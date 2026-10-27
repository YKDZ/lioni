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
import type { VueI18nSyntaxError } from "./vue-i18n-messages.ts";

type VueI18nSyntaxConfiguration = {
  readonly compilerVersion: typeof VUE_I18N_MESSAGE_COMPILER_VERSION;
};

type VueI18nSyntaxInput = { readonly text: string };

export type VueI18nSourceSyntaxSubject<
  TSelectedUnit extends TranslationUnitInput,
> = {
  readonly sourceUnit: SourceUnitFact<TSelectedUnit>;
  readonly sourceKey: string;
  readonly language: string;
};

export type VueI18nSourceSyntaxCheckerOptions<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TSelectedUnit extends TUnit,
  TBody = unknown,
  TUnavailable = never,
> = {
  /** 宿主选择、正文投影和位置映射的版本。 */
  readonly hostVersion: string;
  readonly select: (
    input: QualityCheckInput<TUnit, TTranslation, unknown, TBody, TUnavailable>,
  ) => Awaitable<
    QualityCheckSelection<VueI18nSourceSyntaxSubject<TSelectedUnit>>
  >;
  readonly sourceText: (unit: TSelectedUnit) => unknown;
  readonly sourceLocation?: (
    unit: TSelectedUnit,
    subject: QualitySubject,
    range: TextRange,
    defaultLocation: QualityLocation,
  ) => QualityLocation;
};

export type VueI18nTargetSyntaxSubject<TContent> = {
  readonly sourceKey: string;
  readonly language: string;
  readonly content: TContent;
};

export type VueI18nTargetSyntaxCheckerOptions<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TContent,
  TBody = unknown,
  TUnavailable = never,
> = {
  /** 宿主选择、正文投影和位置映射的版本。 */
  readonly hostVersion: string;
  readonly select: (
    input: QualityCheckInput<TUnit, TTranslation, unknown, TBody, TUnavailable>,
  ) => Awaitable<QualityCheckSelection<VueI18nTargetSyntaxSubject<TContent>>>;
  readonly targetText: (content: TContent) => unknown;
  readonly targetLocation?: (
    translation: TTranslation | undefined,
    subject: QualitySubject,
    range: TextRange,
    defaultLocation: QualityLocation,
  ) => QualityLocation;
};

const configurationSchema: StandardSchemaV1<
  VueI18nSyntaxConfiguration,
  VueI18nSyntaxConfiguration
> = {
  "~standard": {
    version: 1,
    vendor: "lioni-vue-i18n-syntax-checker",
    validate(value) {
      return isRecord(value) &&
        value.compilerVersion === VUE_I18N_MESSAGE_COMPILER_VERSION
        ? { value: { compilerVersion: VUE_I18N_MESSAGE_COMPILER_VERSION } }
        : { issues: [{ message: "Vue I18n 语法检查配置无效。" }] };
    },
  },
};

const inputSchema: StandardSchemaV1<VueI18nSyntaxInput, VueI18nSyntaxInput> = {
  "~standard": {
    version: 1,
    vendor: "lioni-vue-i18n-syntax-checker",
    validate(value) {
      return isRecord(value) && typeof value.text === "string"
        ? { value: { text: value.text } }
        : { issues: [{ message: "Vue I18n 检查输入必须包含字符串正文。" }] };
    },
  },
};

const configuration: VueI18nSyntaxConfiguration = {
  compilerVersion: VUE_I18N_MESSAGE_COMPILER_VERSION,
};

/** 按候选目标语言执行原文语法检查，原文位置可由宿主映射。 */
export function createVueI18nSourceSyntaxChecker<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TSelectedUnit extends TUnit,
  TBody = unknown,
  TUnavailable = never,
