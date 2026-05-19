/**
 * Tiny disk-backed HTTP JSON cache.
 *
 * Writes each cached response under `<dir>/<sha1(url)>.json`. Only intended
 * for endpoints whose response is effectively immutable (finalized
 * tournaments, finalized decks); do not wrap listing endpoints that emit
 * new items over time.
 *
 * Storage is "best effort": a missing, corrupt, or unreadable entry simply
 * misses the cache and is refetched. No TTL is tracked; delete the cache
 * directory to invalidate.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export class HttpCache {
  private initPromise: Promise<void> | null = null;
  private hits = 0;
  private misses = 0;

  constructor(private readonly dir: string) {}

  private async ensureDir(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = mkdir(this.dir, { recursive: true }).then(() => undefined);
    }
    await this.initPromise;
  }

  private keyPath(url: string): string {
    const hash = createHash("sha1").update(url).digest("hex");
    return path.join(this.dir, `${hash}.json`);
  }

  async get<T>(url: string): Promise<T | null> {
    return this.getWithinTtl<T>(url, Number.POSITIVE_INFINITY);
  }

  /**
   * Like {@link get} but returns null if the cached entry is older
   * than `maxAgeMs`. Used for mutable endpoints (listing pages) so
   * we can still cache them across rapid re-runs without serving
   * stale results forever.
   *
   * Backward-compatible with legacy entries that were stored without
   * an envelope — those are treated as fresh enough to return.
   */
  async getWithinTtl<T>(url: string, maxAgeMs: number): Promise<T | null> {
    await this.ensureDir();
    try {
      const raw = await readFile(this.keyPath(url), "utf8");
      const parsed = JSON.parse(raw) as CacheEnvelope<T> | T;
      if (isEnvelope(parsed)) {
        const age = Date.now() - new Date(parsed.fetchedAt).getTime();
        // `>=` so a maxAgeMs of 0 always expires, even when the cache
        // entry was written in the same millisecond as the read (which
        // happens on fast CI runners and made the C1 test flake).
        if (age >= maxAgeMs) {
          this.misses++;
          return null;
        }
        this.hits++;
        return parsed.value;
      }
      // Legacy entry (no envelope). Treat as fresh — these are
      // immutable-endpoint payloads which is why they were cached
      // without a TTL in the first place.
      this.hits++;
      return parsed as T;
    } catch {
      this.misses++;
      return null;
    }
  }

  async set(url: string, value: unknown): Promise<void> {
    await this.ensureDir();
    try {
      const envelope: CacheEnvelope<unknown> = {
        fetchedAt: new Date().toISOString(),
        value,
      };
      await writeFile(this.keyPath(url), JSON.stringify(envelope), "utf8");
    } catch {
      // Non-fatal: a failed cache write just means a future run will refetch.
    }
  }

  stats(): { hits: number; misses: number } {
    return { hits: this.hits, misses: this.misses };
  }
}

interface CacheEnvelope<T> {
  readonly fetchedAt: string; // ISO timestamp
  readonly value: T;
}

function isEnvelope<T>(x: unknown): x is CacheEnvelope<T> {
  return (
    typeof x === "object" &&
    x !== null &&
    "fetchedAt" in x &&
    "value" in x &&
    typeof (x as { fetchedAt: unknown }).fetchedAt === "string"
  );
}
