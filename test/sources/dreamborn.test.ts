import { describe, expect, it } from "vitest";

import {
  decodePbCode,
  extractNuxtData,
  parseDeckPage,
  resolveNuxtPayload,
} from "../../src/sources/dreamborn.js";

describe("decodePbCode", () => {
  it("decodes versioned and version-less entries", () => {
    // Real dreamborn pbCode snippet (Woody's Roundup, truncated).
    const pb = Buffer.from(
      "Be Our Guest$2|Woody_Jungle Guide$3|Hamm_Piggy Bank$4|",
      "utf-8",
    ).toString("base64");
    expect(decodePbCode(pb)).toEqual([
      { rawName: "Be Our Guest", count: 2 },
      { rawName: "Woody - Jungle Guide", count: 3 },
      { rawName: "Hamm - Piggy Bank", count: 4 },
    ]);
  });

  it("ignores entries without a $count separator and zero-count entries", () => {
    const pb = Buffer.from("CardWithoutCount|Other$0|Real$2|", "utf-8").toString("base64");
    expect(decodePbCode(pb)).toEqual([{ rawName: "Real", count: 2 }]);
  });

  it("returns [] on garbage base64", () => {
    // Buffer.from with non-base64 chars is lenient — we just need to
    // confirm we don't throw on it.
    expect(decodePbCode("not-base64 ===")).toEqual([]);
  });

  it("only splits on the FIRST underscore (versions can themselves contain underscores indirectly via mojibake)", () => {
    // Defensive: lastIndexOf('$') already protects against names with
    // '$' in them. But the underscore split must be greedy to the
    // first occurrence so a hypothetical "Name_Sub_Title" doesn't
    // become "Name - Sub_Title" -> we always emit single " - ".
    const pb = Buffer.from("Foo_Bar_Baz$1|", "utf-8").toString("base64");
    expect(decodePbCode(pb)).toEqual([{ rawName: "Foo - Bar_Baz", count: 1 }]);
  });
});

describe("resolveNuxtPayload", () => {
  it("dereferences integer-indexed children", () => {
    // Indexed-ref payload representing { foo: "bar" } at index 0.
    const raw: unknown[] = [{ foo: 1 }, "bar"];
    expect(resolveNuxtPayload(raw)).toEqual({ foo: "bar" });
  });

  it("unwraps Ref/Reactive/ShallowReactive wrappers", () => {
    const raw: unknown[] = [{ data: 1 }, ["Reactive", 2], { hello: 3 }, "world"];
    expect(resolveNuxtPayload(raw)).toEqual({ data: { hello: "world" } });
  });

  it("handles cycles without exploding", () => {
    // Self-referential — synthetic but possible. The walker memos
    // visited indices so revisits don't recurse forever.
    const raw: unknown[] = [{ self: 0 }];
    // We don't care that the cycle is represented faithfully; only
    // that the call returns and doesn't blow the stack.
    expect(() => resolveNuxtPayload(raw)).not.toThrow();
  });
});

describe("extractNuxtData / parseDeckPage", () => {
  // Minimal fixture mimicking dreamborn's deck-page SSR shape.
  const id = "DECK1";
  const payload = [
    { data: 1, state: 2 },
    { [id]: 3 },
    { irrelevant: 4 },
    {
      id: 5,
      name: 6,
      creatorName: 7,
      colors: 8,
      pbCode: 9,
      lastUpdated: 10,
      tags: 11,
    },
    "ignored",
    id,
    "My Deck",
    "Alice",
    [12, 13],
    Buffer.from("Bullseye_Loyal Horse$4|", "utf-8").toString("base64"),
    "2026-05-19T00:00:00.000Z",
    { "archetype:competitive": true },
    "amber",
    "ruby",
  ];
  const html = `<!doctype html><script type="application/json" id="__NUXT_DATA__">${JSON.stringify(
    payload,
  )}</script>`;

  it("slices the __NUXT_DATA__ block out of the HTML", () => {
    expect(extractNuxtData(html)?.length).toBeGreaterThan(0);
    expect(extractNuxtData("<html>no data here</html>")).toBeNull();
  });

  it("parses a deck page through the full chain", () => {
    const page = parseDeckPage(id, html);
    expect(page).not.toBeNull();
    expect(page!.name).toBe("My Deck");
    expect(page!.creatorName).toBe("Alice");
    expect(page!.colors).toEqual(["amber", "ruby"]);
    expect(page!.tags["archetype:competitive"]).toBe(true);
    expect(decodePbCode(page!.pbCode!)).toEqual([{ rawName: "Bullseye - Loyal Horse", count: 4 }]);
  });

  it("returns null when the SSR contract drifts (missing deck entry)", () => {
    const empty = `<script type="application/json" id="__NUXT_DATA__">${JSON.stringify([
      { data: 1 },
      {},
    ])}</script>`;
    expect(parseDeckPage(id, empty)).toBeNull();
  });
});
