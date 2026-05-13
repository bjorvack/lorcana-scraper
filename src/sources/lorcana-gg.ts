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
import { fetch } from "undici";
import type { RawDeck, RawTournament, SourceAdapter, TournamentRef } from "./types.js";

const BASE = "https://api.dotgg.gg/cgfw";
const PER_REQUEST_TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 3;
/**
 * `api.dotgg.gg` is fronted by Cloudflare with an aggressive request-rate
 * rule. Empirically 4 RPS sustained from one IP triggers a 1015 ratelimit
 * (`retry-after` measured in minutes). 1.1 s/req puts us comfortably under
 * the threshold and keeps a 1.1k-deck backfill at ≈20 min of wall-clock.
 */
const MIN_GAP_MS = 1100;
/**
 * If the server tells us to wait longer than this on a 429, we bail and
 * let the orchestrator resume on a future run rather than block CI for
 * an hour. Cloudflare 1015 cooldowns are usually 5-10 minutes.
 */
const MAX_RETRY_AFTER_MS = 60_000;
const USER_AGENT = "lorcana-scraper (+https://github.com/bjorvack/lorcana-scraper)";

export interface LorcanaGgOptions {
  /** Hard cap on pagination. Default 200 (~6000 tournaments). */
  readonly maxPages?: number;
  /** Maximum simultaneous deck fetches per tournament. Default 3. */
  readonly deckConcurrency?: number;
  /**
   * Optional callback: when listing tournaments, stop paginating as soon
   * as we see a tournamentKey for which `priorSeen(key)` returns true.
   * Used by the orchestrator to make incremental runs fast.
   */
  readonly priorSeen?: (tournamentKey: string) => boolean;
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

  private lastRequestAt = 0;

  constructor(private readonly opts: LorcanaGgOptions = {}) {}

  async listTournaments(): Promise<TournamentRef[]> {
    const maxPages = this.opts.maxPages ?? 200;
    const maxResults = this.opts.maxResults ?? Number.POSITIVE_INFINITY;
    const minPlayers = this.opts.minPlayers ?? 0;
    const refs: TournamentRef[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const summaries = await this.fetchTournamentsPage(page);
      if (summaries.length === 0) break;
      let stopEarly = false;
      for (const s of summaries) {
        const key = tournamentKey(this.sourceName, s.slug);
        if (this.opts.priorSeen?.(key)) {
          stopEarly = true;
          continue;
        }
        const players = Number.parseInt(s.players_count ?? "0", 10);
        if (Number.isFinite(players) && players < minPlayers) continue;
        refs.push({
          tournamentKey: key,
          sourceUrl: tournamentUrl(s.slug),
          name: s.name,
          date: toIsoDate(s.date),
        });
        if (refs.length >= maxResults) return refs;
      }
      if (stopEarly) break;
    }
    return refs;
  }

  async fetchTournament(ref: TournamentRef): Promise<RawTournament> {
    const slug = slugFromUrl(ref.sourceUrl);
    const detail = await this.fetchTournamentDetail(slug);
    const concurrency = this.opts.deckConcurrency ?? 1;
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
    let lastErr: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      await this.respectMinGap();
      try {
        const res = await timedFetch(url);
        if (res.status === 429) {
          const retryAfterMs = Number(res.headers.get("retry-after") ?? "0") * 1000;
          if (retryAfterMs > MAX_RETRY_AFTER_MS) {
            throw new Error(
              `${url}: HTTP 429 with retry-after=${retryAfterMs / 1000}s — refusing to wait`,
            );
          }
          await sleep(Math.max(retryAfterMs, backoff(attempt)));
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
        return (await res.json()) as T;
      } catch (err) {
        lastErr = err;
        if (attempt === MAX_ATTEMPTS) break;
        await sleep(backoff(attempt));
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(`Failed to fetch ${url}`);
  }

  private async respectMinGap(): Promise<void> {
    const wait = MIN_GAP_MS - (Date.now() - this.lastRequestAt);
    if (wait > 0) await sleep(wait);
    this.lastRequestAt = Date.now();
  }
}

export const lorcanaGg = new LorcanaGgAdapter();

// ---------- helpers (exported for tests) ----------

export function tournamentKey(sourceName: string, slug: string): string {
  return `${sourceName}:${slug}`;
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
