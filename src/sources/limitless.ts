/**
 * Limitless TCG adapter (play.limitlesstcg.com).
 *
 * Limitless hosts tournaments for many TCGs including Disney Lorcana
 * (game id ``LORCANA``). This is a **public, documented REST API**
 * that returns clean JSON — no HTML scraping, no Cloudflare
 * Turnstile, no headless browser.
 *
 * Endpoints used (all relative to ``https://play.limitlesstcg.com/api``):
 *
 *   GET /tournaments?game=LORCANA&limit=100&page=N
 *     → array of `{ id, name, date, players, ... }`
 *
 *   GET /tournaments/{id}/details
 *     → adds `format`, `phases`, `decklists: boolean`, ...
 *
 *   GET /tournaments/{id}/standings
 *     → array of player entries with `placing`, `record`, `decklist`,
 *       `deck: { id, name }` (auto-assigned ink combo).
 *
 * Rate limit (no API key): 50 requests per 5 minutes. We pace at
 * ``DEFAULT_REQUEST_SPACING_MS`` to stay under that while still
 * scraping 70+ tournaments + their standings in a single run.
 *
 * Card-id mapping is direct: Limitless emits
 * ``{ set: "001", number: "174", count: 4, name: "..." }`` per card,
 * which we serialise to ``"001-174"`` — the existing pipeline's
 * ``parsePrintingId`` resolves that to ``Card`` deterministically.
 */
import { createHash } from "node:crypto";
import { fetch } from "undici";

import { HttpCache } from "./httpCache.js";
import type { RawDeck, RawTournament, SourceAdapter, TournamentRef } from "./types.js";

const SOURCE_NAME = "limitlesstcg.com";
const BASE = "https://play.limitlesstcg.com/api";
const USER_AGENT = "lorcana-scraper (+https://github.com/bjorvack/lorcana-scraper)";
const PER_REQUEST_TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 3;
/**
 * Documented rate limit: 50 req per 5 min ≈ 6 s per request. We
 * pace at 6500ms (slightly under) so a small burst never trips it.
 */
const DEFAULT_REQUEST_SPACING_MS = 6_500;
/** Tournaments per listing page; 100 is the documented max. */
const LISTING_PAGE_SIZE = 100;

export interface LimitlessAdapterOptions {
  /** Skip tournaments whose key the orchestrator already has. */
  readonly priorSeen?: (tournamentKey: string) => boolean;
  /** Skip individual decks already in the prior dataset (D1). */
  readonly priorDecksSeen?: (deckExternalKey: string) => boolean;
  /** Stop listing once we've collected this many NEW (un-seen) refs. */
  readonly maxResults?: number;
  /** Min players gate. Limitless surfaces a lot of tiny weekly leagues
   *  with ~6 players that aren't worth ingesting; default cut is 8. */
  readonly minPlayers?: number;
  /** Restrict to a format. Default: ``CONSTRUCTED`` (the competitive one). */
  readonly format?: string;
  /** Per-tournament cap on decks to keep — sort by placing asc. */
  readonly maxDecksPerTournament?: number;
  /** Override request spacing in ms. */
  readonly requestSpacingMs?: number;
  /** HTTP cache directory (shared with other adapters). Tournament
   *  details + standings are finalized once published, so cache
   *  hits are effectively free re-runs. */
  readonly cacheDir?: string;
  /** B2 streaming hook. */
  readonly onDeckScraped?: (deck: RawDeck) => void;
  /** Per-deck progress callback. */
  readonly onDeckFetched?: (a: { resolved: boolean; failed: boolean }) => void;
  /** Fired once we know a tournament's deck count. */
  readonly onTournamentStart?: (a: { deckCount: number }) => void;
}

// ---- API response shapes (only the bits we use) ----

interface ApiTournamentSummary {
  readonly id: string;
  readonly name: string;
  readonly date: string;
  readonly players: number;
  readonly game: string;
  readonly format?: string;
}

interface ApiDeck {
  readonly id: string;
  readonly name: string;
}

interface ApiCard {
  readonly count: number;
  readonly name: string;
  readonly set: string;
  readonly number: string;
}

interface ApiDecklist {
  readonly character?: ApiCard[];
  readonly action?: ApiCard[];
  readonly item?: ApiCard[];
  readonly location?: ApiCard[];
}

interface ApiStandingsEntry {
  readonly name: string;
  readonly player?: string;
  readonly placing?: number;
  readonly record?: { wins: number; losses: number; ties: number };
  readonly decklist?: ApiDecklist;
  readonly deck?: ApiDeck;
  readonly drop?: number;
}

