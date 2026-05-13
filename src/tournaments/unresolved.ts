/**
 * Print a per-rawName breakdown of cards the resolver couldn't map to
 * Lorcast, joined with whatever metadata dotgg has for that id.
 *
 *   pnpm tournaments:unresolved \
 *     --report ./backfill/resolution-report.json \
 *     --dotgg ./backfill/dotgg-cards.cache.json \
 *     --cards ./out/cards.json
 *
 * Output: one line per unresolved id, sorted by frequency desc:
 *
 *   count  rawName              | dotgg name + title          | closest Lorcast guess
 *
 * Two output formats:
 *   --format=text   (default)   one row per unresolved id
 *   --format=json               machine-readable for follow-up tooling
 */
import { existsSync, readFileSync } from "node:fs";
import { CardSet, type CardT } from "@bjorvack/lorcana-schemas";
import { buildCardIndex } from "../resolve/cardIndex.js";
import { normaliseKey } from "../resolve/normalise.js";

interface Args {
  reportPath: string;
  dotggPath: string | null;
  cardsPath: string | null;
  format: "text" | "json";
  limit: number;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    reportPath: "",
    dotggPath: null,
    cardsPath: null,
    format: "text",
    limit: Infinity,
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = (): string => {
      const x = argv[++i];
      if (!x) throw new Error(`Missing value for ${k}`);
      return x;
    };
    if (k === "--report") a.reportPath = v();
    else if (k === "--dotgg") a.dotggPath = v();
    else if (k === "--cards") a.cardsPath = v();
    else if (k === "--format") {
      const f = v();
      if (f !== "text" && f !== "json") throw new Error("--format must be text or json");
      a.format = f;
    } else if (k === "--limit") a.limit = Number.parseInt(v(), 10);
    else if (k === "-h" || k === "--help") {
      process.stdout.write(
        [
          "Usage: pnpm tournaments:unresolved [options]",
          "",
          "Required:",
          "  --report <path>     resolution-report.json produced by a run",
          "",
          "Optional:",
          "  --dotgg <path>      dotgg-cards.cache.json (enables name lookup)",
          "  --cards <path>      cards.json (enables Lorcast closest-match)",
          "  --format text|json  output format (default text)",
          "  --limit <n>         only show the top N rawNames",
          "",
        ].join("\n"),
      );
      process.exit(0);
    } else throw new Error(`Unknown argument: ${k}`);
  }
  if (!a.reportPath) throw new Error("--report is required");
  return a;
}

interface UnresolvedRow {
  count: number;
  rawName: string;
  dotggName: string | null;
  dotggTitle: string | null;
  bestGuess: { id: string; name: string; version: string | null; reason: string } | null;
}

function rows(args: Args): UnresolvedRow[] {
  if (!existsSync(args.reportPath)) throw new Error(`report not found: ${args.reportPath}`);
  const report = JSON.parse(readFileSync(args.reportPath, "utf8"));
  const unresolved: Record<string, number> = {};
  for (const src of Object.values(report.sources ?? {}) as {
    unresolvedCounts?: Record<string, number>;
  }[]) {
    for (const [k, v] of Object.entries(src.unresolvedCounts ?? {})) {
      unresolved[k] = (unresolved[k] ?? 0) + v;
    }
  }

  let dotgg: { byId: Map<string, { name: string; title: string | null }> } | null = null;
  if (args.dotggPath && existsSync(args.dotggPath)) {
    const cached = JSON.parse(readFileSync(args.dotggPath, "utf8")) as {
      cards: { id: string; name: string; title: string | null }[];
    };
    const byId = new Map<string, { name: string; title: string | null }>();
    for (const c of cached.cards) byId.set(c.id, { name: c.name, title: c.title });
    dotgg = { byId };
  }

  let cards: CardT[] | null = null;
  let index: ReturnType<typeof buildCardIndex> | null = null;
  if (args.cardsPath && existsSync(args.cardsPath)) {
    cards = CardSet.parse(JSON.parse(readFileSync(args.cardsPath, "utf8"))).cards;
    index = buildCardIndex(cards);
  }

  const out: UnresolvedRow[] = [];
  for (const [rawName, count] of Object.entries(unresolved)) {
    const entry = dotgg?.byId.get(rawName) ?? null;
    let bestGuess: UnresolvedRow["bestGuess"] = null;
    if (entry && index) {
      const display = entry.title ? `${entry.name} - ${entry.title}` : entry.name;
      const byExact = index.byExact.get(display);
      if (byExact) {
        bestGuess = {
          id: byExact.id,
          name: byExact.name,
          version: byExact.version,
          reason: "exact match",
        };
      } else {
        const byNormalised = index.byNormalised.get(normaliseKey(display));
        if (byNormalised) {
          bestGuess = {
            id: byNormalised.id,
            name: byNormalised.name,
            version: byNormalised.version,
            reason: "normalised match",
          };
        } else {
          const candidates = index.byNameVersion.get(entry.name.toLowerCase()) ?? [];
          if (candidates.length === 1) {
            const c = candidates[0]!;
            bestGuess = {
              id: c.id,
              name: c.name,
              version: c.version,
              reason: "single name match",
            };
          } else if (candidates.length > 1) {
            // Multiple printings — list options succinctly.
            const versions = candidates.map((c) => c.version ?? "—").join(" | ");
            bestGuess = {
              id: candidates.map((c) => c.id).join(","),
              name: entry.name,
              version: `(${candidates.length} printings: ${versions})`,
              reason: "ambiguous: multiple printings",
            };
          }
        }
      }
    }

    out.push({
      count,
      rawName,
      dotggName: entry?.name ?? null,
      dotggTitle: entry?.title ?? null,
      bestGuess,
    });
  }

  out.sort((a, b) => b.count - a.count || a.rawName.localeCompare(b.rawName));
  if (Number.isFinite(args.limit)) return out.slice(0, args.limit);
  return out;
}

const args = parseArgs(process.argv.slice(2));
const result = rows(args);
if (args.format === "json") {
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
} else {
  if (result.length === 0) {
    process.stdout.write("No unresolved cards.\n");
  } else {
    const colCount = Math.max(...result.map((r) => String(r.count).length), 5);
    const colRaw = Math.max(...result.map((r) => r.rawName.length), 10);
    const colDot = Math.max(
      ...result.map((r) =>
        r.dotggName ? (r.dotggTitle ? `${r.dotggName} — ${r.dotggTitle}` : r.dotggName).length : 1,
      ),
      14,
    );
    const head =
      `${"count".padStart(colCount)}  ` +
      `${"rawName".padEnd(colRaw)}  ` +
      `${"dotgg name + title".padEnd(colDot)}  ` +
      `lorcast best guess`;
    process.stdout.write(head + "\n" + "-".repeat(head.length) + "\n");
    for (const r of result) {
      const dot = r.dotggName
        ? r.dotggTitle
          ? `${r.dotggName} — ${r.dotggTitle}`
          : r.dotggName
        : "—";
      const bg = r.bestGuess
        ? `${r.bestGuess.name}${r.bestGuess.version ? ` — ${r.bestGuess.version}` : ""} [${r.bestGuess.reason}]`
        : "—";
      process.stdout.write(
        `${String(r.count).padStart(colCount)}  ` +
          `${r.rawName.padEnd(colRaw)}  ` +
          `${dot.padEnd(colDot)}  ` +
          `${bg}\n`,
      );
    }
    process.stdout.write(`\n${result.length} distinct unresolved ids\n`);
  }
}
