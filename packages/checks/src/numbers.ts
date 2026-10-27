import type {
  Awaitable,
  QualityCheckDefinition,
  QualityCheckInput,
  QualityCheckOutcome,
  QualityCheckProjection,
  QualityCheckProjectionInput,
  QualityCheckRuleInput,
  QualityCheckSelection,
  QualityEvidence,
  QualityLocation,
  QualityObject,
  QualitySubject,
  SourceUnitFact,
  StandardSchemaV1,
  TranslationUnitInput,
} from "@lioni/core";
import { bindQualityCheck } from "@lioni/core";

type NumberCheckerConfiguration = {
  readonly format: "ascii-decimal-v1";
  readonly comparison: "exact-multiset";
};

export type NumberTextInput = {
  readonly source: string;
  readonly target: string;
};

export type NumberCheckerSubject<
  TUnit extends TranslationUnitInput,
  TContent,
> = {
  readonly sourceUnit: SourceUnitFact<TUnit>;
  readonly sourceKey: string;
  readonly language: string;
  readonly content: TContent;
};

const numberCheckerConfiguration: NumberCheckerConfiguration = {
  format: "ascii-decimal-v1",
  comparison: "exact-multiset",
};

const numberCheckerConfigurationSchema: StandardSchemaV1<
  NumberCheckerConfiguration,
  NumberCheckerConfiguration
> = {
  "~standard": {
    version: 1,
    vendor: "lioni-number-checker",
    validate(value) {
      if (
        typeof value !== "object" ||
        value === null ||
        Array.isArray(value) ||
        !("format" in value) ||
        value.format !== "ascii-decimal-v1" ||
        !("comparison" in value) ||
        value.comparison !== "exact-multiset"
      )
        return {
          issues: [{ message: "数字检查器配置无效。" }],
        };
      return { value: numberCheckerConfiguration };
    },
  },
};

export const numberTextInputSchema: StandardSchemaV1<
  NumberTextInput,
  NumberTextInput
> = {
  "~standard": {
    version: 1,
    vendor: "lioni-number-checker",
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
        return { issues: [{ message: "数字检查输入必须包含两段文本。" }] };
      return { value: { source: value.source, target: value.target } };
    },
  },
};

type NumberCheckerDefinition<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
> = QualityCheckDefinition<
  TUnit,
  TTranslation,
  QualityObject,
  TBody,
  TUnavailable
> & {
  readonly configuration: NumberCheckerConfiguration;
  readonly configurationSchema: typeof numberCheckerConfigurationSchema;
  readonly inputSchema: typeof numberTextInputSchema;
};

export type NumberCheckerOptions<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TSelectedUnit extends TUnit,
  TContent,
  TBody = unknown,
  TUnavailable = never,
> = {
  /** 宿主选择与文本提取逻辑的版本。 */
  readonly hostVersion: string;
  readonly select: (
    input: QualityCheckInput<TUnit, TTranslation, unknown, TBody, TUnavailable>,
  ) => Awaitable<
    QualityCheckSelection<NumberCheckerSubject<TSelectedUnit, TContent>>
  >;
  readonly sourceText: (unit: TSelectedUnit) => unknown;
  readonly translationText: (content: TContent) => unknown;
  readonly sourceLocation?: (
    unit: TSelectedUnit,
    subject: QualitySubject,
    defaultLocation: QualityLocation,
  ) => QualityLocation;
  readonly translationLocation?: (
    translation: TTranslation | undefined,
    subject: QualitySubject,
    defaultLocation: QualityLocation,
  ) => QualityLocation;
};

/** 按宿主选择的范围和投影，比较 ASCII 十进制数字及其出现次数。 */
export function createNumberChecker<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TSelectedUnit extends TUnit,
  TContent,
  TBody = unknown,
  TUnavailable = never,
