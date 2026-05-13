/**
 * Lorcast API client for the cards snapshot pipeline.
 *
 * Two endpoints:
 *   GET /v0/sets                      → { results: SetSummary[] }
 *   GET /v0/sets/<code>/cards         → LorcastApiCard[]      (no pagination)
 *
 * Failure modes we care about:
 *   - 5xx / network errors      → retry with exponential backoff
 *   - 429 with Retry-After      → respect, then retry
 *   - any 4xx                   → fail fast (likely an upstream shape change)
 *   - per-request timeout       → counts as a failure for retry purposes
 */
import { fetch } from "undici";
import type { LorcastApiCardT } from "@bjorvack/lorcana-schemas";

const LORCAST_BASE = "https://api.lorcast.com/v0";
const PER_REQUEST_TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 3;
const USER_AGENT = "lorcana-scraper (+https://github.com/bjorvack/lorcana-scraper)";

interface SetSummary {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly released_at?: string;
}

interface SetsResponse {
  readonly results: SetSummary[];
}

export interface FetchAllCardsResult {
  readonly fetchedAt: string; // ISO 8601
  readonly sets: SetSummary[];
  readonly cards: LorcastApiCardT[];
}

export async function fetchAllCards(): Promise<FetchAllCardsResult> {
  const fetchedAt = new Date().toISOString();
  const sets = await listSets();
  const cards: LorcastApiCardT[] = [];

  for (const set of sets) {
    const batch = await fetchSetCards(set.code);
    cards.push(...batch);
  }

  return { fetchedAt, sets, cards };
}

async function listSets(): Promise<SetSummary[]> {
  const body = await getJson<SetsResponse>(`${LORCAST_BASE}/sets`);
  if (!Array.isArray(body.results)) {
    throw new Error(`Lorcast /sets did not return a results array`);
  }
  return body.results;
}

async function fetchSetCards(setCode: string): Promise<LorcastApiCardT[]> {
  const body = await getJson<unknown>(`${LORCAST_BASE}/sets/${encodeURIComponent(setCode)}/cards`);
  if (!Array.isArray(body)) {
    throw new Error(`Lorcast /sets/${setCode}/cards did not return an array`);
  }
  return body as LorcastApiCardT[];
}

async function getJson<T>(url: string): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await timed(url);
      if (res.status === 429) {
        const retryAfter = Number(res.headers.get("retry-after") ?? "0");
        await sleep(Math.max(retryAfter * 1000, backoff(attempt)));
        continue;
      }
      if (res.status >= 500) {
        await sleep(backoff(attempt));
        lastErr = new Error(`${url}: HTTP ${res.status}`);
        continue;
      }
      if (!res.ok) {
        throw new Error(`${url}: HTTP ${res.status}`);
      }
      return (await res.json()) as T;
    } catch (err) {
      lastErr = err;
      if (attempt === MAX_ATTEMPTS) break;
      await sleep(backoff(attempt));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`Failed to fetch ${url}`);
}

async function timed(url: string) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PER_REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, {
      headers: { "user-agent": USER_AGENT, accept: "application/json" },
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function backoff(attempt: number): number {
  // 250ms, 500ms, 1s — plus jitter
  return 250 * 2 ** (attempt - 1) + Math.floor(Math.random() * 100);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
