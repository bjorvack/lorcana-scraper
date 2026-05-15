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
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
import { InkdecksAdapter } from "../sources/inkdecks.js";
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
import { writeFailedTournament, writeTournamentFile } from "./tournamentStore.js";

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
  /** Shard: lowest listing page to consider (1-based, inclusive). */
  readonly pageFrom?: number;
  /** Shard: highest listing page to consider (inclusive). */
  readonly pageTo?: number;
  /**
   * Hash-modulo sharding (A1). Each shard runs the full listing but
   * only processes refs where `fnv1a(externalKey) mod shardCount ==
   * shardIndex`. Auto-balances regardless of how many tournaments
   * each source has — unlike page-range sharding, which assumed
   * lorcana.gg's API page count and silently dropped half of
   * inkdecks's archive.
   *
   * Default: no filtering (process all refs). Set both shardIndex
   * (0-based) and shardCount (>=1) to enable.
   */
  readonly shardIndex?: number;
  readonly shardCount?: number;
  /**
   * Max tournaments per source per run (top of pagination). Default: unlimited.
   * Either a number (uniform cap) or a `{ name: N, default?: N }` map for
   * per-source caps. Useful when a slow adapter (e.g. inkdecks.com behind
   * Cloudflare Turnstile) would otherwise stall the whole job.
   */
  readonly maxTournaments?: number | Record<string, number>;
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

  // Deck-level seen-set (D1). Adapters consult this before fetching
  // deck content; if the prospective key (sha256(sourceName|url))
  // matches an already-ingested deck, the adapter can short-circuit
  // the deck fetch. Mostly helps when the same deck slug appears in
  // more than one tournament listing, and lays the groundwork for B2
  // / mid-tournament partial-resume.
  const priorDeckKeys = new Set<string>();
  for (const t of prior?.tournaments ?? []) {
    for (const entry of t.decks) {
      if (entry.deck.externalKey) priorDeckKeys.add(entry.deck.externalKey);
    }
  }
  const priorDecksSeen = (k: string): boolean => priorDeckKeys.has(k);

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

  // Pre-write a minimal meta.json so the merge job can pick up shard
  // metadata even if this run dies before any tournament finishes.
  // Re-written at end of run with the final generatedAt timestamp.
  writeShardMeta({ opts, cards, enabled });

  for (const adapter of enabled) {
    report.startSource(adapter.sourceName);
    progress.startSource(adapter.sourceName);
    const sourceCap = resolveMaxFor(adapter.sourceName, opts.maxTournaments);
    if (sourceCap !== undefined) {
      process.stderr.write(`[${adapter.sourceName}] cap: ${sourceCap} tournaments this run\n`);
    }
    // Re-instantiate adapters that accept run-time options.
    const ad = applyAdapterOptions(adapter, {
      priorSeen,
      priorDecksSeen,
      maxPages: opts.maxPages,
      pageFrom: opts.pageFrom,
      pageTo: opts.pageTo,
      deckConcurrency: opts.deckConcurrency,
      maxResults: sourceCap,
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
    const allRefs = await ad.listTournaments({} as never); // context unused for v1
    report.noteListing(adapter.sourceName, allRefs.length);
    process.stderr.write(`[${adapter.sourceName}] listed ${allRefs.length} tournaments\n`);

    // Hash-modulo sharding (A1). With shardCount=N and shardIndex=i,
    // we only own refs whose key hashes to bucket i. The hash is
    // deterministic so the same ref always lands in the same shard
    // (independent of listing order or pagination), guaranteeing
    // every ref is owned by exactly one shard.
    const shardCount = opts.shardCount ?? 1;
    const shardIndex = opts.shardIndex ?? 0;
    const refs =
      shardCount > 1
        ? allRefs.filter((r) => fnv1aBucket(r.tournamentKey, shardCount) === shardIndex)
        : allRefs;
    if (shardCount > 1) {
      process.stderr.write(
        `[${adapter.sourceName}] shard ${shardIndex}/${shardCount}: ${refs.length}/${allRefs.length} refs\n`,
      );
    }

    // No pipeline-level slice: each adapter already obeys `maxResults`
    // and — crucially — only counts NEW (un-seen) refs against that
    // budget, so repeated capped runs eventually walk the whole archive
    // instead of stalling once `prior` covers the listing's head.
    const limited = refs;
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
          // Per-tournament atomic write. Survives crashes / SIGKILL /
          // runner timeouts: whatever we've ingested so far is on disk
          // before we move on to the next ref. The merge job globs
          // these across shards.
          try {
            writeTournamentFile(outDirAbs, tournament);
          } catch (writeErr) {
            // Don't fail the whole run on a single bad write; the
            // periodic dataset.json snapshot is still a backstop.
            process.stderr.write(
              `  ! writeTournamentFile failed for ${ref.tournamentKey}: ${(writeErr as Error).message}\n`,
            );
          }
        }
      } catch (err) {
        // Single-tournament failures are surfaced but don't fail the run.
        const msg = (err as Error).message;
        console.warn(`  ! ${adapter.sourceName} ${ref.tournamentKey}: ${msg}`);
        progress.noteError(msg);
        // Record the failure so re-runs / triage can see what blew up
        // even when no dataset.json snapshot was taken yet.
        try {
          writeFailedTournament(outDirAbs, {
            externalKey: ref.tournamentKey,
            sourceName: adapter.sourceName,
            sourceUrl: ref.sourceUrl,
            attemptedAt: new Date().toISOString(),
            error: msg,
          });
        } catch {
          /* best-effort */
        }
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

/**
 * Resolve the tournaments cap for `sourceName`. Returns `undefined`
 * (no cap) if `spec` is undefined. For map specs we fall back to a
 * `default` bucket if the named source isn't listed.
 */
function resolveMaxFor(
  sourceName: string,
  spec: number | Record<string, number> | undefined,
): number | undefined {
  if (spec === undefined) return undefined;
  if (typeof spec === "number") return spec;
  if (sourceName in spec) return spec[sourceName];
  if ("default" in spec) return spec.default;
  return undefined;
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
    externalKey: externalKey(adapterName, raw.sourceUrl),
    name: raw.name,
    date: raw.date,
    decks,
  });
  return tournament;
}

