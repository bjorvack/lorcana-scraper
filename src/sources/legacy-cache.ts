/**
 * Static legacy-cache adapter.
 *
 * ``data/legacy-cache.tar.gz`` is a checked-in 1.7 MB tarball seeded
 * from the original ``lorcana-deck-generator`` project's
 * ``training_data/`` directory. It carries:
 *
 *   - ``tournaments/<year>.json``: arrays of
 *     ``{ hash, name, url, date, meta: { set, legality }, decks: [{ hash, place, inks }] }``
 *   - ``decks/<inks>/<sha>.json``: ``{ hash, inks, cards: [{ amount, name, version }] }``
 *
 * We project this into the standard {@link SourceAdapter} shape so the
 * rest of the pipeline (name resolution → ``cardId``, schema
 * validation, dedup against prior dataset) doesn't need to know the
 * data came from a static cache rather than an HTTP source.
 *
 * The adapter is read-only: it never makes network requests, so it
 * runs in zero seconds regardless of rate-limits. The tarball is
 * lazily unpacked into an in-memory map on first ``listTournaments``
 * so a quick ``--max-tournaments=0`` dry-run stays cheap.
 *
 * Notes on the data:
 *   - Some legacy decks have ``version: ""`` for cards with no
 *     subtitle; we drop the empty string so the name-resolver looks
 *     the card up by name only.
 *   - Tournament names are uppercase and noisy ("SET CHAMPIONSHIP
 *     WHISPERS IN THE WELL FREAKCORP"); we keep them verbatim — the
 *     downstream consumer can normalise if needed.
 *   - Tournament ``hash`` + ``deck hash`` are used as the source-side
 *     identifiers, so a re-import is idempotent against the existing
 *     dedup key (``tournamentKey`` = sha256(sourceName + sourceUrl)).
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import type { ScrapeContext } from "../context.js";
import type { RawDeck, RawTournament, SourceAdapter, TournamentRef } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOURCE_NAME = "legacy-cache";
const TARBALL_PATH = resolve(__dirname, "..", "..", "data", "legacy-cache.tar.gz");

interface LegacyTournament {
  readonly hash: string;
  readonly name: string;
  readonly url: string;
  readonly date: string;
  readonly meta?: { set?: number; legality?: string };
  readonly decks: ReadonlyArray<{ hash: string; place: number | null; inks: readonly string[] }>;
}

interface LegacyDeck {
  readonly hash: string;
  readonly inks: readonly string[];
  readonly cards: ReadonlyArray<{ amount: number; name: string; version: string }>;
}

interface CacheIndex {
  /** tournament hash → tournament record. */
  readonly tournaments: Map<string, LegacyTournament>;
  /** deck hash → deck record. */
  readonly decks: Map<string, LegacyDeck>;
}

let cached: CacheIndex | null = null;

function loadCache(): CacheIndex {
  if (cached) return cached;
  const buf = readFileSync(TARBALL_PATH);
  const tar = gunzipSync(buf);
  const entries = parseTar(tar);
  const tournaments = new Map<string, LegacyTournament>();
  const decks = new Map<string, LegacyDeck>();
  for (const { name, content } of entries) {
    if (name.endsWith("/")) continue;
    if (content.length === 0) continue;
    if (name.includes("tournaments/") && name.endsWith(".json")) {
      const arr = JSON.parse(content.toString("utf8")) as LegacyTournament[];
      for (const t of arr) tournaments.set(t.hash, t);
    } else if (name.includes("decks/") && name.endsWith(".json")) {
      const d = JSON.parse(content.toString("utf8")) as LegacyDeck;
      decks.set(d.hash, d);
    }
  }
  cached = { tournaments, decks };
  return cached;
}

/**
 * Minimal POSIX-ustar parser. Just enough to walk our own tarball
 * (no symlinks, no sparse files, no extended headers). Refusing to
 * add a tar dep for a one-off blob.
 */
function parseTar(buf: Buffer): Array<{ name: string; content: Buffer }> {
  const out: Array<{ name: string; content: Buffer }> = [];
  let offset = 0;
  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512);
    // End-of-archive: two zero blocks.
    if (header[0] === 0) break;
    const name = cstring(header.subarray(0, 100));
    const prefix = cstring(header.subarray(345, 500));
    const fullName = prefix ? `${prefix}/${name}` : name;
    const sizeOctal = cstring(header.subarray(124, 136)).trim();
    const size = sizeOctal ? Number.parseInt(sizeOctal, 8) : 0;
    const typeFlag = String.fromCharCode(header[156]!);
    offset += 512;
    if (typeFlag === "0" || typeFlag === "\0") {
      out.push({ name: fullName, content: buf.subarray(offset, offset + size) });
    }
    offset += Math.ceil(size / 512) * 512;
  }
  return out;
}

function cstring(b: Buffer): string {
  const nul = b.indexOf(0);
  return b.subarray(0, nul >= 0 ? nul : b.length).toString("utf8");
}

function tournamentKey(sourceUrl: string): string {
  return createHash("sha256").update(`${SOURCE_NAME}|${sourceUrl}`).digest("hex");
}

/**
 * Title-case an ink the legacy data emits as lowercase ("amber",
 * "amethyst"…). The downstream pipeline accepts either, but
 * normalising here keeps the dataset consistent across sources.
 */
function titleInk(s: string): string {
  if (s.length === 0) return s;
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

function projectDeck(legacy: LegacyDeck, placement: number | null): RawDeck {
  const cards = legacy.cards
    .filter((c) => c.amount > 0 && c.name.length > 0)
    .map((c) => ({
      // The pipeline's ``resolveCard`` accepts either "Name" or
      // "Name — Version" as input; we normalise to the latter when
      // a non-empty version is present.
      rawName: c.version ? `${c.name} - ${c.version}` : c.name,
      count: c.amount,
    }));
  return {
    placement: placement === null ? undefined : placement,
    inks: legacy.inks.map(titleInk),
    cards,
    externalId: legacy.hash,
  };
}

export const legacyCache: SourceAdapter = {
  sourceName: SOURCE_NAME,

  async listTournaments(_ctx: ScrapeContext): Promise<TournamentRef[]> {
    const idx = loadCache();
    const refs: TournamentRef[] = [];
    for (const t of idx.tournaments.values()) {
      // Skip tournaments that don't reference any cached decks. The
      // legacy data has a handful of stubs with empty deck lists.
      const knownDecks = t.decks.filter((d) => idx.decks.has(d.hash));
      if (knownDecks.length === 0) continue;
      refs.push({
        tournamentKey: tournamentKey(t.url),
        sourceUrl: t.url,
        name: t.name,
        date: t.date,
      });
    }
    return refs;
  },

  async fetchTournament(ref: TournamentRef, _ctx: ScrapeContext): Promise<RawTournament> {
    const idx = loadCache();
    // Reverse-lookup the tournament record by sourceUrl since
    // ``TournamentRef`` is the only shape the orchestrator hands us.
    let entry: LegacyTournament | undefined;
    for (const t of idx.tournaments.values()) {
      if (t.url === ref.sourceUrl) {
        entry = t;
        break;
      }
    }
    if (!entry) throw new Error(`legacy-cache: tournament not found for ${ref.sourceUrl}`);

    const decks: RawDeck[] = [];
    for (const slot of entry.decks) {
      const legacy = idx.decks.get(slot.hash);
      if (!legacy) continue; // dataset references a deck file we don't have
      decks.push(projectDeck(legacy, slot.place));
    }

    return {
      sourceUrl: entry.url,
      name: entry.name,
      date: entry.date,
      decks,
    };
  },
};
