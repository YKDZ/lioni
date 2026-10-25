import assert from "node:assert/strict";
import test from "node:test";

import {
  compareMessageFamily,
  createMessageFamilyChecker,
  indexMessageFamilies,
} from "@lioni/checks";
import type { MessageFamilyLimits } from "@lioni/checks";
import {
  analyzeQuality,
  defineConfig,
  prepareQualityConditionedSemanticEdit,
  type QualityCheckInput,
  type SourceUnitFact,
  StandardSchemaContractError,
  type StandardSchemaV1,
} from "@lioni/core";
import { asciiNumbers, createTextAnalysis } from "@lioni/text-analysis";
import type {
  TemplateSignature,
  TextAnalysis,
  TextRange,
} from "@lioni/text-analysis";

type Unit = { readonly id: string; readonly source: string };
type Translation = { readonly id: string; readonly text: string };

const unitSchema: StandardSchemaV1<Unit, Unit> = {
  "~standard": {
    version: 1,
    vendor: "lioni-message-family-test",
    validate(value) {
      if (
        typeof value !== "object" ||
        value === null ||
        Array.isArray(value) ||
        !("id" in value) ||
        typeof value.id !== "string" ||
        !("source" in value) ||
        typeof value.source !== "string"
      )
        return { issues: [{ message: "原文单元结构不匹配。" }] };
      return { value: { id: value.id, source: value.source } };
    },
  },
};

const translationSchema: StandardSchemaV1<Translation, Translation> = {
  "~standard": {
    version: 1,
    vendor: "lioni-message-family-test",
    validate(value) {
      if (
        typeof value !== "object" ||
        value === null ||
        Array.isArray(value) ||
        !("id" in value) ||
        typeof value.id !== "string" ||
        !("text" in value) ||
        typeof value.text !== "string"
      )
        return { issues: [{ message: "译文记录结构不匹配。" }] };
      return { value: { id: value.id, text: value.text } };
    },
  },
};

const stringSchema: StandardSchemaV1<string, string> = {
  "~standard": {
    version: 1,
    vendor: "lioni-message-family-test",
    validate(value) {
      return typeof value === "string"
        ? { value }
        : { issues: [{ message: "译文正文必须是字符串。" }] };
    },
  },
};

function checkerFor(
  options: {
    readonly partialCandidate?: boolean;
    readonly referenceProjections?: { count: number };
    readonly analysis?: TextAnalysis;
    readonly targetEquivalence?: (signature: TemplateSignature) => string;
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
              : `translation:${input.translation.index}:${sourceKey}`,
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
      return result;
    },
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

function configFor(
  units: readonly Unit[],
  translations: readonly Translation[],
  qualityChecker: ReturnType<typeof checkerFor>,
  exceptions: readonly {
    readonly id: string;
    readonly ruleId: string;
    readonly scope: {
      readonly object: {
        readonly kind: string;
        readonly key: string;
        readonly language?: string;
      };
    };
    readonly reason: string;
  }[] = [],
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
    qualityChecks: [qualityChecker],
    createQualityRequest: () => ({
      candidates: [],
      dependencies: {},
      exceptions,
    }),
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

void test("message family comparison deduplicates by physical record, not text", () => {
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

void test("message family comparison caps displayed categories while counting all facts", () => {
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

void test("message family QA excludes the replaced physical record and keeps other identical facts", async () => {
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
  assert.equal(result.diagnostics[0]?.severity, "warning");
  assert.equal(result.diagnostics[0]?.ruleId, "message-family-consistency");
  const references = result.diagnostics[0]!.evidence.filter(
    ({ role }) => role === "saved-reference",
  );
  assert.equal(references.length, 2);
  assert.equal(
    references.some(
      ({ value }) =>
        typeof value === "object" &&
        value !== null &&
        "translationIndex" in value &&
        value.translationIndex === 0,
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
  assert.equal(projected.count, 3);
});

void test("declared target equivalence allows wording while unlisted signatures retain a category", async () => {
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

void test("business scopes remain separate even when source signatures match", async () => {
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

void test("message family candidates do not become references for one another", async () => {
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

void test("message family output caps categories and representatives after comparing every reference", async () => {
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

void test("complete facts with no same-family reference are explicitly not applicable", async () => {
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

void test("conflicted saved association keeps every known row and marks the comparison incomplete", async () => {
  const config = configFor(
    [
      { id: "editing", source: "Error Code 404" },
      { id: "other", source: "Error Code 504" },
    ],
    [
      { id: "editing", text: "错误码 404" },
      { id: "editing", text: "错误 404" },
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
        "translationIndex" in value
          ? value.translationIndex
          : null,
      )
      .sort((left, right) => Number(left) - Number(right)),
    [0, 1, 2],
  );
  assert.ok(
    result.checks[0]?.issues.some(
      ({ code }) => code === "candidateAssociationConflict",
    ),
  );
});

void test("empty candidates do not project saved references", async () => {
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

void test("invalid UTF-16 protected ranges fail as projection contract errors", async () => {
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
        error instanceof StandardSchemaContractError &&
        error.kind === "schema-mismatch",
    );
  }
});

void test("message family keeps known warning evidence when projection is incomplete and honors the host condition", async () => {
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

  const gated = await prepareQualityConditionedSemanticEdit(config, {
    candidate,
    condition: (quality) => quality.diagnostics.length === 0,
  });
  assert.equal(gated.status, "rejected");
  if (gated.status === "rejected")
    assert.equal(gated.quality.diagnostics[0]?.severity, "warning");
});

void test("partial target structure reports known reference disagreement and keeps completeness limited", async () => {
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

void test("message family exception preserves the warning and its handling", async () => {
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
    [
      {
        id: "known-family-variation",
        ruleId: "message-family-consistency",
        scope: {
          object: {
            kind: "translation-unit",
            key: "editing",
            language: "zh",
          },
        },
        reason: "保留现有界面用语。",
      },
    ],
  );
  const result = await analyzeQuality(exceptionConfig, {
    candidates: [
      { sourceKey: "editing", language: "zh", content: "错误码 404" },
    ],
  });

  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0]?.severity, "warning");
  assert.deepEqual(result.diagnostics[0]?.handling, {
    status: "excepted",
    exceptionId: "known-family-variation",
    reason: "保留现有界面用语。",
  });
});
