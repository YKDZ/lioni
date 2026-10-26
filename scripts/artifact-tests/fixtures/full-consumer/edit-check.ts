import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  analyzeQuality,
  applySemanticEdits,
  prepareQualityConditionedSemanticEdit,
  prepareSemanticEdit,
  readFacts,
  resolveSemanticEditInput,
  type SemanticEdit,
} from "@lioni/core";

import config from "./edits.config.ts";
import { parseJson } from "./schemas.ts";

type EditCatalogueRecord = {
  targetId: string;
  text: string;
  context: {
    file: string;
    resourceKey: string;
    sourceLines: number[];
    annotation?: string;
    readOnly?: boolean;
    writeFailure?: boolean;
    writeIgnore?: boolean;
  };
};
type EditCatalogue = {
  enumeration: "complete" | "partial";
  records: EditCatalogueRecord[];
  unrelated?: unknown;
};
type EditSource = {
  source: string;
  context: { unrelated?: string; screenshot?: string };
};
type AppliedEditResult = {
  readonly status: string;
  readonly reason?: string;
  readonly before?: {
    readonly translations: readonly {
      readonly translation: { readonly text: string };
    }[];
  };
  readonly after?: {
    readonly translations: readonly {
      readonly translation: { readonly text: string };
    }[];
  };
};

function requiredAt<T>(values: readonly T[], index: number, label: string): T {
  const value = values[index];
  assert.ok(value, `缺少预期的 ${label}。`);
  return value;
}

async function prepare(
  sourceKey: string,
  content: string,
): Promise<SemanticEdit<string>> {
  const facts = await readFacts(config);
  const resolved = await resolveSemanticEditInput(
    facts,
    { sourceKey, language: "fr" },
    config,
  );
  if (resolved.status !== "resolved")
    throw new Error(`编辑输入无法解析：${resolved.status}`);
  const result = await prepareSemanticEdit(
    resolved.input,
    {
      sourceKey,
      language: "fr",
      content,
    },
    config,
  );
  if (result.status !== "prepared")
    throw new Error(`编辑候选无法准备：${result.reason}`);
  return result.edit;
}

async function applyInNewProcess(
  name: string,
  edits: readonly SemanticEdit<string>[],
): Promise<readonly AppliedEditResult[]> {
  const editPath = path.join(process.cwd(), name + ".json");
  await writeFile(editPath, JSON.stringify(edits), "utf8");
  const child = spawnSync(process.execPath, ["edit-apply.ts", editPath], {
    encoding: "utf8",
  });
  assert.equal(child.status, 0, child.stderr);
  const saved = parseJson<{ readonly results: readonly AppliedEditResult[] }>(
    await readFile(editPath + ".result.json", "utf8"),
  );
  return saved.results;
}

async function baselineState() {
  const directory = path.join(process.cwd(), ".lioni");
  const files = await readdir(directory, { withFileTypes: true });
  return Object.fromEntries(
    await Promise.all(
      files
        .filter((entry) => entry.isFile())
        .map(async ({ name }) => [
          name,
          await readFile(path.join(directory, name), "utf8"),
        ]),
    ),
  );
}

const sourcesPath = path.join(process.cwd(), "edit-sources.json");
const cataloguePath = path.join(process.cwd(), "edit-catalogue.json");
const initialFacts = await readFacts(config);
assert.equal(
  initialFacts.associations.find(({ sourceKey }) => sourceKey === "source:18")
    ?.status,
  "matched",
);
assert.equal(
  initialFacts.associations.find(({ sourceKey }) => sourceKey === "source:19")
    ?.status,
  "matched",
);
assert.equal(
  initialFacts.associations.find(({ sourceKey }) => sourceKey === "source:22")
    ?.status,
  "missing",
);

const firstSharedEdit = await prepare("source:18", "First shared proposal");
const secondSharedEdit = await prepare("source:19", "Second shared proposal");
const sharedLocator = firstSharedEdit.target.locator;
if (
  typeof sharedLocator !== "object" ||
  sharedLocator === null ||
  Array.isArray(sharedLocator) ||
  !("key" in sharedLocator) ||
  typeof sharedLocator.key !== "string"
)
  throw new Error("共享编辑目标缺少键定位。");
assert.notEqual(firstSharedEdit.sourceKey, sharedLocator.key);
const sources = parseJson<EditSource[]>(await readFile(sourcesPath, "utf8"));
requiredAt(sources, 0, "原文资源首项").context.unrelated =
  "changed after preparation";
await writeFile(sourcesPath, JSON.stringify(sources, null, 2), "utf8");
let catalogue = parseJson<EditCatalogue>(await readFile(cataloguePath, "utf8"));
requiredAt(catalogue.records, 0, "译文资源首项").context.annotation =
  "external annotation change";
