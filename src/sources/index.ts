import type { SourceAdapter } from "./types.js";
import { inkdecks } from "./inkdecks.js";

/** Adapter registry. SOURCES env (comma-separated) selects which to run. */
export const adapters: readonly SourceAdapter[] = [inkdecks];
