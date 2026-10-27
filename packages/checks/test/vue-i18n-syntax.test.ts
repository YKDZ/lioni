import assert from "node:assert/strict";
import test from "node:test";

import {
  createVueI18nSourceSyntaxChecker,
  createVueI18nTargetSyntaxChecker,
  createVueI18nVariableCorrespondenceChecker,
} from "@lioni/checks";
import {
  analyzeQuality,
  defineConfig,
  type QualityCheckDefinition,
  type QualityCheckInput,
  type QualityObject,
  type SourceUnitFact,
  type StandardSchemaV1,
} from "@lioni/core";

type Content = { readonly message: { readonly body: string } };
type Unit = {
  readonly source: {
    readonly identity: string;
    readonly message: { readonly body: string };
  };
};
type Translation = { readonly nativeKey: string; readonly content: Content };

const unitSchema: StandardSchemaV1<Unit, Unit> = {
  "~standard": {
    version: 1,
    vendor: "lioni-vue-i18n-syntax-test",
    validate(value) {
      return isUnit(value)
        ? { value }
        : { issues: [{ message: "原文结构无效。" }] };
    },
  },
};

const translationSchema: StandardSchemaV1<Translation, Translation> = {
  "~standard": {
    version: 1,
    vendor: "lioni-vue-i18n-syntax-test",
    validate(value) {
      return isTranslation(value)
        ? { value }
        : { issues: [{ message: "译文结构无效。" }] };
    },
  },
};

const contentSchema: StandardSchemaV1<Content, Content> = {
  "~standard": {
    version: 1,
    vendor: "lioni-vue-i18n-syntax-test",
    validate(value) {
      return isContent(value)
        ? { value }
        : { issues: [{ message: "候选正文结构无效。" }] };
    },
  },
};

function sourceChecker() {
  return createVueI18nSourceSyntaxChecker<Unit, Translation, Unit, Content>({
    hostVersion: "checks-test-v1",
    select: (input: QualityCheckInput<Unit, Translation, unknown, Content>) => {
      if (input.sourceUnit === null)
        return {
          status: "incomplete" as const,
          issue: { code: "sourceUnavailable", message: "找不到原文。" },
        };
      return {
        status: "selected" as const,
        subject: {
          sourceUnit: input.sourceUnit as SourceUnitFact<Unit>,
          sourceKey: input.candidate.sourceKey,
          language: input.candidate.language,
        },
      };
    },
    sourceText: (unit) => unit.source.message.body,
    sourceLocation: (_unit, subject, range) => ({
      language: null,
      range: { file: "source.json", key: subject.key, span: range },
      key: subject.key,
    }),
  });
}

function targetChecker() {
  return createVueI18nTargetSyntaxChecker<Unit, Translation, Content, Content>({
    hostVersion: "checks-test-v1",
    select: (input) => ({
      status: "selected",
      subject: {
        sourceKey: input.candidate.sourceKey,
        language: input.candidate.language,
        content: input.candidate.content,
      },
    }),
    targetText: (content) => content.message.body,
  });
}

function variableChecker() {
  return createVueI18nVariableCorrespondenceChecker<
    Unit,
    Translation,
    Unit,
    Content,
    Content
  >({
    select: (input) => {
      if (input.sourceUnit === null)
        return {
          status: "incomplete",
          issue: { code: "sourceUnavailable", message: "找不到原文。" },
        };
      return {
        status: "selected",
        subject: {
          sourceUnit: input.sourceUnit as SourceUnitFact<Unit>,
          sourceKey: input.candidate.sourceKey,
          language: input.candidate.language,
          content: input.candidate.content,
        },
      };
    },
    sourceText: (unit) => unit.source.message.body,
    targetText: (content) => content.message.body,
  });
}