catalogue.unrelated = { preserve: "unrelated resource entry" };
await writeFile(cataloguePath, JSON.stringify(catalogue, null, 2), "utf8");

const sharedResults = await applyInNewProcess("shared-edits", [
  firstSharedEdit,
  secondSharedEdit,
]);
assert.deepEqual(
  sharedResults.map(({ status }) => status),
  ["written", "conflict"],
);
assert.equal(
  requiredAt(sharedResults, 1, "第二条写回结果").before?.translations[0]
    ?.translation.text,
  "First shared proposal",
);
let actualCatalogue = parseJson<EditCatalogue>(
  await readFile(cataloguePath, "utf8"),
);
assert.equal(
  requiredAt(actualCatalogue.records, 0, "共享写回后的译文").text,
  "First shared proposal",
);
assert.deepEqual(actualCatalogue.unrelated, {
  preserve: "unrelated resource entry",
});

const staleTargetEdit = await prepare(
  "source:18",
  "Must not overwrite external edit",
);
requiredAt(actualCatalogue.records, 0, "外部修改的译文").text =
  "External target edit";
await writeFile(
  cataloguePath,
  JSON.stringify(actualCatalogue, null, 2),
  "utf8",
);
const staleTargetResults = await applyInNewProcess("stale-target-edit", [
  staleTargetEdit,
]);
assert.equal(
  requiredAt(staleTargetResults, 0, "过期目标结果").status,
  "conflict",
);
actualCatalogue = parseJson<EditCatalogue>(
  await readFile(cataloguePath, "utf8"),
);
assert.equal(
  requiredAt(actualCatalogue.records, 0, "外部修改的译文").text,
  "External target edit",
);

const staleSourceEdit = await prepare(
  "source:18",
  "Must not overwrite after source change",
);
const changedSourceText = parseJson<EditSource[]>(
  await readFile(sourcesPath, "utf8"),
);
requiredAt(changedSourceText, 0, "已更改的原文").source =
  "Save with changed meaning";
await writeFile(
  sourcesPath,
  JSON.stringify(changedSourceText, null, 2),
  "utf8",
);
const staleSourceResults = await applyInNewProcess("stale-source-edit", [
  staleSourceEdit,
]);
assert.equal(
  requiredAt(staleSourceResults, 0, "过期原文结果").status,
  "conflict",
);
actualCatalogue = parseJson<EditCatalogue>(
  await readFile(cataloguePath, "utf8"),
);
assert.equal(
  requiredAt(actualCatalogue.records, 0, "外部修改的译文").text,
  "External target edit",
);
requiredAt(changedSourceText, 0, "恢复的原文").source = "Save";
await writeFile(
  sourcesPath,
  JSON.stringify(changedSourceText, null, 2),
  "utf8",
);

const staleContextEdit = await prepare(
  "source:18",
  "Must not overwrite after screenshot change",
);
const changedSources = parseJson<EditSource[]>(
  await readFile(sourcesPath, "utf8"),
);
requiredAt(changedSources, 0, "上下文已更改的原文").context.screenshot =
  "shots/save-v2.png";
await writeFile(sourcesPath, JSON.stringify(changedSources, null, 2), "utf8");
const staleContextResults = await applyInNewProcess("stale-context-edit", [
  staleContextEdit,
]);
const staleContextResult = requiredAt(staleContextResults, 0, "过期上下文结果");
assert.equal(staleContextResult.status, "conflict");
assert.match(staleContextResult.reason ?? "", /依赖/u);
actualCatalogue = parseJson<EditCatalogue>(
  await readFile(cataloguePath, "utf8"),
);
assert.equal(
  requiredAt(actualCatalogue.records, 0, "外部修改的译文").text,
  "External target edit",
);

const multiMatchEdit = await prepare(
  "source:20",
  "Do not edit an ambiguous target",
);
actualCatalogue = parseJson<EditCatalogue>(
  await readFile(cataloguePath, "utf8"),
);
actualCatalogue.records.push({
  targetId: "duplicate-cancel-target",
  text: "Second cancel translation",
  context: {
    file: "locales/fr.json",
    resourceKey: "duplicate-cancel",
    sourceLines: [20],
  },
});
await writeFile(
  cataloguePath,
  JSON.stringify(actualCatalogue, null, 2),
  "utf8",
);
const multiMatchResults = await applyInNewProcess("multi-match-edit", [
  multiMatchEdit,
]);
assert.equal(
  requiredAt(multiMatchResults, 0, "多重匹配结果").status,
  "conflict",
);
actualCatalogue = parseJson<EditCatalogue>(
  await readFile(cataloguePath, "utf8"),
);
assert.equal(
  actualCatalogue.records.find(
    ({ context }) => context.resourceKey === "readonly-cancel",
  )?.text,
  "Cancel original",
);
actualCatalogue.records = actualCatalogue.records.filter(
  ({ context }) => context.resourceKey !== "duplicate-cancel",
);
await writeFile(
  cataloguePath,
  JSON.stringify(actualCatalogue, null, 2),
  "utf8",
);

