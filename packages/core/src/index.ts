import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import type { MemoScope } from "@lioni/memo";

import type { Compare } from "./comparison.ts";
import {
  CompletionConfigurationError,
  evaluateCompletion,
} from "./completion.ts";
import type { CompletionFacts, CompletionPolicy } from "./completion.ts";
import { bindFrameworkConfig } from "./config-capability.ts";
import type { UpdatePolicy } from "./plans.ts";
import {
  runQualityChecks,
  type QualityCheckDefinition,
  type QualityCheckRequest,
  type QualityRunResult,
  type QualityObject,
} from "./qa.ts";
import {
  prepareSemanticEdit,
  resolveSemanticEditInput,
  validateSemanticEditCandidate,
  type SemanticEditPreparation,
} from "./semantic-edits.ts";
import type {
  JsonValue,
  SemanticEditCandidate,
  TranslationWritebackAdapter,
} from "./semantic-edits.ts";
import {
  assertJsonValue,
  snapshotJsonValue,
  StandardSchemaContractError,
  validateWithStandardSchema,
} from "./standard-schema.ts";
import type {
  PreservingStandardSchema,
  StandardSchemaV1,
  StandardSchemaTypes,
} from "./standard-schema.ts";

export * from "./completion.ts";
export * from "./semantic-edits.ts";
export { StandardSchemaContractError } from "./standard-schema.ts";
export type {
  StandardSchemaFailureKind,
  StandardSchemaV1,
  StandardSchemaV1Issue,
  StandardSchemaV1Result,
} from "./standard-schema.ts";
export * from "./apply-plans.ts";
export {
  createUpdatePlan,
  defaultUpdatePolicy,
  validateUpdatePlanHistory,
  validateUpdatePlan,
} from "./plans.ts";
export type {
  UpdateDecision,
  UpdatePlan,
  UpdatePlanBlock,
  UpdatePlanBlockCode,
  UpdatePlanData,
  UpdatePlanDataItem,
  UpdatePlanItem,
  UpdatePlanObservation,
  UpdatePlanStatus,
  UpdatePlanStore,
  UpdatePolicy,
  UpdatePolicyInput,
} from "./plans.ts";
export * from "./qa.ts";
export {
  compareSnapshots,
  defaultCompare,
  ComparisonContractError,
  validateComparisonInput,
  validateComparisonResult,
} from "./comparison.ts";
export type {
  Compare,
  CompareInput,
  ComparisonContractErrorReason,
  ComparisonResult,
  ComparisonStatus,
  SnapshotReadEvidence,
  SourceChange,
  TranslationChange,
} from "./comparison.ts";
export {
  advanceProcessingBaseline,
  compareProcessingBaseline,
  type ProcessingBaseline,
  type ProcessingBaselineAdvanceResult,
  type ProcessingBaselineChange,
  type ProcessingBaselineEntry,
  type ProcessingBaselineSelection,
  type ProcessingBaselineSourceScope,
  type ProcessingBaselineStore,
  type ProcessingBaselineTranslation,
  type ProcessingBaselineTranslationScope,
  type ProcessingBaselineComparison,
  type ProcessingChangeStatus,
} from "./baselines.ts";

export type Awaitable<T> = T | Promise<T>;

export type TranslationUnitInput = {
  readonly source: unknown;
  readonly context?: unknown;
};

export type BodyAvailability = "available" | "unavailable";
export type EnumerationCompleteness = "complete" | "partial" | "failed";

export type ReadRecord<TValue, TUnavailable = TValue> =
  | { readonly value: TValue; readonly bodyAvailability: "available" }
  | { readonly value: TUnavailable; readonly bodyAvailability: "unavailable" };

export type ReadScope<TValue, TUnavailable = TValue> = {
  readonly range: unknown;
  readonly enumeration: EnumerationCompleteness;
  readonly records: readonly ReadRecord<TValue, TUnavailable>[];
  readonly error?: string;
};

export type SourceRead<TUnit extends TranslationUnitInput> = {
  readonly scopes: readonly ReadScope<TUnit>[];
};

export type SourceAdapter<TUnit extends TranslationUnitInput> = {
  readonly schema: StandardSchemaV1<TUnit, TUnit>;
  read(): Awaitable<SourceRead<TUnit>>;
};

export type TranslationReadScope<
  TTranslation,
  TUnavailable = never,
> = ReadScope<TTranslation, TUnavailable> & {
  readonly covers: readonly string[];
};

export type TranslationRead<TTranslation, TUnavailable = never> = {
  readonly scopes: readonly TranslationReadScope<TTranslation, TUnavailable>[];
};

export type TranslationAdapter<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody = JsonValue,
  TUnavailable = never,
  TTranslationSchema = StandardSchemaV1<TTranslation, TTranslation>,
  TUnavailableSchema = StandardSchemaV1<TUnavailable, TUnavailable>,
  TContentSchema = StandardSchemaV1<TBody, TBody>,
