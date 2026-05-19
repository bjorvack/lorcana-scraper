/**
 * Dreamborn.ink adapter — community-built decks from
 * https://dreamborn.ink/decks?sort=trending.
 *
 * Why a separate source: dreamborn is the largest community deck
 * repository for Lorcana and exposes a public listing endpoint at
 * ``/api/decks?sort=trending`` that returns 24 trending deck
 * summaries per call (no auth, no Cloudflare). The endpoint is
 * hard-capped at 24 results — pagination is silently broken on the
 * server side — so we issue several orthogonal slice calls
 * (trending, popular, per-color trending) and union the results by
 * deck id. Decks are user-uploaded, not tournament standings —
 * there's no placement / record / opponent. To fit the existing
 * ``SourceAdapter`` contract we project each daily run into a
 * synthetic "tournament" grouping that day's competitive decks.
 *
 * Deck-card data lives in the SSR HTML of each ``/decks/{id}``
 * page, inside a ``__NUXT_DATA__`` <script> block (Nuxt 3
 * indexed-ref hydration). The deck object exposes a ``pbCode``
 * field — base64 of ``Name_Version$qty|Name$qty|...`` — which we
 * decode and feed to the existing name-resolver. Using ``pbCode``
 * rather than the inline ``cards`` map gives us a single uniform
 * key shape (the map mixes plain ``setCode-NNN`` keys with
 * ``setCode/<sha1>`` hash keys for promo printings — those
 * aren't parseable by ``parsePrintingId`` and would silently
 * disappear in the resolver).
 *
 * Filtering: we ask the server for ``archetype=competitive`` only
 * (a user-applied tag on dreamborn). The listing endpoint caps at
 * 24 results either way, so server-side filtering gives us 24
 * tournament-shaped decks instead of the ~12 we'd salvage after
 * dropping casual / multiplayer / budget builds client-side.
 * We still re-check the tag on each deck as defense-in-depth so a
 * server-side filter regression doesn't silently dilute the data.
 *
 * Rate limits: dreamborn is a Nuxt SSR site without documented
 * limits. A snapshot is at most 8 listing calls plus up to ~80
 * per-deck HTML fetches (~50KB each), so a typical daily run is
 * well under 100 requests. We pace at 500ms to be polite.
 *
 * Cloudflare bypass: dreamborn.ink sits behind Cloudflare which
 * 403s the undici fetch from GitHub-runner IP ranges (verified
 * in run 26101600629 — every slice returned HTTP 403 Forbidden).
 * We mirror the legality.yml pattern: undici first (fast, works
 * locally), and on a 403/429/5xx escalate to a Playwright-backed
 * fetch that uses a real Chromium TLS profile. The browser context
 * is lazy-launched on the first escalation and reused for every
 * subsequent request in the same run, so we pay the chromium-spawn
 * cost at most once per snapshot. Closed via the adapter's
 * ``close()`` hook which run.ts already invokes after each run.
 */

import { createHash } from "node:crypto";
import { fetch } from "undici";
// Playwright is loaded *lazily* below — keep the import type-only at
// module scope so the unit suite doesn't drag chromium into memory.
import type { APIRequestContext, Browser } from "playwright";

import type { RawDeck, RawTournament, SourceAdapter, TournamentRef } from "./types.js";

export const SOURCE_NAME = "dreamborn.ink";

const BASE = "https://dreamborn.ink";
// The /api/decks listing endpoint is hard-capped at 24 results per
// call. Server-side pagination (``offset=<lastId>`` cursor) is
// silently broken — the SPA emits it on infinite scroll but the
// server rejects with HTTP 400. To extract more useful data per
// snapshot we issue several orthogonal slice calls and union them
// at the deck-id level. Each slice still caps at 24 but they
// overlap only partially, so 8 calls yield ~50-80 unique decks.
//
// All slices apply ``archetype=competitive`` (the user-applied tag
// for tournament-shape builds). Casual / multiplayer / budget
// builds dilute the training set without adding tournament signal.
// We additionally re-check the tag on each deck as defense-in-depth
// in case the server-side filter silently regresses.
const ARCHETYPE = "competitive";
const COLORS = ["amber", "amethyst", "emerald", "ruby", "sapphire", "steel"] as const;
function listingPaths(): readonly string[] {
  // Trending + popular as the two top-level sorts (different
  // ranking signals — trending = recent activity, popular = all-time
  // likes). Then a per-color slice within trending+competitive,
  // which surfaces colour-specific archetypes that don't make the
  // global top-24. Order doesn't matter; we dedup by id below.
  const paths = [
    `/api/decks?sort=trending&archetype=${ARCHETYPE}`,
    `/api/decks?sort=popular&archetype=${ARCHETYPE}`,
  ];
  for (const c of COLORS) {
    paths.push(`/api/decks?sort=trending&archetype=${ARCHETYPE}&color=${c}`);
  }
  return paths;
}
const DEFAULT_REQUEST_SPACING_MS = 500;
const PER_REQUEST_TIMEOUT_MS = 20_000;
const MAX_ATTEMPTS = 3;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const COMPETITIVE_TAG = "archetype:competitive";

