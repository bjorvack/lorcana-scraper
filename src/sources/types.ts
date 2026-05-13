import type { TournamentT } from "@bjorvack/lorcana-schemas";
import type { ScrapeContext } from "../context.js";

export interface TournamentRef {
  /** sha256(sourceName + canonical url). */
  readonly tournamentKey: string;
  readonly sourceUrl: string;
  readonly name?: string;
  /** ISO date if visible in the listing. */
  readonly date?: string;
}

/** Intermediate shape — cards are still strings, not ids. */
export interface RawTournament {
  readonly sourceUrl: string;
  readonly name: string;
  /** ISO date. */
  readonly date: string;
  readonly decks: RawDeck[];
}

export interface RawDeck {
  readonly placement?: number;
  readonly player?: string;
  readonly inks: readonly string[];
  readonly cards: readonly { rawName: string; count: number }[];
}

export interface SourceAdapter {
  /** Stable identifier, e.g. "inkdecks.com". */
  readonly sourceName: string;
  listTournaments(ctx: ScrapeContext): Promise<TournamentRef[]>;
  fetchTournament(ref: TournamentRef, ctx: ScrapeContext): Promise<RawTournament>;
}

// Re-export the schema type for adapter authors who need the validated shape.
export type { TournamentT };
