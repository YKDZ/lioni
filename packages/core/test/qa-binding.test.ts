import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  analyzeQuality,
  bindQualityCheck,
  createDefaultQualityInputBasis,
  defineConfig,
  defineQualityCheck,
  QualityCheckBindingError,
  StandardSchemaContractError,
  type QualityCheckDefinition,
  type QualityCheckInput,
  type QualityInputBasis,
  type QualityCheckOutcome,
  type QualityObject,
  type QualityRelationship,
  type SemanticEditCandidate,
  type StandardSchemaV1,
  type TranslationUnitInput,
} from "../src/index.ts";

type TextUnit = TranslationUnitInput & {
  readonly kind: "text";
  readonly key: string;
  readonly source: string;
};

type ListUnit = TranslationUnitInput & {
  readonly kind: "list";
  readonly key: string;
  readonly source: readonly string[];
};

type MixedUnit = TextUnit | ListUnit;
type MixedBody = string | readonly string[];
type MixedTranslation = {
  readonly key: string;
  readonly content: MixedBody;
};
type MixedUnavailableTranslation = {
  readonly key: string;
  readonly reason: string;
};

type ProjectedText = {
  readonly source: string;
  readonly target: string;
};

const mixedUnitSchema: StandardSchemaV1<MixedUnit, MixedUnit> = {
  "~standard": {
    version: 1,
    vendor: "qa-binding-test",
    validate(value) {
      return isMixedUnit(value)
        ? { value }
        : { issues: [{ message: "原文单元结构不匹配。" }] };
    },
  },
};

const mixedTranslationSchema: StandardSchemaV1<
  MixedTranslation,
  MixedTranslation
> = {
  "~standard": {
    version: 1,
    vendor: "qa-binding-test",
    validate(value) {
      if (
        typeof value !== "object" ||
        value === null ||
        Array.isArray(value) ||
        !("key" in value) ||
        typeof value.key !== "string" ||
        !("content" in value) ||
        !isMixedBody(value.content)
      )
        return { issues: [{ message: "译文记录结构不匹配。" }] };
      return { value: { key: value.key, content: value.content } };
    },
  },
};

const mixedUnavailableTranslationSchema: StandardSchemaV1<
  MixedUnavailableTranslation,
  MixedUnavailableTranslation
> = {
  "~standard": {
    version: 1,
    vendor: "qa-binding-test",
    validate(value) {
      if (
        typeof value !== "object" ||
        value === null ||
        Array.isArray(value) ||
        !("key" in value) ||
        typeof value.key !== "string" ||
        !("reason" in value) ||
        typeof value.reason !== "string"
      )
        return { issues: [{ message: "不可用译文记录结构不匹配。" }] };
      return { value: { key: value.key, reason: value.reason } };
    },
  },
};

const mixedBodySchema: StandardSchemaV1<MixedBody, MixedBody> = {
  "~standard": {
    version: 1,
    vendor: "qa-binding-test",
    validate(value) {
      return isMixedBody(value)
        ? { value }
        : { issues: [{ message: "正文必须是字符串或字符串列表。" }] };
    },
  },
};

const projectedTextSchema: StandardSchemaV1<ProjectedText, ProjectedText> = {
  "~standard": {
    version: 1,
    vendor: "qa-binding-test",
    validate(value) {
      if (
        typeof value !== "object" ||
        value === null ||
        Array.isArray(value) ||
        !("source" in value) ||
        typeof value.source !== "string" ||
        !("target" in value) ||
        typeof value.target !== "string"
      )
        return { issues: [{ message: "检查输入必须包含字符串原文和译文。" }] };
      return { value: { source: value.source, target: value.target } };
    },
  },
};

const checkerConfigurationSchema: StandardSchemaV1<
  { readonly includeListEvidence: boolean },
  { readonly includeListEvidence: boolean }
> = {
  "~standard": {
    version: 1,
    vendor: "qa-binding-test",
    validate(value) {
      if (
        typeof value !== "object" ||
        value === null ||
        Array.isArray(value) ||
        !("includeListEvidence" in value) ||
        typeof value.includeListEvidence !== "boolean"
      )
        return { issues: [{ message: "检查器配置无效。" }] };
      return { value: { includeListEvidence: value.includeListEvidence } };
    },
  },
};

