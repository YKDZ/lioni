import { createHash } from "node:crypto";

import type { MemoScope } from "@lioni/memo";

import type { Compare } from "./comparison.ts";
import {
  CompletionConfigurationError,
  evaluateCompletion,
} from "./completion.ts";
import type { CompletionFacts, CompletionPolicy } from "./completion.ts";
import type { UpdatePolicy } from "./plans.ts";
import {
  runQualityChecks,
  type QualityCheckDefinition,
  type QualityCheckRequest,
  type QualityRunResult,
  type QualityObject,
} from "./qa.ts";
import type { QualityCheckResultCache } from "./quality-cache.ts";
import { validateQualityExceptions } from "./quality-exceptions.ts";
import type {
  QualityException,
  QualityExceptionStore,
} from "./quality-exceptions.ts";
import { validateSemanticEditCandidate } from "./semantic-edits.ts";
import type {
  JsonValue,
  SemanticEditCandidate,
  TranslationWritebackAdapter,
} from "./semantic-edits.ts";
import {
  assertJsonValue,
  StandardSchemaContractError,
  validateWithStandardSchema,
} from "./standard-schema.ts";
import type {
  PreservingStandardSchema,
  StandardSchemaV1,
  StandardSchemaTypes,
} from "./standard-schema.ts";
import { readTranslationFacts } from "./translation-snapshot.ts";

export {
  CompletionConfigurationError,
  evaluateCompletion,
} from "./completion.ts";
export type {
  CompletionResolution,
  CompletionResolverInput,
  ResolveCompletion,
  CompletionPolicy,
  CompletionStatus,
  CompletionObligationFact,
  CompletionReport,
  CompletionFacts,
  CompletionConfigurationErrorReason,
} from "./completion.ts";
export {
  validateSemanticEditCandidate,
  validateTranslationWriteRequest,
  writeTranslationRequests,
} from "./semantic-edits.ts";
export type {
  JsonValue,
  SemanticEditCandidate,
  TranslationWriteTarget,
  TranslationWriteSourceExpectation,
  TranslationWriteTargetExpectation,
  TranslationWriteRequest,
  TranslationWritebackTarget,
  TranslationWritebackResolution,
  TranslationWritebackAdapter,
  TranslationWriteConditionInput,
  TranslationWriteConditionResult,
  TranslationWriteCondition,
  TranslationWriteStatus,
  TranslationWriteResult,
  TranslationWriteBatchResult,
} from "./semantic-edits.ts";
export { StandardSchemaContractError } from "./standard-schema.ts";
export { TranslationIdentityContractError } from "./translation-snapshot.ts";
export type {
  StandardSchemaFailureKind,
  StandardSchemaV1,
  StandardSchemaV1Issue,
  StandardSchemaV1Result,
} from "./standard-schema.ts";
export {
  createQualityException,
  evaluateQualityExceptionApplicability,
  qualityExceptionMatchesExecution,
  upsertQualityExceptionFromReport,
  QualityExceptionFormatError,
  validateQualityException,
  validateQualityExceptionFile,
  validateQualityExceptions,
} from "./quality-exceptions.ts";
export type {
  CreateQualityExceptionInput,
  QualityException,
  QualityExceptionApplicability,
  QualityExceptionChangeReason,
  QualityExceptionExecution,
  QualityExceptionFile,
  QualityExceptionFingerprintSummary,
  QualityExceptionFormatErrorReason,
  QualityExceptionNotVerifiedReason,
  QualityExceptionStore,
  UpsertQualityExceptionFromReportInput,
} from "./quality-exceptions.ts";
export {
  QualityCheckBindingError,
  createDefaultQualityInputBasis,
  defineQualityCheck,
  bindQualityCheck,
  runQualityChecks,
} from "./qa.ts";
export type {
  QualityCheckStatus,
  QualityObject,
  QualityLocation,
  QualitySubject,
  QualityRelationship,
  QualityDiagnosticHandling,
  QualityEvidence,
  QualityDiagnostic,
  QualityFinding,
  QualityIssue,
  QualityCoverage,
  QualityCheckOutcome,
  QualityInputBasis,
  QualityDefaultInput,
  QualityInputFingerprintSummary,
  QualityCheckExecution,
  QualityCheckRequest,
  QualityCheckInput,
  QualityCheckSelection,
  QualityCheckProjection,
  QualityCheckProjectionInput,
  QualityCheckRuleInput,
  QualityCheckBindingStage,
  StandardSchemaInput,
  StandardSchemaOutput,
  QualityCheckDefinition,
  QualityCheckBinding,
  QualityCheckResult,
  QualityFactCoverage,
  QualityRunResult,
  QualityExecutionOptions,
} from "./qa.ts";
export type {
  CacheableQualityCheckOutcome,
  QualityCheckResultCache,
} from "./quality-cache.ts";
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
  ComparisonBaselineFormatError,
  ComparisonBaselineIncompleteSnapshotError,
  recordComparisonBaseline,
  replaceComparisonBaseline,
  validateComparisonBaseline,
} from "./baselines.ts";
export type {
  ComparisonBaseline,
  ComparisonBaselineSelection,
  ComparisonBaselineStore,
  RecordComparisonBaselineResult,
} from "./baselines.ts";

