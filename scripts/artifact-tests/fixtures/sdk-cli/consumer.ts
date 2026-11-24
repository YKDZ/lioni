import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  runQa,
  createQualityProfiler,
  createNumberChecker,
  defineChecker,
  readProjectSnapshot,
  StandardSchemaContractError,
} from "@lioni/lioni";
import { createDirectoryQualityCheckResultCache } from "@lioni/lioni/node";
import * as z from "zod";

import config, { createConfig } from "./lioni.config.ts";

const snapshot = await readProjectSnapshot(config);
assert.equal(snapshot.source.units.length, 2);
assert.equal(snapshot.source.read.status, "complete");
assert.deepEqual(
  snapshot.translations.records.map(({ language, record, identity }) => ({
    language,
    id: record.id,
    identity,
  })),
  [
    {
      language: "fr",
      id: "catalog",
      identity: { language: "fr", key: "catalog" },
    },
    {
      language: "fr",
      id: "guide",
      identity: { language: "fr", key: "guide" },
    },
    {
      language: "de",
      id: "catalog",
      identity: { language: "de", key: "catalog" },
    },
    {
      language: "de",
      id: "guide",
      identity: { language: "de", key: "guide" },
    },
  ],
);
assert.deepEqual(
  snapshot.associations.map(
    ({ sourceKey, language, status, coverageStatus, translationIndexes }) => ({
      sourceKey,
      language,
      status,
      coverageStatus,
      translationIndexes,
    }),
  ),
  [
    {
      sourceKey: "catalog",
      language: "fr",
      status: "matched",
      coverageStatus: "complete",
      translationIndexes: [0],
    },
    {
      sourceKey: "guide",
      language: "fr",
      status: "matched",
      coverageStatus: "complete",
      translationIndexes: [1],
    },
    {
      sourceKey: "catalog",
      language: "de",
      status: "matched",
      coverageStatus: "complete",
      translationIndexes: [2],
    },
    {
      sourceKey: "guide",
      language: "de",
      status: "matched",
      coverageStatus: "complete",
      translationIndexes: [3],
    },
  ],
);
const quality = await runQa(config);
assert.equal(quality.status, "complete");
assert.equal(quality.diagnostics.length, 1);
const defaultNumberConfig = {
  ...config,
  quality: { ...config.quality, checks: [createNumberChecker()] },
};
const defaultNumberQuality = await runQa(defaultNumberConfig, {
  candidates: [
    { sourceKey: "catalog", language: "fr", content: "Enregistrer 2 fichiers" },
  ],
});
assert.equal(defaultNumberQuality.status, "complete");
assert.deepEqual(defaultNumberQuality.diagnostics, []);
const qualityCheck = quality.checks[0];
assert.ok(qualityCheck);
const execution = qualityCheck.executions[0];
assert.ok(execution?.inputFingerprint);
assert.deepEqual(Object.keys(execution?.fingerprintSummary ?? {}).sort(), [
  "inputFingerprint",
  "version",
]);
const cacheDirectory = await mkdtemp(
  path.join(os.tmpdir(), "lioni-artifact-cache-"),
);
try {
  const cachedConfig = () => ({
    ...config,
    quality: {
      ...config.quality,
      resultCache: createDirectoryQualityCheckResultCache(cacheDirectory),
    },
  });
  assert.deepEqual(await runQa(cachedConfig()), quality);
  assert.deepEqual(await runQa(cachedConfig()), quality);
} finally {
  await rm(cacheDirectory, { recursive: true, force: true });
}
const selected = await readProjectSnapshot(config, { languages: ["de"] });
assert.deepEqual(
  selected.translations.reads.map(({ language }) => language),
  ["de"],
);
const selectedQuality = await runQa(config, { languages: ["de"] });
assert.equal(selectedQuality.status, "complete");
assert.equal(selectedQuality.diagnostics.length, 0);
assert.ok(
  selectedQuality.candidates.every(({ language }) => language === "de"),
);
process.stdout.write(JSON.stringify(snapshot));

const profiler = createQualityProfiler({ slowestCandidates: 1 });
assert.deepEqual(await runQa(config, { profiler }), quality);
const evidence = profiler.report();
assert.equal(evidence.status, "completed");
assert.ok(evidence.totalMs >= 0);
assert.deepEqual(JSON.parse(JSON.stringify(evidence)), evidence);
assert.ok(
  evidence.checks.every((check) => check.slowestCandidates.length <= 1),
);
const interrupted = createQualityProfiler();
const invalidDependencyData = () => {
  const value: Record<string, unknown> = {};
  value.self = value;
  return value;
};
const configForInvalidData = createConfig();
const configuredQuality = configForInvalidData.quality ?? { checks: [] };
const invalidDataConfig = {
  ...configForInvalidData,
  quality: {
    ...configuredQuality,
    checks: [
      ...(configuredQuality.checks ?? []),
      defineChecker({
        id: "artifact/invalid-quality-data",
        version: "1",
        inputSchema: z.string(),
        load: ({ qualityData }) => qualityData.read(invalidDependencyData),
        prepare: () => "",
        check: () => ([]),
      }),
    ],
  },
};
await assert.rejects(
  runQa(invalidDataConfig, { profiler: interrupted }),
  (error: unknown) =>
    error instanceof StandardSchemaContractError &&
    error.kind === "invalid-json",
);
assert.equal(interrupted.report().status, "interrupted");
