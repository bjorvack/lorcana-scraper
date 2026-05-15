/**
 * lorcana.gg / api.dotgg.gg adapter.
 *
 * Three endpoints (see DESIGN.md → "v1 adapter: lorcana.gg"):
 *
 *   GET /cgfw/gettournaments?game=lorcana&page=N
 *   GET /cgfw/gettournament?game=lorcana&slug=<slug>
 *   GET /cgfw/getdeck?game=lorcana&slug=<deck-slug>
 *
 * The adapter speaks the {@link SourceAdapter} interface but its
 * `fetchTournament` is special: each tournament page tells us which decks
 * to fetch by slug, and we fetch them with a bounded concurrency pool.
 *
 * Card identifiers come back as `"<setCode>-<NNN>"` printing ids; the
 * pipeline's card index resolves them deterministically against the
 * pinned `cards-vN`.
 */
import { createHash } from "node:crypto";
import { fetch } from "undici";
import { HttpCache } from "./httpCache.js";
import type { RawDeck, RawTournament, SourceAdapter, TournamentRef } from "./types.js";

const BASE = "https://api.dotgg.gg/cgfw";
const PER_REQUEST_TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 3;

/**
 * Default request spacing in ms. The rate limiter is a leaky bucket: the
 * next request returns after `requestSpacingMs` since the previous request
 * was issued, regardless of how many workers call it concurrently.
 *
 * Empirical Cloudflare 1015 thresholds on `api.dotgg.gg`:
 *   - 250 ms (4 RPS)  → trips within seconds
 *   - 500 ms (2 RPS)  → trips after ~50 s
 *   - 750 ms (1.3 RPS) → stable in our tests
 *   - 1100 ms (0.9 RPS) → comfortable, used by the prior long-running backfill
 *
 * We default to 750 ms, which is ~30 % faster than 1100 ms while still
 * leaving headroom for the listing+detail+deck request mix. The
 * `--rate-limit-ms` CLI flag lets a caller go faster or slower.
 */
const DEFAULT_REQUEST_SPACING_MS = 750;
const JITTER_RATIO = 0.15;

/**
 * If the server tells us to wait longer than this on a 429, we bail and
 * let the orchestrator resume on a future run rather than block CI for
 * an hour. Cloudflare 1015 cooldowns are usually 5-10 minutes, so 15 min
 * gives us enough headroom to nap through one and keep the warmed state
 * (card index, prior dataset, HTTP cache) rather than restart.
 */
const MAX_RETRY_AFTER_MS = 15 * 60_000;

/**
 * On every 429 we permanently multiply the rate-limit interval by this
 * factor, up to {@link MAX_ADAPTIVE_SPACING_MS}. The idea: if the server
 * is pushing back, the configured rate is too fast for *this* session; a
 * one-way slowdown auto-discovers the sustainable ceiling without needing
 * the operator to tune `--rate-limit-ms` by hand.
 */
const ADAPTIVE_SLOWDOWN_FACTOR = 1.5;
const MAX_ADAPTIVE_SPACING_MS = 5_000;
/**
 * With N concurrent workers, a single Cloudflare 1015 event typically
 * produces N near-simultaneous 429 responses (all workers had requests
 * in-flight when the limit tripped). Without a debounce each one would
 * independently multiply the interval, blowing past the sustainable
 * rate. Debounce so we only slow down once per "event window".
 */
const SLOWDOWN_DEBOUNCE_MS = 30_000;
const USER_AGENT = "lorcana-scraper (+https://github.com/bjorvack/lorcana-scraper)";

/**
 * Leaky-bucket rate limiter: every `acquire()` returns after the bucket has
 * "filled" enough since the previous acquire. N parallel callers all share
 * the same `nextSlot` so the average rate is exactly `1000/intervalMs` RPS
 * regardless of concurrency.
 */
