/**
 * Tournaments pipeline orchestrator.
 *
 *   loadCards → buildCardIndex
 *   loadPrior (optional) → priorTournamentKeys
 *   for each adapter:
 *     listTournaments (skipping priorTournamentKeys)
 *     fetchTournament → resolve cards → validate
 *   merge with prior
 *   write artifacts
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CardSet,
  Dataset,
  Tournament,
  type CardSetT,
  type DatasetT,
  type DeckT,
  type InkT,
  type TournamentT,
} from "@bjorvack/lorcana-schemas";
import { adapters } from "../sources/index.js";
import type { RawDeck, RawTournament, SourceAdapter } from "../sources/types.js";
import { LorcanaGgAdapter } from "../sources/lorcana-gg.js";
import { buildCardIndex, parsePrintingId, type CardIndex } from "../resolve/cardIndex.js";
import { normaliseKey } from "../resolve/normalise.js";
import {
  defaultDotggCachePath,
  loadDotggNameIndex,
  type DotggNameIndex,
} from "../resolve/dotggNameIndex.js";
import { mergeTournaments, tournamentKeyOf } from "./merge.js";
import { ReportBuilder } from "./report.js";
import { writeTournamentsArtifacts } from "./release.js";
import { ProgressReporter } from "./progress.js";

export interface RunOptions {
  /** Path to the pinned cards-vN cards.json. */
  readonly cardsPath: string;
  /** Output directory. Default: "out". */
  readonly outDir: string;
  /** Path to the prior tournaments-vN dataset.json. Optional. */
  readonly priorPath: string | null;
  /** Comma-separated list of source names to run. Default: all. */
  readonly sources: readonly string[] | null;
  /** Max pages to walk per source. Default: per-adapter default. */
  readonly maxPages?: number;
  /** Max tournaments per source per run (top of pagination). Default: unlimited. */
  readonly maxTournaments?: number;
  /** Concurrency for deck fetches inside each tournament. Default: 1 (rate-limit-friendly). */
  readonly deckConcurrency?: number;
  /** Skip tournaments below this player count. */
  readonly minPlayers?: number;
  /** Only fetch the top-N decks per tournament. Default: unlimited. */
  readonly maxDecksPerTournament?: number;
  /** Persist progress to `outDir` after every N tournaments. Default: 1. */
  readonly persistEvery?: number;
  /** Override the source's default request spacing (ms). Lower = faster. */
  readonly requestSpacingMs?: number;
  /** Dataset metadata. */
  readonly datasetMeta: {
    readonly datasetVersion: string; // semver
    readonly schemaVersion: string;
    readonly cardsReleaseTag: string;
  };
}

export interface RunResult {
  readonly datasetPath: string;
  readonly contentHash: string;
  readonly tournamentsAdded: number;
  readonly totalTournaments: number;
  readonly resolutionFailureRate: number;
}

