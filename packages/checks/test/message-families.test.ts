import assert from "node:assert/strict";
import test from "node:test";

import {
  compareMessageFamily,
  createMessageFamilyChecker,
  indexMessageFamilies,
} from "@lioni/checks";
import type { MessageFamilyInput, MessageFamilyLimits } from "@lioni/checks";
import {
  analyzeQuality,
  createQualityException,
  defineConfig,
  type QualityCheckInput,
  type QualityException,
  type QualityExceptionStore,
  type SourceUnitFact,
  StandardSchemaContractError,
  QualityCheckBindingError,
  snapshotJsonValue,
  type QualityCheckResultCache,
} from "@lioni/core";
import {
  asciiNumbers,
  createTextAnalysis,
  signatureKey,
} from "@lioni/text-analysis";
import type {
  TemplateSignature,
  TextAnalysis,
  TextRange,
} from "@lioni/text-analysis";
import { z } from "zod";

const unitSchema = z.object({ id: z.string(), source: z.string() }).readonly();
const translationSchema = z
  .object({
    id: z.string(),
    text: z.string(),
    targetKey: z.string().optional(),
  })
  .readonly();
const stringSchema = z.string();
type Unit = z.output<typeof unitSchema>;
type Translation = z.output<typeof translationSchema>;

function checkerFor(
  options: {
    readonly partialCandidate?: boolean;
    readonly candidateProjection?: MessageFamilyInput;
    readonly referenceProjection?: MessageFamilyInput;
    readonly explicitBasis?: boolean;
    readonly referenceProjections?: { count: number };
    readonly analysis?: TextAnalysis;
    readonly targetEquivalence?: (
      signature: TemplateSignature,
      language: string,
      input: QualityCheckInput<Unit, Translation, unknown, string>,
    ) => string;
    readonly limits?: Partial<MessageFamilyLimits>;
    readonly separateScopeFor?: string;
    readonly protectedRanges?: readonly TextRange[];
  } = {},
) {
  const slotPolicy = {
    abstract: (token: { readonly kind: string }) =>
      token.kind === "number"
        ? { kind: "slot", identity: "error-code" }
        : undefined,
  };
  return createMessageFamilyChecker<Unit, Translation, Unit, string>({
    hostVersion: "message-families-test-v1",
    select: (input: QualityCheckInput<Unit, Translation, unknown, string>) => {
      const selectedUnit = input.sourceUnit;
      if (selectedUnit === null)
        return {
          status: "incomplete",
          issue: { code: "sourceUnavailable", message: "找不到原文单元。" },
        };
      if (input.candidate.language !== "zh")
        return { status: "not-applicable" };
      return {
        status: "selected",
        subject: {
          sourceUnit: selectedUnit as SourceUnitFact<Unit>,
          sourceKey: input.candidate.sourceKey,
          language: input.candidate.language,
          content: input.candidate.content,
        },
      };
    },
    project: (input) => {
      const isCandidate = input.kind === "candidate";
      const selected = isCandidate ? input.subject : input;
      const sourceUnit = selected.sourceUnit;
      const sourceKey = selected.sourceKey;
      const language = selected.language;
      const target = isCandidate
        ? input.subject.content
        : input.translation.bodyAvailability === "available"
          ? input.translation.content
          : undefined;
      const source = sourceUnit.unit.source;
      if (!isCandidate && options.referenceProjections !== undefined)
        options.referenceProjections.count += 1;
      const complete =
        sourceUnit.bodyAvailability === "available" && target !== undefined;
      const result = {
        complete: options.partialCandidate && isCandidate ? false : complete,
        groups: [
          {
            ref: isCandidate
              ? `candidate:${sourceKey}`
              : `translation:${input.translation.identity.key}:${sourceKey}`,
            scope: options.separateScopeFor === sourceKey ? "domain" : "ui",
            source: {
              language: "en",
              complete: sourceUnit.bodyAvailability === "available",
              fragments: [{ ref: `source:${sourceKey}`, text: source }],
            },
            target: {
              language,
              complete: target !== undefined,
              fragments:
                target === undefined
                  ? []
                  : [
                      {
                        ref: `target:${sourceKey}`,
                        text: target,
                        ...(options.protectedRanges === undefined
                          ? {}
                          : { protectedRanges: options.protectedRanges }),
                      },
                    ],
            },
          },
        ],
        issues:
          options.partialCandidate && isCandidate
            ? [
                {
                  code: "candidateProjectionPartial",
                  message: "候选还有未投影的消息组。",
                },
              ]
            : [],
      };
      return (
        (isCandidate
          ? options.candidateProjection
          : options.referenceProjection) ?? result
      );
    },
    ...(options.explicitBasis
      ? {
          fingerprintInput: ({ projected, subject }) =>
            snapshotJsonValue(
              {
                projected,
                sourceKey: subject.sourceKey,
                language: subject.language,
              },
              "测试消息族依据",
            ),
        }
      : {}),
    analysis:
      options.analysis ?? createTextAnalysis({ recognizers: [asciiNumbers()] }),
    sourceTemplate: slotPolicy,
    targetTemplate: slotPolicy,
    ...(options.targetEquivalence === undefined
      ? {}
      : { targetEquivalence: options.targetEquivalence }),
    ...(options.limits === undefined ? {} : { limits: options.limits }),
  });
}

