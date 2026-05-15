import type { SourceAdapter } from "./types.js";
import { limitless } from "./limitless.js";
import { lorcanaGg } from "./lorcana-gg.js";

/** Adapter registry. `SOURCES` env var (comma-separated) selects which to run.
 *
 * Both adapters speak documented HTTP/JSON APIs — no HTML scraping,
 * no headless browser, no Cloudflare Turnstile dance.
 *
 * - ``limitlesstcg.com`` — public REST API (50 req / 5 min). Highest
 *   signal-to-noise: standings come with decklists already parsed
 *   by category.
 * - ``lorcana.gg`` — live HTTP via the dotgg API. Fast, no JS
 *   render required.
 *
 * Retired adapters (kept here as a note so we don't reintroduce them):
 * - ``inkdecks.com`` — was Playwright-driven; every endpoint sat
 *   behind Cloudflare Turnstile, which blocked GitHub-hosted runner
 *   egress IPs nearly every time. Retired in favour of API-only
 *   sources.
 * - ``legacy-cache`` — vendored tarball of the original
 *   lorcana-deck-generator snapshot. Superseded by the live APIs.
 */
export const adapters: readonly SourceAdapter[] = [limitless, lorcanaGg];
