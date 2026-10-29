import assert from "node:assert/strict";
import test from "node:test";

import {
  createQualityException,
  StandardSchemaContractError,
  type QualityException,
  type QualityCheckResultCache,
} from "@lioni/core";
import type { TermbaseData } from "@lioni/terminology";

import { VUE_I18N_MESSAGE_COMPILER_VERSION } from "../../src/vue-i18n/vue-i18n-messages.ts";
import {
  checkIds,
  createQualityFixture,
  policyFor,
} from "./quality-fixture.ts";

const candidate = (
  sourceKey: string,
  text: string,
  language = "zh-CN",
  resourceStatus?: "missing" | "unavailable",
) => ({
  sourceKey,
  language,
  content: {
    text,
    ...(resourceStatus === undefined ? {} : { resourceStatus }),
  },
});

function findings(
  result: Awaited<ReturnType<ReturnType<typeof createQualityFixture>["run"]>>,
  id: string,
) {
  return result.diagnostics.filter((diagnostic) => diagnostic.checkId === id);
}

function check(
  result: Awaited<ReturnType<ReturnType<typeof createQualityFixture>["run"]>>,
  id: string,
) {
  return result.checks.find((item) => item.checkId === id);
}

void test("检查组保留独立身份，并从投影位置报告原文和候选语法错误", async () => {
  const policy = policyFor({
    sourceMessages: { label: "bad } source" },
    targetMessages: { label: "bad } target" },
    sourceRange: "catalog/en.json",
    targetRange: "catalog/zh-CN.json",
  });
  const result = await createQualityFixture({ policies: [policy] }).run([
    candidate("label", "bad } target"),
  ]);

  for (const id of Object.values(checkIds)) assert.ok(check(result, id), id);
  assert.ok(
    check(result, checkIds.variableCorrespondence)?.version.includes(
      "@intlify/message-compiler@11.2.8",
    ),
  );

  const source = findings(result, checkIds.sourceSyntax)[0];
  const target = findings(result, checkIds.targetSyntax)[0];
  assert.equal(source?.severity, "error");
  assert.equal(source?.object.kind, "source-unit");
  assert.equal(source?.location.language, null);
  assert.equal(source?.location.range, "catalog/en.json");
  assert.equal(target?.severity, "error");
  assert.equal(target?.object.kind, "translation-unit");
  assert.equal(target?.location.language, "zh-CN");
  assert.equal(target?.location.range, "catalog/zh-CN.json");
  assert.ok(source?.location.span);
  assert.ok(target?.location.span);
  assert.equal(
    check(result, checkIds.variableCorrespondence)?.status,
    "incomplete",
  );
  assert.deepEqual(check(result, checkIds.sourceSyntax)?.configuration, {
    compilerVersion: VUE_I18N_MESSAGE_COMPILER_VERSION,
  });
  assert.deepEqual(
    check(result, checkIds.variableCorrespondence)?.configuration,
    {
      compilerVersion: VUE_I18N_MESSAGE_COMPILER_VERSION,
      comparison: "branch-variable-count-patterns-v1",
    },
  );
});

