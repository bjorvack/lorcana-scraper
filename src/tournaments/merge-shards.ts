/**
 * CLI: `pnpm tournaments:merge-shards`.
 *
 * Takes N shard outputs produced by parallel CI runs and writes a
 * single merged dataset into `--out <dir>`. Each shard input may be:
 *
 *   - A directory (preferred). We read shard metadata from
 *     `<dir>/dataset.json` or `<dir>/meta.json`, and collect every
 *     individual tournament file from `<dir>/tournaments/*.json`.
 *     This format is crash-safe: a shard that died mid-run still
 *     contributes the tournaments it persisted.
 *   - A legacy `dataset.json` file — kept for back-compat with the
 *     old single-file shard layout.
 *
 *   pnpm tournaments:merge-shards \
 *     --out ./merged \
 *     --dataset-version 1.0.0 \
 *     ./shard-0 ./shard-1 ./shard-2 ./shard-3
 *
 * Rules:
 *   - Dedup by `sourceName + sourceUrl` (same key as mergeTournaments).
 *   - All shards must share the same `cardSetVersion` / `cardsReleaseTag`
 *     / `schemaVersion`; we refuse to merge across cards releases.
 *   - `sources` union, `generatedAt` = now, `datasetVersion` = --arg.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { Dataset, type DatasetT } from "@bjorvack/lorcana-schemas";
import { mergeTournaments } from "../pipeline/merge.js";
import { writeTournamentsArtifacts } from "../pipeline/release.js";
import { loadTournamentDir } from "../pipeline/tournamentStore.js";

interface Args {
  outDir: string;
  datasetVersion: string;
  shards: string[];
}

function parseArgs(argv: string[]): Args {
  const a: Args = { outDir: "merged", datasetVersion: "1.0.0", shards: [] };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]!;
    const v = (): string => {
      const x = argv[++i];
      if (!x) throw new Error(`Missing value for ${k}`);
      return x;
    };
    switch (k) {
      case "--out":
        a.outDir = v();
        break;
      case "--dataset-version":
        a.datasetVersion = v();
        break;
      case "-h":
      case "--help":
        printUsage();
        process.exit(0);
        break;
      default:
        if (k.startsWith("--")) throw new Error(`Unknown flag: ${k}`);
        a.shards.push(k);
    }
  }
  return a;
}

function printUsage(): void {
  process.stdout.write(
    [
      "Usage: pnpm tournaments:merge-shards [--out <dir>] [--dataset-version <s>] <dataset.json>...",
      "",
      "Merges N shard dataset.json files into one, deduping by sourceName:sourceUrl.",
      "All shards must share the same cardSetVersion / cardsReleaseTag.",
      "",
    ].join("\n"),
  );
}

function loadDataset(path: string): DatasetT {
  if (!existsSync(path)) throw new Error(`not found: ${path}`);
  return Dataset.parse(JSON.parse(readFileSync(path, "utf8")));
}

/**
 * Shape we extract from each shard input. `tournaments` may come
 * from `tournaments/*.json` (preferred) or `dataset.json.tournaments`
 * (legacy). Metadata always comes from `dataset.json` or `meta.json`.
 */
interface ShardInput {
  readonly meta: Pick<DatasetT, "cardSetVersion" | "cardsReleaseTag" | "schemaVersion" | "sources">;
  readonly tournaments: DatasetT["tournaments"];
}