class RateLimiter {
  private nextSlot = 0;
  constructor(
    private intervalMs: number,
    private jitterRatio = JITTER_RATIO,
    private readonly maxIntervalMs = MAX_ADAPTIVE_SPACING_MS,
  ) {}
  async acquire(): Promise<void> {
    const now = Date.now();
    const wait = Math.max(0, this.nextSlot - now);
    // Jitter prevents N workers issuing in lock-step bursts after every
    // acquire() returns simultaneously.
    const jitter = this.intervalMs * this.jitterRatio * (Math.random() * 2 - 1);
    this.nextSlot = Math.max(now, this.nextSlot) + this.intervalMs + jitter;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
  /** Push the next slot back (after a 429). */
  penalise(extraMs: number): void {
    this.nextSlot = Math.max(this.nextSlot, Date.now()) + extraMs;
  }
  private lastSlowdownAt = 0;
  /**
   * Permanently widen the spacing for the remainder of the session, capped
   * at {@link maxIntervalMs}. Returns the new interval so callers can log.
   * Debounced: calls within {@link SLOWDOWN_DEBOUNCE_MS} of the previous
   * one are treated as the same 1015 event and ignored so concurrent
   * workers don't compound the multiplier.
   */
  slowDown(factor = ADAPTIVE_SLOWDOWN_FACTOR): number {
    const now = Date.now();
    if (now - this.lastSlowdownAt < SLOWDOWN_DEBOUNCE_MS) return this.intervalMs;
    this.lastSlowdownAt = now;
    this.intervalMs = Math.min(this.maxIntervalMs, Math.ceil(this.intervalMs * factor));
    return this.intervalMs;
  }
  get intervalMillis(): number {
    return this.intervalMs;
  }
}

export interface LorcanaGgOptions {
  /** Hard cap on pagination. Default 200 (~6000 tournaments). */
  readonly maxPages?: number;
  /**
   * Sharding: only list pages in the closed range [pageFrom, pageTo]. Used
   * by CI matrix jobs to split the ~57 listing pages across N runners so
   * each gets its own Cloudflare rate-limit budget. Defaults to [1,
   * maxPages].
   */
  readonly pageFrom?: number;
  readonly pageTo?: number;
  /** Maximum simultaneous deck fetches per tournament. Default 3. */
  readonly deckConcurrency?: number;
  /**
   * Optional callback: when listing tournaments, stop paginating as soon
   * as we see a tournamentKey for which `priorSeen(key)` returns true.
   * Used by the orchestrator to make incremental runs fast.
   */
  readonly priorSeen?: (tournamentKey: string) => boolean;
  /**
   * Deck-level skip predicate (D1). The adapter computes the
   * prospective `Deck.externalKey` from `(sourceName, deck slug
   * URL)` BEFORE fetching deck content; if `priorDecksSeen(key)`
   * is true we skip the fetch entirely. The orchestrator's E1 merge
   * fills the prior copy back in on the way out, so net effect is
   * "don't re-download decks we already have".
   */
  readonly priorDecksSeen?: (deckExternalKey: string) => boolean;
  /**
   * Short-circuit pagination once `listTournaments` has gathered this many
   * not-yet-seen refs. Helpful for dev runs ("just fetch me a couple").
   */
  readonly maxResults?: number;
  /** Skip tournaments with fewer than this many `players_count`. */
  readonly minPlayers?: number;
  /**
   * Per tournament, only fetch the top-N decks by `standing_place`. A common
   * choice is 16 (top-cut) or 32 (cut + extended). Default: no limit.
   */
  readonly maxDecksPerTournament?: number;
  /** Optional progress callback fired once per attempted deck. */
  readonly onDeckFetched?: (args: { resolved: boolean; failed: boolean }) => void;
  /** Optional callback fired right before deck fetches start. */
  readonly onTournamentStart?: (args: { deckCount: number }) => void;
  /**
   * Spacing between issued requests in ms. Lower = faster, but Cloudflare
   * 1015 trips around 4+ RPS. Default 500 ms (= 2 RPS). Concurrent fetches
   * share the same bucket so this is sustained, not per-worker.
   */
  readonly requestSpacingMs?: number;
  /**
   * Optional directory in which to persist cached JSON responses for
   * immutable endpoints (individual tournaments + decks). With a cache
   * directory set, re-runs skip the network for any URL we've previously
   * fetched successfully — genuinely free tournaments on subsequent runs.
   */
  readonly cacheDir?: string;
}

interface TournamentSummary {
  date: string;
  name: string;
  slug: string;
  organizer_name?: string;
  players_count?: string;
  format?: string;
  winner_name?: string;
}

interface TournamentDetail {
  id?: string;
  date: string;
  name: string;
  slug: string;
  organizer_name?: string;
  players_count?: string;
  format?: string;
  winner_name?: string;
  standings: StandingEntry[];
}

interface StandingEntry {
  standing_place: string;
  standing_record?: string;
  player_name?: string | null;
  slug?: string | null; // deck slug
  humanname?: string | null;
  color_amber?: string;
  color_amethyst?: string;
  color_emerald?: string;
  color_ruby?: string;
  color_sapphire?: string;
  color_steel?: string;
  archetype?: string;
  format?: string;
}

interface DeckDetail {
  slug: string;
  humanname?: string;
  deck: Record<string, string>; // "<setCode>-<NNN>" → "<count>"
}

export class LorcanaGgAdapter implements SourceAdapter {
  readonly sourceName = "lorcana.gg";

  private readonly rateLimiter: RateLimiter;
  private readonly cache: HttpCache | null;

  constructor(private readonly opts: LorcanaGgOptions = {}) {
    this.rateLimiter = new RateLimiter(opts.requestSpacingMs ?? DEFAULT_REQUEST_SPACING_MS);
    this.cache = opts.cacheDir ? new HttpCache(opts.cacheDir) : null;
  }

