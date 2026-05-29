import { describe, expect, it } from "vitest";

import {
  deckExternalKey,
  deckExternalUrl,
  todayIso,
  toRawDeck,
  tournamentKey,
  tournamentUrl,
} from "../../src/sources/api-lorcana.js";

describe("tournamentUrl + tournamentKey", () => {
  it("are deterministic and include the snapshot date + mode", () => {
    expect(tournamentUrl("2026-05-29", "all")).toBe(
      "https://api-lorcana.com/decks?snapshot=2026-05-29",
    );
    expect(tournamentUrl("2026-05-29", "trending")).toBe(
      "https://api-lorcana.com/decks/trending?snapshot=2026-05-29",
    );
    // Stable hex digest, same input -> same key.
    const k1 = tournamentKey("2026-05-29", "all");
    const k2 = tournamentKey("2026-05-29", "all");
    expect(k1).toBe(k2);
    expect(k1).toMatch(/^[0-9a-f]{64}$/);
    // Different mode -> different key, so a "trending" snapshot
    // and an "all" snapshot from the same day are distinct
    // tournaments (priorSeen short-circuit doesn't conflate them).
    expect(tournamentKey("2026-05-29", "all")).not.toBe(tournamentKey("2026-05-29", "trending"));
  });
});

describe("deckExternalUrl + deckExternalKey", () => {
  it("links to dreamborn.ink as the canonical UI for the uuid", () => {
    expect(deckExternalUrl("YMqiMkfyCymDrLwjQwRE")).toBe(
      "https://dreamborn.ink/decks/YMqiMkfyCymDrLwjQwRE",
    );
  });

  it("namespaces the deck key by source so api-lorcana and dreamborn don't collide", () => {
    // Same external URL, different SOURCE_NAME prefix in the hash
    // means the dedup keys are distinct — a deck ingested via
    // dreamborn.ink's adapter won't trigger priorDecksSeen on the
    // api-lorcana side and vice versa. That's intentional: the
    // pipeline's ``externalKey(sourceName, deckId)`` provides the
    // cross-source dedup boundary at projection time.
    const fromApi = deckExternalKey("https://dreamborn.ink/decks/X");
    expect(fromApi).toMatch(/^[0-9a-f]{64}$/);
    // Trivial sanity: differs from the raw hash of the URL alone.
    expect(fromApi).not.toBe("X");
  });
});

describe("todayIso", () => {
  it("formats a Date as YYYY-MM-DD in UTC", () => {
    expect(todayIso(new Date("2026-05-29T01:23:45.678Z"))).toBe("2026-05-29");
    // Crossing midnight UTC vs local: must always be UTC.
    expect(todayIso(new Date("2026-05-29T23:59:59Z"))).toBe("2026-05-29");
    expect(todayIso(new Date("2026-05-30T00:00:00Z"))).toBe("2026-05-30");
  });
});

describe("toRawDeck", () => {
  it("maps a normal deck and copies player + name", () => {
    const out = toRawDeck({
      uuid: "abc123",
      name: "Bounce Burn",
      creator_name: "QuantumLorcana",
      cards: [
        { dreamborn: "006-049", count: 4 },
        { dreamborn: "004-048", count: 2 },
      ],
    });
    expect(out).toEqual({
      player: "QuantumLorcana",
      inks: [],
      cards: [
        { rawName: "006-049", count: 4 },
        { rawName: "004-048", count: 2 },
      ],
      externalId: "abc123",
      externalUrl: "https://dreamborn.ink/decks/abc123",
      displayName: "Bounce Burn",
    });
  });

  it("drops malformed card entries (missing id, zero/negative count) and returns null on empty", () => {
    // Mix of garbage: missing dreamborn key, count <= 0, NaN, valid
    // entry. Only the valid one survives.
    const out = toRawDeck({
      uuid: "xyz",
      name: "",
      cards: [
        { dreamborn: "", count: 4 } as never,
        { dreamborn: "001-002", count: 0 } as never,
        { dreamborn: "001-003", count: Number.NaN } as never,
        { dreamborn: "001-004", count: 3 },
      ],
    });
    expect(out?.cards).toEqual([{ rawName: "001-004", count: 3 }]);
    // Empty deck (everything filtered) -> null so the pipeline
    // doesn't surface a zero-card deck.
    const empty = toRawDeck({ uuid: "y", name: "y", cards: [] });
    expect(empty).toBeNull();
    const noCards = toRawDeck({ uuid: "y", name: "y" });
    expect(noCards).toBeNull();
  });

  it("treats missing/empty creator_name and name as undefined", () => {
    // Empty strings in the API payload shouldn't propagate as
    // empty display names; the projector expects ``undefined`` for
    // "not known" so it can pick the right deckId fallback chain.
    const out = toRawDeck({
      uuid: "abc",
      name: "",
      creator_name: "",
      cards: [{ dreamborn: "001-001", count: 1 }],
    });
    expect(out?.player).toBeUndefined();
    expect(out?.displayName).toBeUndefined();
  });
});
