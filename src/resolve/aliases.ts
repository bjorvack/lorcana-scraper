/** Hand-maintained alias entries, the only acceptable place for manual overrides. */
export interface AliasEntry {
  readonly from: string;
  readonly to: string;
  readonly reason: string;
}

/** TODO: load + validate aliases.json. */
export function loadAliases(): AliasEntry[] {
  return [];
}
