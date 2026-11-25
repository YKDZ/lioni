import assert from "node:assert/strict";

import {
  createQaSuppression,
  defineChecker,
  defineConfig,
  readProjectSnapshot,
  runQa,
  type QualityCheckResultCache,
  type QualityFinding,
  type SourceUnit,
  type StandardSchemaV1,
  type Translation,
  type TranslationCandidate,
} from "@boringparts/lioni";
import { z } from "zod";

type Unit = { source: string; context: { file: string } };
// 专门验证非 Zod、异步的标准协议接入；普通业务夹具由其宿主选择 Zod。
const sourceSchema: StandardSchemaV1<Unit> = {
  "~standard": {
    version: 1,
    vendor: "consumer-protocol",
    async validate(value) {
      if (
        typeof value === "object" &&
        value !== null &&
        "source" in value &&
        typeof value.source === "string" &&
        "context" in value &&
        typeof value.context === "object" &&
        value.context !== null &&
        "file" in value.context &&
        typeof value.context.file === "string"
      )
        return { value: value as Unit };
      return { issues: [{ path: ["source"], message: "原文单元格式无效。" }] };
    },
  },
};
const input = { source: "Save", context: { file: "messages.ts" } };
const config = defineConfig({
  source: {
    schema: sourceSchema,
    read: () => ({
      scopes: [
        {
          range: "source",
          enumeration: "complete",
          records: [{ value: input, bodyAvailability: "available" }],
        },
      ],
    }),
  },
  keyOf: ({ source }) => source,
});
const snapshot = await readProjectSnapshot(config);
assert.deepEqual(snapshot.source.units[0]?.unit, input);

const checker = defineChecker.withTypes<Unit, Unit, string>()({
  id: "action-copy",
  version: "1",
  inputSchema: z
    .object({
      key: z.string(),
      language: z.string(),
      file: z.string(),
      text: z.string(),
      expected: z.string(),
    })
    .nullable(),
  load() {
    const index: ReadonlyMap<string, string> = new Map([
      ["Save", "Enregistrer"],
    ]);
    return {
      lookup: (key: string) => index.get(key),
      index,
      runtimeMarker: "runtime-only-checker-context",
    };
  },
  prepare({ candidate, sourceUnit, loaded }) {
    if (candidate === null) return null;
    const expected = loaded.lookup(candidate.sourceKey);
    if (expected === undefined) return null;
    return {
      key: candidate.sourceKey,
      language: candidate.language,
      file: sourceUnit.unit.context.file,
      text: candidate.content,
      expected,
    };
  },
  check(input): readonly QualityFinding[] {
    if (input === null) return [];
    const { key, language, file, text, expected } = input;
    return text === expected
      ? []
      : [
          {
            severity: "warning",
            object: { kind: "translation-unit", key, language },
            location: { language, range: file },
            message: `请使用 ${expected}。`,
            evidence: [],
          },
        ];
  },
});

const qaConfig = defineConfig({
  source: config.source,
  keyOf: config.keyOf,
  translations: {
    languages: ["fr"],
    schema: sourceSchema,
    contentSchema: z.string(),
    keyOf: () => "Save",
    contentOf: ({ source }) => source,
    read: () => ({ scopes: [] }),
  },
  quality: { checks: [checker] },
});
const result = await runQa(qaConfig, {
  checkIds: ["action-copy"],
  candidates: [{ sourceKey: "Save", language: "fr", content: "Sauver" }],
});
assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
assert.equal(result.diagnostics[0]?.message, "请使用 Enregistrer。");
assert.equal(result.diagnostics[0]?.location.range, "messages.ts");
assert.doesNotMatch(JSON.stringify(result), /runtime-only-checker-context/u);
assert.deepEqual(
  Object.keys(result.checks[0]?.executions[0]?.fingerprintSummary ?? {}).sort(),
  ["inputFingerprint", "version"],
);

// 自定义检查器与缓存协同场景：公开类型区分 SourceUnit / Translation（record vs content）/ TranslationCandidate，
// 规则检查与现存译文不同的候选，缓存命中时重新应用新豁免，默认裁剪零诊断 executions。
type CustomUnit = {
  readonly source: string;
  readonly context: { readonly file: string };
};
type CustomRecord = {
  readonly id: string;
  readonly text: string;
  readonly hostMeta: string;
};
const customRecordSchema: StandardSchemaV1<CustomRecord> = {
  "~standard": {
    version: 1,
    vendor: "consumer-protocol",
    validate(value) {
      if (
        typeof value === "object" &&
        value !== null &&
        "id" in value &&
        typeof value.id === "string" &&
        "text" in value &&
        typeof value.text === "string" &&
        "hostMeta" in value &&
        typeof value.hostMeta === "string"
      )
        return { value: value as CustomRecord };
      return { issues: [{ message: "译文记录格式无效。" }] };
    },
  },
};
const cacheStore = new Map<
  string,
  NonNullable<Awaited<ReturnType<QualityCheckResultCache["get"]>>>