> = {
  readonly languages: readonly string[];
  readonly schema: TTranslationSchema &
    StandardSchemaV1<TTranslation, TTranslation> &
    PreservingStandardSchema<TTranslation, TTranslationSchema>;
  readonly unavailableSchema?: TUnavailableSchema &
    StandardSchemaV1<TUnavailable, TUnavailable> &
    PreservingStandardSchema<TUnavailable, TUnavailableSchema>;
  readonly contentSchema: TContentSchema &
    StandardSchemaV1<TBody, TBody> &
    PreservingStandardSchema<TBody, TContentSchema>;
  readonly contentOf: (translation: NoInfer<TTranslation>) => NoInfer<TBody>;
  /** 从译文记录提取稳定目标身份，不依赖正文或本次读取索引。 */
  readonly identityOf: (
    translation: NoInfer<TTranslation | TUnavailable>,
    language: string,
  ) => TranslationIdentityParts;
  read(
    language: string,
    sourceUnits: readonly SourceUnitFact<TUnit>[],
  ): Awaitable<TranslationRead<TTranslation, TUnavailable>>;
  matches?: (
    unit: NoInfer<TUnit>,
    translation: NoInfer<TTranslation | TUnavailable>,
  ) => boolean;
};

export type FrameworkConfig<
  TUnit extends TranslationUnitInput,
  TTranslation = unknown,
  TBody = JsonValue,
  TUnavailable = never,
> = {
  readonly source: SourceAdapter<TUnit>;
  readonly keyOf: (unit: TUnit) => string;
  readonly translations?: TranslationAdapter<
    TUnit,
    TTranslation,
    TBody,
    TUnavailable
  >;
  readonly compare?: Compare<TUnit, TTranslation, TBody, TUnavailable>;
  readonly completion?: CompletionPolicy<
    TUnit,
    TTranslation,
    TBody,
    TUnavailable
  >;
  readonly translationWriteback?: TranslationWritebackAdapter<
    TUnit,
    TTranslation,
    TBody,
    TUnavailable
  >;
  readonly updatePolicy?: UpdatePolicy<
    TUnit,
    TTranslation,
    TBody,
    TUnavailable
  >;
  readonly qualityChecks?: readonly QualityCheckDefinition<
    TUnit,
    TTranslation,
    QualityObject,
    TBody,
    TUnavailable
  >[];
  readonly createQualityRequest?: (
    facts: FrameworkFacts<TUnit, TTranslation, TBody, TUnavailable>,
  ) => Awaitable<QualityCheckRequest<TBody>>;
};

type DefineConfigInput<
  TUnit extends TranslationUnitInput,
  TSchema,
  TTranslationSchema,
  TUnavailableSchema,
  TContentSchema,
> = Omit<
  FrameworkConfig<
    NoInfer<TUnit>,
    NoInfer<SchemaOutput<TTranslationSchema>>,
    NoInfer<SchemaOutput<TContentSchema>>,
    NoInfer<SchemaOutput<TUnavailableSchema>>
  >,
  "source" | "translations"
> & {
  readonly source: {
    readonly schema: TSchema &
      StandardSchemaV1<TUnit, TUnit> &
      PreservingStandardSchema<TUnit, TSchema>;
    read(): Awaitable<SourceRead<NoInfer<TUnit>>>;
  };
  readonly translations?: TranslationAdapterInput<
    NoInfer<TUnit>,
    TTranslationSchema,
    TUnavailableSchema,
    TContentSchema
  >;
};

type TranslationAdapterInput<
  TUnit extends TranslationUnitInput,
  TTranslationSchema,
  TUnavailableSchema,
  TContentSchema,
> = {
  readonly languages: readonly string[];
  readonly schema: TTranslationSchema &
    StandardSchemaV1<
      SchemaOutput<TTranslationSchema>,
      SchemaOutput<TTranslationSchema>
    > &
    PreservingStandardSchema<
      SchemaOutput<TTranslationSchema>,
      TTranslationSchema
    >;
  readonly unavailableSchema?: TUnavailableSchema &
    StandardSchemaV1<
      SchemaOutput<TUnavailableSchema>,
      SchemaOutput<TUnavailableSchema>
    > &
    PreservingStandardSchema<
      SchemaOutput<TUnavailableSchema>,
      TUnavailableSchema
    >;
  readonly contentSchema: TContentSchema &
    StandardSchemaV1<
      SchemaOutput<TContentSchema>,
      SchemaOutput<TContentSchema>
    > &
    PreservingStandardSchema<SchemaOutput<TContentSchema>, TContentSchema>;
  readonly contentOf: (
    translation: NoInfer<SchemaOutput<TTranslationSchema>>,
  ) => NoInfer<SchemaOutput<TContentSchema>>;
  readonly identityOf: (
    translation: NoInfer<
      SchemaOutput<TTranslationSchema> | SchemaOutput<TUnavailableSchema>
    >,
    language: string,
  ) => TranslationIdentityParts;
  read(
    language: string,
    sourceUnits: readonly SourceUnitFact<NoInfer<TUnit>>[],
  ): Awaitable<
    TranslationRead<
      NoInfer<SchemaOutput<TTranslationSchema>>,
      NoInfer<SchemaOutput<TUnavailableSchema>>
    >
  >;
  matches?: (
    unit: NoInfer<TUnit>,
    translation: NoInfer<
      SchemaOutput<TTranslationSchema> | SchemaOutput<TUnavailableSchema>
    >,
  ) => boolean;
};

