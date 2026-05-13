import type { CardT } from "@bjorvack/lorcana-schemas";
import { normaliseKey } from "./normalise.js";

/**
 * In-memory index over the pinned `cards-vN` snapshot.
 *
 * For the lorcana.gg adapter only `byPrinting` is consulted (deterministic
 * `<setCode>-<NNN>` → `Card` lookup). The string-based maps are retained
 * for the inevitable future source that emits card names.
 */
export interface CardIndex {
  readonly byPrinting: Map<string, CardT>;
  readonly byExact: Map<string, CardT>;
  readonly byNameVersion: Map<string, CardT[]>;
  readonly byNormalised: Map<string, CardT>;
}

export function buildCardIndex(cards: readonly CardT[]): CardIndex {
  const byPrinting = new Map<string, CardT>();
  const byExact = new Map<string, CardT>();
  const byNameVersion = new Map<string, CardT[]>();
  const byNormalised = new Map<string, CardT>();

  for (const c of cards) {
    byPrinting.set(printingKey(c.setCode, c.cardNumber), c);

    const displayName = c.version ? `${c.name} - ${c.version}` : c.name;
    byExact.set(displayName, c);

    const nv = c.name.toLowerCase();
    const list = byNameVersion.get(nv) ?? [];
    list.push(c);
    byNameVersion.set(nv, list);

    byNormalised.set(normaliseKey(displayName), c);
  }

  return { byPrinting, byExact, byNameVersion, byNormalised };
}

/** Canonical printing key: pads cardNumber to 3 digits. */
export function printingKey(setCode: string, cardNumber: number): string {
  return `${setCode}-${String(cardNumber).padStart(3, "0")}`;
}

/**
 * Parse a printing id from lorcana.gg / api.dotgg.gg.
 *
 * Three shapes show up in real data:
 *   "006-049"        → Card 49 in set 6
 *   "P1-029"         → Card 29 in Promo Set 1 (alphanumeric set codes)
 *   "001-P1-005"     → Legacy three-part form: "P1 promo #5, originally
 *                       cataloged against set 001". We collapse this to
 *                       `P1-005` because Lorcast indexes by the actual
 *                       set the card is printed in (P1 here).
 *
 * Returns null for unrecognised shapes (e.g. "undefined", empty strings,
 * dotgg-only sets `C1`/`Q1`/`Q2` which Lorcast doesn't catalog under those
 * codes — they need a name-based mapper that isn't built yet).
 *
 * Numeric set codes are normalised by stripping leading zeros so the
 * lookup matches `Card.setCode` (which is `"1"` not `"001"`).
 */
export function parsePrintingId(raw: string): {
  key: string;
  setCode: string;
  cardNumber: number;
} | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "undefined" || trimmed === "null") return null;

  // 3-part legacy: <numeric>-<alpha-set>-<num> → collapse to <alpha-set>-<num>
  const three = /^\d{1,4}-([A-Za-z][A-Za-z0-9]*)-(\d{1,4})$/.exec(trimmed);
  if (three) {
    return {
      key: printingKey(three[1]!, Number.parseInt(three[2]!, 10)),
      setCode: three[1]!,
      cardNumber: Number.parseInt(three[2]!, 10),
    };
  }

  // 2-part: <setCode>-<num>
  const two = /^([A-Za-z0-9]+)-(\d{1,4})$/.exec(trimmed);
  if (two) {
    const rawSet = two[1]!;
    const setCode = /^\d+$/.test(rawSet) ? String(Number.parseInt(rawSet, 10)) : rawSet;
    const cardNumber = Number.parseInt(two[2]!, 10);
    return { key: printingKey(setCode, cardNumber), setCode, cardNumber };
  }

  return null;
}
