import assert from "node:assert/strict";

import {
  compareMessageFamily,
  createMessageFamilyChecker,
  indexMessageFamilies,
} from "@lioni/checks";
import type {
  MessageFamilyGroup,
  MessageFamilyLimits,
  MessageFamilyReference,
} from "@lioni/checks";
import {
  analyzeQuality,
  applySemanticEdits,
  defineConfig,
  prepareQualityConditionedSemanticEdit,
  StandardSchemaContractError,
} from "@lioni/core";
import type {
  QualityCheckInput,
  SourceUnitFact,
  StandardSchemaV1,
} from "@lioni/core";
import { asciiNumbers, createTextAnalysis } from "@lioni/text-analysis";
import type {
  TemplateSignature,
  TextAnalysis,
  TextRange,
} from "@lioni/text-analysis";

type Unit = { readonly id: string; readonly source: string };
type Translation = { readonly id: string; readonly text: string };
type Counters = { references: number; recognitions: number };
type CheckerOptions = {
  readonly partialCandidate?: boolean;
  readonly incompleteTarget?: string;
  readonly domainSources?: ReadonlySet<string>;
  readonly targetEquivalence?: (signature: TemplateSignature) => string;
  readonly limits?: Partial<MessageFamilyLimits>;
  readonly protectedRanges?: readonly TextRange[];
  readonly counters?: Counters;
};
type ConfigOptions = CheckerOptions & {
  readonly units?: readonly Unit[];
  readonly translations?: readonly Translation[];
  readonly exceptions?: readonly {
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
  }[];
};

const defaultUnits: readonly Unit[] = [
  { id: "editing", source: "Error Code 404" },
  { id: "alias", source: "Error Code 404" },
  { id: "same-copy", source: "Error Code 404" },
  { id: "saved-a", source: "Error Code 504" },
  { id: "saved-b", source: "Error Code 304" },
  { id: "domain", source: "Error Code 504" },
  { id: "pending", source: "Error Code 204" },
];
const defaultTranslations: readonly Translation[] = [
  { id: "physical", text: "错误码 404" },
  { id: "same-copy", text: "错误码 404" },
  { id: "saved-a", text: "错误 504" },
  { id: "saved-b", text: "告警 304" },
  { id: "domain", text: "错误码 504" },
];

const unitSchema: StandardSchemaV1<Unit, Unit> = {
  "~standard": {
    version: 1,
    vendor: "lioni-message-family-consumer",
    validate(value) {
      if (
        !isRecord(value) ||
        typeof value.id !== "string" ||
        typeof value.source !== "string"
      )
        return { issues: [{ message: "原文单元结构无效。" }] };
      return { value: { id: value.id, source: value.source } };
    },
  },
};
const translationSchema: StandardSchemaV1<Translation, Translation> = {
  "~standard": {
    version: 1,
    vendor: "lioni-message-family-consumer",
    validate(value) {
      if (
        !isRecord(value) ||
        typeof value.id !== "string" ||
        typeof value.text !== "string"
      )
        return { issues: [{ message: "译文记录结构无效。" }] };
      return { value: { id: value.id, text: value.text } };
    },
  },
};
const stringSchema: StandardSchemaV1<string, string> = {
  "~standard": {
    version: 1,
    vendor: "lioni-message-family-consumer",
    validate(value) {
      return typeof value === "string"
        ? { value }
        : { issues: [{ message: "译文正文必须是字符串。" }] };
    },
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function slotPolicy() {
  return {
    abstract: (token: { readonly kind: string }) =>
      token.kind === "number"
        ? { kind: "slot", identity: "error-code" }
        : undefined,
  };
}

function createChecker(options: CheckerOptions = {}) {
  const numberRecognizer = asciiNumbers();
  const analysis: TextAnalysis = createTextAnalysis({
    recognizers: [
      async (input) => {
        if (options.counters !== undefined) options.counters.recognitions += 1;
        const found = await numberRecognizer(input);
        const tokens = "tokens" in found ? found.tokens : found;
        if (input.text === options.incompleteTarget)
          return {
            tokens,
            complete: false,
            issues: [
              {
                code: "partialTargetStructure",
                message: "保存目标仍有未知结构。",
              },
            ],
          };
        return tokens;
      },
    ],
  });

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
      if (!isCandidate && options.counters !== undefined)
        options.counters.references += 1;
      const complete =
        sourceUnit.bodyAvailability === "available" && target !== undefined;
      return {
        complete: options.partialCandidate && isCandidate ? false : complete,
        groups: [
          {
            ref: isCandidate
              ? `candidate:${sourceKey}`
              : `translation:${input.translation.index}:${sourceKey}`,
            scope: options.domainSources?.has(sourceKey) ? "domain" : "ui",
            source: {
              language: "en",
              complete: sourceUnit.bodyAvailability === "available",
              fragments: [
                { ref: `source:${sourceKey}`, text: sourceUnit.unit.source },
              ],
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
    },
    analysis,
    sourceTemplate: slotPolicy(),
    targetTemplate: slotPolicy(),
    ...(options.targetEquivalence === undefined
      ? {}
      : { targetEquivalence: options.targetEquivalence }),
    ...(options.limits === undefined ? {} : { limits: options.limits }),
  });
}

function createConfig(options: ConfigOptions = {}) {
  const units = options.units ?? defaultUnits;
  const translations = options.translations ?? defaultTranslations;
  const storedTexts = new Map(
    translations.map(({ id, text }) => [id, text] as const),
  );
  const checker = createChecker(options);
  const config = defineConfig({
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
            records: [...storedTexts].map(([id, text]) => ({
              value: { id, text },
              bodyAvailability: "available" as const,
            })),
          },
        ],
      }),
      matches: (unit, translation) =>
        translation.id === "physical"
          ? unit.id === "editing" || unit.id === "alias"
          : unit.id === translation.id,
    },
    translationWriteback: {
      locateExistingTarget: ({ translation }) => ({
        status: "located",
        locator: { id: translation.translation.id },
      }),
      locateNewTarget: () => ({
        status: "notWritable",
        reason: "本场景只修改已有译文。",
      }),
      write: ({ edit }) => {
        if (edit.operation !== "write")
          throw new Error("本场景收到意外删除操作。");
        const locator = edit.target.locator;
        if (!isRecord(locator) || typeof locator.id !== "string")
          throw new Error("写回定位器缺少译文记录 id。");
        storedTexts.set(locator.id, edit.content);
      },
    },
    qualityChecks: [checker],
    createQualityRequest: () => ({
      candidates: [],
      dependencies: {},
      exceptions: options.exceptions ?? [],
    }),
  });
  return { config, storedTexts };
}

