import { createHash } from "node:crypto";

import {
  CompletionConfigurationError,
  evaluateCompletion,
} from "./completion.ts";
import type { CompletionFacts, CompletionPolicy } from "./completion.ts";
import type { SemanticEditAdapter } from "./edits.ts";
import type { UpdatePolicy } from "./plans.ts";
import type { QualityCheckDefinition, QualityCheckRequest } from "./qa.ts";

export * from "./completion.ts";
export * from "./edits.ts";
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
  readonly edits?: SemanticEditAdapter<TUnit, TTranslation>;
  readonly updatePolicy?: UpdatePolicy<TUnit, TTranslation>;
  readonly qualityChecks?: readonly QualityCheckDefinition<
    TUnit,
    TTranslation
  >[];
  readonly qualityRequest?: (
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

export async function readSourceFacts<
  TUnit extends TranslationUnitInput,
  TTranslation,
>(config: FrameworkConfig<TUnit, TTranslation>): Promise<SourceFacts<TUnit>> {
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
  const policy = config.completion;
  if (policy === undefined)
    throw new CompletionConfigurationError("missingPolicy");
  if (config.translations === undefined)
    throw new CompletionConfigurationError("missingTranslations");

  const facts = await readFacts(config);
  const completion = await evaluateCompletion(facts, policy);
  return { ...facts, completion };
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
