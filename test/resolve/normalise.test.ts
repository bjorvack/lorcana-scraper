import { describe, expect, it } from "vitest";
import { normaliseKey } from "../../src/resolve/normalise.js";

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
