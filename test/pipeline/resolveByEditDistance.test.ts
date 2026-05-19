import { describe, expect, it } from "vitest";

import { resolveByEditDistance } from "../../src/pipeline/run.js";

// We don't need a real CardT here; the resolver is generic over
// the map value. Use opaque string ids to make assertion failures
// obvious.
function idx(entries: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(entries));
}

describe("resolveByEditDistance", () => {
  it("returns null for an empty rawName", () => {
    expect(resolveByEditDistance("", idx({ "mickey mouse": "a" }))).toBeNull();
  });

  it("matches a single typo (1 edit) when there's a unique closest card", () => {
    // "Micky Mouse" → normalises to "micky mouse", 1 edit from
    // "mickey mouse".
    expect(resolveByEditDistance("Micky Mouse", idx({ "mickey mouse": "a" }))).toBe("a");
  });

  it("matches a 2-edit drift (e.g. spacing collapse)", () => {
    expect(
      resolveByEditDistance(
        "Tweedle Dee & Tweedle Dum - Strange Storytellers",
        idx({
          "tweedledee tweedledum strange storytellers": "tdd",
          "mickey mouse brave little tailor": "mlt",
        }),
      ),
    ).toBe("tdd");
  });

  it("returns null when the closest card exceeds the threshold", () => {
    // 3+ edits from any candidate
    expect(
      resolveByEditDistance(
        "completely unrelated string",
        idx({ "mickey mouse": "a", "stitch carefree surfer": "b" }),
      ),
    ).toBeNull();
  });

  it("never silently picks a side when two cards tie at the min distance", () => {
    // Both candidates are 1 edit from 'mickey mouwe'
    const result = resolveByEditDistance(
      "Mickey Mouwe",
      idx({ "mickey mouse": "a", "mickey moue": "b" }),
    );
    expect(result).toBeNull();
  });

  it("prefers the strictly-closer card when one wins by distance", () => {
    // 'mickey mose' is 1 edit from 'mickey mouse' (insert 'u')
    // and 3+ edits from 'donald duck the brave'.
    expect(
      resolveByEditDistance(
        "Mickey Mose",
        idx({ "mickey mouse": "a", "donald duck the brave": "b" }),
      ),
    ).toBe("a");
  });
});
