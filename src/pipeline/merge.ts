/**
 * Merge logic for the tournaments pipeline.
 *
 *   priorDataset → set of seen tournamentKeys (sourceName + sourceUrl)
 *   newTournaments → for each tournament:
 *     - new key            → append
 *     - existing key       → merge decks (E1): union by Deck.externalKey
 *       (or by deck content shape for older 0.6.x datasets that
 *       didn't emit externalKey yet).
 *
 * Why deck-level merge: a single tournament can be scraped in pieces
 * — first run pulls the top 8 decks, a later run pulls the rest. The
 * old "prior wins, drop new" rule lost that progress. With E1, every
 * run can contribute new decks to existing tournaments.
 */
import type { DatasetT, TournamentT } from "@bjorvack/lorcana-schemas";

export function tournamentKeyOf(t: { sourceName: string; sourceUrl: string }): string {
  return `${t.sourceName}:${t.sourceUrl}`;
}

/**
 * Stable key for a deck within a tournament. Prefers the explicit
 * `externalKey` we started emitting in schemas 0.7.0; falls back to
 * a tuple of (placement, player, source) for older data where
 * `externalKey` is absent. Two decks share a key iff they describe
 * the same placement entry from the same source.
 */
function deckKey(entry: TournamentT["decks"][number]): string {
  if (entry.deck.externalKey) return `k:${entry.deck.externalKey}`;
  // Legacy fallback: same player + placement + source URL identifies
  // the same standings row across re-scrapes.
  return [
    "leg",
    entry.placement ?? "_",
    entry.player ?? "_",
    entry.deck.externalUrl ?? entry.deck.source ?? "_",
  ].join("|");
}

/**
 * Union the deck arrays of two scrapes of the same tournament,
 * deduping by deckKey. Existing entries win their slot's order (so
 * the merged result is stable); brand-new entries are appended.
 */
function mergeDecks(
  existing: TournamentT["decks"],
  incoming: TournamentT["decks"],
): TournamentT["decks"] {
  const seen = new Map<string, number>();
  const out: TournamentT["decks"] = [];
  for (const e of existing) {
    seen.set(deckKey(e), out.length);
    out.push(e);
  }
  for (const e of incoming) {
    const k = deckKey(e);
    if (seen.has(k)) continue; // keep the prior copy; assume immutability
    seen.set(k, out.length);
    out.push(e);
  }
  // Stable order: by placement asc (nulls last), then deckKey.
  out.sort((a, b) => {
    const pa = a.placement ?? Number.MAX_SAFE_INTEGER;
    const pb = b.placement ?? Number.MAX_SAFE_INTEGER;
    if (pa !== pb) return pa - pb;
    return deckKey(a) < deckKey(b) ? -1 : 1;
  });
  return out;
}

/**
 * Merge two snapshots of the same tournament. The incoming snapshot
 * may have a strictly larger decks list (we re-scraped after more
 * placements landed) or new metadata. We always keep the prior
 * tournament's `externalKey`/`sourceUrl` since those are by
 * definition equal already.
 */
function mergeTournamentPair(prior: TournamentT, incoming: TournamentT): TournamentT {
  return {
    ...prior,
    // Prefer the newer name/date — adapters sometimes fix typos or
    // resolve missing dates on a later scrape.
    name: incoming.name || prior.name,
    date: incoming.date || prior.date,
    decks: mergeDecks(prior.decks, incoming.decks),
  };
}

export function mergeTournaments(
  prior: DatasetT | null,
  added: readonly TournamentT[],
): TournamentT[] {
  const byKey = new Map<string, TournamentT>();
  for (const t of prior?.tournaments ?? []) {
    byKey.set(tournamentKeyOf(t), t);
  }
  for (const t of added) {
    const k = tournamentKeyOf(t);
    const existing = byKey.get(k);
    byKey.set(k, existing ? mergeTournamentPair(existing, t) : t);
  }
  const merged = [...byKey.values()];
  // Stable order: by date asc, then sourceUrl.
  merged.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return a.sourceUrl < b.sourceUrl ? -1 : 1;
  });
  return merged;
}
