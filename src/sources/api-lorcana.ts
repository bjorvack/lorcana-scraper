/**
 * api-lorcana.com adapter — community-built decks via a clean
 * public JSON API.
 *
 * Replaces ``dreamborn.ink`` as the community-deck source for
 * CI scrapes. api-lorcana.com is a third-party mirror of the
 * dreamborn deck graph that surfaces the same data through a
 * plain unauthenticated REST endpoint, without the Cloudflare
 * Turnstile that blocks GitHub-Actions runner IPs from
 * ``dreamborn.ink/api/decks``.
 *
 * Why this works where dreamborn.ink doesn't:
 *   - Pure undici fetch, no headless browser, no chromium install.
 *   - Single endpoint, single round-trip — ``/decks`` returns the
 *     full archive (~1500 decks at the time of writing, ~11MB) in
 *     ~500ms. ``/decks/trending`` is a cheaper ~28-deck slice.
 *   - Cards are already in canonical ``<setCode>-<NNN>`` form
 *     (the ``dreamborn`` field), which ``parsePrintingId`` resolves
 *     deterministically against the dotgg card index.
 *
 * Modelling: api-lorcana doesn't have "tournaments" any more than
 * dreamborn did — these are user-uploaded community decks. We
 * project each scrape into a single synthetic snapshot whose
 * ``sourceUrl`` is date-stamped (``…?snapshot=YYYY-MM-DD``) so
 * consecutive snapshots don't collide via the
 * ``sha256(sourceName|sourceUrl)`` externalKey. Deck-level dedup
 * (``priorDecksSeen``) means a deck that survives across many
 * snapshots is still ingested once.
 *
 * Modes:
 *   - ``"all"`` (default) — pull ``/decks``. Ideal for first-run
 *     backfill (every deck the API knows about lands at once,
 *     then ``priorDecksSeen`` short-circuits subsequent runs) and
 *     ongoing incremental ingest of newly-published decks.
 *   - ``"trending"`` — pull ``/decks/trending``. ~28-deck slice
 *     mirroring dreamborn's surfacing logic. Useful for very
 *     fast CI cadences where the full 11MB pull is undesirable.
 *
 * Inks: the API returns deck cards as ``[{dreamborn, count}]``
 * without inline ink info. The pipeline derives the final ink
 * set from resolved cards' ``Card.inks`` (see
 * ``projectDeck``), so the adapter emits an empty
 * ``RawDeck.inks`` and lets the projection layer compute it.
 */

import { createHash } from "node:crypto";
import { fetch } from "undici";

import type { RawDeck, RawTournament, SourceAdapter, TournamentRef } from "./types.js";

export const SOURCE_NAME = "api-lorcana.com";

const BASE = "https://api-lorcana.com";
const DEFAULT_REQUEST_SPACING_MS = 500;
/** ``/decks`` returns ~11MB; allow a generous timeout for slower
 *  CI runners or when api-lorcana itself has a cold cache. */
const PER_REQUEST_TIMEOUT_MS = 60_000;
const MAX_ATTEMPTS = 3;
const USER_AGENT = "lorcana-scraper (+https://github.com/bjorvack/lorcana-scraper)";

export type ApiLorcanaMode = "all" | "trending";

/** Shape of a single ``cards[]`` entry. The ``dreamborn`` string
 *  is a canonical ``<setCode>-<NNN>`` printing id (e.g.
 *  ``"006-049"``), which ``parsePrintingId`` resolves directly. */
export interface ApiLorcanaDeckCard {
  readonly dreamborn: string;
  readonly count: number;
}

/** Subset of the ``MappingDeck`` schema we actually consume. Many
 *  more fields exist (likes, views, youtube, …) but they're not
 *  needed by the projection. Extras are tolerated — we never
 *  pin schema validation here. */
export interface ApiLorcanaDeck {
  readonly uuid: string;
  readonly name: string;
  readonly creator?: string;
  readonly creator_name?: string;
  readonly cardsCount?: number;
  readonly views?: number;
  readonly likes?: number;
  readonly updated_at?: string;
  readonly last_trending_at_ms?: number;
  readonly last_checked_at_ms?: number;
  readonly is_private?: boolean;
  readonly cards?: readonly ApiLorcanaDeckCard[];
}

