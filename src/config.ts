/**
 * Environment parsing + defaults. See DESIGN.md → "Reliability details".
 *
 * TODO: implement.
 */
export interface ScrapeConfig {
  readonly cardsReleaseTag: string;
  readonly sources: readonly string[];
  readonly perSourceConcurrency: number;
  readonly maxResolutionFailureRate: number;
}

export function loadConfig(_env: NodeJS.ProcessEnv = process.env): ScrapeConfig {
  throw new Error("loadConfig: not yet implemented");
}
