/**
 * CLI entry: `pnpm scrape`.
 *
 * TODO: parse args, build ScrapeContext, run the tournaments pipeline.
 * See DESIGN.md → "High-level flow".
 */
async function main(): Promise<void> {
  throw new Error("lorcana-scraper: not yet implemented");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