/** dreamborn ink names are lowercase ("amber", "ruby"); the
 * schema wants canonical-case enum values. */
const INK_BY_LOWER: Record<string, string> = {
  amber: "Amber",
  amethyst: "Amethyst",
  emerald: "Emerald",
  ruby: "Ruby",
  sapphire: "Sapphire",
  steel: "Steel",
};

/** Shape of /api/decks listing entries. Many more fields exist
 * (likeCount, views, …) but we only consume the ones we need.
 * Anything else is captured as ``unknown`` so the adapter doesn't
 * fail on additive API changes. */
interface DreambornDeckSummary {
  readonly id: string;
  readonly name?: string;
  readonly creatorName?: string;
  readonly colors?: readonly string[];
  readonly size?: number;
  readonly lastUpdated?: string;
  readonly tags?: Readonly<Record<string, unknown>>;
}

export interface DreambornAdapterOptions {
  readonly priorSeen?: (tournamentKey: string) => boolean;
  readonly priorDecksSeen?: (deckExternalKey: string) => boolean;
  readonly maxResults?: number;
  readonly maxDecksPerTournament?: number;
  readonly requestSpacingMs?: number;
  readonly onDeckFetched?: (a: { resolved: boolean; failed: boolean }) => void;
  readonly onDeckScraped?: (deck: RawDeck) => void;
  readonly onTournamentStart?: (a: { deckCount: number }) => void;
  /** Inject a stable "today" timestamp for deterministic tests. */
  readonly nowIso?: string;
}

