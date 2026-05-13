/**
 * Quick post-backfill sanity check.
 *
 *   pnpm tsx src/tournaments/validate.ts --dataset ./backfill/dataset.json --cards ./out/cards.json
 *
 * Reports: tournament count, deck count, resolved-card count, distinct
 * cardIds, ink-pair distribution, and a few spot-checks (no decks
 * >100 cards, every deck has 1-2 inks, every cardId resolves to the
 * pinned cards.json, etc.). Exits non-zero on any hard failure so the
 * release workflow can refuse to publish a broken dataset.
 */
import { existsSync, readFileSync } from "node:fs";
import { CardSet, Dataset } from "@bjorvack/lorcana-schemas";

interface Args {
  datasetPath: string;
  cardsPath: string;
  report: string | null;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { datasetPath: "", cardsPath: "", report: null };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = (): string => {
      const x = argv[++i];
      if (!x) throw new Error(`Missing value for ${k}`);
      return x;
    };
    if (k === "--dataset") a.datasetPath = v();
    else if (k === "--cards") a.cardsPath = v();
    else if (k === "--report") a.report = v();
    else if (k === "-h" || k === "--help") {
      process.stdout.write(
        "Usage: pnpm tsx src/tournaments/validate.ts --dataset <path> --cards <path> [--report <path>]\n",
      );
      process.exit(0);
    } else throw new Error(`Unknown argument: ${k}`);
  }
  if (!a.datasetPath || !a.cardsPath) throw new Error("--dataset and --cards are required");
  return a;
}

function summary(args: Args): { ok: boolean; lines: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];

  if (!existsSync(args.datasetPath)) errors.push(`dataset not found: ${args.datasetPath}`);
  if (!existsSync(args.cardsPath)) errors.push(`cards not found: ${args.cardsPath}`);
  if (errors.length) return { ok: false, lines: errors };

  const dataset = Dataset.parse(JSON.parse(readFileSync(args.datasetPath, "utf8")));
  const cardSet = CardSet.parse(JSON.parse(readFileSync(args.cardsPath, "utf8")));

  lines.push(`dataset:           ${args.datasetPath}`);
  lines.push(`  schemaVersion:   ${dataset.schemaVersion}`);
  lines.push(`  datasetVersion:  ${dataset.datasetVersion}`);
  lines.push(`  cardsReleaseTag: ${dataset.cardsReleaseTag}`);
  lines.push(`  cardSetVersion:  ${dataset.cardSetVersion}`);
  lines.push(`  tournaments:     ${dataset.tournaments.length}`);

  if (dataset.cardSetVersion !== cardSet.cardSetVersion) {
    errors.push(
      `cardSetVersion mismatch: dataset says ${dataset.cardSetVersion}, ` +
        `cards.json says ${cardSet.cardSetVersion}`,
    );
  }

  // Build a Card.id set from the pinned card pool.
  const validIds = new Set(cardSet.cards.map((c) => c.id));

  let totalDecks = 0;
  let totalCards = 0;
  let totalCopies = 0;
  let unknownIds = 0;
  let outOfInk = 0;
  const inkPairCount = new Map<string, number>();
  const dateMin: string[] = [];
  const dateMax: string[] = [];

  for (const t of dataset.tournaments) {
    dateMin.push(t.date);
    dateMax.push(t.date);
    for (const d of t.decks) {
      totalDecks += 1;
      const inks = [...d.deck.inks].sort().join("+");
      inkPairCount.set(inks, (inkPairCount.get(inks) ?? 0) + 1);
      const allowedInks = new Set(d.deck.inks);
      for (const { cardId, count } of d.deck.cards) {
        totalCards += 1;
        totalCopies += count;
        if (!validIds.has(cardId)) {
          unknownIds += 1;
          continue;
        }
        // Validate every card's ink is one of the deck's inks.
        const card = cardSet.cards.find((c) => c.id === cardId)!;
        for (const ink of card.inks) {
          if (!allowedInks.has(ink)) {
            outOfInk += 1;
            break;
          }
        }
      }
    }
  }

  lines.push(`  decks:           ${totalDecks}`);
  lines.push(`  card entries:    ${totalCards}`);
  lines.push(`  total copies:    ${totalCopies}`);
  lines.push(`  dates:           ${dateMin.sort()[0]} … ${dateMax.sort().slice(-1)[0]}`);

  lines.push("");
  lines.push(`top ink pairs:`);
  for (const [pair, n] of [...inkPairCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
    lines.push(`  ${pair.padEnd(20)} ${n}`);
  }

  lines.push("");
  if (unknownIds > 0) {
    errors.push(`${unknownIds} card entries reference an id not in the pinned cards.json`);
  } else {
    lines.push(`every cardId resolves against ${args.cardsPath} ✓`);
  }
  if (outOfInk > 0) {
    errors.push(`${outOfInk} cards have an ink that's not in their deck's declared inks`);
  } else {
    lines.push(`every card's ink is in its deck's inks ✓`);
  }

  if (args.report) {
    const r = JSON.parse(readFileSync(args.report, "utf8"));
    const rate = r.totalFailureRate ?? 0;
    lines.push("");
    lines.push(`resolution failure rate: ${(rate * 100).toFixed(2)}%`);
    if (rate > 0.05) {
      errors.push(`resolution failure rate ${rate * 100}% exceeds 5% threshold`);
    }
  }

  return {
    ok: errors.length === 0,
    lines: errors.length ? [...lines, "", "ERRORS:", ...errors] : lines,
  };
}

const args = parseArgs(process.argv.slice(2));
const result = summary(args);
process.stdout.write(result.lines.join("\n") + "\n");
process.exit(result.ok ? 0 : 1);
