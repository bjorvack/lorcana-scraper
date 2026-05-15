/**
 * inkdecks.com adapter (live).
 *
 * Ports the original ``lorcana-deck-generator/training/scrape.js`` so
 * we keep collecting fresh tournament data from inkdecks beyond the
 * static legacy-cache snapshot.
 *
 * The site is behind Cloudflare Turnstile (interactive challenge on
 * every endpoint, including ``/robots.txt``), so plain HTTP can't
 * reach it; we must drive a real chromium via ``playwright-core``.
 * Several optimizations keep the scrape practical:
 *
 *   1. **One browser / context / page per adapter instance.** Cloudflare
 *      challenges the *session*, not each URL — once we pass once, the
 *      ``cf_clearance`` cookie is good for the next ~30 minutes.
 *   2. **Persisted storage state.** ``CACHE_DIR/inkdecks-state.json``
 *      survives between CI runs, so a follow-up scrape skips the
 *      Turnstile dance entirely until the cookie expires.
 *   3. **Page-range sharding.** Mirrors the lorcana-gg adapter: each
 *      runner only paginates ``[pageFrom, pageTo]`` of the listing.
 *   4. **Priors short-circuit.** When the listing surfaces a
 *      tournament whose key the orchestrator has already seen, we
 *      stop paginating — no point downloading older pages again.
 *
 * Failure model: every navigation has a bounded retry; if Cloudflare
 * gives us a real (cleared) page we extract; if we land on a
 * challenge page we wait + reload once, and bail out the whole run
 * after ``CHALLENGE_BAIL_THRESHOLD`` consecutive failures.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";

import type { ScrapeContext } from "../context.js";
import type { RawDeck, RawTournament, SourceAdapter, TournamentRef } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOURCE_NAME = "inkdecks.com";
const BASE = "https://inkdecks.com";
const LISTING_BASE = "/lorcana-tournaments/core";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const NAV_TIMEOUT_MS = 45_000;
/** Inter-listing-page delay. Cloudflare appears to throttle the
 *  listing endpoint more strictly than detail pages, so we keep
 *  this conservative even when the cf_clearance cookie is fresh. */
const DEFAULT_PAGE_DELAY_MS = 1_500;
/** Between deck navigations within a tournament. With clearance in
 *  hand we can be aggressive — Cloudflare's per-cookie token bucket
 *  refills fast and rate-limiting only kicks back in on challenge
 *  failures, which we already retry with backoff. */
const DEFAULT_DECK_DELAY_MS = 400;
/** Parallel deck fetches per tournament. 3 is the sweet spot in
 *  testing: shaves ~3x off deck-heavy tournaments without tripping
 *  Cloudflare's burst limit. */
const DEFAULT_DECK_CONCURRENCY = 3;
const MAX_NAV_ATTEMPTS = 3;
/** Bail out of the whole adapter run if we see this many consecutive
 *  Cloudflare challenge pages in a row — Turnstile has clearly
 *  decided we're a bot today and waiting longer won't help. */
const CHALLENGE_BAIL_THRESHOLD = 4;

const DEFAULT_STATE_FILE = resolve(__dirname, "..", "..", ".cache", "inkdecks-state.json");
const DEFAULT_DECK_CACHE_DIR = resolve(__dirname, "..", "..", ".cache", "inkdecks-decks");

