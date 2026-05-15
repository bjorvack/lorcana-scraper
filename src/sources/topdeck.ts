/**
 * TopDeck.gg adapter (https://topdeck.gg/disney-lorcana).
 *
 * TopDeck.gg hosts events for many TCGs including Disney Lorcana. The
 * public REST API at ``https://topdeck.gg/api/v2`` is documented at
 * https://topdeck.gg/docs/tournaments-v2 and the OpenAPI spec is at
 * https://topdeck.gg/openapi.json.
 *
 * Auth: ``Authorization: <api-key>`` header. Free key from the account
 * page. We pull it from ``process.env.TOPDECK_API_KEY``; if it's
 * missing the adapter is a soft no-op (returns 0 tournaments rather
 * than failing the whole run).
 *
 * Endpoint:
 *   POST /v2/tournaments
 *     body: { game, format, last, participantMin, columns }
 *
 * Response shape (relevant bits):
 *   [{ TID, tournamentName, startDate (unix s), game, format,
 *      topCut, swissNum,
 *      eventData: { city?, state?, ... },
 *      standings: [{ name, id, decklist, deckObj, wins, draws, losses, ... }]
 *   }]
 *
 * Disney Lorcana coverage as of 2026-05: TopDeck lists Lorcana as a
 * supported game but no completed tournaments have posted results
 * yet. The adapter is wired in advance so a future event lands in
 * the dataset on the very next scrape.
 *
 * Attribution: TopDeck's terms require visible attribution wherever
 * we surface their data. The downstream web UI's release-notes
 * footer + sources list already credits them.
 */
import { createHash } from "node:crypto";
import { fetch } from "undici";

import type { RawDeck, RawTournament, SourceAdapter, TournamentRef } from "./types.js";

const SOURCE_NAME = "topdeck.gg";
const BASE = "https://topdeck.gg/api";
const USER_AGENT = "lorcana-scraper (+https://github.com/bjorvack/lorcana-scraper)";
const PER_REQUEST_TIMEOUT_MS = 20_000;
const MAX_ATTEMPTS = 3;
/**
 * Documented rate limit on the bulk endpoint is "lower" than the
 * standard 100 req / min. Empirically the bulk endpoint cuts off
 * after a small burst, so we pace conservatively.
 */
const DEFAULT_REQUEST_SPACING_MS = 2_000;

export interface TopdeckAdapterOptions {
  /** Auth token. Defaults to ``process.env.TOPDECK_API_KEY``. */
  readonly apiKey?: string;
  /** Game to query — pinned to ``"Disney Lorcana"``. */
  readonly game?: string;
  /** Formats to walk (one bulk call per format). Defaults cover the
   *  two competitive formats; sealed/limited are excluded since they
   *  don't produce repeatable constructed decklists. */
  readonly formats?: readonly string[];
  /** Look-back window in days. */
  readonly lookbackDays?: number;
  /** Cap on tournaments emitted per run. */
  readonly maxResults?: number;
  /** Min players gate (passed to the API as ``participantMin``). */
  readonly minPlayers?: number;
  /** Per-tournament deck cap. */
  readonly maxDecksPerTournament?: number;
  /** Override request spacing. */
  readonly requestSpacingMs?: number;
  /** Tournament-level dedup hook. */
  readonly priorSeen?: (tournamentKey: string) => boolean;
  /** Deck-level skip hook (D1). */
  readonly priorDecksSeen?: (deckExternalKey: string) => boolean;
  /** B2 streaming hook. */
  readonly onDeckScraped?: (deck: RawDeck) => void;
  /** Per-deck progress callback. */
  readonly onDeckFetched?: (a: { resolved: boolean; failed: boolean }) => void;
  /** Fires once we know the deck count for a tournament. */
  readonly onTournamentStart?: (a: { deckCount: number }) => void;
}

interface ApiCard {
  readonly count: number;
  readonly name?: string;
  readonly set?: string;
  readonly number?: string;
}