void test("特殊消息键和带未知字段的 JSON 资源范围沿正式投影保留", async () => {
  const keys = ["__proto__", "constructor", "prototype"];
  const sourceRange = Object.fromEntries([
    ["__proto__", { owner: "source" }],
    ["constructor", "source constructor"],
    ["prototype", { reviewed: false }],
    ["hostMetadata", { revision: 3 }],
  ]);
  const targetRange = Object.fromEntries([
    ["__proto__", { owner: "target" }],
    ["constructor", "target constructor"],
    ["prototype", { reviewed: true }],
    ["hostMetadata", { revision: 4 }],
  ]);
  const sourceLocationMetadata = Object.fromEntries([
    ["__proto__", { owner: "source location" }],
    ["constructor", "source location constructor"],
    ["prototype", { reviewed: false }],
    ["hostMetadata", { revision: 5 }],
  ]);
  const targetLocationMetadata = Object.fromEntries([
    ["__proto__", { owner: "target location" }],
    ["constructor", "target location constructor"],
    ["prototype", { reviewed: true }],
    ["hostMetadata", { revision: 6 }],
  ]);
  const policy = policyFor({
    sourceMessages: Object.fromEntries(
      keys.map((key) => [key, "bad } source"]),
    ),
    targetMessages: Object.fromEntries(
      keys.map((key) => [key, "bad } target"]),
    ),
    sourceRange,
    targetRange,
  });
  const result = await createQualityFixture({
    policies: [policy],
    alterProjection: (projection) => ({
      ...projection,
      locations: {
        ...projection.locations,
        source: {
          ...projection.locations.source,
          ...sourceLocationMetadata,
        },
        target: {
          ...projection.locations.target,
          ...targetLocationMetadata,
        },
      },
    }),
  }).run(keys.map((key) => candidate(key, "bad } target")));
  const targetSyntaxFindings = findings(result, checkIds.targetSyntax);

  assert.deepEqual(
    targetSyntaxFindings.map(({ object }) => object.key),
    keys,
  );
  assert.deepEqual(
    targetSyntaxFindings.map(({ location }) => location.range),
    keys.map(() => targetRange),
  );
  assert.deepEqual(
    findings(result, checkIds.sourceSyntax).map(
      ({ location }) => location.range,
    ),
    keys.map(() => sourceRange),
  );
  for (const { location } of targetSyntaxFindings) {
    assert.deepEqual(location["__proto__"], { owner: "target location" });
    assert.equal(location.constructor, "target location constructor");
    assert.deepEqual(location.prototype, { reviewed: true });
    assert.deepEqual(location.hostMetadata, { revision: 6 });
  }
  for (const { location } of findings(result, checkIds.sourceSyntax)) {
    assert.deepEqual(location["__proto__"], { owner: "source location" });
    assert.equal(location.constructor, "source location constructor");
    assert.deepEqual(location.prototype, { reviewed: false });
    assert.deepEqual(location.hostMetadata, { revision: 5 });
  }
});

void test("共享投影仍拒绝带有投影字段的数组", async () => {
  const fixture = createQualityFixture({
    policies: [
      policyFor({
        sourceMessages: { label: "Hello" },
        targetMessages: { label: "你好" },
      }),
    ],
    alterProjection: (projection) => Object.assign([], projection),
  });

  await assert.rejects(
    fixture.run([candidate("label", "你好")]),
    (error: unknown) => {
      assert.ok(error instanceof StandardSchemaContractError);
      assert.equal(error.kind, "schema-mismatch");
      assert.match(error.valueDescription, /投影/u);
      return true;
    },
  );
});

void test("变量可换序但精确保留身份、重复次数与分支模式", async () => {
  const policy = policyFor({
    sourceMessages: {
      reordered: "Hello {name}, {0}",
      mismatch: "{name} {name} {0} {n}",
      branches: "{n} item | {n} items",
      branchMultiplicity: "{count} {count} | {count}",
      emptyPattern: "plain | {n}",
      dynamic: "{name} @:{route} @:linked",
      dynamicMismatch: "@:linked",
    },
    targetMessages: {
      reordered: "{0}，你好 {name}",
      mismatch: "{name} {0} {count} {extra}",
      branches: "{n} 个项目",
      branchMultiplicity: "{count} {count}",
      emptyPattern: "{n}",
      dynamic: "@:linked {route} {name}",
      dynamicMismatch: "@:linked @:{route}",
    },
  });
  const fixture = createQualityFixture({ policies: [policy] });

  assert.deepEqual(
    findings(
      await fixture.run([candidate("reordered", "{0}，你好 {name}")]),
      checkIds.variableCorrespondence,
    ),
    [],
  );
  assert.equal(
    findings(
      await fixture.run([candidate("mismatch", "{name} {0} {count} {extra}")]),
      checkIds.variableCorrespondence,
    ).length,
    1,
  );
  assert.deepEqual(
    findings(
      await fixture.run([candidate("branches", "{n} 个项目")]),
      checkIds.variableCorrespondence,
    ),
    [],
  );
  for (const [key, text] of [
    ["branchMultiplicity", "{count} {count}"],
    ["emptyPattern", "{n}"],
    ["dynamicMismatch", "@:linked @:{route}"],
  ] as const)
    assert.equal(
      findings(
        await fixture.run([candidate(key, text)]),
        checkIds.variableCorrespondence,
      ).length,
      1,
    );
  assert.deepEqual(
    findings(
      await fixture.run([candidate("dynamic", "@:linked {route} {name}")]),
      checkIds.variableCorrespondence,
    ),
    [],
  );
});

