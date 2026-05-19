import { describe, expect, it } from "vitest";
import type { CardT } from "@bjorvack/lorcana-schemas";
import {
  buildCardIndex,
  parsePrintingId,
  printingKey,
  spacelessKey,
} from "../../src/resolve/cardIndex.js";

function card(o: Partial<CardT>): CardT {
  return {
    id: "x",
    name: "X",
    version: null,
    setCode: "1",
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
    ...o,
  };
}

describe("printingKey", () => {
  it("pads to 3 digits", () => {
    expect(printingKey("1", 49)).toBe("1-049");
    expect(printingKey("10", 174)).toBe("10-174");
  });
});

describe("parsePrintingId", () => {
  it("parses zero-padded ids", () => {
    expect(parsePrintingId("006-049")).toEqual({ key: "6-049", setCode: "6", cardNumber: 49 });
  });
  it("parses unpadded ids", () => {
    expect(parsePrintingId("10-174")).toEqual({ key: "10-174", setCode: "10", cardNumber: 174 });
  });
  it("parses promo / alphanumeric set codes", () => {
    expect(parsePrintingId("P1-029")).toEqual({ key: "P1-029", setCode: "P1", cardNumber: 29 });
    expect(parsePrintingId("D23-003")).toEqual({ key: "D23-003", setCode: "D23", cardNumber: 3 });
    expect(parsePrintingId("cp-7")).toEqual({ key: "cp-007", setCode: "cp", cardNumber: 7 });
  });
  it("collapses 3-part legacy ids to the promo printing", () => {
    expect(parsePrintingId("001-P1-005")).toEqual({ key: "P1-005", setCode: "P1", cardNumber: 5 });
    expect(parsePrintingId("002-D23-003")).toEqual({
      key: "D23-003",
      setCode: "D23",
      cardNumber: 3,
    });
  });
  it("rejects literal 'undefined' / null / empty", () => {
    expect(parsePrintingId("undefined")).toBeNull();
    expect(parsePrintingId("null")).toBeNull();
    expect(parsePrintingId("")).toBeNull();
    expect(parsePrintingId("  ")).toBeNull();
  });
  it("rejects garbage", () => {
    expect(parsePrintingId("rainbow")).toBeNull();
    expect(parsePrintingId("-1")).toBeNull();
  });
});

describe("buildCardIndex", () => {
  const a = card({ id: "a", name: "Ariel", version: "On Human Legs", setCode: "1", cardNumber: 1 });
  const b = card({
    id: "b",
    name: "Stitch",
    version: "Carefree Surfer",
    setCode: "1",
    cardNumber: 182,
  });
  const c = card({
    id: "c",
    name: "Mickey",
    version: "Brave Little Tailor",
    setCode: "10",
    cardNumber: 174,
  });
  const idx = buildCardIndex([a, b, c]);

  it("indexes by printing", () => {
    expect(idx.byPrinting.get("1-001")).toBe(a);
    expect(idx.byPrinting.get("1-182")).toBe(b);
    expect(idx.byPrinting.get("10-174")).toBe(c);
  });

  it("indexes by display name (exact)", () => {
    expect(idx.byExact.get("Ariel - On Human Legs")).toBe(a);
  });

  it("indexes by lowercase name (one→many)", () => {
    expect(idx.byNameVersion.get("ariel")).toContain(a);
  });
});

describe("spacelessKey", () => {
  it("strips internal whitespace and punctuation that survives normalisation", () => {
    expect(spacelessKey("tweedle dee tweedle dum")).toBe("tweedledeetweedledum");
    expect(spacelessKey("hello-world 123")).toBe("helloworld123");
  });

  it("is idempotent on already-spaceless input", () => {
    expect(spacelessKey("tweedledee")).toBe("tweedledee");
  });
});

describe("buildCardIndex.bySpaceless", () => {
  // Real-world failure: dreamborn renders ``Tweedle Dee & Tweedle Dum``
  // but Lorcast catalogs the same card as ``Tweedledee & Tweedledum``.
  // The byNormalised lookup misses because the embedded space differs,
  // but the spaceless index collapses both to the same key.
  const tweedles = card({
    id: "tdd",
    name: "Tweedledee & Tweedledum",
    version: "Strange Storytellers",
  });
  const idx = buildCardIndex([tweedles]);

  it("matches a name whose internal spacing drifted from the catalog", () => {
    const incoming = "Tweedle Dee & Tweedle Dum - Strange Storytellers";
    const key = spacelessKey(
      incoming
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase(),
    );
    expect(idx.bySpaceless.get(key)).toBe(tweedles);
  });

  it("preserves null (ambiguous) when two real cards collapse to the same spaceless key", () => {
    // Synthetic: if some future expansion did publish both
    // ``Tweedledee & Tweedledum`` and ``Tweedle Dee & Tweedle Dum``
    // as separate cards, the spaceless index must NOT silently
    // pick one. Encode that contract here.
    const a = card({ id: "a", name: "Tweedledee & Tweedledum", version: "X" });
    const b = card({ id: "b", name: "Tweedle Dee & Tweedle Dum", version: "X" });
    const dual = buildCardIndex([a, b]);
    expect(dual.bySpaceless.get("tweedledeetweedledumx")).toBeNull();
  });
});