/** sha256 of `sourceName|<source-specific id>`. Stable across runs. */
function externalKey(sourceName: string, id: string): string {
  return createHash("sha256").update(`${sourceName}|${id}`).digest("hex");
}

/**
 * FNV-1a 32-bit hash modulo `buckets`. Used for hash-modulo
 * sharding — every shard runs the full listing, then keeps only
 * refs whose key falls into its bucket. The hash is deterministic
 * and uniformly distributed, so shards auto-balance regardless of
 * source size or pagination order.
 *
 * Picked over `parseInt(key.slice(0, 8), 16) % n` because the
 * upstream key may be sha256-hex (high entropy, this works fine)
 * or, in the future, something else with lopsided prefix bits.
 */
export function fnv1aBucket(key: string, buckets: number): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % buckets;
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

  // Stable deck key. Prefer the canonical externalUrl, fall back to
  // the source-specific externalId, then a (tournament-url, displayName)
  // composite so adapters that emit neither still get a deterministic
  // key. This is what downstream consumers (training, web) use to skip
  // already-processed decks across re-runs.
  const deckId =
    raw.externalUrl ??
    raw.externalId ??
    `${rawTournament.sourceUrl}#${raw.displayName ?? raw.player ?? ""}`;
  const deck: DeckT = {
    inks: inks as DeckT["inks"],
    cards,
    name: raw.displayName ?? null,
    // Prefer the direct deck URL (lets reviewers click straight through).
    source: raw.externalUrl ?? sourceName,
    externalKey: externalKey(sourceName, deckId),
    ...(raw.externalUrl ? { externalUrl: raw.externalUrl } : {}),
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
    priorDecksSeen?: (k: string) => boolean;
    maxPages?: number;
    pageFrom?: number;
    pageTo?: number;
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
      priorDecksSeen: opts.priorDecksSeen,
      maxPages: opts.maxPages,
      pageFrom: opts.pageFrom,
      pageTo: opts.pageTo,
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
  if (adapter instanceof InkdecksAdapter) {
    return new InkdecksAdapter({
      priorSeen: opts.priorSeen,
      priorDecksSeen: opts.priorDecksSeen,
      pageFrom: opts.pageFrom,
      pageTo: opts.pageTo,
      maxPages: opts.maxPages,
      maxResults: opts.maxResults,
      deckConcurrency: opts.deckConcurrency,
      onTournamentStart: opts.onTournamentStart,
      onDeckFetched: opts.onDeckFetched,
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

/**
 * Persist `<outDir>/meta.json` — the minimum the merge job needs to
 * stitch this shard into the final dataset, even if zero tournaments
 * have finished yet. Idempotent: safe to call repeatedly.
 */
function writeShardMeta(args: {
  opts: RunOptions;
  cards: CardSetT;
  enabled: readonly SourceAdapter[];
}): void {
  const { opts, cards, enabled } = args;
  const outDirAbs = resolve(process.cwd(), opts.outDir);
  try {
    mkdirSync(outDirAbs, { recursive: true });
    const meta = {
      datasetVersion: opts.datasetMeta.datasetVersion,
      schemaVersion: opts.datasetMeta.schemaVersion,
      cardSetVersion: cards.cardSetVersion,
      cardsReleaseTag: opts.datasetMeta.cardsReleaseTag,
      generatedAt: new Date().toISOString(),
      sources: enabled.map((a) => a.sourceName),
    };
    writeFileSync(resolve(outDirAbs, "meta.json"), JSON.stringify(meta, null, 2) + "\n", "utf8");
  } catch (err) {
    process.stderr.write(`[shard-meta] write failed: ${(err as Error).message}\n`);
  }
}

function loadCards(path: string): CardSetT {
  if (!existsSync(path)) throw new Error(`cards.json not found at ${path}`);
  return CardSet.parse(JSON.parse(readFileSync(path, "utf8")));
}

function loadDataset(path: string): DatasetT {
  if (!existsSync(path)) throw new Error(`prior dataset.json not found at ${path}`);
  return Dataset.parse(JSON.parse(readFileSync(path, "utf8")));
}