function configFor(
  source: string | undefined,
  target: string | undefined,
  checks: readonly QualityCheckDefinition<
    Unit,
    Translation,
    QualityObject,
    Content
  >[],
) {
  return defineConfig({
    source: {
      schema: unitSchema,
      read: () => ({
        scopes: [
          {
            range: "source.json",
            enumeration: "complete" as const,
            records:
              source === undefined
                ? []
                : [
                    {
                      value: {
                        source: {
                          identity: "message",
                          message: { body: source },
                        },
                      },
                      bodyAvailability: "available" as const,
                    },
                  ],
          },
        ],
      }),
    },
    keyOf: ({ source: { identity } }) => `hash:${identity}`,
    translations: {
      languages: ["fr"],
      identityOf: (translation) => ({
        namespace: "messages",
        key: translation.nativeKey,
      }),
      schema: translationSchema,
      contentSchema,
      contentOf: (translation) => translation.content,
      matches: (unit, translation) =>
        unit.source.identity === translation.nativeKey,
      read: (_language, units) => ({
        scopes: [
          {
            range: "fr.json",
            enumeration: "complete" as const,
            covers: units.map(({ key }) => key),
            records:
              target === undefined
                ? []
                : [
                    {
                      value: {
                        nativeKey: "message",
                        content: { message: { body: target } },
                      },
                      bodyAvailability: "available" as const,
                    },
                  ],
          },
        ],
      }),
    },
    qualityChecks: checks,
  });
}

void test("原文与候选译文语法分别报告，并将原文错误映射回原文", async () => {
  const result = await analyzeQuality(
    configFor("bad } source", "wrong } target", [
      sourceChecker(),
      targetChecker(),
    ]),
    {
      candidates: [
        {
          sourceKey: "hash:message",
          language: "fr",
          content: { message: { body: "wrong } target" } },
        },
      ],
    },
  );

  assert.equal(result.status, "complete");
  assert.equal(result.diagnostics.length, 2);
  const source = result.diagnostics.find(
    (diagnostic) => diagnosticCheckId(diagnostic) === "vue-i18n/source-syntax",
  );
  const target = result.diagnostics.find(
    (diagnostic) => diagnosticCheckId(diagnostic) === "vue-i18n/target-syntax",
  );
  assert.equal(source?.severity, "error");
  assert.equal(source?.object.kind, "source-unit");
  assert.equal(source?.location.language, null);
  assert.deepEqual(source?.location.range, {
    file: "source.json",
    key: "hash:message",
    span: { start: 4, end: 4 },
  });
  assert.equal(target?.severity, "error");
  assert.equal(target?.object.kind, "translation-unit");
  assert.equal(target?.location.language, "fr");
  assert.equal(target?.location.range, "fr.json");
  assert.deepEqual(target?.location.span, { start: 6, end: 6 });
});

void test("目标语法检查可投影嵌套正文且不要求存在原文或非空文本", async () => {
  const config = configFor(undefined, undefined, [targetChecker()]);
  const invalid = await analyzeQuality(config, {
    candidates: [
      {
        sourceKey: "orphan",
        language: "fr",
        content: { message: { body: "bad } target" } },
      },
    ],
  });
  const empty = await analyzeQuality(config, {
    candidates: [
      {
        sourceKey: "orphan",
        language: "fr",
        content: { message: { body: "" } },
      },
    ],
  });

  assert.equal(invalid.status, "complete");
  assert.equal(invalid.diagnostics.length, 1);
  assert.equal(invalid.diagnostics[0]?.object.key, "orphan");
  assert.equal(invalid.diagnostics[0]?.object.language, "fr");
  assert.equal(empty.status, "complete");
  assert.deepEqual(empty.diagnostics, []);
});

void test("变量可重排，重复次数精确，且 Literal 不计变量", async () => {
  const result = await analyzeQuality(
    configFor(
      "{name} {name} {0} {n} {'literal'}",
      "{n} {'literal'} {0} {name} {name}",
      [variableChecker()],
    ),
  );

  assert.equal(result.status, "complete");
  assert.deepEqual(result.diagnostics, []);
});

