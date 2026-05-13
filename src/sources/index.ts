import type { SourceAdapter } from "./types.js";
import { lorcanaGg } from "./lorcana-gg.js";

/** Adapter registry. `SOURCES` env var (comma-separated) selects which to run. */
export const adapters: readonly SourceAdapter[] = [lorcanaGg];
