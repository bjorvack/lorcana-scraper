/**
 * CLI orchestrator for the cards snapshot pipeline.
 *
 *   pnpm scrape:cards [--out ./out] [--prior ./prior/cards.json] [--prior-tag cards-v…]
 *
 * Steps:
 *   1. Fetch every card from Lorcast.
 *   2. Map + validate → canonical `CardSet`.
 *   3. If `--prior` is given, parse it and compare; otherwise treat prior as empty.
 *   4. Write cards.json + cards.json.sha256 + cards-diff.md into `--out`.
 *   5. Print a one-line summary to stdout.
 *
 * Exit codes:
 *   0  success, snapshot may or may not have changed
 *   2  validation / parse failure (likely a Lorcast shape change)
 *   3  network / fetch failure after retries
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { CardSet, type CardSetT } from "@bjorvack/lorcana-schemas";
import { fetchAllCards } from "./fetch.js";
import { buildCardSet } from "./build.js";
import { diffCardSets, isEmpty, renderDiffMarkdown } from "./diff.js";
import { writeCardsArtifacts } from "./release.js";

interface Args {
  outDir: string;
  priorPath: string | null;
  priorTag: string | null;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { outDir: "out", priorPath: null, priorTag: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") args.outDir = expectValue(argv, ++i);
    else if (a === "--prior") args.priorPath = expectValue(argv, ++i);
    else if (a === "--prior-tag") args.priorTag = expectValue(argv, ++i);
    else if (a === "--help" || a === "-h") {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  return args;
}

function expectValue(argv: string[], idx: number): string {
  const v = argv[idx];
  if (!v) throw new Error(`Missing value for ${argv[idx - 1]}`);
  return v;
}

function printUsage(): void {
  process.stdout.write(
    [
      "Usage: pnpm scrape:cards [options]",
      "",
      "Options:",
      "  --out <dir>          Output directory (default: ./out)",
      "  --prior <path>       Path to the prior cards.json to diff against",
      "  --prior-tag <tag>    Human tag for the prior release (used in diff header)",
      "  -h, --help           Show this help",
      "",
    ].join("\n"),
  );
}

function loadPrior(path: string): CardSetT {
  if (!existsSync(path)) {
    throw new Error(`Prior cards.json not found at ${path}`);
  }
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return CardSet.parse(raw);
}

export async function runCardsCli(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  let args: Args;
  try {
    args = parseArgs(argv as string[]);
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message}\n`);
    printUsage();
    process.exit(64);
    return;
  }

  let fetched: Awaited<ReturnType<typeof fetchAllCards>>;
  try {
    fetched = await fetchAllCards();
  } catch (err) {
    process.stderr.write(`fetch failed: ${(err as Error).message}\n`);
    process.exit(3);
    return;
  }

  let next: CardSetT;
  try {
    next = buildCardSet(fetched.cards, { fetchedAt: fetched.fetchedAt });
  } catch (err) {
    process.stderr.write(`build/validate failed: ${(err as Error).message}\n`);
    process.exit(2);
    return;
  }

  const prior = args.priorPath ? loadPrior(args.priorPath) : null;
  const diff = diffCardSets(prior, next);
  const md = renderDiffMarkdown(diff, { priorTag: args.priorTag });

  const outDir = resolve(process.cwd(), args.outDir);
  const written = writeCardsArtifacts({ outDir, cardSet: next, diffMarkdown: md });

  const summary = isEmpty(diff)
    ? "no changes"
    : `+${diff.added.length} / -${diff.removed.length} / Δ${diff.changed.length}`;
  process.stdout.write(
    [
      `cards: ${next.cards.length} (cardSetVersion=${next.cardSetVersion})`,
      `diff vs prior: ${summary}`,
      `wrote ${written.cardsJsonPath}`,
      `wrote ${written.cardsJsonSha256Path}`,
      `wrote ${written.cardsDiffPath}`,
    ].join("\n") + "\n",
  );
}

const isDirectRun = import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  runCardsCli().catch((err) => {
    process.stderr.write(`unexpected error: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(1);
  });
}