void test("非法语法使变量比较未完成，缺译、不可用和真实空正文彼此有别", async () => {
  const policy = policyFor({
    sourceMessages: { label: "Hello {name}", absent: "" },
    targetMessages: { label: "已保存" },
  });
  const fixture = createQualityFixture({ policies: [policy] });

  const invalid = await fixture.run([candidate("label", "你好 {name} }")]);
  const targetUnavailable = await fixture.run([
    candidate("label", "bad } target", "zh-CN", "unavailable"),
  ]);
  const targetMissing = await fixture.run([
    candidate("label", "bad } target", "zh-CN", "missing"),
  ]);
  const empty = await fixture.run([candidate("label", "")]);
  const targetOnly = await createQualityFixture({
    policies: [
      policyFor({
        sourceMessages: {},
        targetMessages: { orphan: "bad } target" },
      }),
    ],
  }).run([candidate("orphan", "bad } target")]);
  const unavailableSource = await createQualityFixture({
    policies: [policy],
    unavailableSourceKeys: ["label"],
  }).run([candidate("label", "你好")]);

  assert.equal(
    check(invalid, checkIds.variableCorrespondence)?.status,
    "incomplete",
  );
  assert.equal(check(invalid, checkIds.quantities)?.status, "incomplete");
  assert.equal(
    check(targetUnavailable, checkIds.targetSyntax)?.status,
    "incomplete",
  );
  assert.equal(
    check(targetUnavailable, checkIds.sourceSyntax)?.status,
    "incomplete",
  );
  assert.equal(
    check(targetMissing, checkIds.targetSyntax)?.status,
    "not-applicable",
  );
  assert.equal(
    check(targetMissing, checkIds.sourceSyntax)?.status,
    "not-applicable",
  );
  assert.equal(
    check(targetMissing, checkIds.variableCorrespondence)?.status,
    "not-applicable",
  );
  assert.deepEqual(findings(targetMissing, checkIds.targetSyntax), []);
  assert.equal(check(empty, checkIds.targetSyntax)?.status, "complete");
  assert.equal(findings(empty, checkIds.variableCorrespondence).length, 1);
  const emptySource = await fixture.run([candidate("absent", "")]);
  assert.equal(check(emptySource, checkIds.sourceSyntax)?.status, "complete");
  assert.equal(
    check(targetOnly, checkIds.sourceSyntax)?.status,
    "not-applicable",
  );
  assert.equal(findings(targetOnly, checkIds.targetSyntax).length, 1);
  assert.equal(
    check(unavailableSource, checkIds.sourceSyntax)?.status,
    "incomplete",
  );
  assert.deepEqual(findings(unavailableSource, checkIds.targetSyntax), []);
});

void test("目标独有关联仍检查，缺失目标可见，当前候选覆盖保存正文参与循环判断", async () => {
  const policy = policyFor({
    sourceMessages: { label: "Hello", other: "Other" },
    targetMessages: { label: "Saved text", other: "译文" },
  });
  const fixture = createQualityFixture({ policies: [policy] });
  const missing = await fixture.run([candidate("orphan", "@:missing.key")]);
  const cycle = await fixture.run([candidate("label", "@:label")]);

  assert.equal(findings(missing, checkIds.linkTargetExists).length, 1);
  assert.equal(findings(cycle, checkIds.linkCycle).length, 1);
  assert.equal(check(cycle, checkIds.linkCycle)?.status, "complete");
});

