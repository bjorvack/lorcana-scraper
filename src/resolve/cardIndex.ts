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
 * Parse a printing id of the form `<setCode>-<NNN>` (e.g. `006-049`,
 * `P1-029`, `D23-003`, `cp-007`). Returns null if the input is not in
 * `<setCode>-<digits>` shape (lorcana.gg occasionally emits 3-part ids
 * for reprints/variants which we drop until we have a real example to
 * cross-reference against Lorcast).
 *
 * Numeric set codes are normalised by stripping leading zeros so the
 * lookup matches `Card.setCode` (which is `"1"` not `"001"`).
 */
export function parsePrintingId(raw: string): {
  key: string;
  setCode: string;
  cardNumber: number;
} | null {
  const m = /^([A-Za-z0-9]+)-(\d{1,4})$/.exec(raw.trim());
  if (!m) return null;
  const rawSet = m[1]!;
  const setCode = /^\d+$/.test(rawSet) ? String(Number.parseInt(rawSet, 10)) : rawSet;
  const cardNumber = Number.parseInt(m[2]!, 10);
  return { key: printingKey(setCode, cardNumber), setCode, cardNumber };
}
