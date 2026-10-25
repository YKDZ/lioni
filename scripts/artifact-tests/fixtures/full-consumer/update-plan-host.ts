import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  advanceProcessingBaseline,
  applyUpdatePlan,
  compareProcessingBaseline,
  createUpdatePlan,
  readFacts,
  type ProcessingBaseline,
  type UpdatePlan,
} from "@lioni/core";
import {
  createFileProcessingBaselineStore,
  createFileUpdatePlanStore,
} from "@lioni/core/node";

import config, { callbackCounts } from "./plan.config.ts";
import { parseJson } from "./schemas.ts";

type Unit = {
  readonly id: string;
  readonly source: string;
  readonly context: {
    readonly file: string;
    readonly line: number;
    readonly screenshot: string;
  };
};
type Translation = { readonly id: string; readonly text: string };

const scenario = process.argv[2];
const baselinePath = "update-plan-baseline.json";
const planPath = "update-plan.json";
const sourcePath = fileURLToPath(
  new URL("./update-plan-resources/source.json", import.meta.url),
);
const targetPath = fileURLToPath(
  new URL("./update-plan-resources/fr.json", import.meta.url),
);
const baselineStore = createFileProcessingBaselineStore(baselinePath);
const planStore = createFileUpdatePlanStore(planPath);