function diagnosticFor(
  quality: Awaited<ReturnType<typeof analyzeQuality>>,
  sourceKey: string,
) {
  return quality.diagnostics.find(({ object }) => object.key === sourceKey);
}

function summaryFor(value: unknown) {
  assert.ok(isRecord(value));
  return value as {
    readonly categoryCount: number;
    readonly referenceCount: number;
    readonly omittedCategories: number;
    readonly omittedReferences: number;
    readonly categories: readonly { readonly referenceCount: number }[];
  };
}

function reference(index: number, targetKey: string): MessageFamilyReference {
  const group: MessageFamilyGroup = {
    ref: `record:${index}`,
    scope: "ui",
    source: { language: "en", fragments: [] },
    target: { language: "zh", fragments: [] },
  };
  return {
    familyKey: "explicit-error-family",
    targetKey,
    translationIndex: index,
    sourceKey: `source-${index}`,
    group,
    sourceSignatures: [],
    targetSignatures: [],
  };
}

function equivalentTarget(signature: TemplateSignature): string {
  return JSON.stringify(
    signature.parts.map((part) =>
      part.type === "text" && (part.text === "错误码 " || part.text === "错误 ")
        ? ["text", "错误 "]
        : part.type === "text"
          ? ["text", part.text]
          : ["slot", part.kind, part.identity],
    ),
  );
}

const candidates = [
  { sourceKey: "editing", language: "zh", content: "错误码 404" },
  { sourceKey: "pending", language: "zh", content: "新表达 204" },
];
const counters: Counters = { references: 0, recognitions: 0 };
const baseline = createConfig({ counters, domainSources: new Set(["domain"]) });
assert.equal(counters.references, 0, "配置创建不得投影保存参照。");
const baselineQuality = await analyzeQuality(baseline.config, { candidates });
assert.equal(baselineQuality.status, "complete");
assert.equal(counters.references, 6, "两个候选共享一次完整参照投影。");
assert.equal(
  counters.recognitions,
  9,
  "相同语言和文本的结构只分析一次，多个候选复用同一分析 memo。",
);
const physicalDiagnostic = diagnosticFor(baselineQuality, "editing");
assert.ok(physicalDiagnostic);
assert.equal(physicalDiagnostic.severity, "warning");
assert.equal(physicalDiagnostic.ruleId, "message-family-consistency");
const physicalReferences = physicalDiagnostic.evidence.filter(
  ({ role }) => role === "saved-reference",
);
assert.equal(physicalReferences.length, 3);
assert.equal(
  physicalReferences.some(
    ({ value }) => isRecord(value) && value.translationIndex === 0,
  ),
  false,
  "当前候选替代的物理记录及其别名投影都应排除。",
);
const physicalSummary = summaryFor(
  physicalDiagnostic.evidence.find(({ role }) => role === "comparison-summary")
    ?.value,
);
assert.deepEqual(
  [physicalSummary.categoryCount, physicalSummary.referenceCount],
  [3, 3],
);
assert.ok(
  physicalReferences.some(
    ({ value }) => isRecord(value) && value.sourceKey === "same-copy",
  ),
  "正文相同但物理独立的记录仍需保留。",
);
assert.equal(
  diagnosticFor(baselineQuality, "pending")?.severity,
  "warning",
  "其他待写回候选可以被检查，但不能互相成为保存参照。",
);