export interface ApiLorcanaAdapterOptions {
  readonly priorSeen?: (tournamentKey: string) => boolean;
  readonly priorDecksSeen?: (deckExternalKey: string) => boolean;
  readonly maxResults?: number;
  readonly maxDecksPerTournament?: number;
  readonly requestSpacingMs?: number;
  /** ``"all"`` (default) = ``/decks`` full archive. ``"trending"`` =
   *  ``/decks/trending`` cheap slice. */
  readonly mode?: ApiLorcanaMode;
  /** Drop decks below this cardsCount. Defaults to 40 to filter
   *  obvious deck-builder scratchpads — anything close to a real
   *  60-card constructed deck survives; midbuilds (8-card "let me
   *  jot down an idea" pages) are dropped. */
  readonly minCardsCount?: number;
  /** Inject a stable "today" timestamp for deterministic tests. */
  readonly nowIso?: string;
  readonly onDeckFetched?: (a: { resolved: boolean; failed: boolean }) => void;
  readonly onDeckScraped?: (deck: RawDeck) => void;
  readonly onTournamentStart?: (a: { deckCount: number }) => void;
}

class RateLimiter {
  private nextSlot = 0;
  constructor(private readonly intervalMs: number) {}
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

/** Today's UTC date as ``YYYY-MM-DD``. Extracted for testability. */
export function todayIso(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function tournamentUrl(snapshotIso: string, mode: ApiLorcanaMode): string {
  const path = mode === "trending" ? "/decks/trending" : "/decks";
  return `${BASE}${path}?snapshot=${snapshotIso}`;
}

export function tournamentKey(snapshotIso: string, mode: ApiLorcanaMode): string {
  return createHash("sha256")
    .update(`${SOURCE_NAME}|${tournamentUrl(snapshotIso, mode)}`)
    .digest("hex");
}

/** Human-readable URL to point reviewers at. api-lorcana itself
 *  has no public UI, so we link to dreamborn.ink (the canonical
 *  origin for these uuids). */
export function deckExternalUrl(uuid: string): string {
  return `https://dreamborn.ink/decks/${uuid}`;
}

export function deckExternalKey(externalUrl: string): string {
  return createHash("sha256").update(`${SOURCE_NAME}|${externalUrl}`).digest("hex");
}

/** Convert an API deck into the pipeline's ``RawDeck`` shape, or
 *  ``null`` if the deck has no parseable cards. Exported for
 *  testing. */
export function toRawDeck(d: ApiLorcanaDeck): RawDeck | null {
  const cards = (d.cards ?? [])
    .filter(
      (c) =>
        c &&
        typeof c.dreamborn === "string" &&
        c.dreamborn.length > 0 &&
        Number.isFinite(c.count) &&
        c.count > 0,
    )
    .map((c) => ({ rawName: c.dreamborn, count: c.count }));
  if (cards.length === 0) return null;
  const externalUrl = deckExternalUrl(d.uuid);
  return {
    // api-lorcana / dreamborn have no tournament context, so no
    // placement. ``creator_name`` plays the same role as
    // ``player`` for limitless/lorcana.gg.
    player: d.creator_name && d.creator_name.length > 0 ? d.creator_name : undefined,
    // Pipeline derives the final ink set from resolved cards
    // (see ``projectDeck``); adapter-provided inks are ignored.
    inks: [],
    cards,
    externalId: d.uuid,
    externalUrl,
    displayName: d.name && d.name.length > 0 ? d.name : undefined,
  };
}

async function undiciFetchJson<T>(url: string): Promise<T> {
  let lastErr: Error = new Error(`${url}: fetch failed`);
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), PER_REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        headers: { "user-agent": USER_AGENT, accept: "application/json" },
        signal: ctrl.signal,
      });
      if (res.ok) {
        const body = await res.text();
        try {
          return JSON.parse(body) as T;
        } catch {
          throw new Error(`${url}: invalid JSON response`);
        }
      }
      await res.arrayBuffer().catch(() => undefined);
      lastErr = new Error(`${url}: HTTP ${res.status} ${res.statusText}`);
      // 4xx (other than 429) is persistent — don't retry.
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

