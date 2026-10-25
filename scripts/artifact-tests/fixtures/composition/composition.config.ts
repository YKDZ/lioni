import { readFileSync } from "node:fs";

import {
  compareNumberText,
  numberTextInputSchema,
  type NumberTextInput,
} from "@lioni/checks";
import {
  defineConfig,
  bindQualityCheck,
  type CompletionResolution,
  type CompletionResolverInput,
  type FrameworkConfig,
  type FrameworkFacts,
  type JsonValue,
  type QualityCheckDefinition,
  type QualityCheckInput,
  type QualityCheckProjection,
  type QualityCheckProjectionInput,
  type QualityCheckRuleInput,
  type QualityCheckSelection,
  type QualityCheckRequest,
  type QualityException,
  type QualityObject,
  type SourceUnitFact,
  type UpdatePolicyInput,
  type UpdateDecision,
  type StandardSchemaV1,
} from "@lioni/core";

import { isRecord, standardSchema } from "./schemas.ts";

type CatalogUnit = {
  readonly source: { readonly label: string };
  readonly context: {
    readonly domain: "catalog";
    readonly nativeKey: string;
    readonly file: string;
    readonly line: number;
    readonly screenshot: string;
  };
};
type GuideUnit = {
  readonly source: { readonly body: string };
  readonly context: {
    readonly domain: "guide";
    readonly nativeKey: string;
    readonly resource: string;
    readonly row: number;
  };
};
export type Unit = CatalogUnit | GuideUnit;
type CatalogTranslation = {
  readonly domain: "catalog";
  readonly nativeKey: string;
  readonly text: string;
  readonly approved: boolean;
  readonly resourceKey: string;
};
type GuideTranslation = {
  readonly domain: "guide";
  readonly nativeKey: string;
  readonly content: { readonly message: string; readonly reviewed: boolean };
  readonly resourceKey: string;
};
export type Translation = CatalogTranslation | GuideTranslation;
export type TranslationContent = string | GuideTranslation["content"];
export type Domain = "catalog" | "guide";
const sourceSchema = standardSchema<Unit>((value): value is Unit => {
  if (!isRecord(value) || !isRecord(value.context)) return false;
  if (value.context.domain === "catalog")
    return (
      isRecord(value.source) &&
      typeof value.source.label === "string" &&
      typeof value.context.nativeKey === "string" &&
      typeof value.context.file === "string" &&
      typeof value.context.line === "number" &&
      typeof value.context.screenshot === "string"
    );
  if (value.context.domain === "guide")
    return (
      isRecord(value.source) &&
      typeof value.source.body === "string" &&
      typeof value.context.nativeKey === "string" &&
      typeof value.context.resource === "string" &&
      typeof value.context.row === "number"
    );
  return false;
});
const translationSchema = standardSchema<Translation>(
  (value): value is Translation => {
    if (!isRecord(value)) return false;
    if (value.domain === "catalog")
      return (
        typeof value.nativeKey === "string" &&
        typeof value.text === "string" &&
        typeof value.approved === "boolean" &&
        typeof value.resourceKey === "string"
      );
    if (value.domain === "guide")
      return (
        typeof value.nativeKey === "string" &&
        isRecord(value.content) &&
        typeof value.content.message === "string" &&
        typeof value.content.reviewed === "boolean" &&
        typeof value.resourceKey === "string"
      );
    return false;
  },
);
const contentSchema = standardSchema<TranslationContent>(
  (value): value is TranslationContent =>
    typeof value === "string" ||
    (isRecord(value) &&
      typeof value.message === "string" &&
      typeof value.reviewed === "boolean"),
);
const qualityConfigurationSchema: StandardSchemaV1<JsonValue, JsonValue> = {
  "~standard": {
    version: 1,
    vendor: "independent-composition",
    validate(value) {
      return { value: value as JsonValue };
    },
  },
};
type TargetResource = {
  readonly enumeration: "complete" | "partial" | "failed";
  readonly records: readonly Translation[];
};
type EntryModule = {
  readonly domain: Domain;
  readonly sourceRange: string;
  readonly translationRange: string;
  readonly readUnits: () => readonly Unit[];
  readonly readTargets: (language: string) => TargetResource;
  readonly exception?: QualityException;
  readonly checkConfiguration: JsonValue;
  readonly resolveCompletion: (
    input: CompletionResolverInput<Unit, Translation>,
  ) => CompletionResolution;
  readonly updatePolicy: (
    input: UpdatePolicyInput<Unit, Translation, TranslationContent>,
  ) => UpdateDecision<TranslationContent>;
};

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8")) as unknown;
}