void test("变量身份和出现次数严格比较", async () => {
  const mismatch = await analyzeQuality(
    configFor("{name} {name} {0} {n}", "{name} {0} {count} {extra}", [
      variableChecker(),
    ]),
  );
  const positionVsName = await analyzeQuality(
    configFor("{0}", "{name}", [variableChecker()]),
  );
  const nVsCount = await analyzeQuality(
    configFor("{n}", "{count}", [variableChecker()]),
  );

  assert.equal(mismatch.status, "complete");
  assert.equal(mismatch.diagnostics.length, 1);
  assert.equal(
    diagnosticCheckId(mismatch.diagnostics[0]),
    "vue-i18n/variable-correspondence",
  );
  assert.equal(mismatch.diagnostics[0]?.severity, "error");
  assert.equal(positionVsName.diagnostics.length, 1);
  assert.equal(nVsCount.diagnostics.length, 1);
});

void test("分支比较使用去重后的变量计数模式并保留空模式", async () => {
  const folded = await analyzeQuality(
    configFor("{count} item | {count} items", "{count} things", [
      variableChecker(),
    ]),
  );
  const repeated = await analyzeQuality(
    configFor("{count} items", "{count} item | {count} items", [
      variableChecker(),
    ]),
  );
  const exchanged = await analyzeQuality(
    configFor("{n} | {count} {count}", "{count} {count} | {n}", [
      variableChecker(),
    ]),
  );
  const differentCountRemoved = await analyzeQuality(
    configFor("{count} {count} | {count}", "{count} {count}", [
      variableChecker(),
    ]),
  );
  const emptyPatternRemoved = await analyzeQuality(
    configFor("plain | {n}", "{n}", [variableChecker()]),
  );

  assert.deepEqual(folded.diagnostics, []);
  assert.deepEqual(repeated.diagnostics, []);
  assert.deepEqual(exchanged.diagnostics, []);
  assert.equal(differentCountRemoved.diagnostics.length, 1);
  assert.equal(emptyPatternRemoved.diagnostics.length, 1);
});

void test("动态关联键中的直接变量参与计数，静态关联键不展开", async () => {
  const matchingDynamicKey = await analyzeQuality(
    configFor("{name} @:{route} @:linked", "@:linked {route} {name}", [
      variableChecker(),
    ]),
  );
  const extraDynamicKeyVariable = await analyzeQuality(
    configFor("@:linked", "@:linked @:{route}", [variableChecker()]),
  );

  assert.deepEqual(matchingDynamicKey.diagnostics, []);
  assert.equal(extraDynamicKeyVariable.diagnostics.length, 1);
});

void test("任一消息语法非法时变量比较不执行", async () => {
  for (const [source, target] of [
    ["{name} }", "{name}"],
    ["{name}", "{name} }"],
    ["{name} }", "{name} }"],
  ]) {
    const result = await analyzeQuality(
      configFor(source!, target!, [variableChecker()]),
    );

    assert.equal(result.status, "incomplete");
    assert.deepEqual(result.diagnostics, []);
    assert.equal(result.checks[0]?.status, "incomplete");
  }
});

void test("缺译不制造空候选，显式空候选仍参与变量比较", async () => {
  const config = configFor("{name}", undefined, [variableChecker()]);
  const noCandidate = await analyzeQuality(config);
  const explicitEmptyCandidate = await analyzeQuality(config, {
    candidates: [
      {
        sourceKey: "hash:message",
        language: "fr",
        content: { message: { body: "" } },
      },
    ],
  });

  assert.equal(noCandidate.checks[0]?.status, "not-run");
  assert.deepEqual(noCandidate.diagnostics, []);
  assert.equal(explicitEmptyCandidate.status, "complete");
  assert.equal(explicitEmptyCandidate.diagnostics.length, 1);
});

function isContent(value: unknown): value is Content {
  return (
    isRecord(value) &&
    isRecord(value.message) &&
    typeof value.message.body === "string"
  );
}

function isUnit(value: unknown): value is Unit {
  return (
    isRecord(value) &&
    isRecord(value.source) &&
    typeof value.source.identity === "string" &&
    isContent({ message: value.source.message })
  );
}

function isTranslation(value: unknown): value is Translation {
  return (
    isRecord(value) &&
    typeof value.nativeKey === "string" &&
    isContent(value.content)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function diagnosticCheckId(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.checkId === "string") return value.checkId;
  if (typeof value.ruleId === "string") return value.ruleId;
  return undefined;
}
