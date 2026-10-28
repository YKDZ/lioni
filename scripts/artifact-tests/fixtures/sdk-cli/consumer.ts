import assert from "node:assert/strict";

import { analyzeQuality, readCompletion, readFacts } from "lioni";

import config from "./lioni.config.ts";

const facts = await readFacts(config);
assert.equal(facts.source.units.length, 2);
assert.equal((await readCompletion(config)).completion.status, "complete");
const quality = await analyzeQuality(config);
assert.equal(quality.status, "complete");
assert.equal(quality.diagnostics.length, 1);
const selected = await readFacts(config, { languages: ["de"] });
assert.deepEqual(
  selected.translations.reads.map(({ language }) => language),
  ["de"],
);
assert.deepEqual(
  (await readCompletion(config, { languages: ["de"] })).completion.scope
    .targetLanguages,
  ["de"],
);
const selectedQuality = await analyzeQuality(config, { languages: ["de"] });
assert.equal(selectedQuality.status, "complete");
assert.equal(selectedQuality.diagnostics.length, 0);
assert.ok(
  selectedQuality.candidates.every(({ language }) => language === "de"),
);
process.stdout.write(JSON.stringify(facts));