export interface InkdecksAdapterOptions {
  /** Filter the listing by date descending; only emit pages in
   *  ``[pageFrom, pageTo]``. The orchestrator's matrix uses this to
   *  shard scrapes the same way it shards ``lorcana-gg``. */
  readonly pageFrom?: number;
  readonly pageTo?: number;
  /** Optional cap on listing pages (defaults to "until empty page"). */
  readonly maxPages?: number;
  /** Returning ``true`` drops the matching listing ref — the
   *  orchestrator passes this so already-known tournaments don't
   *  count against ``maxResults``. We deliberately KEEP paginating
   *  past seen refs so older tournaments deeper in the listing
   *  still get picked up on subsequent runs; otherwise once a
   *  source has ``maxResults`` tournaments in the prior we'd never
   *  reach the tail and the backfill would stall. */
  readonly priorSeen?: (tournamentKey: string) => boolean;
  /** D3: per-shard startup stagger in ms. With hash-modulo sharding
   *  (A1) every shard walks the listing in the same date-desc order,
   *  hitting page 1 simultaneously and tripping Cloudflare's burst
   *  limit. Sleeping `shardIndex * staggerMs` at the start lets
   *  earlier shards establish their cf_clearance cookies before
   *  later shards arrive — and combined with D2's shared cookie
   *  cache, later shards often skip Turnstile altogether. */
  readonly startupStaggerMs?: number;
  /** Deck-level skip (D1). The adapter computes the prospective
   *  ``Deck.externalKey`` from ``(sourceName, deck detail URL)``
   *  before fetching the deck page. If ``priorDecksSeen`` returns
   *  true we drop the deck without hitting the network; the
   *  orchestrator's E1 merge re-attaches the prior copy. */
  readonly priorDecksSeen?: (deckExternalKey: string) => boolean;
  /** Cap on the number of NEW (un-seen) tournaments emitted per
   *  run. Pagination stops as soon as this many fresh refs have
   *  been collected. Prior-seen refs are skipped without consuming
   *  the budget. */
  readonly maxResults?: number;
  /** Where to persist the Cloudflare cookie + localStorage between
   *  runs. Defaults to ``.cache/inkdecks-state.json``. */
  readonly stateFile?: string;
  /** Throttle between *listing* page navigations. */
  readonly listingDelayMs?: number;
  /** Throttle between *deck* page navigations. */
  readonly deckDelayMs?: number;
  /** Parallel deck-page fetches per tournament. Cloudflare's
   *  per-cookie limit comfortably allows this once Turnstile is
   *  cleared; testing put the sweet spot at 3. */
  readonly deckConcurrency?: number;
  /** Where to persist the per-deck content cache. Each parsed
   *  ``/decks/export/<uuid>/txt`` is content-addressable, so
   *  re-running an already-scraped deck is a JSON read. */
  readonly deckCacheDir?: string;
  /** ``onTournamentStart`` mirrors the lorcana-gg adapter signature
   *  so the orchestrator can render a progress line. */
  readonly onTournamentStart?: (a: { deckCount: number }) => void;
  /** Per-deck progress callback. */
  readonly onDeckFetched?: (a: { resolved: boolean; failed: boolean }) => void;
  /** B2 streaming hook: fired with the actual `RawDeck` as soon as
   *  it lands so the pipeline can persist a partial tournament after
   *  every deck. A crash mid-tournament keeps everything that made it. */
  readonly onDeckScraped?: (deck: RawDeck) => void;
}

function tournamentKey(sourceUrl: string): string {
  return createHash("sha256").update(`${SOURCE_NAME}|${sourceUrl}`).digest("hex");
}

/**
 * Same formula the pipeline uses to stamp `Deck.externalKey`. The
 * adapter calls this before fetching deck content so D1's
 * `priorDecksSeen` can short-circuit known decks.
 */
function deckExternalKey(sourceName: string, externalUrl: string): string {
  return createHash("sha256").update(`${sourceName}|${externalUrl}`).digest("hex");
}