class RateLimiter {
  private nextSlot = 0;
  constructor(private intervalMs: number) {}
  async acquire(): Promise<void> {
    const now = Date.now();
    const wait = Math.max(0, this.nextSlot - now);
    this.nextSlot = Math.max(now, this.nextSlot) + this.intervalMs;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function tournamentKey(snapshotIso: string): string {
  return createHash("sha256")
    .update(`${SOURCE_NAME}|${tournamentUrl(snapshotIso)}`)
    .digest("hex");
}

function tournamentUrl(snapshotIso: string): string {
  return `${BASE}/decks?sort=trending&snapshot=${snapshotIso}`;
}

function deckUrl(id: string): string {
  return `${BASE}/decks/${id}`;
}

function deckExternalKey(externalUrl: string): string {
  return createHash("sha256").update(`${SOURCE_NAME}|${externalUrl}`).digest("hex");
}

/** Slice the ``__NUXT_DATA__`` <script> body out of dreamborn's
 * server-rendered HTML. Returns ``null`` if it isn't present (the
 * page failed to render or the SSR contract changed). */
export function extractNuxtData(html: string): string | null {
  const m = /<script[^>]*id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i.exec(html);
  return m ? (m[1] ?? null) : null;
}

/** Resolve Nuxt 3's indexed-ref hydration payload into a normal
 * object graph. Nuxt stores the top-level value at index 0 and
 * every nested object/array uses **numeric indices** as values
 * (instead of inlining them) to deduplicate shared subtrees. This
 * walker dereferences those indices and unwraps
 * ``["Ref"/"Reactive"/"ShallowReactive", idx]`` wrappers. */
export function resolveNuxtPayload(raw: unknown[]): unknown {
  const seen = new Map<number, unknown>();
  const walk = (idx: number): unknown => {
    if (seen.has(idx)) return seen.get(idx);
    const node = raw[idx];
    if (Array.isArray(node)) {
      if (
        node.length >= 2 &&
        typeof node[0] === "string" &&
        (node[0] === "Ref" || node[0] === "Reactive" || node[0] === "ShallowReactive") &&
        typeof node[1] === "number"
      ) {
        // Reactive wrapper — unwrap to the referenced subtree.
        const placeholder: { value: unknown } = { value: null };
        seen.set(idx, placeholder);
        placeholder.value = walk(node[1]);
        seen.set(idx, placeholder.value);
        return placeholder.value;
      }
      const out: unknown[] = [];
      seen.set(idx, out);
      for (const x of node) {
        out.push(typeof x === "number" && x >= 0 && x < raw.length ? walk(x) : x);
      }
      return out;
    }
    if (node !== null && typeof node === "object") {
      const out: Record<string, unknown> = {};
      seen.set(idx, out);
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        out[k] = typeof v === "number" && v >= 0 && v < raw.length ? walk(v) : v;
      }
      return out;
    }
    seen.set(idx, node);
    return node;
  };
  return walk(0);
}

/** Decode dreamborn's base64 ``pbCode`` deck representation.
 *
 * Format: ``<entry1>|<entry2>|…|`` where each entry is
 * ``<name>$<qty>``. Names may contain ``_`` as a separator between
 * the base name and version (e.g. ``Woody_Jungle Guide`` →
 * ``Woody - Jungle Guide``). We translate to the schema's
 * ``Name - Version`` form so the existing dotgg name index can
 * resolve them via ``byExact``. */
export function decodePbCode(pbCode: string): { rawName: string; count: number }[] {
  let decoded: string;
  try {
    decoded = Buffer.from(pbCode, "base64").toString("utf-8");
  } catch {
    return [];
  }
  const out: { rawName: string; count: number }[] = [];
  for (const entry of decoded.split("|")) {
    if (!entry) continue;
    const sep = entry.lastIndexOf("$");
    if (sep === -1) continue;
    const namePart = entry.slice(0, sep);
    const countStr = entry.slice(sep + 1);
    const count = Number.parseInt(countStr, 10);
    if (!Number.isFinite(count) || count <= 0) continue;
    // ``Name_Version`` → ``Name - Version``. Versionless cards have
    // no underscore and pass through unchanged.
    const rawName = namePart.includes("_") ? namePart.replace("_", " - ") : namePart;
    out.push({ rawName, count });
  }
  return out;
}

interface ResolvedDeckPage {
  readonly id: string;
  readonly name: string | null;
  readonly creatorName: string | null;
  readonly pbCode: string | null;
  readonly colors: readonly string[];
  readonly lastUpdated: string | null;
  readonly tags: Readonly<Record<string, unknown>>;
}

/** Parse a deck-detail HTML page into a normalised structure.
 * Exported for testing. */
export function parseDeckPage(id: string, html: string): ResolvedDeckPage | null {
  const block = extractNuxtData(html);
  if (!block) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(block);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const root = resolveNuxtPayload(parsed) as Record<string, unknown> | null;
  if (!root || typeof root !== "object") return null;
  // The hydrated root has `data[<deckId>] = {…deck…}`.
  const dataMap = (root.data ?? null) as Record<string, unknown> | null;
  const deck = dataMap && typeof dataMap === "object" ? dataMap[id] : null;
  if (!deck || typeof deck !== "object") return null;
  const d = deck as Record<string, unknown>;
  return {
    id,
    name: typeof d.name === "string" ? d.name : null,
    creatorName: typeof d.creatorName === "string" ? d.creatorName : null,
    pbCode: typeof d.pbCode === "string" ? d.pbCode : null,
    colors: Array.isArray(d.colors)
      ? (d.colors as string[]).filter((x) => typeof x === "string")
      : [],
    lastUpdated: typeof d.lastUpdated === "string" ? d.lastUpdated : null,
    tags: (d.tags && typeof d.tags === "object"
      ? (d.tags as Record<string, unknown>)
      : {}) as Readonly<Record<string, unknown>>,
  };
}

/** Today's UTC date as ``YYYY-MM-DD``. Pulled out for testability. */
function todayIso(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** Plain undici GET with timeout + retry-on-transient. 4xx (other
 * than 429) is thrown immediately so the outer ``fetchText`` can
 * decide whether to escalate to a real browser. */
async function undiciFetch(url: string): Promise<string> {
  let lastErr: Error = new Error(`${url}: fetch failed`);
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), PER_REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        headers: { "user-agent": USER_AGENT, accept: "text/html,application/json;q=0.9,*/*;q=0.8" },
        signal: ctrl.signal,
      });
      if (res.ok) return await res.text();
      await res.arrayBuffer().catch(() => undefined);
      lastErr = new Error(`${url}: HTTP ${res.status} ${res.statusText}`);
      // Only 5xx + 429 are worth retrying here. Cloudflare 403 is
      // persistent for the runner IP so retrying just burns time —
      // throw immediately and let the caller escalate to Playwright.
      if (res.status !== 429 && res.status < 500) throw lastErr;
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
    } finally {
      clearTimeout(t);
    }
    if (attempt === MAX_ATTEMPTS) throw lastErr;
    await sleep(750 * 2 ** (attempt - 1) + Math.floor(Math.random() * 500));
  }
  throw lastErr;
}