export async function runTournamentsPipeline(opts: RunOptions): Promise<RunResult> {
  const cards = loadCards(opts.cardsPath);
  const index = buildCardIndex(cards.cards);

  // Secondary lookup index: maps dotgg printing ids to (name, title) for
  // the ~3% of cases parsePrintingId can't handle directly (C1/Q1/Q2 sets,
  // letter-suffix variants like P2-024B, etc.). Resolved through Lorcast
  // by name so we still emit a real `Card.id`.
  const outDirAbs = resolve(process.cwd(), opts.outDir);
  const dotggIndex = await loadDotggNameIndex(defaultDotggCachePath(outDirAbs)).catch((err) => {
    process.stderr.write(
      `[warn] couldn't load dotgg name index (${(err as Error).message}); name fallback disabled\n`,
    );
    return null;
  });
  if (dotggIndex) {
    process.stderr.write(
      `[resolve] loaded dotgg name index: ${dotggIndex.byId.size} cards (fetched ${dotggIndex.fetchedAt})\n`,
    );
  }

  // Resume: if `--prior` wasn't given but `<outDir>/dataset.json` exists,
  // pick it up automatically. This makes re-running the same command after
  // an interrupted run cheap (skip everything we already have).
  const autoPriorPath = resolve(process.cwd(), opts.outDir, "dataset.json");
  const effectivePrior = opts.priorPath ?? (existsSync(autoPriorPath) ? autoPriorPath : null);
  const prior = effectivePrior ? loadDataset(effectivePrior) : null;
  if (prior && !opts.priorPath) {
    process.stderr.write(
      `[resume] picked up ${prior.tournaments.length} tournaments from ${autoPriorPath}\n`,
    );
  }
  const priorKeys = new Set((prior?.tournaments ?? []).map(tournamentKeyOf));
  const priorSeen = (k: string): boolean => priorKeys.has(k);

  const enabled = opts.sources
    ? adapters.filter((a) => opts.sources!.includes(a.sourceName))
    : adapters;
  if (enabled.length === 0) {
    throw new Error(`No source adapters enabled (asked for: ${opts.sources?.join(",") ?? "all"})`);
  }

  const report = new ReportBuilder();
  const progress = new ProgressReporter(resolve(process.cwd(), opts.outDir));
  const added: TournamentT[] = [];

  // Best-effort: on SIGINT/SIGTERM, snapshot whatever we have before exit
  // so the next run can resume from `<outDir>/dataset.json`.
  let interrupted = false;
  const onSignal = (sig: NodeJS.Signals): void => {
    if (interrupted) return; // double-Ctrl-C → let default handler kill us
    interrupted = true;
    process.stderr.write(`\n[${sig}] flushing partial dataset before exit…\n`);
    try {
      writePartial({ opts, cards, enabled, prior, added, report });
      process.stderr.write(`[${sig}] saved ${added.length} new tournaments to ${opts.outDir}\n`);
    } catch (err) {
      process.stderr.write(`[${sig}] failed to flush: ${(err as Error).message}\n`);
    }
    process.exit(130);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  for (const adapter of enabled) {
    report.startSource(adapter.sourceName);
    progress.startSource(adapter.sourceName);
    // Re-instantiate adapters that accept run-time options.
    const ad = applyAdapterOptions(adapter, {
      priorSeen,
      maxPages: opts.maxPages,
      deckConcurrency: opts.deckConcurrency,
      maxResults: opts.maxTournaments,
      minPlayers: opts.minPlayers,
      maxDecksPerTournament: opts.maxDecksPerTournament,
      requestSpacingMs: opts.requestSpacingMs,
      // Always-on persistent HTTP cache for immutable endpoints.
      // Delete <outDir>/http-cache to invalidate.
      cacheDir: resolve(outDirAbs, "http-cache"),
      onDeckFetched: (a) => progress.noteDeck(a),
      onTournamentStart: (a) => progress.setCurrentTournamentDeckCount(a.deckCount),
    });

    process.stderr.write(`[${adapter.sourceName}] listing tournaments...\n`);
    const refs = await ad.listTournaments({} as never); // context unused for v1
    report.noteListing(adapter.sourceName, refs.length);
    process.stderr.write(`[${adapter.sourceName}] listed ${refs.length} tournaments\n`);

    const limited =
      typeof opts.maxTournaments === "number" ? refs.slice(0, opts.maxTournaments) : refs;
    progress.setTournamentsTotal(limited.length);

    // Default to persisting after every tournament so a crash/SIGINT mid-run
    // loses at most one tournament's work. Override with --persist-every if
    // disk write overhead matters more than crash safety.
    const persistEvery = opts.persistEvery ?? 1;
    let i = 0;
    for (const ref of limited) {
      i++;
      const tournamentName = ref.name ?? ref.tournamentKey;
      progress.startTournament(i, tournamentName, 0); // deckCount set later by onTournamentStart
      process.stderr.write(
        `[${adapter.sourceName}] (${i}/${limited.length}) ${tournamentName}...\n`,
      );
      try {
        const raw = await ad.fetchTournament(ref, {} as never);
        const tournament = projectTournament({
          adapterName: adapter.sourceName,
          ref,
          raw,
          index,
          dotggIndex,
          report,
        });
        if (tournament) {
          added.push(tournament);
          report.noteTournamentKept(adapter.sourceName);
        }
      } catch (err) {
        // Single-tournament failures are surfaced but don't fail the run.
        const msg = (err as Error).message;
        console.warn(`  ! ${adapter.sourceName} ${ref.tournamentKey}: ${msg}`);
        progress.noteError(msg);
      }
      progress.endTournament();
      process.stderr.write(`  ${progress.oneLine()}\n`);
      // Periodic crash-safety snapshot. Avoid double-write on the final tournament.
      if (persistEvery > 0 && i % persistEvery === 0 && i < limited.length) {
        writePartial({ opts, cards, enabled, prior, added, report });
        process.stderr.write(`  [persisted snapshot after ${i}/${limited.length}]\n`);
      }
    }
    // Surface HTTP cache effectiveness. Hits = tournaments/decks served
    // from disk, which is why re-runs are cheap.
    const cacheStats = ad instanceof LorcanaGgAdapter ? ad.cacheStats() : null;
    if (cacheStats) {
      process.stderr.write(
        `[${adapter.sourceName}] http cache: ${cacheStats.hits} hits / ${cacheStats.misses} misses\n`,
      );
    }
  }

  const merged = mergeTournaments(prior, added);
  const dataset: DatasetT = Dataset.parse({
    datasetVersion: opts.datasetMeta.datasetVersion,
    schemaVersion: opts.datasetMeta.schemaVersion,
    cardSetVersion: cards.cardSetVersion,
    cardsReleaseTag: opts.datasetMeta.cardsReleaseTag,
    generatedAt: new Date().toISOString(),
    sources: enabled.map((a) => a.sourceName),
    tournaments: merged,
  });

  const finalReport = report.build();
  const written = writeTournamentsArtifacts({
    outDir: resolve(process.cwd(), opts.outDir),
    dataset,
    report: finalReport,
    affectedDecks: report.affectedDecks(),
  });

  return {
    datasetPath: written.datasetPath,
    contentHash: written.contentHash,
    tournamentsAdded: added.length,
    totalTournaments: merged.length,
    resolutionFailureRate: finalReport.totalFailureRate,
  };
}

function projectTournament(args: {
  adapterName: string;
  ref: { sourceUrl: string; name?: string; date?: string };
  raw: RawTournament;
  index: CardIndex;
  dotggIndex: DotggNameIndex | null;
  report: ReportBuilder;
}): TournamentT | null {
  const { adapterName, raw, index, dotggIndex, report } = args;
  const decks = raw.decks
    .map((rawDeck) => projectDeck(adapterName, raw, rawDeck, index, dotggIndex, report))
    .filter((d): d is TournamentT["decks"][number] => d !== null);
  if (decks.length === 0) return null;

  const tournament: TournamentT = Tournament.parse({
    sourceUrl: raw.sourceUrl,
    sourceName: adapterName,
    name: raw.name,
    date: raw.date,
    decks,
  });
  return tournament;
}

function projectDeck(
  sourceName: string,
  rawTournament: RawTournament,
  raw: RawDeck,
  index: CardIndex,
  dotggIndex: DotggNameIndex | null,
  report: ReportBuilder,
): TournamentT["decks"][number] | null {
  const resolvedCards: { cardId: string; count: number }[] = [];
  const inksUsed = new Set<InkT>();
  const unresolvedByRawName = new Map<string, number>();

  for (const { rawName, count } of raw.cards) {
    const card = resolveCard(rawName, index, dotggIndex);
    if (card) {
      report.noteCard(sourceName, rawName, true);
      resolvedCards.push({ cardId: card.id, count });
      for (const ink of card.inks) inksUsed.add(ink);
    } else {
      report.noteCard(sourceName, rawName, false);
      unresolvedByRawName.set(rawName, (unresolvedByRawName.get(rawName) ?? 0) + 1);
    }
  }

  if (unresolvedByRawName.size > 0) {
    let total = 0;
    for (const v of unresolvedByRawName.values()) total += v;
    report.noteAffectedDeck({
      sourceName,
      tournament: {
        name: rawTournament.name,
        url: rawTournament.sourceUrl,
        date: rawTournament.date,
      },
      deck: {
        externalId: raw.externalId ?? null,
        url: raw.externalUrl ?? null,
        displayName: raw.displayName ?? null,
        player: raw.player ?? null,
        placement: raw.placement ?? null,
      },
      unresolvedByRawName: Object.fromEntries(unresolvedByRawName),
      unresolvedTotal: total,
    });
  }

  if (resolvedCards.length === 0) return null;
  // Merge duplicates (defensive — adapters should already dedup).
  const byCardId = new Map<string, number>();
  for (const { cardId, count } of resolvedCards) {
    byCardId.set(cardId, (byCardId.get(cardId) ?? 0) + count);
  }
  const cards = [...byCardId.entries()].map(([cardId, count]) => ({ cardId, count }));

  // Inks: prefer the deck-card-derived set (always accurate). Adapter
  // hints (color_* counters) are ignored if they conflict.
  const inks = [...inksUsed];
  if (inks.length === 0 || inks.length > 2) return null;

  const deck: DeckT = {
    inks: inks as DeckT["inks"],
    cards,
    name: raw.displayName ?? null,
    // Prefer the direct deck URL (lets reviewers click straight through).
    source: raw.externalUrl ?? sourceName,
  };
  report.noteDeckKept(sourceName);
  return {
    placement: raw.placement ?? null,
    player: raw.player ?? null,
    deck,
  };
}

function applyAdapterOptions(
  adapter: SourceAdapter,
  opts: {
    priorSeen?: (k: string) => boolean;
    maxPages?: number;
    deckConcurrency?: number;
    maxResults?: number;
    minPlayers?: number;
    maxDecksPerTournament?: number;
    requestSpacingMs?: number;
    cacheDir?: string;
    onDeckFetched?: (a: { resolved: boolean; failed: boolean }) => void;
    onTournamentStart?: (a: { deckCount: number }) => void;
  },
): SourceAdapter {
  if (adapter instanceof LorcanaGgAdapter) {
    return new LorcanaGgAdapter({
      priorSeen: opts.priorSeen,
      maxPages: opts.maxPages,
      deckConcurrency: opts.deckConcurrency,
      maxResults: opts.maxResults,
      minPlayers: opts.minPlayers,
      maxDecksPerTournament: opts.maxDecksPerTournament,
      requestSpacingMs: opts.requestSpacingMs,
      cacheDir: opts.cacheDir,
      onDeckFetched: opts.onDeckFetched,
      onTournamentStart: opts.onTournamentStart,
    });
  }
  return adapter;
}

/**
 * Resolve a dotgg printing id to a Lorcast `Card`. Strategy, in order:
 *   1. Direct printing-id match (`<setCode>-<NNN>` → Card via parsePrintingId).
 *   2. dotgg name fallback: look up the printing id in dotgg's full card
 *      catalog → get (name, title) → match Lorcast by display name.
 *      Catches `C1`/`Q1`/`Q2` and letter-suffix variants like `P2-024B`.
 *   3. Normalised-name fallback (accent-stripped, lowercased).
 */
function resolveCard(
  rawName: string,
  index: CardIndex,
  dotggIndex: DotggNameIndex | null,
): CardIndex["byPrinting"] extends Map<unknown, infer V> ? V | null : never {
  const printing = parsePrintingId(rawName);
  if (printing) {
    const byPrinting = index.byPrinting.get(printing.key);
    if (byPrinting) return byPrinting;
  }
  if (dotggIndex) {
    const entry = dotggIndex.byId.get(rawName);
    if (entry) {
      const displayName = entry.title ? `${entry.name} - ${entry.title}` : entry.name;
      const byExact = index.byExact.get(displayName);
      if (byExact) return byExact;
      const byNormalised = index.byNormalised.get(normaliseKey(displayName));
      if (byNormalised) return byNormalised;
      // Single-printing fallback: if a card with this name has exactly one
      // printing in Lorcast, use it (handles minor title spelling drift).
      if (!entry.title) {
        const candidates = index.byNameVersion.get(entry.name.toLowerCase()) ?? [];
        if (candidates.length === 1) return candidates[0]!;
      }
    }
  }
  return null as CardIndex["byPrinting"] extends Map<unknown, infer V> ? V | null : never;
}

function writePartial(args: {
  opts: RunOptions;
  cards: CardSetT;
  enabled: readonly SourceAdapter[];
  prior: DatasetT | null;
  added: readonly TournamentT[];
  report: ReportBuilder;
}): void {
  const { opts, cards, enabled, prior, added, report } = args;
  const merged = mergeTournaments(prior, [...added]);
  const dataset: DatasetT = Dataset.parse({
    datasetVersion: opts.datasetMeta.datasetVersion,
    schemaVersion: opts.datasetMeta.schemaVersion,
    cardSetVersion: cards.cardSetVersion,
    cardsReleaseTag: opts.datasetMeta.cardsReleaseTag,
    generatedAt: new Date().toISOString(),
    sources: enabled.map((a) => a.sourceName),
    tournaments: merged,
  });
  writeTournamentsArtifacts({
    outDir: resolve(process.cwd(), opts.outDir),
    dataset,
    report: report.build(),
    affectedDecks: report.affectedDecks(),
  });
}

function loadCards(path: string): CardSetT {
  if (!existsSync(path)) throw new Error(`cards.json not found at ${path}`);
  return CardSet.parse(JSON.parse(readFileSync(path, "utf8")));
}

function loadDataset(path: string): DatasetT {
  if (!existsSync(path)) throw new Error(`prior dataset.json not found at ${path}`);
  return Dataset.parse(JSON.parse(readFileSync(path, "utf8")));
}