function titleInk(s: string): string {
  if (s.length === 0) return s;
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface ListedTournament {
  href: string;
  text: string;
  dateStr: string | null;
}

interface RawDeckRow {
  href: string;
  place: number;
  inks: string[];
}

export class InkdecksAdapter implements SourceAdapter {
  readonly sourceName = SOURCE_NAME;
  readonly #opts: InkdecksAdapterOptions;
  #browser: Browser | null = null;
  #context: BrowserContext | null = null;
  #page: Page | null = null;
  #challengeStreak = 0;

  constructor(opts: InkdecksAdapterOptions = {}) {
    this.#opts = opts;
  }

  async listTournaments(_ctx: ScrapeContext): Promise<TournamentRef[]> {
    // D3: stagger shards so they don't all hammer page 1 at the
    // same instant. No-op when run as a single process locally.
    if (this.#opts.startupStaggerMs && this.#opts.startupStaggerMs > 0) {
      await sleep(this.#opts.startupStaggerMs);
    }
    let page: Page;
    try {
      page = await this.#ensurePage();
    } catch (err) {
      // The most common failure here is "chromium not installed" on
      // a runner without the playwright browsers bundle. Treat the
      // whole adapter as a soft no-op rather than killing the run.
      process.stderr.write(`[${SOURCE_NAME}] disabled: ${(err as Error).message}\n`);
      return [];
    }
    const pageFrom = this.#opts.pageFrom ?? 1;
    const pageTo = this.#opts.pageTo ?? Number.MAX_SAFE_INTEGER;
    const maxResults = this.#opts.maxResults ?? Number.POSITIVE_INFINITY;
    const refs: TournamentRef[] = [];
    let listingPage = pageFrom;

    while (listingPage <= pageTo) {
      const url = `${BASE}${LISTING_BASE}?sort=date&direction=desc${listingPage > 1 ? `&page=${listingPage}` : ""}`;
      // Wait for at least one tournament-decks anchor to materialise;
      // the page is JS-rendered so ``domcontentloaded`` returns
      // before the table is filled in.
      const ok = await this.#navigate(page, url, "a[href*='-tournament-decks-']");
      if (!ok) {
        // Persistent Cloudflare wall: surface what we have, let the
        // orchestrator log the partial result. Doing nothing here is
        // safer than dropping the run entirely.
        break;
      }
      await sleep(this.#opts.listingDelayMs ?? DEFAULT_PAGE_DELAY_MS);

      const items = await this.#scrapeListing(page);
      // An empty page means we've walked off the end of the
      // pagination — nothing left to find.
      if (items.length === 0) break;
      let stopBudget = false;
      for (const item of items) {
        const date = parseListingDate(item.dateStr);
        if (!date) continue;
        const key = tournamentKey(item.href);
        // Skip refs the orchestrator has already ingested but KEEP
        // paginating — older un-seen tournaments may live deeper in
        // the listing. This is what lets repeated capped runs walk
        // the whole archive incrementally.
        if (this.#opts.priorSeen?.(key)) continue;
        refs.push({
          tournamentKey: key,
          sourceUrl: item.href,
          name: item.text,
          date,
        });
        if (refs.length >= maxResults) {
          stopBudget = true;
          break;
        }
      }
      if (stopBudget) break;
      listingPage++;
      if (this.#opts.maxPages && listingPage - pageFrom + 1 > this.#opts.maxPages) break;
    }

    await this.#persistState();
    return refs;
  }

  async fetchTournament(ref: TournamentRef, _ctx: ScrapeContext): Promise<RawTournament> {
    const page = await this.#ensurePage();
    if (!(await this.#navigate(page, ref.sourceUrl, "tr[id^='desktop-deck-']"))) {
      throw new Error(`inkdecks: could not reach ${ref.sourceUrl}`);
    }
    await sleep(this.#opts.listingDelayMs ?? DEFAULT_PAGE_DELAY_MS);

    const deckRows = await page.evaluate(() => {
      // Same selectors the legacy scraper used. The site renders an
      // ``<tr id="desktop-deck-N">`` row per deck with a
      // ``data-href`` attribute pointing at the deck detail page.
      const rows = Array.from(
        document.querySelectorAll<HTMLTableRowElement>("tr[id^='desktop-deck-']"),
      );
      return rows
        .filter((row) => row.getAttribute("data-href")?.includes("/lorcana-metagame/deck-"))
        .map((row, index) => {
          const href = row.getAttribute("data-href")!;
          const placeCell = row.querySelector("td");
          let place = index + 1;
          if (placeCell) {
            const text = (placeCell.textContent ?? "").trim();
            if (/^winner|1st/i.test(text)) place = 1;
            else if (/finalist|runner|2nd/i.test(text)) place = 2;
            else {
              const m = text.match(/(\d+)/);
              if (m) place = Number.parseInt(m[1]!, 10);
            }
          }
          return {
            href: new URL(href, "https://inkdecks.com/").toString(),
            place,
            inks: [] as string[],
          };
        });
    });

    this.#opts.onTournamentStart?.({ deckCount: deckRows.length });
    await this.#persistState();

    // Fan deck fetches out across N pages in the same context, all
    // sharing the cf_clearance cookie. Each worker pulls the next
    // row off a shared queue. Output order is intentionally
    // unspecified — the orchestrator sorts/dedupes downstream.
    const concurrency = Math.max(1, this.#opts.deckConcurrency ?? DEFAULT_DECK_CONCURRENCY);
    const queue = [...deckRows];
    const decks: RawDeck[] = [];
    const workers = Array.from({ length: concurrency }, (_, i) => i).map(async (i) => {
      // Worker 0 keeps the shared main page; workers 1..N spin up
      // a fresh page so they don't fight each other for the URL bar.
      const wp = i === 0 ? page : await this.#context!.newPage();
      try {
        while (queue.length > 0) {
          const row = queue.shift()!;
          // D1: skip refetching decks the prior dataset already has.
          // We compute the prospective Deck.externalKey from the
          // deck detail URL we already extracted from the row, so
          // no navigation is required.
          if (this.#opts.priorDecksSeen?.(deckExternalKey(SOURCE_NAME, row.href))) {
            this.#opts.onDeckFetched?.({ resolved: false, failed: false });
            continue;
          }
          try {
            const deck = await this.#fetchDeck(wp, row);
            if (deck) {
              decks.push(deck);
              // B2: stream to orchestrator for partial-tournament
              // persistence before moving to the next worker iter.
              this.#opts.onDeckScraped?.(deck);
            }
            this.#opts.onDeckFetched?.({ resolved: Boolean(deck), failed: !deck });
          } catch {
            this.#opts.onDeckFetched?.({ resolved: false, failed: true });
          }
          await sleep(this.#opts.deckDelayMs ?? DEFAULT_DECK_DELAY_MS);
        }
      } finally {
        if (wp !== page) await wp.close().catch(() => undefined);
      }
    });
    await Promise.all(workers);

    return {
      sourceUrl: ref.sourceUrl,
      name: ref.name ?? "",
      date: ref.date ?? "",
      decks,
    };
  }

  /** Tear the browser down. Safe to call from a ``finally`` block. */
  async close(): Promise<void> {
    await this.#persistState();
    await this.#page?.close().catch(() => {});
    await this.#context?.close().catch(() => {});
    await this.#browser?.close().catch(() => {});
    this.#page = null;
    this.#context = null;
    this.#browser = null;
  }

  // --- internals ---------------------------------------------------

  async #ensurePage(): Promise<Page> {
    if (this.#page && !this.#page.isClosed()) return this.#page;
    // ``CHROME_BIN`` / ``PLAYWRIGHT_BROWSERS_PATH`` get set by the
    // ``playwright install chromium`` step; we accept ``CHROME_BIN``
    // as an explicit override for local debugging.
    const explicitPath = process.env.CHROMIUM_BIN ?? process.env.CHROME_BIN;
    this.#browser = await chromium.launch({
      headless: true,
      executablePath: explicitPath || undefined,
      args: ["--disable-blink-features=AutomationControlled", "--no-sandbox"],
    });

    const stateFile = this.#opts.stateFile ?? DEFAULT_STATE_FILE;
    const storageState = existsSync(stateFile) ? stateFile : undefined;
    this.#context = await this.#browser.newContext({
      userAgent: USER_AGENT,
      viewport: { width: 1920, height: 1080 },
      storageState,
    });
    // Hide ``navigator.webdriver`` — the most common stealth tweak.
    // The legacy scraper relied on ``puppeteer-extra-plugin-stealth``
    // for this and a few other minor patches; the webdriver flag is
    // 90% of what Cloudflare actually checks for in Turnstile v1.
    await this.#context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
    });
    this.#page = await this.#context.newPage();
    this.#page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
    return this.#page;
  }

  async #navigate(page: Page, url: string, waitFor?: string): Promise<boolean> {
    for (let attempt = 1; attempt <= MAX_NAV_ATTEMPTS; attempt++) {
      try {
        // ``domcontentloaded`` returns as soon as the HTML is
        // parsed — typically 5-10x faster than ``networkidle`` on
        // a Cloudflare-protected site, which keeps a long-poll
        // open even after the user-visible content is settled.
        // When the caller passes ``waitFor``, we additionally wait
        // for that selector to materialise; gives us deterministic
        // readiness without the heuristic of "no network activity
        // for 500 ms".
        await page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: NAV_TIMEOUT_MS,
        });
        if (waitFor) {
          await page
            .waitForSelector(waitFor, { timeout: NAV_TIMEOUT_MS / 2 })
            .catch(() => undefined);
        }
        if (await this.#isChallenge(page)) {
          this.#challengeStreak++;
          if (this.#challengeStreak >= CHALLENGE_BAIL_THRESHOLD) return false;
          // Cloudflare interactive challenge: a fresh navigation
          // after a short wait usually clears.
          await sleep(8_000 + Math.random() * 4_000);
          continue;
        }
        this.#challengeStreak = 0;
        return true;
      } catch {
        await sleep(2_000 * attempt);
      }
    }
    return false;
  }

  async #isChallenge(page: Page): Promise<boolean> {
    const title = await page.title().catch(() => "");
    if (/just a moment/i.test(title)) return true;
    const text = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
    return /verifying you are human|just a moment/i.test(text);
  }

  async #scrapeListing(page: Page): Promise<ListedTournament[]> {
    return page.evaluate(() => {
      const links = Array.from(document.querySelectorAll<HTMLAnchorElement>("a"));
      return links
        .filter(
          (a) =>
            a.href.includes("/lorcana-tournaments/") &&
            a.href.includes("-tournament-decks-") &&
            /\d+$/.test(a.href),
        )
        .map((a) => {
          let dateStr: string | null = null;
          const row = a.closest("tr");
          if (row) {
            const cells = Array.from(row.querySelectorAll<HTMLTableCellElement>("td"));
            for (const cell of cells) {
              const text = (cell.textContent ?? "").trim();
              if (
                /\b\d{4}-\d{2}-\d{2}\b/.test(text) ||
                /\b\w{3}\s+\d{1,2},\s+\d{4}\b/.test(text) ||
                /\b\d{1,2}\/\d{1,2}\/\d{4}\b/.test(text)
              ) {
                dateStr = text;
                break;
              }
            }
          }
          return { href: a.href, text: (a.textContent ?? "").trim(), dateStr };
        })
        .filter((item) => item.text.length > 5);
    });
  }

  async #fetchDeck(page: Page, row: RawDeckRow): Promise<RawDeck | null> {
    if (!(await this.#navigate(page, row.href, "img"))) return null;
    await sleep(this.#opts.deckDelayMs ?? DEFAULT_DECK_DELAY_MS);
    // Read the inks from the deck detail page (images alt/src), and
    // grab the export URL embedded in the HTML.
    const { inks, exportUuid } = await page.evaluate(() => {
      const inkColors = ["amber", "amethyst", "emerald", "ruby", "sapphire", "steel"];
      const found = new Set<string>();
      for (const img of Array.from(document.images)) {
        const haystack = `${img.alt ?? ""} ${img.src ?? ""} ${img.className ?? ""}`.toLowerCase();
        for (const c of inkColors) if (haystack.includes(c)) found.add(c);
      }
      // The export UUID is embedded as an anchor / form-action on
      // the detail page. Pulling it out directly is faster than
      // calling ``page.content()`` to get the entire HTML.
      let exportUuid: string | null = null;
      for (const a of Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]"))) {
        const m = a.href.match(/\/decks\/export\/([a-f0-9-]+)/);
        if (m) {
          exportUuid = m[1] ?? null;
          break;
        }
      }
      return { inks: [...found], exportUuid };
    });
    if (!exportUuid) return null;

    // Per-deck content cache — each ``/decks/export/<uuid>/txt`` is
    // content-addressable, so we keep a JSON blob on disk and skip
    // the network round-trip when we've parsed this deck before.
    let cards: { rawName: string; count: number }[] | null = this.#cacheGet(exportUuid);
    if (!cards) {
      const exportUrl = `${BASE}/decks/export/${exportUuid}/txt`;
      if (!(await this.#navigate(page, exportUrl, "textarea"))) return null;
      await sleep(this.#opts.deckDelayMs ?? DEFAULT_DECK_DELAY_MS);
      const txt = await page.evaluate(() => {
        const ta = document.querySelector<HTMLTextAreaElement>("textarea");
        return ta?.value ?? document.body?.innerText ?? "";
      });
      cards = parseTxtDecklist(txt);
      if (cards.length === 0) return null;
      this.#cachePut(exportUuid, cards);
    }
    return {
      placement: row.place,
      inks: (row.inks.length > 0 ? row.inks : inks).map(titleInk),
      cards,
      externalUrl: row.href,
    };
  }

  #cacheGet(uuid: string): { rawName: string; count: number }[] | null {
    try {
      const p = this.#cachePath(uuid);
      if (!existsSync(p)) return null;
      return JSON.parse(readFileSync(p, "utf8")) as { rawName: string; count: number }[];
    } catch {
      return null;
    }
  }

  #cachePut(uuid: string, cards: { rawName: string; count: number }[]): void {
    try {
      const p = this.#cachePath(uuid);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, JSON.stringify(cards));
    } catch {
      // Best-effort — a cache write failure shouldn't break the run.
    }
  }

  #cachePath(uuid: string): string {
    const dir = this.#opts.deckCacheDir ?? DEFAULT_DECK_CACHE_DIR;
    // Two-char prefix sharding so we don't end up with thousands of
    // siblings in one directory on macOS / older filesystems.
    return resolve(dir, uuid.slice(0, 2), `${uuid}.json`);
  }

  async #persistState(): Promise<void> {
    if (!this.#context) return;
    const target = this.#opts.stateFile ?? DEFAULT_STATE_FILE;
    mkdirSync(dirname(target), { recursive: true });
    await this.#context.storageState({ path: target });
  }
}

