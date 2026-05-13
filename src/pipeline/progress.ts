/**
 * Structured run-progress tracker.
 *
 * Writes `progress.json` next to the other run artifacts so an outside
 * observer can watch a long run:
 *
 *   watch -n 5 'jq . ./out/progress.json'
 *
 * Updated after every tournament and every deck. The file is fsync'd so
 * a `cat` from another shell never sees partial JSON.
 */
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface ProgressSnapshot {
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly elapsedMs: number;
  readonly etaMs: number | null;
  readonly source: string | null;
  readonly tournaments: {
    readonly total: number;
    readonly done: number;
    readonly current: { readonly index: number; readonly name: string } | null;
  };
  readonly decks: {
    readonly currentTotal: number;
    readonly currentDone: number;
    readonly totalFetched: number;
    readonly totalResolved: number;
    readonly totalFailed: number;
  };
  readonly lastError: string | null;
}

export class ProgressReporter {
  private readonly start = Date.now();
  private source: string | null = null;
  private tournamentsTotal = 0;
  private tournamentsDone = 0;
  private currentIndex = 0;
  private currentName: string | null = null;
  private deckCurrentTotal = 0;
  private deckCurrentDone = 0;
  private totalDecksFetched = 0;
  private totalDecksResolved = 0;
  private totalDecksFailed = 0;
  private lastError: string | null = null;
  private readonly outPath: string;

  constructor(outDir: string) {
    this.outPath = resolve(outDir, "progress.json");
    mkdirSync(dirname(this.outPath), { recursive: true });
    this.flush();
  }

  startSource(name: string): void {
    this.source = name;
    this.flush();
  }

  setTournamentsTotal(n: number): void {
    this.tournamentsTotal = n;
    this.flush();
  }

  startTournament(index: number, name: string, deckCount: number): void {
    this.currentIndex = index;
    this.currentName = name;
    this.deckCurrentTotal = deckCount;
    this.deckCurrentDone = 0;
    this.flush();
  }

  /** Set the number of decks to fetch for the current tournament. */
  setCurrentTournamentDeckCount(n: number): void {
    this.deckCurrentTotal = n;
    this.flush();
  }

  noteDeck(args: { resolved: boolean; failed: boolean }): void {
    this.deckCurrentDone += 1;
    this.totalDecksFetched += 1;
    if (args.resolved) this.totalDecksResolved += 1;
    if (args.failed) this.totalDecksFailed += 1;
    // Don't flush per-deck if there are many — keep a soft cadence.
    if (this.deckCurrentDone % 4 === 0 || this.deckCurrentDone === this.deckCurrentTotal) {
      this.flush();
    }
  }

  endTournament(): void {
    this.tournamentsDone += 1;
    this.flush();
  }

  noteError(msg: string): void {
    this.lastError = msg;
    this.flush();
  }

  snapshot(): ProgressSnapshot {
    const elapsedMs = Date.now() - this.start;
    const etaMs =
      this.tournamentsDone > 0 && this.tournamentsTotal > this.tournamentsDone
        ? Math.round(
            (elapsedMs / this.tournamentsDone) * (this.tournamentsTotal - this.tournamentsDone),
          )
        : null;
    return {
      startedAt: new Date(this.start).toISOString(),
      updatedAt: new Date().toISOString(),
      elapsedMs,
      etaMs,
      source: this.source,
      tournaments: {
        total: this.tournamentsTotal,
        done: this.tournamentsDone,
        current:
          this.currentName !== null ? { index: this.currentIndex, name: this.currentName } : null,
      },
      decks: {
        currentTotal: this.deckCurrentTotal,
        currentDone: this.deckCurrentDone,
        totalFetched: this.totalDecksFetched,
        totalResolved: this.totalDecksResolved,
        totalFailed: this.totalDecksFailed,
      },
      lastError: this.lastError,
    };
  }

  /** Format a one-line summary, useful for terminal log lines. */
  oneLine(): string {
    const s = this.snapshot();
    const t = `${s.tournaments.done}/${s.tournaments.total}`;
    const d =
      s.decks.currentTotal > 0 ? ` decks=${s.decks.currentDone}/${s.decks.currentTotal}` : "";
    const eta = s.etaMs !== null ? ` eta=${formatDuration(s.etaMs)}` : "";
    const elapsed = ` elapsed=${formatDuration(s.elapsedMs)}`;
    return `[${s.source ?? "?"}] t=${t}${d}${elapsed}${eta}`;
  }

  private flush(): void {
    const snap = this.snapshot();
    // Atomic write: temp file + rename.
    const tmp = `${this.outPath}.tmp`;
    writeFileSync(tmp, JSON.stringify(snap, null, 2) + "\n", "utf8");
    renameSync(tmp, this.outPath);
  }
}

function formatDuration(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m}m${rs.toString().padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h${rm.toString().padStart(2, "0")}m`;
}
