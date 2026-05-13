# lorcana-scraper — Design

> Owns two release streams:
> - **`cards-vN`** — monthly snapshot of the Lorcana card pool (with
>   manual triggers for new-set release days), fetched from Lorcast and
>   validated against `lorcana-schemas`.
> - **`tournaments-vN`** — periodically scraped tournament decks, each
>   resolved against a pinned `cards-vN`.
>
> Every other repo (`lorcana-training`, `lorcana-web`) is a read-only
> consumer of these releases.

## Purpose

This repo is a **batch ETL job** with two release streams:

1. **`cards-vN`** — the canonical `CardSet` snapshot. Lorcana ships a
   new set every ~3–4 months, with occasional errata and banlist
   updates in between, so the cards workflow runs **monthly** with a
   manual `workflow_dispatch` trigger for new-set release days.
   Fetched from `api.lorcast.com`, validated against the schema,
   published as a GitHub Release. Everyone downstream (this scraper
   itself, the training pipeline, the web app build) pins to a
   specific `cards-vN`.
2. **`tournaments-vN`** — the `Dataset` of scraped tournament decks.
   Built by listing tournaments from each source, resolving every
   printed card name against a pinned `cards-vN`, validating the
   result, and appending to the previous tournaments release.

Only this repo writes either of those artifacts. The training pipeline
and the web app are read-only consumers.

Two design pressures shape every choice below:

1. **External sites break.** Selectors change, pages move, sites go down,
   rate-limits tighten. The scraper must fail loudly and locally rather
   than silently shipping garbage downstream.
2. **The product wants more data over time.** Today we have one source
   (`inkdecks.com`). Tomorrow we'll want `lorcanito.com`, a Discord
   league, etc. The architecture has to make adding a source *small*.

## Non-goals

- Real-time / streaming scraping. Daily batches are plenty.
- Authoring card data. The scraper resolves card identities against
  Lorcast's API; it never invents fields.
- Storing historical raw HTML. We only persist the structured
  `Tournament` objects.
- A scraping framework. We write thin, source-specific adapters.

---

## High-level flow (tournaments pipeline)

The cards pipeline is documented separately below; this is the
tournaments flow, which depends on a pinned `cards-vN`.

```
                ┌──────────────────┐
                │   schedule (CI)  │
                └────────┬─────────┘
                         ▼
              ┌────────────────────┐
              │ resolve cards-vN   │ ◄── latest, or pinned via env
              │ (download release) │
              └────────┬───────────┘
                       ▼
              ┌────────────────────┐
              │   load source list │ ◄── sources/*.ts
              └────────┬───────────┘
                       ▼
            ┌──────────────────────┐
            │ per-source adapter   │
            │  • list tournaments  │  (HTTP-first, Playwright fallback)
            │  • diff vs. prior    │
            │  • for each new one: │
            │      fetch + parse   │
            └────────┬─────────────┘
                     ▼
         ┌───────────────────────────┐
         │ resolve card names → ids  │ ◄── card index built from cards-vN
         └────────┬──────────────────┘     + aliases.json
                  ▼
         ┌───────────────────────────┐
         │ validate against schemas  │ ◄── @bjorvack/lorcana-schemas
         └────────┬──────────────────┘
                  ▼
         ┌───────────────────────────┐
         │ merge into Dataset        │ ◄── prior tournaments-vN as base
         └────────┬──────────────────┘
                  ▼
         ┌───────────────────────────┐
         │ open PR with bumped tag   │
         └───────────────────────────┘
```

Key properties:
- **HTTP-first.** Every adapter tries plain `fetch` against a sitemap, RSS,
  or JSON endpoint before touching Playwright. Browsers are slow,
  expensive, and easier to detect; we use them only when the source
  genuinely needs JS rendering.
- **Idempotent.** Tournaments are keyed by a stable `tournamentKey`
  (defined per adapter, typically `sourceName + sourceUrl`). The scraper
  refuses to re-process a key that's already in the latest dataset
  release.
- **Append-only.** Each run starts from the latest `Dataset` release,
  appends new tournaments, and publishes the result. Nothing is mutated
  in place.

---

## Stack