function readCatalogUnits(): readonly CatalogUnit[] {
  const source = readJson("composition/catalog-source.json") as {
    readonly items: readonly {
      readonly nativeKey: string;
      readonly label: string;
      readonly file: string;
      readonly line: number;
      readonly screenshot: string;
    }[];
  };
  return source.items.map((item) => ({
    source: { label: item.label },
    context: {
      domain: "catalog",
      nativeKey: item.nativeKey,
      file: item.file,
      line: item.line,
      screenshot: item.screenshot,
    },
  }));
}

function readGuideUnits(): readonly GuideUnit[] {
  const source = readJson("composition/guide-source.json") as {
    readonly pages: readonly {
      readonly id: string;
      readonly body: string;
      readonly resource: string;
      readonly row: number;
    }[];
  };
  return source.pages.map((page) => ({
    source: { body: page.body },
    context: {
      domain: "guide",
      nativeKey: page.id,
      resource: page.resource,
      row: page.row,
    },
  }));
}

function readCatalogTargets(): TargetResource {
  const resource = readJson("composition/catalog-fr.json") as {
    readonly enumeration: TargetResource["enumeration"];
    readonly entries: readonly {
      readonly nativeKey: string;
      readonly text: string;
      readonly approved: boolean;
      readonly resourceKey: string;
    }[];
  };
  return {
    enumeration: resource.enumeration,
    records: resource.entries.map((entry) => ({
      domain: "catalog",
      nativeKey: entry.nativeKey,
      text: entry.text,
      approved: entry.approved,
      resourceKey: entry.resourceKey,
    })),
  };
}

function readGuideTargets(): TargetResource {
  const resource = readJson("composition/guide-fr.json") as {
    readonly enumeration: TargetResource["enumeration"];
    readonly messages: readonly {
      readonly id: string;
      readonly content: string;
      readonly reviewed: boolean;
      readonly resourceKey: string;
    }[];
  };
  return {
    enumeration: resource.enumeration,
    records: resource.messages.map((message) => ({
      domain: "guide",
      nativeKey: message.id,
      content: { message: message.content, reviewed: message.reviewed },
      resourceKey: message.resourceKey,
    })),
  };
}

const catalogException: QualityException = {
  id: "catalog-approved-numbers",
  ruleId: "catalog-numbers",
  scope: {
    object: { kind: "translation-unit", key: "catalog:save", language: "fr" },
  },
  reason: "目录中的数字差异由维护者单独确认。",
};

const catalogModule: EntryModule = {
  domain: "catalog",
  sourceRange: "composition/catalog-source.json",
  translationRange: "composition/catalog-fr.json",
  readUnits: readCatalogUnits,
  readTargets: () => readCatalogTargets(),
  exception: catalogException,
  checkConfiguration: { domain: "catalog" },
  resolveCompletion: ({ translations }) => {
    const target = translations[0]?.translation;
    return (
      target?.domain === "catalog" &&
      target.approved &&
      target.text.trim().length > 0
    );
  },
  updatePolicy: ({ processed }) =>
    processed
      ? { action: "none", reason: "目录范围已单独处理。" }
      : { action: "retain", reason: "保留目录中的现有译法。" },
};

