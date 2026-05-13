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
});
