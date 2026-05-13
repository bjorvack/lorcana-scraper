/**
 * CLI entry: `pnpm scrape`.
 *
 * TODO: parse args, build ScrapeContext, run the tournaments pipeline.
 * See DESIGN.md → "High-level flow".
 */
export async function runScrapeCli(): Promise<void> {
  throw new Error("lorcana-scraper: not yet implemented");
}

runScrapeCli().catch((err) => {
  console.error(err);
  process.exit(1);
});