interface ApiDeckObj {
  // Speculative based on parity with Limitless's structured format.
  // The OpenAPI schema declares deckObj as a bare ``object`` so any
  // shape is possible; both parsers below are defensive.
  readonly character?: ApiCard[];
  readonly action?: ApiCard[];
  readonly item?: ApiCard[];
  readonly location?: ApiCard[];
  readonly cards?: ApiCard[];
}

interface ApiStanding {
  readonly standing?: number;
  readonly name?: string;
  readonly id?: string;
  readonly wins?: number;
  readonly draws?: number;
  readonly losses?: number;
  readonly decklist?: string | null;
  readonly deckObj?: ApiDeckObj | null;
}

interface ApiTournament {
  readonly TID: string;
  readonly tournamentName: string;
  readonly startDate: number; // unix seconds
  readonly game: string;
  readonly format: string;
  readonly topCut?: number;
  readonly swissNum?: number;
  readonly eventData?: Record<string, unknown>;
  readonly standings: ApiStanding[];
}

function tournamentKey(tid: string): string {
  return createHash("sha256")
    .update(`${SOURCE_NAME}|${tournamentUrl(tid)}`)
    .digest("hex");
}

function tournamentUrl(tid: string): string {
  return `https://topdeck.gg/event/${tid}`;
}

function deckUrl(tid: string, playerId: string | undefined): string {
  return playerId
    ? `https://topdeck.gg/event/${tid}/player/${playerId}`
    : `https://topdeck.gg/event/${tid}`;
}

function deckExternalKey(externalUrl: string): string {
  return createHash("sha256").update(`${SOURCE_NAME}|${externalUrl}`).digest("hex");
}

function toIsoDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

