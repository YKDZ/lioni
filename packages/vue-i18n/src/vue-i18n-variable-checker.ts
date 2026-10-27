import type {
  Awaitable,
  QualityCheckInput,
  QualityCheckOutcome,
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
import type { TextRange } from "@lioni/text-analysis";

import {
  parseVueI18nMessage,
  VUE_I18N_MESSAGE_COMPILER_VERSION,
} from "./vue-i18n-messages.ts";
import type { VueI18nMessage } from "./vue-i18n-messages.ts";

type Configuration = {
  readonly compilerVersion: typeof VUE_I18N_MESSAGE_COMPILER_VERSION;
  readonly comparison: "branch-variable-count-patterns-v1";
};

type Input = {
  readonly source: string;
  readonly target: string;
};

type VariableCount = {
  readonly identity: string;
  readonly count: number;
};

type VariablePattern = {
  readonly key: string;
  readonly variables: readonly VariableCount[];
};

export type VueI18nVariableCorrespondenceSubject<
  TSelectedUnit extends TranslationUnitInput,
  TContent,
> = {
  readonly sourceUnit: SourceUnitFact<TSelectedUnit>;
  readonly sourceKey: string;
  readonly language: string;
  readonly content: TContent;
};

export type VueI18nVariableCorrespondenceCheckerOptions<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TSelectedUnit extends TUnit,
  TContent,
  TBody = unknown,
  TUnavailable = never,
> = {
  /** 宿主选择、正文投影和位置映射的版本。 */
  readonly hostVersion: string;
  readonly select: (
    input: QualityCheckInput<TUnit, TTranslation, unknown, TBody, TUnavailable>,
  ) => Awaitable<
    QualityCheckSelection<
      VueI18nVariableCorrespondenceSubject<TSelectedUnit, TContent>
    >
  >;
  readonly sourceText: (unit: TSelectedUnit) => unknown;
  readonly targetText: (content: TContent) => unknown;
  readonly sourceLocation?: (
    unit: TSelectedUnit,
    subject: QualitySubject,
    range: TextRange,
    defaultLocation: QualityLocation,
  ) => QualityLocation;
  readonly targetLocation?: (
    translation: TTranslation | undefined,
    subject: QualitySubject,
    range: TextRange,
    defaultLocation: QualityLocation,
  ) => QualityLocation;
};

const configurationSchema: StandardSchemaV1<Configuration, Configuration> = {
  "~standard": {
    version: 1,
    vendor: "lioni-vue-i18n-variable-checker",
    validate(value) {
      return isRecord(value) &&
        value.compilerVersion === VUE_I18N_MESSAGE_COMPILER_VERSION &&
        value.comparison === "branch-variable-count-patterns-v1"
        ? {
            value: {
              compilerVersion: VUE_I18N_MESSAGE_COMPILER_VERSION,
              comparison: "branch-variable-count-patterns-v1",
            },
          }
        : { issues: [{ message: "Vue I18n 变量检查配置无效。" }] };
    },
  },
};

const inputSchema: StandardSchemaV1<Input, Input> = {
  "~standard": {
    version: 1,
    vendor: "lioni-vue-i18n-variable-checker",
    validate(value) {
      return isRecord(value) &&
        typeof value.source === "string" &&
        typeof value.target === "string"
        ? { value: { source: value.source, target: value.target } }
        : { issues: [{ message: "变量对应检查输入必须包含原文和译文正文。" }] };
    },
  },
};

const configuration: Configuration = {
  compilerVersion: VUE_I18N_MESSAGE_COMPILER_VERSION,
  comparison: "branch-variable-count-patterns-v1",
};

/** 严格比较原译各分支中的命名与位置变量身份及出现次数。 */
export function createVueI18nVariableCorrespondenceChecker<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TSelectedUnit extends TUnit,
  TContent,
  TBody = unknown,
  TUnavailable = never,
>(
  options: VueI18nVariableCorrespondenceCheckerOptions<
    TUnit,
    TTranslation,
    TSelectedUnit,
    TContent,
    TBody,
    TUnavailable
  >,
) {
  type Subject = VueI18nVariableCorrespondenceSubject<TSelectedUnit, TContent>;
  return bindQualityCheck<
    TUnit,
    TTranslation,
    typeof configurationSchema,
    typeof inputSchema,
    Subject,
    QualityObject,
    TBody,
    TUnavailable
  >({
    id: "vue-i18n/variable-correspondence",
    version: `checks.vue-i18n/variable-correspondence/v1+@intlify/message-compiler@${VUE_I18N_MESSAGE_COMPILER_VERSION}+${options.hostVersion}`,
    configurationSchema,
    configuration,
    inputSchema,
    select: options.select,
    project: (
      input: QualityCheckProjectionInput<
        TUnit,
        TTranslation,
        Configuration,
        Subject,
        TBody,
        TUnavailable
      >,
    ) => {
      if (input.subject.sourceUnit.bodyAvailability !== "available")
        return {
          status: "incomplete",
          issue: {
            code: "sourceUnavailable",
            message: "原文正文不可用，无法检查变量对应。",
          },
        };
      const source = options.sourceText(input.subject.sourceUnit.unit);
      const target = options.targetText(input.subject.content);
      if (typeof source !== "string" || typeof target !== "string")
        return {
          status: "incomplete",
          issue: {
            code: "textUnavailable",
            message: "无法取得变量对应所需的原文或译文正文。",
          },
        };
      return { status: "ready", value: { source, target } };
    },
    check: (
      input: QualityCheckRuleInput<
        TUnit,
        TTranslation,
        Configuration,
        Subject,
        Input,
        TBody,
        TUnavailable
      >,
    ) => {
      const subject = {
        key: input.subject.sourceKey,
        language: input.subject.language,
      };
      const source = parseVueI18nMessage(input.projected.source);
      const target = parseVueI18nMessage(input.projected.target);
      const sourceRange = fullRange(input.projected.source);
      const targetRange = fullRange(input.projected.target);
      const sourceDefaultLocation: QualityLocation = {
        language: null,
        range: sourceRange,
        key: subject.key,
      };
      const sourceLocation =
        options.sourceLocation?.(
          input.subject.sourceUnit.unit,
          subject,
          sourceRange,
          sourceDefaultLocation,
        ) ?? sourceDefaultLocation;

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
      const targetDefaultLocation: QualityLocation = {
        language: subject.language,
        range: record?.range ?? targetRange,
        span: targetRange,
        key: subject.key,
      };
      const targetLocation =
        options.targetLocation?.(
          translation,
          subject,
          targetRange,
          targetDefaultLocation,
        ) ?? targetDefaultLocation;

      const syntaxIssues = invalidSyntaxIssues(
        subject,
        source,
        target,
        sourceLocation,
        targetLocation,
      );
      if (syntaxIssues.length > 0) return incompleteOutcome(syntaxIssues);

      const sourcePatterns = variablePatterns(source);
      const targetPatterns = variablePatterns(target);
      const sourcePatternKeys = new Set(sourcePatterns.map(({ key }) => key));
      const targetPatternKeys = new Set(targetPatterns.map(({ key }) => key));
      const missing = sourcePatterns.filter(
        ({ key }) => !targetPatternKeys.has(key),
      );
      const extra = targetPatterns.filter(
        ({ key }) => !sourcePatternKeys.has(key),
      );
      if (missing.length === 0 && extra.length === 0)
        return completeOutcome([]);

      const sourceObject: QualityObject = {
        kind: "source-unit",
        key: subject.key,
      };
      const targetObject: QualityObject = {
        kind: "translation-unit",
        key: subject.key,
        language: subject.language,
      };
      const evidence: readonly QualityEvidence[] = [
        {
          role: "source-variable-patterns",
          object: sourceObject,
          location: sourceLocation,
          value: { text: input.projected.source, patterns: sourcePatterns },
        },
        {
          role: "target-variable-patterns",
          object: targetObject,
          location: targetLocation,
          value: { text: input.projected.target, patterns: targetPatterns },
        },
        {
          role: "variable-pattern-difference",
          object: targetObject,
          location: targetLocation,
          value: { missing, extra },
        },
      ];
      return completeOutcome([
        {
          severity: "error",
          object: targetObject,
          location: targetLocation,
          message: describeDifference(missing, extra),
          evidence,
        },
      ]);
    },
  });
}

function variablePatterns(message: VueI18nMessage): readonly VariablePattern[] {
  const patterns = new Map<string, VariablePattern>();
  for (const branch of message.branches) {
    const counts = new Map<string, number>();
    for (const variable of branch.variables)
      counts.set(variable, (counts.get(variable) ?? 0) + 1);
    const variables = [...counts]
      .map(([identity, count]) => ({ identity, count }))
      .sort((left, right) => compareText(left.identity, right.identity));
    const key = JSON.stringify(variables);
    patterns.set(key, { key, variables });
  }
  return [...patterns.values()].sort((left, right) =>
    compareText(left.key, right.key),
  );
}

function invalidSyntaxIssues(
  subject: QualitySubject,
  source: VueI18nMessage,
  target: VueI18nMessage,
  sourceLocation: QualityLocation,
  targetLocation: QualityLocation,
) {
  const issues = [];
  if (source.errors.length > 0)
    issues.push({
      code: "sourceMessageSyntaxInvalid",
      message: "原文语法无效，变量对应检查未执行。",
      object: { kind: "source-unit", key: subject.key },
      location: sourceLocation,
    });
  if (target.errors.length > 0)
    issues.push({
      code: "targetMessageSyntaxInvalid",
      message: "译文语法无效，变量对应检查未执行。",
      object: {
        kind: "translation-unit",
        key: subject.key,
        language: subject.language,
      },
      location: targetLocation,
    });
  return issues;
}

function describeDifference(
  missing: readonly VariablePattern[],
  extra: readonly VariablePattern[],
): string {
  return [
    ...(missing.length === 0
      ? []
      : [`译文缺少变量模式：${missing.map(describePattern).join("；")}。`]),
    ...(extra.length === 0
      ? []
      : [`译文多出变量模式：${extra.map(describePattern).join("；")}。`]),
  ].join("");
}

function describePattern(pattern: VariablePattern): string {
  return pattern.variables.length === 0
    ? "无变量"
    : pattern.variables
        .map(({ identity, count }) => `${identity} × ${count}`)
        .join("、");
}

function fullRange(text: string): TextRange {
  return { start: 0, end: text.length };
}

function completeOutcome(
  diagnostics: QualityCheckOutcome["diagnostics"],
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

function incompleteOutcome(
  issues: QualityCheckOutcome["issues"],
): QualityCheckOutcome {
  return {
    status: "incomplete",
    diagnostics: [],
    issues,
    coverage: {
      selected: 1,
      evaluated: 0,
      notApplicable: 0,
      incomplete: 1,
      failed: 0,
    },
  };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
