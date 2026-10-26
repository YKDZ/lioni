import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  applyUpdatePlan,
  previewUpdate,
  recordComparisonBaseline,
  validateUpdatePlan,
  type UpdatePlan,
} from "@lioni/core";
import {
  createFileComparisonBaselineStore,
  createFileUpdatePlanStore,
} from "@lioni/core/node";

import config, { callbackCounts } from "./plan.config.ts";

type Unit = {
  readonly id: string;
  readonly source: string;
  readonly context: {
    readonly file: string;
    readonly line: number;
    readonly screenshot: string;
  };
};
type Translation = { readonly id: string; text: string };
type StoredPlan = UpdatePlan<Unit, Translation, string>;

const mode = process.argv[2];
const baselinePath = "update-plan-baseline.json";
const planPath = "update-plan.json";
const targetPath = fileURLToPath(
  new URL("./update-plan-resources/fr.json", import.meta.url),
);
const baselineStore = createFileComparisonBaselineStore<
  Unit,
  Translation,
  string
>(baselinePath);
const planStore = createFileUpdatePlanStore(planPath);

async function loadPlan(): Promise<StoredPlan> {
  const plan = await planStore.load();
  assert.ok(plan);
  validateUpdatePlan(plan);
  return plan as StoredPlan;
}

if (mode === "establish") {
  const result = await recordComparisonBaseline(config, baselineStore);
  assert.equal(result.outcome, "saved");
} else if (mode === "save") {
  const before = await readFile(baselinePath, "utf8");
  const plan = await previewUpdate(config, baselineStore);
  const item = plan.items.find(({ sourceKey }) => sourceKey === "save-button");
  assert.equal(item?.action, "write");
  assert.equal(item?.request?.operation, "write");
  assert.equal(item?.request?.expectedSource?.presence, "present");
  await planStore.save(plan);
  assert.equal(await readFile(baselinePath, "utf8"), before);
} else if (mode === "read") {
  const plan = await loadPlan();
  const item = plan.items.find(({ sourceKey }) => sourceKey === "save-button");
  assert.ok(item && item.action === "write");
  if (
    item === undefined ||
    item.action !== "write" ||
    item.request.expectedSource?.presence !== "present"
  )
    throw new Error("保存的写入计划缺少原文依据。");
  assert.equal(
    item.request.expectedSource.unit.context.screenshot,
    "shots/save-updated.png",
  );
} else if (mode === "stale-apply") {
  const plan = await loadPlan();
  const baselineBefore = await readFile(baselinePath, "utf8");
  const targetBefore = await readFile(targetPath, "utf8");
  const result = await applyUpdatePlan(plan, config);
  assert.equal(result.status, "failed");
  assert.equal(result.results[0]?.status, "conflict");
  assert.equal(callbackCounts.policy, 0);
  assert.equal(callbackCounts.matches, 0);
  assert.equal(callbackCounts.write, 0);
  assert.equal(await readFile(targetPath, "utf8"), targetBefore);
  assert.equal(await readFile(baselinePath, "utf8"), baselineBefore);
} else if (mode === "refresh") {
  const plan = await previewUpdate(config, baselineStore);
  assert.equal(plan.items[0]?.action, "write");
  await planStore.save(plan);
} else if (mode === "apply") {
  const plan = await loadPlan();
  const baselineBefore = await readFile(baselinePath, "utf8");
  const result = await applyUpdatePlan(plan, config);
  assert.equal(result.status, "completed");
  assert.equal(result.results[0]?.status, "written");
  assert.equal(callbackCounts.policy, 0);
  assert.equal(callbackCounts.matches, 0);
  assert.equal(await readFile(baselinePath, "utf8"), baselineBefore);
} else if (mode === "verify") {
  const translations = JSON.parse(
    await readFile(targetPath, "utf8"),
  ) as Translation[];
  assert.equal(
    translations.find(({ id }) => id === "save-button")?.text,
    "Save",
  );
} else if (mode === "corrupt-plan") {
  const plan = await loadPlan();
  const item = plan.items.find(({ sourceKey }) => sourceKey === "save-button");
  assert.ok(item && item.action === "write");
  const changed = {
    ...plan,
    items: plan.items.map((candidate) =>
      candidate === item
        ? {
            ...candidate,
            request: {
              ...candidate.request,
              content: 7 as unknown as string,
            },
          }
        : candidate,
    ),
  };
  await writeFile(planPath, JSON.stringify(changed), "utf8");
} else if (mode === "reject-plan") {
  const [planBefore, baselineBefore, targetBefore] = await Promise.all([
    readFile(planPath, "utf8"),
    readFile(baselinePath, "utf8"),
    readFile(targetPath, "utf8"),
  ]);
  const plan = JSON.parse(await readFile(planPath, "utf8")) as StoredPlan;
  await assert.rejects(() => applyUpdatePlan(plan, config), {
    name: "TypeError",
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