class RateLimiter {
  private nextSlot = 0;
  constructor(private intervalMs: number) {}
  async acquire(): Promise<void> {
    const now = Date.now();
    const wait = Math.max(0, this.nextSlot - now);
    this.nextSlot = Math.max(now, this.nextSlot) + this.intervalMs;
    if (wait > 0) await sleep(wait + Math.floor(Math.random() * 100));
  }
  penalise(ms: number): void {
    this.nextSlot = Math.max(this.nextSlot, Date.now() + ms);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function backoff(attempt: number): number {
  return 1_000 * 2 ** (attempt - 1) + Math.floor(Math.random() * 500);
}

export class TopdeckAdapter implements SourceAdapter {
  readonly sourceName = SOURCE_NAME;
  private readonly opts: TopdeckAdapterOptions;
  private readonly rateLimiter: RateLimiter;
  // Cache of (tournamentId → ApiTournament) populated during
  // `listTournaments` so `fetchTournament` doesn't re-issue the bulk
  // POST per tournament. The bulk response already contains the
  // standings + decklists, so we keep the whole tournament alive in
  // memory through the per-tournament loop.
  private readonly cachedByTid = new Map<string, ApiTournament>();

  constructor(opts: TopdeckAdapterOptions = {}) {
    this.opts = opts;
    this.rateLimiter = new RateLimiter(opts.requestSpacingMs ?? DEFAULT_REQUEST_SPACING_MS);
  }

  async listTournaments(): Promise<TournamentRef[]> {
    const apiKey = this.opts.apiKey ?? process.env.TOPDECK_API_KEY;
    if (!apiKey) {
      // Soft no-op when the key isn't configured. Mirrors the inkdecks
      // adapter's "disabled" behaviour so a missing secret in CI
      // doesn't fail the whole run.
      process.stderr.write(`[${SOURCE_NAME}] disabled: TOPDECK_API_KEY not set\n`);
      return [];
    }
    const game = this.opts.game ?? "Disney Lorcana";
    const formats = this.opts.formats ?? ["Core Constructed", "Infinity Constructed"];
    const lookbackDays = this.opts.lookbackDays ?? 365;
    const maxResults = this.opts.maxResults ?? Number.POSITIVE_INFINITY;
    const minPlayers = this.opts.minPlayers ?? 8;

    const refs: TournamentRef[] = [];
    for (const format of formats) {
      const body = {
        game,
        format,
        last: lookbackDays,
        participantMin: minPlayers,
        columns: ["name", "id", "decklist", "wins", "draws", "losses"],
      };
      const tournaments = await this.postJson<ApiTournament[]>("/v2/tournaments", body, apiKey);
      for (const t of tournaments ?? []) {
        // Defensive: the bulk endpoint occasionally returns test
        // events with non-numeric startDate. Skip those.
        if (typeof t.startDate !== "number") continue;
        const tKey = tournamentKey(t.TID);
        if (this.opts.priorSeen?.(tKey)) continue;
        this.cachedByTid.set(t.TID, t);
        refs.push({
          tournamentKey: tKey,
          sourceUrl: tournamentUrl(t.TID),
          name: t.tournamentName,
          date: toIsoDate(t.startDate),
        });
        if (refs.length >= maxResults) return refs;
      }
    }
    return refs;
  }

  async fetchTournament(ref: TournamentRef): Promise<RawTournament> {
    const tid = idFromUrl(ref.sourceUrl);
    const cached = this.cachedByTid.get(tid);
    // We always populate the cache via listTournaments, so a miss
    // here is unusual — fall back to a direct GET as a safety net.
    const t = cached ?? (await this.fetchOne(tid));
    if (!t) {
      throw new Error(`topdeck: no tournament data for ${tid}`);
    }
    const sorted = [...t.standings].sort(
      (a, b) => (a.standing ?? Number.MAX_SAFE_INTEGER) - (b.standing ?? Number.MAX_SAFE_INTEGER),
    );
    const limited =
      typeof this.opts.maxDecksPerTournament === "number"
        ? sorted.slice(0, this.opts.maxDecksPerTournament)
        : sorted;
    this.opts.onTournamentStart?.({ deckCount: limited.length });

    const decks: RawDeck[] = [];
    for (const entry of limited) {
      const dkUrl = deckUrl(tid, entry.id);
      if (this.opts.priorDecksSeen?.(deckExternalKey(dkUrl))) {
        this.opts.onDeckFetched?.({ resolved: false, failed: false });
        continue;
      }
      const deck = standingToRawDeck(tid, entry);
      if (deck) {
        decks.push(deck);
        this.opts.onDeckScraped?.(deck);
        this.opts.onDeckFetched?.({ resolved: true, failed: false });
      } else {
        // Most TopDeck events don't collect decklists; skipping is
        // expected, not a failure.
        this.opts.onDeckFetched?.({ resolved: false, failed: false });
      }
    }
    return {
      sourceUrl: tournamentUrl(tid),
      name: ref.name ?? t.tournamentName ?? tid,
      date: ref.date ?? toIsoDate(t.startDate),
      decks,
    };
  }

  /** GET /v2/tournaments/{TID} fallback when the bulk cache misses. */
  private async fetchOne(tid: string): Promise<ApiTournament | null> {
    const apiKey = this.opts.apiKey ?? process.env.TOPDECK_API_KEY;
    if (!apiKey) return null;
    const data = await this.getJson<{ data?: ApiTournament; standings?: ApiStanding[] }>(
      `/v2/tournaments/${encodeURIComponent(tid)}`,
      apiKey,
    );
    if (!data) return null;
    const d = data.data;
    if (!d) return null;
    return {
      TID: d.TID,
      tournamentName: d.tournamentName,
      startDate: d.startDate,
      game: d.game,
      format: d.format,
      topCut: d.topCut,
      swissNum: d.swissNum,
      standings: data.standings ?? [],
    };
  }

  private async postJson<T>(path: string, body: unknown, apiKey: string): Promise<T> {
    return this.fetchJson<T>(path, apiKey, "POST", JSON.stringify(body));
  }

  private async getJson<T>(path: string, apiKey: string): Promise<T | null> {
    try {
      return await this.fetchJson<T>(path, apiKey, "GET", null);
    } catch (err) {
      process.stderr.write(`[${SOURCE_NAME}] GET ${path} failed: ${(err as Error).message}\n`);
      return null;
    }
  }

  private async fetchJson<T>(
    path: string,
    apiKey: string,
    method: "GET" | "POST",
    body: string | null,
  ): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      await this.rateLimiter.acquire();
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), PER_REQUEST_TIMEOUT_MS);
        const res = await fetch(`${BASE}${path}`, {
          method,
          headers: {
            authorization: apiKey,
            "content-type": "application/json",
            "user-agent": USER_AGENT,
            accept: "application/json",
          },
          body: body ?? undefined,
          signal: ctrl.signal,
        }).finally(() => clearTimeout(t));

