/**
 * Unit tests for the pure inkdecks helpers. The headless-browser
 * machinery itself isn't covered here — that's a Playwright job that
 * has to talk to the live site and would belong in a tagged
 * integration suite. These tests cover the parsers that turn raw page
 * text into structured records, which is where the most subtle bugs
 * have historically lived (timezone-dependent date parsing, etc.).
 */
import { describe, expect, it } from "vitest";

import { parseListingDate, parseTxtDecklist } from "../../src/sources/inkdecks.js";

describe("parseListingDate", () => {
  it("parses ISO-8601 dates verbatim", () => {
    expect(parseListingDate("2025-11-20")).toBe("2025-11-20");
  });

  it("parses long-form American dates", () => {
    expect(parseListingDate("Nov 20, 2025")).toBe("2025-11-20");
  });

  it("parses slash-separated dates", () => {
    expect(parseListingDate("11/20/2025")).toBe("2025-11-20");
  });

  it("returns null for free-form text that isn't a date", () => {
    expect(parseListingDate("32 players")).toBeNull();
    expect(parseListingDate("Set 10")).toBeNull();
    expect(parseListingDate(null)).toBeNull();
    expect(parseListingDate(undefined)).toBeNull();
  });
});

describe("parseTxtDecklist", () => {
  it("extracts ``count name - version`` entries", () => {
    const txt = [
      "4 Mickey Mouse - Brave Little Tailor",
      "2 A Whole New World",
      "  3 Dalmatian Puppy - Tail Wagger  ",
    ].join("\n");
    expect(parseTxtDecklist(txt)).toEqual([
      { rawName: "Mickey Mouse - Brave Little Tailor", count: 4 },
      { rawName: "A Whole New World", count: 2 },
      { rawName: "Dalmatian Puppy - Tail Wagger", count: 3 },
    ]);
  });

  it("accepts the ``Nx`` and ``N×`` count separators", () => {
    expect(parseTxtDecklist("4x Belle - Strange but Special").length).toBe(1);
    expect(parseTxtDecklist("4× Belle - Strange but Special").length).toBe(1);
  });

  it("drops entries with implausible counts", () => {
    // Tournament-legal Lorcana decks cap at 4 copies; Microbots-style
    // unlimited copies aren't expressible in the txt export anyway.
    const txt = "8 Goofy - Knight for a Day\n0 Mickey Mouse\n2 Stitch";
    expect(parseTxtDecklist(txt).map((c) => c.rawName)).toEqual(["Stitch"]);
  });

  it("ignores blank lines and short noise", () => {
    expect(parseTxtDecklist("\n\n  \n4 X\n4 Belle - Mystery")).toEqual([
      { rawName: "Belle - Mystery", count: 4 },
    ]);
  });
});
