import { describe, expect, it } from "vitest";
import {
  inksFromStanding,
  parseDescription,
  slugFromUrl,
  toIsoDate,
  tournamentKey,
  tournamentUrl,
} from "../../src/sources/lorcana-gg.js";

describe("toIsoDate", () => {
  it("converts unix seconds (string) to YYYY-MM-DD", () => {
    expect(toIsoDate("1763697840")).toBe("2025-11-21");
  });
});

describe("slugFromUrl", () => {
  it("extracts the slug", () => {
    expect(slugFromUrl("https://lorcana.gg/tournaments/mulligan-challenge-25")).toBe(
      "mulligan-challenge-25",
    );
  });
});

describe("tournamentKey + tournamentUrl", () => {
  it("are deterministic", () => {
    expect(tournamentKey("lorcana.gg", "abc")).toBe("lorcana.gg:abc");
    expect(tournamentUrl("abc")).toBe("https://lorcana.gg/tournaments/abc");
  });
});

describe("inksFromStanding", () => {
  it("picks colors with a positive count", () => {
    expect(
      inksFromStanding({
        color_amber: "0",
        color_amethyst: "31",
        color_steel: "29",
        color_emerald: "0",
        color_ruby: "0",
        color_sapphire: "0",
      }),
    ).toEqual(["Amethyst", "Steel"]);
  });

  it("handles missing/zero fields", () => {
    expect(inksFromStanding({})).toEqual([]);
  });
});

describe("parseDescription", () => {
  it("extracts slug, place and tournament name from /getdecks anchor", () => {
    expect(
      parseDescription(
        '<a href="/tournaments/mulligan-challenge-25">Place 107 on Mulligan Challenge #25</a>',
      ),
    ).toEqual({
      tournamentSlug: "mulligan-challenge-25",
      tournamentName: "Mulligan Challenge #25",
      placement: 107,
    });
  });

  it("accepts the 'Top N at <name>' variant", () => {
    expect(parseDescription('<a href="/tournaments/foo-bar">Top 8 at Foo Bar Open</a>')).toEqual({
      tournamentSlug: "foo-bar",
      tournamentName: "Foo Bar Open",
      placement: 8,
    });
  });

  it("returns null when no anchor is present", () => {
    expect(parseDescription("just some text")).toBeNull();
    expect(parseDescription(null)).toBeNull();
    expect(parseDescription(undefined)).toBeNull();
    expect(parseDescription("")).toBeNull();
  });

  it("falls back to slug + name when placement format is unexpected", () => {
    expect(parseDescription('<a href="/tournaments/foo">Foo Tournament</a>')).toEqual({
      tournamentSlug: "foo",
      tournamentName: "Foo Tournament",
      placement: undefined,
    });
  });
});