        if (res.status === 429) {
          // TopDeck returns `retryAfterSeconds` in the body. Use the
          // larger of that and our local backoff.
          const text = await res.text();
          let retryAfter = 0;
          try {
            const parsed = JSON.parse(text) as { retryAfterSeconds?: number };
            retryAfter = Number(parsed.retryAfterSeconds ?? 0) * 1000;
          } catch {
            /* ignore parse failure */
          }
          const wait = Math.max(retryAfter, backoff(attempt));
          this.rateLimiter.penalise(wait);
          process.stderr.write(
            `  [${SOURCE_NAME}] 429 on ${path} — sleeping ${(wait / 1000).toFixed(0)}s\n`,
          );
          await sleep(wait);
          continue;
        }
        if (res.status === 401 || res.status === 403) {
          throw new Error(`${path}: HTTP ${res.status} — check TOPDECK_API_KEY`);
        }
        if (res.status >= 500) {
          lastErr = new Error(`${path}: HTTP ${res.status}`);
          await sleep(backoff(attempt));
          continue;
        }
        if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
        return (await res.json()) as T;
      } catch (err) {
        lastErr = err;
        if (attempt === MAX_ATTEMPTS) break;
        await sleep(backoff(attempt));
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(`Failed to fetch ${path}`);
  }
}

/**
 * Map a `Standing` to a `RawDeck`. Two-path parser:
 *
 *   1. If `deckObj` is present, walk its category arrays (parity with
 *      Limitless's shape). Each card is `{ count, set?, number?,
 *      name? }`. When `set`+`number` are present we emit a printing
 *      id (`<set>-<number>`); otherwise we fall back to the card
 *      name so the orchestrator's name-index resolves it.
 *
 *   2. Else if `decklist` is a string, parse the common
 *      ``"4 Card Name"`` line format and emit name-based rawNames.
 *
 *   3. Else return null — TopDeck events without decklists are
 *      surprisingly common; the orchestrator skips them.
 */
function standingToRawDeck(tid: string, e: ApiStanding): RawDeck | null {
  const cards: { rawName: string; count: number }[] = [];
  if (e.deckObj) {
    for (const category of ["character", "action", "item", "location", "cards"] as const) {
      for (const c of e.deckObj[category] ?? []) {
        const count = Number.isFinite(c.count) ? c.count : 0;
        if (count <= 0) continue;
        const printing = c.set && c.number ? `${c.set}-${c.number}` : null;
        const rawName = printing ?? c.name ?? null;
        if (!rawName) continue;
        cards.push({ rawName, count });
      }
    }
  } else if (typeof e.decklist === "string") {
    for (const line of e.decklist.split(/\r?\n/)) {
      const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
      if (!m) continue;
      const count = Number.parseInt(m[1]!, 10);
      const name = m[2]!;
      if (count <= 0 || !name) continue;
      cards.push({ rawName: name, count });
    }
  }
  if (cards.length === 0) return null;
  return {
    placement: e.standing,
    player: e.name,
    inks: [],
    cards,
    externalId: e.id ?? `${tid}#${e.standing ?? "?"}`,
    externalUrl: deckUrl(tid, e.id),
  };
}

function idFromUrl(url: string): string {
  const m = /\/event\/([^/?#]+)/.exec(url);
  if (!m || !m[1]) throw new Error(`Cannot extract TID from URL: ${url}`);
  return m[1];
}

export const topdeck: SourceAdapter = new TopdeckAdapter();
