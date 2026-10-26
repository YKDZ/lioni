import type {
  ActualTranslationFact,
  CoverageStatus,
  EnumerationCompleteness,
  SourceUnitFact,
  StandardSchemaV1,
  TranslationAdapter,
  TranslationIdentity,
  TranslationRead,
  TranslationReadFact,
  TranslationReadScopeFact,
  TranslationUnitInput,
} from "./index.ts";
import {
  assertJsonValue,
  StandardSchemaContractError,
  validateWithStandardSchema,
} from "./standard-schema.ts";

export type TranslationFactsSnapshot<
  TTranslation,
  TBody,
  TUnavailable,
> = {
  readonly reads: readonly TranslationReadFact[];
  readonly records: readonly ActualTranslationFact<
    TTranslation,
    TBody,
    TUnavailable
  >[];
};

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

export function validateTranslationAdapterConfig(
  translations: unknown,
): void {
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
    throw new StandardSchemaContractError(
      "defineConfig 配置",
      "schema-mismatch",
      "defineConfig 的 translations 必须提供语言列表、记录与正文 schema、identityOf、read 与 contentOf 函数；matches 可按需提供。",
    );
}

/** 按给定原文单元读取并验证译文；空集合可用于独立目标身份操作。 */
export async function readTranslationFacts<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  adapter: TranslationAdapter<TUnit, TTranslation, TBody, TUnavailable> | undefined,
  sourceUnits: readonly SourceUnitFact<TUnit>[],
): Promise<TranslationFactsSnapshot<TTranslation, TBody, TUnavailable>> {
  const translations = {
    reads: [] as TranslationReadFact[],
    records: [] as ActualTranslationFact<TTranslation, TBody, TUnavailable>[],
  };
  if (adapter === undefined) return translations;
  validateTranslationAdapterConfig(adapter);

  const firstTranslationIndexes = new Map<string, number>();
  for (const language of adapter.languages) {
    let read: TranslationRead<TTranslation, TUnavailable> | undefined;
    let errorMessage: string | undefined;
    try {
      read = await adapter.read(language, sourceUnits);
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
            adapter.schema,
            record.value,
            `译文记录 ${index + 1}`,
            { preserveValue: true, requireJson: true },
          );
          const identity = readTranslationIdentity(
            adapter.identityOf(translation, language),
            language,
          );
          assertUniqueTranslationIdentity(
            identity,
            firstTranslationIndexes,
            index,
          );
          const content = await validateWithStandardSchema(
            adapter.contentSchema,
            adapter.contentOf(translation),
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
          const schema = adapter.unavailableSchema;
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
            adapter.identityOf(translation, language),
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
  return translations;
}

function validateTranslationRead(value: unknown): void {
  if (!isRecord(value) || !Array.isArray(value.scopes))
    invalidTranslationRead("translations.read 必须返回包含 scopes 数组的读取结果。");
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
      invalidTranslationRead(
        `translations.read 的第 ${scopeIndex + 1} 个范围结构无效。`,
      );
    assertJsonValue(scope.range, `译文范围 ${scopeIndex + 1}`);
    for (const [recordIndex, record] of scope.records.entries()) {
      if (
        !isRecord(record) ||
        (record.bodyAvailability !== "available" &&
          record.bodyAvailability !== "unavailable")
      )
        invalidTranslationRead(
          `translations.read 的第 ${scopeIndex + 1} 个范围中，第 ${recordIndex + 1} 条译文记录结构无效。`,
        );
    }
  }
}

function invalidTranslationRead(message: string): never {
  throw new StandardSchemaContractError(
    "translations.read",
    "schema-mismatch",
    message,
  );
}

function readStatus(
  scopes: readonly { readonly enumeration: EnumerationCompleteness }[],
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
