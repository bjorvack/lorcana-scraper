# lorcana-scraper

Owns the two release streams that feed every other repo in the Lorcana
deckbuilder ecosystem:

- **`cards-vN`** — periodic snapshot of the Lorcana card pool, sourced
  from [Lorcast](https://lorcast.com), validated against
  [`@bjorvack/lorcana-schemas`](https://github.com/bjorvack/lorcana-schemas)
  (`Card` / `CardSet`).
- **`tournaments-vN`** — periodically scraped tournament decklists from
  multiple public APIs, deck-resolved against a pinned `cards-vN`,
  validated against `Tournament` / `Dataset`.

Both are published as GitHub Releases with stable tag schemes that
downstream repos pin against. See [`DESIGN.md`](./DESIGN.md) for the
full architecture.

## Sources

The tournament scraper currently runs three API-only adapters (no HTML
scraping, no headless browser, no Cloudflare Turnstile):

| Source | Endpoint | Auth | Coverage |
|---|---|---|---|
| `lorcana.gg` | `api.dotgg.gg/cgfw/getdecks` (documented) | none | community + small-mid tournaments |
| `limitlesstcg.com` | `play.limitlesstcg.com/api/tournaments/*` | none, 50 req/5min | larger tournaments + championships |
| `topdeck.gg` | `topdeck.gg/api/v2/tournaments` | `TOPDECK_API_KEY` (soft no-op if absent) | sparse Lorcana coverage today, scaffolded for growth |

inkdecks was retired (Cloudflare Turnstile made it unscrapeable). See
[the full source-evaluation matrix](./DESIGN.md#sources) for adapters
investigated and rejected (melee.gg, lorcanahunter, LorcaHub,
api.elorcana.com, …).

## Quick start

```bash
pnpm install
# Refresh the card pool.
pnpm scrape:cards
# Scrape one tournament from lorcana.gg as a smoke test.
pnpm scrape:tournaments \
  --cards ./out/cards.json \
  --cards-release-tag cards-v0 \
  --sources lorcana.gg \
  --max-tournaments 1 \
  --out /tmp/smoke
```

## CLIs

| Script | What it does |
|---|---|
| `pnpm scrape:cards` | Pull the latest Lorcast snapshot, validate, write `out/cards.json` |
| `pnpm scrape:tournaments` | Multi-source tournament scrape with hash-mod sharding + per-tournament file storage |
| `pnpm scrape:legality` | Refresh `banlist-vN` + `rotation-vN` artifacts |
| `pnpm tournaments:merge-shards` | Merge per-source shard artifacts into one `dataset.json` |
| `pnpm tournaments:validate` | Re-run schema + cardId resolution checks against an existing dataset |
| `pnpm tournaments:promote` | Promote a draft `dataset.json` to a versioned release artifact |
| `pnpm tournaments:unresolved` | List card-id resolution failures with context (used during card-pool gaps) |

Run any with `-- --help` for flags.

## Pipeline architecture

```
prepare (cards-vN pin + prior tournaments-vN)
  ├─ scrape-lorcana-gg  ── 4-shard matrix (hash-mod) ──┐
  ├─ scrape-limitless   ── 4-shard matrix (hash-mod) ──┤
  └─ scrape-topdeck     ── 4-shard matrix (hash-mod) ──┤
                                                       ▼
                                                     merge → release
```

Key invariants (see DESIGN.md for rationale):

- **Hash-modulo sharding** (`fnv1a(externalKey) mod N`) — every shard
  walks the full listing and only fetches the standings/decks whose key
  hashes to its bucket. Adding shards scales linearly without
  re-thinking pagination.
- **Per-tournament file storage** — each tournament is written as
  `out/tournaments/<externalKey>.json` so a mid-tournament crash never
  loses prior decks. The merge step globs everything back together.
- **Deck-level merge** — decks union by `Deck.externalKey`
  (`sha256(sourceName + externalUrl)`) so re-runs that pick up extra
  decks for a known tournament don't duplicate or overwrite.
- **`priorSeen` short-circuit** — the orchestrator passes the prior
  dataset's tournament keys into each adapter so already-ingested
  tournaments are skipped before any HTTP request.

## CI / scheduled runs

| Workflow | Trigger | Output |
|---|---|---|
| [`cards.yml`](.github/workflows/cards.yml) | weekly cron + manual | `cards-vN` GitHub Release |
| [`scrape.yml`](.github/workflows/scrape.yml) | hourly cron + manual | `tournaments-vN` GitHub Release |
| [`legality.yml`](.github/workflows/legality.yml) | weekly cron + manual | `banlist-vN` + `rotation-vN` releases |
| [`ci.yml`](.github/workflows/ci.yml) | every push / PR | lint + typecheck + tests |

## Develop

See [`AGENTS.md`](./AGENTS.md) for the (mandatory) pre-commit checklist.

```bash
pnpm install
pnpm lint        # eslint + prettier --check
pnpm typecheck   # tsc --noEmit
pnpm test -- --run
```

## Live smoke after adapter changes

```bash
pnpm scrape:tournaments \
  --cards ./out/cards.json \
  --cards-release-tag cards-v0 \
  --sources <source> \
  --max-tournaments 1 \
  --out /tmp/smoke
```

A green smoke + green CI is the bar for merging adapter changes.