void test("消息族正式入口验证展示上限并保留投影证据", async () => {
  await assert.rejects(
    analyzeQuality(
      configFor(
        [{ id: "editing", source: "Save" }],
        [],
        checkerFor({ limits: { maxCategories: 0 } }),
      ),
      {
        candidates: [{ sourceKey: "editing", language: "zh", content: "保存" }],
      },
    ),
    StandardSchemaContractError,
  );
  assert.throws(
    () =>
      compareMessageFamily(
        indexMessageFamilies([]),
        { familyKey: "ui|en|zh|Save", targetKey: "保存" },
        new Set(),
        { maxCategories: 1.5, maxSourcesPerCategory: 2 },
      ),
    TypeError,
  );

  const specialReference = JSON.parse('{"__proto__":{"retained":true}}');
  const projection = {
    groups: [
      {
        ref: specialReference,
        scope: "ui",
        source: {
          language: "en",
          fragments: [{ ref: "source", text: "Save", extra: "fragment" }],
          extra: "text",
        },
        target: {
          language: "zh",
          fragments: [{ ref: "target", text: "保存" }],
        },
        extra: "group",
      },
    ],
    extra: "input",
  };
  Object.defineProperty(projection, "__proto__", {
    configurable: true,
    enumerable: true,
    value: { retained: true },
  });
  const result = await analyzeQuality(
    configFor(
      [
        { id: "editing", source: "Save" },
        { id: "saved", source: "Save" },
      ],
      [{ id: "saved", text: "储存" }],
      checkerFor({ candidateProjection: projection }),
    ),
    { candidates: [{ sourceKey: "editing", language: "zh", content: "保存" }] },
  );
  assert.equal(result.status, "complete");
  const evidence = result.diagnostics[0]?.evidence.find(
    ({ role }) => role === "candidate",
  )?.value;
  assert.ok(
    evidence &&
      typeof evidence === "object" &&
      "groupRef" in evidence &&
      "source" in evidence,
  );
  assert.deepEqual(evidence.groupRef, specialReference);
  assert.deepEqual(evidence.source, projection.groups[0]!.source);
});

void test("一致且没有诊断时也在投影入口拒绝特殊键中的非 JSON 引用", async () => {
  const invalidProjection = {
    groups: [
      {
        ref: { nested: Object.fromEntries([["__proto__", undefined]]) },
        scope: "ui",
        source: {
          language: "en",
          fragments: [{ ref: "source", text: "Save" }],
        },
        target: {
          language: "zh",
          fragments: [{ ref: "target", text: "保存" }],
        },
      },
    ],
  } as unknown as MessageFamilyInput;
  for (const kind of ["candidate", "reference"] as const) {
    const checker = checkerFor(
      kind === "candidate"
        ? { candidateProjection: invalidProjection }
        : { referenceProjection: invalidProjection },
    );
    await assert.rejects(
      analyzeQuality(
        configFor(
          [
            { id: "editing", source: "Save" },
            { id: "saved", source: "Save" },
          ],
          [{ id: "saved", text: "保存" }],
          checker,
        ),
        {
          candidates: [
            { sourceKey: "editing", language: "zh", content: "保存" },
          ],
        },
      ),
      (error: unknown) => {
        let cause = error;
        while (cause instanceof QualityCheckBindingError) cause = cause.cause;
        assert.ok(cause instanceof StandardSchemaContractError);
        assert.equal(cause.kind, "schema-mismatch");
        assert.deepEqual(cause.issues?.[0]?.path, ["groups", 0, "ref"]);
        return true;
      },
    );
  }
});

