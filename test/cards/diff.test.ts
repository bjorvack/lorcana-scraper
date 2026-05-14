import { describe, expect, it } from "vitest";
import type { CardSetT, CardT } from "@bjorvack/lorcana-schemas";
import { diffCardSets, isEmpty, renderDiffMarkdown } from "../../src/cards/diff.js";

function card(overrides: Partial<CardT> = {}): CardT {
  return {
    id: "x",
    name: "X",
    version: null,
    setCode: "TFC",
    cardNumber: 1,
    cost: 1,
    inkwell: true,
    inks: ["Amber"],
    types: ["Action"],
    classifications: [],
    keywords: [],
    text: "",
    flavor: null,
    imageUrl: "https://example.com/x.png",
    legality: "legal",
    lore: null,
    strength: null,
    willpower: null,
    moveCost: null,
    setName: null,
    collectorNumber: null,
    rarity: null,
    illustrators: [],
    releasedAt: null,
    tcgplayerId: null,
    ...overrides,
  };
}

function set(cards: CardT[]): CardSetT {
  return {
    cardSetVersion: "sha256:" + "0".repeat(64),
    fetchedAt: "2025-01-01T00:00:00.000Z",
    cards,
  };
}

const a = card({ id: "a", name: "A" });
const b = card({ id: "b", name: "B" });
const c = card({ id: "c", name: "C" });

describe("diffCardSets", () => {
  it("classifies added/removed/changed", () => {
    const prior = set([a, b]);
    const next = set([{ ...b, cost: 5 }, c]); // a removed, b changed cost, c added
    const d = diffCardSets(prior, next);
    expect(d.added.map((x) => x.id)).toEqual(["c"]);
    expect(d.removed.map((x) => x.id)).toEqual(["a"]);
    expect(d.changed.map((x) => x.after.id)).toEqual(["b"]);
  });

  it("treats null prior as everything added", () => {
    const next = set([a, b]);
    const d = diffCardSets(null, next);
    expect(d.added.length).toBe(2);
    expect(d.removed.length).toBe(0);
    expect(d.changed.length).toBe(0);
  });

  it("reports empty diff when content is identical", () => {
    const prior = set([a, b]);
    const next = set([a, b]);
    expect(isEmpty(diffCardSets(prior, next))).toBe(true);
  });

  it("renders Markdown with counts and per-card lines", () => {
    const prior = set([a, b]);
    const next = set([{ ...b, cost: 5 }, c]);
    const md = renderDiffMarkdown(diffCardSets(prior, next), { priorTag: "cards-vTEST" });
    expect(md).toContain("Compared against: `cards-vTEST`");
    expect(md).toContain("Added: **1**");
    expect(md).toContain("Removed: **1**");
    expect(md).toContain("Changed: **1**");
    expect(md).toContain("- `a`");
    expect(md).toContain("- `b`");
    expect(md).toContain("- `c`");
  });
});
