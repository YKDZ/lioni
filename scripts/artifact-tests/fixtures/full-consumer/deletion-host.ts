import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  advanceProcessingBaseline,
  applyUpdatePlan,
  createUpdatePlan,
  readFacts,
} from "@lioni/core";
import {
  createFileProcessingBaselineStore,
  createFileUpdatePlanStore,
} from "@lioni/core/node";

import config from "./deletion.config.ts";
import { parseJson } from "./schemas.ts";

type DeletionTranslation = {
  readonly id: string;
  readonly text: string;
  readonly context: {
    readonly file: string;
    readonly key: string;
    readonly readonly?: boolean;
  };
};
type TranslationResource = {
  readonly records: readonly DeletionTranslation[];
};

async function readResource(file: string): Promise<TranslationResource> {
  return parseJson<TranslationResource>(await readFile(file, "utf8"));
}

const scenario = process.argv[2];
const sourcePath = fileURLToPath(
  new URL("./deletion-resources/source.json", import.meta.url),
);
const targetPath = fileURLToPath(
  new URL("./deletion-resources/fr.json", import.meta.url),
);
const otherTargetPath = fileURLToPath(
  new URL("./deletion-resources/other.json", import.meta.url),
);
const baselinePath = ".lioni/deletion-baseline.json";
const planPath = ".lioni/deletion-plan.json";
const baselineStore = createFileProcessingBaselineStore(baselinePath);
const planStore = createFileUpdatePlanStore(planPath);

if (scenario === "initialize") {
  const result = await advanceProcessingBaseline(
    baselineStore,
    await readFacts(config),
    [{ sourceKey: "retired-message", language: "fr" }],
    config,
  );
  assert.equal(result.outcome, "saved");
  assert.equal(result.selections[0]?.outcome, "advanced");
} else if (scenario === "save-plan") {
  const before = await Promise.all([
    readFile(sourcePath),
    readFile(targetPath),
    readFile(otherTargetPath),
    readFile(baselinePath),
  ]);
  const facts = await readFacts(config);
  const plan = await createUpdatePlan(
    facts,
    await baselineStore.load(),
    config,
  );
  const item = plan.items.find(
    ({ sourceKey }) => sourceKey === "retired-message",
  );
  assert.equal(item?.change, "source-removed");
  assert.equal(item?.expectedInput?.source.presence, "removed");
  assert.equal(item?.decision.action, "delete");
  assert.equal(item?.status, "delete");
  assert.equal(item?.edit?.operation, "delete");
  assert.equal(Object.hasOwn(item?.edit ?? {}, "content"), false);
  assert.equal("value" in (item?.expectedInput?.source ?? {}), false);
  assert.equal(item?.edit?.expected.source.presence, "removed");
  await planStore.save(plan);
  assert.deepEqual(
    await Promise.all([
      readFile(sourcePath),
      readFile(targetPath),
      readFile(otherTargetPath),
      readFile(baselinePath),
    ]),
    before,
  );
} else if (scenario === "read-plan") {
  const plan = await planStore.load();
  assert.ok(plan);
  const item = plan.items.find(
    ({ sourceKey }) => sourceKey === "retired-message",
  );
  assert.equal(item?.status, "delete");
  assert.equal(item?.edit?.operation, "delete");
  assert.equal(Object.hasOwn(item?.edit ?? {}, "content"), false);
} else if (scenario === "apply") {
  const plan = await planStore.load();
  assert.ok(plan);
  const baselineBefore = await readFile(baselinePath, "utf8");
  const result = await applyUpdatePlan(plan, config, baselineStore);
  const item = result.contentResults.find(
    ({ sourceKey }) => sourceKey === "retired-message",
  );
  const baselineResult = result.baselineResults.find(
    ({ sourceKey }) => sourceKey === "retired-message",
  );
  if (process.argv[3] === "stale-dependency") {
    assert.equal(item?.status, "conflict");
    assert.equal(baselineResult?.status, "notAttempted");
    assert.equal(await readFile(baselinePath, "utf8"), baselineBefore);
    const target = await readResource(targetPath);
    assert.equal(target.records[0]?.text, "Enregistrer");
  } else if (process.argv[3] === "physical-target-remains") {
    assert.equal(item?.status, "writeUnconfirmed");
    assert.equal(baselineResult?.status, "notAttempted");
    assert.equal(await readFile(baselinePath, "utf8"), baselineBefore);
    const target = await readResource(targetPath);
    assert.equal(target.records.length, 2);
    assert.equal(
      target.records.find(({ context }) => context.key === "archive.save")?.id,
      "detached-message",
    );
  } else {
    assert.equal(item?.status, "written");
    assert.equal(baselineResult?.status, "advanced");
    assert.deepEqual(
      (await readResource(targetPath)).records.map(({ id }) => id),
      ["unrelated-message"],
    );
    assert.equal(
      (await readResource(otherTargetPath)).records[0]?.context.readonly,
      true,
    );
  }
} else if (scenario === "verify") {
  const baseline = await baselineStore.load();
  const entry = baseline?.entries.find(
    ({ sourceKey }) => sourceKey === "retired-message",
  );
  assert.equal(entry?.source.presence, "removed");
  assert.equal(entry?.association.status, "missing");
  assert.equal(entry?.processed, true);
  assert.deepEqual(
    (await readResource(targetPath)).records.map(({ id }) => id),
    ["unrelated-message"],
  );
  assert.deepEqual(
    (await readResource(otherTargetPath)).records.map(({ id }) => id),
    ["unmatched-other"],
  );
  const facts = await readFacts(config);
  assert.equal(
    facts.source.units.some(({ key }) => key === "retired-message"),
    false,
  );
  assert.equal(facts.translations.records.length, 2);
}

console.log(JSON.stringify({ scenario, pid: process.pid }));