function configFor(
  units: readonly Unit[],
  translations: readonly Translation[],
  qualityChecker: ReturnType<typeof checkerFor>,
  exceptionStore?: QualityExceptionStore,
  resultCache?: QualityCheckResultCache,
) {
  return defineConfig({
    source: {
      schema: unitSchema,
      read: () => ({
        scopes: [
          {
            range: "en.json",
            enumeration: "complete" as const,
            records: units.map((value) => ({
              value,
              bodyAvailability: "available" as const,
            })),
          },
        ],
      }),
    },
    keyOf: ({ id }) => id,
    translations: {
      languages: ["zh"],
      keyOf: (translation) => ({
        namespace: "messages",
        key: translation.targetKey ?? translation.id,
      }),
      schema: translationSchema,
      contentSchema: stringSchema,
      contentOf: ({ text }) => text,
      read: (_language, sourceUnits) => ({
        scopes: [
          {
            range: "zh.json",
            covers: sourceUnits.map(({ key }) => key),
            enumeration: "complete" as const,
            records: translations.map((value) => ({
              value,
              bodyAvailability: "available" as const,
            })),
          },
        ],
      }),
      matches: (unit, translation) => unit.id === translation.id,
    },
    quality: {
      checks: [qualityChecker],
      buildCandidates: () => [],
      ...(exceptionStore === undefined ? {} : { exceptionStore }),
      ...(resultCache === undefined ? {} : { resultCache }),
    },
  });
}

function reference(
  translationIndex: number,
  targetKey: string,
  sourceKey = `source-${translationIndex}`,
) {
  return {
    familyKey: "ui|en|zh|Error Code {number}",
    targetKey,
    translationIndex,
    translationIdentity: {
      language: "zh",
      namespace: "messages",
      key: `record-${translationIndex}`,
    },
    sourceKey,
    group: {
      ref: `${sourceKey}:${translationIndex}`,
      scope: "ui",
      source: { language: "en", fragments: [] },
      target: { language: "zh", fragments: [] },
    },
    sourceSignatures: [],
    targetSignatures: [],
  };
}

void test("同一物理记录的重复映射只计数一次，不按文本去重", () => {
  const index = indexMessageFamilies([
    reference(4, "same-target", "alias-a"),
    reference(4, "same-target", "alias-b"),
    reference(9, "same-target", "another-record"),
  ]);
  const result = compareMessageFamily(
    index,
    { familyKey: "ui|en|zh|Error Code {number}", targetKey: "other-target" },
    new Set([4]),
    { maxCategories: 3, maxSourcesPerCategory: 3 },
  );

  assert.equal(result.status, "different");
  assert.equal(result.referenceCount, 1);
  assert.equal(result.categoryCount, 1);
  assert.equal(result.categories[0]?.referenceCount, 1);
  assert.equal(result.categories[0]?.references[0]?.translationIndex, 9);
});

void test("展示类别与代表来源受限，但计数覆盖全部参照", () => {
  const index = indexMessageFamilies([
    reference(1, "variant-b"),
    reference(2, "variant-c"),
    reference(3, "variant-a"),
    reference(4, "variant-b"),
  ]);
  const result = compareMessageFamily(
    index,
    { familyKey: "ui|en|zh|Error Code {number}", targetKey: "variant-a" },
    new Set(),
    { maxCategories: 1, maxSourcesPerCategory: 1 },
  );

  assert.equal(result.status, "different");
  assert.equal(result.categoryCount, 3);
  assert.equal(result.referenceCount, 4);
  assert.equal(result.categories.length, 1);
  assert.equal(result.categories[0]?.key, "variant-b");
  assert.equal(result.categories[0]?.referenceCount, 2);
  assert.equal(result.categories[0]?.references.length, 1);
  assert.equal(result.omittedCategories, 2);
  assert.equal(result.omittedReferences, 3);
});

