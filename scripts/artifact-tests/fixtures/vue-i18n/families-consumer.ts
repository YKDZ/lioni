import assert from "node:assert/strict";

import {
  analyzeQuality,
  createQualityException,
  createVueI18nChecks,
  defineConfig,
  type QualityCheckResultCache,
  type QualityException,
  type VueI18nMessageProjection,
  type VueI18nPolicy,
} from "@lioni/lioni";
import * as z from "zod";

const unitSchema = z.object({ key: z.string(), source: z.string() });
const translationSchema = z.object({ key: z.string(), text: z.string() });
type Unit = z.infer<typeof unitSchema>;
type Translation = z.infer<typeof translationSchema>;
type CacheableQualityCheckOutcome = Exclude<
  Awaited<ReturnType<QualityCheckResultCache["get"]>>,
  undefined
>;
const cache = new Map<string, CacheableQualityCheckOutcome>();
let hits = 0;
const exceptions: QualityException[] = [];
const candidate = { sourceKey: "first", language: "zh-CN", content: "激活" };

function projection(
  key: string,
  source: string,
  target: string,
): VueI18nMessageProjection {
  return {
    key,
    language: "zh-CN",
    source: { status: "available", text: source },
    target: { status: "available", text: target },
    locations: {
      source: { key, language: null, range: "en.json" },
      target: { key, language: "zh-CN", range: "zh-CN.json" },
    },
  };
}

async function run(
  records: readonly { key: string; source: string; text: string }[],
) {
  const policy: VueI18nPolicy = {
    sourceLanguage: "en",
    targetLanguage: "zh-CN",
    resources: {
      source: {
        messages: Object.fromEntries(
          records.map(({ key, source }) => [key, source]),
        ),
        range: "en.json",
      },
      target: {
        messages: Object.fromEntries(
          records.map(({ key, text }) => [key, text]),
        ),
        range: "zh-CN.json",
      },
    },
    quantities: { source: { profile: "en" }, target: { profile: "zh-CN" } },
    protectedLiterals: {},
    messageFamilies: {
      scopes: [{ scope: "ui", keys: records.map(({ key }) => key) }],
      targetEquivalences: [],
    },
  };
  const config = defineConfig({
    source: {
      schema: unitSchema,
      read: () => ({
        scopes: [
          {
            range: "en.json",
            enumeration: "complete",
            records: records.map(({ key, source }) => ({
              value: { key, source },
              bodyAvailability: "available",
            })),
          },
        ],
      }),
    },
    keyOf: ({ key }) => key,
    translations: {
      languages: ["zh-CN"],
      schema: translationSchema,
      contentSchema: z.string(),
      contentOf: ({ text }) => text,
      keyOf: ({ key }) => ({ namespace: "messages", key }),
      matches: (unit, translation) => unit.key === translation.key,
      read: () => ({
        scopes: [
          {
            range: "zh-CN.json",
            covers: records.map(({ key }) => key),
            enumeration: "complete",
            records: records.map(({ key, text }) => ({
              value: { key, text },
              bodyAvailability: "available",
            })),
          },
        ],
      }),
    },
    quality: {
      checks: createVueI18nChecks<Unit, Translation, string>({
        hostVersion: "artifact-families/v1",
        project: ({ sourceUnit, candidate }) =>
          projection(
            candidate.sourceKey,
            sourceUnit!.unit.source,
            candidate.content,
          ),
        reference: ({ sourceUnit, translation }) => {
          assert.equal(translation.bodyAvailability, "available");
          return projection(
            sourceUnit.key,
            sourceUnit.unit.source,
            translation.content!,
          );
        },
      }).filter(({ id }) => id === "message-family-consistency"),
      loadDependencies: () => ({
        vueI18n: { policies: [policy], terms: { concepts: [] } },
      }),
      resultCache: {
        async get(key: string) {
          const value = cache.get(key);
          if (value !== undefined) hits += 1;
          return value;
        },
        async set(key: string, value: CacheableQualityCheckOutcome) {
          cache.set(key, value);
        },
      },
      exceptionStore: {
        async load() {
          return exceptions;
        },
        async upsert() {
          throw new Error("消费验收只读取例外。");
        },
      },
    },
  });
  return await analyzeQuality(config, { candidates: [candidate] });
}

const first = { key: "first", source: "Active", text: "旧译文" };
const second = { key: "second", source: "Active", text: "有效" };
const other = { key: "other", source: "Delete", text: "删除" };
const before = await run([first, second, other]);
assert.equal(before.diagnostics.length, 1);
const execution = before.checks[0]?.executions[0];
assert.ok(execution);
exceptions.push(
  createQualityException({
    id: "family-approval",
    reason: "批准当前同族译法差异",
    execution,
  }),
);

// 重排和编辑不同族的已保存消息，不改变当前参照身份、位置及缓存依据。
const after = await run([{ ...other, text: "移除" }, second, first]);
assert.equal(hits, 1);
assert.equal(after.exceptionApplicability[0]?.status, "applicable");
assert.equal(after.diagnostics[0]?.handling.status, "excepted");
assert.deepEqual(
  after.diagnostics[0]?.evidence,
  before.diagnostics[0]?.evidence,
);

// 同族参照改变但仍产生同一类别诊断，必须重新计算并撤销本次豁免。
const changed = await run([first, { ...second, text: "启用" }, other]);
assert.equal(hits, 1);
assert.equal(changed.exceptionApplicability[0]?.status, "basis-changed");
assert.equal(changed.diagnostics.length, 1);
assert.notDeepEqual(
  changed.diagnostics[0]?.evidence,
  before.diagnostics[0]?.evidence,
);
const restored = await run([first, second, other]);
assert.equal(hits, 2);
assert.equal(restored.exceptionApplicability[0]?.status, "applicable");
