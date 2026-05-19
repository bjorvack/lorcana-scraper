import { describe, expect, it } from "vitest";
import type { CardT } from "@bjorvack/lorcana-schemas";

import { buildCardIndex } from "../../src/resolve/cardIndex.js";
import { ReportBuilder } from "../../src/pipeline/report.js";
import { projectTournament } from "../../src/pipeline/run.js";
import type { RawDeck, RawTournament } from "../../src/sources/types.js";

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

function rawDeck(i: number): RawDeck {
  return {
    placement: i + 1,
    player: `player-${i}`,
    inks: [],
    cards: [
      { rawName: "1-001", count: 4 },
      { rawName: "1-002", count: 4 },
    ],
    externalId: `deck-${i}`,
    externalUrl: `https://example.test/t/1/p${i}`,
  };
}

function makeRaw(decks: number): RawTournament {
  return {
    sourceUrl: "https://example.test/t/1",
    name: "Test Tournament",
    date: "2026-05-01",
    decks: Array.from({ length: decks }, (_, i) => rawDeck(i)),
  };
}

const cards: CardT[] = [
  card({ id: "a", name: "Ariel", version: "On Human Legs", setCode: "1", cardNumber: 1 }),
  card({ id: "b", name: "Stitch", version: "Carefree Surfer", setCode: "1", cardNumber: 2 }),
];
const index = buildCardIndex(cards);
const adapterName = "test.example";

describe("projectTournament report bookkeeping", () => {
  // Bug repro: per-deck streaming snapshots in run.ts call
  // projectTournament after every emitted deck, growing the deck
  // list 1..N. Each invocation used to re-credit every accumulated
  // deck to the report (decksKept, cardsTotal, ...). For an N-deck
  // tournament that inflated decksKept to N(N+1)/2 + N instead of N.
  // Guard the regression with explicit silent/non-silent assertions.

  it("non-silent projection counts every deck and card exactly once", () => {
    const report = new ReportBuilder();
    report.startSource(adapterName);
    const raw = makeRaw(3);
    const t = projectTournament({
      adapterName,
      ref: { sourceUrl: raw.sourceUrl, name: raw.name, date: raw.date },
      raw,
      index,
      dotggIndex: null,
      report,
    });
    expect(t).not.toBeNull();
    const stats = report.build().sources[adapterName]!;
    expect(stats.decksKept).toBe(3);
    // 3 decks × 2 card entries each = 6 noteCard invocations.
    expect(stats.cardsTotal).toBe(6);
    expect(stats.cardsResolved).toBe(6);
  });

  it("silent projection produces the same tournament but leaves the report untouched", () => {
    const report = new ReportBuilder();
    report.startSource(adapterName);
    const raw = makeRaw(3);
    const t = projectTournament({
      adapterName,
      ref: { sourceUrl: raw.sourceUrl, name: raw.name, date: raw.date },
      raw,
      index,
      dotggIndex: null,
      report,
      silent: true,
    });
    expect(t).not.toBeNull();
    expect(t!.decks).toHaveLength(3);
    const stats = report.build().sources[adapterName]!;
    expect(stats.decksKept).toBe(0);
    expect(stats.cardsTotal).toBe(0);
  });

  it("streaming pattern (N silent + 1 final) reports N decks, not N(N+1)/2", () => {
    // Faithful repro of the pipeline's persistStreaming flow.
    const report = new ReportBuilder();
    report.startSource(adapterName);
    const raw = makeRaw(8);
    const accumulated: RawDeck[] = [];
    for (const d of raw.decks) {
      accumulated.push(d);
      projectTournament({
        adapterName,
        ref: { sourceUrl: raw.sourceUrl, name: raw.name, date: raw.date },
        raw: { ...raw, decks: accumulated },
        index,
        dotggIndex: null,
        report,
        silent: true,
      });
    }
    projectTournament({
      adapterName,
      ref: { sourceUrl: raw.sourceUrl, name: raw.name, date: raw.date },
      raw,
      index,
      dotggIndex: null,
      report,
    });
    const stats = report.build().sources[adapterName]!;
    expect(stats.decksKept).toBe(8);
    expect(stats.cardsTotal).toBe(16);
  });
});