void test("排除当前替代记录并保留其他内容相同的事实", async () => {
  const projected = { count: 0 };
  const checker = checkerFor({ referenceProjections: projected });
  const config = configFor(
    [
      { id: "editing", source: "Error Code 404" },
      { id: "same-copy", source: "Error Code 404" },
      { id: "different", source: "Error Code 504" },
    ],
    [
      { id: "editing", text: "错误码 404" },
      { id: "same-copy", text: "错误码 404" },
      { id: "different", text: "错误 504" },
    ],
    checker,
  );
  const result = await analyzeQuality(config, {
    candidates: [
      { sourceKey: "editing", language: "zh", content: "错误码 404" },
    ],
  });

  assert.equal(result.status, "complete");
  assert.equal(result.diagnostics.length, 1);
  assert.equal(
    result.checks[0]?.version,
    "checks.message-family-consistency/v2+message-families-test-v1",
  );
  assert.equal(result.diagnostics[0]?.severity, "warning");
  assert.equal(result.diagnostics[0]?.checkId, "message-family-consistency");
  const references = result.diagnostics[0]!.evidence.filter(
    ({ role }) => role === "saved-reference",
  );
  assert.equal(references.length, 2);
  assert.equal(
    references.some(
      ({ value }) =>
        typeof value === "object" &&
        value !== null &&
        "sourceKey" in value &&
        value.sourceKey === "editing",
    ),
    false,
  );
  const candidateEvidence = result.diagnostics[0]!.evidence.find(
    ({ role }) => role === "candidate",
  );
  assert.ok(candidateEvidence);
  const candidateValue = candidateEvidence.value as {
    readonly signatures: readonly {
      readonly slots: readonly {
        readonly raw: string;
        readonly start: number;
        readonly end: number;
      }[];
    }[];
  };
  assert.deepEqual(candidateValue.signatures[0]?.slots[0], {
    kind: "slot",
    identity: "error-code",
    raw: "404",
    start: 4,
    end: 7,
  });
  assert.equal(projected.count, 2);
});

void test("声明的目标等价表达可合并，未声明签名仍独立计类", async () => {
  const targetEquivalence = (signature: TemplateSignature) =>
    JSON.stringify(
      signature.parts.map((part) =>
        part.type === "text" &&
        (part.text === "错误码 " || part.text === "错误 ")
          ? ["text", "错误 "]
          : part.type === "text"
            ? ["text", part.text]
            : ["slot", part.kind, part.identity],
      ),
    );
  const analyze = (extra: boolean) =>
    analyzeQuality(
      configFor(
        [
          { id: "editing", source: "Error Code 404" },
          { id: "saved", source: "Error Code 504" },
          ...(extra ? [{ id: "unlisted", source: "Error Code 304" }] : []),
        ],
        [
          { id: "editing", text: "错误 404" },
          { id: "saved", text: "错误码 504" },
          ...(extra ? [{ id: "unlisted", text: "警告 304" }] : []),
        ],
        checkerFor({ targetEquivalence }),
      ),
      {
        candidates: [
          { sourceKey: "editing", language: "zh", content: "错误 404" },
        ],
      },
    );

  const equivalent = await analyze(false);
  assert.equal(equivalent.diagnostics.length, 0);
  const withUnlistedSignature = await analyze(true);
  assert.equal(withUnlistedSignature.diagnostics.length, 1);
  assert.equal(withUnlistedSignature.diagnostics[0]?.severity, "warning");
  const summary = withUnlistedSignature.diagnostics[0]?.evidence.find(
    ({ role }) => role === "comparison-summary",
  );
  assert.ok(summary);
  assert.equal(
    (summary.value as { readonly categoryCount: number }).categoryCount,
    2,
  );
});

void test("业务范围不同的消息不会相互比较", async () => {
  const config = configFor(
    [
      { id: "editing", source: "Error Code 404" },
      { id: "other-scope", source: "Error Code 504" },
    ],
    [
      { id: "editing", text: "错误码 404" },
      { id: "other-scope", text: "错误 504" },
    ],
    checkerFor({ separateScopeFor: "other-scope" }),
  );
  const result = await analyzeQuality(config, {
    candidates: [
      { sourceKey: "editing", language: "zh", content: "错误码 404" },
    ],
  });

  assert.equal(result.diagnostics.length, 0);
  assert.ok(
    result.checks[0]?.issues.some(
      ({ code }) => code === "noComparableReference",
    ),
  );
});

void test("待写回候选不会成为彼此的参照", async () => {
  const projected = { count: 0 };
  const config = configFor(
    [
      { id: "saved", source: "Error Code 404" },
      { id: "pending", source: "Error Code 504" },
    ],
    [{ id: "saved", text: "错误码 404" }],
    checkerFor({ referenceProjections: projected }),
  );
  const result = await analyzeQuality(config, {
    candidates: [
      { sourceKey: "saved", language: "zh", content: "错误码 404" },
      { sourceKey: "pending", language: "zh", content: "错误 504" },
    ],
  });

  assert.equal(result.status, "complete");
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0]?.object.key, "pending");
  assert.equal(projected.count, 1);
});