type SchemaOutput<TSchema> = TSchema extends never
  ? never
  : StandardSchemaTypes<TSchema> extends { readonly output: infer TOutput }
    ? TOutput
    : never;

export type SourceUnitFact<TUnit extends TranslationUnitInput> = {
  readonly key: string;
  readonly unit: TUnit;
  readonly bodyAvailability: BodyAvailability;
  readonly scopeIndex: number;
};

export type SourceReadFact = {
  readonly status: "complete" | "incomplete" | "failed" | "notRead";
  readonly scopes: readonly {
    readonly range: unknown;
    readonly enumeration: EnumerationCompleteness;
    readonly recordCount: number;
    readonly error?: string;
  }[];
  readonly error?: string;
};

export type SourceFacts<TUnit extends TranslationUnitInput> = {
  readonly version: string;
  readonly read: SourceReadFact;
  readonly totalUnitCount: number | null;
  readonly units: readonly SourceUnitFact<TUnit>[];
};

export type TranslationAssociationStatus =
  | "matched"
  | "missing"
  | "unavailable"
  | "unknown"
  | "conflict";

export type CoverageStatus = "complete" | "incomplete" | "failed" | "notRead";

export type TranslationReadScopeFact = {
  readonly range: unknown;
  readonly covers: readonly string[];
  readonly enumeration: EnumerationCompleteness;
  readonly translationIndexes: readonly number[];
  readonly error?: string;
};

export type TranslationReadFact = {
  readonly language: string;
  readonly status: CoverageStatus;
  readonly scopes: readonly TranslationReadScopeFact[];
  readonly error?: string;
};

type ActualTranslationFactBase = {
  readonly index: number;
  readonly language: string;
  readonly scopeIndex: number;
  readonly range: unknown;
};

export type ActualTranslationFact<
  TTranslation,
  TBody = JsonValue,
  TUnavailable = never,
> =
  | (ActualTranslationFactBase & {
      readonly translation: TTranslation;
      readonly identity: TranslationIdentity;
      readonly content: TBody;
      readonly bodyAvailability: "available";
    })
  | (ActualTranslationFactBase & {
      readonly translation: TUnavailable;
      readonly identity: TranslationIdentity;
      readonly content?: never;
      readonly bodyAvailability: "unavailable";
    });

export type TranslationAssociationFact = {
  readonly sourceKey: string;
  readonly language: string;
  readonly status: TranslationAssociationStatus;
  readonly coverageStatus: CoverageStatus;
  readonly scopeIndexes: readonly number[];
  readonly translationIndexes: readonly number[];
};

/** 快照中译文目标的完整稳定身份。 */
export type TranslationIdentity = {
  readonly language: string;
  readonly namespace: string;
  readonly key: string;
};

/** 宿主提供的稳定目标身份部分；语言由框架补入。 */
export type TranslationIdentityParts = {
  readonly namespace: string;
  readonly key: string;
};

export type ComparisonSnapshot<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody = JsonValue,
  TUnavailable = never,
> = {
  readonly version: string;
  readonly source: SourceFacts<TUnit>;
  readonly translations: {
    readonly reads: readonly TranslationReadFact[];
    readonly records: readonly ActualTranslationFact<
      TTranslation,
      TBody,
      TUnavailable
    >[];
  };
};

export type FrameworkFacts<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody = JsonValue,
  TUnavailable = never,
> = ComparisonSnapshot<TUnit, TTranslation, TBody, TUnavailable> & {
  readonly associations: readonly TranslationAssociationFact[];
};

export class DuplicateTranslationUnitKeyError extends Error {
  readonly key: string;
  readonly firstIndex: number;
  readonly duplicateIndex: number;

  constructor(key: string, firstIndex: number, duplicateIndex: number) {
    super(
      `原文单元身份重复：${JSON.stringify(key)}（第 ${firstIndex + 1} 与第 ${duplicateIndex + 1} 个单元）`,
    );
    this.name = "DuplicateTranslationUnitKeyError";
    this.key = key;
    this.firstIndex = firstIndex;
    this.duplicateIndex = duplicateIndex;
  }
}

export class TranslationIdentityContractError extends TypeError {
  readonly reason: "missing" | "duplicate";
  readonly identity?: TranslationIdentity;
  readonly firstIndex?: number;
  readonly duplicateIndex?: number;

  constructor(
    reason: "missing" | "duplicate",
    details: {
      readonly identity?: TranslationIdentity;
      readonly firstIndex?: number;
      readonly duplicateIndex?: number;
    } = {},
  ) {
    super(
      reason === "missing"
        ? "译文身份必须提供非空的 namespace 与 key。"
        : `译文身份重复：${JSON.stringify(details.identity)}（第 ${(details.firstIndex ?? -1) + 1} 与第 ${(details.duplicateIndex ?? -1) + 1} 条记录）`,
    );
    this.name = "TranslationIdentityContractError";
    this.reason = reason;
    if (details.identity !== undefined) this.identity = details.identity;
    if (details.firstIndex !== undefined) this.firstIndex = details.firstIndex;
    if (details.duplicateIndex !== undefined)
      this.duplicateIndex = details.duplicateIndex;
  }
}

