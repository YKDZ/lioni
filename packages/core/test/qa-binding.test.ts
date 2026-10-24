import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  analyzeQuality,
  bindQualityCheck,
  defineConfig,
  defineQualityCheck,
  QualityCheckBindingError,
  StandardSchemaContractError,
  type QualityCheckInput,
  type QualityCheckOutcome,
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

function readMixedSource() {
  const units: readonly MixedUnit[] = [
    { kind: "text", key: "message", source: "Total 12" },
    { kind: "list", key: "rows", source: ["Reference 7"] },
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

function selectedText(
  input: QualityCheckInput<
    MixedUnit,
    unknown,
    { readonly includeListEvidence: boolean }
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
  void it("projects selected text while preserving full mixed facts and other outcomes", async () => {
    const checker = bindQualityCheck({
      id: "text-number-context",
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
        const sameProjection =
          currentUnit.source === currentInput.source &&
          input.candidate.content === currentInput.target;
        const diagnostics =
          input.configuration.includeListEvidence &&
          listUnit?.unit.kind === "list" &&
          listSource !== undefined &&
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
                  ],
                },
              ]
            : [];
        return completeOutcome(diagnostics);
      },
    });
    const candidates = [
      { sourceKey: "message", language: "fr", content: "Total 12" },
      { sourceKey: "rows", language: "fr", content: ["Reference 7"] },
      { sourceKey: "message", language: "fr", content: ["wrong shape"] },
    ];
    const config = defineConfig<MixedUnit>({
      source: readMixedSource(),
      keyOf: ({ key }) => key,
      qualityChecks: [checker],
      createQualityRequest: () => ({ candidates, dependencies: {} }),
    });

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
    assert.equal(result.checks[0]?.issues[0]?.code, "candidateShape");
    assert.equal(
      result.diagnostics[0]?.message,
      "已参考列表原文：Reference 7。",
    );
    assert.deepEqual(result.diagnostics[0]?.evidence[0]?.value, [
      "Reference 7",
    ]);
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
      configurationSchema: checkerConfigurationSchema,
      configuration: { includeListEvidence: false },
      inputSchema: stringInputSchema,
      select: selectedText,
      project: () => ({ status: "ready", value: 42 }),
      check: () => completeOutcome(),
    });
    const config = defineConfig<MixedUnit>({
      source: readMixedSource(),
      keyOf: ({ key }) => key,
      qualityChecks: [checker],
      createQualityRequest: () => ({
        candidates: [
          { sourceKey: "message", language: "fr", content: "Total 12" },
        ],
        dependencies: {},
      }),
    });

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
      configurationSchema: checkerConfigurationSchema,
      configuration: { includeListEvidence: false },
      inputSchema: stringInputSchema,
      select: selectedText,
      project() {
        throw new Error("无法投影检查输入。");
      },
      check: () => completeOutcome(),
    });
    const config = defineConfig<MixedUnit>({
      source: readMixedSource(),
      keyOf: ({ key }) => key,
      qualityChecks: [checker],
      createQualityRequest: () => ({
        candidates: [
          { sourceKey: "message", language: "fr", content: "Total 12" },
        ],
        dependencies: {},
      }),
    });

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
      configurationSchema: checkerConfigurationSchema,
      configuration: { includeListEvidence: false },
      check: () => completeOutcome(),
    });

    const config = defineConfig<MixedUnit>({
      source: readMixedSource(),
      keyOf: ({ key }) => key,
      // @ts-expect-error 窄类型检查器必须先显式绑定到混合项目
      qualityChecks: [narrowChecker],
    });

    assert.ok(config);
  });
});