void test("QA 输出限制类别与代表来源，但比较覆盖全部参照", async () => {
  const config = configFor(
    [
      { id: "editing", source: "Error Code 404" },
      { id: "saved-a", source: "Error Code 504" },
      { id: "saved-b", source: "Error Code 304" },
      { id: "saved-c", source: "Error Code 204" },
    ],
    [
      { id: "editing", text: "错误码 404" },
      { id: "saved-a", text: "错误 504" },
      { id: "saved-b", text: "告警 304" },
      { id: "saved-c", text: "其它 204" },
    ],
    checkerFor({ limits: { maxCategories: 1, maxSourcesPerCategory: 1 } }),
  );
  const result = await analyzeQuality(config, {
    candidates: [
      { sourceKey: "editing", language: "zh", content: "错误码 404" },
    ],
  });

  assert.equal(result.diagnostics.length, 1);
  const diagnostic = result.diagnostics[0]!;
  const references = diagnostic.evidence.filter(
    ({ role }) => role === "saved-reference",
  );
  assert.equal(references.length, 1);
  const summary = diagnostic.evidence.find(
    ({ role }) => role === "comparison-summary",
  );
  assert.ok(summary);
  const summaryValue = summary.value as {
    readonly categoryCount: number;
    readonly referenceCount: number;
    readonly omittedCategories: number;
    readonly omittedReferences: number;
    readonly categories: readonly { readonly referenceCount: number }[];
  };
  assert.deepEqual(
    [
      summaryValue.categoryCount,
      summaryValue.referenceCount,
      summaryValue.omittedCategories,
      summaryValue.omittedReferences,
      summaryValue.categories[0]?.referenceCount,
    ],
    [3, 3, 2, 2, 1],
  );
});

void test("完整资料没有同族参照时明确返回不适用", async () => {
  const config = configFor(
    [{ id: "new", source: "Error Code 404" }],
    [],
    checkerFor(),
  );
  const result = await analyzeQuality(config, {
    candidates: [{ sourceKey: "new", language: "zh", content: "错误码 404" }],
  });

  assert.equal(result.status, "not-applicable");
  assert.equal(result.diagnostics.length, 0);
  assert.ok(
    result.checks[0]?.issues.some(
      ({ code }) => code === "noComparableReference",
    ),
  );
});

void test("关联冲突时保留全部已知记录并标记不完整", async () => {
  const config = configFor(
    [
      { id: "editing", source: "Error Code 404" },
      { id: "other", source: "Error Code 504" },
    ],
    [
      { id: "editing", targetKey: "editing.one", text: "错误码 404" },
      { id: "editing", targetKey: "editing.two", text: "错误 404" },
      { id: "other", text: "错误码 504" },
    ],
    checkerFor(),
  );
  const result = await analyzeQuality(config, {
    candidates: [
      { sourceKey: "editing", language: "zh", content: "错误码 404" },
    ],
  });

  assert.equal(result.status, "incomplete");
  assert.equal(result.diagnostics.length, 1);
  assert.deepEqual(
    result.diagnostics[0]?.evidence
      .filter(({ role }) => role === "saved-reference")
      .map(({ value }) =>
        typeof value === "object" &&
        value !== null &&
        "translationIdentity" in value
          ? (value.translationIdentity as { key: string }).key
          : null,
      )
      .sort(),
    ["editing.one", "editing.two", "other"],
  );
  assert.ok(
    result.checks[0]?.issues.some(
      ({ code }) => code === "candidateAssociationConflict",
    ),
  );
});

void test("候选为空时不投影已保存参照", async () => {
  const projections = { count: 0 };
  const config = configFor(
    [{ id: "saved", source: "Error Code 404" }],
    [{ id: "saved", text: "错误码 404" }],
    checkerFor({ referenceProjections: projections }),
  );
  assert.equal(projections.count, 0);

  const result = await analyzeQuality(config, { candidates: [] });

  assert.equal(result.status, "not-run");
  assert.equal(projections.count, 0);
});

void test("非法 UTF-16 保护范围作为投影契约错误拒绝", async () => {
  for (const protectedRange of [
    { start: 0, end: 1 },
    { start: 0, end: 3 },
  ]) {
    const config = configFor(
      [{ id: "editing", source: "Error Code 404" }],
      [{ id: "editing", text: "😀" }],
      checkerFor({ protectedRanges: [protectedRange] }),
    );

    await assert.rejects(
      analyzeQuality(config, {
        candidates: [{ sourceKey: "editing", language: "zh", content: "😀" }],
      }),
      (error: unknown) =>
        error instanceof QualityCheckBindingError &&
        error.cause instanceof StandardSchemaContractError &&
        error.cause.kind === "schema-mismatch" &&
        error.cause.message.includes("保护范围"),
    );
  }
});