export function defineConfig<
  TUnit extends TranslationUnitInput,
  TSchema = StandardSchemaV1<TUnit, TUnit>,
  TTranslationSchema = StandardSchemaV1<unknown, unknown>,
  TUnavailableSchema = never,
  TContentSchema = StandardSchemaV1<JsonValue, JsonValue>,
>(
  config: DefineConfigInput<
    TUnit,
    TSchema,
    TTranslationSchema,
    TUnavailableSchema,
    TContentSchema
  >,
): FrameworkConfig<
  TUnit,
  SchemaOutput<TTranslationSchema>,
  SchemaOutput<TContentSchema>,
  SchemaOutput<TUnavailableSchema>
> {
  return bindFrameworkConfig(config);
}

export function validateFrameworkConfig(value: unknown): void {
  validateSourceConfig(value);
  if (!isRecord(value))
    invalidFrameworkConfig("宿主配置必须是 defineConfig(...) 的对象结果。");
  const translations = value.translations;
  if (translations === undefined) return;
  validateTranslationAdapterConfig(translations);
}

function validateSourceConfig(value: unknown): void {
  if (!isRecord(value))
    invalidFrameworkConfig("宿主配置必须是 defineConfig(...) 的对象结果。");
  if (!isRecord(value.source) || typeof value.source.read !== "function")
    invalidFrameworkConfig("defineConfig 的 source.read 必须是函数。");
  if (!isStandardSchema(value.source.schema))
    invalidFrameworkConfig(
      "defineConfig 的 source.schema 必须符合 Standard Schema v1。",
    );
  if (typeof value.keyOf !== "function")
    invalidFrameworkConfig("defineConfig 的 keyOf 必须是函数。");
}

function validateTranslationAdapterConfig(translations: unknown): void {
  if (
    !isRecord(translations) ||
    !Array.isArray(translations.languages) ||
    translations.languages.some((language) => typeof language !== "string") ||
    typeof translations.read !== "function" ||
    typeof translations.identityOf !== "function" ||
    typeof translations.contentOf !== "function" ||
    !isStandardSchema(translations.schema) ||
    !isStandardSchema(translations.contentSchema) ||
    (translations.unavailableSchema !== undefined &&
      !isStandardSchema(translations.unavailableSchema))
  )
    invalidFrameworkConfig(
      "defineConfig 的 translations 必须提供语言列表、记录与正文 schema、identityOf、read 与 contentOf 函数；matches 可按需提供。",
    );
}

function invalidFrameworkConfig(message: string): never {
  throw new StandardSchemaContractError(
    "defineConfig 配置",
    "schema-mismatch",
    message,
  );
}

export async function readSourceFacts<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  config: FrameworkConfig<TUnit, TTranslation, TBody, TUnavailable>,
): Promise<SourceFacts<TUnit>> {
  validateSourceConfig(config);
  let read: SourceRead<TUnit> | undefined;
  let errorMessage: string | undefined;
  try {
    read = await config.source.read();
  } catch (error) {
    if (error instanceof StandardSchemaContractError) throw error;
    errorMessage = error instanceof Error ? error.message : String(error);
  }

  if (errorMessage === undefined) validateSourceRead(read);

  const firstIndexes = new Map<string, number>();
  const units: SourceUnitFact<TUnit>[] = [];
  const scopes = read?.scopes ?? [];
  for (const [scopeIndex, scope] of scopes.entries()) {
    for (const record of scope.records) {
      const index = units.length;
      const unit = await validateWithStandardSchema(
        config.source.schema,
        record.value,
        `原文单元 ${index + 1}`,
        { preserveValue: true, requireJson: true },
      );
      const key = config.keyOf(unit);
      const firstIndex = firstIndexes.get(key);
      if (firstIndex !== undefined)
        throw new DuplicateTranslationUnitKeyError(key, firstIndex, index);
      firstIndexes.set(key, index);
      units.push({
        key,
        unit,
        bodyAvailability: record.bodyAvailability,
        scopeIndex,
      });
    }
  }

  const scopeFacts = scopes.map((scope) => ({
    range: scope.range,
    enumeration: scope.enumeration,
    recordCount: scope.records.length,
    ...(scope.error === undefined ? {} : { error: scope.error }),
  }));
  const status = readStatus(scopeFacts, errorMessage);
  const totalUnitCount = status === "complete" ? units.length : null;
  const readFact: SourceReadFact = {
    status,
    scopes: scopeFacts,
    ...(errorMessage === undefined ? {} : { error: errorMessage }),
  };
  const version = sourceFactsVersion({ read: readFact, units });
  return {
    version,
    read: readFact,
    totalUnitCount,
    units,
  };
}

/** 读取源、目标事实及依据，不计算源译关联、完成度或 QA。 */
export async function readComparisonSnapshot<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  config: FrameworkConfig<TUnit, TTranslation, TBody, TUnavailable>,
): Promise<ComparisonSnapshot<TUnit, TTranslation, TBody, TUnavailable>> {
  validateFrameworkConfig(config);
  return await collectComparisonSnapshot(config);
}

