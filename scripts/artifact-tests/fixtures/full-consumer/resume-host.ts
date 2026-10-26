import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  applyUpdatePlan,
  previewUpdate,
  recordComparisonBaseline,
  type UpdatePlan,
} from "@lioni/core";
import {
  createFileComparisonBaselineStore,
  createFileUpdatePlanStore,
} from "@lioni/core/node";

import config from "./resume.config.ts";

type SourceUnit = { id: string; source: string };
type TargetTranslation = {
  targetId: string;
  sourceId: string;
  text: string;
  path: string;
  writePath?: string;
};
type ResumePlan = UpdatePlan<SourceUnit, TargetTranslation, string>;

const ids = ["A", "B", "C"] as const;
const baselinePath = "resume-baseline.json";
const planPath = "resume-plan.json";
const baselineStore = createFileComparisonBaselineStore<
  SourceUnit,
  TargetTranslation,
  string
>(baselinePath);
const planStore = createFileUpdatePlanStore(planPath);
const scenario = process.argv[2];

async function readTarget(id: string): Promise<TargetTranslation> {
  return JSON.parse(
    await readFile(`resume-resources/fr/${id}.json`, "utf8"),
  ) as TargetTranslation;
}

async function loadPlan(): Promise<ResumePlan> {
  const plan = await planStore.load();
  assert.ok(plan);
  return plan as ResumePlan;
}

function itemResult(
  plan: ResumePlan,
  results: readonly { readonly status: string; readonly reason?: string }[],
  id: string,
) {
  const index = plan.items.findIndex(({ sourceKey }) => sourceKey === id);
  return results[index];
}

if (scenario === "initialize") {
  const result = await recordComparisonBaseline(config, baselineStore);
  assert.equal(result.outcome, "saved");
} else if (scenario === "save-plan") {
  const plan = await previewUpdate(config, baselineStore);
  assert.deepEqual(
    plan.items.map(({ sourceKey, action }) => [sourceKey, action]),
    ids.map((id) => [id, "write"]),
  );
  await planStore.save(plan);
} else if (scenario === "partial") {
  const plan = await loadPlan();
  const baselineBefore = await readFile(baselinePath, "utf8");
  const result = await applyUpdatePlan(plan, config);
  assert.equal(itemResult(plan, result.results, "A")?.status, "written");
  assert.equal(itemResult(plan, result.results, "B")?.status, "writeFailed");
  assert.match(itemResult(plan, result.results, "B")?.reason ?? "", /EISDIR/u);
  assert.equal(itemResult(plan, result.results, "C")?.status, "written");
  assert.equal((await readTarget("A")).text, "更新译文 A");
  assert.equal((await readTarget("B")).text, "译文 B");
  assert.equal((await readTarget("C")).text, "更新译文 C");
  assert.equal(await readFile(baselinePath, "utf8"), baselineBefore);
} else if (scenario === "stale-old-plan") {
  const plan = await loadPlan();
  const result = await applyUpdatePlan(plan, config);
  assert.equal(itemResult(plan, result.results, "A")?.status, "conflict");
  assert.equal(itemResult(plan, result.results, "B")?.status, "conflict");
  assert.equal(itemResult(plan, result.results, "C")?.status, "conflict");
} else if (scenario === "replan-retain") {
  const plan = await previewUpdate(config, baselineStore);
  assert.deepEqual(
    plan.items.map(({ sourceKey, action }) => [sourceKey, action]),
    [
      ["A", "retain"],
      ["B", "write"],
      ["C", "retain"],
    ],
  );
  await planStore.save(plan);
} else if (scenario === "resume-write") {
  const plan = await loadPlan();
  const baselineBefore = await readFile(baselinePath, "utf8");
  const result = await applyUpdatePlan(plan, config);
  assert.equal(result.status, "completed");
  assert.equal(itemResult(plan, result.results, "A")?.status, "retained");
  assert.equal(itemResult(plan, result.results, "B")?.status, "written");
  assert.equal(itemResult(plan, result.results, "C")?.status, "retained");
  assert.equal((await readTarget("B")).text, "更新译文 B");
  assert.equal(await readFile(baselinePath, "utf8"), baselineBefore);
} else if (scenario === "verify") {
  for (const id of ids)
    assert.equal((await readTarget(id)).text, "更新译文 " + id);
}
