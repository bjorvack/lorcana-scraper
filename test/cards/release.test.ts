import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CardSetT } from "@bjorvack/lorcana-schemas";
import { cardsReleaseTag, writeCardsArtifacts } from "../../src/cards/release.js";

const emptySet: CardSetT = {
  cardSetVersion: "sha256:" + "0".repeat(64),
  fetchedAt: "2025-01-01T00:00:00.000Z",
  cards: [],
};

describe("writeCardsArtifacts", () => {
  it("writes cards.json, sha256, and diff.md with consistent content hash", () => {
    const dir = mkdtempSync(join(tmpdir(), "cards-test-"));
    const written = writeCardsArtifacts({
      outDir: dir,
      cardSet: emptySet,
      diffMarkdown: "# Cards diff\n",
    });
    const bytes = readFileSync(written.cardsJsonPath, "utf8");
    expect(JSON.parse(bytes).cards).toEqual([]);
    expect(readFileSync(written.cardsJsonSha256Path, "utf8").trim()).toBe(written.contentHash);
    expect(readFileSync(written.cardsDiffPath, "utf8")).toContain("Cards diff");
  });
});

describe("cardsReleaseTag", () => {
  it("formats date + sequence", () => {
    const tag = cardsReleaseTag(new Date(Date.UTC(2025, 4, 13)), 1);
    expect(tag).toBe("cards-v2025.05.13-01");
  });
});
