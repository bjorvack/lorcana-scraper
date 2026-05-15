/**
 * lorcana.gg / api.dotgg.gg adapter — documented public API.
 *
 * Talks to ONE endpoint:
 *
 *   GET /cgfw/getdecks?game=lorcana&rq=<urlencoded JSON>
 *
 * (see https://dotgg.gg/api/ for the spec). We filter to
 * `getdecks.is_tournament = "1"` and sort by date desc, then
 * group decks by tournament slug parsed out of the
 * `description` field — the doc-promised `tournament` object
 * isn't populated for Lorcana yet but the description's anchor
 * gives us slug + placement + tournament name.
 *
 * Each `/getdecks` page already contains the full deck list
 * (`deck` field, `Record<setNumber, qty>` strings), so we don't
 * need a per-deck round trip — the previous adapter's
 * `gettournament` + `getdeck` calls are gone.
 *
 * Trade-offs vs the old undocumented endpoints:
 *   - Lost: player_name (`authornick` is null for tournament decks).
 *   - Lost: standing_record (W-L-D).
 *   - Lost: players_count (no min-players gate possible — we
 *     proxy it with "had at least N decks placing" via the
 *     adapter's deck count).
 *   - Lost: precise tournament date (we use the latest deck
 *     date in the group, which is effectively the tournament
 *     date for finalised events).
 *
 * Card identifiers are still `"<set>-<NNN>"` strings; the
 * pipeline's `parsePrintingId` resolves them deterministically.
 */
import { createHash } from "node:crypto";
import { fetch } from "undici";
import { HttpCache } from "./httpCache.js";
import type { RawDeck, RawTournament, SourceAdapter, TournamentRef } from "./types.js";

const BASE = "https://api.dotgg.gg/cgfw";
const PER_REQUEST_TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 3;

/** /getdecks documented max page size. */
const PAGE_SIZE = 30;

/**
 * Default request spacing. The /getdecks endpoint is friendlier
 * than the old undocumented tournament endpoints, but the same
 * Cloudflare front sits in front of api.dotgg.gg, so we keep
 * the conservative spacing from before.
 */
const DEFAULT_REQUEST_SPACING_MS = 750;
const JITTER_RATIO = 0.15;
const MAX_RETRY_AFTER_MS = 15 * 60_000;
const ADAPTIVE_SLOWDOWN_FACTOR = 1.5;
const MAX_ADAPTIVE_SPACING_MS = 5_000;
const SLOWDOWN_DEBOUNCE_MS = 30_000;
const USER_AGENT = "lorcana-scraper (+https://github.com/bjorvack/lorcana-scraper)";

/**
 * Stop pagination when we've seen this many consecutive
 * already-ingested decks without a single new tournament
 * appearing. The counter resets the moment we encounter a
 * deck whose tournament is NOT in `priorSeen`.
 *
 * A *deck-level* threshold (rather than per-page) is the only
 * correct heuristic because /getdecks is sorted by deck date
 * desc and a single popular tournament can easily span 4+
 * pages on its own. Mulligan Challenge #25 had 108 decks,
 * filling pages 1-4. With a per-page heuristic of 2 we
 * stopped at page 2 and missed legitimate new tournaments
 * that started appearing on page 3.
 *
 * 240 covers the biggest published Lorcana tournaments
 * (DLC top-cut + Swiss = ~256 decks) with margin. If a
 * single tournament ever exceeds this we'd false-stop, but
 * the next run will catch any tail because /getdecks keeps
 * paginating older tournaments after a big one finishes.
 */
const STOP_AFTER_PRIOR_SEEN_DECKS = 240;