const guideModule: EntryModule = {
  domain: "guide",
  sourceRange: "composition/guide-source.json",
  translationRange: "composition/guide-fr.json",
  readUnits: readGuideUnits,
  readTargets: () => readGuideTargets(),
  checkConfiguration: { domain: "guide" },
  resolveCompletion: ({ translations }) => {
    const target = translations[0]?.translation;
    return (
      target?.domain === "guide" &&
      target.content.reviewed &&
      target.content.message.trim().length > 0
    );
  },
  updatePolicy: ({ processed }) =>
    processed
      ? { action: "none", reason: "指南范围已单独处理。" }
      : { action: "review", reason: "指南内容需要维护者复核。" },
};

function isCatalogUnit(unit: Unit): unit is CatalogUnit {
  return unit.context.domain === "catalog";
}

function unitText(unit: Unit): string {
  if (isCatalogUnit(unit)) return unit.source.label;
  return unit.source.body;
}

function translationText(
  content: TranslationContent,
  domain: Domain,
): string | undefined {
  if (typeof content === "string") return content;
  if (domain === "catalog") return undefined;
  return typeof content === "object" &&
    content !== null &&
    "message" in content &&
    typeof content.message === "string"
    ? content.message
    : undefined;
}

function createDomainChecker(
  module: EntryModule,
): QualityCheckDefinition<
  Unit,
  Translation,
  QualityObject,
  TranslationContent,
  never
> {
  type Subject = {
    readonly sourceUnit: SourceUnitFact<Unit>;
    readonly sourceKey: string;
    readonly language: string;
    readonly content: TranslationContent;
  };
  return bindQualityCheck<
    Unit,
    Translation,
    typeof qualityConfigurationSchema,
    typeof numberTextInputSchema,
    Subject,
    QualityObject,
    TranslationContent,
    never
  >({
    id: module.domain + "-numbers",
    configurationSchema: qualityConfigurationSchema,
    configuration: {
      options: module.checkConfiguration,
      numbers: {
        format: "ascii-decimal-v1",
        comparison: "exact-multiset",
      },
    },
    inputSchema: numberTextInputSchema,
    select: (
      input: QualityCheckInput<
        Unit,
        Translation,
        JsonValue,
        TranslationContent,
        never
      >,
    ): QualityCheckSelection<Subject> => {
      const sourceUnit = input.sourceUnit;
      if (sourceUnit === null)
        return {
          status: "incomplete",
          issue: { code: "sourceUnavailable", message: "找不到对应原文。" },
        };
      if (sourceUnit.unit.context.domain !== module.domain)
        return { status: "not-applicable" };
      if (sourceUnit.bodyAvailability !== "available")
        return {
          status: "incomplete",
          issue: {
            code: "sourceUnavailable",
            message: "原文正文不可用，无法核对数字。",
          },
        };
      return {
        status: "selected",
        subject: {
          sourceUnit,
          sourceKey: input.candidate.sourceKey,
          language: input.candidate.language,
          content: input.candidate.content,
        },
      };
    },
    project: (
      input: QualityCheckProjectionInput<
        Unit,
        Translation,
        JsonValue,
        Subject,
        TranslationContent,
        never
      >,
    ): QualityCheckProjection<NumberTextInput> => {
      const source = unitText(input.subject.sourceUnit.unit);
      const target = translationText(input.subject.content, module.domain);
      if (target === undefined)
        return {
          status: "incomplete",
          issue: {
            code: "textUnavailable",
            message: "无法取得候选译文的文本。",
          },
        };
      return { status: "ready", value: { source, target } };
    },
    check: (
      input: QualityCheckRuleInput<
        Unit,
        Translation,
        JsonValue,
        Subject,
        NumberTextInput,
        TranslationContent,
        never
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
      const defaultSourceLocation = {
        language: null,
        range:
          input.facts.source.read.scopes[input.subject.sourceUnit.scopeIndex]
            ?.range,
      };
      const defaultTargetLocation = {
        language: subject.language,
        range: record?.range ?? null,
        key: subject.key,
      };
      return compareNumberText({
        ...input.projected,
        subject,
        sourceLocation: defaultSourceLocation,
        targetLocation: defaultTargetLocation,
        targetContent: input.subject.content,
      });
    },
  });
}

