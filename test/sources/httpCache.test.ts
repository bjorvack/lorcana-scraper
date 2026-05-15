import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HttpCache } from "../../src/sources/httpCache.js";

describe("HttpCache", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "httpcache-"));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns null on cold miss and the stored value on hit", async () => {
    const cache = new HttpCache(dir);
    const url = "https://example.test/foo?bar=1";
    expect(await cache.get<{ a: number }>(url)).toBeNull();
    await cache.set(url, { a: 1 });
    expect(await cache.get<{ a: number }>(url)).toEqual({ a: 1 });
    expect(cache.stats()).toEqual({ hits: 1, misses: 1 });
  });

  it("keys by URL so different URLs are independent", async () => {
    const cache = new HttpCache(dir);
    await cache.set("https://example.test/a", { v: "a" });
    await cache.set("https://example.test/b", { v: "b" });
    expect(await cache.get<{ v: string }>("https://example.test/a")).toEqual({ v: "a" });
    expect(await cache.get<{ v: string }>("https://example.test/b")).toEqual({ v: "b" });
  });

  it("C1: getWithinTtl returns null when the entry is older than maxAgeMs", async () => {
    const cache = new HttpCache(dir);
    const url = "https://example.test/ttl";
    await cache.set(url, { v: "fresh" });
    // 0 ms TTL → always expired.
    expect(await cache.getWithinTtl<{ v: string }>(url, 0)).toBeNull();
    // 1 hour TTL → entry is well within it.
    expect(await cache.getWithinTtl<{ v: string }>(url, 60 * 60_000)).toEqual({ v: "fresh" });
  });

  it("C1: getWithinTtl tolerates legacy non-envelope entries (treats as fresh)", async () => {
    const { writeFileSync } = await import("node:fs");
    const { createHash } = await import("node:crypto");
    const url = "https://example.test/legacy";
    const hash = createHash("sha1").update(url).digest("hex");
    writeFileSync(join(dir, `${hash}.json`), JSON.stringify({ legacy: true }), "utf8");
    const cache = new HttpCache(dir);
    expect(await cache.getWithinTtl<{ legacy: boolean }>(url, 0)).toEqual({ legacy: true });
  });
});
