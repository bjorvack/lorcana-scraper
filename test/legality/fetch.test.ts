import { describe, expect, it } from "vitest";

import { parseAbsoluteDate, parseDateOrQuarter, parseQuarter } from "../../src/legality/fetch.js";

describe("parseAbsoluteDate", () => {
  it("parses Month Day, Year regardless of host timezone", () => {
    // The source page renders e.g. "September 5, 2025"; our parser
    // operates on the literal y/m/d without going through Date so
    // the output is identical on a UTC runner vs a PST runner.
    expect(parseAbsoluteDate("September 5, 2025")).toBe("2025-09-05");
    expect(parseAbsoluteDate("April 8, 2025")).toBe("2025-04-08");
    expect(parseAbsoluteDate("August 18, 2023")).toBe("2023-08-18");
  });

  it("returns null for unrecognised inputs", () => {
    expect(parseAbsoluteDate("Q3 2026")).toBeNull();
    expect(parseAbsoluteDate("Tomorrow")).toBeNull();
    expect(parseAbsoluteDate("")).toBeNull();
  });

  it("rejects unknown month names so a page typo doesn't silently slide", () => {
    expect(parseAbsoluteDate("Septembr 5, 2025")).toBeNull();
  });
});

describe("parseQuarter", () => {
  it("maps QN YYYY to the last day of that quarter", () => {
    expect(parseQuarter("Q1 2026")).toBe("2026-03-31");
    expect(parseQuarter("Q2 2026")).toBe("2026-06-30");
    expect(parseQuarter("Q3 2026")).toBe("2026-09-30");
    expect(parseQuarter("Q4 2026")).toBe("2026-12-31");
  });

  it("returns null on garbage", () => {
    expect(parseQuarter("Q5 2026")).toBeNull();
    expect(parseQuarter("Q3")).toBeNull();
    expect(parseQuarter("September 5, 2025")).toBeNull();
  });
});

describe("parseDateOrQuarter", () => {
  it("flags forecast=true only for quarter inputs", () => {
    expect(parseDateOrQuarter("September 5, 2025")).toEqual({
      date: "2025-09-05",
      forecast: false,
    });
    expect(parseDateOrQuarter("Q3 2026")).toEqual({ date: "2026-09-30", forecast: true });
    expect(parseDateOrQuarter("not a date")).toBeNull();
  });
});