function completeOutcome(
  diagnostics: QualityCheckOutcome["diagnostics"] = [],
): QualityCheckOutcome {
  return {
    status: "complete",
    diagnostics,
    issues: [],
    coverage: {
      selected: 1,
      evaluated: 1,
      notApplicable: 0,
      incomplete: 0,
      failed: 0,
    },
  };
}

function isMixedUnit(value: unknown): value is MixedUnit {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  if (
    !("kind" in value) ||
    !("key" in value) ||
    typeof value.key !== "string" ||
    !("source" in value)
  )
    return false;
  if (value.kind === "text") return typeof value.source === "string";
  return (
    value.kind === "list" &&
    Array.isArray(value.source) &&
    value.source.every((entry: unknown) => typeof entry === "string")
  );
}

function isMixedBody(value: unknown): value is MixedBody {
  return (
    typeof value === "string" ||
    (Array.isArray(value) &&
      value.every((entry: unknown) => typeof entry === "string"))
  );
}

function readMixedSource(unrelatedSource = "Reference 7") {
  const units: readonly MixedUnit[] = [
    { kind: "text", key: "message", source: "Total 12" },
    { kind: "list", key: "rows", source: [unrelatedSource] },
  ];
  return {
    schema: mixedUnitSchema,
    read: () => ({
      scopes: [
        {
          range: "messages.json",
          enumeration: "complete" as const,
          records: units.map((value) => ({
            value,
            bodyAvailability: "available" as const,
          })),
        },
      ],
    }),
  };
}

const mixedTranslations = {
  languages: ["fr"],
  identityOf: (
    translation: MixedTranslation | MixedUnavailableTranslation,
  ) => ({
    namespace: "messages",
    key: translation.key,
  }),
  schema: mixedTranslationSchema,
  unavailableSchema: mixedUnavailableTranslationSchema,
  contentSchema: mixedBodySchema,
  contentOf: ({ content }: MixedTranslation) => content,
  read: (_language: string, sourceUnits: readonly { key: string }[]) => ({
    scopes: [
      {
        range: "fr.json",
        covers: sourceUnits.map(({ key }) => key),
        enumeration: "complete" as const,
        records: [
          {
            value: { key: "message", content: "Total 12" },
            bodyAvailability: "available" as const,
          },
          {
            value: { key: "rows", content: ["Reference 7"] },
            bodyAvailability: "available" as const,
          },
          {
            value: { key: "unknown", reason: "译文正文暂不可读。" },
            bodyAvailability: "unavailable" as const,
          },
        ],
      },
    ],
  }),
  matches: (
    unit: MixedUnit,
    translation: MixedTranslation | MixedUnavailableTranslation,
  ) => unit.key === translation.key,
};

function qualityConfig(
  checks: readonly QualityCheckDefinition<
    MixedUnit,
    MixedTranslation,
    QualityObject,
    MixedBody,
    MixedUnavailableTranslation
  >[],
  candidates: readonly SemanticEditCandidate<MixedBody>[],
  dependencies: unknown = {},
  unrelatedSource = "Reference 7",
  relationships: readonly QualityRelationship[] = [],
) {
  return defineConfig({
    source: readMixedSource(unrelatedSource),
    keyOf: ({ key }) => key,
    translations: mixedTranslations,
    quality: {
      checks,
      buildCandidates: () => candidates,
      loadDependencies: () => dependencies,
      relationships,
    },
  });
}

function selectedText(
  input: QualityCheckInput<
    MixedUnit,
    MixedTranslation,
    { readonly includeListEvidence: boolean },
    MixedBody,
    MixedUnavailableTranslation
  >,
) {
  const sourceUnit = input.sourceUnit;
  if (sourceUnit === null || sourceUnit.bodyAvailability !== "available")
    return {
      status: "incomplete" as const,
      issue: { code: "sourceUnavailable", message: "原文正文不可用。" },
    };
  if (sourceUnit.unit.kind === "list")
    return Array.isArray(input.candidate.content)
      ? { status: "not-applicable" as const }
      : {
          status: "incomplete" as const,
          issue: { code: "candidateShape", message: "列表候选结构不匹配。" },
        };
  if (typeof input.candidate.content !== "string")
    return {
      status: "incomplete" as const,
      issue: { code: "candidateShape", message: "文本候选必须是字符串。" },
    };
  return {
    status: "selected" as const,
    subject: {
      unit: sourceUnit.unit,
      content: input.candidate.content,
    },
  };
}

