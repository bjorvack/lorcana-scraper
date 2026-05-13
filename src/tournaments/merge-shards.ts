/**
 * CLI: `pnpm tournaments:merge-shards`.
 *
 * Takes N shard dataset.json files produced by parallel CI runs (each
 * scraping a disjoint page range) and writes a single merged dataset
 * into `--out <dir>`. Downstream steps (validate, release) then operate
 * on the merged file as usual.
 *
 *   pnpm tournaments:merge-shards \
 *     --out ./merged \
 *     --dataset-version 1.0.0 \
 *     ./shard-0/dataset.json ./shard-1/dataset.json ...
 *
 * Rules:
 *   - Dedup by `sourceName + sourceUrl` (same key as mergeTournaments).
 *   - All shards must share the same `cardSetVersion` / `cardsReleaseTag`
 *     / `schemaVersion`; we refuse to merge across cards releases.
 *   - `sources` union, `generatedAt` = now, `datasetVersion` = --arg.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Dataset, type DatasetT } from "@bjorvack/lorcana-schemas";
import { mergeTournaments } from "../pipeline/merge.js";
import { writeTournamentsArtifacts } from "../pipeline/release.js";

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

  const datasets = args.shards.map(loadDataset);
  const [head, ...rest] = datasets;
  if (!head) {
    process.stderr.write("error: no shards loaded\n");
    process.exit(64);
    return;
  }
  for (const d of rest) {
    if (d.cardSetVersion !== head.cardSetVersion) {
      throw new Error(
        `cardSetVersion mismatch: ${d.cardSetVersion} vs ${head.cardSetVersion} — refusing to merge`,
      );
    }
    if (d.cardsReleaseTag !== head.cardsReleaseTag) {
      throw new Error(
        `cardsReleaseTag mismatch: ${d.cardsReleaseTag} vs ${head.cardsReleaseTag} — refusing to merge`,
      );
    }
    if (d.schemaVersion !== head.schemaVersion) {
      throw new Error(
        `schemaVersion mismatch: ${d.schemaVersion} vs ${head.schemaVersion} — refusing to merge`,
      );
    }
  }

  // Fold datasets left-to-right via the existing mergeTournaments helper.
  let merged: DatasetT["tournaments"] = [];
  for (const d of datasets) {
    merged = mergeTournaments({ ...head, tournaments: merged }, d.tournaments);
  }

  const sources = Array.from(new Set(datasets.flatMap((d) => d.sources)));
  const out: DatasetT = Dataset.parse({
    datasetVersion: args.datasetVersion,
    schemaVersion: head.schemaVersion,
    cardSetVersion: head.cardSetVersion,
    cardsReleaseTag: head.cardsReleaseTag,
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
      `merged ${datasets.length} shards`,
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