| Concern | Choice | Why |
|---|---|---|
| Runtime | Node 20 LTS | Same as `lorcana-web`; pinned via `.nvmrc` and Action setup. |
| Language | TypeScript (strict) | Matches schemas; consumer of `@bjorvack/lorcana-schemas`. |
| HTTP | `undici` (built-in `fetch`) | First-class in Node 20, fast, supports timeouts and retries via interceptors. |
| Browser | `playwright` | Stable selectors, built-in auto-wait, headless-by-default, official Docker image, better tracing than Puppeteer. We do **not** use `puppeteer-extra-plugin-stealth`; if a source needs that level of evasion, we don't scrape it. |
| HTML parsing (HTTP path) | `cheerio` | Cheap when JS rendering isn't required. |
| Concurrency | small in-house pool over `playwright.BrowserContext` | A few contexts (default 3) on one shared `Browser`. Avoids the "one browser per request" anti-pattern. |
| Validation | `@bjorvack/lorcana-schemas` (`zod`) | Single source of truth. |
| Hashing | `node:crypto` | `tournamentKey`, dataset content hash. |
| Compression | `tar` + `zstd` (`@mongodb-js/zstd` or shell `zstd`) | Dataset releases are tarballs. |
| Test | `vitest` + recorded HTTP/HTML fixtures | No network in unit tests. |
| Lint/format | ESLint + Prettier | Same config as schemas. |

Deliberately **not** chosen:
- A scraping framework (Crawlee, Apify). The pipeline is small and the
  surface area is easier to reason about as plain code.
- Puppeteer. Playwright supersedes it for our needs.
- Headed Chromium in CI. Headless is sufficient; if a site requires
  headed mode, we treat that as a "find another data source" signal.

---

## Source adapter pattern

Adding a new tournament site means writing one file. Everything else is
shared infrastructure.

```ts
// src/sources/types.ts
import type { TournamentT } from "@bjorvack/lorcana-schemas";

export interface SourceAdapter {
  /** Stable identifier, e.g. "inkdecks.com". */
  readonly sourceName: string;

  /** Lists tournament keys + URLs available right now. */
  listTournaments(ctx: ScrapeContext): Promise<TournamentRef[]>;

  /** Fetches and parses a single tournament. */
  fetchTournament(ref: TournamentRef, ctx: ScrapeContext): Promise<RawTournament>;
}

export interface TournamentRef {
  tournamentKey: string;   // sha256(sourceName + canonical url)
  sourceUrl: string;
  name?: string;
  date?: string;           // ISO date if visible in the listing
}

/** Intermediate shape — cards are still strings, not ids. */
export interface RawTournament {
  sourceUrl: string;
  name: string;
  date: string;            // ISO date
  decks: RawDeck[];
}

export interface RawDeck {
  placement?: number;
  player?: string;
  inks: string[];          // adapter's best guess, validated later
  cards: { rawName: string; count: number }[];
}
```

Adapter responsibilities **stop** at "string card names". Resolution to
`Card.id` is centralised (see below) so adapters don't each ship their
own fuzzy-match code.

`src/sources/index.ts` exports an array of registered adapters. A
`SOURCES` env var (comma-separated) selects which to run; default is all.

### v1 adapters

- `src/sources/inkdecks.ts` — port of the existing scraper, simplified
  and on Playwright. Sniff for `inkdecks.com/api/...` JSON endpoints
  before falling back to HTML.

Future adapters (`lorcanito.com`, `dreamborn.ink`, …) are out of scope
for v1 but the interface above is what they'll implement.

---

## Card name resolution

The single dirtiest part of the pipeline. Source sites display cards as
`"Mickey Mouse - Brave Little Tailor"`, sometimes `"Mickey Mouse"` (no
version), sometimes with set codes appended, occasionally misspelled.
Resolution lives in **one** module so the rules are visible.

`src/resolve/cardIndex.ts` builds, on each run, an in-memory index over
the current Lorcast snapshot:

```ts
interface CardIndex {
  byExact: Map<string, CardT>;          // "Mickey Mouse - Brave Little Tailor"
  byNameVersion: Map<string, CardT[]>;  // "mickey mouse" → all printings
  byNormalised: Map<string, CardT>;     // accent-stripped, lowercased, punctuation-stripped
}
```

Resolution strategy, in order:

1. Exact match on `name - version`.
2. Match on the normalised key (`normaliseKey("Mîckey-Mouse")` =
   `"mickey mouse"`).
3. Single-version disambiguation: if the source gave only a name and the
   name has exactly one printing, use it.