function requestForDomain(
  facts: FrameworkFacts<Unit, Translation, TranslationContent, never>,
  domain: Domain,
): QualityCheckRequest<TranslationContent> {
  const candidates = facts.associations.flatMap((association) => {
    if (
      !association.sourceKey.startsWith(domain + ":") ||
      association.status !== "matched"
    )
      return [];
    const record =
      facts.translations.records[association.translationIndexes[0] as number];
    if (record?.bodyAvailability !== "available") return [];
    return [
      {
        sourceKey: association.sourceKey,
        language: association.language,
        content: record.content,
      },
    ];
  });
  return {
    candidates,
    relationships: [],
    exceptions: domain === "catalog" ? [catalogException] : [],
    dependencies: { domain },
  };
}

function mergeQualityRequests(
  requests: readonly QualityCheckRequest<TranslationContent>[],
): QualityCheckRequest<TranslationContent> {
  return {
    candidates: requests.flatMap(({ candidates }) => candidates),
    relationships: requests.flatMap(({ relationships }) => relationships ?? []),
    exceptions: requests.flatMap(({ exceptions }) => exceptions ?? []),
    dependencies: {
      inputs: requests.map(({ dependencies }) => dependencies),
    },
  };
}

function createInputConfig(
  modules: readonly EntryModule[],
): FrameworkConfig<Unit, Translation, TranslationContent> {
  const qualityChecks = modules.map(createDomainChecker);
  return defineConfig({
    source: {
      schema: sourceSchema,
      read: () => ({
        scopes: modules.map((module) => ({
          range: module.sourceRange,
          enumeration: "complete" as const,
          records: module.readUnits().map((value) => ({
            value,
            bodyAvailability: "available" as const,
          })),
        })),
      }),
    },
    keyOf: (unit) => unit.context.domain + ":" + unit.context.nativeKey,
    translations: {
      languages: ["fr"],
      schema: translationSchema,
      contentSchema,
      contentOf: (translation) =>
        translation.domain === "catalog"
          ? translation.text
          : translation.content.message,
      read: (language, sourceUnits) => ({
        scopes: modules.flatMap((module) => {
          const selected = sourceUnits.filter(
            ({ unit }) => unit.context.domain === module.domain,
          );
          if (selected.length === 0) return [];
          const targets = module.readTargets(language);
          return [
            {
              range: module.translationRange,
              covers: selected.map(({ key }) => key),
              enumeration: targets.enumeration,
              records: targets.records.map((value) => ({
                value,
                bodyAvailability: "available" as const,
              })),
            },
          ];
        }),
      }),
      matches: (unit, translation) =>
        unit.context.domain === translation.domain &&
        unit.context.nativeKey === translation.nativeKey,
    },
    completion: {
      criterion: "input-specific-content-and-status-v1",
      resolveCompletion(input) {
        const module = modules.find(
          ({ domain }) => domain === input.sourceUnit.unit.context.domain,
        );
        return module === undefined
          ? { status: "unknown", reason: "没有对应的局部判据。" }
          : module.resolveCompletion(input);
      },
    },
    qualityChecks,
    createQualityRequest: (facts) =>
      mergeQualityRequests(
        modules.map(({ domain }) => requestForDomain(facts, domain)),
      ),
    updatePolicy(input) {
      const module = modules.find(({ domain }) =>
        input.sourceKey.startsWith(domain + ":"),
      );
      return module === undefined
        ? { action: "review", reason: "没有对应的局部更新策略。" }
        : module.updatePolicy(input);
    },
  });
}

export const catalogConfig = createInputConfig([catalogModule]);
export const guideConfig = createInputConfig([guideModule]);
export default createInputConfig([catalogModule, guideModule]);
