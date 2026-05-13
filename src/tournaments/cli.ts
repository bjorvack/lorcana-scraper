/**
 * CLI: `pnpm scrape:tournaments`.
 *
 * Drives the tournaments orchestrator. Required:
 *   --cards <path>           Path to cards.json (from a cards-vN release)
 *   --cards-release-tag <s>  Tag for the dataset metadata
 *
 * Optional:
 *   --out <dir>              Output directory (default: ./out)
 *   --prior <path>           Prior tournaments-vN dataset.json
 *   --sources <csv>          Comma-separated adapter names (default: all)
 *   --max-tournaments <n>    Cap tournaments per source this run
 *   --max-pages <n>          Cap pagination depth (per source)
 *   --deck-concurrency <n>   Parallel deck fetches per tournament (default: 3)
 *   --dataset-version <s>    Semver string for this dataset (default: 1.0.0)
 *
 * Exit codes:
 *   0  success (with or without changes)
 *   2  validation / schema failure
 *   3  fetch failure after retries
 *   64 usage error
 */
import { SCHEMA_VERSION } from "@bjorvack/lorcana-schemas";
import { runTournamentsPipeline } from "../pipeline/run.js";

interface Args {
  cardsPath: string | null;
  cardsReleaseTag: string | null;
  outDir: string;
  priorPath: string | null;
  sources: readonly string[] | null;
  maxTournaments: number | undefined;
  maxPages: number | undefined;
  deckConcurrency: number | undefined;
  minPlayers: number | undefined;
  maxDecksPerTournament: number | undefined;
  persistEvery: number | undefined;
  datasetVersion: string;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    cardsPath: null,
    cardsReleaseTag: null,
    outDir: "out",
    priorPath: null,
    sources: null,
    maxTournaments: undefined,
    maxPages: undefined,
    deckConcurrency: undefined,
    minPlayers: undefined,
    maxDecksPerTournament: undefined,
    persistEvery: undefined,
    datasetVersion: "1.0.0",
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = (): string => {
      const x = argv[++i];
      if (!x) throw new Error(`Missing value for ${k}`);
      return x;
    };
    switch (k) {
      case "--cards":
        a.cardsPath = v();
        break;
      case "--cards-release-tag":
        a.cardsReleaseTag = v();
        break;
      case "--out":
        a.outDir = v();
        break;
      case "--prior":
        a.priorPath = v();
        break;
      case "--sources":
        a.sources = v()
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        break;
      case "--max-tournaments":
        a.maxTournaments = Number.parseInt(v(), 10);
        break;
      case "--max-pages":
        a.maxPages = Number.parseInt(v(), 10);
        break;
      case "--deck-concurrency":
        a.deckConcurrency = Number.parseInt(v(), 10);
        break;
      case "--min-players":
        a.minPlayers = Number.parseInt(v(), 10);
        break;
      case "--max-decks-per-tournament":
        a.maxDecksPerTournament = Number.parseInt(v(), 10);
        break;
      case "--persist-every":
        a.persistEvery = Number.parseInt(v(), 10);
        break;
      case "--dataset-version":
        a.datasetVersion = v();
        break;
      case "-h":
      case "--help":
        printUsage();
        process.exit(0);
      // eslint-disable-next-line no-fallthrough
      default:
        throw new Error(`Unknown argument: ${k}`);
    }
  }
  return a;
}

function printUsage(): void {
  process.stdout.write(
    [
      "Usage: pnpm scrape:tournaments [options]",
      "",
      "Required:",
      "  --cards <path>             cards.json from a cards-vN release",
      "  --cards-release-tag <s>    Human tag (e.g. cards-v2026.05.13-01)",
      "",
      "Optional:",
      "  --out <dir>                Output directory (default: ./out)",
      "  --prior <path>             Prior tournaments-vN dataset.json.",
      "                             If omitted, `<outDir>/dataset.json` is used",
      "                             automatically (so re-running the same",
      "                             command resumes from where it left off).",
      "  --sources <csv>            Adapter names (default: all)",
      "  --max-tournaments <n>      Cap tournaments per source this run",
      "  --max-pages <n>            Cap pagination depth",
      "  --deck-concurrency <n>     Parallel deck fetches per tournament (default: 1)",
      "  --min-players <n>          Skip tournaments below this player count",
      "  --max-decks-per-tournament <n>  Only fetch top-N decks per tournament",
      "  --persist-every <n>        Snapshot outputs every N tournaments (default: 1)",
      "  --dataset-version <s>      Semver (default: 1.0.0)",
      "  -h, --help                 Show this help",
      "",
      "While the run is in progress, `<outDir>/progress.json` is updated",
      "after every deck and tournament. Watch live with:",
      "",
      "  watch -n 5 'jq . ./out/progress.json'",
      "",
      "Resume after a crash or SIGINT: just re-run the same command. The",
      "orchestrator picks up `<outDir>/dataset.json` as the prior and",
      "skips tournaments already in it.",
      "",
    ].join("\n"),
  );
}

export async function runTournamentsCli(argv = process.argv.slice(2)): Promise<void> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message}\n`);
    printUsage();
    process.exit(64);
    return;
  }
  if (!args.cardsPath || !args.cardsReleaseTag) {
    process.stderr.write("error: --cards and --cards-release-tag are required\n");
    printUsage();
    process.exit(64);
    return;
  }

  try {
    const r = await runTournamentsPipeline({
      cardsPath: args.cardsPath,
      outDir: args.outDir,
      priorPath: args.priorPath,
      sources: args.sources,
      maxTournaments: args.maxTournaments,
      maxPages: args.maxPages,
      deckConcurrency: args.deckConcurrency,
      minPlayers: args.minPlayers,
      maxDecksPerTournament: args.maxDecksPerTournament,
      persistEvery: args.persistEvery,
      datasetMeta: {
        datasetVersion: args.datasetVersion,
        schemaVersion: SCHEMA_VERSION,
        cardsReleaseTag: args.cardsReleaseTag,
      },
    });
    process.stdout.write(
      [
        `added tournaments: ${r.tournamentsAdded}`,
        `total tournaments: ${r.totalTournaments}`,
        `resolution failure rate: ${(r.resolutionFailureRate * 100).toFixed(2)}%`,
        `wrote ${r.datasetPath}`,
      ].join("\n") + "\n",
    );
  } catch (err) {
    process.stderr.write(`run failed: ${(err as Error).message}\n`);
    process.exit(2);
  }
}

const isDirectRun = import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  runTournamentsCli().catch((err) => {
    process.stderr.write(`unexpected error: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(1);
  });
}
