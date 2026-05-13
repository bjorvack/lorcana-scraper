import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { LorcastApiCardT } from "@bjorvack/lorcana-schemas";
import { buildCardSet } from "../../src/cards/build.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const raw: LorcastApiCardT[] = JSON.parse(
  readFileSync(resolve(__dirname, "fixtures/lorcast.sample.json"), "utf8"),
);

const FETCHED_AT = "2025-01-01T00:00:00.000Z";

describe("buildCardSet", () => {
  it("produces a sorted, hash-stamped CardSet", () => {
    const cs = buildCardSet(raw, { fetchedAt: FETCHED_AT });
    expect(cs.cards.length).toBe(2);
    expect(cs.cards[0]!.id).toBe("crd_aaa");
    expect(cs.cards[1]!.id).toBe("crd_bbb");
    expect(cs.cardSetVersion).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(cs.fetchedAt).toBe(FETCHED_AT);
  });

  it("is deterministic across reorderings of the input", () => {
    const a = buildCardSet(raw, { fetchedAt: FETCHED_AT });
    const b = buildCardSet([...raw].reverse(), { fetchedAt: FETCHED_AT });
    expect(b.cardSetVersion).toBe(a.cardSetVersion);
  });

  it("rejects an unmappable Lorcast card", () => {
    const broken = [{ ...raw[0]!, ink: "Rainbow", inks: null }];
    expect(() => buildCardSet(broken as LorcastApiCardT[], { fetchedAt: FETCHED_AT })).toThrow();
  });
});
