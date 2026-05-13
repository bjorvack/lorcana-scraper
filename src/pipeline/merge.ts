/**
 * Merge logic for the tournaments pipeline.
 *
 *   priorDataset → set of seen tournamentKeys (sourceUrl-derived)
 *   newTournaments → append-only, only those not in the prior set
 *
 * Tournaments are uniquely identified by `sourceName + sourceUrl` (same
 * shape as `TournamentRef.tournamentKey` in source adapters). Re-running
 * against a stale prior is therefore idempotent.
 */
import type { DatasetT, TournamentT } from "@bjorvack/lorcana-schemas";

export function tournamentKeyOf(t: { sourceName: string; sourceUrl: string }): string {
  return `${t.sourceName}:${t.sourceUrl}`;
}

export function mergeTournaments(
  prior: DatasetT | null,
  added: readonly TournamentT[],
): TournamentT[] {
  const seen = new Set<string>();
  const merged: TournamentT[] = [];
  for (const t of prior?.tournaments ?? []) {
    const k = tournamentKeyOf(t);
    if (!seen.has(k)) {
      seen.add(k);
      merged.push(t);
    }
  }
  for (const t of added) {
    const k = tournamentKeyOf(t);
    if (!seen.has(k)) {
      seen.add(k);
      merged.push(t);
    }
  }
  // Stable order: by date asc, then sourceUrl.
  merged.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return a.sourceUrl < b.sourceUrl ? -1 : 1;
  });
  return merged;
}