export class ApiLorcanaAdapter implements SourceAdapter {
  readonly sourceName = SOURCE_NAME;
  private readonly opts: ApiLorcanaAdapterOptions;
  private readonly rateLimiter: RateLimiter;

  constructor(opts: ApiLorcanaAdapterOptions = {}) {
    this.opts = opts;
    this.rateLimiter = new RateLimiter(opts.requestSpacingMs ?? DEFAULT_REQUEST_SPACING_MS);
  }

  async listTournaments(): Promise<TournamentRef[]> {
    const snapshot = this.opts.nowIso ?? todayIso();
    const mode: ApiLorcanaMode = this.opts.mode ?? "all";
    const ref: TournamentRef = {
      tournamentKey: tournamentKey(snapshot, mode),
      sourceUrl: tournamentUrl(snapshot, mode),
      name: `api-lorcana ${mode} — ${snapshot}`,
      date: snapshot,
    };
    if (this.opts.priorSeen?.(ref.tournamentKey)) return [];
    return [ref];
  }

  async fetchTournament(ref: TournamentRef): Promise<RawTournament> {
    const mode: ApiLorcanaMode = this.opts.mode ?? "all";
    const minCards = this.opts.minCardsCount ?? 40;
    const endpoint = mode === "trending" ? `${BASE}/decks/trending` : `${BASE}/decks`;

    await this.rateLimiter.acquire();
    let raw: ApiLorcanaDeck[];
    try {
      raw = await undiciFetchJson<ApiLorcanaDeck[]>(endpoint);
    } catch (err) {
      process.stderr.write(
        `[${SOURCE_NAME}] listing failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      return {
        sourceUrl: ref.sourceUrl,
        name: ref.name ?? `api-lorcana ${mode}`,
        date: ref.date ?? this.opts.nowIso ?? todayIso(),
        decks: [],
      };
    }
    if (!Array.isArray(raw)) {
      process.stderr.write(`[${SOURCE_NAME}] ${endpoint}: response was not an array\n`);
      return {
        sourceUrl: ref.sourceUrl,
        name: ref.name ?? `api-lorcana ${mode}`,
        date: ref.date ?? this.opts.nowIso ?? todayIso(),
        decks: [],
      };
    }

    // Filter + dedup by uuid (the API doesn't promise uniqueness).
    const seen = new Set<string>();
    const candidates: ApiLorcanaDeck[] = [];
    for (const d of raw) {
      if (!d || typeof d.uuid !== "string" || d.uuid.length === 0) continue;
      if (d.is_private === true) continue;
      if (typeof d.cardsCount === "number" && d.cardsCount < minCards) continue;
      if (seen.has(d.uuid)) continue;
      seen.add(d.uuid);
      candidates.push(d);
    }

    const limited =
      typeof this.opts.maxDecksPerTournament === "number"
        ? candidates.slice(0, this.opts.maxDecksPerTournament)
        : candidates;

    this.opts.onTournamentStart?.({ deckCount: limited.length });

    const decks: RawDeck[] = [];
    for (const d of limited) {
      const externalUrl = deckExternalUrl(d.uuid);
      if (this.opts.priorDecksSeen?.(deckExternalKey(externalUrl))) {
        // Already ingested in a previous snapshot — counts as
        // "fetched" so the pipeline progress reporter can show it
        // without marking it failed.
        this.opts.onDeckFetched?.({ resolved: false, failed: false });
        continue;
      }
      const raw = toRawDeck(d);
      if (!raw) {
        this.opts.onDeckFetched?.({ resolved: false, failed: true });
        continue;
      }
      decks.push(raw);
      this.opts.onDeckScraped?.(raw);
      this.opts.onDeckFetched?.({ resolved: true, failed: false });
    }

    return {
      sourceUrl: ref.sourceUrl,
      name: ref.name ?? `api-lorcana ${mode}`,
      date: ref.date ?? this.opts.nowIso ?? todayIso(),
      decks,
    };
  }
}

export const apiLorcana: SourceAdapter = new ApiLorcanaAdapter();
