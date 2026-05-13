/**
 * Materialise a tournaments-vN artifact set into a directory.
 *
 *   <outDir>/
 *     dataset.json            — the validated `Dataset`
 *     dataset.json.sha256     — sha256 of dataset.json
 *     resolution-report.json  — per-source stats, unresolved counts
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { DatasetT } from "@bjorvack/lorcana-schemas";
import type { ResolutionReport } from "./report.js";

export interface WriteTournamentsArtifactsInput {
  readonly outDir: string;
  readonly dataset: DatasetT;
  readonly report: ResolutionReport;
}

export interface WriteTournamentsArtifactsResult {
  readonly datasetPath: string;
  readonly datasetSha256Path: string;
  readonly reportPath: string;
  readonly contentHash: string;
}

export function writeTournamentsArtifacts(
  input: WriteTournamentsArtifactsInput,
): WriteTournamentsArtifactsResult {
  mkdirSync(input.outDir, { recursive: true });
  const datasetJson = JSON.stringify(input.dataset, null, 2) + "\n";
  const hash = createHash("sha256").update(datasetJson, "utf8").digest("hex");
  const datasetPath = resolve(input.outDir, "dataset.json");
  const datasetSha256Path = resolve(input.outDir, "dataset.json.sha256");
  const reportPath = resolve(input.outDir, "resolution-report.json");
  writeFileSync(datasetPath, datasetJson, "utf8");
  writeFileSync(datasetSha256Path, hash + "\n", "utf8");
  writeFileSync(reportPath, JSON.stringify(input.report, null, 2) + "\n", "utf8");
  return { datasetPath, datasetSha256Path, reportPath, contentHash: hash };
}