void test("术语与受保护字面值接受声明形式并拒绝不允许的译法", async () => {
  const terms: TermbaseData = {
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
              { id: "display", text: "显示器", usage: "forbidden" },
            ],
          },
        ],
      },
    ],
  };
  const policy = policyFor({
    sourceMessages: {
      monitor: "monitor",
      identifier: "Use monitor_id",
      header: "Trust X-Forwarded-*",
    },
    targetMessages: {
      monitor: "监控项",
      identifier: "使用 monitor_id",
      header: "信任 X-Forwarded-*",
    },
    protectedLiterals: {
      identifier: ["monitor_id"],
      header: ["X-Forwarded-*"],
    },
  });
  const fixture = createQualityFixture({ policies: [policy], terms });
  const allowed = await fixture.run([
    candidate("monitor", "监控项"),
    candidate("identifier", "使用 monitor_id"),
    candidate("header", "信任 X-Forwarded-*"),
  ]);
  const forbidden = await fixture.run([candidate("monitor", "显示器")]);
  const alteredLiteral = await fixture.run([
    candidate("header", "信任 X-Forwarded-"),
  ]);

  assert.deepEqual(findings(allowed, checkIds.forbiddenTerminology), []);
  assert.deepEqual(findings(allowed, checkIds.protectedLiterals), []);
  assert.equal(findings(forbidden, checkIds.forbiddenTerminology).length, 1);
  assert.equal(findings(alteredLiteral, checkIds.protectedLiterals).length, 1);
});

void test("数量比较保留单位语义，显式策略支持换算和能力不足状态", async () => {
  const policy = policyFor({
    sourceMessages: {
      converted: "Wait 2000 milliseconds",
      changed: "Wait 20 seconds",
      placeholders: "Wait {0} seconds",
      range: "3..=11 characters",
      repeated: "6 parts, 153 x 6 = 918 characters",
      ordinal: "2nd Last Day of Month",
      alias: "Wait 180 seconds",
      defaultUnit: "Size below 16",
    },
    targetMessages: {
      converted: "等待2秒",
      changed: "等待20分钟",
      placeholders: "等待{0}秒",
      range: "3到11个字符",
      repeated: "最多6段，每段153字符，共918字符",
      ordinal: "每月倒数第二天",
      alias: "等待3分",
      defaultUnit: "小于16字节",
    },
    targetQuantities: { profile: "zh-CN", aliases: { 分: "分钟" } },
    sourceQuantities: {
      profile: "en",
      byKey: { defaultUnit: { defaultUnit: "bytes" } },
    },
  });
  const fixture = createQualityFixture({ policies: [policy] });
  const converted = await fixture.run([candidate("converted", "等待2秒")]);
  const changed = await fixture.run([candidate("changed", "等待20分钟")]);

  assert.deepEqual(findings(converted, checkIds.quantities), []);
  assert.equal(findings(changed, checkIds.quantities).length, 1);
  for (const [key, text] of [
    ["placeholders", "等待{0}秒"],
    ["range", "3到11个字符"],
    ["repeated", "最多6段，每段153字符，共918字符"],
    ["ordinal", "每月倒数第二天"],
    ["alias", "等待3分"],
    ["defaultUnit", "小于16字节"],
  ] as const)
    assert.deepEqual(
      findings(await fixture.run([candidate(key, text)]), checkIds.quantities),
      [],
    );

  const ignoredLiteral = await createQualityFixture({
    policies: [
      policyFor({
        sourceMessages: { expiry: "2FA expires after 1 hour" },
        targetMessages: { expiry: "二次验证一小时后过期" },
        sourceQuantities: { profile: "en", ignoredLiterals: ["2FA"] },
        targetQuantities: {
          profile: "zh-CN",
          ignoredLiterals: ["二次验证"],
        },
      }),
    ],
  }).run([candidate("expiry", "二次验证一小时后过期")]);
  assert.deepEqual(findings(ignoredLiteral, checkIds.quantities), []);

  const unsupported = await createQualityFixture({
    policies: [
      policyFor({
        sourceMessages: { label: "Wait 20 seconds {name}" },
        targetMessages: { label: "Warten {other}" },
        targetLanguage: "de-DE",
        targetRange: "catalog/de-DE.json",
      }),
    ],
  }).run([candidate("label", "Warten {other}", "de-DE")]);
  assert.equal(check(unsupported, checkIds.quantities)?.status, "incomplete");
  assert.equal(
    findings(unsupported, checkIds.variableCorrespondence).length,
    1,
  );
});