4. Hand-maintained `aliases.json` (e.g. `"Maleficent — Dragon Form": "…"`).
   This file lives in the repo and is the **only** acceptable place for
   manual overrides.
5. Otherwise: emit a `resolution-failure` event and **drop the entire
   deck** from the output, not just the card. A partial deck with a
   missing card is worse-than-useless training data.

Resolution failures are aggregated and logged at the end of the run with
counts per `rawName`. If the failure rate for any single source exceeds
**1%** of cards (configurable), the run **fails CI**. This is the
canary that catches Lorcast schema changes and source-site changes.

A small `aliases.json` schema:

```jsonc
[
  {
    "from": "Maleficent - Dragon Form",
    "to": "crd_abc123…",
    "reason": "Source site uses old subtitle. Verified 2025-04-01."
  }
]
```

Aliases are reviewed on PR like any other change.

---

## Card snapshot pipeline

The card snapshot is the simpler of the two pipelines, but it's the
foundation: every tournaments run, every training run, and every web
build pins to one of its outputs.

### Flow

```
   schedule (monthly)             manual workflow_dispatch
   (1st of month, 04:00 UTC)      (run on new-set release days)
          │                                │
          └──────────────┬─────────────────┘
                         ▼
         ┌──────────────────────────────┐
         │  fetch all cards from        │
         │  api.lorcast.com (paginated) │
         └────────────┬─────────────────┘
                      ▼
         ┌──────────────────────────────┐
         │  mapLorcastToCard() per row  │ ◄── shared mapper from
         └────────────┬─────────────────┘     @bjorvack/lorcana-schemas
                      ▼
         ┌──────────────────────────────┐
         │  Card.parse() every row;     │
         │  fail run on any rejection   │
         └────────────┬─────────────────┘
                      ▼
         ┌──────────────────────────────┐
         │  canonicalise + sort;        │
         │  hashCardSet() → version     │
         └────────────┬─────────────────┘
                      ▼
         ┌──────────────────────────────┐
         │  diff vs. previous cards-vN  │
         └────────────┬─────────────────┘
                      ▼
              (changes?) ─── no ──► exit 0, no PR
                      │
                      ▼
         ┌──────────────────────────────┐
         │  open PR with cards-diff.md  │
         └──────────────────────────────┘
```

### Output

A `cards-vN` release contains:
- `cards.json` — a `CardSet` (validated by `CardSet.parse`).
- `cards.json.sha256` — content hash. This is `CardSet.cardSetVersion`.
- `cards-diff.md` — added / removed / changed cards vs. the prior release.

### Versioning

Card snapshots use `cards-vYYYY.MM.DD-NN` (date-based, with a sequence
number for same-day reruns). They are *not* semver: every release is by
definition compatible — only the data inside changes. The
`cardSetVersion` hash is what downstream artifacts pin to; the tag is
just the human-readable name of that hash.

### Workflow

`.github/workflows/cards.yml`:
- Cron: `0 4 1 * *` (1st of every month, 04:00 UTC). Manual
  `workflow_dispatch` for new-set release days, which is where the real
  value lives — the monthly run is a safety net to catch errata /
  banlist changes between sets.
- Steps:
  1. Fetch all cards from Lorcast (one request per cost bucket, same as
     today, with retries).
  2. `mapLorcastToCard` + `Card.parse` every row. Fail on any rejection
     (this is the canary for Lorcast schema changes).
  3. Sort, canonicalise, hash.
  4. Download the previous `cards-vN`. Diff.
  5. If unchanged → exit 0, no PR.
  6. Otherwise → open a PR updating `RELEASES.md` and committing
     `cards-diff.md` for review. Merging the PR triggers
     `cards-release.yml`, which publishes the GitHub Release.

The diff PR is the safety net: a Lorcast bug that suddenly removes 200
cards shows up as a 200-line `cards-diff.md` no human will approve.

### Consumption

Inside this repo, every tournaments run starts by resolving the *latest*
`cards-vN` (configurable via `CARDS_RELEASE_TAG` env, default `latest`).
The card index is built from that snapshot; the resulting
`tournaments-vN` release records `cardSetVersion` in its metadata so
downstream consumers know which `cards-vN` it was resolved against.

`lorcana-training` and `lorcana-web` each pin a `CARDS_RELEASE_TAG` in
their own config; bumping it is a reviewed PR in those repos.

---

## Caching and incremental runs

Each tournaments run pulls the latest `tournaments-vN` release from this
repo and treats it as the base:

