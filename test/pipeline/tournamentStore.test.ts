import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { TournamentT } from "@bjorvack/lorcana-schemas";
import {
  TOURNAMENTS_SUBDIR,
  loadTournamentDir,
  writeFailedTournament,
  writeTournamentFile,
} from "../../src/pipeline/tournamentStore.js";

function makeTournament(slug: string, key: string): TournamentT {
  return {
    sourceUrl: `https://lorcana.gg/tournaments/${slug}`,
    sourceName: "lorcana.gg",
    externalKey: key,
    name: slug,
    date: "2026-05-14",
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

describe("tournamentStore", () => {
  it("writes one file per externalKey and reads them back", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "ts-"));
    writeTournamentFile(dir, makeTournament("a", "aaaa"));
    writeTournamentFile(dir, makeTournament("b", "bbbb"));
    const entries = readdirSync(resolve(dir, TOURNAMENTS_SUBDIR));
    expect(entries.sort()).toEqual(["aaaa.json", "bbbb.json"]);

    const loaded = loadTournamentDir(dir).sort((x, y) =>
      x.externalKey!.localeCompare(y.externalKey!),
    );
    expect(loaded.map((t) => t.externalKey)).toEqual(["aaaa", "bbbb"]);
  });

  it("refuses to write a tournament without externalKey", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "ts-"));
    const bad = { ...makeTournament("c", "cccc"), externalKey: undefined } as TournamentT;
    expect(() => writeTournamentFile(dir, bad)).toThrow(/externalKey/);
  });

  it("overwriting the same externalKey replaces (idempotent re-run)", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "ts-"));
    writeTournamentFile(dir, makeTournament("a", "aaaa"));
    const updated: TournamentT = { ...makeTournament("a", "aaaa"), name: "renamed" };
    writeTournamentFile(dir, updated);
    const [loaded] = loadTournamentDir(dir);
    expect(loaded?.name).toBe("renamed");
  });

  it("skips malformed json files without aborting the load", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "ts-"));
    writeTournamentFile(dir, makeTournament("good", "good"));
    // Drop a syntactically invalid JSON file into the same directory.
    writeFileSync(resolve(dir, TOURNAMENTS_SUBDIR, "bad.json"), "{ this is not json", "utf8");
    const loaded = loadTournamentDir(dir);
    expect(loaded.map((t) => t.externalKey)).toEqual(["good"]);
  });

  it("failed tournaments go to a sibling failed/ directory", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "ts-"));
    writeFailedTournament(dir, {
      externalKey: "ffff",
      sourceName: "inkdecks.com",
      sourceUrl: "https://inkdecks.com/x",
      attemptedAt: "2026-05-14T00:00:00Z",
      error: "boom",
    });
    const record = JSON.parse(readFileSync(resolve(dir, "failed", "ffff.json"), "utf8"));
    expect(record.error).toBe("boom");
  });
});
