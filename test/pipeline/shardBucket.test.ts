import { describe, expect, it } from "vitest";
import { fnv1aBucket } from "../../src/pipeline/run.js";

describe("fnv1aBucket", () => {
  it("is deterministic for the same input", () => {
    expect(fnv1aBucket("abc", 8)).toBe(fnv1aBucket("abc", 8));
  });

  it("partitions roughly evenly across buckets for sha256-like inputs", () => {
    // Synthesise 4096 distinct hex digests by hashing sequential
    // integers — gives a sample that looks like real externalKey
    // sha256 strings without bringing crypto into the test.
    const counts = new Array(8).fill(0) as number[];
    for (let i = 0; i < 4096; i++) {
      // Linear congruential — different enough across i to break
      // up any prefix-bit clustering from the FNV constants.
      let h = i * 2654435761;
      let key = "";
      for (let j = 0; j < 8; j++) {
        h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
        key += h.toString(16).padStart(8, "0");
      }
      counts[fnv1aBucket(key, 8)]!++;
    }
    const ideal = 4096 / 8;
    for (const c of counts) {
      // Loose bound: even chi-squared-y bad cases should land in
      // [ideal*0.7, ideal*1.3]. The test guards against gross
      // mis-implementation (e.g. always returning 0).
      expect(c).toBeGreaterThan(ideal * 0.7);
      expect(c).toBeLessThan(ideal * 1.3);
    }
  });

  it("returns 0 when buckets is 1 (no-op shard)", () => {
    expect(fnv1aBucket("anything", 1)).toBe(0);
  });

  it("every input lands in exactly one bucket (partition invariant)", () => {
    // For a random sample, the bucket assignment is total: sum of
    // bucket counts equals the input size. Trivially true by
    // construction, but documents the property the pipeline depends on.
    const sample = ["a", "b", "c", "d", "deadbeef", "0000", "ff"];
    const buckets = sample.map((k) => fnv1aBucket(k, 4));
    expect(buckets.every((b) => b >= 0 && b < 4)).toBe(true);
  });
});
