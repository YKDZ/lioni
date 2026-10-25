import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";

import {
  advanceProcessingBaseline,
  applyUpdatePlan,
  compareProcessingBaseline,
  createUpdatePlan,
  readFacts,
  type ProcessingBaseline,
} from "@lioni/core";
import {
  createFileProcessingBaselineStore,
  createFileUpdatePlanStore,
} from "@lioni/core/node";

import config from "./resume.config.ts";
import { parseJson } from "./schemas.ts";

type SourceUnit = { readonly id: string; readonly source: string };
type TargetTranslation = {
  readonly sourceId: string;
  readonly text: string;
  readonly path?: string;
};
type ResumeBaseline = ProcessingBaseline<SourceUnit, TargetTranslation, never>;

const ids = ["A", "B", "C"] as const;
const baselineSelections = ids.map((sourceKey) => ({
  sourceKey,
  language: "fr",
}));
const baselinePath = ".lioni/resume-baseline.json";
const baselineStore = createFileProcessingBaselineStore(baselinePath);
const planStore = createFileUpdatePlanStore(".lioni/resume-plan.json");
const readTarget = async (id: string): Promise<TargetTranslation> =>
  parseJson<TargetTranslation>(
    await readFile("resume-resources/fr/" + id + ".json", "utf8"),
  );
const readBaseline = async (): Promise<ResumeBaseline | undefined> =>
  (await baselineStore.load()) as ResumeBaseline | undefined;
const entry = (baseline: ResumeBaseline | undefined, id: string) =>
  baseline?.entries.find(({ sourceKey }) => sourceKey === id);
const findResult = <T extends { readonly sourceKey: string }>(
  results: readonly T[],
  id: string,
) => results.find(({ sourceKey }) => sourceKey === id);
const scenario = process.argv[2];

