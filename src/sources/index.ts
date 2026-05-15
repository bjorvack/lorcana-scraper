import type { SourceAdapter } from "./types.js";
import { InkdecksAdapter } from "./inkdecks.js";
import { limitless } from "./limitless.js";
import { lorcanaGg } from "./lorcana-gg.js";

/** Adapter registry. `SOURCES` env var (comma-separated) selects which to run.
 *
 * Ordering is deliberate: cheapest sources first so a partial run
 * still produces useful output.
 *
 * - ``limitlesstcg.com`` — documented public REST API. No
 *   scraping, no Cloudflare; rate-limited at 50 req / 5 min.
 *   Highest signal-to-noise: standings come with decklists
 *   already parsed by category.
 * - ``lorcana.gg`` — live HTTP via the dotgg API. Fast, no JS
 *   render required.
 * - ``inkdecks.com`` — live, headless-chromium-driven (Cloudflare
 *   Turnstile guards every endpoint). Slowest; runs last so a
 *   browser-install failure doesn't block the rest of the pipeline.
 *
 * The historical ``legacy-cache`` adapter (vendored tarball of the
 * original lorcana-deck-generator snapshot) was retired now that
 * ``inkdecks.com`` covers the same data live.
 */
export const adapters: readonly SourceAdapter[] = [limitless, lorcanaGg, new InkdecksAdapter()];
