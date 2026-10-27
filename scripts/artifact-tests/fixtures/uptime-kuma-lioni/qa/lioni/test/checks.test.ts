import assert from "node:assert/strict";
import { test } from "node:test";

import {
  analyzeQuality,
  defineConfig,
  type StandardSchemaV1,
} from "@lioni/core";

import { createKumaQualityRequest, type KumaFacts } from "../adapter.ts";
import { createKumaAnalysis } from "../analysis.ts";
import { createKumaQualityChecks } from "../checks/index.ts";
function createKumaChecks(project: Project) {
  return createKumaQualityChecks(project, createKumaAnalysis());
}

function createKumaConfig(input: Policy | readonly Policy[]) {
  const policies = Array.isArray(input) ? input : [input as Policy];
  const project: Project = {
    policies,
    terms: policies[0]!.terms,
    usages: policies[0]!.usages,
  };
  const byLanguage = new Map(
    policies.map((policy) => [policy.targetLanguage, policy]),
  );
  return defineConfig({
    source: {
      schema: schema<Unit>(
        (value): value is Unit =>
          isRecord(value) &&
          typeof value.key === "string" &&
          isRecord(value.source) &&
          typeof value.source.text === "string",
      ),
      read: () => ({
        scopes: [
          {
            range: policies[0]!.sourceRange,
            enumeration: "complete",
            records: (
              Object.entries(policies[0]!.source) as [string, string][]
            ).map(([key, text]) => ({
              value: { key, source: { text } },
              bodyAvailability: "available",
            })),
          },
        ],
      }),
    },
    keyOf: (unit) => unit.key,
    translations: {
      languages: policies.map((policy) => policy.targetLanguage),
      schema: schema<Translation>(
        (value): value is Translation =>
          isRecord(value) &&
          typeof value.key === "string" &&
          typeof value.text === "string" &&
          typeof value.language === "string",
      ),
      contentSchema: schema<Body>(
        (value): value is Body =>
          isRecord(value) && typeof value.text === "string",
      ),
      contentOf: (translation) => ({ text: translation.text }),
      identityOf: (translation, language) => ({
        namespace:
          byLanguage.get(language)?.targetRange ?? `fixtures/${language}.json`,
        key: translation.key,
      }),
      matches: (unit, translation) => unit.key === translation.key,
      read: (language, units) => {
        const policy = byLanguage.get(language);
        if (!policy) throw new Error(`未配置目标语言 ${language}。`);
        return {
          scopes: [
            {
              range: policy.targetRange,
              covers: units.map((unit) => unit.key),
              enumeration: "complete",
              records: (
                Object.entries(policy.target) as [string, string][]
              ).map(([key, text]) => ({
                value: { key, text, language },
                bodyAvailability: "available",
              })),
            },
          ],
        };
      },
    },
    qualityChecks: createKumaChecks(project),
    createQualityRequest: (facts) =>
      createKumaQualityRequest(project, facts as KumaFacts),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function schema<T>(
  validate: (value: unknown) => value is T,
): StandardSchemaV1<T, T> {
  return {
    "~standard": {
      version: 1,
      vendor: "kuma-check-tests",
      validate: (value) =>
        validate(value)
          ? { value }
          : { issues: [{ message: "输入结构无效。" }] },
    },
  };
}

import { readFileSync } from "node:fs";

import type {
  Policy,
  Project,
  LanguageMetadata,
  MessagePolicy,
  Unit,
  Translation,
  Body,
} from "../model.ts";
const metadata = (language: string): LanguageMetadata =>
  JSON.parse(
    readFileSync(
      new URL(`../../../src/lang/lioni/${language}.json`, import.meta.url),
      "utf8",
    ),
  );
const shared: MessagePolicy = JSON.parse(
  readFileSync(
    new URL("../../../src/lang/lioni/messages.json", import.meta.url),
    "utf8",
  ),
);
const sourceMetadata = metadata("en");
const targetMetadata = metadata("zh-CN");
const basePolicy: Policy = {
  ...shared,
  source: {},
  target: {},
  terms: { concepts: [] },
  usages: { entries: [], unresolved: [], errors: [] },
  sourceLanguage: "en",
  targetLanguage: "zh-CN",
  sourceRange: "fixtures/en.json",
  targetRange: "fixtures/zh-CN.json",
  sourceQuantityProfile: "en",
  targetQuantityProfile: "zh-CN",
  targetEquivalences: targetMetadata.equivalences ?? [],
  quantityUnitAliases: sourceMetadata.quantityUnitAliases ?? {},
  quantityDefaultUnits: sourceMetadata.quantityDefaultUnits ?? {},
  targetQuantityUnitAliases: targetMetadata.quantityUnitAliases ?? {},
  targetQuantityDefaultUnits: targetMetadata.quantityDefaultUnits ?? {},
  sourceQuantityIgnoredLiterals: sourceMetadata.quantityIgnoredLiterals ?? {},
  targetQuantityIgnoredLiterals: targetMetadata.quantityIgnoredLiterals ?? {},
};
async function run(
  source: string,
  target: string,
  patch: Partial<Policy> = {},
  key = "label",
) {
  const policy: Policy = {
    ...basePolicy,
    source: { [key]: source },
    target: { [key]: target },
    terms: { concepts: [] },
    usages: { entries: [], unresolved: [], errors: [] },
    literals: {},
    ...patch,
  };
  return analyzeQuality(createKumaConfig(policy), {
    candidates: [
      {
        sourceKey: key,
        language: "zh-CN",
        content: { text: target },
      },
    ],
  });
}
const codes = (result: Awaited<ReturnType<typeof run>>) =>
  result.diagnostics.map((d) => d.object.code);
const diagnosticsFor = (
  result: Awaited<ReturnType<typeof run>>,
  checkId: string,
) => result.diagnostics.filter((diagnostic) => diagnostic.checkId === checkId);
void test("Kuma 变量对应保留 n 与 count 的身份差异", async () => {
  const result = await run("{n} item | {count} items", "{count} 项");
  const diagnostics = result.diagnostics.filter(
    (diagnostic) => diagnostic.checkId === "vue-i18n/variable-correspondence",
  );
  assert.equal(diagnostics.length, 1);
  assert.equal(
    result.checks.find(
      (check) => check.checkId === "vue-i18n/variable-correspondence",
    )?.status,
    "complete",
  );
});
void test("变量重排允许但重复次数仍需一致", async () => {
  assert.equal(
    diagnosticsFor(
      await run("Hello {name}, {0}", "{0}，你好 {name}"),
      "vue-i18n/variable-correspondence",
    ).length,
    0,
  );
  assert.equal(
    diagnosticsFor(
      await run("Hello {name}, {0}", "你好 {name}"),
      "vue-i18n/variable-correspondence",
    ).length,
    1,
  );
  assert.equal(
    diagnosticsFor(
      await run("{name}{name}", "{name}"),
      "vue-i18n/variable-correspondence",
    ).length,
    1,
  );
});
void test("中文可以合并英文复数分支且字面转义不作为变量", async () => {
  assert.equal(
    diagnosticsFor(
      await run("{n} monitor | {n} monitors", "{n} 个监控项"),
      "vue-i18n/variable-correspondence",
    ).length,
    0,
  );
  assert.equal(
    diagnosticsFor(
      await run("Email {'@'} {name}", "邮箱 {'@'} {name}"),
      "vue-i18n/variable-correspondence",
    ).length,
    0,
  );
  assert.equal(
    diagnosticsFor(
      await run("{n} monitor | {n} monitors", "监控项"),
      "vue-i18n/variable-correspondence",
    ).length,
    1,
  );
});
void test("原译语法独立报告且变量语法无效时不比较", async () => {
  const result = await run("Hi {name", "你好 {name");
  assert.equal(diagnosticsFor(result, "vue-i18n/source-syntax").length, 1);
  assert.equal(diagnosticsFor(result, "vue-i18n/target-syntax").length, 1);
  assert.equal(
    diagnosticsFor(result, "vue-i18n/variable-correspondence").length,
    0,
  );
  assert.equal(
    result.checks.find(
      (check) => check.checkId === "vue-i18n/variable-correspondence",
    )?.status,
    "incomplete",
  );
  const sourceFinding = diagnosticsFor(result, "vue-i18n/source-syntax")[0]!;
  assert.equal(sourceFinding.location.language, null);
  assert.equal(sourceFinding.location.range, "fixtures/en.json");
  assert.ok(sourceFinding.location.span);
});
void test("源消息语法无效时数量检查不报告已完成", async () => {
  const result = await run("Wait {n", "Wait");
  const quantity = result.checks.find(
    (check) => check.checkId === "kuma/quantities",
  );
  assert.ok(quantity);
  assert.deepEqual(
    {
      status: quantity.status,
      coverage: quantity.coverage,
      issueCodes: quantity.issues.map(({ code }) => code),
      syntaxDiagnosticCount: diagnosticsFor(result, "vue-i18n/source-syntax")
        .length,
      quantityDiagnosticCount: diagnosticsFor(result, "kuma/quantities").length,
    },
    {
      status: "incomplete",
      coverage: {
        selected: 1,
        evaluated: 0,
        notApplicable: 0,
        incomplete: 1,
        failed: 0,
      },
      issueCodes: ["invalid-message-syntax"],
      syntaxDiagnosticCount: 1,
      quantityDiagnosticCount: 0,
    },
  );
});
void test("译文变量差异与关联目标缺失由独立检查报告", async () => {
  assert.equal(
    diagnosticsFor(
      await run("Hi {name}", "你好 {other}"),
      "vue-i18n/variable-correspondence",
    ).length,
    1,
  );
  assert.equal(
    diagnosticsFor(
      await run("Hello", "@:missing.key"),
      "kuma/vue-message-link-target-exists",
    ).length,
    1,
  );
});
import { extractUsages } from "../usages.ts";
void test("调用参数和组件槽位从Vue语法树取得并核对", async () => {
  const usages = extractUsages(
    `<template><i18n-t keypath="label"><template #link><a>文档</a></template></i18n-t></template>`,
    "src/pages/Docs.vue",
  );
  assert.equal(usages.errors.length, 0);
  assert.deepEqual(
    codes(await run("See {link}", "参见{link}", { usages })),
    [],
  );
  assert.ok(
    codes(await run("See {link}", "参见{code}", { usages })).includes(
      "call-argument-missing",
    ),
  );
  const calls = extractUsages(
    `const x = t('label', ['value']); t(dynamicKey, params)`,
    "src/demo.ts",
  );
  assert.equal(calls.unresolved.length, 1);
  assert.deepEqual(
    codes(await run("Value {0}", "值{0}", { usages: calls })),
    [],
  );
  assert.ok(
    codes(await run("Value {0}", "值{1}", { usages: calls })).includes(
      "call-argument-missing",
    ),
  );
  const unknownArguments = extractUsages(`t('label', params)`, "src/demo.ts");
  const incomplete = await run("Value {0}", "值{0}", {
    usages: unknownArguments,
  });
  assert.equal(
    incomplete.checks.find(
      (check) => check.checkId === "kuma/vue-message-call-arguments",
    )?.status,
    "incomplete",
  );
});
void test("消息别名循环会阻止运行时无限递归", async () => {
  assert.ok(
    codes(await run("Hello", "@:label")).includes("linked-message-cycle"),
  );
});
void test("关联循环使用当前候选正文覆盖已保存正文", async () => {
  const result = await run("Hello", "@:label", {
    target: { label: "已保存正文" },
  });
  assert.equal(diagnosticsFor(result, "kuma/vue-message-link-cycle").length, 1);
});
void test("技术标识符必须保留，不能用含相同子串的新标识符替代", async () => {
  const literals = { label: ["monitor_id"] };
  assert.deepEqual(
    codes(await run("Use monitor_id", "使用 monitor_id", { literals })),
    [],
  );
  assert.ok(
    codes(await run("Use monitor_id", "使用 monitorId", { literals })).includes(
      "protected-literal-missing",
    ),
  );
  assert.ok(
    codes(
      await run("Use monitor_id", "使用 old_monitor_id", { literals }),
    ).includes("protected-literal-missing"),
  );
});
void test("数值检查允许中文数词、等价时间换算及减少重复提及", async () => {
  assert.deepEqual(
    codes(
      await run("2FA expires after 1 hour", "二次验证在一小时后过期", {
        targetQuantityIgnoredLiterals: { label: ["二次验证"] },
      }),
    ),
    [],
  );
  assert.deepEqual(codes(await run("Wait 2000 milliseconds", "等待2秒")), []);
  assert.deepEqual(
    codes(
      await run(
        "6 parts, 153 x 6 = 918 characters",
        "最多6段，每段153字符，共918字符",
      ),
    ),
    [],
  );
  assert.deepEqual(
    codes(await run("2nd Last Day of Month", "每月倒数第二天")),
    [],
  );
});
void test("数值、负号和单位发生改变会报告", async () => {
  assert.ok(
    codes(await run("Max 25000 recipients", "最多250 00个收件人")).includes(
      "quantity-mismatch",
    ),
  );
  assert.ok(
    codes(await run("Wait 20 seconds", "等待20分钟")).includes(
      "quantity-mismatch",
    ),
  );
  assert.ok(
    codes(await run("Use -1 to disable", "使用1禁用")).includes(
      "quantity-mismatch",
    ),
  );
});
void test("数字插值不被误当常量，变量前后数字不拼接", async () => {
  assert.deepEqual(codes(await run("Wait {0} seconds", "等待{0}秒")), []);
  assert.deepEqual(codes(await run("1{name}2", "1{name} 2")), []);
});
void test("资源缺译和中文独有键分别报告", async () => {
  assert.ok(
    codes(await run("Hello", "", { target: {} })).includes(
      "missing-translation",
    ),
  );
  assert.ok(
    codes(await run("", "旧键", { source: {} })).includes("target-only-key"),
  );
  assert.ok(codes(await run("Hello", "   ")).includes("empty-translation"));
});
void test("缺译占位不参与变量检查，已保存的空译文仍按真实候选检查", async () => {
  const missing = await analyzeQuality(
    createKumaConfig({
      ...basePolicy,
      source: { label: "Hello {name}" },
      target: {},
    }),
  );
  assert.equal(
    missing.checks.find(
      (check) => check.checkId === "vue-i18n/variable-correspondence",
    )?.status,
    "not-applicable",
  );
  assert.ok(
    missing.diagnostics.some(
      (diagnostic) =>
        diagnostic.checkId === "kuma/resource-contract" &&
        diagnostic.object.code === "missing-translation",
    ),
  );

  const empty = await analyzeQuality(
    createKumaConfig({
      ...basePolicy,
      source: { label: "Hello {name}" },
      target: { label: "" },
    }),
  );
  assert.equal(
    diagnosticsFor(empty, "vue-i18n/variable-correspondence").length,
    1,
  );

  const explicitConfig = createKumaConfig({
    ...basePolicy,
    source: { label: "Hello {name}" },
    target: {},
  });
  for (const text of ["", "新的实际译文"]) {
    const explicitCandidate = await analyzeQuality(explicitConfig, {
      candidates: [
        {
          sourceKey: "label",
          language: "zh-CN",
          content: { text },
        },
      ],
    });
    assert.equal(
      diagnosticsFor(explicitCandidate, "vue-i18n/variable-correspondence")
        .length,
      1,
    );
  }
});
void test("领域禁用词由正式术语规则检查，允许译法保持通过", async () => {
  const terms: Policy["terms"] = {
    concepts: [
      {
        id: "monitor",
        languages: [
          {
            language: "en",
            expressions: [{ id: "en", text: "monitor", usage: "preferred" }],
          },
          {
            language: "zh-CN",
            expressions: [
              { id: "zh", text: "监控项", usage: "preferred" },
              { id: "bad", text: "显示器", usage: "forbidden" },
            ],
          },
        ],
      },
    ],
  };
  assert.deepEqual(codes(await run("monitor", "监控项", { terms })), []);
  assert.ok(
    codes(await run("monitor", "显示器", { terms })).includes(
      "forbidden-translation",
    ),
  );
});
void test("不同业务的同形消息不互相约束，同范围差异仍提示", async () => {
  const policy: Policy = {
    ...basePolicy,
    source: { Active: "Active", "apiKey-active": "Active" },
    target: { Active: "激活", "apiKey-active": "有效" },
    terms: { concepts: [] },
    usages: { entries: [], unresolved: [], errors: [] },
    literals: {},
  };
  let result = await analyzeQuality(createKumaConfig(policy), {
    candidates: [
      {
        sourceKey: "Active",
        language: "zh-CN",
        content: { text: "激活" },
      },
    ],
  });
  assert.equal(
    result.diagnostics.filter((d) => d.checkId === "message-family-consistency")
      .length,
    0,
  );
  const shared = {
    ...policy,
    source: { "From Email": "From Email", resendFromEmail: "From Email" },
    target: { "From Email": "发信人", resendFromEmail: "发件邮箱地址" },
  };
  result = await analyzeQuality(createKumaConfig(shared), {
    candidates: [
      {
        sourceKey: "From Email",
        language: "zh-CN",
        content: { text: "发信人" },
      },
    ],
  });
  assert.equal(
    result.diagnostics.filter((d) => d.checkId === "message-family-consistency")
      .length,
    1,
  );
});
void test("推送URL的明确合法空格差异不产生消息族警告", async () => {
  const policy: Policy = {
    ...basePolicy,
    source: { "Push URL": "Push URL", PushUrl: "Push URL" },
    target: { "Push URL": "推送 URL", PushUrl: "推送URL" },
    terms: { concepts: [] },
    usages: { entries: [], unresolved: [], errors: [] },
    literals: {},
  };
  const result = await analyzeQuality(createKumaConfig(policy), {
    candidates: [
      {
        sourceKey: "Push URL",
        language: "zh-CN",
        content: { text: "推送 URL" },
      },
    ],
  });
  assert.equal(result.diagnostics.length, 0);
});
void test("真实文本中的区间、句末数字、存储缩写与约数不产生误报", async () => {
  assert.deepEqual(
    codes(
      await run("Default: 1024 (1KB)", "默认1024（1 KiB）", {
        quantityUnitAliases: { label: { KB: "KiB" } },
      }),
    ),
    [],
  );
  assert.deepEqual(codes(await run("3..=11 characters", "3到11个字符")), []);
  assert.deepEqual(
    codes(
      await run("Local 7-digit numbers use 960.", "本地7位号码使用960前缀"),
    ),
    [],
  );
  assert.deepEqual(
    codes(
      await run(
        "Thousands of probes, 250 tests per hour",
        "数千个探针，每小时250次测试",
      ),
    ),
    [],
  );
  assert.deepEqual(
    codes(
      await run(
        "Emergency priority (2) has 30 second timeout between retries and expires after 1 hour.",
        "紧急优先级（2）会在一小时内每隔30秒重试一次。",
      ),
    ),
    [],
  );
});
void test("孤立的非法消息由语法检查报告，不污染其他消息族", async () => {
  const policy: Policy = {
    ...basePolicy,
    source: {
      "From Email": "From Email",
      resendFromEmail: "From Email",
      bad: "Mention {'@'}all",
    },
    target: {
      "From Email": "发信人",
      resendFromEmail: "发信人",
      bad: "提及 @all",
    },
    terms: { concepts: [] },
    usages: { entries: [], unresolved: [], errors: [] },
    literals: {},
  };
  const result = await analyzeQuality(createKumaConfig(policy), {
    candidates: Object.entries(policy.target).map(([key, text]) => ({
      sourceKey: key,
      language: "zh-CN",
      content: { text },
    })),
  });
  assert.ok(
    result.diagnostics.some(
      (diagnostic) =>
        diagnostic.checkId === "vue-i18n/target-syntax" &&
        diagnostic.object.key === "bad",
    ),
  );
  const family = result.checks.find(
    (check) => check.checkId === "message-family-consistency",
  );
  assert.equal(
    family?.executions.find((execution) => execution.sourceKey === "bad")
      ?.status,
    "not-applicable",
  );
});
void test("中文独有键仍检查消息语法", async () => {
  const result = await run("", "错误 @all", { source: {} });
  assert.ok(diagnosticsFor(result, "vue-i18n/target-syntax").length > 0);
});
void test("变量对应和调用参数检查均保留 n 与 count 的身份", async () => {
  const branchResult = await run("{n} item | {count} items", "项目");
  assert.equal(
    diagnosticsFor(branchResult, "vue-i18n/variable-correspondence").length,
    1,
  );
  const usages = extractUsages(`t('label', { n: 2 })`, "src/demo.ts");
  const callResult = await run("Items", "共{count}项", { usages });
  assert.equal(
    diagnosticsFor(callResult, "kuma/vue-message-call-arguments").length,
    1,
  );
  assert.equal(
    diagnosticsFor(callResult, "vue-i18n/variable-correspondence").length,
    1,
  );
});
void test("数字 plural 参数按 Vue I18n 运行时供给 n 和 count", async () => {
  const usages = extractUsages(`t('label', 2)`, "src/demo.ts");
  assert.deepEqual(usages.entries[0]?.supplied, [
    "plural",
    "named:n",
    "named:count",
  ]);
  const result = await run("{n} items", "{count} 项", { usages });
  assert.equal(
    diagnosticsFor(result, "kuma/vue-message-call-arguments").length,
    0,
  );
  assert.equal(
    diagnosticsFor(result, "vue-i18n/variable-correspondence").length,
    1,
  );
  const componentUsages = extractUsages(
    `<template><i18n-t keypath="label" plural="2" /></template>`,
    "src/Message.vue",
  );
  assert.deepEqual(componentUsages.entries[0]?.supplied, [
    "plural",
    "named:n",
    "named:count",
  ]);
  assert.equal(
    diagnosticsFor(
      await run("Items", "{count} 项", { usages: componentUsages }),
      "kuma/vue-message-call-arguments",
    ).length,
    0,
  );
});
void test("Kuma 暴露六项独立 Vue 消息职责并固定编译器版本", async () => {
  const result = await run("Hello", "你好");
  const checks = new Map(result.checks.map((check) => [check.checkId, check]));
  for (const id of [
    "vue-i18n/source-syntax",
    "vue-i18n/target-syntax",
    "vue-i18n/variable-correspondence",
    "kuma/vue-message-call-arguments",
    "kuma/vue-message-link-target-exists",
    "kuma/vue-message-link-cycle",
  ])
    assert.ok(checks.has(id), `缺少独立检查 ${id}`);
  assert.ok(
    checks
      .get("vue-i18n/variable-correspondence")
      ?.version.includes("@intlify/message-compiler@11.2.8"),
  );
  const loadedProject = Object.assign(
    {
      policies: [basePolicy],
      terms: basePolicy.terms,
      usages: basePolicy.usages,
    },
    {
      root: "/fixture",
      inputs: [{ url: new URL("file:///fixture/messages.json"), raw: "{}" }],
      catalog: new URL("file:///fixture/languages.json"),
    },
  );
  assert.equal(createKumaChecks(loadedProject).length, 12);
});
void test("调用点闭包资料参与对应候选的输入指纹", async () => {
  const candidate = {
    candidates: [
      {
        sourceKey: "label",
        language: "zh-CN",
        content: { text: "你好 {name}" },
      },
    ],
  };
  const first = await analyzeQuality(
    createKumaConfig({
      ...basePolicy,
      source: { label: "Hello" },
      target: { label: "你好 {name}" },
      usages: {
        entries: [
          {
            key: "label",
            file: "src/first.ts",
            kind: "call",
            supplied: ["named:name"],
            parametersKnown: true,
          },
        ],
        unresolved: [],
        errors: [],
      },
    }),
    candidate,
  );
  const second = await analyzeQuality(
    createKumaConfig({
      ...basePolicy,
      source: { label: "Hello" },
      target: { label: "你好 {name}" },
      usages: {
        entries: [
          {
            key: "label",
            file: "src/second.ts",
            kind: "call",
            supplied: ["named:other"],
            parametersKnown: true,
          },
        ],
        unresolved: [],
        errors: [],
      },
    }),
    candidate,
  );
  const fingerprint = (result: typeof first) =>
    result.checks
      .find((check) => check.checkId === "kuma/vue-message-call-arguments")
      ?.executions.find((execution) => execution.sourceKey === "label")
      ?.inputFingerprint;
  assert.ok(fingerprint(first));
  assert.ok(fingerprint(second));
  assert.notEqual(fingerprint(first), fingerprint(second));
});
void test("技术字面值中的通配符和句点也必须按原值保留", async () => {
  assert.deepEqual(
    codes(
      await run("Trust X-Forwarded-*", "信任 X-Forwarded-*", {
        literals: { label: ["X-Forwarded-*"] },
      }),
    ),
    [],
  );
  assert.ok(
    codes(
      await run("Trust X-Forwarded-*", "信任 X-Forwarded-", {
        literals: { label: ["X-Forwarded-*"] },
      }),
    ).includes("protected-literal-missing"),
  );
  assert.ok(
    codes(
      await run("Use example.com", "使用 exampleXcom", {
        literals: { label: ["example.com"] },
      }),
    ).includes("protected-literal-missing"),
  );
});
void test("数据单位、速率单位和变量单位保持语义", async () => {
  assert.deepEqual(codes(await run("1024 bytes", "1 KiB")), []);
  assert.ok(codes(await run("1 KB", "1 MB")).includes("quantity-mismatch"));
  assert.ok(
    codes(await run("250 tests per hour", "每分钟250次测试")).includes(
      "quantity-mismatch",
    ),
  );
  assert.ok(
    codes(await run("Wait {0} seconds", "等待{0}分钟")).includes(
      "quantity-mismatch",
    ),
  );
  assert.deepEqual(codes(await run("Wait {0} seconds", "等待{0}秒")), []);
});
void test("Kuma短单位、每次动作及隐含字节单位使用项目政策", async () => {
  assert.deepEqual(
    codes(
      await run("{n} min | {n} min", "{n} 分", {
        targetQuantityUnitAliases: { label: { 分: "分钟" } },
      }),
    ),
    [],
  );
  assert.deepEqual(
    codes(await run("Call URL every {0} seconds.", "每{0}秒调用一次URL。")),
    [],
  );
  assert.deepEqual(
    codes(await run("Refresh every {0} seconds", "每{0}秒进行一次完全刷新")),
    [],
  );
  assert.deepEqual(
    codes(
      await run("Size smaller than 16", "小于16字节", {
        quantityDefaultUnits: { label: "bytes" },
      }),
    ),
    [],
  );
});

void test("同一配置运行多语言，术语、消息族等价与位置互不串用", async () => {
  const terms: Policy["terms"] = {
    concepts: [
      {
        id: "monitor",
        languages: [
          {
            language: "en",
            expressions: [
              { id: "en-monitor", text: "monitor", usage: "preferred" },
            ],
          },
          {
            language: "zh-CN",
            expressions: [
              { id: "zh-monitor", text: "监控项", usage: "preferred" },
            ],
          },
          {
            language: "ja",
            expressions: [
              { id: "ja-monitor", text: "モニター", usage: "preferred" },
            ],
          },
        ],
      },
    ],
  };
  const source = {
    "Push URL": "Push URL",
    PushUrl: "Push URL",
    label: "monitor",
  };
  const chinese: Policy = {
    ...basePolicy,
    source,
    target: { "Push URL": "推送 URL", PushUrl: "推送URL", label: "监控项" },
    terms,
  };
  const japanese: Policy = {
    ...chinese,
    targetLanguage: "ja",
    targetRange: "fixtures/ja.json",
    targetQuantityProfile: "ja",
    targetEquivalences: [],
    target: { "Push URL": "推送 URL", PushUrl: "推送URL", label: "监控项" },
  };
  const together = await analyzeQuality(createKumaConfig([chinese, japanese]));
  assert.equal(together.candidates.length, 6);
  assert.equal(together.status, "complete");
  assert.ok(together.diagnostics.length > 0);
  assert.ok(together.diagnostics.every((d) => d.object.language === "ja"));
  assert.ok(
    together.diagnostics.some(
      (d) => d.checkId === "message-family-consistency",
    ),
  );
  assert.ok(
    together.diagnostics.some(
      (d) =>
        d.checkId === "terminology/require-allowed-translation" &&
        d.location.range === "fixtures/ja.json",
    ),
  );
  const onlyJapanese = await analyzeQuality(createKumaConfig(japanese));
  const semantic = (diagnostics: typeof together.diagnostics) =>
    JSON.parse(
      JSON.stringify(diagnostics, (key, value: unknown) =>
        key === "translationIndex" || key === "executionId" ? undefined : value,
      ),
    );
  assert.deepEqual(
    semantic(together.diagnostics),
    semantic(onlyJapanese.diagnostics),
  );
});
void test("源语言和目标语言交换仍使用各自资源身份", async () => {
  const policy: Policy = {
    ...basePolicy,
    sourceLanguage: "ja",
    targetLanguage: "en",
    sourceRange: "fixtures/ja.json",
    targetRange: "fixtures/en.json",
    sourceQuantityProfile: "ja",
    targetQuantityProfile: "en",
    source: { label: "{name}さん" },
    target: { label: "Hello" },
    targetEquivalences: [],
  };
  const result = await analyzeQuality(createKumaConfig(policy));
  const finding = result.diagnostics.find(
    (diagnostic) => diagnostic.checkId === "vue-i18n/variable-correspondence",
  );
  assert.equal(finding?.object.language, "en");
  assert.equal(finding?.location.range, "fixtures/en.json");
  assert.ok(
    finding?.evidence.some(
      (e) =>
        e.role === "source-variable-patterns" &&
        e.location.language === null &&
        e.location.range === "fixtures/ja.json",
    ),
  );
});
void test("未支持的数值语言明确报告能力不足，其他规则仍执行", async () => {
  const policy: Policy = {
    ...basePolicy,
    targetLanguage: "de-DE",
    targetRange: "fixtures/de-DE.json",
    targetQuantityProfile: "de-DE",
    source: { label: "Wait {n} seconds" },
    target: { label: "Warten" },
    targetEquivalences: [],
  };
  const result = await analyzeQuality(createKumaConfig(policy));
  assert.equal(result.status, "incomplete");
  assert.equal(
    result.checks.find((c) => c.checkId === "kuma/quantities")?.coverage
      .incomplete,
    1,
  );
  assert.ok(
    result.diagnostics.some(
      (diagnostic) => diagnostic.checkId === "vue-i18n/variable-correspondence",
    ),
  );
});
