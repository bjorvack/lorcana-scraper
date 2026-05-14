import type { SourceAdapter } from "./types.js";
import { InkdecksAdapter } from "./inkdecks.js";
import { legacyCache } from "./legacy-cache.js";
import { lorcanaGg } from "./lorcana-gg.js";

/** Adapter registry. `SOURCES` env var (comma-separated) selects which to run.
 *
 * Ordering is deliberate: cheapest sources first so a partial run
 * still produces useful output.
 *
 * - ``legacy-cache`` — read-only, in-memory, no network. Always
 *   carries the original ``lorcana-deck-generator`` snapshot.
 * - ``lorcana.gg`` — live HTTP via the dotgg API. Fast, no JS render
 *   required.
 * - ``inkdecks.com`` — live, headless-chromium-driven (Cloudflare
 *   Turnstile guards every endpoint). Slowest; runs last so a
 *   browser-install failure doesn't block the rest of the pipeline.
 */
export const adapters: readonly SourceAdapter[] = [legacyCache, lorcanaGg, new InkdecksAdapter()];