void test("消息族只比较同一声明范围，并接受明确列出的目标等价", async () => {
  const sameScope = policyFor({
    sourceMessages: { first: "Active", second: "Active" },
    targetMessages: { first: "激活", second: "有效" },
    scopes: [{ scope: "ui", keys: ["first", "second"] }],
  });
  const separateScopes = policyFor({
    sourceMessages: { first: "Active", second: "Active" },
    targetMessages: { first: "激活", second: "有效" },
    scopes: [
      { scope: "settings", keys: ["first"] },
      { scope: "billing", keys: ["second"] },
    ],
  });
  const equivalentTargets = policyFor({
    sourceMessages: { first: "Push URL", second: "Push URL" },
    targetMessages: { first: "推送 URL", second: "推送URL" },
    scopes: [{ scope: "ui", keys: ["first", "second"] }],
    targetEquivalences: [["推送 URL", "推送URL"]],
  });

  const inconsistent = await createQualityFixture({
    policies: [sameScope],
  }).run([candidate("first", "激活")]);
  const isolated = await createQualityFixture({
    policies: [separateScopes],
  }).run([candidate("first", "激活")]);
  const equivalent = await createQualityFixture({
    policies: [equivalentTargets],
  }).run([candidate("first", "推送 URL")]);

  assert.equal(
    findings(inconsistent, checkIds.messageFamilyConsistency).length,
    1,
  );
  assert.deepEqual(findings(isolated, checkIds.messageFamilyConsistency), []);
  assert.deepEqual(findings(equivalent, checkIds.messageFamilyConsistency), []);
});

void test("消息族目标等价声明仅影响其目标语言", async () => {
  const chinese = policyFor({
    sourceMessages: { first: "Enabled", second: "Enabled" },
    targetMessages: { first: "A", second: "B" },
    scopes: [{ scope: "ui", keys: ["first", "second"] }],
  });
  const japanese = policyFor({
    sourceMessages: { first: "Enabled", second: "Enabled" },
    targetMessages: { first: "A", second: "B" },
    targetLanguage: "ja",
    targetRange: "translations/ja.json",
    scopes: [{ scope: "ui", keys: ["first", "second"] }],
    targetEquivalences: [["A", "B"]],
  });

  const withoutJapanesePolicy = await createQualityFixture({
    policies: [chinese],
  }).run([candidate("first", "A")]);
  const withJapanesePolicy = await createQualityFixture({
    policies: [chinese, japanese],
  }).run([candidate("first", "A", "zh-CN"), candidate("first", "A", "ja")]);

  assert.equal(
    findings(withoutJapanesePolicy, checkIds.messageFamilyConsistency).length,
    1,
  );
  assert.equal(
    findings(withJapanesePolicy, checkIds.messageFamilyConsistency).filter(
      ({ object }) => object.language === "zh-CN",
    ).length,
    1,
  );
  assert.deepEqual(
    findings(withJapanesePolicy, checkIds.messageFamilyConsistency).filter(
      ({ object }) => object.language === "ja",
    ),
    [],
  );
});

void test("无效的已保存译文不使其他消息族变为未完成", async () => {
  const policy = policyFor({
    sourceMessages: {
      first: "Enabled",
      second: "Enabled",
      broken: "Enabled",
    },
    targetMessages: { first: "A", second: "B", broken: "bad }" },
    scopes: [{ scope: "ui", keys: ["first", "second", "broken"] }],
  });
  const result = await createQualityFixture({ policies: [policy] }).run([
    candidate("first", "A"),
    candidate("broken", "bad }"),
  ]);

  const familyCheck = check(result, checkIds.messageFamilyConsistency);
  assert.equal(familyCheck?.status, "complete");
  assert.equal(familyCheck?.coverage.incomplete, 0);
  assert.equal(findings(result, checkIds.messageFamilyConsistency).length, 1);
  assert.equal(findings(result, checkIds.targetSyntax).length, 1);
});