class RateLimiter {
  private nextSlot = 0;
  private lastSlowdownAt = 0;
  constructor(
    private intervalMs: number,
    private jitterRatio = JITTER_RATIO,
    private readonly maxIntervalMs = MAX_ADAPTIVE_SPACING_MS,
  ) {}
  async acquire(): Promise<void> {
    const now = Date.now();
    const wait = Math.max(0, this.nextSlot - now);
    const jitter = this.intervalMs * this.jitterRatio * (Math.random() * 2 - 1);
    this.nextSlot = Math.max(now, this.nextSlot) + this.intervalMs + jitter;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
  penalise(extraMs: number): void {
    this.nextSlot = Math.max(this.nextSlot, Date.now()) + extraMs;
  }
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
  /** Hard cap on pagination. Default 500 pages × 30 decks = 15k decks. */
  readonly maxPages?: number;
  /** Skip tournaments the orchestrator has already ingested. */
  readonly priorSeen?: (tournamentKey: string) => boolean;
  /** Skip individual decks already in the prior dataset (D1). */
  readonly priorDecksSeen?: (deckExternalKey: string) => boolean;
  /** Stop once we've collected this many NEW (un-seen) tournament refs. */
  readonly maxResults?: number;
  /**
   * Min "deck count" gate. The documented API doesn't expose
   * `players_count`, so we use the number of decks observed for
   * a tournament as a proxy. A tournament is dropped if fewer
   * than `minPlayers` decks were ingested for it.
   */
  readonly minPlayers?: number;
  /** Per tournament, only keep the top-N decks by placement. */
  readonly maxDecksPerTournament?: number;
  /** Optional progress callback fired once per attempted deck. */
  readonly onDeckFetched?: (args: { resolved: boolean; failed: boolean }) => void;
  /** B2 streaming hook fired with each `RawDeck` as it's parsed. */
  readonly onDeckScraped?: (deck: RawDeck) => void;
  /** Fired right before we start emitting decks for a tournament. */
  readonly onTournamentStart?: (args: { deckCount: number }) => void;
  /** Override request spacing (ms). */
  readonly requestSpacingMs?: number;
  /**
   * Optional HTTP cache directory. /getdecks is paginated by
   * date desc, so listing pages get a short TTL — the rest of
   * the data is finalised once a tournament closes.
   */
  readonly cacheDir?: string;
  /** Compatibility shims (no-ops for the documented adapter). */
  readonly pageFrom?: number;
  readonly pageTo?: number;
  readonly deckConcurrency?: number;
}

/** Raw shape of a /getdecks deck entry (only the fields we use). */
interface DeckListEntry {
  slug: string;
  humanname?: string | null;
  date: string; // unix seconds as string
  description?: string | null; // HTML, e.g. `<a href="/tournaments/foo">Place 1 on Foo</a>`
  is_tournament?: string;
  color_amber?: string;
  color_amethyst?: string;
  color_emerald?: string;
  color_ruby?: string;
  color_sapphire?: string;
  color_steel?: string;
  deck?: Record<string, string>; // "<set>-<NNN>" → "<count>"
}

interface ParsedDescription {
  tournamentSlug: string;
  tournamentName: string;
  placement?: number;
}

interface PendingTournament {
  ref: TournamentRef;
  rawDecks: RawDeck[];
  /** Latest seen unix-seconds date across this tournament's decks. */
  latestDate: number;
}

export class LorcanaGgAdapter implements SourceAdapter {
  readonly sourceName = "lorcana.gg";

  private readonly rateLimiter: RateLimiter;
  private readonly cache: HttpCache | null;
  /** Populated by `listTournaments`, drained by `fetchTournament`. */
  private readonly pending = new Map<string, PendingTournament>();

  constructor(private readonly opts: LorcanaGgOptions = {}) {
    this.rateLimiter = new RateLimiter(opts.requestSpacingMs ?? DEFAULT_REQUEST_SPACING_MS);
    this.cache = opts.cacheDir ? new HttpCache(opts.cacheDir) : null;
  }

  cacheStats(): { hits: number; misses: number } | null {
    return this.cache?.stats() ?? null;
  }