// ---- helpers ----

function tournamentKey(id: string): string {
  return createHash("sha256")
    .update(`${SOURCE_NAME}|${tournamentUrl(id)}`)
    .digest("hex");
}

function tournamentUrl(id: string): string {
  return `https://play.limitlesstcg.com/tournament/${id}`;
}

function deckUrl(tournamentId: string, playerId: string | undefined): string {
  // Limitless renders per-player decklist URLs as
  // `/tournament/<id>/player/<player>/decklist`. When `player` is
  // absent (anonymous entries) we fall back to a synthetic
  // `#placing-<n>` fragment so the deck still has a stable URL.
  return playerId
    ? `https://play.limitlesstcg.com/tournament/${tournamentId}/player/${playerId}/decklist`
    : `https://play.limitlesstcg.com/tournament/${tournamentId}`;
}

function deckExternalKey(sourceName: string, externalUrl: string): string {
  return createHash("sha256").update(`${sourceName}|${externalUrl}`).digest("hex");
}

function toIsoDate(timestamp: string): string {
  // The API returns ISO 8601 datetimes; we keep just the date part.
  return timestamp.slice(0, 10);
}

/**
 * Map Limitless's auto-assigned `deck.id` to our `Ink` enum names.
 * E.g. `"amethyst-steel"` → `["Amethyst", "Steel"]`.
 */
function inksFromDeck(deck: ApiDeck | undefined): string[] {
  if (!deck?.id) return [];
  return deck.id
    .split("-")
    .filter(Boolean)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase());
}

