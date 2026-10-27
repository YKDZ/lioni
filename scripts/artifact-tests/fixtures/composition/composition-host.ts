import assert from "node:assert/strict";

import { analyzeQuality, evaluateCompletion, readFacts } from "@lioni/core";

import aggregateConfig, {
  catalogConfig,
  guideConfig,
} from "./composition.config.ts";

const mode = process.argv[2];

async function prepare() {
  const [catalogFacts, guideFacts, facts] = await Promise.all([
    readFacts(catalogConfig),
    readFacts(guideConfig),
    readFacts(aggregateConfig),
  ]);
  assert.equal(catalogFacts.source.units[0]?.key, "catalog:save");
  assert.equal(guideFacts.source.units[0]?.key, "guide:save");
  assert.deepEqual(
    facts.source.units.map(({ key }) => key),
    ["catalog:save", "guide:save"],
  );

  const result = await analyzeQuality(aggregateConfig);
  assert.equal(result.status, "complete");
  assert.equal(result.candidates.length, 2);
  assert.equal(
    result.diagnostics.find(({ checkId }) => checkId === "catalog-numbers")
      ?.handling.status,
    "active",
  );
  assert.equal(
    result.diagnostics.find(({ checkId }) => checkId === "guide-numbers")
      ?.handling.status,
    "active",
  );

  const completionPolicy = aggregateConfig.completion;
  assert.ok(completionPolicy);
  const completion = await evaluateCompletion(facts, completionPolicy);
  assert.equal(
    completion.obligations.find(({ sourceKey }) => sourceKey === "catalog:save")
      ?.status,
    "complete",
  );
  assert.equal(
    completion.obligations.find(({ sourceKey }) => sourceKey === "guide:save")
      ?.status,
    "incomplete",
  );

  process.stdout.write(
    JSON.stringify({
      status: "prepared",
      version: facts.version,
      candidateCount: result.candidates.length,
    }) + "\n",
  );
}

async function observe() {
  const facts = await readFacts(aggregateConfig);
  const guideTarget = facts.translations.records.find(
    ({ translation }) => translation.domain === "guide",
  );
  assert.ok(guideTarget);
  assert.ok("content" in guideTarget.translation);
  assert.equal(guideTarget.translation.content.message, "Sauver");
  process.stdout.write(
    JSON.stringify({
      status: "observed",
      version: facts.version,
      guideChange: "changed",
    }) + "\n",
  );
}

if (mode === "prepare") await prepare();
else if (mode === "observe") await observe();
