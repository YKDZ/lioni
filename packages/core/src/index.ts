import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

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
} from "./qa.ts";
import {
  prepareSemanticEdit,
  resolveSemanticEditInput,
  type SemanticEditPreparation,
} from "./semantic-edits.ts";
import type {
  JsonValue,
  SemanticEditCandidate,
  TranslationWritebackAdapter,
} from "./semantic-edits.ts";

export * from "./completion.ts";
export * from "./semantic-edits.ts";
export * from "./apply-plans.ts";
export * from "./plans.ts";
export * from "./qa.ts";
export {
  advanceProcessingBaseline,
  compareProcessingBaseline,
  type ProcessingBaseline,
  type ProcessingBaselineAdvanceOptions,
  type ProcessingBaselineAdvanceResult,
  type ProcessingBaselineChange,
  type ProcessingBaselineCompareOptions,
  type ProcessingBaselineEntry,
  type ProcessingBaselineMatch,
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

export type ReadRecord<TValue> = {
  readonly value: TValue;
  readonly bodyAvailability: BodyAvailability;
};

export type ReadScope<TValue> = {
  readonly range: unknown;
  readonly enumeration: EnumerationCompleteness;
  readonly records: readonly ReadRecord<TValue>[];
  readonly error?: string;
};

export type SourceRead<TUnit extends TranslationUnitInput> = {
  readonly scopes: readonly ReadScope<TUnit>[];
};

export type SourceAdapter<TUnit extends TranslationUnitInput> = {
  read(): Awaitable<SourceRead<TUnit>>;
};

export type TranslationReadScope<TTranslation> = ReadScope<TTranslation> & {
  readonly covers: readonly string[];
};

export type TranslationRead<TTranslation> = {
  readonly scopes: readonly TranslationReadScope<TTranslation>[];
};

export type TranslationAdapter<
  TUnit extends TranslationUnitInput,
  TTranslation,
> = {
  readonly languages: readonly string[];
  readonly contentOf: (translation: TTranslation) => JsonValue;
  read(
    language: string,
    sourceUnits: readonly SourceUnitFact<TUnit>[],
  ): Awaitable<TranslationRead<TTranslation>>;
  matches: (unit: TUnit, translation: TTranslation) => boolean;
};

export type FrameworkConfig<
  TUnit extends TranslationUnitInput,
  TTranslation = unknown,
> = {
  readonly source: SourceAdapter<TUnit>;
  readonly keyOf: (unit: TUnit) => string;
  readonly translations?: TranslationAdapter<TUnit, TTranslation>;
  readonly completion?: CompletionPolicy<TUnit, TTranslation>;
  readonly translationWriteback?: TranslationWritebackAdapter<
    TUnit,
    TTranslation
  >;
  readonly updatePolicy?: UpdatePolicy<TUnit, TTranslation>;
  readonly qualityChecks?: readonly QualityCheckDefinition<
    TUnit,
    TTranslation
  >[];
  readonly createQualityRequest?: (
    facts: FrameworkFacts<TUnit, TTranslation>,
  ) => Awaitable<QualityCheckRequest>;
};

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

export type ActualTranslationFact<TTranslation> = {
  readonly index: number;
  readonly language: string;
  readonly scopeIndex: number;
  readonly range: unknown;
  readonly translation: TTranslation;
  readonly content: JsonValue;
  readonly bodyAvailability: BodyAvailability;
};

export type TranslationAssociationFact = {
  readonly sourceKey: string;
  readonly language: string;
  readonly status: TranslationAssociationStatus;
  readonly coverageStatus: CoverageStatus;
  readonly scopeIndexes: readonly number[];
  readonly translationIndexes: readonly number[];
};

export type FrameworkFacts<TUnit extends TranslationUnitInput, TTranslation> = {
  readonly version: string;
  readonly source: SourceFacts<TUnit>;
  readonly translations: {
    readonly reads: readonly TranslationReadFact[];
    readonly records: readonly ActualTranslationFact<TTranslation>[];
  };
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

export function defineConfig<TUnit extends TranslationUnitInput, TTranslation>(
  config: FrameworkConfig<TUnit, TTranslation>,
): FrameworkConfig<TUnit, TTranslation> {
  return config;
}

export function validateFrameworkConfig(value: unknown): void {
  if (!isRecord(value))
    throw new TypeError("宿主配置必须是 defineConfig(...) 的对象结果。");
  if (!isRecord(value.source) || typeof value.source.read !== "function")
    throw new TypeError("defineConfig 的 source.read 必须是函数。");
  if (typeof value.keyOf !== "function")
    throw new TypeError("defineConfig 的 keyOf 必须是函数。");

  const translations = value.translations;
  if (translations === undefined) return;
  if (
    !isRecord(translations) ||
    !Array.isArray(translations.languages) ||
    translations.languages.some((language) => typeof language !== "string") ||
    typeof translations.read !== "function" ||
    typeof translations.matches !== "function" ||
    typeof translations.contentOf !== "function"
  )
    throw new TypeError(
      "defineConfig 的 translations 必须提供语言列表、read、matches 与 contentOf 函数。",
    );
}

export async function readSourceFacts<
  TUnit extends TranslationUnitInput,
  TTranslation,
>(config: FrameworkConfig<TUnit, TTranslation>): Promise<SourceFacts<TUnit>> {
  validateFrameworkConfig(config);
  let read: SourceRead<TUnit> | undefined;
  let errorMessage: string | undefined;
  try {
    read = await config.source.read();
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : String(error);
  }

  const firstIndexes = new Map<string, number>();
  const units: SourceUnitFact<TUnit>[] = [];
  const scopes = read?.scopes ?? [];
  for (const [scopeIndex, scope] of scopes.entries()) {
    for (const record of scope.records) {
      const index = units.length;
      const key = config.keyOf(record.value);
      const firstIndex = firstIndexes.get(key);
      if (firstIndex !== undefined)
        throw new DuplicateTranslationUnitKeyError(key, firstIndex, index);
      firstIndexes.set(key, index);
      units.push({
        key,
        unit: record.value,
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

export async function readFacts<
  TUnit extends TranslationUnitInput,
  TTranslation,
>(
  config: FrameworkConfig<TUnit, TTranslation>,
): Promise<FrameworkFacts<TUnit, TTranslation>> {
  validateFrameworkConfig(config);
  const source = await readSourceFacts(config);
  const translationAdapter = config.translations;
  const translations = {
    reads: [] as TranslationReadFact[],
    records: [] as ActualTranslationFact<TTranslation>[],
  };

  if (translationAdapter !== undefined) {
    for (const language of translationAdapter.languages) {
      let read: TranslationRead<TTranslation> | undefined;
      let errorMessage: string | undefined;
      try {
        read = await translationAdapter.read(language, source.units);
      } catch (error) {
        errorMessage = error instanceof Error ? error.message : String(error);
      }

      const scopes: TranslationReadScopeFact[] = [];
      for (const [scopeIndex, scope] of (read?.scopes ?? []).entries()) {
        const translationIndexes: number[] = [];
        for (const record of scope.records) {
          const index = translations.records.length;
          translationIndexes.push(index);
          translations.records.push({
            index,
            language,
            scopeIndex,
            range: scope.range,
            translation: record.value,
            content:
              record.bodyAvailability === "available"
                ? snapshotJson(
                    translationAdapter.contentOf(record.value),
                    "译文业务内容",
                  )
                : null,
            bodyAvailability: record.bodyAvailability,
          });
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

  const associations: TranslationAssociationFact[] = [];
  for (const languageRead of translations.reads) {
    const languageRecords = translations.records.filter(
      ({ language }) => language === languageRead.language,
    );
    for (const sourceUnit of source.units) {
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
        .filter(
          ({ translation }) =>
            translationAdapter?.matches(sourceUnit.unit, translation) ?? false,
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
              : translations.records[translationIndexes[0] as number]
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

  const version = factsVersion({ source, translations, associations });
  return { version, source, translations, associations };
}

export async function readCompletion<
  TUnit extends TranslationUnitInput,
  TTranslation,
>(
  config: FrameworkConfig<TUnit, TTranslation>,
): Promise<CompletionFacts<TUnit, TTranslation>> {
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
>(
  config: FrameworkConfig<TUnit, TTranslation>,
  options: { readonly candidates?: readonly SemanticEditCandidate[] } = {},
): Promise<QualityRunResult> {
  const facts = await readFacts(config);
  const checks = configuredQualityChecks(config);
  const configuredRequest = await createConfiguredQualityRequest(config, facts);
  const request =
    options.candidates === undefined
      ? configuredRequest
      : { ...configuredRequest, candidates: options.candidates };
  return runQualityChecks(facts, request, checks);
}

export type QualityWriteCondition = (
  quality: QualityRunResult,
) => Awaitable<boolean>;

export type PrepareQualityConditionedSemanticEditOptions = {
  readonly candidate: SemanticEditCandidate;
  readonly condition?: QualityWriteCondition;
  readonly quality?: QualityRunResult;
};

export type QualityConditionedSemanticEditResult =
  | {
      readonly status: "not-required";
      readonly preparation: SemanticEditPreparation;
    }
  | {
      readonly status: "passed";
      readonly quality: QualityRunResult;
      readonly preparation: SemanticEditPreparation;
    }
  | {
      readonly status: "rejected";
      readonly quality: QualityRunResult;
    }
  | {
      readonly status: "input-mismatch";
      readonly reason: string;
    };

/**
 * Uses a host-selected QA condition to gate preparation of one semantic edit.
 * Without a condition, quality checks are not required and the candidate follows
 * the ordinary semantic-edit preparation path.
 */
export async function prepareQualityConditionedSemanticEdit<
  TUnit extends TranslationUnitInput,
  TTranslation,
>(
  config: FrameworkConfig<TUnit, TTranslation>,
  options: PrepareQualityConditionedSemanticEditOptions,
): Promise<QualityConditionedSemanticEditResult> {
  const facts = await readFacts(config);
  const { candidate, condition } = options;
  if (condition === undefined)
    return {
      status: "not-required",
      preparation: await prepareCandidateEdit(facts, candidate, config),
    };

  const checks = configuredQualityChecks(config);
  const configuredRequest = await createConfiguredQualityRequest(config, facts);
  const request = { ...configuredRequest, candidates: [candidate] };
  const quality =
    options.quality ?? (await runQualityChecks(facts, request, checks));
  if (
    options.quality !== undefined &&
    !qualityRunMatchesInputs(
      facts,
      candidate,
      configuredRequest,
      checks,
      quality,
    )
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
>(
  facts: FrameworkFacts<TUnit, TTranslation>,
  candidate: SemanticEditCandidate,
  config: FrameworkConfig<TUnit, TTranslation>,
): Promise<SemanticEditPreparation> {
  const resolved = await resolveSemanticEditInput(
    facts,
    { sourceKey: candidate.sourceKey, language: candidate.language },
    config,
  );
  return resolved.status === "resolved"
    ? prepareSemanticEdit(resolved.input, candidate)
    : resolved;
}

function qualityRunMatchesInputs<
  TUnit extends TranslationUnitInput,
  TTranslation,
>(
  facts: FrameworkFacts<TUnit, TTranslation>,
  candidate: SemanticEditCandidate,
  request: QualityCheckRequest,
  checks: readonly QualityCheckDefinition<TUnit, TTranslation>[],
  quality: QualityRunResult,
): boolean {
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
    QualityRunResult,
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

  const expectedChecks = checks.map(({ id, configuration }) => ({
    id,
    configuration: snapshotConfigurationOrNull(configuration),
  }));
  const actualChecks = quality.checks.map(({ id, configuration }) => ({
    id,
    configuration,
  }));
  return isDeepStrictEqual(actualChecks, expectedChecks);
}

function snapshotConfigurationOrNull(value: unknown): unknown {
  try {
    return snapshotJson(value, "QA 检查配置");
  } catch {
    return null;
  }
}

function defaultQualityRequest<
  TUnit extends TranslationUnitInput,
  TTranslation,
>(facts: FrameworkFacts<TUnit, TTranslation>): QualityCheckRequest {
  return {
    candidates: facts.associations.flatMap((association) => {
      if (association.status !== "matched") return [];
      const record =
        facts.translations.records[association.translationIndexes[0] as number];
      return record === undefined
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
>(
  config: FrameworkConfig<TUnit, TTranslation>,
): readonly QualityCheckDefinition<TUnit, TTranslation>[] {
  const checks = config.qualityChecks;
  if (checks === undefined) return [];
  if (!Array.isArray(checks))
    throw new TypeError("defineConfig 的 qualityChecks 必须是检查器数组。");
  return checks;
}

async function createConfiguredQualityRequest<
  TUnit extends TranslationUnitInput,
  TTranslation,
>(
  config: FrameworkConfig<TUnit, TTranslation>,
  facts: FrameworkFacts<TUnit, TTranslation>,
): Promise<QualityCheckRequest> {
  const request = config.createQualityRequest;
  if (request === undefined) return defaultQualityRequest(facts);
  if (typeof request !== "function")
    throw new TypeError("defineConfig 的 createQualityRequest 必须是函数。");
  return await request(facts);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function snapshotJson(value: unknown, description: string): JsonValue {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new TypeError(`${description}必须可序列化为 JSON。`, {
      cause: error,
    });
  }
  if (serialized === undefined)
    throw new TypeError(`${description}必须可序列化为 JSON。`);
  return JSON.parse(serialized) as JsonValue;
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

function factsVersion<TUnit extends TranslationUnitInput, TTranslation>(facts: {
  readonly source: SourceFacts<TUnit>;
  readonly translations: {
    readonly reads: readonly TranslationReadFact[];
    readonly records: readonly ActualTranslationFact<TTranslation>[];
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