if (scenario === "initialize") {
  const facts = await readFacts(config);
  const result = await advanceProcessingBaseline(
    baselineStore,
    facts,
    baselineSelections,
    config,
  );
  assert.equal(result.outcome, "saved");
  assert.ok(result.baseline);
  assert.ok(result.baseline.entries.every(({ processed }) => processed));
} else if (scenario === "save-plan") {
  const facts = await readFacts(config);
  const baseline = await readBaseline();
  const plan = await createUpdatePlan(facts, baseline, config);
  for (const id of ids) {
    const item = plan.items.find(({ sourceKey }) => sourceKey === id);
    assert.equal(item?.change, "changed");
    assert.equal(item?.status, "candidate");
    assert.equal(item?.decision.action, "candidate");
    assert.equal(item?.edit?.content, "更新译文 " + id);
  }
  await planStore.save(plan);
} else if (scenario === "partial") {
  const plan = await planStore.load();
  assert.ok(plan);
  const result = await applyUpdatePlan(plan, config, baselineStore);
  assert.equal(findResult(result.contentResults, "A")?.status, "written");
  const failedWrite = findResult(result.contentResults, "B");
  assert.equal(failedWrite?.status, "writeFailed");
  assert.match(failedWrite?.reason ?? "", /EACCES|permission denied/iu);
  assert.equal(findResult(result.contentResults, "C")?.status, "written");
  assert.equal(findResult(result.baselineResults, "A")?.status, "advanced");
  assert.equal(findResult(result.baselineResults, "B")?.status, "notAttempted");
  assert.equal(findResult(result.baselineResults, "C")?.status, "advanced");
  const baseline = await readBaseline();
  assert.equal(entry(baseline, "A")?.source.unit.source, "原文 A 新版");
  assert.equal(entry(baseline, "B")?.source.unit.source, "原文 B 旧版");
  assert.equal(entry(baseline, "C")?.source.unit.source, "原文 C 新版");
  assert.equal(
    entry(baseline, "A")?.association.translations[0]?.translation.text,
    "更新译文 A",
  );
  assert.equal(
    entry(baseline, "B")?.association.translations[0]?.translation.text,
    "译文 B",
  );
  assert.equal(
    entry(baseline, "C")?.association.translations[0]?.translation.text,
    "更新译文 C",
  );
  assert.equal((await readTarget("A")).text, "更新译文 A");
  assert.equal((await readTarget("B")).text, "译文 B");
  assert.equal((await readTarget("C")).text, "更新译文 C");
} else if (scenario === "resume-write") {
  const plan = await planStore.load();
  assert.ok(plan);
  const result = await applyUpdatePlan(plan, config, baselineStore);
  assert.equal(findResult(result.contentResults, "A")?.status, "conflict");
  assert.equal(findResult(result.contentResults, "B")?.status, "written");
  assert.equal(findResult(result.contentResults, "C")?.status, "conflict");
  assert.equal(findResult(result.baselineResults, "B")?.status, "advanced");
  assert.equal((await readTarget("B")).text, "更新译文 B");
  assert.equal(
    entry(await readBaseline(), "B")?.association.translations[0]?.translation
      .text,
    "更新译文 B",
  );
} else if (scenario === "baseline-failure") {
  const source = parseJson<SourceUnit[]>(
    await readFile("resume-resources/source.json", "utf8"),
  );
  const unitC = source.find(({ id }) => id === "C");
  assert.ok(unitC);
  (unitC as { id: string; source: string }).source = "原文 C 再更新";
  await writeFile(
    "resume-resources/source.json",
    JSON.stringify(source),
    "utf8",
  );
  const facts = await readFacts(config);
  const plan = await createUpdatePlan(facts, await readBaseline(), config);
  assert.equal(findResult(plan.items, "C")?.status, "candidate");
  assert.equal(findResult(plan.items, "A")?.status, "notProcessed");
  const baselineBefore = await readFile(baselinePath, "utf8");
  const result = await applyUpdatePlan(plan, config, baselineStore);
  assert.equal(findResult(result.contentResults, "C")?.status, "written");
  const failedSave = findResult(result.baselineResults, "C");
  assert.equal(failedSave?.status, "failed");
  assert.match(failedSave?.reason ?? "", /EACCES|permission denied/iu);
  assert.equal((await readTarget("C")).text, "更新译文 C");
  assert.equal(await readFile(baselinePath, "utf8"), baselineBefore);
  assert.equal(
    entry(await readBaseline(), "C")?.source.unit.source,
    "原文 C 新版",
  );
  assert.equal(
    entry(await readBaseline(), "C")?.association.translations[0]?.translation
      .text,
    "更新译文 C",
  );
} else if (scenario === "stale-old-plan") {
  const plan = await planStore.load();
  assert.ok(plan);
  const baselineBefore = await readFile(baselinePath, "utf8");
  const result = await applyUpdatePlan(plan, config, baselineStore);
  assert.equal(findResult(result.contentResults, "C")?.status, "conflict");
  assert.equal(findResult(result.baselineResults, "C")?.status, "notAttempted");
  assert.equal(await readFile(baselinePath, "utf8"), baselineBefore);
  assert.equal((await readTarget("C")).text, "更新译文 C");
} else if (scenario === "replan-retain") {
  const facts = await readFacts(config);
  const baseline = await readBaseline();
  const refreshedPlan = await createUpdatePlan(facts, baseline, config);
  const refreshedC = refreshedPlan.items.find(
    ({ sourceKey }) => sourceKey === "C",
  );
  assert.equal(refreshedC?.change, "changed");
  assert.equal(
    refreshedC?.expectedInput?.association.translations[0]?.translation.text,
    "更新译文 C",
  );
  assert.equal(refreshedC?.decision.action, "retain");
  assert.equal(refreshedC?.status, "retain");
  await planStore.save(refreshedPlan);
  const result = await applyUpdatePlan(refreshedPlan, config, baselineStore);
  assert.equal(findResult(result.contentResults, "C")?.status, "retained");
  assert.equal(findResult(result.baselineResults, "C")?.status, "advanced");
  assert.equal((await readTarget("C")).text, "更新译文 C");
} else if (scenario === "verify") {
  const facts = await readFacts(config);
  const baseline = await readBaseline();
  assert.ok(baseline);
  for (const id of ids) {
    assert.equal(entry(baseline, id)?.processed, true);
    assert.equal(
      entry(baseline, id)?.source.unit.source,
      id === "C" ? "原文 C 再更新" : "原文 " + id + " 新版",
    );
    assert.equal(
      entry(baseline, id)?.association.translations[0]?.translation.text,
      "更新译文 " + id,
    );
  }
  assert.ok(
    (await compareProcessingBaseline(facts, baseline, config)).changes.every(
      ({ status }) => status === "unchanged",
    ),
  );
}
