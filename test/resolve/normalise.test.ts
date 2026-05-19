import { describe, expect, it } from "vitest";
import { levenshtein, normaliseKey } from "../../src/resolve/normalise.js";

describe("normaliseKey", () => {
  it("lowercases", () => {
    expect(normaliseKey("Mickey Mouse")).toBe("mickey mouse");
  });

  it("strips accents", () => {
    expect(normaliseKey("Mîckey")).toBe("mickey");
  });

  it("collapses punctuation to whitespace", () => {
    expect(normaliseKey("Mickey-Mouse!")).toBe("mickey mouse");
  });
});

describe("levenshtein", () => {
  it("returns 0 for equal strings", () => {
    expect(levenshtein("mickey", "mickey", 2)).toBe(0);
  });

  it("counts a single substitution as 1", () => {
    expect(levenshtein("micky", "mickey", 2)).toBe(1);
  });

  it("counts a single insertion / deletion as 1", () => {
    expect(levenshtein("mickey", "mickeyy", 2)).toBe(1);
    expect(levenshtein("mickeyy", "mickey", 2)).toBe(1);
  });

  it("returns max+1 when length differs by more than max (cheap-skip)", () => {
    // 'ab' vs 'abcdef' differs by 4 chars; cap=2.
    expect(levenshtein("ab", "abcdef", 2)).toBe(3);
    // Same idea but the answer should clamp at max+1 without falling
    // through to the full DP — we don't actually probe the
    // implementation, just confirm the contract.
    expect(levenshtein("a", "abcdefgh", 2)).toBeGreaterThan(2);
  });

  it("aborts early without underflowing when both strings empty", () => {
    expect(levenshtein("", "", 0)).toBe(0);
  });

  it("returns max+1 when both differ enough that no edit script fits", () => {
    expect(levenshtein("apple", "banana", 2)).toBeGreaterThan(2);
  });

  it("real-world: catches Tweedledee spacing drift (2 deletes)", () => {
    expect(
      levenshtein(
        "tweedle dee tweedle dum strange storytellers",
        "tweedledee tweedledum strange storytellers",
        2,
      ),
    ).toBe(2);
  });
});