```
prior = downloadLatestRelease()
prior.tournaments → set of tournamentKeys
```

For each adapter:
1. `listTournaments()` returns refs.
2. Filter to refs whose `tournamentKey` is not in the prior set.
3. Fetch + parse those.
4. Resolve cards.
5. Append.

If no new tournaments materialise, the run exits early with a `"no
changes"` status and **does not open a PR**. This keeps the noise floor
low.

A small `cache/` directory (gitignored, cleared between runs in CI) holds
intermediate HTML/JSON for debugging when a run fails. CI uploads it as
an artifact on failure.

---

## Output: the `Dataset` release artifact

Every successful run that produces new tournaments publishes:

- `dataset.json` — the full `Dataset` object (validated against
  `Dataset.parse` from `lorcana-schemas`).
- `dataset.json.sha256` — hash of the file, for downstream pinning.
- `resolution-report.json` — per-source stats: tournaments seen,
  decks parsed, cards resolved, failures by `rawName` and count. Useful
  to triage future failures.
- `tournaments-vN.tar.zst` — tarball containing the three above, the
  primary release asset.

Versioning: `tournaments-v1.0.0`, `tournaments-v1.1.0`, etc. The minor
bumps every time tournaments are appended; major bumps if the underlying
schema major changes.

Releases are created via the GitHub API in CI, with the release notes
auto-generated from the `resolution-report.json`:

```
## tournaments-v1.42.0

Added 14 tournaments (208 decks, 12480 cards).
Sources: inkdecks.com.

Card resolution failure rate: 0.2% (24 / 12480).
Top unresolved names:
  - "Maleficent - Dragon" (8)
  - "Mickey Mouse - Brave" (6)
  …
```

---

## CI / scheduling

Five workflows. The `cards.yml` / `cards-release.yml` pair is documented
under "Card snapshot pipeline" above; the three below are for the
tournaments stream and lint/test gates.

### `scrape.yml` — scheduled run

- Cron: `0 */6 * * *` (every 6 hours). Hourly was overkill; tournaments
  publish in bursts, not continuously.
- Manual `workflow_dispatch` trigger for re-runs.
- Steps:
  1. Checkout, set up Node 20, install pnpm.
  2. `pnpm install --frozen-lockfile`.
  3. `pnpm playwright install --with-deps chromium`. Cached.
  4. Determine latest prior release tag (`gh release list`).
  5. Download `tournaments-<latest>.tar.zst`, extract `dataset.json`.
  6. `pnpm scrape --base ./prior/dataset.json --out ./out`.
  7. If `out/changes.flag` is missing → exit 0 with status `"no changes"`.
  8. Otherwise:
     - Open a **PR** (branch `scrape/tournaments-<new-version>`) updating
       a single file `RELEASES.md` with the new version and report
       summary. The PR body is the auto-generated notes.
     - The PR is what triggers release publication on merge (see
       `release.yml`).

Why a PR instead of direct push: it gives a human-reviewable diff of the
report when something looks off (e.g. failure rate jumped), and keeps
`main` clean. Per Q3 the tournaments PR is manual-merge for v1; once
metric thresholds are calibrated we enable GitHub's native auto-merge
for runs whose `resolution-report.json` lands inside the bands.

### `release.yml` — release publication

- Triggered on merge of a `scrape/*` PR.
- Re-runs the scrape against the prior tag, produces the same artifacts,
  publishes them as a GitHub Release with tag `tournaments-vX.Y.Z`.
- Hash-pins so the artifact bytes match what was reviewed in the PR
  (the PR body includes `dataset.json.sha256`; release.yml fails if the
  freshly generated hash differs).

### `ci.yml` — every PR / push

- Lint, typecheck, test.
- Schema-pin assertion: `node scripts/check-schema-major.ts` verifies
  the installed `@bjorvack/lorcana-schemas` major matches `EXPECTED_SCHEMA_MAJOR`
  in `src/version.ts`. Mismatch → red.
- Unit tests run adapters against checked-in HTML/JSON fixtures.
  Network is forbidden (`mocked-fetch` strict mode).

---

## File layout