void describe("quality check bindings", () => {
  void it("按候选生成稳定指纹并将诊断关联到对应执行", async () => {
    const candidates = [
      { sourceKey: "message", language: "fr", content: "Bonjour" },
      { sourceKey: "message", language: "fr", content: "Salut" },
    ];
    const createResult = async (
      version: string,
      configuration: { readonly includeListEvidence: boolean },
      dependencies: unknown,
      checkId = "fingerprint-check",
      unrelatedSource = "Reference 7",
      relationships: readonly QualityRelationship[] = [],
      useDefaultBasisHelper = false,
      customBasis?: QualityInputBasis,
    ) => {
      const checker = defineQualityCheck<
        MixedUnit,
        MixedTranslation,
        typeof checkerConfigurationSchema,
        QualityObject,
        MixedBody,
        MixedUnavailableTranslation
      >({
        id: checkId,
        version,
        configurationSchema: checkerConfigurationSchema,
        configuration,
        ...(customBasis !== undefined
          ? { fingerprintInput: () => customBasis }
          : useDefaultBasisHelper
            ? {
                fingerprintInput: (input) =>
                  createDefaultQualityInputBasis(input),
              }
            : {}),
        check: ({ candidate }) =>
          completeOutcome([
            {
              severity: "warning",
              object: {
                kind: "translation-unit",
                key: candidate.sourceKey,
                language: candidate.language,
              },
              location: { language: candidate.language, range: "fr.json" },
              message: "候选存在需复核的问题。",
              evidence: [],
            },
          ]),
      });
      return analyzeQuality(
        qualityConfig(
          [checker],
          candidates,
          dependencies,
          unrelatedSource,
          relationships,
        ),
      );
    };

    const first = await createResult(
      "algorithm-v1",
      { includeListEvidence: true },
      { policy: { strict: true }, modes: ["short", "full"] },
    );
    const reorderedObjectKeys = await createResult(
      "algorithm-v1",
      { includeListEvidence: true },
      { modes: ["short", "full"], policy: { strict: true } },
    );
    const reorderedArray = await createResult(
      "algorithm-v1",
      { includeListEvidence: true },
      { policy: { strict: true }, modes: ["full", "short"] },
    );
    const changedVersion = await createResult(
      "algorithm-v2",
      { includeListEvidence: true },
      { policy: { strict: true }, modes: ["short", "full"] },
    );
    const changedConfiguration = await createResult(
      "algorithm-v1",
      { includeListEvidence: false },
      { policy: { strict: true }, modes: ["short", "full"] },
    );
    const changedIdentity = await createResult(
      "algorithm-v1",
      { includeListEvidence: true },
      { policy: { strict: true }, modes: ["short", "full"] },
      "different-check",
    );
    const changedUnrelatedFact = await createResult(
      "algorithm-v1",
      { includeListEvidence: true },
      { policy: { strict: true }, modes: ["short", "full"] },
      "fingerprint-check",
      "Reference 8",
    );
    const changedRelationships = await createResult(
      "algorithm-v1",
      { includeListEvidence: true },
      { policy: { strict: true }, modes: ["short", "full"] },
      "fingerprint-check",
      "Reference 7",
      [
        {
          kind: "related-message",
          key: "message",
          members: [
            { key: "message", language: "fr" },
            { key: "rows", language: "fr" },
          ],
        },
      ],
    );
    const explicitDefaultBasis = await createResult(
      "algorithm-v1",
      { includeListEvidence: true },
      { policy: { strict: true }, modes: ["short", "full"] },
      "fingerprint-check",
      "Reference 7",
      [],
      true,
    );
    const specialKeys = JSON.parse(
      '{"__proto__":{"strict":true},"constructor":"policy"}',
    ) as unknown;
    const reorderedSpecialKeys = JSON.parse(
      '{"constructor":"policy","__proto__":{"strict":true}}',
    ) as unknown;
    const changedSpecialKey = JSON.parse(
      '{"constructor":"changed","__proto__":{"strict":true}}',
    ) as unknown;
    const surrogateKeyA = JSON.parse('{"\\ud800":1}') as QualityInputBasis;
    const surrogateKeyB = JSON.parse('{"\\ud801":1}') as QualityInputBasis;
    const specialKeyResult = await createResult(
      "algorithm-v1",
      { includeListEvidence: true },
      specialKeys,
    );
    const reorderedSpecialKeyResult = await createResult(
      "algorithm-v1",
      { includeListEvidence: true },
      reorderedSpecialKeys,
    );
    const changedSpecialKeyResult = await createResult(
      "algorithm-v1",
      { includeListEvidence: true },
      changedSpecialKey,
    );
    const surrogateKeyResultA = await createResult(
      "algorithm-v1",
      { includeListEvidence: true },
      {},
      "fingerprint-check",
      "Reference 7",
      [],
      false,
      surrogateKeyA,
    );
    const surrogateKeyResultB = await createResult(
      "algorithm-v1",
      { includeListEvidence: true },
      {},
      "fingerprint-check",
      "Reference 7",
      [],
      false,
      surrogateKeyB,
    );
    const execution = first.checks[0]?.executions[0];
    const secondExecution = first.checks[0]?.executions[1];

    assert.ok(execution);
    assert.ok(secondExecution);
    assert.equal(execution.checkId, "fingerprint-check");
    assert.equal(execution.sourceKey, "message");
    assert.equal(execution.language, "fr");
    assert.equal(secondExecution.candidateIndex, 1);
    assert.notEqual(
      secondExecution.inputFingerprint,
      execution.inputFingerprint,
    );
    assert.match(execution.inputFingerprint ?? "", /^sha256:[a-f0-9]{64}$/u);
    assert.equal(
      execution.fingerprintSummary?.version,
      "lioni.check-input/v1:algorithm-v1",
    );
    assert.match(
      execution.fingerprintSummary?.configurationFingerprint ?? "",
      /^sha256:[a-f0-9]{64}$/u,
    );
    assert.match(
      execution.fingerprintSummary?.inputFingerprint ?? "",
      /^sha256:[a-f0-9]{64}$/u,
    );
    assert.equal(
      reorderedObjectKeys.checks[0]?.executions[0]?.inputFingerprint,
      execution.inputFingerprint,
    );
    assert.notEqual(
      reorderedArray.checks[0]?.executions[0]?.inputFingerprint,
      execution.inputFingerprint,
    );
    assert.notEqual(
      changedVersion.checks[0]?.executions[0]?.inputFingerprint,
      execution.inputFingerprint,
    );
    assert.notEqual(
      changedConfiguration.checks[0]?.executions[0]?.inputFingerprint,
      execution.inputFingerprint,
    );
    assert.notEqual(
      changedIdentity.checks[0]?.executions[0]?.inputFingerprint,
      execution.inputFingerprint,
    );
    assert.notEqual(
      changedUnrelatedFact.checks[0]?.executions[0]?.inputFingerprint,
      execution.inputFingerprint,
    );
    assert.notEqual(
      changedRelationships.checks[0]?.executions[0]?.inputFingerprint,
      execution.inputFingerprint,
    );
    assert.equal(
      explicitDefaultBasis.checks[0]?.executions[0]?.inputFingerprint,
      execution.inputFingerprint,
    );
    assert.equal(
      explicitDefaultBasis.checks[0]?.executions[0]?.fingerprintSummary
        ?.inputFingerprint,
      execution.fingerprintSummary?.inputFingerprint,
    );
    assert.equal(
      reorderedSpecialKeyResult.checks[0]?.executions[0]?.inputFingerprint,
      specialKeyResult.checks[0]?.executions[0]?.inputFingerprint,
    );
    assert.notEqual(
      changedSpecialKeyResult.checks[0]?.executions[0]?.inputFingerprint,
      specialKeyResult.checks[0]?.executions[0]?.inputFingerprint,
    );
    assert.notEqual(
      surrogateKeyResultA.checks[0]?.executions[0]?.inputFingerprint,
      surrogateKeyResultB.checks[0]?.executions[0]?.inputFingerprint,
    );
    assert.equal(first.diagnostics[0]?.checkId, "fingerprint-check");
    assert.equal(first.diagnostics[0]?.executionId, execution.executionId);
    assert.equal(
      first.diagnostics[1]?.executionId,
      secondExecution.executionId,
    );
  });

  void it("绑定检查从同次执行快照中的已校验投影生成指纹", async () => {
    const candidates = [
      { sourceKey: "message", language: "fr", content: "Bonjour" },
      { sourceKey: "message", language: "fr", content: "Salut" },
    ];
    const fingerprintProjections: ProjectedText[] = [];
    const checkedProjections: ProjectedText[] = [];
    const defaultBases: unknown[] = [];
    let selected = 0;
    let projected = 0;
    let glossaryVersion = "glossary-v1";
    const checker = bindQualityCheck<
      MixedUnit,
      MixedTranslation,
      typeof checkerConfigurationSchema,
      typeof projectedTextSchema,
      { readonly unit: TextUnit; readonly content: string },
      QualityObject,
      MixedBody,
      MixedUnavailableTranslation
    >({
      id: "bound-fingerprint",
      version: "algorithm-v1",
      configurationSchema: checkerConfigurationSchema,
      configuration: { includeListEvidence: false },
      inputSchema: projectedTextSchema,
      select: (input) => {
        selected += 1;
        const sourceUnit = input.sourceUnit;
        if (sourceUnit === null || sourceUnit.unit.kind !== "text")
          return { status: "not-applicable" };
        if (typeof input.candidate.content !== "string")
          return {
            status: "incomplete",
            issue: { code: "candidateShape", message: "候选必须是字符串。" },
          };
        return {
          status: "selected",
          subject: {
            unit: sourceUnit.unit,
            content: input.candidate.content,
          },
        };
      },
      project: ({ subject }) => {
        projected += 1;
        return {
          status: "ready",
          value: {
            source: subject.unit.source,
            target: subject.content,
          },
        };
      },
      fingerprintInput: (input) => {
        const basis = createDefaultQualityInputBasis(input);
        defaultBases.push(basis);
        fingerprintProjections.push(input.projected);
        return {
          basis,
          projected: input.projected,
          glossaryVersion,
        };
      },
      check: (input) => {
        checkedProjections.push(input.projected);
        return completeOutcome([
          {
            severity: "warning",
            object: {
              kind: "translation-unit",
              key: input.candidate.sourceKey,
              language: input.candidate.language,
            },
            location: { language: input.candidate.language, range: "fr.json" },
            message: "候选需要复核。",
            evidence: [],
          },
        ]);
      },
    });
    const config = qualityConfig([checker], candidates, { policyVersion: 3 });

    const first = await analyzeQuality(config);
    glossaryVersion = "glossary-v2";
    const second = await analyzeQuality(config);

    assert.equal(selected, 4);
    assert.equal(projected, 4);
    assert.equal(first.checks[0]?.executions.length, 2);
    assert.equal(second.checks[0]?.executions.length, 2);
    assert.notEqual(
      first.checks[0]?.executions[0]?.inputFingerprint,
      first.checks[0]?.executions[1]?.inputFingerprint,
    );
    assert.notEqual(
      first.checks[0]?.executions[0]?.inputFingerprint,
      second.checks[0]?.executions[0]?.inputFingerprint,
    );
    assert.deepEqual(
      first.diagnostics.map(({ executionId }) => executionId),
      [0, 1],
    );
    assert.equal(
      first.diagnostics[0]?.executionId,
      first.checks[0]?.executions[0]?.executionId,
    );
    assert.equal(
      first.diagnostics[1]?.executionId,
      first.checks[0]?.executions[1]?.executionId,
    );
    assert.strictEqual(fingerprintProjections[0], checkedProjections[0]);
    assert.strictEqual(fingerprintProjections[1], checkedProjections[1]);
    assert.strictEqual(fingerprintProjections[2], checkedProjections[2]);
    assert.strictEqual(fingerprintProjections[3], checkedProjections[3]);
    const basis = defaultBases[0] as Record<string, unknown>;
    assert.equal(
      (basis.candidate as SemanticEditCandidate<MixedBody>).content,
      "Bonjour",
    );
    assert.equal(
      (basis.sourceUnit as { readonly unit: TextUnit }).unit.source,
      "Total 12",
    );
    assert.deepEqual(basis.dependencies, { policyVersion: 3 });
    assert.deepEqual(basis.relationships, []);
  });

  void it("自定义指纹依据可从非 JSON 主体与投影中选取序列化数据", async () => {
    const checker = bindQualityCheck<
      MixedUnit,
      MixedTranslation,
      typeof checkerConfigurationSchema,
      typeof projectedTextSchema,
      {
        readonly unit: TextUnit;
        readonly capturedAt: Date;
        readonly render: () => string;
      },
      QualityObject,
      MixedBody,
      MixedUnavailableTranslation
    >({
      id: "non-json-subject",
      version: "non-json-subject-v1",
      configurationSchema: checkerConfigurationSchema,
      configuration: { includeListEvidence: false },
      inputSchema: projectedTextSchema,
      select: (input) => {
        const sourceUnit = input.sourceUnit;
        if (
          sourceUnit === null ||
          sourceUnit.unit.kind !== "text" ||
          typeof input.candidate.content !== "string"
        )
          return { status: "not-applicable" };
        return {
          status: "selected",
          subject: {
            unit: sourceUnit.unit,
            capturedAt: new Date("2026-10-27T00:00:00.000Z"),
            render: () => input.candidate.content as string,
          },
        };
      },
      project: ({ subject }) => ({
        status: "ready",
        value: {
          source: subject.unit.source,
          target: subject.render(),
        },
      }),
      fingerprintInput: ({ subject, projected }) => ({
        source: subject.unit.source,
        capturedAt: subject.capturedAt.toISOString(),
        target: projected.target,
      }),
      check: () => completeOutcome(),
    });

    const result = await analyzeQuality(
      qualityConfig(
        [checker],
        [{ sourceKey: "message", language: "fr", content: "Bonjour" }],
      ),
    );

    assert.equal(result.status, "complete");
    assert.equal(
      typeof result.checks[0]?.executions[0]?.inputFingerprint,
      "string",
    );
  });

  void it("projects selected text while preserving full mixed facts and other outcomes", async () => {
    const candidates = [
      { sourceKey: "message", language: "fr", content: "Total 12" },
      { sourceKey: "rows", language: "fr", content: ["Reference 7"] },
      { sourceKey: "message", language: "fr", content: ["wrong shape"] },
    ];
    const checker = bindQualityCheck({
      id: "text-number-context",
      version: "qa-binding-v1",
      configurationSchema: checkerConfigurationSchema,
      configuration: { includeListEvidence: true },
      inputSchema: projectedTextSchema,
      select: selectedText,
      project: ({ subject }) => ({
        status: "ready",
        value: {
          source: subject.unit.source,
          target: subject.content,
        },
      }),
      check: (input) => {
        const currentUnit: TextUnit = input.subject.unit;
        const currentInput: ProjectedText = input.projected;
        const listUnit = input.facts.source.units.find(
          ({ unit }) => unit.kind === "list",
        );
        const listSource =
          listUnit?.unit.kind === "list" ? listUnit.unit.source : undefined;
        const listTranslation = input.facts.translations.records.find(
          (record) =>
            record.bodyAvailability === "available" &&
            record.translation.key === "rows",
        );
        const listBody: readonly string[] | undefined =
          listTranslation?.bodyAvailability === "available" &&
          Array.isArray(listTranslation.content)
            ? listTranslation.content
            : undefined;
        const unavailableTranslation = input.facts.translations.records.find(
          (record) => record.bodyAvailability === "unavailable",
        );
        const keepsUnavailableFact =
          unavailableTranslation?.bodyAvailability === "unavailable" &&
          unavailableTranslation.translation.reason === "译文正文暂不可读。";
        const sameProjection =
          currentUnit.source === currentInput.source &&
          input.candidate.content === currentInput.target;
        const diagnostics =
          input.configuration.includeListEvidence &&
          listUnit?.unit.kind === "list" &&
          listSource !== undefined &&
          listBody !== undefined &&
          keepsUnavailableFact &&
          sameProjection
            ? [
                {
                  severity: "info" as const,
                  object: {
                    kind: "translation-unit",
                    key: input.candidate.sourceKey,
                    language: input.candidate.language,
                  },
                  location: {
                    language: input.candidate.language,
                    range: "fr.json",
                  },
                  message: `已参考列表原文：${listSource.join("、")}。`,
                  evidence: [
                    {
                      role: "list-source",
                      object: { kind: "list-unit", key: listUnit.key },
                      location: {
                        language: null,
                        range:
                          input.facts.source.read.scopes[listUnit.scopeIndex]
                            ?.range ?? null,
                      },
                      value: listSource,
                    },
                    {
                      role: "list-translation-body",
                      object: {
                        kind: "translation-unit",
                        key: "rows",
                        language: "fr",
                      },
                      location: {
                        language: "fr",
                        range: listTranslation?.range ?? null,
                      },
                      value: listBody,
                    },
                  ],
                },
              ]
            : [];
        return completeOutcome(diagnostics);
      },
    });
    const config = qualityConfig([checker], candidates);

    const result = await analyzeQuality(config);

    assert.equal(result.status, "incomplete");
    assert.deepEqual(result.candidates, candidates);
    assert.deepEqual(result.checks[0]?.coverage, {
      selected: 3,
      evaluated: 1,
      notApplicable: 1,
      incomplete: 1,
      failed: 0,
    });
    assert.deepEqual(
      result.checks[0]?.executions.map(({ status, inputFingerprint }) => ({
        status,
        hasFingerprint: inputFingerprint !== undefined,
      })),
      [
        { status: "complete", hasFingerprint: true },
        { status: "not-applicable", hasFingerprint: false },
        { status: "incomplete", hasFingerprint: false },
      ],
    );
    assert.equal(result.checks[0]?.issues[0]?.code, "candidateShape");
    assert.equal(
      result.diagnostics[0]?.message,
      "已参考列表原文：Reference 7。",
    );
    assert.deepEqual(result.diagnostics[0]?.evidence[0]?.value, [
      "Reference 7",
    ]);
    assert.deepEqual(result.diagnostics[0]?.evidence[1]?.value, [
      "Reference 7",
    ]);
    const mixedBody: MixedBody = result.candidates[1]!.content;
    assert.deepEqual(mixedBody, ["Reference 7"]);
  });

  void it("rejects an invalid projection through the public QA workflow", async () => {
    const stringInputSchema: StandardSchemaV1<unknown, string> = {
      "~standard": {
        version: 1,
        vendor: "qa-binding-test",
        validate(value) {
          return typeof value === "string"
            ? { value }
            : { issues: [{ message: "检查输入必须是字符串。" }] };
        },
      },
    };
    const checker = bindQualityCheck({
      id: "invalid-projection",
      version: "qa-binding-v1",
      configurationSchema: checkerConfigurationSchema,
      configuration: { includeListEvidence: false },
      inputSchema: stringInputSchema,
      select: selectedText,
      project: () => ({ status: "ready", value: 42 }),
      check: () => completeOutcome(),
    });
    const config = qualityConfig(
      [checker],
      [{ sourceKey: "message", language: "fr", content: "Total 12" }],
    );

    await assert.rejects(analyzeQuality(config), (error: unknown) => {
      assert.ok(error instanceof StandardSchemaContractError);
      assert.equal(error.kind, "schema-mismatch");
      assert.match(error.valueDescription, /投影/u);
      return true;
    });
  });

  void it("keeps a thrown projection separate from an ordinary checker failure", async () => {
    const stringInputSchema: StandardSchemaV1<unknown, string> = {
      "~standard": {
        version: 1,
        vendor: "qa-binding-test",
        validate(value) {
          return typeof value === "string"
            ? { value }
            : { issues: [{ message: "检查输入必须是字符串。" }] };
        },
      },
    };
    const checker = bindQualityCheck({
      id: "throwing-projection",
      version: "qa-binding-v1",
      configurationSchema: checkerConfigurationSchema,
      configuration: { includeListEvidence: false },
      inputSchema: stringInputSchema,
      select: selectedText,
      project() {
        throw new Error("无法投影检查输入。");
      },
      check: () => completeOutcome(),
    });
    const config = qualityConfig(
      [checker],
      [{ sourceKey: "message", language: "fr", content: "Total 12" }],
    );

    await assert.rejects(analyzeQuality(config), (error: unknown) => {
      assert.ok(error instanceof QualityCheckBindingError);
      assert.equal(error.stage, "projection");
      assert.equal(error.qualityCheckId, "throwing-projection");
      return true;
    });
  });

  void it("rejects a narrow checker installed directly in a wider project", () => {
    const narrowChecker = defineQualityCheck<
      TextUnit,
      unknown,
      typeof checkerConfigurationSchema
    >({
      id: "text-only",
      version: "qa-binding-v1",
      configurationSchema: checkerConfigurationSchema,
      configuration: { includeListEvidence: false },
      check: () => completeOutcome(),
    });

    const config = defineConfig<MixedUnit>({
      source: readMixedSource(),
      keyOf: ({ key }) => key,
      quality: {
        // @ts-expect-error 窄类型检查器必须先显式绑定到混合项目
        checks: [narrowChecker],
      },
    });

    assert.ok(config);
  });
});
