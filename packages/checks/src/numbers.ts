import type {
  Awaitable,
  QualityCheckDefinition,
  QualityCheckInput,
  QualityCheckOutcome,
  QualityCheckRuleInput,
  QualityCheckSelection,
  QualityEvidence,
  QualityInputBasis,
  QualityLocation,
  QualityObject,
  QualitySubject,
  SourceUnitFact,
  TranslationUnitInput,
} from "@lioni/core";
import { bindQualityCheck, snapshotJsonValue } from "@lioni/core";
import { z } from "zod";

const numberCheckerConfigurationSchema = z.object({
  format: z.literal("ascii-decimal-v1"),
  comparison: z.literal("exact-multiset"),
});
type NumberCheckerConfiguration = {
  readonly format: "ascii-decimal-v1";
  readonly comparison: "exact-multiset";
};

const numberTextInputSchema = z.object({
  source: z.string(),
  target: z.string(),
});
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
>;

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
  /** 声明显式宿主依赖；工厂另行纳入实际文本、关联、位置和诊断证据，省略时保留全事实默认。 */
  readonly fingerprintInput?: (
    input: QualityCheckRuleInput<
      TUnit,
      TTranslation,
      NumberCheckerConfiguration,
      NumberCheckerSubject<TSelectedUnit, TContent>,
      NumberTextInput,
      TBody,
      TUnavailable
    >,
  ) => QualityInputBasis;
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
  type Selected = NumberCheckerSubject<TSelectedUnit, TContent>;
  type Subject = {
    readonly value: Selected;
    readonly projected: NumberTextInput;
    readonly report: Parameters<typeof compareNumberText>[0];
    readonly association: QualityInputBasis;
  };
  const fingerprintInput = options.fingerprintInput;
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
    version: `checks.number-correspondence/v2+${options.hostVersion}`,
    configurationSchema: numberCheckerConfigurationSchema,
    configuration: numberCheckerConfiguration,
    inputSchema: numberTextInputSchema,
    select: async (input) => {
      const selection = await options.select(input);
      if (selection.status !== "selected") return selection;
      const selected = selection.subject;
      if (selected.sourceUnit.bodyAvailability !== "available")
        return {
          status: "incomplete",
          issue: {
            code: "sourceUnavailable",
            message: "原文正文不可用，无法核对数字。",
          },
        };
      const source = options.sourceText(selected.sourceUnit.unit);
      const target = options.translationText(selected.content);
      if (typeof source !== "string" || typeof target !== "string")
        return {
          status: "incomplete",
          issue: {
            code: "textUnavailable",
            message: "无法取得原文或候选译文的文本。",
          },
        };
      const subject = {
        key: selected.sourceKey,
        language: selected.language,
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
          input.facts.source.read.scopes[selected.sourceUnit.scopeIndex]?.range,
      };
      const defaultTargetLocation: QualityLocation = {
        language: subject.language,
        range: record?.range ?? null,
        key: subject.key,
      };
      const sourceLocation =
        options.sourceLocation?.(
          selected.sourceUnit.unit,
          subject,
          defaultSourceLocation,
        ) ?? defaultSourceLocation;
      const targetLocation =
        options.translationLocation?.(
          translation,
          subject,
          defaultTargetLocation,
        ) ?? defaultTargetLocation;
      return {
        status: "selected",
        subject: {
          value: selected,
          projected: { source, target },
          report: {
            source,
            target,
            subject,
            sourceLocation,
            targetLocation,
            targetContent: selected.content,
          },
          association: {
            status: association?.status ?? "missing",
            translations: (association?.translationIndexes ?? []).map(
              (index) => {
                const translation = input.facts.translations.records[index]!;
                return {
                  identity: translation.identity ?? null,
                  availability: translation.bodyAvailability,
                };
              },
            ),
          },
        },
      };
    },
    project: ({ subject }) => ({ status: "ready", value: subject.projected }),
    ...(fingerprintInput === undefined
      ? {}
      : {
          fingerprintInput: (
            input: QualityCheckRuleInput<
              TUnit,
              TTranslation,
              NumberCheckerConfiguration,
              Subject,
              NumberTextInput,
              TBody,
              TUnavailable
            >,
          ) => ({
            input: fingerprintInput({ ...input, subject: input.subject.value }),
            report: snapshotJsonValue(input.subject.report, "数字检查诊断依据"),
            association: input.subject.association,
          }),
        }),
    check: ({ subject }) => compareNumberText(subject.report),
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
