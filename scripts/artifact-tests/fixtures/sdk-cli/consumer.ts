import assert from "node:assert/strict";

import { analyzeQuality, readFacts } from "@lioni/lioni";

import config from "./lioni.config.ts";

const facts = await readFacts(config);
assert.equal(facts.source.units.length, 2);
assert.equal(facts.source.read.status, "complete");
assert.deepEqual(
  facts.translations.records.map(({ language, translation, identity }) => ({
    language,
    id: translation.id,
    identity,
  })),
  [
    {
      language: "fr",
      id: "catalog",
      identity: { language: "fr", namespace: "catalog", key: "catalog" },
    },
    {
      language: "fr",
      id: "guide",
      identity: { language: "fr", namespace: "catalog", key: "guide" },
    },
    {
      language: "de",
      id: "catalog",
      identity: { language: "de", namespace: "catalog", key: "catalog" },
    },
    {
      language: "de",
      id: "guide",
      identity: { language: "de", namespace: "catalog", key: "guide" },
    },
  ],
);
assert.deepEqual(
  facts.associations.map(
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
const quality = await analyzeQuality(config);
assert.equal(quality.status, "complete");
assert.equal(quality.diagnostics.length, 1);
const selected = await readFacts(config, { languages: ["de"] });
assert.deepEqual(
  selected.translations.reads.map(({ language }) => language),
  ["de"],
);
const selectedQuality = await analyzeQuality(config, { languages: ["de"] });
assert.equal(selectedQuality.status, "complete");
assert.equal(selectedQuality.diagnostics.length, 0);
assert.ok(
  selectedQuality.candidates.every(({ language }) => language === "de"),
);
process.stdout.write(JSON.stringify(facts));