const MONTHS: Readonly<Record<string, number>> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  sept: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

/**
 * Parse a listing date string in any of the formats inkdecks uses
 * back into ``YYYY-MM-DD``. Parsing is done component-wise — passing
 * ``"Nov 20, 2025"`` through ``new Date()`` interprets it as *local*
 * midnight and ``toISOString()`` then shifts it back to UTC, which
 * silently produces the previous day in any negative-UTC timezone.
 * Returns ``null`` on parse failure.
 */
export function parseListingDate(dateStr: string | null | undefined): string | null {
  if (!dateStr) return null;

  let m = dateStr.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;

  m = dateStr.match(/\b(\w{3,9})\s+(\d{1,2}),\s+(\d{4})\b/);
  if (m) {
    const month = MONTHS[m[1]!.toLowerCase()];
    if (month) return `${m[3]}-${pad2(month)}-${pad2(Number.parseInt(m[2]!, 10))}`;
  }

  m = dateStr.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
  if (m) {
    // inkdecks displays dates as MM/DD/YYYY (American).
    return `${m[3]}-${pad2(Number.parseInt(m[1]!, 10))}-${pad2(Number.parseInt(m[2]!, 10))}`;
  }

  return null;
}

/** Parse an inkdecks ``/txt`` export into raw card entries. */
export function parseTxtDecklist(txt: string): { rawName: string; count: number }[] {
  const out: { rawName: string; count: number }[] = [];
  for (const line of txt.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m =
      trimmed.match(/^(\d+)\s*[x×]?\s+(.+?)\s*-\s*(.+)$/) ||
      trimmed.match(/^(\d+)\s*[x×]?\s+(.+)$/);
    if (!m) continue;
    const count = Number.parseInt(m[1]!, 10);
    if (!Number.isFinite(count) || count < 1 || count > 4) continue;
    const name = m[2]!.trim();
    const version = m[3]?.trim();
    if (name.length < 2) continue;
    out.push({ rawName: version ? `${name} - ${version}` : name, count });
  }
  return out;
}

/** Cache the JSON state path so callers (CI, tests) can locate it. */
export function defaultInkdecksStatePath(): string {
  return DEFAULT_STATE_FILE;
}