  /** Expose cache hit/miss counters for end-of-run reporting. */
  cacheStats(): { hits: number; misses: number } | null {
    return this.cache?.stats() ?? null;
  }

  async listTournaments(): Promise<TournamentRef[]> {
    const maxPages = this.opts.maxPages ?? 200;
    const maxResults = this.opts.maxResults ?? Number.POSITIVE_INFINITY;
    const minPlayers = this.opts.minPlayers ?? 0;
    const pageFrom = Math.max(1, this.opts.pageFrom ?? 1);
    const pageTo = Math.min(maxPages, this.opts.pageTo ?? maxPages);
    const refs: TournamentRef[] = [];
    for (let page = pageFrom; page <= pageTo; page++) {
      const summaries = await this.fetchTournamentsPage(page);
      if (summaries.length === 0) break;
      for (const s of summaries) {
        const url = tournamentUrl(s.slug);
        // Dedup key matches `mergeTournaments`' `tournamentKeyOf`
        // (sourceName + sourceUrl) so a re-run with `--prior` skips
        // tournaments already in the prior dataset.
        const key = `${this.sourceName}:${url}`;
        if (this.opts.priorSeen?.(key)) continue;
        const players = Number.parseInt(s.players_count ?? "0", 10);
        if (Number.isFinite(players) && players < minPlayers) continue;
        refs.push({
          tournamentKey: key,
          sourceUrl: url,
          name: s.name,
          date: toIsoDate(s.date),
        });
        if (refs.length >= maxResults) return refs;
      }
    }
    return refs;
  }

  async fetchTournament(ref: TournamentRef): Promise<RawTournament> {
    const slug = slugFromUrl(ref.sourceUrl);
    const detail = await this.fetchTournamentDetail(slug);
    // With a shared rate limiter the effective RPS is constant regardless
    // of concurrency, so we can safely run 4 workers in parallel. That
    // pipelines JSON parsing while the next request is in flight.
    const concurrency = this.opts.deckConcurrency ?? 4;
    let standings = detail.standings.filter((s) => typeof s.slug === "string" && s.slug);
    // Top-N by placement (1 is the best, missing places sort last).
    standings.sort(
      (a, b) =>
        (Number.parseInt(a.standing_place, 10) || Number.MAX_SAFE_INTEGER) -
        (Number.parseInt(b.standing_place, 10) || Number.MAX_SAFE_INTEGER),
    );
    if (typeof this.opts.maxDecksPerTournament === "number") {
      standings = standings.slice(0, this.opts.maxDecksPerTournament);
    }
    this.opts.onTournamentStart?.({ deckCount: standings.length });
    const onDeckFetched = this.opts.onDeckFetched;
    const decks = await mapInPool(standings, concurrency, async (s) => {
      const result = await this.standingToRawDeck(s);
      onDeckFetched?.({ resolved: result !== null, failed: result === null });
      return result;
    });
    const isoDate = toIsoDate(detail.date);

    return {
      sourceUrl: tournamentUrl(slug),
      name: detail.name,
      date: isoDate,
      decks: decks.filter((d): d is RawDeck => d !== null),
    };
  }

  private async standingToRawDeck(s: StandingEntry): Promise<RawDeck | null> {
    if (!s.slug) return null;
    // D1: skip the network round-trip if we already have this deck
    // in the prior dataset. The pipeline's E1 merge will re-attach
    // the prior copy so the resulting tournament is unchanged.
    const externalUrl = `https://lorcana.gg/decks/${s.slug}`;
    if (this.opts.priorDecksSeen?.(deckExternalKey(this.sourceName, externalUrl))) {
      return null;
    }
    const deck = await this.fetchDeck(s.slug);
    if (!deck) return null;
    const cards: { rawName: string; count: number }[] = [];
    for (const [printingId, rawCount] of Object.entries(deck.deck ?? {})) {
      const count = Number.parseInt(rawCount, 10);
      if (!Number.isFinite(count) || count <= 0) continue;
      cards.push({ rawName: printingId, count });
    }
    if (cards.length === 0) return null;
    return {
      placement: parseIntOrUndefined(s.standing_place),
      player: s.player_name ?? undefined,
      inks: inksFromStanding(s),
      cards,
      externalId: s.slug,
      externalUrl: `https://lorcana.gg/decks/${s.slug}`,
      displayName: s.humanname ?? undefined,
    };
  }

  private async fetchTournamentsPage(page: number): Promise<TournamentSummary[]> {
    const url = `${BASE}/gettournaments?game=lorcana&page=${page}`;
    return await this.getJson<TournamentSummary[]>(url, []);
  }

  private async fetchTournamentDetail(slug: string): Promise<TournamentDetail> {
    const url = `${BASE}/gettournament?game=lorcana&slug=${encodeURIComponent(slug)}`;
    return await this.getJson<TournamentDetail>(url);
  }