const readOnlyEdit = await prepare("source:20", "No write to read-only target");
const readOnlyRecord = requiredAt(
  actualCatalogue.records.filter(
    ({ context }) => context.resourceKey === "readonly-cancel",
  ),
  0,
  "只读译文",
);
readOnlyRecord.context.readOnly = true;
await writeFile(
  cataloguePath,
  JSON.stringify(actualCatalogue, null, 2),
  "utf8",
);
const readOnlyResults = await applyInNewProcess("readonly-edit", [
  readOnlyEdit,
]);
assert.equal(
  requiredAt(readOnlyResults, 0, "只读写回结果").status,
  "notWritable",
);

const failedWriteEdit = await prepare(
  "source:21",
  "Host storage rejects this edit",
);
const failedWriteResults = await applyInNewProcess("failed-write-edit", [
  failedWriteEdit,
]);
assert.equal(
  requiredAt(failedWriteResults, 0, "失败写回结果").status,
  "writeFailed",
);
assert.equal(
  requiredAt(failedWriteResults, 0, "失败写回结果").after?.translations[0]
    ?.translation.text,
  "Help original",
);

const ignoredWriteEdit = await prepare(
  "source:24",
  "Host reports success without changing the resource",
);
const ignoredWriteResults = await applyInNewProcess("ignored-write-edit", [
  ignoredWriteEdit,
]);
assert.equal(
  requiredAt(ignoredWriteResults, 0, "未确认写回结果").status,
  "writeUnconfirmed",
);
assert.equal(
  requiredAt(ignoredWriteResults, 0, "未确认写回结果").after?.translations[0]
    ?.translation.text,
  "Tooltip original",
);

const createEdit = await prepare("source:22", "À propos");
assert.deepEqual(createEdit.target, {
  kind: "create",
  locator: { file: "locales/fr.json", key: "toolbar.about" },
});
actualCatalogue = parseJson<EditCatalogue>(
  await readFile(cataloguePath, "utf8"),
);
actualCatalogue.records.push({
  targetId: "external-about-target",
  text: "Externally created About",
  context: {
    file: "locales/fr.json",
    resourceKey: "toolbar.about",
    sourceLines: [22],
  },
});
await writeFile(
  cataloguePath,
  JSON.stringify(actualCatalogue, null, 2),
  "utf8",
);
const occupiedCreateResults = await applyInNewProcess("occupied-create-edit", [
  createEdit,
]);
assert.equal(
  requiredAt(occupiedCreateResults, 0, "已占用创建结果").status,
  "conflict",
);
actualCatalogue = parseJson<EditCatalogue>(
  await readFile(cataloguePath, "utf8"),
);
assert.equal(
  actualCatalogue.records.find(
    ({ context }) => context.resourceKey === "toolbar.about",
  )?.text,
  "Externally created About",
);
actualCatalogue.records = actualCatalogue.records.filter(
  ({ context }) => context.resourceKey !== "toolbar.about",
);
actualCatalogue.enumeration = "partial";
await writeFile(
  cataloguePath,
  JSON.stringify(actualCatalogue, null, 2),
  "utf8",
);
const unprocessedResults = await applyInNewProcess("unprocessed-edit", [
  createEdit,
]);
assert.equal(
  requiredAt(unprocessedResults, 0, "未处理创建结果").status,
  "unprocessed",
);
actualCatalogue = parseJson<EditCatalogue>(
  await readFile(cataloguePath, "utf8"),
);
assert.equal(
  actualCatalogue.records.some(
    ({ context }) => context.resourceKey === "toolbar.about",
  ),
  false,
);
actualCatalogue.enumeration = "complete";
await writeFile(
  cataloguePath,
  JSON.stringify(actualCatalogue, null, 2),
  "utf8",
);
const createResults = await applyInNewProcess("create-edit", [createEdit]);
assert.equal(requiredAt(createResults, 0, "创建写回结果").status, "written");
assert.equal(
  requiredAt(createResults, 0, "创建写回结果").after?.translations[0]
    ?.translation.text,
  "À propos",
);

