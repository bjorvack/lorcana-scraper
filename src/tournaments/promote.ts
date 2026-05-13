/**
 * CLI: `pnpm tournaments:promote`.
 *
 * Turn a pipeline output directory (typically `./backfill` or `./out`)
 * into a GitHub `tournaments-v<version>` release. Steps:
 *
 *   1. Snapshot dataset.json into a staging directory so the running
 *      scraper can keep writing to the source uninterrupted.
 *   2. Patch `datasetVersion` to the requested value.
 *   3. Recompute the sha256 sidecar.
 *   4. Copy the resolution report + decks-needing-review if present.
 *   5. Validate the snapshot against the pinned cards.json (same check
 *      scrape.yml runs before it publishes).
 *   6. Generate release notes from the report stats.
 *   7. Call `gh release create` (unless --dry-run).
 *
 * Usage:
 *
 *   pnpm tournaments:promote \
 *     --from ./backfill \
 *     --cards ./out/cards.json \
 *     --version 0.1.0 \
 *     [--out ./release-v0.1.0] \
 *     [--repo bjorvack/lorcana-scraper] \
 *     [--prerelease] \
 *     [--dry-run] \
 *     [--title "tournaments-v0.1.0 (preview)"] \
 *     [--note "Extra line to add above the auto-generated body"]
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { CardSet, Dataset, type DatasetT } from "@bjorvack/lorcana-schemas";

interface Args {
  from: string;
  cardsPath: string;
  version: string;
  outDir: string | null;
  repo: string;
  prerelease: boolean;
  dryRun: boolean;
  title: string | null;
  extraNote: string | null;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    from: "./backfill",
    cardsPath: "",
    version: "",
    outDir: null,
    repo: "bjorvack/lorcana-scraper",
    prerelease: false,
    dryRun: false,
    title: null,
    extraNote: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]!;
    const v = (): string => {
      const x = argv[++i];
      if (!x) throw new Error(`Missing value for ${k}`);
      return x;
    };
    switch (k) {
      case "--from":
        a.from = v();
        break;
      case "--cards":
        a.cardsPath = v();
        break;
      case "--version":
        a.version = v();
        break;
      case "--out":
        a.outDir = v();
        break;
      case "--repo":
        a.repo = v();
        break;
      case "--prerelease":
        a.prerelease = true;
        break;
      case "--dry-run":
        a.dryRun = true;
        break;
      case "--title":
        a.title = v();
        break;
      case "--note":
        a.extraNote = v();
        break;
      case "-h":
      case "--help":
        printUsage();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown flag: ${k}`);
    }
  }
  if (!a.version) throw new Error("--version is required (e.g. --version 0.1.0)");
  if (!a.cardsPath) throw new Error("--cards is required (pinned cards.json path)");
  return a;
}

function printUsage(): void {
  process.stdout.write(
    [
      "Usage: pnpm tournaments:promote --from <dir> --cards <path> --version <semver> [options]",
      "",
      "Required:",
      "  --from <dir>         Pipeline output dir (default: ./backfill)",
      "  --cards <path>       Pinned cards.json for validation",
      "  --version <semver>   Release version (becomes tournaments-v<semver>)",
      "",
      "Optional:",
      "  --out <dir>          Staging dir (default: ./release-v<version>)",
      "  --repo <owner/repo>  GitHub repo (default: bjorvack/lorcana-scraper)",
      "  --prerelease         Mark the GitHub release as prerelease",
      "  --dry-run            Stage + validate, skip `gh release create`",
      "  --title <str>        Override the GitHub release title",
      "  --note <str>         Extra line inserted above the auto-generated body",
      "",
    ].join("\n"),
  );
}

interface Stats {
  tournaments: number;
  decks: number;
  failureRate: number;
  cardSetVersion: string;
  cardsReleaseTag: string;
}

function snapshotAndPatch(args: Args): { outDir: string; dataset: DatasetT; stats: Stats } {
  const outDir = resolve(process.cwd(), args.outDir ?? `./release-v${args.version}`);
  mkdirSync(outDir, { recursive: true });

  const sourceDataset = resolve(process.cwd(), args.from, "dataset.json");
  if (!existsSync(sourceDataset)) {
    throw new Error(`dataset.json not found at ${sourceDataset}`);
  }

  // Re-parse + re-serialise so we get stable key ordering and schema
  // validation in a single shot. Bumping datasetVersion happens here.
  const raw = JSON.parse(readFileSync(sourceDataset, "utf8")) as Record<string, unknown>;
  raw.datasetVersion = args.version;
  const dataset = Dataset.parse(raw);
  const json = JSON.stringify(dataset, null, 2) + "\n";
  const datasetOut = resolve(outDir, "dataset.json");
  writeFileSync(datasetOut, json, "utf8");

  const hash = createHash("sha256").update(json, "utf8").digest("hex");
  writeFileSync(resolve(outDir, "dataset.json.sha256"), hash + "\n", "utf8");

  // Copy report + review file if present — they aren't required, but they
  // make the release self-describing.
  for (const name of ["resolution-report.json", "decks-needing-review.json"]) {
    const src = resolve(process.cwd(), args.from, name);
    if (existsSync(src)) copyFileSync(src, resolve(outDir, name));
  }

  const reportPath = resolve(outDir, "resolution-report.json");
  let failureRate = 0;
  if (existsSync(reportPath)) {
    const report = JSON.parse(readFileSync(reportPath, "utf8")) as { totalFailureRate: number };
    failureRate = report.totalFailureRate ?? 0;
  }

  const deckCount = dataset.tournaments.reduce((sum, t) => sum + t.decks.length, 0);
  const stats: Stats = {
    tournaments: dataset.tournaments.length,
    decks: deckCount,
    failureRate,
    cardSetVersion: dataset.cardSetVersion,
    cardsReleaseTag: dataset.cardsReleaseTag,
  };

  return { outDir, dataset, stats };
}

function validateAgainstCards(datasetPath: string, cardsPath: string): void {
  // Cheap version of `tournaments:validate`: make sure every cardId in
  // the dataset exists in the pinned cards.json. Stops us shipping a
  // release that references cards we no longer have printings for.
  if (!existsSync(cardsPath)) throw new Error(`cards not found: ${cardsPath}`);
  const dataset = Dataset.parse(JSON.parse(readFileSync(datasetPath, "utf8")));
  const cardSet = CardSet.parse(JSON.parse(readFileSync(cardsPath, "utf8")));
  const cardIds = new Set(cardSet.cards.map((c) => c.id));
  const missing = new Set<string>();
  for (const t of dataset.tournaments) {
    for (const d of t.decks) {
      for (const c of d.deck.cards) {
        if (!cardIds.has(c.cardId)) missing.add(c.cardId);
      }
    }
  }
  if (missing.size > 0) {
    const sample = [...missing].slice(0, 10).join(", ");
    throw new Error(
      `${missing.size} cardId(s) in dataset don't resolve against ${cardsPath}: ${sample}${missing.size > 10 ? ", ..." : ""}`,
    );
  }
}

function buildReleaseNotes(args: Args, stats: Stats): string {
  const tag = `tournaments-v${args.version}`;
  const ratePct = (stats.failureRate * 100).toFixed(2) + "%";
  const parts: string[] = [];
  parts.push(`## ${tag}${args.prerelease ? " (preview)" : ""}`);
  parts.push("");
  if (args.extraNote) {
    parts.push(args.extraNote);
    parts.push("");
  }
  parts.push(`- **Tournaments:** ${stats.tournaments}`);
  parts.push(`- **Decks:** ${stats.decks}`);
  parts.push(`- **Resolution failure rate:** ${ratePct}`);
  parts.push(`- **Pinned cards snapshot:** \`${stats.cardsReleaseTag}\``);
  parts.push(`- **\`cardSetVersion\`:** \`${stats.cardSetVersion}\``);
  parts.push("");
  parts.push("See `resolution-report.json` (attached) for per-source stats.");
  return parts.join("\n") + "\n";
}

function createGithubRelease(args: Args, outDir: string, notesPath: string): void {
  const tag = `tournaments-v${args.version}`;
  const title = args.title ?? (args.prerelease ? `${tag} (preview)` : tag);
  const cliArgs = [
    "release",
    "create",
    tag,
    "--repo",
    args.repo,
    "--title",
    title,
    "--notes-file",
    notesPath,
  ];
  if (args.prerelease) cliArgs.push("--prerelease");
  const assets = [resolve(outDir, "dataset.json"), resolve(outDir, "dataset.json.sha256")];
  const report = resolve(outDir, "resolution-report.json");
  if (existsSync(report)) assets.push(report);
  const review = resolve(outDir, "decks-needing-review.json");
  if (existsSync(review)) assets.push(review);
  cliArgs.push(...assets);

  process.stderr.write(`\n$ gh ${cliArgs.join(" ")}\n`);
  const result = spawnSync("gh", cliArgs, { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`gh release create exited with status ${result.status}`);
  }
}

export async function runPromoteCli(argv = process.argv.slice(2)): Promise<void> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message}\n`);
    printUsage();
    process.exit(64);
    return;
  }

  const { outDir, stats } = snapshotAndPatch(args);
  const datasetOut = resolve(outDir, "dataset.json");
  process.stderr.write(`[promote] staged ${datasetOut}\n`);
  process.stderr.write(
    `  datasetVersion=${args.version} tournaments=${stats.tournaments} decks=${stats.decks}\n`,
  );

  validateAgainstCards(datasetOut, resolve(process.cwd(), args.cardsPath));
  process.stderr.write(`[promote] validation against ${args.cardsPath} ✓\n`);

  const notes = buildReleaseNotes(args, stats);
  const notesPath = resolve(outDir, "release-notes.md");
  writeFileSync(notesPath, notes, "utf8");
  process.stderr.write(`[promote] wrote release notes to ${notesPath}\n`);

  if (args.dryRun) {
    process.stderr.write("[promote] --dry-run set, not calling gh\n");
    return;
  }

  createGithubRelease(args, outDir, notesPath);
  process.stderr.write(
    `[promote] published https://github.com/${args.repo}/releases/tag/tournaments-v${args.version}\n`,
  );
}

const isDirectRun = import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  runPromoteCli().catch((err) => {
    process.stderr.write(`unexpected error: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(1);
  });
}
