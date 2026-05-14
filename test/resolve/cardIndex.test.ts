import { describe, expect, it } from "vitest";
import type { CardT } from "@bjorvack/lorcana-schemas";
import { buildCardIndex, parsePrintingId, printingKey } from "../../src/resolve/cardIndex.js";

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
