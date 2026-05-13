/**
 * Build a validated, canonical `CardSet` from raw Lorcast responses.
 *
 *   raw LorcastApiCard[]
 *     → mapLorcastToCard (validates upstream shape, projects to Card)
 *     → Card.parse (re-validates output)
 *     → sort by id
 *     → hashCardSet → cardSetVersion
 *     → assemble CardSet (also re-validated)
 */
import {
  Card,
  CardSet,
  type CardSetT,
  type CardT,
  type LorcastApiCardT,
  hashCardSet,
  mapLorcastToCard,
} from "@bjorvack/lorcana-schemas";

export interface BuildOptions {
  readonly fetchedAt: string;
}

export function buildCardSet(raw: readonly LorcastApiCardT[], opts: BuildOptions): CardSetT {
  const cards: CardT[] = [];
  for (const r of raw) {
    cards.push(Card.parse(mapLorcastToCard(r)));
  }
  cards.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const cardSetVersion = hashCardSet(cards);
  return CardSet.parse({ cardSetVersion, fetchedAt: opts.fetchedAt, cards });
}
