/**
 * Secondary card index built from `api.dotgg.gg/cgfw/getcards`.
 *
 * Used as a fallback when a deck's printing id can't be resolved against
 * Lorcast directly. dotgg uses some printing id forms that Lorcast doesn't
 * (`C1`, `Q1`/`Q2` sets, the `001-P1-XXX` three-part form, letter-suffix
 * variants like `P2-024B`). All of these are reprints of cards that *do*
 * exist in Lorcast under a different printing id, so a name + title
 * lookup recovers them.
 *
 * The fetched index is cached on disk so repeated runs don't re-download
 * the ~2 MB JSON. Cache TTL defaults to 24h — long enough to be cheap,
 * short enough that newly added sets get picked up next day.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fetch } from "undici";

const DOTGG_GETCARDS_URL = "https://api.dotgg.gg/cgfw/getcards?game=lorcana&mode=indexed";
const FETCH_TIMEOUT_MS = 30_000;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const USER_AGENT = "lorcana-scraper (+https://github.com/bjorvack/lorcana-scraper)";

export interface DotggCardEntry {
  readonly name: string;
  readonly title: string | null;
}

export interface DotggNameIndex {
  /** dotgg printing id (e.g. `012-001`, `P2-024B`, `001-P1-002`) → (name, title). */
  readonly byId: Map<string, DotggCardEntry>;
  /** When the underlying snapshot was fetched. */
  readonly fetchedAt: string;
}

export async function loadDotggNameIndex(
  cachePath: string,
  opts: { ttlMs?: number; force?: boolean } = {},
): Promise<DotggNameIndex> {
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
  if (!opts.force && existsSync(cachePath)) {
    const cached = JSON.parse(readFileSync(cachePath, "utf8")) as {
      fetchedAt: string;
      cards: { id: string; name: string; title: string | null }[];
    };
    const age = Date.now() - new Date(cached.fetchedAt).getTime();
    if (age < ttl) {
      const byId = new Map<string, DotggCardEntry>();
      for (const c of cached.cards) byId.set(c.id, { name: c.name, title: c.title });
      return { byId, fetchedAt: cached.fetchedAt };
    }
  }
  return await refreshDotggNameIndex(cachePath);
}

async function refreshDotggNameIndex(cachePath: string): Promise<DotggNameIndex> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  let body: unknown;
  try {
    const res = await fetch(DOTGG_GETCARDS_URL, {
      headers: { "user-agent": USER_AGENT, accept: "application/json" },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`dotgg getcards: HTTP ${res.status}`);
    body = await res.json();
  } finally {
    clearTimeout(t);
  }
  const { byId, cards } = parseGetCardsResponse(body);
  const fetchedAt = new Date().toISOString();
  mkdirSync(dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, JSON.stringify({ fetchedAt, cards }, null, 2) + "\n", "utf8");
  return { byId, fetchedAt };
}

/**
 * Parse the `{names: [...schema], data: [[...row], ...]}` shape into a
 * lookup index. Exported for tests.
 */
export function parseGetCardsResponse(body: unknown): {
  byId: Map<string, DotggCardEntry>;
  cards: { id: string; name: string; title: string | null }[];
} {
  if (!body || typeof body !== "object") throw new Error("dotgg getcards: not an object");
  const obj = body as { names?: unknown; data?: unknown };
  if (!Array.isArray(obj.names) || !Array.isArray(obj.data)) {
    throw new Error("dotgg getcards: missing names/data arrays");
  }
  const schema = obj.names as string[];
  const idIdx = schema.indexOf("id");
  const nameIdx = schema.indexOf("name");
  const titleIdx = schema.indexOf("title");
  if (idIdx < 0 || nameIdx < 0 || titleIdx < 0) {
    throw new Error(
      `dotgg getcards: schema missing id/name/title columns (got: ${schema.join(",")})`,
    );
  }
  const byId = new Map<string, DotggCardEntry>();
  const cards: { id: string; name: string; title: string | null }[] = [];
  for (const row of obj.data as unknown[]) {
    if (!Array.isArray(row)) continue;
    const id = row[idIdx];
    const name = row[nameIdx];
    const titleRaw = row[titleIdx];
    if (typeof id !== "string" || typeof name !== "string") continue;
    const title = typeof titleRaw === "string" && titleRaw.length > 0 ? titleRaw : null;
    byId.set(id, { name, title });
    cards.push({ id, name, title });
  }
  return { byId, cards };
}

/**
 * Default disk-cache location relative to a run's outDir. Co-locating with
 * `dataset.json` etc. keeps everything for a run in one place.
 */
export function defaultDotggCachePath(outDir: string): string {
  return resolve(outDir, "dotgg-cards.cache.json");
}