void test("投影不完整时保留已知警告", async () => {
  const units = [
    { id: "editing", source: "Error Code 404" },
    { id: "different", source: "Error Code 504" },
  ];
  const translations = [
    { id: "editing", text: "错误码 404" },
    { id: "different", text: "错误 504" },
  ];
  const candidate = {
    sourceKey: "editing",
    language: "zh",
    content: "错误码 404",
  };
  const config = configFor(
    units,
    translations,
    checkerFor({ partialCandidate: true }),
  );
  const result = await analyzeQuality(config, { candidates: [candidate] });

  assert.equal(result.status, "incomplete");
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0]?.severity, "warning");
  assert.ok(
    result.checks[0]?.issues.some(
      ({ code }) => code === "candidateProjectionPartial",
    ),
  );
});

void test("目标结构分析不完整时保留已知参照差异并标记不完整", async () => {
  const numbers = asciiNumbers();
  const analysis = createTextAnalysis({
    recognizers: [
      async (input) => {
        const found = await numbers(input);
        const tokens = "tokens" in found ? found.tokens : found;
        return input.language === "zh" && input.text === "错误码 405"
          ? {
              tokens,
              complete: false,
              issues: [
                {
                  code: "partialTargetStructure",
                  message: "候选仍有未知结构。",
                },
              ],
            }
          : tokens;
      },
    ],
  });
  const config = configFor(
    [
      { id: "editing", source: "Error Code 404" },
      { id: "saved-a", source: "Error Code 504" },
      { id: "saved-b", source: "Error Code 304" },
    ],
    [
      { id: "editing", text: "错误码 404" },
      { id: "saved-a", text: "错误码 504" },
      { id: "saved-b", text: "错误 304" },
    ],
    checkerFor({ analysis }),
  );
  const result = await analyzeQuality(config, {
    candidates: [
      { sourceKey: "editing", language: "zh", content: "错误码 405" },
    ],
  });

  assert.equal(result.status, "incomplete");
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0]?.severity, "warning");
  assert.ok(
    result.checks[0]?.issues.some(
      ({ code }) => code === "partialTargetStructure",
    ),
  );
});

void test("例外保留警告处理状态，未声明依据的通用工厂仍保守对待其他事实", async () => {
  let exceptions: readonly QualityException[] = [];
  const exceptionStore: QualityExceptionStore = {
    async load() {
      return exceptions;
    },
    async upsert(exception) {
      exceptions = [
        ...exceptions.filter(({ id }) => id !== exception.id),
        exception,
      ];
    },
  };
  const exceptionConfig = configFor(
    [
      { id: "editing", source: "Error Code 404" },
      { id: "different", source: "Error Code 504" },
    ],
    [
      { id: "editing", text: "错误码 404" },
      { id: "different", text: "错误 504" },
    ],
    checkerFor(),
    exceptionStore,
  );
  const candidates = [
    { sourceKey: "editing", language: "zh", content: "错误码 404" },
  ];
  const initial = await analyzeQuality(exceptionConfig, { candidates });
  const execution = initial.checks
    .find(({ checkId }) => checkId === "message-family-consistency")
    ?.executions.find(
      ({ sourceKey, language }) => sourceKey === "editing" && language === "zh",
    );
  assert.ok(execution);
  await exceptionStore.upsert(
    createQualityException({
      id: "known-family-variation",
      reason: "保留现有界面用语。",
      execution,
    }),
  );

  const result = await analyzeQuality(exceptionConfig, {
    candidates,
  });

  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0]?.severity, "warning");
  assert.deepEqual(result.diagnostics[0]?.handling, {
    status: "excepted",
    exceptionId: "known-family-variation",
    reason: "保留现有界面用语。",
  });
  const changed = await analyzeQuality(
    configFor(
      [
        { id: "editing", source: "Error Code 404" },
        { id: "different", source: "Error Code 504" },
        { id: "unrelated", source: "Save" },
      ],
      [
        { id: "editing", text: "错误码 404" },
        { id: "different", text: "错误 504" },
        { id: "unrelated", text: "保存" },
      ],
      checkerFor(),
      exceptionStore,
    ),
    { candidates },
  );
  assert.equal(changed.exceptionApplicability[0]?.status, "basis-changed");
});

void test("同次候选的等价回调分别接收当前候选，参照不共享首次结果", async () => {
  const result = await analyzeQuality(
    configFor(
      [
        { id: "first", source: "Error Code 404" },
        { id: "second", source: "Error Code 504" },
        { id: "saved", source: "Error Code 304" },
      ],
      [{ id: "saved", text: "错误码 304" }],
      checkerFor({
        targetEquivalence: (_signature, _language, input) =>
          input.candidate.sourceKey,
      }),
    ),
    {
      candidates: [
        { sourceKey: "first", language: "zh", content: "错误码 404" },
        { sourceKey: "second", language: "zh", content: "错误码 504" },
      ],
    },
  );
  assert.equal(result.status, "complete");
  assert.deepEqual(result.diagnostics, []);
});