const bounded = createConfig({
  limits: { maxCategories: 1, maxSourcesPerCategory: 1 },
  domainSources: new Set(["domain"]),
});
const boundedQuality = await analyzeQuality(bounded.config, {
  candidates: [candidates[0]!],
});
const boundedDiagnostic = diagnosticFor(boundedQuality, "editing");
assert.ok(boundedDiagnostic);
const boundedSummary = summaryFor(
  boundedDiagnostic.evidence.find(({ role }) => role === "comparison-summary")
    ?.value,
);
assert.deepEqual(
  [
    boundedSummary.categoryCount,
    boundedSummary.referenceCount,
    boundedSummary.omittedCategories,
    boundedSummary.omittedReferences,
    boundedSummary.categories[0]?.referenceCount,
  ],
  [3, 3, 2, 2, 1],
);
assert.equal(
  boundedDiagnostic.evidence.filter(({ role }) => role === "saved-reference")
    .length,
  1,
);

const pureIndex = indexMessageFamilies([
  reference(4, "same-expression"),
  reference(4, "same-expression"),
  reference(9, "same-expression"),
  reference(10, "second-expression"),
  reference(11, "third-expression"),
]);
const pureComparison = compareMessageFamily(
  pureIndex,
  { familyKey: "explicit-error-family", targetKey: "candidate-expression" },
  new Set([4]),
  { maxCategories: 1, maxSourcesPerCategory: 1 },
);
assert.deepEqual(
  [
    pureComparison.status,
    pureComparison.categoryCount,
    pureComparison.referenceCount,
    pureComparison.omittedCategories,
    pureComparison.omittedReferences,
  ],
  ["different", 3, 3, 2, 2],
);

const exceptionConfig = createConfig({
  exceptions: [
    {
      id: "known-family-variation",
      ruleId: "message-family-consistency",
      scope: {
        object: { kind: "translation-unit", key: "editing", language: "zh" },
      },
      reason: "保留现有界面用语。",
    },
  ],
  domainSources: new Set(["domain"]),
});
const candidate = {
  sourceKey: "editing",
  language: "zh",
  content: "错误码 405",
};
const exceptedQuality = await analyzeQuality(exceptionConfig.config, {
  candidates: [candidate],
});
const exceptedDiagnostic = diagnosticFor(exceptedQuality, "editing");
assert.ok(exceptedDiagnostic);
assert.equal(exceptedDiagnostic.severity, "warning");
assert.deepEqual(exceptedDiagnostic.handling, {
  status: "excepted",
  exceptionId: "known-family-variation",
  reason: "保留现有界面用语。",
});

const rejected = await prepareQualityConditionedSemanticEdit(baseline.config, {
  candidate,
  condition: (quality) => quality.diagnostics.length === 0,
});
assert.equal(rejected.status, "rejected");
if (rejected.status === "rejected")
  assert.equal(rejected.quality.diagnostics[0]?.severity, "warning");

const passed = await prepareQualityConditionedSemanticEdit(baseline.config, {
  candidate,
  condition: (quality) => quality.status === "complete",
});
assert.equal(passed.status, "passed");
if (passed.status !== "passed" || passed.preparation.status !== "prepared")
  throw new Error("宿主接受完整 warning QA 后应获得可写编辑。");
const write = await applySemanticEdits(
  [passed.preparation.edit],
  baseline.config,
);
assert.equal(write.results[0]?.status, "written");
assert.equal(baseline.storedTexts.get("physical"), candidate.content);

const partial = createConfig({
  partialCandidate: true,
  domainSources: new Set(["domain"]),
});
const partialQuality = await analyzeQuality(partial.config, {
  candidates: [candidate],
});
assert.equal(partialQuality.status, "incomplete");
const partialDiagnostic = diagnosticFor(partialQuality, "editing");
assert.ok(partialDiagnostic);
assert.equal(partialDiagnostic.severity, "warning");
assert.ok(
  partialQuality.checks.some(({ issues }) =>
    issues.some(({ code }) => code === "candidateProjectionPartial"),
  ),
);