  async listTournaments(): Promise<TournamentRef[]> {
    const maxPages = this.opts.maxPages ?? 500;
    const maxResults = this.opts.maxResults ?? Number.POSITIVE_INFINITY;
    const minPlayers = this.opts.minPlayers ?? 0;
    const maxDecksPerTournament = this.opts.maxDecksPerTournament;
    const priorSeen = this.opts.priorSeen ?? (() => false);
    const priorDecksSeen = this.opts.priorDecksSeen ?? (() => false);

    this.pending.clear();

    let priorSeenStreak = 0;
    pages: for (let page = 1; page <= maxPages; page++) {
      const entries = await this.fetchDecksPage(page);
      if (entries.length === 0) break;

      for (const e of entries) {
        const parsed = parseDescription(e.description);
        if (!parsed) continue; // tournament link missing → skip
        const url = tournamentUrl(parsed.tournamentSlug);
        const tournamentKeyVal = `${this.sourceName}:${url}`;

        if (priorSeen(tournamentKeyVal)) {
          // Deck-level streak — see STOP_AFTER_PRIOR_SEEN_DECKS doc.
          priorSeenStreak++;
          if (priorSeenStreak >= STOP_AFTER_PRIOR_SEEN_DECKS) break pages;
          continue;
        }
        priorSeenStreak = 0;

        const externalUrl = `https://lorcana.gg/decks/${e.slug}`;
        if (priorDecksSeen(deckExternalKey(this.sourceName, externalUrl))) continue;

        const rawDeck = entryToRawDeck(e, parsed, externalUrl);
        if (!rawDeck) continue;

        const dateSecs = Number.parseInt(e.date, 10) || 0;
        let bucket = this.pending.get(tournamentKeyVal);
        if (!bucket) {
          bucket = {
            ref: {
              tournamentKey: tournamentKeyVal,
              sourceUrl: url,
              name: parsed.tournamentName,
              date: toIsoDate(e.date),
            },
            rawDecks: [],
            latestDate: dateSecs,
          };
          this.pending.set(tournamentKeyVal, bucket);
        }
        bucket.rawDecks.push(rawDeck);
        if (dateSecs > bucket.latestDate) {
          bucket.latestDate = dateSecs;
          // Refresh the ref's date so it reflects the freshest deck.
          (bucket.ref as { date?: string }).date = toIsoDate(e.date);
        }
      }

      if (this.pending.size >= maxResults) break;
      if (entries.length < PAGE_SIZE) break;
    }

    // Apply min-deck and top-N caps. minPlayers acts as a deck-count
    // proxy now (see option doc).
    const refs: TournamentRef[] = [];
    for (const [key, t] of this.pending) {
      if (t.rawDecks.length < minPlayers) {
        this.pending.delete(key);
        continue;
      }
      // Sort by placement asc; missing placement sinks to the bottom.
      t.rawDecks.sort(
        (a, b) =>
          (a.placement ?? Number.MAX_SAFE_INTEGER) - (b.placement ?? Number.MAX_SAFE_INTEGER),
      );
      if (typeof maxDecksPerTournament === "number") {
        t.rawDecks.length = Math.min(t.rawDecks.length, maxDecksPerTournament);
      }
      refs.push(t.ref);
    }
    return refs;
  }

  async fetchTournament(ref: TournamentRef): Promise<RawTournament> {
    const bucket = this.pending.get(ref.tournamentKey);
    if (!bucket) {
      // listTournaments wasn't called or the ref is unknown — fall back
      // to an empty tournament; the orchestrator will treat it as a
      // resolution failure rather than crash.
      return {
        sourceUrl: ref.sourceUrl,
        name: ref.name ?? slugFromUrl(ref.sourceUrl),
        date: ref.date ?? new Date().toISOString().slice(0, 10),
        decks: [],
      };
    }
    this.opts.onTournamentStart?.({ deckCount: bucket.rawDecks.length });
    const onFetched = this.opts.onDeckFetched;
    const onScraped = this.opts.onDeckScraped;
    for (const d of bucket.rawDecks) {
      onFetched?.({ resolved: true, failed: false });
      onScraped?.(d);
    }
    return {
      sourceUrl: ref.sourceUrl,
      name: ref.name ?? bucket.ref.name ?? slugFromUrl(ref.sourceUrl),
      date: ref.date ?? bucket.ref.date ?? toIsoDate(String(bucket.latestDate)),
      decks: bucket.rawDecks,
    };
  }