const factsAfter = await readFacts(config);
assert.equal(
  factsAfter.associations.find(({ sourceKey }) => sourceKey === "source:18")
    ?.status,
  "matched",
);
assert.equal(
  factsAfter.associations.find(({ sourceKey }) => sourceKey === "source:19")
    ?.status,
  "matched",
);
const noLocationFacts = await readFacts(config);
const noLocation = await resolveSemanticEditInput(
  noLocationFacts,
  {
    sourceKey: "source:23",
    language: "fr",
  },
  config,
);
assert.equal(noLocation.status, "notWritable");

const candidate = {
  sourceKey: "source:18",
  language: "fr",
  content: "Default write with QA findings",
};
const quality = await analyzeQuality(config, { candidates: [candidate] });
assert.equal(quality.diagnostics.length, 1);
const beforeReject = await readFile(cataloguePath, "utf8");
const baselineBeforeReject = await baselineState();
const rejected = await prepareQualityConditionedSemanticEdit(config, {
  candidate,
  condition: (currentQuality) => currentQuality.diagnostics.length === 0,
});
assert.equal(rejected.status, "rejected");
assert.equal("preparation" in rejected, false);
assert.equal(await readFile(cataloguePath, "utf8"), beforeReject);
assert.deepEqual(await baselineState(), baselineBeforeReject);

const cachedAllowed = await prepareQualityConditionedSemanticEdit(config, {
  candidate,
  quality,
  condition: () => true,
});
assert.equal(cachedAllowed.status, "passed");
assert.equal(cachedAllowed.preparation.status, "prepared");
if (cachedAllowed.preparation.status !== "prepared")
  throw new Error("缓存候选未准备。");
assert.equal(cachedAllowed.preparation.edit.content, candidate.content);
assert.equal(await readFile(cataloguePath, "utf8"), beforeReject);
assert.deepEqual(await baselineState(), baselineBeforeReject);

let conditionCalled = false;
const mismatch = await prepareQualityConditionedSemanticEdit(config, {
  candidate: { ...candidate, content: "Changed after checking" },
  quality,
  condition: () => {
    conditionCalled = true;
    return true;
  },
});
assert.equal(mismatch.status, "input-mismatch");
assert.equal(conditionCalled, false);
assert.equal(await readFile(cataloguePath, "utf8"), beforeReject);
assert.deepEqual(await baselineState(), baselineBeforeReject);

let releaseQualityCondition: () => void = () => {};
const qualityConditionGate = new Promise<void>((resolve) => {
  releaseQualityCondition = resolve;
});
let enterQualityCondition: () => void = () => {};
const qualityConditionEntered = new Promise<void>((resolve) => {
  enterQualityCondition = resolve;
});
let checkedContent;
const raceCandidate = { ...candidate, content: "Checked package text" };
const pendingCondition = prepareQualityConditionedSemanticEdit(config, {
  candidate: raceCandidate,
  condition: async (currentQuality) => {
    checkedContent = currentQuality.candidates[0]?.content;
    enterQualityCondition();
    await qualityConditionGate;
    return true;
  },
});
await qualityConditionEntered;
raceCandidate.content = "Unchecked package text";
releaseQualityCondition();
const raceResult = await pendingCondition;
assert.equal(checkedContent, "Checked package text");
assert.equal(raceResult.status, "passed");
assert.equal(raceResult.preparation.status, "prepared");
if (raceResult.preparation.status !== "prepared")
  throw new Error("异步候选未准备。");
assert.equal(raceResult.preparation.edit.content, "Checked package text");
assert.equal(await readFile(cataloguePath, "utf8"), beforeReject);
assert.deepEqual(await baselineState(), baselineBeforeReject);

const allowed = await prepareQualityConditionedSemanticEdit(config, {
  candidate,
});
assert.equal(allowed.status, "not-required");
assert.equal(allowed.preparation.status, "prepared");
if (allowed.preparation.status !== "prepared") throw new Error("候选未准备。");
const writeResult = await applySemanticEdits(
  [allowed.preparation.edit],
  config,
);
assert.equal(writeResult.results[0]?.status, "written");
assert.deepEqual(await baselineState(), baselineBeforeReject);
const afterDefaultWrite = parseJson<EditCatalogue>(
  await readFile(cataloguePath, "utf8"),
);
assert.equal(
  afterDefaultWrite.records.find(
    ({ context }) => context.resourceKey === "shared-save-submit",
  )?.text,
  candidate.content,
);

process.stdout.write(
  "独立打包宿主：编辑跨进程、冲突、依赖失效、失败和未处理结果通过。\n",
);
process.stdout.write(
  "独立打包宿主：诊断候选默认写入，显式拒绝、缓存复用/错配及异步候选变化均受核对。\n",
);
