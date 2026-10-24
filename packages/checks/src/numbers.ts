import type {
  JsonValue,
  QualityCheckDefinition,
  QualityCheckOutcome,
  QualityEvidence,
  QualityLocation,
  QualitySubject,
  TranslationUnitInput,
} from "@lioni/core";

export type NumberCheckerOptions<
  TUnit extends TranslationUnitInput,
  TTranslation,
> = {
  readonly sourceText: (unit: TUnit) => unknown;
  readonly translationText: (content: JsonValue) => unknown;
  readonly sourceLocation?: (
    unit: TUnit,
    subject: QualitySubject,
    defaultLocation: QualityLocation,
  ) => QualityLocation;
  readonly translationLocation?: (
    translation: TTranslation | undefined,
    subject: QualitySubject,
    defaultLocation: QualityLocation,
  ) => QualityLocation;
};

/** 精确比较 ASCII 十进制数字及其出现次数，允许顺序变化，不做数值归一化。 */
export function createNumberChecker<
  TUnit extends TranslationUnitInput,
  TTranslation,
>(
  options: NumberCheckerOptions<TUnit, TTranslation>,
): QualityCheckDefinition<TUnit, TTranslation> {
  return {
    id: "number-correspondence",
    configuration: { format: "ascii-decimal-v1", comparison: "exact-multiset" },
    check(input) {
      const sourceUnit = input.sourceUnit;
      if (sourceUnit === null || sourceUnit.bodyAvailability !== "available")
        return incomplete(
          "sourceUnavailable",
          "原文正文不可用，无法核对数字。",
        );

      const source = options.sourceText(sourceUnit.unit);
      const target = options.translationText(input.candidate.content);
      if (typeof source !== "string" || typeof target !== "string")
        return incomplete("textUnavailable", "无法取得原文或候选译文的文本。");

      const subject = {
        key: input.candidate.sourceKey,
        language: input.candidate.language,
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
      const defaultSourceLocation: QualityLocation = {
        language: null,
        range: input.facts.source.read.scopes[sourceUnit.scopeIndex]?.range,
      };
      const defaultTargetLocation: QualityLocation = {
        language: subject.language,
        range: record?.range ?? null,
        key: subject.key,
      };
      const sourceLocation =
        options.sourceLocation?.(
          sourceUnit.unit,
          subject,
          defaultSourceLocation,
        ) ?? defaultSourceLocation;
      const targetLocation =
        options.translationLocation?.(
          record?.translation,
          subject,
          defaultTargetLocation,
        ) ?? defaultTargetLocation;
      const sourceNumbers = numbersIn(source);
      const targetNumbers = numbersIn(target);
      const missing = difference(sourceNumbers, targetNumbers);
      const extra = difference(targetNumbers, sourceNumbers);
      const object = {
        kind: "translation-unit",
        key: subject.key,
        language: subject.language,
      };
      const evidence: readonly QualityEvidence[] = [
        {
          role: "source",
          object: { kind: "translation-unit", key: subject.key },
          location: sourceLocation,
          value: source,
        },
        {
          role: "target",
          object,
          location: targetLocation,
          value: input.candidate.content,
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
                  location: targetLocation,
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
    },
  };
}

function incomplete(code: string, message: string): QualityCheckOutcome {
  return {
    status: "incomplete",
    diagnostics: [],
    issues: [{ code, message }],
    coverage: {
      selected: 1,
      evaluated: 0,
      notApplicable: 0,
      incomplete: 1,
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
