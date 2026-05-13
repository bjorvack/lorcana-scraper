import { describe, expect, it } from "vitest";
import {
  inksFromStanding,
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
        standing_place: "1",
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
    expect(inksFromStanding({ standing_place: "1" })).toEqual([]);
  });
});