const unknown = createConfig({
  units: [...defaultUnits, { id: "saved-unknown", source: "Error Code 704" }],
  translations: [
    ...defaultTranslations,
    { id: "saved-unknown", text: "尚未完成 704" },
  ],
  incompleteTarget: "尚未完成 704",
  domainSources: new Set(["domain"]),
});
const unknownQuality = await analyzeQuality(unknown.config, {
  candidates: [candidate],
});
assert.equal(unknownQuality.status, "incomplete");
const unknownDiagnostic = diagnosticFor(unknownQuality, "editing");
assert.ok(unknownDiagnostic);
assert.equal(unknownDiagnostic.severity, "warning");
assert.ok(
  unknownQuality.checks.some(({ issues }) =>
    issues.some(({ code }) => code === "partialTargetStructure"),
  ),
);
const unknownReferences = unknownDiagnostic.evidence.filter(
  ({ role }) => role === "saved-reference",
);
assert.equal(
  unknownReferences.some(
    ({ value }) => isRecord(value) && value.sourceKey === "saved-unknown",
  ),
  false,
  "结构不完整的参照不应伪造完整签名。",
);
assert.equal(
  summaryFor(
    unknownDiagnostic.evidence.find(({ role }) => role === "comparison-summary")
      ?.value,
  ).referenceCount,
  3,
);

const equivalent = createConfig({
  units: [
    { id: "editing", source: "Error Code 404" },
    { id: "saved", source: "Error Code 504" },
  ],
  translations: [{ id: "saved", text: "错误 504" }],
  targetEquivalence: equivalentTarget,
});
const equivalentQuality = await analyzeQuality(equivalent.config, {
  candidates: [candidate],
});
assert.equal(equivalentQuality.status, "complete");
assert.equal(equivalentQuality.diagnostics.length, 0);

const unlisted = createConfig({
  units: [
    { id: "editing", source: "Error Code 404" },
    { id: "saved", source: "Error Code 504" },
    { id: "unlisted", source: "Error Code 304" },
  ],
  translations: [
    { id: "saved", text: "错误 504" },
    { id: "unlisted", text: "警告 304" },
  ],
  targetEquivalence: equivalentTarget,
});
const unlistedQuality = await analyzeQuality(unlisted.config, {
  candidates: [candidate],
});
const unlistedDiagnostic = diagnosticFor(unlistedQuality, "editing");
assert.ok(unlistedDiagnostic);
assert.equal(unlistedDiagnostic.severity, "warning");
assert.equal(
  summaryFor(
    unlistedDiagnostic.evidence.find(
      ({ role }) => role === "comparison-summary",
    )?.value,
  ).categoryCount,
  2,
);

const scoped = createConfig({
  units: [
    { id: "editing", source: "Error Code 404" },
    { id: "domain", source: "Error Code 504" },
  ],
  translations: [{ id: "domain", text: "错误 504" }],
  domainSources: new Set(["domain"]),
});
const scopedQuality = await analyzeQuality(scoped.config, {
  candidates: [candidate],
});
assert.equal(scopedQuality.status, "not-applicable");
assert.equal(scopedQuality.diagnostics.length, 0);
assert.ok(
  scopedQuality.checks.some(({ issues }) =>
    issues.some(({ code }) => code === "noComparableReference"),
  ),
);

const emptyCounters: Counters = { references: 0, recognitions: 0 };
const empty = createConfig({ counters: emptyCounters });
assert.equal(emptyCounters.references, 0);
const emptyQuality = await analyzeQuality(empty.config, { candidates: [] });
assert.equal(emptyQuality.status, "not-run");
assert.equal(emptyCounters.references, 0);
assert.equal(emptyCounters.recognitions, 0);

for (const protectedRange of [
  { start: 0, end: 1 },
  { start: 0, end: 3 },
]) {
  const invalidProjection = createConfig({
    units: [{ id: "editing", source: "Error Code 404" }],
    translations: [{ id: "editing", text: "😀" }],
    protectedRanges: [protectedRange],
  });
  await assert.rejects(
    analyzeQuality(invalidProjection.config, {
      candidates: [{ sourceKey: "editing", language: "zh", content: "😀" }],
    }),
    (error: unknown) =>
      error instanceof StandardSchemaContractError &&
      error.kind === "schema-mismatch",
  );
}

process.stdout.write(
  "消息族独立制品消费者：公开比较、物理记录排除、有限展示和默认 warning 通过。\n",
);
process.stdout.write(
  "消息族独立制品消费者：局部证据、例外、条件写回及结构不完整限制通过。\n",
);