export {
  createUpdatePlan,
  defaultUpdatePolicy,
  previewUpdate,
  validateUpdatePlan,
} from "./plans.ts";
export type {
  UpdatePlan,
  UpdatePlanAction,
  UpdatePlanAssociations,
  UpdatePlanComparisons,
  UpdatePlanData,
  UpdatePlanInput,
  UpdatePlanItem,
  UpdatePlanSourceChange,
  UpdatePlanTranslationChange,
  UpdatePlanWriteRequest,
  UpdatePolicy,
  UpdateSourceExpectation,
  UpdateTargetExpectation,
} from "./plans.ts";
export { applyUpdatePlan, update } from "./apply-plans.ts";
export type {
  UpdatePlanApplyResult,
  UpdatePlanExecutionItemResult,
  UpdatePlanExecutionStatus,
  UpdateResult,
} from "./apply-plans.ts";

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
  /** 将宿主原文正文映射为目标语言中的待译占位正文。 */
  readonly sourceToContent?: (
    source: NoInfer<TUnit["source"]>,
  ) => NoInfer<TBody>;
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
  readonly qualityCheckResultCache?: QualityCheckResultCache;
  readonly qualityExceptionStore?: QualityExceptionStore;
  readonly createQualityRequest?: (
    facts: FrameworkFacts<TUnit, TTranslation, TBody, TUnavailable>,
  ) => Awaitable<Omit<QualityCheckRequest<TBody>, "exceptions">>;
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
  return config;
}

export function validateFrameworkConfig(value: unknown): void {
  validateSourceConfig(value);
}

function validateSourceConfig(value: unknown): void {
  if (!isRecord(value)) invalidFrameworkConfig("宿主配置必须是对象。");
  if (!isRecord(value.source) || typeof value.source.read !== "function")
    invalidFrameworkConfig("defineConfig 的 source.read 必须是函数。");
  if (!isStandardSchema(value.source.schema))
    invalidFrameworkConfig(
      "defineConfig 的 source.schema 必须符合 Standard Schema v1。",
    );
  if (typeof value.keyOf !== "function")
    invalidFrameworkConfig("defineConfig 的 keyOf 必须是函数。");
  if (
    value.qualityCheckResultCache !== undefined &&
    (!isRecord(value.qualityCheckResultCache) ||
      typeof value.qualityCheckResultCache.get !== "function" ||
      typeof value.qualityCheckResultCache.set !== "function")
  )
    invalidFrameworkConfig(
      "defineConfig 的 qualityCheckResultCache 必须提供 get 与 set 函数。",
    );
  if (
    value.qualityExceptionStore !== undefined &&
    (!isRecord(value.qualityExceptionStore) ||
      typeof value.qualityExceptionStore.load !== "function" ||
      typeof value.qualityExceptionStore.upsert !== "function")
  )
    invalidFrameworkConfig(
      "defineConfig 的 qualityExceptionStore 必须提供 load 与 upsert 函数。",
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
  const translations = await readTranslationFacts(
    config.translations,
    source.units,
  );

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
  validateFrameworkConfig(config);
  const exceptions = await loadQualityExceptions(config);
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
  return runQualityChecks(
    facts,
    { ...request, candidates, exceptions },
    checks,
    {
      ...options,
      ...(config.qualityCheckResultCache === undefined
        ? {}
        : { qualityCheckResultCache: config.qualityCheckResultCache }),
    },
  );
}

async function loadQualityExceptions<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  config: FrameworkConfig<TUnit, TTranslation, TBody, TUnavailable>,
): Promise<readonly QualityException[]> {
  const store = config.qualityExceptionStore;
  if (store === undefined) return [];
  const exceptions: unknown = await store.load();
  validateQualityExceptions(exceptions);
  return exceptions;
}

function defaultQualityRequest<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  facts: FrameworkFacts<TUnit, TTranslation, TBody, TUnavailable>,
): Omit<QualityCheckRequest<TBody>, "exceptions"> {
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
): Promise<Omit<QualityCheckRequest<TBody>, "exceptions">> {
  const request = config.createQualityRequest;
  if (request === undefined) return defaultQualityRequest(facts);
  if (typeof request !== "function")
    throw new TypeError("defineConfig 的 createQualityRequest 必须是函数。");
  const configured = await request(facts);
  if (isRecord(configured) && Object.hasOwn(configured, "exceptions"))
    throw new TypeError(
      "defineConfig 的 createQualityRequest 不再接受 exceptions；请通过 qualityExceptionStore 配置例外来源。",
    );
  return configured;
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
    invalidReadStructure("source.read 必须返回包含 scopes 数组的读取结果。");

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
          `source.read 的第 ${scopeIndex + 1} 个范围中，第 ${recordIndex + 1} 条原文记录结构无效。`,
        );
    }
  }
}

function invalidReadStructure(message: string): never {
  throw new StandardSchemaContractError(
    "source.read",
    "schema-mismatch",
    message,
  );
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