async function collectComparisonSnapshot<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  config: FrameworkConfig<TUnit, TTranslation, TBody, TUnavailable>,
): Promise<ComparisonSnapshot<TUnit, TTranslation, TBody, TUnavailable>> {
  const source = await readSourceFacts(config);
  const translationAdapter = config.translations;
  const translations = {
    reads: [] as TranslationReadFact[],
    records: [] as ActualTranslationFact<TTranslation, TBody, TUnavailable>[],
  };
  const firstTranslationIndexes = new Map<string, number>();

  if (translationAdapter !== undefined) {
    for (const language of translationAdapter.languages) {
      let read: TranslationRead<TTranslation, TUnavailable> | undefined;
      let errorMessage: string | undefined;
      try {
        read = await translationAdapter.read(language, source.units);
      } catch (error) {
        if (error instanceof StandardSchemaContractError) throw error;
        errorMessage = error instanceof Error ? error.message : String(error);
      }

      if (errorMessage === undefined) validateTranslationRead(read);

      const scopes: TranslationReadScopeFact[] = [];
      for (const [scopeIndex, scope] of (read?.scopes ?? []).entries()) {
        const translationIndexes: number[] = [];
        for (const record of scope.records) {
          const index = translations.records.length;
          translationIndexes.push(index);
          const fact = {
            index,
            language,
            scopeIndex,
            range: scope.range,
          };
          if (record.bodyAvailability === "available") {
            const translation = await validateWithStandardSchema(
              translationAdapter.schema,
              record.value,
              `译文记录 ${index + 1}`,
              { preserveValue: true, requireJson: true },
            );
            const identity = readTranslationIdentity(
              translationAdapter.identityOf(translation, language),
              language,
            );
            assertUniqueTranslationIdentity(
              identity,
              firstTranslationIndexes,
              index,
            );
            const content = await validateWithStandardSchema(
              translationAdapter.contentSchema,
              translationAdapter.contentOf(translation),
              `译文正文 ${index + 1}`,
              { preserveValue: true, requireJson: true },
            );
            translations.records.push({
              ...fact,
              translation,
              identity,
              content,
              bodyAvailability: "available",
            });
          } else if (record.bodyAvailability === "unavailable") {
            const schema = translationAdapter.unavailableSchema;
            if (schema === undefined)
              throw new StandardSchemaContractError(
                `译文记录 ${index + 1}`,
                "schema-mismatch",
                "发现不可用译文记录，但 translations.unavailableSchema 未声明该分支。",
              );
            const translation = await validateWithStandardSchema(
              schema,
              record.value,
              `不可用译文记录 ${index + 1}`,
              { preserveValue: true, requireJson: true },
            );
            const identity = readTranslationIdentity(
              translationAdapter.identityOf(translation, language),
              language,
            );
            assertUniqueTranslationIdentity(
              identity,
              firstTranslationIndexes,
              index,
            );
            translations.records.push({
              ...fact,
              translation,
              identity,
              bodyAvailability: "unavailable",
            });
          } else {
            throw new StandardSchemaContractError(
              `译文记录 ${index + 1}`,
              "invalid-schema-result",
              "译文记录的 bodyAvailability 必须为 available 或 unavailable。",
            );
          }
        }
        scopes.push({
          range: scope.range,
          covers: [...scope.covers],
          enumeration: scope.enumeration,
          translationIndexes,
          ...(scope.error === undefined ? {} : { error: scope.error }),
        });
      }
      translations.reads.push({
        language,
        status: readStatus(scopes, errorMessage),
        scopes,
        ...(errorMessage === undefined ? {} : { error: errorMessage }),
      });
    }
  }

  const version = comparisonSnapshotVersion({ source, translations });
  return { version, source, translations };
}

export async function readFacts<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  config: FrameworkConfig<TUnit, TTranslation, TBody, TUnavailable>,
): Promise<FrameworkFacts<TUnit, TTranslation, TBody, TUnavailable>> {
  validateFrameworkConfig(config);
  const translationAdapter = config.translations;
  if (
    translationAdapter !== undefined &&
    translationAdapter.languages.length > 0 &&
    typeof translationAdapter.matches !== "function"
  )
    invalidFrameworkConfig(
      "readFacts 需要 translations.matches 来计算源译关联；独立快照读取无需此函数。",
    );
  const snapshot = await collectComparisonSnapshot(config);

  const associations: TranslationAssociationFact[] = [];
  for (const languageRead of snapshot.translations.reads) {
    const languageRecords = snapshot.translations.records.filter(
      ({ language }) => language === languageRead.language,
    );
    for (const sourceUnit of snapshot.source.units) {
      const scopeIndexes = languageRead.scopes.flatMap((scope, index) =>
        scope.covers.includes(sourceUnit.key) ? [index] : [],
      );
      const relevantScopes = languageRead.scopes.filter((_, index) =>
        scopeIndexes.includes(index),
      );
      const coverageStatus = readStatus(
        relevantScopes,
        scopeIndexes.length === 0 ? languageRead.error : undefined,
      );
      const translationIndexes = languageRecords
        .filter(({ scopeIndex }) => scopeIndexes.includes(scopeIndex))
        .filter(({ translation }) =>
          translationAdapter!.matches!(sourceUnit.unit, translation),
        )
        .map(({ index }) => index);

      const status: TranslationAssociationStatus =
        translationIndexes.length > 1
          ? "conflict"
          : translationIndexes.length === 0
            ? coverageStatus === "complete"
              ? "missing"
              : "unknown"
            : coverageStatus !== "complete"
              ? "unknown"
              : snapshot.translations.records[translationIndexes[0] as number]
                    ?.bodyAvailability === "available"
                ? "matched"
                : "unavailable";
      associations.push({
        sourceKey: sourceUnit.key,
        language: languageRead.language,
        status,
        coverageStatus,
        scopeIndexes,
        translationIndexes,
      });
    }
  }

  const version = factsVersion({
    source: snapshot.source,
    translations: snapshot.translations,
    associations,
  });
  return { ...snapshot, version, associations };
}

