/**
 * Per-run resolution report.
 *
 * Tracks, per source: tournaments seen vs. ingested, decks fetched vs.
 * resolved, and per-rawName failure counts. Persisted as
 * `resolution-report.json` so it can be reviewed alongside the dataset.
 */

export interface PerSourceStats {
  readonly tournamentsListed: number;
  readonly tournamentsKept: number;
  readonly decksKept: number;
  readonly decksWithUnresolved: number;
  readonly cardsTotal: number;
  readonly cardsResolved: number;
  readonly unresolvedCounts: Record<string, number>;
}

export interface ResolutionReport {
  readonly generatedAt: string;
  readonly sources: Record<string, PerSourceStats>;
  readonly totalFailureRate: number;
}

/** Per-deck breakdown of decks that lost at least one card during resolution. */
export interface AffectedDeck {
  readonly sourceName: string;
  readonly tournament: {
    readonly name: string;
    readonly url: string;
    readonly date: string;
  };
  readonly deck: {
    readonly externalId: string | null;
    readonly url: string | null;
    readonly displayName: string | null;
    readonly player: string | null;
    readonly placement: number | null;
  };
  /** rawName → number of distinct deck entries unresolved (not copy count). */
  readonly unresolvedByRawName: Record<string, number>;
  /** Total unresolved entries in this deck. */
  readonly unresolvedTotal: number;
}

export class ReportBuilder {
  private readonly perSource = new Map<string, MutableStats>();
  private readonly affected: AffectedDeck[] = [];

  startSource(sourceName: string): void {
    if (!this.perSource.has(sourceName)) {
      this.perSource.set(sourceName, {
        tournamentsListed: 0,
        tournamentsKept: 0,
        decksKept: 0,
        decksWithUnresolved: 0,
        cardsTotal: 0,
        cardsResolved: 0,
        unresolvedCounts: new Map<string, number>(),
      });
    }
  }

  noteListing(sourceName: string, n: number): void {
    this.perSource.get(sourceName)!.tournamentsListed = n;
  }

  noteTournamentKept(sourceName: string): void {
    this.perSource.get(sourceName)!.tournamentsKept += 1;
  }

  noteDeckKept(sourceName: string): void {
    this.perSource.get(sourceName)!.decksKept += 1;
  }

  noteCard(sourceName: string, rawName: string, resolved: boolean): void {
    const s = this.perSource.get(sourceName)!;
    s.cardsTotal += 1;
    if (resolved) {
      s.cardsResolved += 1;
    } else {
      s.unresolvedCounts.set(rawName, (s.unresolvedCounts.get(rawName) ?? 0) + 1);
    }
  }

  /**
   * Called once per deck that had at least one unresolved card entry. Drives
   * `decksWithUnresolved` and `decks-needing-review.json`.
   */
  noteAffectedDeck(d: AffectedDeck): void {
    const s = this.perSource.get(d.sourceName);
    if (s) s.decksWithUnresolved += 1;
    this.affected.push(d);
  }

  affectedDecks(): readonly AffectedDeck[] {
    return this.affected;
  }

  build(): ResolutionReport {
    const sources: Record<string, PerSourceStats> = {};
    let total = 0;
    let resolved = 0;
    for (const [k, s] of this.perSource) {
      sources[k] = {
        tournamentsListed: s.tournamentsListed,
        tournamentsKept: s.tournamentsKept,
        decksKept: s.decksKept,
        decksWithUnresolved: s.decksWithUnresolved,
        cardsTotal: s.cardsTotal,
        cardsResolved: s.cardsResolved,
        unresolvedCounts: Object.fromEntries(
          [...s.unresolvedCounts.entries()].sort((a, b) => b[1] - a[1]),
        ),
      };
      total += s.cardsTotal;
      resolved += s.cardsResolved;
    }
    return {
      generatedAt: new Date().toISOString(),
      sources,
      totalFailureRate: total === 0 ? 0 : 1 - resolved / total,
    };
  }
}

interface MutableStats {
  tournamentsListed: number;
  tournamentsKept: number;
  decksKept: number;
  decksWithUnresolved: number;
  cardsTotal: number;
  cardsResolved: number;
  unresolvedCounts: Map<string, number>;
}
