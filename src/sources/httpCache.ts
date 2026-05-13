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
    await this.ensureDir();
    try {
      const raw = await readFile(this.keyPath(url), "utf8");
      this.hits++;
      return JSON.parse(raw) as T;
    } catch {
      this.misses++;
      return null;
    }
  }

  async set(url: string, value: unknown): Promise<void> {
    await this.ensureDir();
    try {
      await writeFile(this.keyPath(url), JSON.stringify(value), "utf8");
    } catch {
      // Non-fatal: a failed cache write just means a future run will refetch.
    }
  }

  stats(): { hits: number; misses: number } {
    return { hits: this.hits, misses: this.misses };
  }
}
