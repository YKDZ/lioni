import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  analyzeQuality,
  readFacts,
  type JsonValue,
  type TranslationWriteRequest,
  writeTranslationRequests,
} from "@lioni/core";

import config from "./edits.config.ts";
import { parseJson } from "./schemas.ts";

type Unit = {
  source: string;
  context: {
    identity: string;
    line: number;
    targetKey: string;
    screenshot: string;
  };
};
type Record = {
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
type Catalogue = {
  enumeration: "complete" | "partial";
  records: Record[];
  unrelated?: unknown;
};
type WriteResult = { readonly status: string; readonly reason?: string };

function requiredAt<T>(values: readonly T[], index: number, label: string): T {
  const value = values[index];
  assert.ok(value, `缺少预期的 ${label}。`);
  return value;
}

async function requestFor(
  sourceKey: string,
  content: string,
): Promise<TranslationWriteRequest<string, Unit>> {
  const facts = await readFacts(config);
  const sourceUnit = facts.source.units.find(({ key }) => key === sourceKey);
  assert.ok(sourceUnit);
  if (sourceUnit === undefined) throw new Error(`缺少原文 ${sourceKey}。`);
  const range = facts.source.read.scopes[sourceUnit.scopeIndex]?.range;
  assert.ok(range !== undefined);
  const expectedSource = {
    presence: "present" as const,
    key: sourceKey,
    unit: sourceUnit.unit,
    content: sourceUnit.unit.source,
    range: range as JsonValue,
  };
  const association = facts.associations.find(
    ({ sourceKey: key, language }) => key === sourceKey && language === "fr",
  );
  assert.ok(association);
  if (association === undefined)
    throw new Error(`缺少 ${sourceKey} 的关联事实。`);
  if (association.status === "missing")
    return {
      operation: "write",
      target: { sourceKey, language: "fr" },
      content,
      expectedSource,
      expectedTarget: { status: "missing" },
    };
  if (
    association.status !== "matched" ||
    association.translationIndexes.length !== 1
  )
    throw new Error(
      `原文 ${sourceKey} 关联状态不是唯一匹配：${association.status}`,
    );
  const target = facts.translations.records[association.translationIndexes[0]!];
  assert.ok(target && target.bodyAvailability === "available");
  if (target === undefined || target.bodyAvailability !== "available")
    throw new Error(`原文 ${sourceKey} 的目标译文不可用。`);
  return {
    operation: "write",
    target: { identity: target.identity },
    content,
    expectedSource,
    expectedTarget: {
      status: "present",
      identity: target.identity,
      content: target.content,
      range: target.range as JsonValue,
      record: target.translation,
    },
  };
}

async function applyInNewProcess(
  name: string,
  requests: readonly TranslationWriteRequest<string, Unit>[],
): Promise<readonly WriteResult[]> {
  const requestPath = path.join(process.cwd(), name + ".json");
  await writeFile(requestPath, JSON.stringify(requests), "utf8");
  const child = spawnSync(process.execPath, ["edit-apply.ts", requestPath], {
    encoding: "utf8",
  });
  assert.equal(child.status, 0, child.stderr);
  const saved = parseJson<{
    readonly results: readonly WriteResult[];
  }>(await readFile(requestPath + ".result.json", "utf8"));
  return saved.results;
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

const firstShared = await requestFor("source:18", "First shared proposal");
const secondShared = await requestFor("source:19", "Second shared proposal");
const conflicting = await applyInNewProcess("shared-conflicts", [
  firstShared,
  secondShared,
]);
assert.deepEqual(
  conflicting.map(({ status }) => status),
  ["conflict", "conflict"],
);
let catalogue = parseJson<Catalogue>(await readFile(cataloguePath, "utf8"));
assert.equal(catalogue.records[0]?.text, "Shared original");

const firstWrite = await applyInNewProcess("shared-first-write", [firstShared]);
assert.equal(firstWrite[0]?.status, "written");
const staleShared = await applyInNewProcess("shared-second-write", [
  secondShared,
]);
assert.equal(staleShared[0]?.status, "conflict");
catalogue = parseJson<Catalogue>(await readFile(cataloguePath, "utf8"));
assert.equal(catalogue.records[0]?.text, "First shared proposal");
assert.deepEqual(catalogue.unrelated, { preserve: "original resource entry" });

const staleTarget = await requestFor("source:18", "Must not overwrite edit");
catalogue.records[0]!.text = "External target edit";
await writeFile(cataloguePath, JSON.stringify(catalogue), "utf8");
assert.equal(
  (await applyInNewProcess("stale-target", [staleTarget]))[0]?.status,
  "conflict",
);

const staleSource = await requestFor(
  "source:18",
  "Must not overwrite source change",
);
const sources = parseJson<Unit[]>(await readFile(sourcesPath, "utf8"));
requiredAt(sources, 0, "原文资源首项").source = "Changed source";
await writeFile(sourcesPath, JSON.stringify(sources), "utf8");
assert.equal(
  (await applyInNewProcess("stale-source", [staleSource]))[0]?.status,
  "conflict",
);
requiredAt(sources, 0, "恢复的原文").source = "Save";
await writeFile(sourcesPath, JSON.stringify(sources), "utf8");

catalogue.records.push({
  targetId: "duplicate-cancel-target",
  text: "Second cancel translation",
  context: {
    file: "locales/fr.json",
    resourceKey: "duplicate-cancel",
    sourceLines: [20],
  },
});
await writeFile(cataloguePath, JSON.stringify(catalogue), "utf8");
assert.equal(
  (await readFacts(config)).associations.find(
    ({ sourceKey }) => sourceKey === "source:20",
  )?.status,
  "conflict",
);
catalogue.records = catalogue.records.filter(
  ({ context }) => context.resourceKey !== "duplicate-cancel",
);
catalogue.records.find(
  ({ targetId }) => targetId === "cancel-target",
)!.context.readOnly = true;
await writeFile(cataloguePath, JSON.stringify(catalogue), "utf8");
assert.equal(
  (
    await applyInNewProcess("readonly-write", [
      await requestFor("source:20", "No write"),
    ])
  )[0]?.status,
  "notWritable",
);

const failedWrite = await applyInNewProcess("failed-write", [
  await requestFor("source:21", "Host rejects write"),
]);
assert.equal(failedWrite[0]?.status, "writeFailed");
assert.match(failedWrite[0]?.reason ?? "", /拒绝保存/iu);
const ignoredWrite = await applyInNewProcess("ignored-write", [
  await requestFor("source:24", "Host ignores write"),
]);
assert.equal(ignoredWrite[0]?.status, "writeUnconfirmed");

const createRequest = await requestFor("source:22", "À propos");
catalogue.records.push({
  targetId: "external-about-target",
  text: "Externally created About",
  context: {
    file: "locales/fr.json",
    resourceKey: "toolbar.about",
    sourceLines: [22],
  },
});
await writeFile(cataloguePath, JSON.stringify(catalogue), "utf8");
assert.equal(
  (await applyInNewProcess("occupied-create", [createRequest]))[0]?.status,
  "conflict",
);
catalogue.records = catalogue.records.filter(
  ({ context }) => context.resourceKey !== "toolbar.about",
);
await writeFile(cataloguePath, JSON.stringify(catalogue), "utf8");
assert.equal(
  (await applyInNewProcess("create-write", [createRequest]))[0]?.status,
  "written",
);
assert.equal(
  (
    await applyInNewProcess("unlocatable-create", [
      await requestFor("source:23", "No physical key"),
    ])
  )[0]?.status,
  "notWritable",
);

const candidate = {
  sourceKey: "source:18",
  language: "fr",
  content: "QA gated proposal",
};
const quality = await analyzeQuality(config, { candidates: [candidate] });
assert.equal(quality.diagnostics.length, 1);
const qaRequest = await requestFor(candidate.sourceKey, candidate.content);
const beforeRejectedWrite = await readFile(cataloguePath, "utf8");
const rejected = await writeTranslationRequests(
  [qaRequest],
  config,
  () => quality.diagnostics.length === 0,
);
assert.equal(rejected.results[0]?.status, "conflict");
assert.equal(await readFile(cataloguePath, "utf8"), beforeRejectedWrite);

process.stdout.write(
  "独立打包宿主：写入请求跨进程、目标身份、条件核对、冲突和回读确认通过。\n",
);