>();
const memoryCache: QualityCheckResultCache = {
  get: async (key) => cacheStore.get(key),
  set: async (key, value) => {
    cacheStore.set(key, value);
  },
};
let candidateRuleCalls = 0;
let cleanRuleCalls = 0;
const customCandidateCheck = defineChecker.withTypes<
  CustomUnit,
  CustomRecord,
  string,
  never
>()({
  id: "custom-candidate-diff",
  version: "1",
  inputSchema: z.object({
    key: z.string(),
    language: z.string(),
    source: z.string(),
    savedMeta: z.string(),
    savedContent: z.string(),
    candidateText: z.string(),
  }),
  prepare(input) {
    const unit: SourceUnit<CustomUnit> = input.sourceUnit;
    if (input.translation === null || input.candidate === null)
      throw new Error("预期同时存在现存译文与送检候选。");
    const saved: Translation<CustomRecord, string> = input.translation;
    const candidate: TranslationCandidate<string> = input.candidate;
    assert.ok(saved.bodyAvailability === "available");
    return {
      key: unit.key,
      language: candidate.language,
      source: unit.unit.source,
      savedMeta: saved.record.hostMeta,
      savedContent: saved.content,
      candidateText: candidate.content,
    };
  },
  check(input): readonly QualityFinding[] {
    candidateRuleCalls += 1;
    // 明确检查送检候选正文（candidateText），而非现存译文（savedContent）。
    if (input.candidateText === "Enregistrer") return [];
    return [
      {
        severity: "warning",
        object: {
          kind: "translation-unit",
          key: input.key,
          language: input.language,
        },
        location: { language: input.language, range: input.savedMeta },
        message: `候选 ${input.candidateText} 与期望不符（现存 ${input.savedContent}）。`,
        evidence: [],
      },
    ];
  },
});
const customCleanCheck = defineChecker.withTypes<
  CustomUnit,
  CustomRecord,
  string,
  never
>()({
  id: "custom-clean",
  version: "1",
  inputSchema: z.string(),
  prepare: ({ association }) => association.sourceKey,
  check() {
    cleanRuleCalls += 1;
    return [];
  },
});
let activeSuppressions: readonly ReturnType<typeof createQaSuppression>[] = [];
const customConfig = defineConfig({
  source: config.source,
  keyOf: config.keyOf,
  translations: {
    languages: ["fr"],
    schema: customRecordSchema,
    contentSchema: z.string(),
    keyOf: ({ id }) => id,
    contentOf: ({ text }) => text,
    read: () => ({
      scopes: [
        {
          range: "fr.json",
          enumeration: "complete",
          covers: ["Save"],
          records: [
            {
              value: {
                id: "Save",
                text: "Enregistrer",
                hostMeta: "host-record-meta",
              },
              bodyAvailability: "available",
            },
          ],
        },
      ],
    }),
  },
  quality: {
    checks: [customCandidateCheck, customCleanCheck],
    resultCache: memoryCache,
    suppressionStore: {
      load: async () => activeSuppressions,
      upsert: async () => {},
    },
  },
});
const diffCandidates: readonly TranslationCandidate<string>[] = [
  { sourceKey: "Save", language: "fr", content: "Sauver" },
];
const coldRun = await runQa(customConfig, { candidates: diffCandidates });
assert.equal(candidateRuleCalls, 1);
assert.equal(cleanRuleCalls, 1);
assert.equal(coldRun.checkScope.evaluatedCount, 2);
assert.equal(coldRun.diagnostics.length, 1);
assert.match(
  coldRun.diagnostics[0]?.message ?? "",
  /候选 Sauver 与期望不符（现存 Enregistrer）/u,
);
assert.equal(coldRun.diagnostics[0]?.location.range, "host-record-meta");
assert.equal(coldRun.diagnostics[0]?.handling.status, "active");
assert.equal(coldRun.checks[0]?.executions.length, 1);
assert.deepEqual(coldRun.checks[1]?.executions, []);

// 缓存命中时重新应用新豁免，不重复调用规则检查函数。
const coldExec = coldRun.checks[0]?.executions[0];
assert.ok(coldExec);
activeSuppressions = [
  createQaSuppression({
    id: "accept-sauver-draft",
    reason: "缓存命中后按新豁免接受草稿。",
    execution: coldExec,
  }),
];
const warmRun = await runQa(customConfig, { candidates: diffCandidates });
assert.equal(candidateRuleCalls, 1);
assert.equal(cleanRuleCalls, 1);
assert.equal(warmRun.checkScope.evaluatedCount, 2);
assert.equal(warmRun.diagnostics[0]?.handling.status, "suppressed");
if (warmRun.diagnostics[0]?.handling.status === "suppressed") {
  assert.equal(
    warmRun.diagnostics[0].handling.suppressionId,
    "accept-sauver-draft",
  );
  assert.equal(
    warmRun.diagnostics[0].handling.reason,
    "缓存命中后按新豁免接受草稿。",
  );
}
assert.deepEqual(warmRun.checks[1]?.executions, []);
