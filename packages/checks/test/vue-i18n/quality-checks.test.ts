import assert from "node:assert/strict";
import test from "node:test";

import {
  createQaSuppression,
  StandardSchemaContractError,
  type QaSuppression,
  type QualityCheckResultCache,
} from "@lioni/core";
import { TermContractError } from "@lioni/terminology";
import type { TermbaseData } from "@lioni/terminology";

import {
  VUE_I18N_PROTECTED_LITERAL_COMPARISON_VERSION,
  VUE_I18N_QUANTITY_COMPARISON_VERSION,
} from "../../src/vue-i18n/versions.ts";
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

void test("检查组保留独立身份与既有规则版本，并从投影位置报告原文和候选语法错误", async () => {
  const validPolicy = policyFor({
    sourceMessages: { label: "Hello" },
    targetMessages: { label: "你好" },
  });
  const valid = await createQualityFixture({ policies: [validPolicy] }).run([
    candidate("label", "你好"),
  ]);
  for (const id of Object.values(checkIds)) assert.ok(check(valid, id), id);
  assert.deepEqual(
    Object.fromEntries(
      valid.checks.map((item) => [item.checkId, item.version]),
    ),
    {
      [checkIds.sourceSyntax]: `checks.vue-i18n/source-syntax/v3+@intlify/message-compiler@${VUE_I18N_MESSAGE_COMPILER_VERSION}`,
      [checkIds.targetSyntax]: `checks.vue-i18n/target-syntax/v2+@intlify/message-compiler@${VUE_I18N_MESSAGE_COMPILER_VERSION}`,
      [checkIds.variableCorrespondence]: `checks.vue-i18n/variable-correspondence/v2+@intlify/message-compiler@${VUE_I18N_MESSAGE_COMPILER_VERSION}`,
      [checkIds.linkTargetExists]: `vue-i18n-suite/link-target-exists/v2+@intlify/message-compiler@${VUE_I18N_MESSAGE_COMPILER_VERSION}`,
      [checkIds.linkCycle]: `vue-i18n-suite/link-cycle/v3+@intlify/message-compiler@${VUE_I18N_MESSAGE_COMPILER_VERSION}`,
      [checkIds.protectedLiterals]: `vue-i18n-suite/protected-literals/v2+${VUE_I18N_PROTECTED_LITERAL_COMPARISON_VERSION}`,
      [checkIds.quantities]: `vue-i18n-suite/quantities/v2+@intlify/message-compiler@${VUE_I18N_MESSAGE_COMPILER_VERSION}+${VUE_I18N_QUANTITY_COMPARISON_VERSION}`,
      [checkIds.allowedTerminology]: "checks.terminology-rule/v3",
      [checkIds.forbiddenTerminology]: "checks.terminology-rule/v3",
      [checkIds.messageFamilyConsistency]:
        "checks.message-family-consistency/v6",
    },
  );

  const policy = policyFor({
    sourceMessages: { label: "bad } source" },
    targetMessages: { label: "bad } target" },
    sourceRange: "catalog/en.json",
    targetRange: "catalog/zh-CN.json",
  });
  const fixture = createQualityFixture({ policies: [policy] });
  const result = await fixture.run(
    [candidate("label", "bad } target")],
    [checkIds.sourceSyntax, checkIds.targetSyntax],
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
  await assert.rejects(
    fixture.run(
      [candidate("label", "bad } target")],
      [checkIds.variableCorrespondence],
    ),
    /vue-i18n\/variable-correspondence.*label.*zh-CN/u,
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
  }).run(
    keys.map((key) => candidate(key, "bad } target")),
    [checkIds.sourceSyntax, checkIds.targetSyntax],
  );
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

void test("特殊字典键的字面值与数量策略完整验证并参与正式检查", async () => {
  const policy = policyFor({
    sourceMessages: JSON.parse(
      '{"__proto__":"Wait 1 __proto__ URL","root":"Root"}',
    ),
    targetMessages: JSON.parse('{"__proto__":"等待 2","root":"@:__proto__"}'),
    protectedLiterals: JSON.parse('{"__proto__":["URL"]}'),
    sourceQuantities: {
      profile: "en",
      aliases: JSON.parse('{"__proto__":"minute"}'),
    },
    targetQuantities: {
      profile: "zh-CN",
      byKey: JSON.parse('{"__proto__":{"defaultUnit":"minute"}}'),
    },
  });
  const fixture = createQualityFixture({ policies: [policy] });
  const missing = await fixture.run([
    candidate("__proto__", "等待 2"),
    candidate("root", "@:__proto__"),
  ]);
  assert.equal(findings(missing, checkIds.protectedLiterals).length, 1);
  assert.equal(findings(missing, checkIds.quantities).length, 1);
  assert.deepEqual(findings(missing, checkIds.linkTargetExists), []);
  const corrected = await fixture.run([
    candidate("__proto__", "等待 1 分钟 URL"),
  ]);
  assert.deepEqual(findings(corrected, checkIds.protectedLiterals), []);
  assert.deepEqual(findings(corrected, checkIds.quantities), []);
});

void test("动态策略拒绝特殊字典键下的非法资源、字面值和数量配置", async () => {
  const policy = policyFor({
    sourceMessages: { a: "Wait 1 minute URL" },
    targetMessages: { a: "等待 2 分钟" },
  });
  const invalid = JSON.parse('{"__proto__":123}');
  const cases = [
    {
      expected: "protectedLiterals.__proto__",
      value: { protectedLiterals: invalid },
    },
    {
      expected: "resources.source.messages.__proto__",
      value: { sourceMessages: invalid },
    },
    {
      expected: "resources.target.messages.__proto__",
      value: { targetMessages: invalid },
    },
    {
      expected: "quantities.source.aliases.__proto__",
      value: { sourceQuantities: { profile: "en", aliases: invalid } },
    },
    {
      expected: "quantities.target.byKey.__proto__",
      value: { targetQuantities: { profile: "zh-CN", byKey: invalid } },
    },
    {
      expected: "quantities.target.byKey.__proto__.aliases.__proto__",
      value: {
        targetQuantities: {
          profile: "zh-CN",
          byKey: JSON.parse('{"__proto__":{"aliases":{"__proto__":123}}}'),
        },
      },
    },
  ];
  for (const scenario of cases) {
    const fixture = createQualityFixture({
      policies: [policy],
      loadPolicies: () => [policyFor(scenario.value)],
    });
    await assert.rejects(
      fixture.run([candidate("a", "等待 2 分钟")]),
      (error: unknown) => {
        assert.ok(error instanceof StandardSchemaContractError);
        assert.equal(error.kind, "schema-mismatch");
        const actualPath = error.issues?.[0]?.path
          ?.map((part) => {
            if (typeof part === "string" || typeof part === "number")
              return String(part);
            if (typeof part === "object" && part !== null && "key" in part)
              return String(part.key);
            return JSON.stringify(part) ?? "";
          })
          .join(".");
        assert.equal(actualPath, scenario.expected);
        return true;
      },
    );
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
      assert.equal(error.kind, "invalid-json");

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

void test("非法语法使依赖解析的检查抛错拒绝，缺译、不可用和真实空正文彼此有别", async () => {
  const policy = policyFor({
    sourceMessages: { label: "Hello {name}", absent: "" },
    targetMessages: { label: "已保存" },
  });
  const fixture = createQualityFixture({ policies: [policy] });

  await assert.rejects(
    fixture.run(
      [candidate("label", "你好 {name} }")],
      [checkIds.variableCorrespondence],
    ),
    /vue-i18n\/variable-correspondence.*label.*zh-CN/u,
  );
  await assert.rejects(
    fixture.run([candidate("label", "你好 {name} }")], [checkIds.quantities]),
    /vue-i18n\/quantities.*label.*zh-CN/u,
  );
  const invalidTargetSyntax = await fixture.run(
    [candidate("label", "你好 {name} }")],
    [checkIds.sourceSyntax, checkIds.targetSyntax],
  );
  assert.equal(findings(invalidTargetSyntax, checkIds.targetSyntax).length, 1);

  await assert.rejects(
    fixture.run(
      [candidate("label", "bad } target", "zh-CN", "unavailable")],
      [checkIds.targetSyntax],
    ),
    /vue-i18n\/target-syntax.*label.*zh-CN/u,
  );
  const targetUnavailableSourceOnly = await fixture.run(
    [candidate("label", "bad } target", "zh-CN", "unavailable")],
    [checkIds.sourceSyntax],
  );
  assert.deepEqual(
    findings(targetUnavailableSourceOnly, checkIds.sourceSyntax),
    [],
  );

  const targetMissing = await fixture.run([
    candidate("label", "bad } target", "zh-CN", "missing"),
  ]);
  assert.deepEqual(targetMissing.diagnostics, []);
  assert.equal(
    check(targetMissing, checkIds.variableCorrespondence)?.coverage.evaluated,
    1,
  );

  const empty = await fixture.run([candidate("label", "")]);
  assert.deepEqual(findings(empty, checkIds.targetSyntax), []);
  assert.equal(findings(empty, checkIds.variableCorrespondence).length, 1);

  await assert.rejects(
    createQualityFixture({
      policies: [
        policyFor({
          sourceMessages: {},
          targetMessages: { orphan: "bad } target" },
        }),
      ],
    }).run([candidate("orphan", "bad } target")]),
    /原文键.*不存在于本次已读取的原文/,
  );

  const unavailableSourceFixture = createQualityFixture({
    policies: [policy],
    unavailableSourceKeys: ["label"],
    alterProjection: (projection) => ({
      ...projection,
      source: { status: "available", text: "Hello {name}" },
    }),
  });
  const emptySource = await fixture.run([candidate("absent", "")]);
  assert.deepEqual(findings(emptySource, checkIds.sourceSyntax), []);
  for (const id of [
    checkIds.sourceSyntax,
    checkIds.variableCorrespondence,
    checkIds.allowedTerminology,
    checkIds.messageFamilyConsistency,
  ]) {
    await assert.rejects(
      unavailableSourceFixture.run([candidate("label", "你好")], [id]),
      new RegExp(`${id}.*label.*zh-CN`, "u"),
    );
  }
  const unavailableSourceTargetOnly = await unavailableSourceFixture.run(
    [candidate("label", "你好")],
    [checkIds.targetSyntax],
  );
  assert.deepEqual(
    findings(unavailableSourceTargetOnly, checkIds.targetSyntax),
    [],
  );
  await assert.rejects(
    unavailableSourceFixture.run(
      [candidate("label", "无关占位", "zh-CN", "missing")],
      [checkIds.sourceSyntax],
    ),
    /vue-i18n\/source-syntax.*label.*zh-CN/u,
  );
});

void test("目标独有关联仍检查，缺失目标可见，当前候选覆盖保存正文参与循环判断", async () => {
  const policy = policyFor({
    sourceMessages: { label: "Hello", other: "Other" },
    targetMessages: { label: "Saved text", other: "译文" },
  });
  const fixture = createQualityFixture({ policies: [policy] });
  const missing = await fixture.run([candidate("other", "@:missing.key")]);
  const cycle = await fixture.run([candidate("label", "@:label")]);

  assert.equal(findings(missing, checkIds.linkTargetExists).length, 1);
  assert.equal(findings(cycle, checkIds.linkCycle).length, 1);
});

void test("缺译时 source-syntax v3 仍检查原文语法并计入进度，link-cycle v3 在全量保存资源中检出循环", async () => {
  const fixture = createQualityFixture({
    policies: [
      policyFor({
        sourceMessages: {
          broken: "bad } source",
          ok: "Hello",
          loopA: "Root A",
          loopB: "Root B",
        },
        targetMessages: {
          ok: "你好",
          loopA: "@:loopB",
          loopB: "@:loopA",
        },
      }),
    ],
  });

  const syntaxOnly = await fixture.run(undefined, [
    checkIds.sourceSyntax,
    checkIds.targetSyntax,
  ]);
  assert.equal(
    check(syntaxOnly, checkIds.sourceSyntax)?.version,
    `checks.vue-i18n/source-syntax/v3+@intlify/message-compiler@${VUE_I18N_MESSAGE_COMPILER_VERSION}`,
  );
  assert.equal(
    check(syntaxOnly, checkIds.targetSyntax)?.version,
    `checks.vue-i18n/target-syntax/v2+@intlify/message-compiler@${VUE_I18N_MESSAGE_COMPILER_VERSION}`,
  );
  assert.deepEqual(
    findings(syntaxOnly, checkIds.sourceSyntax).map((item) => item.object),
    [{ kind: "source-unit", key: "broken" }],
  );
  assert.deepEqual(findings(syntaxOnly, checkIds.targetSyntax), []);
  assert.equal(check(syntaxOnly, checkIds.sourceSyntax)?.coverage.evaluated, 4);

  const cycleOnly = await fixture.run(undefined, [checkIds.linkCycle]);
  assert.equal(
    check(cycleOnly, checkIds.linkCycle)?.version,
    `vue-i18n-suite/link-cycle/v3+@intlify/message-compiler@${VUE_I18N_MESSAGE_COMPILER_VERSION}`,
  );
  assert.deepEqual(
    findings(cycleOnly, checkIds.linkCycle).map((item) => item.object.key),
    ["loopA", "loopB"],
  );
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

  const unsupportedFixture = createQualityFixture({
    policies: [
      policyFor({
        sourceMessages: { label: "Wait 20 seconds {name}" },
        targetMessages: { label: "Warten {other}" },
        targetLanguage: "de-DE",
        targetRange: "catalog/de-DE.json",
      }),
    ],
  });
  await assert.rejects(
    unsupportedFixture.run(
      [candidate("label", "Warten {other}", "de-DE")],
      [checkIds.quantities],
    ),
    /vue-i18n\/quantities.*label.*de-DE/u,
  );
  const unsupportedVariables = await unsupportedFixture.run(
    [candidate("label", "Warten {other}", "de-DE")],
    [checkIds.variableCorrespondence],
  );
  assert.equal(
    findings(unsupportedVariables, checkIds.variableCorrespondence).length,
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

void test("无效的已保存译文不使其他消息族失败，解析失败的候选整体抛错", async () => {
  const policy = policyFor({
    sourceMessages: {
      first: "Enabled",
      second: "Enabled",
      broken: "Other",
    },
    targetMessages: { first: "A", second: "B", broken: "bad }" },
    scopes: [{ scope: "ui", keys: ["first", "second", "broken"] }],
  });
  const fixture = createQualityFixture({ policies: [policy] });
  const isolated = await fixture.run(
    [candidate("first", "A")],
    [checkIds.messageFamilyConsistency],
  );
  assert.equal(findings(isolated, checkIds.messageFamilyConsistency).length, 1);

  await assert.rejects(
    fixture.run(
      [candidate("first", "A"), candidate("broken", "bad }")],
      [checkIds.messageFamilyConsistency],
    ),
    /message-family-consistency.*broken.*zh-CN/u,
  );
  const targetSyntax = await fixture.run(
    [candidate("first", "A"), candidate("broken", "bad }")],
    [checkIds.targetSyntax],
  );
  assert.equal(findings(targetSyntax, checkIds.targetSyntax).length, 1);
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
  }).run(
    [
      candidate("label", "显示器", "zh-CN"),
      candidate("label", "モニター", "ja"),
    ],
    [checkIds.forbiddenTerminology],
  );
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
    onPrepare: () => projections++,
  }).run([candidate("label", "你好 {name}")]);

  assert.ok(result.checks.length > 1);
  assert.equal(projections, 1);
});

void test("组合基础、术语与消息族共用准备适配并保留候选位置", async () => {
  let preparations = 0;
  let candidateRange = { file: "prepared-target.json", revision: 4 };
  let savedRange = { file: "saved-target.json", revision: 2 };
  let suppressions: QaSuppression[] = [];
  const policy = policyFor({
    sourceMessages: { current: "Open", peer: "Open" },
    targetMessages: { current: "旧译", peer: "启用" },
    scopes: [{ scope: "controls", keys: ["current", "peer"] }],
  });
  const fixture = createQualityFixture({
    policies: [policy],
    reference: (reference) => {
      assert.ok(reference.translation.content);
      return {
        key: reference.sourceKey,
        language: reference.language,
        source: {
          status: "available",
          text: reference.sourceUnit.unit.source.text,
        },
        target: {
          status: "available",
          text: reference.translation.content.text,
        },
        locations: {
          source: {
            language: null,
            key: reference.sourceKey,
            range: "saved-source.json",
          },
          target: {
            language: reference.language,
            key: reference.sourceKey,
            range: savedRange,
            hostMetadata: { fromReference: true },
          },
        },
      };
    },
    prepare: (input) => {
      preparations++;
      assert.equal(Object.hasOwn(input, "loaded"), false);
      const { candidate, sourceUnit } = input;
      assert.ok(sourceUnit);
      if (candidate === null) return null;
      return {
        key: candidate.sourceKey,
        language: candidate.language,
        source: {
          status: "available",
          text: sourceUnit.unit.source.text,
        },
        target: { status: "available", text: candidate.content.text },
        locations: {
          source: {
            language: null,
            key: candidate.sourceKey,
            range: "prepared-source.json",
          },
          target: {
            language: candidate.language,
            key: candidate.sourceKey,
            range: candidateRange,
            hostMetadata: { adapter: "vue" },
          },
        },
      };
    },
    suppressionStore: {
      load: async () => suppressions,
      upsert: async (suppression) => {
        suppressions = [...suppressions, suppression];
      },
    },
  });
  const selectedChecks = [
    checkIds.sourceSyntax,
    checkIds.targetSyntax,
    checkIds.variableCorrespondence,
    checkIds.allowedTerminology,
    checkIds.forbiddenTerminology,
    checkIds.messageFamilyConsistency,
  ];
  const result = await fixture.run(
    [candidate("current", "激活")],
    selectedChecks,
  );

  assert.equal(preparations, 1);
  const familyFinding = findings(result, checkIds.messageFamilyConsistency)[0];
  assert.deepEqual(familyFinding?.location.range, {
    file: "prepared-target.json",
    revision: 4,
  });
  assert.deepEqual(familyFinding?.location.hostMetadata, { adapter: "vue" });
  const savedReference = familyFinding?.evidence.find(
    ({ role }) => role === "saved-reference",
  );
  assert.deepEqual(savedReference?.location.range, {
    file: "saved-target.json",
    revision: 2,
  });
  assert.deepEqual(savedReference?.location.hostMetadata, {
    fromReference: true,
  });

  const execution = check(result, checkIds.messageFamilyConsistency)
    ?.executions[0];
  assert.ok(execution);
  suppressions = [
    createQaSuppression({
      id: "family-location",
      reason: "接受当前消息族发现",
      execution,
    }),
  ];
  candidateRange = { file: "prepared-target.json", revision: 5 };
  const movedCandidate = await fixture.run(
    [candidate("current", "激活")],
    [checkIds.messageFamilyConsistency],
  );
  assert.equal(movedCandidate.diagnostics[0]?.handling.status, "active");
  assert.deepEqual(
    findings(movedCandidate, checkIds.messageFamilyConsistency)[0]?.location
      .range,
    candidateRange,
  );

  candidateRange = { file: "prepared-target.json", revision: 4 };
  savedRange = { file: "saved-target.json", revision: 3 };
  const movedReference = await fixture.run(
    [candidate("current", "激活")],
    [checkIds.messageFamilyConsistency],
  );
  assert.equal(movedReference.diagnostics[0]?.handling.status, "active");
  assert.deepEqual(
    movedReference.diagnostics[0]?.evidence.find(
      ({ role }) => role === "saved-reference",
    )?.location.range,
    savedRange,
  );
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

  const first = await fixture.run(
    [candidate("monitor", "显示器"), candidate("other", "其他")],
    [checkIds.forbiddenTerminology],
  );
  forbidDisplayTerm = false;
  const second = await fixture.run(
    [candidate("monitor", "显示器")],
    [checkIds.forbiddenTerminology],
  );

  assert.equal(reads, 2);
  assert.equal(findings(first, checkIds.forbiddenTerminology).length, 1);
  assert.deepEqual(findings(second, checkIds.forbiddenTerminology), []);
});

void test("同次 Vue 检查按声明共享读取各类资料一次", async () => {
  const policy = policyFor({
    sourceMessages: { label: "Hello {name}" },
    targetMessages: { label: "你好 {name}" },
  });
  const terms: TermbaseData = { concepts: [] };
  const reads = { languages: 0, policies: 0, terms: 0 };
  await createQualityFixture({
    policies: [policy],
    terms,
    dataReaders: {
      loadLanguages: () => {
        reads.languages++;
        return [{ sourceLanguage: "en", targetLanguage: "zh-CN" }];
      },
      loadPolicies: () => {
        reads.policies++;
        return [policy];
      },
      loadTerms: () => {
        reads.terms++;
        return terms;
      },
    },
  }).run([candidate("label", "你好 {name}")]);
  assert.deepEqual(reads, { languages: 1, policies: 1, terms: 1 });
});

void test("只选 Vue 语法时不读取术语库或消息族策略", async () => {
  const policy = policyFor({
    sourceMessages: { label: "Hello {name}" },
    targetMessages: { label: "你好 {name}" },
  });
  const fixture = createQualityFixture({
    policies: [policy],
    dataReaders: {
      loadLanguages: () => [{ sourceLanguage: "en", targetLanguage: "zh-CN" }],
    },
  });
  const result = await fixture.run(
    [candidate("label", "你好 {name}")],
    [
      checkIds.sourceSyntax,
      checkIds.targetSyntax,
      checkIds.variableCorrespondence,
    ],
  );
  assert.deepEqual(
    result.checks.map(({ checkId, coverage }) => ({ checkId, coverage })),
    [
      {
        checkId: checkIds.sourceSyntax,
        coverage: { selected: 1, evaluated: 1 },
      },
      {
        checkId: checkIds.targetSyntax,
        coverage: { selected: 1, evaluated: 1 },
      },
      {
        checkId: checkIds.variableCorrespondence,
        coverage: { selected: 1, evaluated: 1 },
      },
    ],
  );
});

void test("所选 Vue 术语资料不是 JSON 时保持契约错误", async () => {
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
    fixture.run([candidate("label", "你好")], [checkIds.allowedTerminology]),
    (error: unknown) =>
      error instanceof StandardSchemaContractError &&
      error.kind === "invalid-json",
  );
});

void test("所选 Vue 术语资料不符合术语 schema 时以契约错误中止", async () => {
  const policy = policyFor({ sourceMessages: { label: "Hello" } });
  const fixture = createQualityFixture({
    policies: [policy],
    terms: { concepts: "invalid" } as unknown as TermbaseData,
  });

  await assert.rejects(
    fixture.run([candidate("label", "你好")], [checkIds.allowedTerminology]),
    (error: unknown) => {
      assert.ok(error instanceof StandardSchemaContractError);
      assert.equal(error.kind, "schema-mismatch");
      assert.ok(error.cause instanceof TermContractError);
      return true;
    },
  );
});

void test("缺少目标候选时不把缺译占位转成空消息", async () => {
  const policy = policyFor({
    sourceMessages: { label: "Hello {name}" },
    targetMessages: {},
  });
  const fixture = createQualityFixture({ policies: [policy] });
  const result = await fixture.run([]);

  assert.deepEqual(check(result, checkIds.variableCorrespondence)?.coverage, {
    selected: 0,
    evaluated: 0,
  });
  assert.deepEqual(findings(result, checkIds.variableCorrespondence), []);
});

void test("Vue 术语豁免与缓存仅随当前消息、术语资料和诊断位置变化", async () => {
  const sourceMessages = { a: "monitor", b: "Hello" };
  const targetMessages = { a: "显示器", b: "你好" };
  const policy = policyFor({ sourceMessages, targetMessages });
  let targetRange = "zh-CN.json";
  let suppressions: readonly QaSuppression[] = [];
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
    suppressionStore: {
      async load() {
        return suppressions;
      },
      async upsert(value) {
        suppressions = [...suppressions, value];
      },
    },
    resultCache: {
      async get(key) {
        const value = cache.get(key);
        if (
          value?.some(
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
  const sameTermInputs = (report: typeof first) =>
    ids.map(
      (id) =>
        check(report, id)?.executions[0]?.inputFingerprint ===
        check(first, id)?.executions[0]?.inputFingerprint,
    );
  suppressions = first.checks
    .filter((item) => ids.includes(item.checkId as (typeof ids)[number]))
    .flatMap((item) =>
      item.executions.map((execution) =>
        createQaSuppression({
          id: execution.checkId,
          reason: "接受消息 A",
          execution,
        }),
      ),
    );
  assert.equal(suppressions.length, 2);
  sourceMessages.b = "Goodbye";
  targetMessages.b = "再见";
  const unrelated = await run();
  assert.deepEqual(sameTermInputs(unrelated), [true, true]);
  assert.equal(termCacheHits, 2);
  assert.deepEqual(
    unrelated.diagnostics
      .filter((item) => ids.includes(item.checkId as (typeof ids)[number]))
      .map((item) => item.handling.status),
    ["suppressed", "suppressed"],
  );
  const changedCandidate = await run("另一个译法");
  assert.deepEqual(sameTermInputs(changedCandidate), [false, false]);
  sourceMessages.a = "monitor changed";
  assert.deepEqual(sameTermInputs(await run()), [false, false]);
  sourceMessages.a = "monitor";
  terms = { concepts: [] };
  const changedTerms = await run();
  assert.deepEqual(sameTermInputs(changedTerms), [false, false]);
  assert.deepEqual(findings(changedTerms, checkIds.forbiddenTerminology), []);
  terms = originalTerms;
  targetRange = "moved/zh-CN.json";
  const moved = await run();
  assert.deepEqual(sameTermInputs(moved), [false, false]);
  assert.equal(
    findings(moved, checkIds.forbiddenTerminology)[0]?.location.range,
    targetRange,
  );
  targetRange = "zh-CN.json";
  assert.deepEqual(sameTermInputs(await run()), [true, true]);
});

void test("局部规则复用无关消息和策略变更前的豁免，相关输入和位置变化重新判断", async () => {
  const cases = [
    { id: checkIds.sourceSyntax, source: "bad } source", target: "正常" },
    { id: checkIds.targetSyntax, source: "正常", target: "bad } target" },
    {
      id: checkIds.variableCorrespondence,
      source: "Hello {name}",
      target: "你好 {other}",
    },
    { id: checkIds.protectedLiterals, source: "Use API", target: "使用接口" },
    {
      id: checkIds.quantities,
      source: "Wait 12 minutes",
      target: "等待 13 分钟",
    },
  ];
  for (const scenario of cases) {
    const sourceMessages: Record<string, string> = {
      a: scenario.source,
      b: "Other",
    };
    const targetMessages: Record<string, string> = {
      a: scenario.target,
      b: "其他",
    };
    const literals: Record<string, readonly string[]> = { a: ["API"] };
    const byKey: Record<string, { readonly defaultUnit: string }> = {};
    const policy = policyFor({
      sourceMessages,
      targetMessages,
      protectedLiterals: literals,
      targetQuantities: { profile: "zh-CN", byKey },
    });
    let suppressions: readonly QaSuppression[] = [];
    const values = new Map<
      string,
      Awaited<ReturnType<QualityCheckResultCache["get"]>>
    >();
    let hits = 0;
    let targetRange = "target.json";
    const fixture = createQualityFixture({
      policies: [policy],
      alterProjection: (projection) => ({
        ...projection,
        locations: {
          ...projection.locations,
          target: { ...projection.locations.target, range: targetRange },
        },
      }),
      suppressionStore: {
        load: async () => suppressions,
        upsert: async (value) => {
          suppressions = [...suppressions, value];
        },
      },
      resultCache: {
        get: async (key) => {
          const value = values.get(key);
          if (value) hits++;
          return value;
        },
        set: async (key, value) => {
          values.set(key, value);
        },
      },
    });
    const run = (text = scenario.target) =>
      fixture.run([candidate("a", text)], [scenario.id]);
    const first = await run();
    assert.equal(findings(first, scenario.id).length, 1, scenario.id);
    suppressions = [
      createQaSuppression({
        id: scenario.id,
        reason: "接受当前消息",
        execution: check(first, scenario.id)!.executions[0]!,
      }),
    ];
    sourceMessages.b = "Other changed";
    targetMessages.b = "另一条消息";
    literals.b = ["unrelated"];
    byKey.b = { defaultUnit: "hour" };
    const stable = await run();
    assert.equal(
      check(stable, scenario.id)?.executions[0]?.inputFingerprint,
      suppressions[0]?.inputFingerprint,
      scenario.id,
    );
    assert.equal(
      findings(stable, scenario.id)[0]?.handling.status,
      "suppressed",
    );
    assert.ok(hits > 0, scenario.id);
    assert.notEqual(
      check(await run(`${scenario.target} changed`), scenario.id)?.executions[0]
        ?.inputFingerprint,
      suppressions[0]?.inputFingerprint,
      scenario.id,
    );
    targetRange = "moved.json";
    assert.notEqual(
      check(await run(), scenario.id)?.executions[0]?.inputFingerprint,
      suppressions[0]?.inputFingerprint,
      scenario.id,
    );
    targetRange = "target.json";
    assert.equal(
      check(await run(), scenario.id)?.executions[0]?.inputFingerprint,
      suppressions[0]?.inputFingerprint,
      scenario.id,
    );
    if (scenario.id === checkIds.protectedLiterals) literals.a = ["API", "SDK"];
    else if (scenario.id === checkIds.quantities)
      byKey.a = { defaultUnit: "hour" };
    else sourceMessages.a = `${scenario.source} changed`;
    assert.notEqual(
      check(await run(), scenario.id)?.executions[0]?.inputFingerprint,
      suppressions[0]?.inputFingerprint,
      scenario.id,
    );
  }
});

void test("链接豁免按直接键存在性和完整可达闭包复用缓存", async () => {
  const sourceMessages: Record<string, string> = {
    a: "Root",
    b: "@:a",
    unrelated: "Other",
  };
  const targetMessages: Record<string, string> = {
    a: "@:b @:missing",
    b: "@:a",
    unrelated: "其他",
  };
  let suppressions: readonly QaSuppression[] = [];
  const cache = new Map<
    string,
    Awaited<ReturnType<QualityCheckResultCache["get"]>>
  >();
  let hits = 0;
  const fixture = createQualityFixture({
    policies: [policyFor({ sourceMessages, targetMessages })],
    suppressionStore: {
      load: async () => suppressions,
      upsert: async (value) => {
        suppressions = [...suppressions, value];
      },
    },
    resultCache: {
      get: async (key) => {
        const value = cache.get(key);
        if (value) hits++;
        return value;
      },
      set: async (key, value) => {
        cache.set(key, value);
      },
    },
  });
  const text = "@:b @:missing";
  const run = () => fixture.run([candidate("a", text)]);
  const first = await run();
  const ids = [checkIds.linkTargetExists, checkIds.linkCycle];
  suppressions = ids.map((id) =>
    createQaSuppression({
      id,
      reason: "接受当前关联",
      execution: check(first, id)!.executions[0]!,
    }),
  );
  const sameInputs = (result: typeof first) =>
    ids.map(
      (id) =>
        check(result, id)?.executions[0]?.inputFingerprint ===
        check(first, id)?.executions[0]?.inputFingerprint,
    );
  targetMessages.unrelated = "@:unrelated";
  targetMessages.a = "保存正文不覆盖候选";
  assert.deepEqual(sameInputs(await run()), [true, true]);
  assert.ok(hits >= 2);
  targetMessages.b = "No link";
  const changedBody = await run();
  assert.deepEqual(sameInputs(changedBody), [true, false]);
  assert.deepEqual(findings(changedBody, checkIds.linkCycle), []);
  delete targetMessages.b;
  const fallback = await run();
  assert.deepEqual(sameInputs(fallback), [true, false]);
  assert.equal(findings(fallback, checkIds.linkCycle).length, 1);
  targetMessages.b = "@:a";
  assert.deepEqual(sameInputs(await run()), [true, true]);
  // 首个循环后的引用也属于完整闭包；新键即使不改变首个循环仍改变依据。
  targetMessages.missing = "@:a";
  const added = await run();
  assert.deepEqual(sameInputs(added), [false, false]);
  assert.deepEqual(findings(added, checkIds.linkTargetExists), []);
  // 即使先遇到有效循环，另一条可达分支解析失败仍会使整次检查抛错拒绝。
  targetMessages.missing = "bad }";
  await assert.rejects(
    fixture.run([candidate("a", text)], [checkIds.linkCycle]),
    /vue-i18n\/link-cycle.*a.*zh-CN/u,
  );
  delete targetMessages.missing;
  targetMessages.b = "bad }";
  await assert.rejects(
    fixture.run([candidate("a", text)], [checkIds.linkCycle]),
    /vue-i18n\/link-cycle.*a.*zh-CN/u,
  );
  const linkTargetOnly = await fixture.run(
    [candidate("a", text)],
    [checkIds.linkTargetExists],
  );
  assert.equal(
    check(linkTargetOnly, checkIds.linkTargetExists)?.executions[0]
      ?.inputFingerprint,
    check(first, checkIds.linkTargetExists)?.executions[0]?.inputFingerprint,
  );
});

void test("缺失关联键后来补全成循环会重新检查", async () => {
  const sourceMessages = { a: "Root" };
  const targetMessages: Record<string, string> = { a: "@:missing" };
  const cache = new Map<
    string,
    Awaited<ReturnType<QualityCheckResultCache["get"]>>
  >();
  let hits = 0;
  const fixture = createQualityFixture({
    policies: [policyFor({ sourceMessages, targetMessages })],
    resultCache: {
      async get(key) {
        const value = cache.get(key);
        if (value !== undefined) hits++;
        return value;
      },
      async set(key, value) {
        cache.set(key, value);
      },
    },
  });
  const run = () =>
    fixture.run([candidate("a", "@:missing")], [checkIds.linkCycle]);
  const first = await run();
  assert.deepEqual(findings(first, checkIds.linkCycle), []);
  assert.equal(hits, 0);
  await run();
  assert.equal(hits, 1);
  targetMessages.missing = "@:a";
  const added = await run();
  assert.equal(hits, 1);
  assert.equal(
    findings(added, checkIds.linkCycle)[0]?.handling.status,
    "active",
  );
  assert.equal(findings(added, checkIds.linkCycle).length, 1);
});

void test("消息族按已知源族局部化目标语法缺口，未知源族仍抛错拒绝", async () => {
  for (const [source, shouldReject] of [
    ["Enabled", true],
    ["Other", false],
    ["bad } source", true],
  ] as const) {
    const fixture = createQualityFixture({
      policies: [
        policyFor({
          sourceMessages: { a: "Enabled", b: "Enabled", broken: source },
          targetMessages: { a: "启用", b: "开启", broken: "bad } target" },
          scopes: [{ scope: "ui", keys: ["a", "b", "broken"] }],
        }),
      ],
    });
    if (shouldReject) {
      await assert.rejects(
        fixture.run(
          [candidate("a", "启用")],
          [checkIds.messageFamilyConsistency],
        ),
        /message-family-consistency.*a.*zh-CN/u,
      );
    } else {
      const result = await fixture.run(
        [candidate("a", "启用")],
        [checkIds.messageFamilyConsistency],
      );
      assert.equal(
        findings(result, checkIds.messageFamilyConsistency).length,
        1,
        source,
      );
    }
  }
});

void test("消息族只随实际采用的目标等价变化重新判断", async () => {
  const targetEquivalences: string[][] = [];
  let suppressions: readonly QaSuppression[] = [];
  const fixture = createQualityFixture({
    policies: [
      policyFor({
        sourceMessages: { a: "Active", b: "Active" },
        targetMessages: { a: "A", b: "B" },
        scopes: [{ scope: "ui", keys: ["a", "b"] }],
        targetEquivalences,
      }),
    ],
    suppressionStore: {
      load: async () => suppressions,
      upsert: async (value) => {
        suppressions = [...suppressions, value];
      },
    },
  });
  const run = () => fixture.run([candidate("a", "A")]);
  const first = await run();
  suppressions = [
    createQaSuppression({
      id: "family",
      reason: "接受同族差异",
      execution: check(first, checkIds.messageFamilyConsistency)!
        .executions[0]!,
    }),
  ];
  targetEquivalences.push(["Other", "Unrelated"]);
  assert.equal(
    findings(await run(), checkIds.messageFamilyConsistency)[0]?.handling
      .status,
    "suppressed",
  );
  targetEquivalences.push(["A", "B"]);
  const related = await run();
  assert.deepEqual(findings(related, checkIds.messageFamilyConsistency), []);
});

void test("Vue 准备适配先验证返回结构与投影，普通 TypeError 同样抛错中止运行", async () => {
  const policies = [policyFor({ sourceMessages: { label: "Hello" } })];
  const selectedIds = [
    checkIds.sourceSyntax,
    checkIds.targetSyntax,
    checkIds.variableCorrespondence,
    checkIds.linkTargetExists,
    checkIds.linkCycle,
    checkIds.protectedLiterals,
    checkIds.quantities,
    checkIds.allowedTerminology,
    checkIds.forbiddenTerminology,
    checkIds.messageFamilyConsistency,
  ];
  for (const checkId of selectedIds) {
    for (const invalid of [undefined, { key: "label", language: "zh-CN" }]) {
      const fixture = createQualityFixture({
        policies,
        prepare: () => invalid as never,
      });
      await assert.rejects(
        fixture.run([candidate("label", "你好")], [checkId]),
        StandardSchemaContractError,
      );
    }
    const fixture = createQualityFixture({
      policies,
      prepare: () => {
        throw new TypeError("宿主消息提取失败");
      },
    });
    await assert.rejects(
      fixture.run([candidate("label", "你好")], [checkId]),
      new RegExp(`${checkId}.*label.*zh-CN.*宿主消息提取失败`, "u"),
    );
  }
});

void test("Vue 消息族参照投影的非法返回与宿主普通 TypeError 均抛错中止运行", async () => {
  const policies = [
    policyFor({
      sourceMessages: { editing: "Hello", saved: "Hello" },
      targetMessages: { saved: "你好" },
    }),
  ];
  for (const invalid of [null, { key: "saved", language: "zh-CN" }]) {
    const fixture = createQualityFixture({
      policies,
      reference: () => invalid as never,
    });
    await assert.rejects(
      fixture.run(
        [candidate("editing", "你好")],
        [checkIds.messageFamilyConsistency],
      ),
      StandardSchemaContractError,
    );
  }
  const fixture = createQualityFixture({
    policies,
    reference: () => {
      throw new TypeError("宿主参照提取失败");
    },
  });
  await assert.rejects(
    fixture.run(
      [candidate("editing", "你好")],
      [checkIds.messageFamilyConsistency],
    ),
    /message-family-consistency.*editing.*zh-CN.*宿主参照提取失败/u,
  );
});