class RateLimiter {
  private nextSlot = 0;
  constructor(private intervalMs: number) {}
  async acquire(): Promise<void> {
    const now = Date.now();
    const wait = Math.max(0, this.nextSlot - now);
    // Tiny jitter so multiple workers don't synchronise on the slot.
    this.nextSlot = Math.max(now, this.nextSlot) + this.intervalMs;
    if (wait > 0) await sleep(wait + Math.floor(Math.random() * 50));
  }
  penalise(ms: number): void {
    this.nextSlot = Math.max(this.nextSlot, Date.now() + ms);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function backoff(attempt: number): number {
  return 500 * 2 ** (attempt - 1) + Math.floor(Math.random() * 200);
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

export class LimitlessAdapter implements SourceAdapter {
  readonly sourceName = SOURCE_NAME;
  private readonly opts: LimitlessAdapterOptions;
  private readonly rateLimiter: RateLimiter;
  private readonly cache: HttpCache | null;

  constructor(opts: LimitlessAdapterOptions = {}) {
    this.opts = opts;
    this.rateLimiter = new RateLimiter(opts.requestSpacingMs ?? DEFAULT_REQUEST_SPACING_MS);
    this.cache = opts.cacheDir ? new HttpCache(opts.cacheDir) : null;
  }

  cacheStats(): { hits: number; misses: number } | null {
    return this.cache?.stats() ?? null;
  }

  async listTournaments(): Promise<TournamentRef[]> {
    const format = this.opts.format ?? "CONSTRUCTED";
    const minPlayers = this.opts.minPlayers ?? 8;
    const maxResults = this.opts.maxResults ?? Number.POSITIVE_INFINITY;
    const refs: TournamentRef[] = [];
    for (let page = 1; ; page++) {
      const url = `${BASE}/tournaments?game=LORCANA&format=${encodeURIComponent(format)}&limit=${LISTING_PAGE_SIZE}&page=${page}`;
      const summaries = await this.getJson<ApiTournamentSummary[]>(url, []);
      if (summaries.length === 0) break;
      for (const s of summaries) {
        if (typeof s.players === "number" && s.players < minPlayers) continue;
        const tKey = tournamentKey(s.id);
        if (this.opts.priorSeen?.(tKey)) continue;
        refs.push({
          tournamentKey: tKey,
          sourceUrl: tournamentUrl(s.id),
          name: s.name,
          date: toIsoDate(s.date),
        });
        if (refs.length >= maxResults) return refs;
      }
      // Defensive: if the API returns fewer than a full page, we've
      // walked off the end. (Currently only ~71 LORCANA tournaments,
      // so this fires on page 1 already.)
      if (summaries.length < LISTING_PAGE_SIZE) break;
    }
    return refs;
  }

  async fetchTournament(ref: TournamentRef): Promise<RawTournament> {
    const id = idFromUrl(ref.sourceUrl);
    const url = `${BASE}/tournaments/${id}/standings`;
    const standings = await this.getJson<ApiStandingsEntry[]>(url);
    // Sort by placing asc (1 is the best). Anonymous-placing entries
    // sort last.
    const sorted = [...standings].sort(
      (a, b) => (a.placing ?? Number.MAX_SAFE_INTEGER) - (b.placing ?? Number.MAX_SAFE_INTEGER),
    );
    const limited =
      typeof this.opts.maxDecksPerTournament === "number"
        ? sorted.slice(0, this.opts.maxDecksPerTournament)
        : sorted;
    this.opts.onTournamentStart?.({ deckCount: limited.length });

    const decks: RawDeck[] = [];
    for (const entry of limited) {
      // D1: skip refetching decks we already have. Limitless gives us
      // the entire decklist in one bundled response so there's no
      // network cost to "skip" — we just don't emit the RawDeck and
      // let the E1 merge re-attach the prior copy.
      const dkUrl = deckUrl(id, entry.player);
      if (this.opts.priorDecksSeen?.(deckExternalKey(SOURCE_NAME, dkUrl))) {
        this.opts.onDeckFetched?.({ resolved: false, failed: false });
        continue;
      }
      const deck = standingToRawDeck(id, entry);
      if (deck) {
        decks.push(deck);
        this.opts.onDeckScraped?.(deck);
        this.opts.onDeckFetched?.({ resolved: true, failed: false });
      } else {
        this.opts.onDeckFetched?.({ resolved: false, failed: true });
      }
    }

    return {
      sourceUrl: tournamentUrl(id),
      name: ref.name ?? id,
      date: ref.date ?? "",
      decks,
    };
  }

  private async getJson<T>(url: string, fallback?: T): Promise<T> {
    if (this.cache && url.includes("/standings")) {
      // Standings are immutable once posted.
      const cached = await this.cache.get<T>(url);
      if (cached !== null) return cached;
    }
    if (this.cache && url.includes("/tournaments?")) {
      // 15-min TTL on the listing — recent tournaments may still
      // appear at the top of page 1 between runs.
      const cached = await this.cache.getWithinTtl<T>(url, 15 * 60_000);
      if (cached !== null) return cached;
    }
    let lastErr: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      await this.rateLimiter.acquire();
      try {
        const res = await timedFetch(url);
        if (res.status === 429) {
          const retryAfter = Number(res.headers.get("retry-after") ?? "0") * 1000;
          const wait = Math.max(retryAfter, backoff(attempt) * 4);
          this.rateLimiter.penalise(wait);
          process.stderr.write(
            `  [${SOURCE_NAME}] 429 on ${url} — sleeping ${(wait / 1000).toFixed(0)}s\n`,
          );
          await sleep(wait);
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
        if (this.cache && (url.includes("/standings") || url.includes("/tournaments?"))) {
          await this.cache.set(url, parsed);
        }
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

function standingToRawDeck(tournamentId: string, e: ApiStandingsEntry): RawDeck | null {
  const dl = e.decklist;
  if (!dl) return null;
  const cards: { rawName: string; count: number }[] = [];
  for (const category of ["character", "action", "item", "location"] as const) {
    for (const c of dl[category] ?? []) {
      // Limitless emits zero-padded set + number. The existing
      // parsePrintingId trims the leading zeros, so `"001-174"`
      // matches our `Card.setCode="1", cardNumber=174`.
      const rawName = `${c.set}-${c.number}`;
      const count = Number.isFinite(c.count) ? c.count : 0;
      if (count <= 0) continue;
      cards.push({ rawName, count });
    }
  }
  if (cards.length === 0) return null;

  // Inks come from Limitless's auto-assigned `deck.id` (e.g.
  // `amethyst-steel`). The orchestrator's deck-card-derived ink set
  // overrides this anyway, but supplying a starting hint helps the
  // edge case where every card resolved is a single-ink card.
  const inks = inksFromDeck(e.deck);
  return {
    placement: typeof e.placing === "number" ? e.placing : undefined,
    player: e.name,
    inks,
    cards,
    externalId: e.player ?? `${tournamentId}#${e.placing ?? "?"}`,
    externalUrl: deckUrl(tournamentId, e.player),
    displayName: e.deck?.name ?? undefined,
  };
}

function idFromUrl(url: string): string {
  const m = /\/tournament\/([^/?#]+)/.exec(url);
  if (!m || !m[1]) throw new Error(`Cannot extract tournament id from URL: ${url}`);
  return m[1];
}

export const limitless: SourceAdapter = new LimitlessAdapter();