export async function readCompletion<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  config: FrameworkConfig<TUnit, TTranslation, TBody, TUnavailable>,
): Promise<CompletionFacts<TUnit, TTranslation, TBody, TUnavailable>> {
  validateFrameworkConfig(config);
  const policy = config.completion;
  if (policy === undefined)
    throw new CompletionConfigurationError("missingPolicy");
  if (
    !isRecord(policy) ||
    typeof policy.criterion !== "string" ||
    typeof policy.resolveCompletion !== "function"
  )
    throw new TypeError(
      "defineConfig 的 completion 必须提供 criterion 与 resolveCompletion 函数。",
    );
  if (config.translations === undefined)
    throw new CompletionConfigurationError("missingTranslations");

  const facts = await readFacts(config);
  const completion = await evaluateCompletion(facts, policy);
  return { ...facts, completion };
}

export async function analyzeQuality<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  config: FrameworkConfig<TUnit, TTranslation, TBody, TUnavailable>,
  options: {
    readonly candidates?: readonly SemanticEditCandidate<TBody>[];
    readonly memo?: MemoScope;
  } = {},
): Promise<QualityRunResult<QualityObject, TBody>> {
  const facts = await readFacts(config);
  const checks = configuredQualityChecks(config);
  const configuredRequest = await createConfiguredQualityRequest(config, facts);
  const request =
    options.candidates === undefined
      ? configuredRequest
      : { ...configuredRequest, candidates: options.candidates };
  const candidates: SemanticEditCandidate<TBody>[] = [];
  for (const candidate of request.candidates)
    candidates.push(await validateSemanticEditCandidate(candidate, config));
  return runQualityChecks(facts, { ...request, candidates }, checks, options);
}

export type QualityWriteCondition<TBody = JsonValue> = (
  quality: QualityRunResult<QualityObject, TBody>,
) => Awaitable<boolean>;

export type PrepareQualityConditionedSemanticEditOptions<TBody = JsonValue> = {
  readonly candidate: SemanticEditCandidate<TBody>;
  readonly condition?: QualityWriteCondition<TBody>;
  readonly quality?: QualityRunResult<QualityObject, TBody>;
  readonly memo?: MemoScope;
};

export type QualityConditionedSemanticEditResult<TBody = JsonValue> =
  | {
      readonly status: "not-required";
      readonly preparation: SemanticEditPreparation<TBody>;
    }
  | {
      readonly status: "passed";
      readonly quality: QualityRunResult<QualityObject, TBody>;
      readonly preparation: SemanticEditPreparation<TBody>;
    }
  | {
      readonly status: "rejected";
      readonly quality: QualityRunResult<QualityObject, TBody>;
    }
  | {
      readonly status: "input-mismatch";
      readonly reason: string;
    };

/**
 * 根据宿主选择的质量条件决定是否准备语义编辑。
 * 未提供条件时不要求执行质量检查，候选仍走普通语义编辑准备流程。
 */
export async function prepareQualityConditionedSemanticEdit<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  config: FrameworkConfig<TUnit, TTranslation, TBody, TUnavailable>,
  options: PrepareQualityConditionedSemanticEditOptions<TBody>,
): Promise<QualityConditionedSemanticEditResult<TBody>> {
  const candidate = await validateSemanticEditCandidate(
    options.candidate,
    config,
  );
  const { condition } = options;
  const providedQuality =
    condition === undefined || options.quality === undefined
      ? undefined
      : (snapshotJson(options.quality, "QA 结果") as QualityRunResult<
          QualityObject,
          TBody
        >);
  const facts = await readFacts(config);
  if (condition === undefined)
    return {
      status: "not-required",
      preparation: await prepareCandidateEdit(facts, candidate, config),
    };

  const checks = configuredQualityChecks(config);
  const configuredRequest = await createConfiguredQualityRequest(config, facts);
  const qualityCandidate = candidate;
  const request = { ...configuredRequest, candidates: [qualityCandidate] };
  const quality =
    providedQuality ??
    (await runQualityChecks(facts, request, checks, options));
  if (
    providedQuality !== undefined &&
    !(await qualityRunMatchesInputs(
      facts,
      qualityCandidate,
      configuredRequest,
      checks,
      quality,
    ))
  )
    return {
      status: "input-mismatch",
      reason: "质量检查结果不匹配当前候选、事实或明确检查输入。",
    };

  if (!(await condition(quality))) return { status: "rejected", quality };
  return {
    status: "passed",
    quality,
    preparation: await prepareCandidateEdit(facts, candidate, config),
  };
}

