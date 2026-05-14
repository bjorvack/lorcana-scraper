import type { SourceAdapter } from "./types.js";
import { legacyCache } from "./legacy-cache.js";
import { lorcanaGg } from "./lorcana-gg.js";

/** Adapter registry. `SOURCES` env var (comma-separated) selects which to run.
 *
 * ``legacyCache`` is a static, read-only seed of historical tournaments
 * imported from the original ``lorcana-deck-generator`` project. It
 * runs in milliseconds and produces no network traffic, so listing it
 * first means a fresh dataset always carries the legacy seed even if
 * a live HTTP source is rate-limited or down.
 */
export const adapters: readonly SourceAdapter[] = [legacyCache, lorcanaGg];
