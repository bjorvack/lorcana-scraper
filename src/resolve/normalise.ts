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
