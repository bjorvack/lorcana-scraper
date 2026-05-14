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
import { existsSync, mkdirSync } from "node:fs";
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
const DEFAULT_PAGE_DELAY_MS = 2_500;
const DEFAULT_DECK_DELAY_MS = 1_500;
const MAX_NAV_ATTEMPTS = 3;
/** Bail out of the whole adapter run if we see this many consecutive
 *  Cloudflare challenge pages in a row — Turnstile has clearly
 *  decided we're a bot today and waiting longer won't help. */
const CHALLENGE_BAIL_THRESHOLD = 4;

const DEFAULT_STATE_FILE = resolve(__dirname, "..", "..", ".cache", "inkdecks-state.json");

export interface InkdecksAdapterOptions {
  /** Filter the listing by date descending; only emit pages in
   *  ``[pageFrom, pageTo]``. The orchestrator's matrix uses this to
   *  shard scrapes the same way it shards ``lorcana-gg``. */
  readonly pageFrom?: number;
  readonly pageTo?: number;
  /** Optional cap on listing pages (defaults to "until empty page"). */
  readonly maxPages?: number;
  /** Returning ``true`` drops the matching listing ref and stops
   *  paginating — the orchestrator passes this so incremental runs
   *  short-circuit at the first already-seen tournament. */
  readonly priorSeen?: (tournamentKey: string) => boolean;
  /** Where to persist the Cloudflare cookie + localStorage between
   *  runs. Defaults to ``.cache/inkdecks-state.json``. */
  readonly stateFile?: string;
  /** Throttle between *listing* page navigations. */
  readonly listingDelayMs?: number;
  /** Throttle between *deck* page navigations. */
  readonly deckDelayMs?: number;
  /** ``onTournamentStart`` mirrors the lorcana-gg adapter signature
   *  so the orchestrator can render a progress line. */
  readonly onTournamentStart?: (a: { deckCount: number }) => void;
  /** Per-deck progress callback. */
  readonly onDeckFetched?: (a: { resolved: boolean; failed: boolean }) => void;
}

function tournamentKey(sourceUrl: string): string {
  return createHash("sha256").update(`${SOURCE_NAME}|${sourceUrl}`).digest("hex");
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
    const refs: TournamentRef[] = [];
    let listingPage = pageFrom;
    let stop = false;

    while (!stop && listingPage <= pageTo) {
      const url = `${BASE}${LISTING_BASE}?sort=date&direction=desc${listingPage > 1 ? `&page=${listingPage}` : ""}`;
      const ok = await this.#navigate(page, url);
      if (!ok) {
        // Persistent Cloudflare wall: surface what we have, let the
        // orchestrator log the partial result. Doing nothing here is
        // safer than dropping the run entirely.
        break;
      }
      await sleep(this.#opts.listingDelayMs ?? DEFAULT_PAGE_DELAY_MS);

      const items = await this.#scrapeListing(page);
      if (items.length === 0) {
        stop = true;
        break;
      }
      let seenAny = false;
      for (const item of items) {
        const date = parseListingDate(item.dateStr);
        if (!date) continue;
        const key = tournamentKey(item.href);
        if (this.#opts.priorSeen?.(key)) {
          stop = true;
          break;
        }
        seenAny = true;
        refs.push({
          tournamentKey: key,
          sourceUrl: item.href,
          name: item.text,
          date,
        });
      }
      if (!seenAny) break;
      listingPage++;
      if (this.#opts.maxPages && listingPage - pageFrom + 1 > this.#opts.maxPages) break;
    }

    await this.#persistState();
    return refs;
  }

  async fetchTournament(ref: TournamentRef, _ctx: ScrapeContext): Promise<RawTournament> {
    const page = await this.#ensurePage();
    if (!(await this.#navigate(page, ref.sourceUrl))) {
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

    const decks: RawDeck[] = [];
    for (const row of deckRows) {
      try {
        const deck = await this.#fetchDeck(row);
        if (deck) decks.push(deck);
        this.#opts.onDeckFetched?.({ resolved: Boolean(deck), failed: !deck });
      } catch {
        this.#opts.onDeckFetched?.({ resolved: false, failed: true });
      }
      await sleep(this.#opts.deckDelayMs ?? DEFAULT_DECK_DELAY_MS);
    }

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

  async #navigate(page: Page, url: string): Promise<boolean> {
    for (let attempt = 1; attempt <= MAX_NAV_ATTEMPTS; attempt++) {
      try {
        await page.goto(url, { waitUntil: "networkidle", timeout: NAV_TIMEOUT_MS });
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

  async #fetchDeck(row: RawDeckRow): Promise<RawDeck | null> {
    const page = this.#page!;
    if (!(await this.#navigate(page, row.href))) return null;
    await sleep(this.#opts.deckDelayMs ?? DEFAULT_DECK_DELAY_MS);
    // Read the inks from the deck detail page (images alt/src), and
    // grab the export URL embedded in the HTML.
    const inks = await page.evaluate(() => {
      const inkColors = ["amber", "amethyst", "emerald", "ruby", "sapphire", "steel"];
      const found = new Set<string>();
      for (const img of Array.from(document.images)) {
        const haystack = `${img.alt ?? ""} ${img.src ?? ""} ${img.className ?? ""}`.toLowerCase();
        for (const c of inkColors) if (haystack.includes(c)) found.add(c);
      }
      return [...found];
    });

    const html = await page.content();
    const exportMatch = html.match(/\/decks\/export\/([a-f0-9-]+)/);
    if (!exportMatch) return null;
    const exportUrl = `${BASE}${exportMatch[0]}/txt`;

    if (!(await this.#navigate(page, exportUrl))) return null;
    await sleep(this.#opts.deckDelayMs ?? DEFAULT_DECK_DELAY_MS);

    const txt = await page.evaluate(() => {
      const ta = document.querySelector<HTMLTextAreaElement>("textarea");
      return ta?.value ?? document.body?.innerText ?? "";
    });

    const cards = parseTxtDecklist(txt);
    if (cards.length === 0) return null;
    return {
      placement: row.place,
      inks: (row.inks.length > 0 ? row.inks : inks).map(titleInk),
      cards,
      externalUrl: row.href,
    };
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