if (scenario === "establish") {
  const facts = await readFacts(config);
  const result = await advanceProcessingBaseline(
    baselineStore,
    facts,
    [{ sourceKey: "save-button", language: "fr" }],
    config,
  );
  assert.equal(result.outcome, "saved");
  assert.deepEqual(
    result.baseline?.entries.map(({ sourceKey, processed }) => [
      sourceKey,
      processed,
    ]),
    [
      ["save-button", true],
      ["cancel-button", false],
    ],
  );
} else if (scenario === "save") {
  const baselineBefore = await readFile(baselinePath);
  const sourceBefore = await readFile(sourcePath);
  const targetBefore = await readFile(targetPath);
  const facts = await readFacts(config);
  const baseline = (await baselineStore.load()) as
    | ProcessingBaseline<Unit, Translation, never>
    | undefined;
  const plan = await createUpdatePlan(facts, baseline, config);
  const item = plan.items.find(({ sourceKey }) => sourceKey === "save-button");
  assert.equal(item?.change, "changed");
  assert.equal(item?.decision.action, "candidate");
  assert.equal(item?.status, "candidate");
  assert.equal(
    item?.previous?.source.unit.context.screenshot,
    "shots/save.png",
  );
  assert.equal(
    item?.current?.source.unit.context.screenshot,
    "shots/save-updated.png",
  );
  assert.equal(item?.expectedInput?.source.value, "Save");
  assert.equal(
    item?.expectedInput?.association.translations[0]?.translation.text,
    "Enregistrer",
  );
  assert.equal(item?.edit?.content, "Save");
  await planStore.save(plan);
  assert.deepEqual(await readFile(sourcePath), sourceBefore);
  assert.deepEqual(await readFile(targetPath), targetBefore);
  assert.deepEqual(await readFile(baselinePath), baselineBefore);
} else if (scenario === "read") {
  const plan = (await planStore.load()) as
    | UpdatePlan<Unit, Translation, string>
    | undefined;
  assert.ok(plan);
  const item = plan.items.find(({ sourceKey }) => sourceKey === "save-button");
  assert.equal(item?.decision.action, "candidate");
  assert.equal(item?.status, "candidate");
  assert.equal(
    item?.previous?.source.unit.context.screenshot,
    "shots/save.png",
  );
  assert.equal(
    item?.current?.source.unit.context.screenshot,
    "shots/save-updated.png",
  );
  assert.equal(item?.expectedInput?.source.value, "Save");
  assert.equal(
    item?.expectedInput?.association.translations[0]?.translation.text,
    "Enregistrer",
  );
  assert.equal(item?.edit?.content, "Save");
  const liveSource = JSON.parse(await readFile(sourcePath, "utf8"));
  const liveTarget = JSON.parse(await readFile(targetPath, "utf8"));
  assert.equal(liveSource[0].context.screenshot, "shots/after-plan.png");
  assert.equal(liveTarget[0].text, "Sauvegarder");
} else if (scenario === "stale-apply") {
  const baselineBefore = await readFile(baselinePath, "utf8");
  const targetBefore = await readFile(targetPath, "utf8");
  const plan = (await planStore.load()) as
    | UpdatePlan<Unit, Translation, string>
    | undefined;
  assert.ok(plan);
  const result = await applyUpdatePlan(plan, config, baselineStore);
  assert.equal(
    result.contentResults.find(({ sourceKey }) => sourceKey === "save-button")
      ?.status,
    "conflict",
  );
  assert.equal(
    result.baselineResults.find(({ sourceKey }) => sourceKey === "save-button")
      ?.status,
    "notAttempted",
  );
  assert.deepEqual(await readFile(targetPath, "utf8"), targetBefore);
  assert.deepEqual(await readFile(baselinePath, "utf8"), baselineBefore);
} else if (scenario === "refresh") {
  const facts = await readFacts(config);
  const baseline = (await baselineStore.load()) as
    | ProcessingBaseline<Unit, Translation, never>
    | undefined;
  const plan = await createUpdatePlan(facts, baseline, config);
  const item = plan.items.find(({ sourceKey }) => sourceKey === "save-button");
  assert.equal(item?.expectedInput?.source.value, "Save");
  assert.equal(item?.status, "candidate");
  assert.equal(item?.edit?.content, "Save");
  await planStore.save(plan);
} else if (scenario === "apply") {
  const plan = (await planStore.load()) as
    | UpdatePlan<Unit, Translation, string>
    | undefined;
  assert.ok(plan);
  const result = await applyUpdatePlan(plan, config, baselineStore);
  assert.equal(
    result.contentResults.find(({ sourceKey }) => sourceKey === "save-button")
      ?.status,
    "written",
  );
  assert.equal(
    result.baselineResults.find(({ sourceKey }) => sourceKey === "save-button")
      ?.status,
    "advanced",
  );
} else if (scenario === "verify") {
  const facts = await readFacts(config);
  const baseline = (await baselineStore.load()) as
    | ProcessingBaseline<Unit, Translation, never>
    | undefined;
  assert.ok(baseline);
  const a = baseline.entries.find(
    ({ sourceKey }) => sourceKey === "save-button",
  );
  const b = baseline.entries.find(
    ({ sourceKey }) => sourceKey === "cancel-button",
  );
  assert.equal(a?.source.unit.source, "Save");
  assert.equal(a?.association.translations[0]?.translation.text, "Save");
  assert.equal(a?.processed, true);
  assert.equal(b?.source.unit.source, "Cancel");
  assert.equal(b?.association.translations[0]?.translation.text, "Annuler");
  assert.equal(b?.processed, false);
  const changes = (await compareProcessingBaseline(facts, baseline, config))
    .changes;
  assert.equal(
    changes.find(({ sourceKey }) => sourceKey === "save-button")?.status,
    "unchanged",
  );
  assert.equal(
    changes.find(({ sourceKey }) => sourceKey === "cancel-button")?.status,
    "unchanged",
  );
} else if (scenario === "corrupt-plan") {
  const saved = parseJson<{
    readonly items: {
      readonly sourceKey: string;
      readonly current: {
        readonly source: { readonly unit: { source: unknown } };
      };
    }[];
  }>(await readFile(planPath, "utf8"));
  const item = saved.items.find(({ sourceKey }) => sourceKey === "save-button");
  assert.ok(item);
  item.current.source.unit.source = 7;
  await writeFile(planPath, JSON.stringify(saved, null, 2), "utf8");
} else if (scenario === "reject-plan") {
  const [planBefore, baselineBefore, targetBefore] = await Promise.all([
    readFile(planPath, "utf8"),
    readFile(baselinePath, "utf8"),
    readFile(targetPath, "utf8"),
  ]);
  const plan = (await planStore.load()) as
    | UpdatePlan<Unit, Translation, string>
    | undefined;
  assert.ok(plan);
  await assert.rejects(() => applyUpdatePlan(plan, config, baselineStore), {
    name: "StandardSchemaContractError",
  });
  assert.deepEqual(callbackCounts, {
    matches: 0,
    policy: 0,
    locate: 0,
    write: 0,
  });
  assert.equal(await readFile(planPath, "utf8"), planBefore);
  assert.equal(await readFile(baselinePath, "utf8"), baselineBefore);
  assert.equal(await readFile(targetPath, "utf8"), targetBefore);
}