void test("显式消息族依据复用无关编辑的缓存和例外，并跟随全部同族成员与位置变化", async () => {
  const units: Unit[] = [
    { id: "editing", source: "Error Code 404" },
    { id: "saved-a", source: "Error Code 504" },
    { id: "saved-b", source: "Error Code 304" },
    { id: "other", source: "Good morning" },
  ];
  const translations: Translation[] = [
    { id: "editing", text: "旧译文" },
    { id: "saved-a", text: "错误 504" },
    { id: "saved-b", text: "告警 304" },
    { id: "other", text: "早上好" },
  ];
  const initialUnits = [...units];
  const initialTranslations = [...translations];
  const stored = new Map<
    string,
    Awaited<ReturnType<QualityCheckResultCache["get"]>>
  >();
  let hits = 0;
  const cache: QualityCheckResultCache = {
    async get(key) {
      const value = stored.get(key);
      if (value !== undefined) hits++;
      return value;
    },
    async set(key, value) {
      stored.set(key, value);
    },
  };
  let exceptions: readonly QualityException[] = [];
  const exceptionStore: QualityExceptionStore = {
    async load() {
      return exceptions;
    },
    async upsert(value) {
      exceptions = [value];
    },
  };
  const checker = checkerFor({
    explicitBasis: true,
    limits: { maxCategories: 1, maxSourcesPerCategory: 1 },
  });
  const candidates = [
    { sourceKey: "editing", language: "zh", content: "错误码 404" },
  ];
  const run = () =>
    analyzeQuality(
      configFor(units, translations, checker, exceptionStore, cache),
      { candidates },
    );
  const initial = await run();
  assert.equal(initial.diagnostics.length, 1);
  await exceptionStore.upsert(
    createQualityException({
      id: "family",
      reason: "保留已有表达。",
      execution: initial.checks[0]!.executions[0]!,
    }),
  );
  const assertRestored = async () => {
    const result = await run();
    assert.equal(result.exceptionApplicability[0]?.status, "applicable");
    assert.equal(result.diagnostics[0]?.handling.status, "excepted");
    assert.deepEqual(
      result.diagnostics[0]?.evidence,
      initial.diagnostics[0]?.evidence,
    );
  };

  translations[3] = { id: "other", text: "上午好" };
  units.reverse();
  translations.reverse();
  await assertRestored();
  assert.equal(hits, 1);
  units.unshift({ id: "inserted", source: "Save" });
  translations.unshift({ id: "inserted", text: "保存" });
  await assertRestored();
  assert.equal(hits, 2);
  units.splice(
    units.findIndex(({ id }) => id === "other"),
    1,
  );
  translations.splice(
    translations.findIndex(({ id }) => id === "other"),
    1,
  );
  await assertRestored();
  assert.equal(hits, 3);

  // 展示只有一个代表，修改未显示参照的正文（类别不变）仍须重判。
  const shown = initial.diagnostics[0]!.evidence.find(
    ({ role }) => role === "saved-reference",
  )!.object.key;
  const hidden = shown === "saved-a" ? "saved-b" : "saved-a";
  const hiddenIndex = translations.findIndex(({ id }) => id === hidden);
  translations[hiddenIndex] = {
    ...translations[hiddenIndex]!,
    text: hidden === "saved-a" ? "错误 505" : "告警 305",
  };
  assert.equal(
    (await run()).exceptionApplicability[0]?.status,
    "basis-changed",
  );
  assert.equal(hits, 3);
  units.splice(0, units.length, ...initialUnits);
  translations.splice(0, translations.length, ...initialTranslations);
  await assertRestored();
  assert.equal(hits, 4);

  units.push({ id: "new-member", source: "Error Code 204" });
  translations.push({ id: "new-member", text: "错误 204" });
  assert.equal(
    (await run()).exceptionApplicability[0]?.status,
    "basis-changed",
  );
  assert.equal(hits, 4);
  units.pop();
  translations.pop();
  units[3] = { id: "other", source: "Error Code 104" };
  assert.equal(
    (await run()).exceptionApplicability[0]?.status,
    "basis-changed",
  );
  assert.equal(hits, 4);
  units[3] = initialUnits[3]!;
  await assertRestored();
  assert.equal(hits, 5);

  const moved = configFor(units, translations, checker, exceptionStore, cache);
  const originalAdapter = moved.translations!;
  const movedConfig = defineConfig({
    ...moved,
    translations: {
      ...moved.translations!,
      read: async (language, sourceUnits) => {
        const read = await originalAdapter.read(language, sourceUnits);
        return {
          ...read,
          scopes: read.scopes.map((scope) => ({
            ...scope,
            range: "relocated/zh.json",
          })),
        };
      },
    },
  });
  assert.equal(
    (await analyzeQuality(movedConfig, { candidates }))
      .exceptionApplicability[0]?.status,
    "basis-changed",
  );
  assert.equal(hits, 5);
});