/** Returns ``true`` when the error message looks like a Cloudflare
 * (or upstream-Cloudflare-shaped) wall — 403/429/5xx. Anything else
 * propagates so a real DNS / parse problem doesn't get masked by a
 * 30-second browser launch. */
function isCloudflareShaped(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /HTTP (?:403|429|5\d\d)\b/.test(msg);
}

export class DreambornAdapter implements SourceAdapter {
  readonly sourceName = SOURCE_NAME;
  private readonly opts: DreambornAdapterOptions;
  private readonly rateLimiter: RateLimiter;
  // Lazy-launched browser session — kept null until we hit a 403
  // and need to escalate. Reused for every subsequent request in
  // the same adapter run, then disposed via ``close()`` from the
  // pipeline's adapter shutdown hook.
  private browser: Browser | null = null;
  private requestContext: APIRequestContext | null = null;

  constructor(opts: DreambornAdapterOptions = {}) {
    this.opts = opts;
    this.rateLimiter = new RateLimiter(opts.requestSpacingMs ?? DEFAULT_REQUEST_SPACING_MS);
  }

  /** Lazily spawn a headless Chromium and return its
   * ``APIRequestContext`` — a request-only interface that uses
   * the browser's TLS profile (which Cloudflare actually inspects)
   * without spinning up a full DOM. Cheaper than a real
   * ``page.goto`` and returns raw response bodies that the JSON /
   * HTML parsers above can consume directly. */
  private async getBrowserRequest(): Promise<APIRequestContext> {
    if (this.requestContext) return this.requestContext;
    const { chromium } = await import("playwright");
    this.browser = await chromium.launch({ headless: true });
    const context = await this.browser.newContext({
      userAgent: USER_AGENT,
      locale: "en-US",
      extraHTTPHeaders: {
        "accept-language": "en-US,en;q=0.9",
        referer: `${BASE}/`,
      },
    });
    this.requestContext = context.request;
    return this.requestContext;
  }

  /** Fetch raw response text via the browser context. Treats any
   * non-2xx as a hard failure — by the time we're here undici
   * has already given up, so a second 403 means Cloudflare is
   * actively blocking even the browser fingerprint and there's
   * nothing left to try. */
  private async browserFetch(url: string): Promise<string> {
    const req = await this.getBrowserRequest();
    const res = await req.get(url, { timeout: PER_REQUEST_TIMEOUT_MS });
    if (!res.ok()) {
      throw new Error(`${url}: HTTP ${res.status()} ${res.statusText()} (via browser)`);
    }
    return await res.text();
  }

