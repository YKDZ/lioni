import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  applyUpdatePlan,
  previewUpdate,
  recordComparisonBaseline,
  validateUpdatePlan,
  type UpdatePlan,
  type TranslationWriteCondition,
} from "@lioni/core";
import {
  createFileComparisonBaselineStore,
  createFileUpdatePlanStore,
} from "@lioni/core/node";

import config from "./deletion.config.ts";

type Unit = { id: string; source: string; context: { file: string } };
type Translation = {
  id: string;
  text: string;
  context: { file: string; key: string; readonly?: boolean };
};
type DeletionPlan = UpdatePlan<Unit, Translation, string>;

const baselinePath = "deletion-baseline.json";
const planPath = "deletion-plan.json";
const targetPath = fileURLToPath(
  new URL("./deletion-resources/fr.json", import.meta.url),
);
const dependencyPath = fileURLToPath(
  new URL("./deletion-resources/dependencies.json", import.meta.url),
);
const baselineStore = createFileComparisonBaselineStore<
  Unit,
  Translation,
  string
>(baselinePath);
const planStore = createFileUpdatePlanStore(planPath);
const condition: TranslationWriteCondition<
  Unit,
  Translation,
  string,
  never
> = async () => {
  const dependency = JSON.parse(await readFile(dependencyPath, "utf8")) as {
    revision: number;
  };
  return dependency.revision === 1
    ? true
    : { status: "rejected", reason: "删除所依赖的清单已变化。" };
};
const mode = process.argv[2];

async function loadPlan(): Promise<DeletionPlan> {
  const plan = await planStore.load();
  assert.ok(plan);
  validateUpdatePlan(plan);
  return plan as DeletionPlan;
}

if (mode === "initialize") {
  const result = await recordComparisonBaseline(config, baselineStore);
  assert.equal(result.outcome, "saved");
} else if (mode === "save-plan") {
  const plan = await previewUpdate(config, baselineStore);
  const deletion = plan.items.find(({ action }) => action === "delete");
  assert.ok(deletion && deletion.action === "delete");
  assert.equal(deletion.request.expectedSource?.presence, "absent");
  assert.equal(deletion.request.expectedTarget.status, "present");
  assert.ok(deletion.request.expectedTarget.record);
  await planStore.save(plan);
} else if (mode === "read-plan") {
  const plan = await loadPlan();
  assert.ok(plan.items.some(({ action }) => action === "delete"));
} else if (mode === "apply") {
  const plan = await loadPlan();
  const deletionIndex = plan.items.findIndex(
    ({ action }) => action === "delete",
  );
  const before = await readFile(targetPath, "utf8");
  const baselineBefore = await readFile(baselinePath, "utf8");
  const result = await applyUpdatePlan(plan, config, condition);
  const deletionResult = result.results[deletionIndex];
  if (deletionResult?.status === "written") {
    assert.equal(result.status, "completed");
    assert.deepEqual(JSON.parse(await readFile(targetPath, "utf8")), {
      enumeration: "complete",
      records: [
        {
          id: "unrelated-message",
          text: "Annuler",
          context: {
            file: "deletion-resources/fr.json",
            key: "footer.cancel",
          },
        },
      ],
    });
  } else {
    assert.equal(result.status, "failed");
    assert.equal(deletionResult?.status, "conflict");
    assert.equal(await readFile(targetPath, "utf8"), before);
  }
  assert.equal(await readFile(baselinePath, "utf8"), baselineBefore);
} else if (mode === "verify") {
  const target = JSON.parse(await readFile(targetPath, "utf8")) as {
    readonly records: readonly unknown[];
  };
  assert.equal(target.records.length, 1);
  const remaining = target.records[0] as { readonly id?: string } | undefined;
  assert.equal(remaining?.id, "unrelated-message");
  const baseline = await baselineStore.load();
  assert.ok(baseline);
  assert.equal(baseline.snapshot.source.units[0]?.key, "retired-message");
  assert.equal(baseline.snapshot.translations.records.length, 3);
}