async function prepareCandidateEdit<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  facts: FrameworkFacts<TUnit, TTranslation, TBody, TUnavailable>,
  candidate: SemanticEditCandidate<TBody>,
  config: FrameworkConfig<TUnit, TTranslation, TBody, TUnavailable>,
): Promise<SemanticEditPreparation<TBody>> {
  const resolved = await resolveSemanticEditInput(
    facts,
    { sourceKey: candidate.sourceKey, language: candidate.language },
    config,
  );
  return resolved.status === "resolved"
    ? prepareSemanticEdit(resolved.input, candidate, config)
    : resolved;
}

async function qualityRunMatchesInputs<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  facts: FrameworkFacts<TUnit, TTranslation, TBody, TUnavailable>,
  candidate: SemanticEditCandidate<TBody>,
  request: QualityCheckRequest<TBody>,
  checks: readonly QualityCheckDefinition<
    TUnit,
    TTranslation,
    QualityObject,
    TBody,
    TUnavailable
  >[],
  quality: QualityRunResult<QualityObject, TBody>,
): Promise<boolean> {
  const configurationRun = await runQualityChecks(
    facts,
    { ...request, candidates: [] },
    checks,
  );
  if (quality.version !== facts.version) return false;
  const expectedRequest = snapshotJson(
    {
      ...request,
      candidates: [candidate],
      relationships: request.relationships ?? [],
      exceptions: request.exceptions ?? [],
    },
    "QA 输入",
  ) as Pick<
    QualityRunResult<QualityObject, TBody>,
    "candidates" | "dependencies" | "relationships" | "exceptions"
  >;
  if (
    !isDeepStrictEqual(quality.candidates, expectedRequest.candidates) ||
    !isDeepStrictEqual(quality.dependencies, expectedRequest.dependencies) ||
    !isDeepStrictEqual(quality.relationships, expectedRequest.relationships) ||
    !isDeepStrictEqual(quality.exceptions, expectedRequest.exceptions)
  )
    return false;

  const expectedFactCoverage = snapshotJson(
    {
      source: facts.source.read,
      translations: facts.translations.reads,
      associations: facts.associations.map((association) => ({
        ...association,
        candidateSelected:
          association.sourceKey === candidate.sourceKey &&
          association.language === candidate.language,
      })),
    },
    "QA 事实覆盖",
  );
  if (!isDeepStrictEqual(quality.factCoverage, expectedFactCoverage))
    return false;

  const expectedChecks = configurationRun.checks.map(
    ({ id, configuration }) => ({ id, configuration }),
  );
  const actualChecks = quality.checks.map(({ id, configuration }) => ({
    id,
    configuration,
  }));
  return isDeepStrictEqual(actualChecks, expectedChecks);
}

function defaultQualityRequest<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  facts: FrameworkFacts<TUnit, TTranslation, TBody, TUnavailable>,
): QualityCheckRequest<TBody> {
  return {
    candidates: facts.associations.flatMap((association) => {
      if (association.status !== "matched") return [];
      const record =
        facts.translations.records[association.translationIndexes[0] as number];
      return record === undefined || record.bodyAvailability !== "available"
        ? []
        : [
            {
              sourceKey: association.sourceKey,
              language: association.language,
              content: record.content,
            },
          ];
    }),
    dependencies: {},
  };
}

function configuredQualityChecks<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  config: FrameworkConfig<TUnit, TTranslation, TBody, TUnavailable>,
): readonly QualityCheckDefinition<
  TUnit,
  TTranslation,
  QualityObject,
  TBody,
  TUnavailable
>[] {
  const checks = config.qualityChecks;
  if (checks === undefined) return [];
  if (!Array.isArray(checks))
    throw new TypeError("defineConfig 的 qualityChecks 必须是检查器数组。");
  return checks;
}

