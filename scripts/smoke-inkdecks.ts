/**
 * Local smoke test for ``InkdecksAdapter``. Lists one page of
 * tournaments, fetches the first two, prints the result. Not a unit
 * test — needs the network and a real chromium — so it's not in the
 * vitest suite. Run with:
 *
 *   pnpm exec tsx scripts/smoke-inkdecks.ts
 */
import { InkdecksAdapter } from "../src/sources/inkdecks.js";

const t0 = Date.now();
const adapter = new InkdecksAdapter({ pageFrom: 1, pageTo: 1, deckConcurrency: 3 });
try {
  const refs = await adapter.listTournaments({} as never);
  console.log(`list: ${refs.length} tournaments in ${Date.now() - t0}ms`);
  for (const ref of refs.slice(0, 2)) {
    const t1 = Date.now();
    const tournament = await adapter.fetchTournament(ref, {} as never);
    console.log(
      `  ${tournament.date} ${tournament.name.slice(0, 50)}  ` +
        `${tournament.decks.length} decks in ${Date.now() - t1}ms`,
    );
    const sampleDeck = tournament.decks[0];
    if (sampleDeck) {
      console.log(
        `    placement=${sampleDeck.placement}  inks=${sampleDeck.inks.join("/")}  ` +
          `cards=${sampleDeck.cards
            .slice(0, 3)
            .map((c) => `${c.count}× ${c.rawName}`)
            .join(", ")}…`,
      );
    }
  }
  console.log(`\ntotal: ${Date.now() - t0}ms`);
} finally {
  await adapter.close();
}
