/** CLI entry for the cards snapshot pipeline. TODO: implement. */
export async function runCardsCli(): Promise<void> {
  throw new Error("cards pipeline: not yet implemented");
}

runCardsCli().catch((err) => {
  console.error(err);
  process.exit(1);
});