function loadShardInput(shardPath: string): ShardInput {
  if (!existsSync(shardPath)) throw new Error(`not found: ${shardPath}`);
  const isDir = statSync(shardPath).isDirectory();
  if (!isDir) {
    // Legacy mode: a path to a single dataset.json.
    const ds = loadDataset(shardPath);
    return {
      meta: {
        cardSetVersion: ds.cardSetVersion,
        cardsReleaseTag: ds.cardsReleaseTag,
        schemaVersion: ds.schemaVersion,
        sources: ds.sources,
      },
      tournaments: ds.tournaments,
    };
  }
  // Directory mode. Prefer per-tournament files, fall back to a
  // dataset.json snapshot if no tournaments/ dir was produced (e.g.
  // a shard that died before any tournament finished).
  const datasetPath = resolve(shardPath, "dataset.json");
  const metaPath = resolve(shardPath, "meta.json");
  let meta: ShardInput["meta"];
  if (existsSync(datasetPath)) {
    const ds = loadDataset(datasetPath);
    meta = {
      cardSetVersion: ds.cardSetVersion,
      cardsReleaseTag: ds.cardsReleaseTag,
      schemaVersion: ds.schemaVersion,
      sources: ds.sources,
    };
  } else if (existsSync(metaPath)) {
    // Parsed loosely — the writer in run.ts guarantees these fields.
    meta = JSON.parse(readFileSync(metaPath, "utf8")) as ShardInput["meta"];
  } else {
    throw new Error(`${shardPath}: no dataset.json or meta.json found`);
  }
  const fromFiles = loadTournamentDir(shardPath);
  if (fromFiles.length > 0) {
    return { meta, tournaments: fromFiles };
  }
  // No per-tournament files — fall back to whatever the snapshot has.
  if (existsSync(datasetPath)) {
    return { meta, tournaments: loadDataset(datasetPath).tournaments };
  }
  return { meta, tournaments: [] };
}

export async function runMergeShardsCli(argv = process.argv.slice(2)): Promise<void> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message}\n`);
    printUsage();
    process.exit(64);
    return;
  }
  if (args.shards.length === 0) {
    process.stderr.write("error: at least one shard dataset.json is required\n");
    process.exit(64);
    return;
  }

  const shards = args.shards.map(loadShardInput);
  const [head, ...rest] = shards;
  if (!head) {
    process.stderr.write("error: no shards loaded\n");
    process.exit(64);
    return;
  }
  for (const s of rest) {
    if (s.meta.cardSetVersion !== head.meta.cardSetVersion) {
      throw new Error(
        `cardSetVersion mismatch: ${s.meta.cardSetVersion} vs ${head.meta.cardSetVersion} — refusing to merge`,
      );
    }
    if (s.meta.cardsReleaseTag !== head.meta.cardsReleaseTag) {
      throw new Error(
        `cardsReleaseTag mismatch: ${s.meta.cardsReleaseTag} vs ${head.meta.cardsReleaseTag} — refusing to merge`,
      );
    }
    if (s.meta.schemaVersion !== head.meta.schemaVersion) {
      throw new Error(
        `schemaVersion mismatch: ${s.meta.schemaVersion} vs ${head.meta.schemaVersion} — refusing to merge`,
      );
    }
  }

  // Fold shards left-to-right via the existing mergeTournaments helper.
  // We synthesise a stand-in DatasetT so the helper has the metadata
  // shape it expects; only `tournaments` actually participates in the
  // fold.
  let merged: DatasetT["tournaments"] = [];
  const stand: Pick<DatasetT, "tournaments"> = { tournaments: [] };
  for (const s of shards) {
    merged = mergeTournaments({ ...stand, tournaments: merged } as DatasetT, s.tournaments);
  }

  const sources = Array.from(new Set(shards.flatMap((s) => s.meta.sources)));
  const out: DatasetT = Dataset.parse({
    datasetVersion: args.datasetVersion,
    schemaVersion: head.meta.schemaVersion,
    cardSetVersion: head.meta.cardSetVersion,
    cardsReleaseTag: head.meta.cardsReleaseTag,
    generatedAt: new Date().toISOString(),
    sources,
    tournaments: merged,
  });

  // No resolution report in the merged output — downstream steps run
  // `tournaments:validate` on the merged dataset to regenerate stats.
  const written = writeTournamentsArtifacts({
    outDir: resolve(process.cwd(), args.outDir),
    dataset: out,
    report: {
      generatedAt: out.generatedAt,
      totalFailureRate: 0,
      sources: {},
    },
    affectedDecks: [],
  });

  process.stdout.write(
    [
      `merged ${shards.length} shards`,
      `tournaments: ${out.tournaments.length}`,
      `wrote ${written.datasetPath}`,
    ].join("\n") + "\n",
  );
}

const isDirectRun = import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  runMergeShardsCli().catch((err) => {
    process.stderr.write(`unexpected error: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(1);
  });
}
