import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";

import {
  applyUpdatePlan,
  previewUpdate,
  readFacts,
  recordComparisonBaseline,
  validateTranslationWriteRequest,
  validateUpdatePlan,
  writeTranslationRequests,
  type TranslationWriteRequest,
  type UpdatePlan,
} from "lioni";
import {
  createFileComparisonBaselineStore,
  createFileUpdatePlanStore,
} from "lioni/node";

import config, { type Translation, type Unit } from "./lioni.config.ts";

const baseline = createFileComparisonBaselineStore<Unit, Translation, string>(
  "baseline.json",
);
const plans = createFileUpdatePlanStore("plan.json");
const mode = process.argv[2];
let result: unknown;
if (mode === "baseline")
  result = await recordComparisonBaseline(config, baseline);
else if (mode === "plan") {
  const plan = await previewUpdate(config, baseline);
  await plans.save(plan);
  result = plan.items.map((item) => [
    item.sourceKey ?? item.request?.expectedSource?.key,
    item.action,
  ]);
} else if (mode === "apply") {
  const plan = await plans.load();
  assert.ok(plan);
  validateUpdatePlan(plan);
  result = await applyUpdatePlan(
    plan as UpdatePlan<Unit, Translation, string>,
    config,
    () => process.argv[3] !== "reject",
  );
} else if (mode === "save-edit") {
  const facts = await readFacts(config);
  const source = facts.source.units.find(({ key }) => key === "A");
  const target = facts.translations.records.find(
    ({ translation }) => translation.id === "A",
  );
  assert.ok(source && target?.bodyAvailability === "available");
  const request: TranslationWriteRequest<string, Unit> = {
    operation: "write",
    target: { identity: target.identity },
    content: "人工修订 A",
    expectedSource: {
      presence: "present",
      key: source.key,
      unit: source.unit,
      content: source.unit.source,
      range: "source.json",
    },
    expectedTarget: {
      status: "present",
      identity: target.identity,
      content: target.content,
      range: "fr",
      record: target.translation,
    },
  };
  await writeFile("edit.json", JSON.stringify(request));
} else if (mode === "edit") {
  const request = await validateTranslationWriteRequest(
    JSON.parse(await readFile("edit.json", "utf8")),
    config,
  );
  result = await writeTranslationRequests([request], config);
} else throw new Error(`未知工作流操作：${String(mode)}`);
process.stdout.write(JSON.stringify(result ?? null));