void test("已知其他族的关联冲突局部化，相关冲突与未知源结构仍限制当前族", async () => {
  const units: Unit[] = [
    { id: "editing", source: "Error Code 404" },
    { id: "saved", source: "Error Code 504" },
    { id: "broken", source: "Save" },
  ];
  const translations: Translation[] = [
    { id: "saved", text: "错误 504" },
    { id: "broken", targetKey: "broken.one", text: "保存" },
    { id: "broken", targetKey: "broken.two", text: "储存" },
  ];
  const numbers = asciiNumbers();
  const analysis = createTextAnalysis({
    recognizers: [
      async (input) =>
        input.text === "Unknown source"
          ? {
              tokens: [],
              complete: false,
              issues: [
                { code: "sourceStructureUnknown", message: "未知源结构。" },
              ],
            }
          : numbers(input),
    ],
  });
  const run = () =>
    analyzeQuality(
      configFor(
        units,
        translations,
        checkerFor({ analysis, explicitBasis: true }),
      ),
      {
        candidates: [
          { sourceKey: "editing", language: "zh", content: "错误码 404" },
        ],
      },
    );
  const unrelated = await run();
  assert.equal(unrelated.status, "complete");
  assert.equal(
    unrelated.checks[0]?.issues.some(
      ({ code }) => code === "translationAssociationConflict",
    ),
    false,
  );
  units[2] = { id: "broken", source: "Error Code 304" };
  const related = await run();
  assert.equal(related.status, "incomplete");
  assert.equal(
    related.checks[0]?.issues.some(
      ({ code }) => code === "translationAssociationConflict",
    ),
    true,
  );
  units[2] = { id: "broken", source: "Unknown source" };
  const unknown = await run();
  assert.equal(unknown.status, "incomplete");
  assert.equal(
    unknown.checks[0]?.issues.some(
      ({ code }) => code === "sourceStructureUnknown",
    ),
    true,
  );
});

void test("同一保存记录的同类别重复组稳定选择完整证据，缓存与重新计算一致", async () => {
  const group = (text: string) => ({
    ref: "same-ref",
    scope: "ui",
    source: { language: "en", fragments: [{ ref: "source", text: "Save" }] },
    target: { language: "zh", fragments: [{ ref: "target", text }] },
  });
  const stored = new Map<
    string,
    Awaited<ReturnType<QualityCheckResultCache["get"]>>
  >();
  let hits = 0;
  const cache: QualityCheckResultCache = {
    async get(key) {
      const value = stored.get(key);
      if (value !== undefined) hits++;
      return value;
    },
    async set(key, value) {
      stored.set(key, value);
    },
  };
  const run = (
    texts: readonly string[],
    resultCache?: QualityCheckResultCache,
  ) =>
    analyzeQuality(
      configFor(
        [
          { id: "editing", source: "Save" },
          { id: "saved", source: "Save" },
        ],
        [{ id: "saved", text: "A" }],
        checkerFor({
          explicitBasis: true,
          candidateProjection: { groups: [group("C")] },
          referenceProjection: { groups: texts.map(group) },
          targetEquivalence: (signature) =>
            ["A", "B"].includes(
              signature.parts[0]?.type === "text"
                ? signature.parts[0].text
                : "",
            )
              ? "same"
              : signatureKey(signature),
        }),
        undefined,
        resultCache,
      ),
      { candidates: [{ sourceKey: "editing", language: "zh", content: "C" }] },
    );
  const before = await run(["A", "B"], cache);
  const cached = await run(["B", "A"], cache);
  const fresh = await run(["B", "A"]);
  assert.equal(hits, 1);
  assert.equal(before.diagnostics.length, 1);
  assert.deepEqual(cached.diagnostics, fresh.diagnostics);
  assert.deepEqual(before.diagnostics, fresh.diagnostics);
});