  private async fetchDeck(slug: string): Promise<DeckDetail | null> {
    const url = `${BASE}/getdeck?game=lorcana&slug=${encodeURIComponent(slug)}`;
    try {
      return await this.getJson<DeckDetail>(url);
    } catch {
      // A 404 / parse error on one deck shouldn't fail the whole run; the
      // orchestrator's resolution report will surface it.
      return null;
    }
  }

  private async getJson<T>(url: string, fallback?: T): Promise<T> {
    // Only cache individual tournament + deck endpoints; listing pages are
    // mutable as new tournaments appear.
    const cacheable =
      this.cache !== null && (url.includes("/gettournament?") || url.includes("/getdeck?"));
    if (cacheable) {
      const cached = await this.cache!.get<T>(url);
      if (cached !== null) return cached;
    }
    let lastErr: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      await this.rateLimiter.acquire();
      try {
        const res = await timedFetch(url);
        if (res.status === 429) {
          const retryAfterMs = Number(res.headers.get("retry-after") ?? "0") * 1000;
          if (retryAfterMs > MAX_RETRY_AFTER_MS) {
            throw new Error(
              `${url}: HTTP 429 with retry-after=${retryAfterMs / 1000}s — refusing to wait`,
            );
          }
          // Push every other in-flight worker out by retryAfter as well — they
          // were issued at roughly the same rate so they'd all 429 in a row.
          const waitMs = Math.max(retryAfterMs, backoff(attempt));
          this.rateLimiter.penalise(waitMs);
          // Adaptive slowdown: the configured rate is too fast for this
          // session, so widen the interval permanently (capped).
          const newInterval = this.rateLimiter.slowDown();
          console.warn(
            `  [lorcana.gg] 429 on ${url} — sleeping ${(waitMs / 1000).toFixed(0)}s, new spacing ${newInterval}ms`,
          );
          await sleep(waitMs);
          continue;
        }
        if (res.status === 404) {
          if (fallback !== undefined) return fallback;
          throw new Error(`${url}: HTTP 404`);
        }
        if (res.status >= 500) {
          lastErr = new Error(`${url}: HTTP ${res.status}`);
          await sleep(backoff(attempt));
          continue;
        }
        if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
        const parsed = (await res.json()) as T;
        if (cacheable) await this.cache!.set(url, parsed);
        return parsed;
      } catch (err) {
        lastErr = err;
        if (attempt === MAX_ATTEMPTS) break;
        await sleep(backoff(attempt));
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(`Failed to fetch ${url}`);
  }
}

export const lorcanaGg = new LorcanaGgAdapter();

// ---------- helpers (exported for tests) ----------

export function tournamentKey(sourceName: string, slug: string): string {
  return `${sourceName}:${slug}`;
}

/**
 * Same formula the pipeline uses to stamp `Deck.externalKey` —
 * sha256(`<sourceName>|<externalUrl>`). Adapters call this BEFORE
 * fetching to consult `priorDecksSeen` (D1).
 */
export function deckExternalKey(sourceName: string, externalUrl: string): string {
  return createHash("sha256").update(`${sourceName}|${externalUrl}`).digest("hex");
}

export function tournamentUrl(slug: string): string {
  return `https://lorcana.gg/tournaments/${slug}`;
}

export function slugFromUrl(url: string): string {
  const m = /\/tournaments\/([^/?#]+)/.exec(url);
  if (!m || !m[1]) throw new Error(`Cannot extract slug from URL: ${url}`);
  return m[1];
}

export function toIsoDate(unixSecondsAsString: string): string {
  const seconds = Number.parseInt(unixSecondsAsString, 10);
  if (!Number.isFinite(seconds)) {
    throw new Error(`Invalid unix timestamp: ${unixSecondsAsString}`);
  }
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

export function inksFromStanding(s: StandingEntry): string[] {
  const cols: [string, string | undefined][] = [
    ["Amber", s.color_amber],
    ["Amethyst", s.color_amethyst],
    ["Emerald", s.color_emerald],
    ["Ruby", s.color_ruby],
    ["Sapphire", s.color_sapphire],
    ["Steel", s.color_steel],
  ];
  return cols
    .filter(([, v]) => v !== undefined && Number.parseInt(v, 10) > 0)
    .map(([name]) => name);
}

function parseIntOrUndefined(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) ? n : undefined;
}

async function mapInPool<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function pump(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i]!);
    }
  }
  const lanes = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: lanes }, () => pump()));
  return results;
}

async function timedFetch(url: string) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), PER_REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, {
      headers: { "user-agent": USER_AGENT, accept: "application/json" },
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(t);
  }
}

function backoff(attempt: number): number {
  return 250 * 2 ** (attempt - 1) + Math.floor(Math.random() * 100);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