  /** Undici-first, browser-fallback on Cloudflare-shaped failures. */
  private async fetchText(url: string): Promise<string> {
    try {
      return await undiciFetch(url);
    } catch (err) {
      if (!isCloudflareShaped(err)) throw err;
      process.stderr.write(
        `[${SOURCE_NAME}] ${(err as Error).message} — escalating to headless browser\n`,
      );
      return await this.browserFetch(url);
    }
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close().catch(() => undefined);
      this.browser = null;
      this.requestContext = null;
    }
  }

  async listTournaments(): Promise<TournamentRef[]> {
    // dreamborn doesn't actually have "tournaments" — we model
    // each daily run as a single synthetic snapshot whose
    // ``sourceUrl`` is date-stamped so consecutive days don't
    // collide via the standard ``sha256(sourceName|sourceUrl)``
    // externalKey. Deck-level dedup (priorDecksSeen) means a deck
    // that stays trending for multiple days is still ingested
    // once.
    const snapshot = this.opts.nowIso ?? todayIso();
    const ref: TournamentRef = {
      tournamentKey: tournamentKey(snapshot),
      sourceUrl: tournamentUrl(snapshot),
      name: `Dreamborn trending — ${snapshot}`,
      date: snapshot,
    };
    if (this.opts.priorSeen?.(ref.tournamentKey)) return [];
    return [ref];
  }

  async fetchTournament(ref: TournamentRef): Promise<RawTournament> {
    // Union the orthogonal listing slices. Each is capped at 24
    // server-side; together they cover ~3x more unique decks. Any
    // slice that fails (network blip, server hiccup) is silently
    // dropped — the other slices still contribute and the daily
    // rerun will pick up the survivors.
    const byId = new Map<string, DreambornDeckSummary>();
    for (const path of listingPaths()) {
      await this.rateLimiter.acquire();
      let raw: string;
      try {
        raw = await this.fetchText(`${BASE}${path}`);
      } catch (err) {
        process.stderr.write(
          `[${SOURCE_NAME}] listing slice ${path} failed: ${
            err instanceof Error ? err.message : String(err)
          }\n`,
        );
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        continue;
      }
      if (!Array.isArray(parsed)) continue;
      for (const s of parsed as DreambornDeckSummary[]) {
        if (!s || typeof s.id !== "string") continue;
        // First slice to mention a given id wins. All slices return
        // the same per-deck fields so the choice is cosmetic.
        if (!byId.has(s.id)) byId.set(s.id, s);
      }
    }

    const competitive = [...byId.values()].filter(
      (s) => s.tags && Object.prototype.hasOwnProperty.call(s.tags, COMPETITIVE_TAG),
    );
    const limited =
      typeof this.opts.maxDecksPerTournament === "number"
        ? competitive.slice(0, this.opts.maxDecksPerTournament)
        : competitive;

    this.opts.onTournamentStart?.({ deckCount: limited.length });

    const decks: RawDeck[] = [];
    for (const summary of limited) {
      const url = deckUrl(summary.id);
      const externalKey = deckExternalKey(url);
      if (this.opts.priorDecksSeen?.(externalKey)) {
        // Already ingested in a previous snapshot — no need to
        // re-fetch the page. Mirrors the limitless adapter's dedup.
        this.opts.onDeckFetched?.({ resolved: false, failed: false });
        continue;
      }
      await this.rateLimiter.acquire();
      let html: string;
      try {
        html = await this.fetchText(url);
      } catch {
        this.opts.onDeckFetched?.({ resolved: false, failed: true });
        continue;
      }
      const page = parseDeckPage(summary.id, html);
      if (!page || !page.pbCode) {
        this.opts.onDeckFetched?.({ resolved: false, failed: true });
        continue;
      }
      const cards = decodePbCode(page.pbCode);
      if (cards.length === 0) {
        this.opts.onDeckFetched?.({ resolved: false, failed: true });
        continue;
      }
      const inks = (page.colors.length ? page.colors : (summary.colors ?? []))
        .map((c) => INK_BY_LOWER[c.toLowerCase()])
        .filter((c): c is string => typeof c === "string");
      const deck: RawDeck = {
        // dreamborn has no notion of placement — these are
        // user-uploaded decks. Leave undefined so the projector
        // emits ``placement: null`` rather than a fake "1st".
        player: page.creatorName ?? summary.creatorName ?? undefined,
        inks,
        cards,
        externalId: summary.id,
        externalUrl: url,
        displayName: page.name ?? summary.name ?? undefined,
      };
      decks.push(deck);
      this.opts.onDeckScraped?.(deck);
      this.opts.onDeckFetched?.({ resolved: true, failed: false });
    }

    return {
      sourceUrl: ref.sourceUrl,
      name: ref.name ?? "Dreamborn trending",
      date: ref.date ?? this.opts.nowIso ?? todayIso(),
      decks,
    };
  }
}

export const dreamborn: SourceAdapter = new DreambornAdapter();