>(
  options: NumberCheckerOptions<
    TUnit,
    TTranslation,
    TSelectedUnit,
    TContent,
    TBody,
    TUnavailable
  >,
): NumberCheckerDefinition<TUnit, TTranslation, TBody, TUnavailable> {
  type Subject = NumberCheckerSubject<TSelectedUnit, TContent>;
  return bindQualityCheck<
    TUnit,
    TTranslation,
    typeof numberCheckerConfigurationSchema,
    typeof numberTextInputSchema,
    Subject,
    QualityObject,
    TBody,
    TUnavailable
  >({
    id: "number-correspondence",
    version: `checks.number-correspondence/v1+${options.hostVersion}`,
    configurationSchema: numberCheckerConfigurationSchema,
    configuration: numberCheckerConfiguration,
    inputSchema: numberTextInputSchema,
    select: options.select,
    project: (
      input: QualityCheckProjectionInput<
        TUnit,
        TTranslation,
        NumberCheckerConfiguration,
        Subject,
        TBody,
        TUnavailable
      >,
    ): QualityCheckProjection<NumberTextInput> => {
      if (input.subject.sourceUnit.bodyAvailability !== "available")
        return {
          status: "incomplete",
          issue: {
            code: "sourceUnavailable",
            message: "原文正文不可用，无法核对数字。",
          },
        };
      const source = options.sourceText(input.subject.sourceUnit.unit);
      const target = options.translationText(input.subject.content);
      if (typeof source !== "string" || typeof target !== "string")
        return {
          status: "incomplete",
          issue: {
            code: "textUnavailable",
            message: "无法取得原文或候选译文的文本。",
          },
        };
      return { status: "ready", value: { source, target } };
    },
    check: (
      input: QualityCheckRuleInput<
        TUnit,
        TTranslation,
        NumberCheckerConfiguration,
        Subject,
        NumberTextInput,
        TBody,
        TUnavailable
      >,
    ) => {
      const subject = {
        key: input.subject.sourceKey,
        language: input.subject.language,
      };
      const association = input.facts.associations.find(
        ({ sourceKey, language }) =>
          sourceKey === subject.key && language === subject.language,
      );
      const record =
        association?.status === "matched" &&
        association.translationIndexes.length === 1
          ? input.facts.translations.records[association.translationIndexes[0]!]
          : undefined;
      const translation =
        record?.bodyAvailability === "available"
          ? record.translation
          : undefined;
      const defaultSourceLocation: QualityLocation = {
        language: null,
        range:
          input.facts.source.read.scopes[input.subject.sourceUnit.scopeIndex]
            ?.range,
      };
      const defaultTargetLocation: QualityLocation = {
        language: subject.language,
        range: record?.range ?? null,
        key: subject.key,
      };
      const sourceLocation =
        options.sourceLocation?.(
          input.subject.sourceUnit.unit,
          subject,
          defaultSourceLocation,
        ) ?? defaultSourceLocation;
      const targetLocation =
        options.translationLocation?.(
          translation,
          subject,
          defaultTargetLocation,
        ) ?? defaultTargetLocation;
      return compareNumberText({
        ...input.projected,
        subject,
        sourceLocation,
        targetLocation,
        targetContent: input.subject.content,
      });
    },
  });
}

export function compareNumberText(input: {
  readonly source: string;
  readonly target: string;
  readonly subject: QualitySubject;
  readonly sourceLocation: QualityLocation;
  readonly targetLocation: QualityLocation;
  readonly targetContent: unknown;
}): QualityCheckOutcome {
  const sourceNumbers = numbersIn(input.source);
  const targetNumbers = numbersIn(input.target);
  const missing = difference(sourceNumbers, targetNumbers);
  const extra = difference(targetNumbers, sourceNumbers);
  const object = {
    kind: "translation-unit",
    key: input.subject.key,
    language: input.subject.language,
  };
  const evidence: readonly QualityEvidence[] = [
    {
      role: "source",
      object: { kind: "translation-unit", key: input.subject.key },
      location: input.sourceLocation,
      value: input.source,
    },
    {
      role: "target",
      object,
      location: input.targetLocation,
      value: input.targetContent,
    },
  ];
  return {
    status: "complete",
    diagnostics:
      missing.length === 0 && extra.length === 0
        ? []
        : [
            {
              severity: "error",
              object,
              location: input.targetLocation,
              message: [
                ...(missing.length === 0
                  ? []
                  : [`译文缺少数字：${missing.join("、")}。`]),
                ...(extra.length === 0
                  ? []
                  : [`译文多出数字：${extra.join("、")}。`]),
              ].join(""),
              evidence,
            },
          ],
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

function numbersIn(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const [number] of text.matchAll(/[+-]?[0-9]+(?:\.[0-9]+)?/gu))
    counts.set(number, (counts.get(number) ?? 0) + 1);
  return counts;
}

function difference(
  left: ReadonlyMap<string, number>,
  right: ReadonlyMap<string, number>,
): string[] {
  return [...left.entries()].flatMap(([number, count]) =>
    Array<string>(Math.max(0, count - (right.get(number) ?? 0))).fill(number),
  );
}
