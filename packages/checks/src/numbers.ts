import {
  defineChecker,
  QualityCheckerContractError,
  type Awaitable,
  type CheckerPrepareInput,
  type QualityCheckDefinition,
  type QualityCheckOutcome,
  type QualityIssue,
  type QualityLocation,
  type QualityObject,
  type QualitySubject,
  type TranslationUnitInput,
} from "@lioni/core";
import { z } from "zod";

const qualityLocationSchema = z
  .object({
    language: z.string().nullable(),
    range: z.unknown(),
    key: z.string().optional(),
  })
  .passthrough();

const numberTextInputSchema = z.object({
  source: z.string(),
  target: z.string(),
  subject: z.object({ key: z.string(), language: z.string() }),
  sourceLocation: qualityLocationSchema,
  targetLocation: qualityLocationSchema,
  targetContent: z.unknown(),
});
type CheckerNumberTextInput = z.input<typeof numberTextInputSchema>;

export type NumberTextInput = {
  readonly source: string;
  readonly target: string;
  readonly subject: QualitySubject;
  readonly sourceLocation: QualityLocation;
  readonly targetLocation: QualityLocation;
  readonly targetContent: unknown;
};

export type NumberCheckerPreparation =
  | {
      readonly status: "ready";
      readonly source: string;
      readonly target: string;
      readonly sourceLocation?: QualityLocation;
      readonly targetLocation?: QualityLocation;
    }
  | { readonly status: "not-applicable" }
  | { readonly status: "incomplete"; readonly issue: QualityIssue };

export type NumberCheckerOptions<
  TUnit extends TranslationUnitInput = TranslationUnitInput,
  TTranslation = unknown,
  TBody = unknown,
  TUnavailable = unknown,
> = {
  /** 为结构化正文明确提供文本提取与适用范围。 */
  readonly prepare?: (
    input: CheckerPrepareInput<TUnit, TTranslation, TBody, TUnavailable>,
  ) => Awaitable<NumberCheckerPreparation>;
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
  TUnavailable,
  "number-correspondence"
>;

/** 默认比较字符串正文；结构化正文可通过 prepare 明确提供适配。 */
function createNumberCheckerImplementation<
  TUnit extends TranslationUnitInput = TranslationUnitInput,
  TTranslation = unknown,
  TBody = unknown,
  TUnavailable = unknown,
>(
  options: NumberCheckerOptions<TUnit, TTranslation, TBody, TUnavailable> = {},
): NumberCheckerDefinition<TUnit, TTranslation, TBody, TUnavailable> {
  if (options === null || typeof options !== "object" || Array.isArray(options))
    throw new TypeError("数字检查器选项必须是对象。");
  if (options.prepare !== undefined && typeof options.prepare !== "function")
    throw new TypeError("数字检查器 prepare 必须是函数。");

  return defineChecker.withTypes<TUnit, TTranslation, TBody, TUnavailable>()({
    id: "number-correspondence",
    version: "checks.number-correspondence/v3",
    inputSchema: numberTextInputSchema,
    async prepare(input) {
      const preparation =
        options.prepare === undefined
          ? input.sourceUnit.bodyAvailability === "available"
            ? defaultNumberPreparation(input)
            : sourceUnavailablePreparation()
          : await options.prepare(input);
      if (
        preparation === null ||
        typeof preparation !== "object" ||
        Array.isArray(preparation)
      )
        throw new QualityCheckerContractError(
          "number-correspondence",
          "prepare",
          "的 prepare 返回了无效结果。",
        );
      if (preparation.status !== "ready") return preparation;
      if (input.sourceUnit.bodyAvailability !== "available")
        return sourceUnavailablePreparation();

      const sourceRange =
        input.facts.source.read.scopes[input.sourceUnit.scopeIndex]?.range ??
        null;
      const sourceLocation = { language: null, range: sourceRange };
      const targetLocation = {
        language: input.candidate.language,
        range: input.translation?.range ?? null,
        key: input.candidate.sourceKey,
      };
      const checkerInput = {
        source: preparation.source,
        target: preparation.target,
        subject: {
          key: input.candidate.sourceKey,
          language: input.candidate.language,
        },
        sourceLocation: preparation.sourceLocation ?? sourceLocation,
        targetLocation: preparation.targetLocation ?? targetLocation,
        targetContent: input.candidate.content,
      } as CheckerNumberTextInput;
      return {
        status: "ready",
        input: checkerInput,
      };
    },
    check: checkPreparedNumberText,
  });
}

function createNumberCheckerWithTypes<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody = unknown,
  TUnavailable = unknown,
>() {
  return (
    options: NumberCheckerOptions<
      TUnit,
      TTranslation,
      TBody,
      TUnavailable
    > = {},
  ) =>
    createNumberCheckerImplementation<TUnit, TTranslation, TBody, TUnavailable>(
      options,
    );
}

/** 内置版本、默认文本提取和定位由本包维护。 */
export const createNumberChecker = Object.assign(
  createNumberCheckerImplementation,
  { withTypes: createNumberCheckerWithTypes },
);

function checkPreparedNumberText(
  input: CheckerNumberTextInput,
): QualityCheckOutcome {
  return compareNumberText(input as unknown as NumberTextInput);
}

function sourceUnavailablePreparation(): Extract<
  NumberCheckerPreparation,
  { readonly status: "incomplete" }
> {
  return {
    status: "incomplete",
    issue: {
      code: "sourceUnavailable",
      message: "原文正文不可用，无法核对数字。",
    },
  };
}

function defaultNumberPreparation<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  input: CheckerPrepareInput<TUnit, TTranslation, TBody, TUnavailable>,
): NumberCheckerPreparation {
  const source = input.sourceUnit.unit.source;
  const target = input.candidate.content;
  if (typeof source !== "string" || typeof target !== "string")
    return {
      status: "incomplete",
      issue: {
        code: "textUnavailable",
        message: "无法取得原文或候选译文的字符串正文。",
      },
    };
  return { status: "ready", source, target };
}

export function compareNumberText(input: NumberTextInput): QualityCheckOutcome {
  const sourceNumbers = numbersIn(input.source);
  const targetNumbers = numbersIn(input.target);
  const missing = difference(sourceNumbers, targetNumbers);
  const extra = difference(targetNumbers, sourceNumbers);
  const object = {
    kind: "translation-unit",
    key: input.subject.key,
    language: input.subject.language,
  };
  const evidence = [
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
  ] as const;
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