  private async fetchDecksPage(page: number): Promise<DeckListEntry[]> {
    const rq = JSON.stringify({
      page,
      limit: PAGE_SIZE,
      srt: "date",
      direct: "desc",
      type: "",
      my: 0,
      myarchive: 0,
      fav: 0,
      getdecks: {
        hascrd: [],
        nothascrd: [],
        youtube: 0,
        smartsrch: "",
        date: "",
        color: [],
        collection: 0,
        topset: "",
        at: 0,
        format: "",
        is_tournament: "1",
        legalonly: 0,
        priceMin: "",
        priceMax: "",
        priceCurrency: "usd",
        placement: "",
      },
    });
    const url = `${BASE}/getdecks?game=lorcana&rq=${encodeURIComponent(rq)}`;
    return await this.getJson<DeckListEntry[]>(url, []);
  }

  private async getJson<T>(url: string, fallback?: T): Promise<T> {
    // /getdecks is a listing endpoint sorted by date desc — short TTL.
    if (this.cache !== null) {
      const cached = await this.cache.getWithinTtl<T>(url, 15 * 60_000);
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
          const waitMs = Math.max(retryAfterMs, backoff(attempt));
          this.rateLimiter.penalise(waitMs);
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
        if (this.cache !== null) await this.cache.set(url, parsed);
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

/** Subset of the /getdecks ink fields, accepted by `inksFromStanding`. */
export interface InkFields {
  color_amber?: string;
  color_amethyst?: string;
  color_emerald?: string;
  color_ruby?: string;
  color_sapphire?: string;
  color_steel?: string;
}

export function inksFromStanding(s: InkFields): string[] {
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

/**
 * Parse the deck `description` field from /getdecks. Lorcana
 * tournament decks come back as
 *
 *   `<a href="/tournaments/<slug>">Place <N> on <Tournament Name></a>`
 *
 * Returns `null` for non-tournament descriptions.
 */
export function parseDescription(html: string | null | undefined): ParsedDescription | null {
  if (!html) return null;
  const anchor = /<a\s+href="\/tournaments\/([^"]+)"[^>]*>([^<]+)<\/a>/i.exec(html);
  if (!anchor) return null;
  const tournamentSlug = decodeURIComponent(anchor[1]!);
  const text = anchor[2]!.trim();
  // "Place <N> on <Name>" or "Top <N> at <Name>", be lenient.
  const m = /^(?:Place|Top)\s+(\d+)\s+(?:on|at)\s+(.+)$/i.exec(text);
  if (m) {
    return {
      tournamentSlug,
      tournamentName: m[2]!.trim(),
      placement: Number.parseInt(m[1]!, 10),
    };
  }
  // Fallback: no placement, but a tournament anchor — keep the slug.
  return { tournamentSlug, tournamentName: text, placement: undefined };
}

function entryToRawDeck(
  e: DeckListEntry,
  parsed: ParsedDescription,
  externalUrl: string,
): RawDeck | null {
  const cards: { rawName: string; count: number }[] = [];
  for (const [printingId, rawCount] of Object.entries(e.deck ?? {})) {
    const count = Number.parseInt(rawCount, 10);
    if (!Number.isFinite(count) || count <= 0) continue;
    cards.push({ rawName: printingId, count });
  }
  if (cards.length === 0) return null;
  return {
    placement: parsed.placement,
    player: undefined,
    inks: inksFromStanding(e),
    cards,
    externalId: e.slug,
    externalUrl,
    displayName: e.humanname ?? undefined,
  };
}

async function timedFetch(url: string) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PER_REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, {
      signal: ctrl.signal,
      headers: {
        accept: "application/json",
        "user-agent": USER_AGENT,
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

function backoff(attempt: number): number {
  return Math.min(15_000, 500 * 2 ** (attempt - 1));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
