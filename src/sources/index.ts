import type { SourceAdapter } from "./types.js";
import { apiLorcana } from "./api-lorcana.js";
import { dreamborn } from "./dreamborn.js";
import { limitless } from "./limitless.js";
import { lorcanaGg } from "./lorcana-gg.js";
import { topdeck } from "./topdeck.js";

/** Adapter registry. `SOURCES` env var (comma-separated) selects which to run.
 *
 * Default scheduled CI sources are pure HTTP/JSON APIs — no HTML
 * scraping, no headless browser, no Cloudflare Turnstile dance.
 *
 * - ``limitlesstcg.com`` — public REST API (50 req / 5 min). Highest
 *   signal-to-noise: standings come with decklists already parsed
 *   by category.
 * - ``lorcana.gg`` — live HTTP via the dotgg API. Fast, no JS
 *   render required.
 * - ``topdeck.gg`` — public REST API, auth via ``TOPDECK_API_KEY``.
 *   Lorcana coverage is currently sparse but the adapter is wired so
 *   future events land automatically. Disabled at runtime when the
 *   secret isn't set.
 * - ``api-lorcana.com`` — third-party mirror of the dreamborn
 *   community deck graph, served as plain unauthenticated JSON.
 *   Replaces ``dreamborn.ink`` in scheduled CI because it returns
 *   the same data without the Cloudflare Turnstile that blocks
 *   GitHub-Actions runner IPs from dreamborn.ink directly. Cards
 *   come pre-resolved as ``<setCode>-<NNN>`` printing ids.
 *
 * Locally-runnable, NOT in scheduled CI (Cloudflare-gated):
 * - ``dreamborn.ink`` — direct community deck repository with the
 *   richest per-deck metadata (pbCode, archetype tags, full
 *   colour palette). Cloudflare 403s the runner IPs even via the
 *   Playwright primed-page fallback, so it's only useful from
 *   residential / self-hosted egress. Kept in the registry so
 *   ``pnpm scrape:tournaments --sources dreamborn.ink ...`` still
 *   works for ad-hoc local backfills; api-lorcana.com covers the
 *   same decks in scheduled runs.
 *
 * Retired adapters (kept here as a note so we don't reintroduce them):
 * - ``inkdecks.com`` — was Playwright-driven; every endpoint sat
 *   behind Cloudflare Turnstile, which now blocks browser-automation
 *   approaches regardless of egress IP (verified 2026-05). Retired
 *   in favour of API-only sources.
 * - ``legacy-cache`` — vendored tarball of the original
 *   lorcana-deck-generator snapshot. Superseded by the live APIs.
 */
export const adapters: readonly SourceAdapter[] = [
  limitless,
  lorcanaGg,
  topdeck,
  apiLorcana,
  dreamborn,
];
