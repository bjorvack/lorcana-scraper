/**
 * Materialise a cards-vN release artifact set into a directory.
 *
 *   <outDir>/
 *     cards.json           — the CardSet (validated upstream)
 *     cards.json.sha256    — sha256 of cards.json, for content-pin verification
 *     cards-diff.md        — human-readable diff vs prior
 *
 * The tag format is `cards-v<YYYY.MM.DD>-<NN>` where NN is the same-day
 * sequence number provided by the caller. The release file content is the
 * sole source of truth; the tag is just the human-readable handle.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CardSetT } from "@bjorvack/lorcana-schemas";

export interface WriteArtifactsInput {
  readonly outDir: string;
  readonly cardSet: CardSetT;
  readonly diffMarkdown: string;
}

export interface WriteArtifactsResult {
  readonly cardsJsonPath: string;
  readonly cardsJsonSha256Path: string;
  readonly cardsDiffPath: string;
  readonly contentHash: string; // sha256 of the literal cards.json bytes
}

export function writeCardsArtifacts(input: WriteArtifactsInput): WriteArtifactsResult {
  mkdirSync(input.outDir, { recursive: true });
  const cardsJson = JSON.stringify(input.cardSet, null, 2) + "\n";
  const hash = createHash("sha256").update(cardsJson, "utf8").digest("hex");

  const cardsJsonPath = resolve(input.outDir, "cards.json");
  const cardsJsonSha256Path = resolve(input.outDir, "cards.json.sha256");
  const cardsDiffPath = resolve(input.outDir, "cards-diff.md");

  writeFileSync(cardsJsonPath, cardsJson, "utf8");
  writeFileSync(cardsJsonSha256Path, hash + "\n", "utf8");
  writeFileSync(cardsDiffPath, input.diffMarkdown, "utf8");

  return { cardsJsonPath, cardsJsonSha256Path, cardsDiffPath, contentHash: hash };
}

/**
 * Produce the human tag for a cards release, using today's UTC date and a
 * caller-supplied sequence number (defaults to `01`).
 */
export function cardsReleaseTag(date = new Date(), sequence = 1): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  const n = String(sequence).padStart(2, "0");
  return `cards-v${y}.${m}.${d}-${n}`;
}
