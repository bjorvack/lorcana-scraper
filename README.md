# lorcana-scraper

Owns two release streams that the rest of the Lorcana deckbuilder pipeline
consumes:

- **`cards-vN`** — monthly snapshot of the Lorcana card pool from Lorcast.
- **`tournaments-vN`** — periodically scraped tournament decks resolved
  against a pinned `cards-vN`.

See [`DESIGN.md`](./DESIGN.md) for the full spec.

## Status

Skeleton only. File layout follows DESIGN.md. Implementation pending.

## Develop

```bash
pnpm install
pnpm typecheck
pnpm test
```
