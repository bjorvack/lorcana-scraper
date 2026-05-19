/**
 * Accent-stripped, lowercased, punctuation-stripped key for fuzzy card-name lookup.
 * "Mîckey-Mouse" → "mickey mouse".
 *
 * TODO: finalise rules; mirror in tests.
 */
export function normaliseKey(input: string): string {
  return input
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Bounded Levenshtein distance with early abort.
 *
 * Returns ``max + 1`` as soon as it can prove the true distance
 * exceeds ``max`` — used by the card-name resolver as a last-ditch
 * fuzzy match for cross-source rename drift the static indices
 * don't catch. The early abort keeps the worst-case work per call
 * to roughly ``O(max · min(|a|, |b|))`` rather than the full
 * ``O(|a| · |b|)``, so a per-card resolve against a 3 000-entry
 * catalog stays cheap.
 *
 * Implementation: rolling two-row dynamic programming. We also
 * length-skip up front because if the strings differ in length by
 * more than ``max`` no edit-script can close the gap.
 */
export function levenshtein(a: string, b: string, max: number): number {
  if (max < 0) return 0;
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  // Make ``a`` the shorter string so the inner loop is the shorter
  // dimension. Keeps the row arrays small without changing the result.
  if (a.length > b.length) [a, b] = [b, a];
  const aLen = a.length;
  const bLen = b.length;
  if (aLen === 0) return bLen <= max ? bLen : max + 1;
  // Single row DP. ``prev[j]`` holds the distance between ``a[0..i-1]``
  // and ``b[0..j-1]``; we update in place using ``diag`` to remember
  // the value that would have been ``prev[j-1]`` before the in-place
  // write to ``prev[j]``.
  const prev = new Array<number>(aLen + 1);
  for (let i = 0; i <= aLen; i += 1) prev[i] = i;
  for (let j = 1; j <= bLen; j += 1) {
    let diag = prev[0]!;
    prev[0] = j;
    let rowMin = j;
    const bj = b.charCodeAt(j - 1);
    for (let i = 1; i <= aLen; i += 1) {
      const tmp = prev[i]!;
      const cost = a.charCodeAt(i - 1) === bj ? 0 : 1;
      const v = Math.min(
        prev[i]! + 1, // deletion
        prev[i - 1]! + 1, // insertion
        diag + cost, // substitution / match
      );
      prev[i] = v;
      if (v < rowMin) rowMin = v;
      diag = tmp;
    }
    // Every cell in the next row will be at least ``rowMin`` (each
    // step costs at most 1). If even the smallest current value is
    // already over budget we can bail out.
    if (rowMin > max) return max + 1;
  }
  return prev[aLen]! <= max ? prev[aLen]! : max + 1;
}
