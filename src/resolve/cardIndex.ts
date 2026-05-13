import type { CardT } from "@bjorvack/lorcana-schemas";

export interface CardIndex {
  readonly byExact: Map<string, CardT>;
  readonly byNameVersion: Map<string, CardT[]>;
  readonly byNormalised: Map<string, CardT>;
}

/** TODO: build an in-memory index over a `CardSet`. See DESIGN.md → "Card name resolution". */
export function buildCardIndex(_cards: readonly CardT[]): CardIndex {
  throw new Error("buildCardIndex: not yet implemented");
}
