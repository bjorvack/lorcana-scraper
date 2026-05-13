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
 * Parse a printing id of the form `<setCode>-<NNN>` (e.g. `006-049`),
 * returning the (already-padded) canonical key suitable for `byPrinting`
 * lookup, plus the raw parts.
 *
 * Returns null if the string doesn't match the expected shape.
 */
export function parsePrintingId(raw: string): {
  key: string;
  setCode: string;
  cardNumber: number;
} | null {
  const m = /^(\d{1,4})-(\d{1,4})$/.exec(raw.trim());
  if (!m) return null;
  const setCode = String(Number.parseInt(m[1]!, 10));
  const cardNumber = Number.parseInt(m[2]!, 10);
  return { key: printingKey(setCode, cardNumber), setCode, cardNumber };
}