```
lorcana-scraper/
├── DESIGN.md
├── README.md
├── package.json
├── tsconfig.json
├── .nvmrc
├── pnpm-lock.yaml
├── src/
│   ├── index.ts                # CLI entry: pnpm scrape
│   ├── version.ts              # EXPECTED_SCHEMA_MAJOR
│   ├── config.ts               # env parsing, defaults
│   ├── context.ts              # ScrapeContext (logger, http, browserPool, cardIndex)
│   ├── http/
│   │   ├── client.ts           # undici wrapper: timeouts, retries, UA, rate limit
│   │   └── browserPool.ts      # tiny Playwright pool
│   ├── sources/
│   │   ├── types.ts
│   │   ├── index.ts            # registry
│   │   └── inkdecks.ts
│   ├── resolve/
│   │   ├── cardIndex.ts
│   │   ├── normalise.ts
│   │   ├── aliases.ts
│   │   └── aliases.json
│   ├── pipeline/
│   │   ├── run.ts              # tournaments orchestrator: list→fetch→resolve→validate→merge
│   │   ├── merge.ts
│   │   ├── report.ts
│   │   └── release.ts          # tarball + sha256
│   ├── cards/
│   │   ├── fetch.ts            # paginated Lorcast fetch with retries
│   │   ├── build.ts            # mapLorcastToCard + Card.parse + sort + hash
│   │   ├── diff.ts             # diff vs. prior cards-vN → cards-diff.md
│   │   └── release.ts          # cards release artifact builder
│   └── logging.ts              # structured (pino), JSON lines
├── test/
│   ├── sources/inkdecks.test.ts
│   ├── resolve/cardIndex.test.ts
│   ├── pipeline/merge.test.ts
│   └── fixtures/
│       ├── inkdecks/
│       │   ├── tournament-list.html
│       │   └── tournament-detail-001.html
│       ├── lorcast/cards.snapshot.json
│       └── prior-dataset.json
├── cache/                      # gitignored
└── .github/workflows/
    ├── ci.yml
    ├── cards.yml                # monthly + manual: produce cards-vN PR
    ├── cards-release.yml        # on merge of cards PR: publish release
    ├── scrape.yml               # 6-hourly: produce tournaments-vN PR
    └── release.yml              # on merge of tournaments PR: publish release
```

---

## Reliability details

- **Timeouts.** Per-request 15 s, per-tournament 60 s, per-run 30 min
  hard cap. CI job timeout 45 min.
- **Retries.** `undici` interceptor: 3 attempts, exponential backoff,
  jitter, retry only on 5xx / network errors / 429 (with `Retry-After`
  respected).
- **Concurrency.** Default 3 simultaneous tournament fetches per source.
  Configurable per source via `sources/<name>.ts`.
- **Politeness.** Default 500 ms minimum gap between requests to the
  same host, overridable per source. A common `User-Agent` identifies
  the scraper:
  `"lorcana-scraper/<version> (+https://github.com/bjorvack/lorcana-scraper)"`.
- **Failure budgets.**
  - Card resolution failure > 1%: run fails.
  - Adapter throws on > 20% of tournaments: run fails.
  - Adapter returns zero tournaments: warning, not failure (sites can
    legitimately have empty days).
- **Determinism.** Sort all output arrays by stable keys before
  hashing/serialising so the same input always produces the same bytes.

---

## Local development

```
pnpm install
pnpm playwright install chromium
# Run a single source against a single tournament URL, no PR, no release
pnpm scrape:dev --source inkdecks --url https://inkdecks.com/tournaments/xyz
```

`scrape:dev` runs everything except the release step, writes results to
`out/`, and prints the resolution report. There is no separate dev/prod
adapter code path — only the orchestration around it differs.

---

## Observability

- Structured JSON logs via `pino` to stdout. CI captures them.
- `resolution-report.json` is committed to the PR for human review.
- On failure, CI uploads:
  - `cache/` (raw HTML, partial JSON),
  - `out/resolution-report.partial.json`,
  - Playwright traces (`trace.zip`) for the failing tournaments.
- A small Slack/Discord webhook (optional) posts the run summary. Off
  by default; webhook URL via repo secret if you want it.

---

## Open questions to resolve before implementing

1. **Source coverage at launch.** *Decided: build the `inkdecks.com`
   adapter end-to-end, do one real production run, then evaluate.* If
   that run yields enough tournaments to make a healthy v1 dataset
   (rough bar: ≥ 200 distinct tournament-decks after dedup), we ship
   v1 single-sourced and revisit. If the volume looks thin, we add a
   second adapter before publishing v1.0.0. The adapter interface is
   designed so adding a second source is one reviewed PR; the
   cross-source deduplication question (item 5 below) only becomes
   real once we actually pick a second source, so we defer it.