async function createConfiguredQualityRequest<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  config: FrameworkConfig<TUnit, TTranslation, TBody, TUnavailable>,
  facts: FrameworkFacts<TUnit, TTranslation, TBody, TUnavailable>,
): Promise<QualityCheckRequest<TBody>> {
  const request = config.createQualityRequest;
  if (request === undefined) return defaultQualityRequest(facts);
  if (typeof request !== "function")
    throw new TypeError("defineConfig 的 createQualityRequest 必须是函数。");
  return await request(facts);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStandardSchema(value: unknown): value is StandardSchemaV1 {
  if (!isRecord(value) || !isRecord(value["~standard"])) return false;
  const standard = value["~standard"];
  return (
    standard.version === 1 &&
    typeof standard.vendor === "string" &&
    typeof standard.validate === "function"
  );
}

function validateSourceRead(value: unknown): void {
  if (!isRecord(value) || !Array.isArray(value.scopes))
    invalidReadStructure(
      "source.read",
      "source.read 必须返回包含 scopes 数组的读取结果。",
    );

  for (const [scopeIndex, scope] of value.scopes.entries()) {
    if (
      !isRecord(scope) ||
      !Array.isArray(scope.records) ||
      (scope.enumeration !== "complete" &&
        scope.enumeration !== "partial" &&
        scope.enumeration !== "failed") ||
      (scope.error !== undefined && typeof scope.error !== "string")
    )
      invalidReadStructure(
        "source.read",
        `source.read 的第 ${scopeIndex + 1} 个范围结构无效。`,
      );
    assertJsonValue(scope.range, `原文范围 ${scopeIndex + 1}`);
    for (const [recordIndex, record] of scope.records.entries()) {
      if (
        !isRecord(record) ||
        (record.bodyAvailability !== "available" &&
          record.bodyAvailability !== "unavailable")
      )
        invalidReadStructure(
          "source.read",
          `source.read 的第 ${scopeIndex + 1} 个范围中，第 ${recordIndex + 1} 条原文记录结构无效。`,
        );
    }
  }
}

function validateTranslationRead(value: unknown): void {
  if (!isRecord(value) || !Array.isArray(value.scopes))
    invalidReadStructure(
      "translations.read",
      "translations.read 必须返回包含 scopes 数组的读取结果。",
    );

  for (const [scopeIndex, scope] of value.scopes.entries()) {
    if (
      !isRecord(scope) ||
      !Array.isArray(scope.records) ||
      !Array.isArray(scope.covers) ||
      scope.covers.some((key) => typeof key !== "string") ||
      (scope.enumeration !== "complete" &&
        scope.enumeration !== "partial" &&
        scope.enumeration !== "failed") ||
      (scope.error !== undefined && typeof scope.error !== "string")
    )
      invalidReadStructure(
        "translations.read",
        `translations.read 的第 ${scopeIndex + 1} 个范围结构无效。`,
      );
    assertJsonValue(scope.range, `译文范围 ${scopeIndex + 1}`);
    for (const [recordIndex, record] of scope.records.entries()) {
      if (
        !isRecord(record) ||
        (record.bodyAvailability !== "available" &&
          record.bodyAvailability !== "unavailable")
      )
        invalidReadStructure(
          "translations.read",
          `translations.read 的第 ${scopeIndex + 1} 个范围中，第 ${recordIndex + 1} 条译文记录结构无效。`,
        );
    }
  }
}

function invalidReadStructure(
  adapter: "source.read" | "translations.read",
  message: string,
): never {
  throw new StandardSchemaContractError(adapter, "schema-mismatch", message);
}

function snapshotJson(value: unknown, description: string): JsonValue {
  return snapshotJsonValue(value, description);
}

function readStatus(
  scopes: readonly {
    readonly enumeration: EnumerationCompleteness;
  }[],
  errorMessage?: string,
): CoverageStatus {
  if (
    errorMessage !== undefined ||
    scopes.some(({ enumeration }) => enumeration === "failed")
  )
    return "failed";
  if (scopes.length === 0) return "notRead";
  return scopes.every(({ enumeration }) => enumeration === "complete")
    ? "complete"
    : "incomplete";
}

function readTranslationIdentity(
  value: unknown,
  language: string,
): TranslationIdentity {
  if (
    !isRecord(value) ||
    typeof value.namespace !== "string" ||
    value.namespace.trim().length === 0 ||
    typeof value.key !== "string" ||
    value.key.trim().length === 0
  )
    throw new TranslationIdentityContractError("missing");
  return { language, namespace: value.namespace, key: value.key };
}

function assertUniqueTranslationIdentity(
  identity: TranslationIdentity,
  firstIndexes: Map<string, number>,
  duplicateIndex: number,
): void {
  const serialized = JSON.stringify(identity);
  const firstIndex = firstIndexes.get(serialized);
  if (firstIndex !== undefined)
    throw new TranslationIdentityContractError("duplicate", {
      identity,
      firstIndex,
      duplicateIndex,
    });
  firstIndexes.set(serialized, duplicateIndex);
}

function comparisonSnapshotVersion<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(snapshot: {
  readonly source: SourceFacts<TUnit>;
  readonly translations: {
    readonly reads: readonly TranslationReadFact[];
    readonly records: readonly ActualTranslationFact<
      TTranslation,
      TBody,
      TUnavailable
    >[];
  };
}): string {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(snapshot);
  } catch (error) {
    throw new TypeError("比较快照及读取依据必须可序列化为 JSON。", {
      cause: error,
    });
  }
  if (serialized === undefined)
    throw new TypeError("比较快照及读取依据必须可序列化为 JSON。");
  return `sha256:${createHash("sha256").update(serialized).digest("hex")}`;
}

function sourceFactsVersion<TUnit extends TranslationUnitInput>(facts: {
  readonly read: SourceReadFact;
  readonly units: readonly SourceUnitFact<TUnit>[];
}): string {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(facts);
  } catch (error) {
    throw new TypeError("原文事实及读取依据必须可序列化为 JSON。", {
      cause: error,
    });
  }
  if (serialized === undefined)
    throw new TypeError("原文事实及读取依据必须可序列化为 JSON。");
  return `sha256:${createHash("sha256").update(serialized).digest("hex")}`;
}

function factsVersion<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(facts: {
  readonly source: SourceFacts<TUnit>;
  readonly translations: {
    readonly reads: readonly TranslationReadFact[];
    readonly records: readonly ActualTranslationFact<
      TTranslation,
      TBody,
      TUnavailable
    >[];
  };
  readonly associations: readonly TranslationAssociationFact[];
}): string {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(facts);
  } catch (error) {
    throw new TypeError("源译事实及读取依据必须可序列化为 JSON。", {
      cause: error,
    });
  }
  if (serialized === undefined)
    throw new TypeError("源译事实及读取依据必须可序列化为 JSON。");
  return `sha256:${createHash("sha256").update(serialized).digest("hex")}`;
}