>(
  options: VueI18nSourceSyntaxCheckerOptions<
    TUnit,
    TTranslation,
    TSelectedUnit,
    TBody,
    TUnavailable
  >,
) {
  type Subject = VueI18nSourceSyntaxSubject<TSelectedUnit>;
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
    id: "vue-i18n/source-syntax",
    version: `checks.vue-i18n/source-syntax/v1+@intlify/message-compiler@${VUE_I18N_MESSAGE_COMPILER_VERSION}+${options.hostVersion}`,
    configurationSchema,
    configuration,
    inputSchema,
    select: options.select,
    project: (
      input: QualityCheckProjectionInput<
        TUnit,
        TTranslation,
        VueI18nSyntaxConfiguration,
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
            message: "原文正文不可用，无法检查 Vue I18n 语法。",
          },
        };
      const text = options.sourceText(input.subject.sourceUnit.unit);
      return typeof text === "string"
        ? { status: "ready", value: { text } }
        : {
            status: "incomplete",
            issue: {
              code: "sourceTextUnavailable",
              message: "无法从原文单元取得 Vue I18n 消息正文。",
            },
          };
    },
    check: (
      input: QualityCheckRuleInput<
        TUnit,
        TTranslation,
        VueI18nSyntaxConfiguration,
        Subject,
        VueI18nSyntaxInput,
        TBody,
        TUnavailable
      >,
    ) => {
      const subject = {
        key: input.subject.sourceKey,
        language: input.subject.language,
      };
      const parsed = parseVueI18nMessage(input.projected.text);
      const diagnostics = parsed.errors.map((error) => {
        const range = errorRange(error);
        const defaultLocation: QualityLocation = {
          language: null,
          range,
          key: subject.key,
        };
        const location =
          options.sourceLocation?.(
            input.subject.sourceUnit.unit,
            subject,
            range,
            defaultLocation,
          ) ?? defaultLocation;
        return syntaxFinding(
          "source",
          subject,
          location,
          input.projected.text,
          error,
        );
      });
      return completeOutcome(diagnostics);
    },
  });
}

/** 只依赖显式投影的候选正文，可独立检查没有原文记录的目标键。 */
export function createVueI18nTargetSyntaxChecker<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TContent,
  TBody = unknown,
  TUnavailable = never,
>(
  options: VueI18nTargetSyntaxCheckerOptions<
    TUnit,
    TTranslation,
    TContent,
    TBody,
    TUnavailable
  >,
) {
  type Subject = VueI18nTargetSyntaxSubject<TContent>;
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
    id: "vue-i18n/target-syntax",
    version: `checks.vue-i18n/target-syntax/v1+@intlify/message-compiler@${VUE_I18N_MESSAGE_COMPILER_VERSION}+${options.hostVersion}`,
    configurationSchema,
    configuration,
    inputSchema,
    select: options.select,
    project: (
      input: QualityCheckProjectionInput<
        TUnit,
        TTranslation,
        VueI18nSyntaxConfiguration,
        Subject,
        TBody,
        TUnavailable
      >,
    ) => {
      const text = options.targetText(input.subject.content);
      return typeof text === "string"
        ? { status: "ready", value: { text } }
        : {
            status: "incomplete",
            issue: {
              code: "targetTextUnavailable",
              message: "无法从候选内容取得 Vue I18n 消息正文。",
            },
          };
    },
    check: (
      input: QualityCheckRuleInput<
        TUnit,
        TTranslation,
        VueI18nSyntaxConfiguration,
        Subject,
        VueI18nSyntaxInput,
        TBody,
        TUnavailable
      >,
    ) => {
      const subject = {
        key: input.subject.sourceKey,
        language: input.subject.language,
      };
      const parsed = parseVueI18nMessage(input.projected.text);
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
      const diagnostics = parsed.errors.map((error) => {
        const range = errorRange(error);
        const defaultLocation: QualityLocation = {
          language: subject.language,
          range: record?.range ?? range,
          span: range,
          key: subject.key,
        };
        const location =
          options.targetLocation?.(
            translation,
            subject,
            range,
            defaultLocation,
          ) ?? defaultLocation;
        return syntaxFinding(
          "target",
          subject,
          location,
          input.projected.text,
          error,
        );
      });
      return completeOutcome(diagnostics);
    },
  });
}

function syntaxFinding(
  side: "source" | "target",
  subject: QualitySubject,
  location: QualityLocation,
  text: string,
  error: VueI18nSyntaxError,
) {
  const object: QualityObject = {
    kind: side === "source" ? "source-unit" : "translation-unit",
    key: subject.key,
    ...(side === "target" ? { language: subject.language } : {}),
  };
  const evidence: readonly QualityEvidence[] = [
    { role: `${side}-message`, object, location, value: text },
    { role: "syntax-error", object, location, value: error },
  ];
  return {
    severity: "error" as const,
    object,
    location,
    message: `${side === "source" ? "原文" : "译文"}不符合 Vue I18n 消息语法：${error.message}。`,
    evidence,
  };
}

function completeOutcome(
  diagnostics: ReturnType<typeof syntaxFinding>[],
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

function errorRange(error: VueI18nSyntaxError): TextRange {
  return error.range ?? { start: 0, end: 0 };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