2. **Lorcast snapshotting.** *Decided: the scraper owns the canonical
   card snapshot.* A separate scheduled workflow in this repo fetches
   Lorcast on a daily cadence and publishes a `cards-vN` GitHub Release
   containing a `CardSet` payload (see `lorcana-schemas`). Every
   downstream consumer pins to a specific `cards-vN`:
   - `lorcana-scraper` itself, when building its card index for name
     resolution.
   - `lorcana-web`, at build time, baking `cards.json` into the bundle.
   - `lorcana-training`, when constructing the vocab and embeddings.

   This makes `ModelManifest.cardSetVersion` enforceable end to end:
   a model trained against `cards-v17` will only run in a web bundle
   built from `cards-v17`. See the "Card snapshot pipeline" section
   below.
3. **PR-then-release vs. direct release.** *Decided: staged.*
   - **Cards pipeline:** PR-then-merge **forever**. A bad `cards-vN`
     poisons every downstream artifact (training data, model vocab,
     web bundle), and the cadence is low enough (monthly + occasional
     manual) that one PR a month is not a burden. Never auto-merged.
   - **Tournaments pipeline:** PR-then-merge for v1 (no auto-merge).
     After ~2 weeks of real runs we calibrate metric thresholds
     (resolution-failure rate, new-tournament count, removed-card
     count, etc.) and enable GitHub auto-merge on PRs whose
     `resolution-report.json` is inside those bands. Anything outside
     waits for a human. Threshold values get checked in to the repo
     and reviewed like code.

   In both cases the publication artifact is the GitHub Release, never
   a commit on `main`. `RELEASES.md` is the only file the PR touches.
4. **Historical backfill.** *Decided: one-shot full backfill into
   v1.0.0.* Before the first scheduled run, a maintainer runs
   `scrape:dev --backfill` locally against the full `inkdecks.com`
   archive. Output is reviewed (`resolution-report.json`, a sample of
   decks eyeballed for plausibility) and committed as the
   `tournaments-v1.0.0` release. Every subsequent scheduled run is
   incremental against that base.

   Crucially, **no recency cutoff is applied at the dataset level**.
   Every `Tournament` already carries a `date` field, and the training
   pipeline applies its own per-model recency filter via config
   (e.g. "validator uses everything, generator uses last 12 months").
   Dataset-level truncation is irreversible and conflates two
   different model needs; keeping it as a training-time decision is
   strictly more flexible.

   Failure budgets for the backfill run are the same as a normal
   run (resolution failure > 1% fails, etc.), but with relaxed
   timeouts (per-run cap 4 h instead of 30 min) because the volume
   is one-time.
5. **Tournament deduplication across sources.** *Decided: keep both,
   tag by source.* Every `Tournament` carries `sourceName`, every
   `tournamentKey` includes `sourceName` in its hash input, so the
   same physical event observed by two sources lands as two records
   with two distinct keys. The training pipeline decides whether to
   dedupe, downweight overlapping events, or treat cross-source
   agreement as a positive validator signal. That choice is
   reversible; deciding it at scrape time is not.

   Practical consequence: `tournaments-vN.metadata.totals.tournaments`
   counts records, not unique events. When we eventually add a second
   source, the dataset size jumps without the underlying event count
   changing, which is something `resolution-report.json` should call
   out explicitly so it doesn't look like a regression.
6. **Rate-limit ethics.** *Decided: proposed defaults.*
   - Cron: every 6 hours.
   - 500 ms minimum gap between requests to the same host.
   - Identifying user agent:
     `lorcana-scraper/<version> (+https://github.com/bjorvack/lorcana-scraper)`.
   - Respect `robots.txt` (use a small `robots-parser` library; refuse
     to fetch disallowed paths and skip the source entirely if its
     root is disallowed).
   - Two free mitigations on top of the defaults:
     - **Conditional GETs.** Honour `ETag` / `Last-Modified` everywhere
       the source supports them; send `If-None-Match` /
       `If-Modified-Since` to avoid re-downloading unchanged pages.
     - **Stop-on-empty.** If a tournament listing's top N entries
       match those from the previous run, skip detail fetches for
       this source entirely on this run.
   - Open a contact channel with the site owner (issue or email) if
     traffic ever becomes notable, e.g. > 1 000 requests/day.
