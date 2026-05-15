import { describe, expect, it } from "vitest";
import type { DatasetT, TournamentT } from "@bjorvack/lorcana-schemas";
import { mergeTournaments, tournamentKeyOf } from "../../src/pipeline/merge.js";

function tournament(slug: string, date: string): TournamentT {
  return {
    sourceUrl: `https://lorcana.gg/tournaments/${slug}`,
    sourceName: "lorcana.gg",
    name: slug,
    date,
    decks: [
      {
        placement: 1,
        player: null,
        deck: {
          inks: ["Amber"],
          cards: [{ cardId: "x", count: 4 }],
          name: null,
          source: "lorcana.gg",
        },
      },
    ],
  };
}

function dataset(ts: TournamentT[]): DatasetT {
  return {
    datasetVersion: "1.0.0",
    schemaVersion: "0.4.0",
    cardSetVersion: "sha256:" + "0".repeat(64),
    cardsReleaseTag: "cards-vTEST",
    generatedAt: "2025-01-01T00:00:00.000Z",
    sources: ["lorcana.gg"],
    tournaments: ts,
  };
}

describe("mergeTournaments", () => {
  const a = tournament("a", "2025-01-01");
  const b = tournament("b", "2025-01-02");
  const c = tournament("c", "2025-01-03");

  it("appends new tournaments", () => {
    const merged = mergeTournaments(dataset([a]), [b, c]);
    expect(merged.map((t) => t.name)).toEqual(["a", "b", "c"]);
  });

  it("dedups by sourceName+sourceUrl", () => {
    const merged = mergeTournaments(dataset([a, b]), [b, c]);
    expect(merged.length).toBe(3);
  });

  it("treats null prior as empty", () => {
    const merged = mergeTournaments(null, [b, a]);
    expect(merged.map((t) => t.name)).toEqual(["a", "b"]);
  });

  it("stable by date asc", () => {
    const merged = mergeTournaments(null, [c, a, b]);
    expect(merged.map((t) => t.date)).toEqual(["2025-01-01", "2025-01-02", "2025-01-03"]);
  });

  it("E1: unions decks when a tournament re-appears", () => {
    const top4: TournamentT = {
      ...a,
      decks: [
        {
          placement: 1,
          player: "alice",
          deck: {
            inks: ["Amber"],
            cards: [{ cardId: "x", count: 4 }],
            name: null,
            source: "lorcana.gg",
            externalKey: "deck-1",
          },
        },
        {
          placement: 2,
          player: "bob",
          deck: {
            inks: ["Ruby"],
            cards: [{ cardId: "y", count: 4 }],
            name: null,
            source: "lorcana.gg",
            externalKey: "deck-2",
          },
        },
      ],
    };
    const fullTop8: TournamentT = {
      ...a,
      decks: [
        ...top4.decks,
        {
          placement: 3,
          player: "carol",
          deck: {
            inks: ["Emerald"],
            cards: [{ cardId: "z", count: 4 }],
            name: null,
            source: "lorcana.gg",
            externalKey: "deck-3",
          },
        },
      ],
    };
    const merged = mergeTournaments(dataset([top4]), [fullTop8]);
    expect(merged.length).toBe(1);
    expect(merged[0]!.decks.map((d) => d.deck.externalKey)).toEqual(["deck-1", "deck-2", "deck-3"]);
  });

  it("E1: deck merge dedups by externalKey when re-scraping", () => {
    const second = {
      ...a,
      decks: a.decks.map((e) => ({
        ...e,
        deck: { ...e.deck, externalKey: "same" },
      })),
    };
    const first = {
      ...a,
      decks: a.decks.map((e) => ({
        ...e,
        deck: { ...e.deck, externalKey: "same" },
      })),
    };
    const merged = mergeTournaments(dataset([first]), [second]);
    expect(merged[0]!.decks.length).toBe(1);
  });

  it("E1: legacy decks (no externalKey) dedup by player+placement+source", () => {
    const merged = mergeTournaments(dataset([a]), [a]);
    expect(merged[0]!.decks.length).toBe(1);
  });
});

describe("tournamentKeyOf", () => {
  it("is sourceName:sourceUrl", () => {
    expect(tournamentKeyOf({ sourceName: "x", sourceUrl: "y" })).toBe("x:y");
  });
});
