/**
 * CLI entry: ``pnpm scrape:banlist`` / ``pnpm scrape:rotation``.
 *
 * Writes ``banlist.json`` and/or ``rotation.json`` to ``--out``. Each
 * file validates against its zod schema before write; a failure here
 * means the upstream page's selectors drifted and a human needs to
 * look at ``--out/raw.html`` (dumped for debugging on failure).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { Banlist, Rotation } from "@bjorvack/lorcana-schemas";

import { scrapeBanlist, scrapeRotation } from "./fetch.js";

type Mode = "banlist" | "rotation" | "both";

function getMode(): Mode {
  // We expose three callers off one entry point:
  //   - tsx src/legality/run.ts --mode banlist
  //   - tsx src/legality/run.ts --mode rotation
  //   - tsx src/legality/run.ts            (defaults to both — the
  //     legality.yml workflow runs them in one shot to share a single
  //     fetch round-trip)
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      mode: { type: "string", default: "both" },
      out: { type: "string", default: "./out" },
    },
  });
  const mode = values.mode ?? "both";
  if (mode !== "banlist" && mode !== "rotation" && mode !== "both") {
    throw new Error(`unknown --mode ${mode}; expected banlist | rotation | both`);
  }
  return mode;
}

function getOutDir(): string {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      mode: { type: "string", default: "both" },
      out: { type: "string", default: "./out" },
    },
  });
  return resolve(process.cwd(), values.out ?? "./out");
}

async function runBanlist(outDir: string): Promise<void> {
  const result = await scrapeBanlist();
  Banlist.parse(result.banlist); // throw early on schema drift
  const path = resolve(outDir, "banlist.json");
  writeFileSync(path, JSON.stringify(result.banlist, null, 2) + "\n", "utf8");
  const summary = `[scrape:banlist] wrote ${path} (${
    result.banlist.formats.core_constructed.length
  } banned, ${result.unresolved.length} unresolved)`;
  process.stdout.write(summary + "\n");
  if (result.unresolved.length > 0) {
    // Surface unresolved names on stderr but don't fail the run — a
    // newly-banned card whose changelog ID hasn't been published yet
    // is real and the PR review will surface it.
    process.stderr.write(
      `[scrape:banlist] could not resolve set+number for: ${result.unresolved.join(", ")}\n`,
    );
  }
}

async function runRotation(outDir: string): Promise<void> {
  const result = await scrapeRotation();
  Rotation.parse(result.rotation);
  const path = resolve(outDir, "rotation.json");
  writeFileSync(path, JSON.stringify(result.rotation, null, 2) + "\n", "utf8");
  process.stdout.write(
    `[scrape:rotation] wrote ${path} (${result.rotation.blocks.length} block(s))\n`,
  );
  if (result.forecastedDates.length > 0) {
    process.stderr.write(
      `[scrape:rotation] forecasted dates from quarter labels: ${result.forecastedDates
        .map((f) => `${f.block}.${f.field}=${f.original}`)
        .join(", ")}\n`,
    );
  }
}

async function main(): Promise<void> {
  const mode = getMode();
  const outDir = getOutDir();
  mkdirSync(outDir, { recursive: true });
  if (mode === "banlist" || mode === "both") await runBanlist(outDir);
  if (mode === "rotation" || mode === "both") await runRotation(outDir);
}

// Top-level await with explicit failure code so CI flags upstream
// drift cleanly. The thrown stack trace is the most useful surface.
main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
