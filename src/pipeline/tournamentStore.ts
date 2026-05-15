/**
 * Per-tournament artifact store.
 *
 * Replaces (well, augments) the single `dataset.json` snapshot with one
 * JSON file per scraped tournament under `<outDir>/tournaments/`:
 *
 *   <outDir>/
 *     tournaments/
 *       <externalKey>.json
 *       <externalKey>.json
 *       ...
 *     failed/
 *       <externalKey>.json
 *
 * Why: a crash mid-run leaves every already-finished tournament
 * untouched on disk. The merge job globs `**\/tournaments/*.json`
 * across shards and dedups by externalKey, so partial shards still
 * contribute. No more "lost a shard ⇒ lost everything that shard
 * had ingested so far".
 *
 * Writes are atomic (`tmp` + rename) so a SIGKILL mid-write never
 * leaves a half-written file behind.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { Tournament, type TournamentT } from "@bjorvack/lorcana-schemas";

export const TOURNAMENTS_SUBDIR = "tournaments";
export const FAILED_SUBDIR = "failed";

function safeBasename(externalKey: string): string {
  // externalKey is a sha256 hex digest, so already filesystem-safe;
  // defensive sanitise in case a future adapter emits something
  // non-hex. Never trust an upstream id with a filename.
  return externalKey.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 96);
}

function tournamentPath(outDir: string, externalKey: string): string {
  return resolve(outDir, TOURNAMENTS_SUBDIR, `${safeBasename(externalKey)}.json`);
}

function failedPath(outDir: string, externalKey: string): string {
  return resolve(outDir, FAILED_SUBDIR, `${safeBasename(externalKey)}.json`);
}

/**
 * Atomically persist one tournament. Writes to `<path>.tmp` first and
 * renames into place so a crash mid-write never produces a malformed
 * JSON file that the merge step would choke on.
 */
export function writeTournamentFile(outDir: string, tournament: TournamentT): string {
  const key = tournament.externalKey;
  if (!key) {
    // Refuse to write tournaments without an externalKey — they'd
    // collide with each other and confuse the merge dedup step.
    throw new Error(`writeTournamentFile: tournament has no externalKey (${tournament.sourceUrl})`);
  }
  const path = tournamentPath(outDir, key);
  mkdirSync(resolve(outDir, TOURNAMENTS_SUBDIR), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(tournament, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
  return path;
}

/**
 * Record a tournament we tried to scrape but errored on. The merge
 * step ignores these but the file is useful for triage (and lets the
 * next run skip the ref if we want a deny-list someday).
 */
export interface FailedTournamentRecord {
  readonly externalKey: string;
  readonly sourceName: string;
  readonly sourceUrl: string;
  readonly attemptedAt: string;
  readonly error: string;
}

export function writeFailedTournament(outDir: string, record: FailedTournamentRecord): string {
  const path = failedPath(outDir, record.externalKey);
  mkdirSync(resolve(outDir, FAILED_SUBDIR), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(record, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
  return path;
}

/**
 * Load every `tournaments/*.json` under `dir` and parse each through
 * the Zod schema. Bad files are skipped with a stderr warning rather
 * than aborting the merge — we'd rather publish (most of) a partial
 * shard than fail the whole run.
 */
export function loadTournamentDir(dir: string): TournamentT[] {
  const root = resolve(dir, TOURNAMENTS_SUBDIR);
  if (!existsSync(root)) return [];
  const out: TournamentT[] = [];
  for (const entry of readdirSync(root)) {
    if (!entry.endsWith(".json")) continue;
    const path = resolve(root, entry);
    try {
      const parsed = Tournament.parse(JSON.parse(readFileSync(path, "utf8")));
      out.push(parsed);
    } catch (err) {
      process.stderr.write(`[tournament-store] skipping ${path}: ${(err as Error).message}\n`);
    }
  }
  return out;
}