void test("多语言沿用各自资源位置，反向语言对仍标注正确来源", async () => {
  const terms: TermbaseData = {
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
            expressions: [{ id: "bad-zh", text: "显示器", usage: "forbidden" }],
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
  const chinese = policyFor({
    sourceMessages: { label: "monitor" },
    targetMessages: { label: "显示器" },
    targetRange: "translations/zh-CN.json",
  });
  const japanese = policyFor({
    sourceMessages: { label: "monitor" },
    targetMessages: { label: "モニター" },
    targetLanguage: "ja",
    targetRange: "translations/ja.json",
  });
  const multilingual = await createQualityFixture({
    policies: [chinese, japanese],
    terms,
  }).run([
    candidate("label", "显示器", "zh-CN"),
    candidate("label", "モニター", "ja"),
  ]);
  const forbidden = findings(multilingual, checkIds.forbiddenTerminology);

  assert.equal(forbidden.length, 1);
  assert.equal(forbidden[0]?.object.language, "zh-CN");
  assert.equal(forbidden[0]?.location.range, "translations/zh-CN.json");

  const reversedPolicy = policyFor({
    sourceLanguage: "ja",
    targetLanguage: "en",
    sourceMessages: { greeting: "{name}さん" },
    targetMessages: { greeting: "Hello" },
    sourceRange: "catalog/ja.json",
    targetRange: "translations/en.json",
    sourceQuantities: { profile: "ja" },
    targetQuantities: { profile: "en" },
  });
  const reversed = await createQualityFixture({
    policies: [reversedPolicy],
  }).run([candidate("greeting", "Hello", "en")]);
  const variable = findings(reversed, checkIds.variableCorrespondence)[0];

  assert.equal(variable?.location.language, "en");
  assert.equal(variable?.location.range, "translations/en.json");
  assert.ok(
    variable?.evidence.some(
      (item) =>
        item.role === "source-variable-patterns" &&
        item.location.language === null &&
        item.location.range === "catalog/ja.json",
    ),
  );
});

void test("同次运行中的各检查共享一次候选消息投影", async () => {
  let projections = 0;
  const policy = policyFor({
    sourceMessages: { label: "Hello {name}" },
    targetMessages: { label: "你好 {name}" },
  });
  const result = await createQualityFixture({
    policies: [policy],
    onProject: () => projections++,
  }).run([candidate("label", "你好 {name}")]);

  assert.ok(result.checks.length > 1);
  assert.equal(projections, 1);
});

void test("每次质量运行读取一次 Vue 动态规则并使用最新术语资料", async () => {
  let reads = 0;
  let forbidDisplayTerm = true;
  const policy = policyFor({
    sourceMessages: { monitor: "monitor", other: "Hello" },
    targetMessages: { monitor: "显示器", other: "其他" },
  });
  const fixture = createQualityFixture({
    policies: [policy],
    loadTerms: () => {
      reads++;
      return {
        concepts: [
          {
            id: "monitor",
            languages: [
              {
                language: "en",
                expressions: [
                  { id: "monitor-en", text: "monitor", usage: "preferred" },
                ],
              },
              {
                language: "zh-CN",
                expressions: [
                  {
                    id: "monitor-zh",
                    text: "显示器",
                    usage: forbidDisplayTerm ? "forbidden" : "allowed",
                  },
                ],
              },
            ],
          },
        ],
      };
    },
  });

  const first = await fixture.run([
    candidate("monitor", "显示器"),
    candidate("other", "其他"),
  ]);
  forbidDisplayTerm = false;
  const second = await fixture.run([candidate("monitor", "显示器")]);

  assert.equal(reads, 2);
  assert.equal(findings(first, checkIds.forbiddenTerminology).length, 1);
  assert.deepEqual(findings(second, checkIds.forbiddenTerminology), []);
});

void test("quality.loadDependencies 将 Vue 策略和术语资料作为嵌套 JSON 依赖传入 core", async () => {
  const policy = policyFor({
    sourceMessages: { label: "Hello {name}" },
    targetMessages: { label: "你好 {name}" },
  });
  const terms: TermbaseData = { concepts: [] };
  const result = await createQualityFixture({
    policies: [policy],
    terms,
  }).run([candidate("label", "你好 {name}")]);

  assert.deepEqual(result.dependencies, {
    vueI18n: { policies: [policy], terms },
  });
});

void test("quality.loadDependencies 返回的规则依赖不是 JSON 时拒绝", async () => {
  const policy = policyFor({ sourceMessages: { label: "Hello" } });
  const metadata: Record<string, unknown> = {};
  metadata.self = metadata;
  const fixture = createQualityFixture({
    policies: [policy],
    terms: {
      concepts: [],
      metadata: metadata as Exclude<TermbaseData["metadata"], undefined>,
    },
  });

  await assert.rejects(
    fixture.run([candidate("label", "你好")]),
    (error: unknown) =>
      error instanceof StandardSchemaContractError &&
      error.kind === "invalid-json",
  );
});

void test("缺少目标候选时不把缺译占位转成空消息", async () => {
  const policy = policyFor({
    sourceMessages: { label: "Hello {name}" },
    targetMessages: {},
  });
  const fixture = createQualityFixture({ policies: [policy] });
  const result = await fixture.run([]);

  assert.equal(
    check(result, checkIds.variableCorrespondence)?.status,
    "not-run",
  );
  assert.deepEqual(findings(result, checkIds.variableCorrespondence), []);
});

void test("Vue 术语例外与缓存仅随当前消息、术语资料和诊断位置变化", async () => {
  const sourceMessages = { a: "monitor", b: "Hello" };
  const targetMessages = { a: "显示器", b: "你好" };
  const policy = policyFor({ sourceMessages, targetMessages });
  let targetRange = "zh-CN.json";
  let exceptions: readonly QualityException[] = [];
  let terms: TermbaseData = {
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
              { id: "zh", text: "显示器", usage: "forbidden" },
              { id: "zh-allowed", text: "监视器", usage: "allowed" },
            ],
          },
        ],
      },
    ],
  };
  const originalTerms = terms;
  const cache = new Map<
    string,
    Awaited<ReturnType<QualityCheckResultCache["get"]>>
  >();
  let termCacheHits = 0;
  const fixture = createQualityFixture({
    policies: [policy],
    loadTerms: () => terms,
    alterProjection: (value) => ({
      ...value,
      locations: {
        ...value.locations,
        target: { ...value.locations.target, range: targetRange },
      },
    }),
    exceptionStore: {
      async load() {
        return exceptions;
      },
      async upsert(value) {
        exceptions = [...exceptions, value];
      },
    },
    resultCache: {
      async get(key) {
        const value = cache.get(key);
        if (
          value?.diagnostics.some(
            (item) =>
              item.object.code === "forbidden-translation" ||
              item.object.code === "missing-allowed-translation",
          )
        )
          termCacheHits++;
        return value;
      },
      async set(key, value) {
        cache.set(key, value);
      },
    },
  });
  const run = (text = "显示器") => fixture.run([candidate("a", text)]);
  const first = await run();
  const ids = [checkIds.allowedTerminology, checkIds.forbiddenTerminology];
  exceptions = first.checks
    .filter((item) => ids.includes(item.checkId as (typeof ids)[number]))
    .flatMap((item) =>
      item.executions.map((execution) =>
        createQualityException({
          id: execution.checkId,
          reason: "接受消息 A",
          execution,
        }),
      ),
    );
  assert.equal(exceptions.length, 2);
  sourceMessages.b = "Goodbye";
  targetMessages.b = "再见";
  const unrelated = await run();
  assert.deepEqual(
    unrelated.exceptionApplicability.map((item) => item.status),
    ["applicable", "applicable"],
  );
  assert.equal(termCacheHits, 2);
  assert.deepEqual(
    unrelated.diagnostics
      .filter((item) => ids.includes(item.checkId as (typeof ids)[number]))
      .map((item) => item.handling.status),
    ["excepted", "excepted"],
  );
  const changedCandidate = await run("另一个译法");
  assert.deepEqual(
    changedCandidate.exceptionApplicability.map((item) => item.status),
    ["basis-changed", "basis-changed"],
  );
  sourceMessages.a = "monitor changed";
  assert.deepEqual(
    (await run()).exceptionApplicability.map((item) => item.status),
    ["basis-changed", "basis-changed"],
  );
  sourceMessages.a = "monitor";
  terms = { concepts: [] };
  const changedTerms = await run();
  assert.deepEqual(
    changedTerms.exceptionApplicability.map((item) => item.status),
    ["basis-changed", "basis-changed"],
  );
  assert.deepEqual(findings(changedTerms, checkIds.forbiddenTerminology), []);
  terms = originalTerms;
  targetRange = "moved/zh-CN.json";
  const moved = await run();
  assert.deepEqual(
    moved.exceptionApplicability.map((item) => item.status),
    ["basis-changed", "basis-changed"],
  );
  assert.equal(
    findings(moved, checkIds.forbiddenTerminology)[0]?.location.range,
    targetRange,
  );
  targetRange = "zh-CN.json";
  assert.deepEqual(
    (await run()).exceptionApplicability.map((item) => item.status),
    ["applicable", "applicable"],
  );
});
