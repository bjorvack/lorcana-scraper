# AGENTS.md — lorcana-scraper

## Pre-commit checklist (run before every commit/push)

CI mirrors these exact commands. Skipping them locally means
shipping red commits to `main` and creating noisy "fix lint"
follow-ups. **Always run all three before `git commit`:**

```bash
pnpm lint        # eslint . && prettier --check .
pnpm typecheck   # tsc --noEmit
pnpm test -- --run
```

If lint fails on formatting, fix it with:

```bash
pnpm format      # prettier --write .
```

Then re-run `pnpm lint` to confirm green before committing.

## Why this matters

- The repo's CI workflow (`.github/workflows/ci.yml`) runs
  `pnpm lint` then `pnpm test`. Either failing fails the build.
- Recent regressions on `main` (e.g.
  [run 25915233996](https://github.com/bjorvack/lorcana-scraper/actions/runs/25915233996),
  [run 25915335600](https://github.com/bjorvack/lorcana-scraper/actions/runs/25915335600))
  were single-file prettier-format issues that would have been
  caught by `pnpm lint` locally in under 2 seconds.
- Treat a green `pnpm lint && pnpm typecheck && pnpm test --
  --run` as a **required** precondition for `git push`, the
  same way a passing build is.

## Verification commands (reference)

| Step | Command | What it catches |
|---|---|---|
| Lint | `pnpm lint` | ESLint rules + Prettier formatting |
| Format fix | `pnpm format` | Auto-fixes Prettier issues |
| Typecheck | `pnpm typecheck` | TS compile errors (no emit) |
| Tests | `pnpm test -- --run` | Vitest unit suite |
| Build | `pnpm build` | tsup bundle (only needed when changing build) |

## Live smoke (optional, for adapter changes)

When touching `src/sources/*` or pipeline code:

```bash
pnpm scrape:tournaments \
  --cards ./out/cards.json \
  --cards-release-tag cards-v0 \
  --sources <source-name> \
  --max-tournaments 1 \
  --out /tmp/smoke
```

Verifies the adapter still talks to the live API and resolves
cards before pushing.
