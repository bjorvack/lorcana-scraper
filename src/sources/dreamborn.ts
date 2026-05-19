/**
 * Dreamborn.ink adapter — community-built decks from
 * https://dreamborn.ink/decks?sort=trending.
 *
 * Why a separate source: dreamborn is the largest community deck
 * repository for Lorcana and exposes a public listing endpoint at
 * ``/api/decks?sort=trending`` that returns ~24 trending deck
 * summaries (no auth, no Cloudflare). Decks are user-uploaded, not
 * tournament standings — there's no placement / record / opponent.
 * To fit the existing ``SourceAdapter`` contract we project each
 * daily run into a synthetic "tournament" grouping that day's
 * trending decks.
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
 * limits, but the per-deck HTML page is ~50KB each and the
 * trending list caps at 24, so a daily run does ≤25 requests.
 * We still pace at 500ms to be polite.
 */

import { createHash } from "node:crypto";
import { fetch } from "undici";

import type { RawDeck, RawTournament, SourceAdapter, TournamentRef } from "./types.js";

export const SOURCE_NAME = "dreamborn.ink";

const BASE = "https://dreamborn.ink";
// Server-side filter rather than client-side: dreamborn caps the
// listing at 24 results, so without ``archetype=competitive`` we'd
// get a mixed bag (casual / multiplayer / budget builds) and end
// up with ~12 usable decks after filtering. Asking the server for
// competitive-only gives us a full 24 tournament-shaped decks per
// snapshot.
const LIST_PATH = "/api/decks?sort=trending&archetype=competitive";
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

async function timedFetch(url: string): Promise<string> {
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
      // Only 5xx + 429 are worth retrying. 4xx (other than 429) is a
      // request bug, not transient.
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

export class DreambornAdapter implements SourceAdapter {
  readonly sourceName = SOURCE_NAME;
  private readonly opts: DreambornAdapterOptions;
  private readonly rateLimiter: RateLimiter;

  constructor(opts: DreambornAdapterOptions = {}) {
    this.opts = opts;
    this.rateLimiter = new RateLimiter(opts.requestSpacingMs ?? DEFAULT_REQUEST_SPACING_MS);
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
    await this.rateLimiter.acquire();
    const listingRaw = await timedFetch(`${BASE}${LIST_PATH}`);
    let summaries: DreambornDeckSummary[];
    try {
      const parsed = JSON.parse(listingRaw);
      summaries = Array.isArray(parsed) ? (parsed as DreambornDeckSummary[]) : [];
    } catch {
      summaries = [];
    }

    const competitive = summaries.filter(
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
        html = await timedFetch(url);
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
