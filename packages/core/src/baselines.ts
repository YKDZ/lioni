import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import type {
  ActualTranslationFact,
  ComparisonSnapshot,
  CoverageStatus,
  EnumerationCompleteness,
  FrameworkConfig,
  SourceFacts,
  SourceReadFact,
  TranslationReadFact,
  TranslationReadScopeFact,
  TranslationUnitInput,
} from "./index.ts";
import { readComparisonSnapshot } from "./index.ts";
import type { JsonValue } from "./semantic-edits.ts";
import { assertJsonValue } from "./standard-schema.ts";

const COMPARISON_BASELINE_FORMAT = "lioni.comparison-baseline/v1" as const;

export type ComparisonBaseline<
  TUnit extends TranslationUnitInput = TranslationUnitInput,
  TTranslation = unknown,
  TBody = JsonValue,
  TUnavailable = never,
> = {
  readonly format: typeof COMPARISON_BASELINE_FORMAT;
  readonly snapshot: ComparisonSnapshot<
    TUnit,
    TTranslation,
    TBody,
    TUnavailable
  >;
};

export type ComparisonBaselineStore<
  TUnit extends TranslationUnitInput = TranslationUnitInput,
  TTranslation = unknown,
  TBody = JsonValue,
  TUnavailable = never,
> = {
  load(): Promise<
    ComparisonBaseline<TUnit, TTranslation, TBody, TUnavailable> | undefined
  >;
  save(
    baseline: ComparisonBaseline<TUnit, TTranslation, TBody, TUnavailable>,
  ): Promise<void>;
};

export type ComparisonBaselineSelection = {
  readonly sourceRanges: readonly unknown[];
  readonly translationRanges: readonly {
    readonly language: string;
    readonly range: unknown;
  }[];
};

export type RecordComparisonBaselineResult<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody = JsonValue,
  TUnavailable = never,
> = {
  readonly outcome: "saved" | "unchanged";
  readonly baseline: ComparisonBaseline<
    TUnit,
    TTranslation,
    TBody,
    TUnavailable
  >;
};

export class ComparisonBaselineFormatError extends TypeError {
  readonly reason: "unsupported" | "invalid";

  constructor(reason: "unsupported" | "invalid", message: string) {
    super(message);
    this.name = "ComparisonBaselineFormatError";
    this.reason = reason;
  }
}

export class ComparisonBaselineIncompleteSnapshotError extends Error {
  readonly language?: string;

  constructor(message: string, language?: string) {
    super(message);
    this.name = "ComparisonBaselineIncompleteSnapshotError";
    if (language !== undefined) this.language = language;
  }
}

/**
 * 替换明确选择的快照范围并保留其余历史。未提供选择时，采用当前快照中观察到的全部范围。
 */
export function replaceComparisonBaseline<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody = JsonValue,
  TUnavailable = never,
>(options: {
  readonly previous?: ComparisonBaseline<
    TUnit,
    TTranslation,
    TBody,
    TUnavailable
  >;
  readonly current: ComparisonSnapshot<
    TUnit,
    TTranslation,
    TBody,
    TUnavailable
  >;
  readonly selection?: ComparisonBaselineSelection;
}): ComparisonBaseline<TUnit, TTranslation, TBody, TUnavailable> {
  const previous = options.previous;
  const current = options.current;
  if (previous !== undefined) validateComparisonBaseline(previous as unknown);
  validateSnapshot(current as unknown);

  const sourceRanges =
    options.selection?.sourceRanges ??
    (options.selection === undefined
      ? current.source.read.scopes.map(({ range }) => range)
      : []);
  const translationRanges =
    options.selection?.translationRanges ??
    (options.selection === undefined
      ? current.translations.reads.flatMap(({ language, scopes }) =>
          scopes.map(({ range }) => ({ language, range })),
        )
      : []);

  const selectedSourceIndexes = selectScopeIndexes(
    current.source.read.scopes,
    sourceRanges,
    "原文",
  );
  const translationIndexesByLanguage = selectTranslationScopeIndexes(
    current.translations.reads,
    translationRanges,
  );

  const sourceEntries = mergeScopeEntries(
    previous?.snapshot.source.read.scopes ?? [],
    current.source.read.scopes,
    selectedSourceIndexes,
  );
  const sourceScopes = sourceEntries.map(({ value }) => ({ ...value }));
  const sourceUnits = sourceEntries.flatMap((entry, scopeIndex) => {
    const snapshot = entry.origin === "current" ? current : previous?.snapshot;
    if (snapshot === undefined) return [];
    return snapshot.source.units
      .filter(({ scopeIndex: oldIndex }) => oldIndex === entry.index)
      .map((unit) => ({ ...unit, scopeIndex }));
  });
  assertUniqueSourceKeys(sourceUnits);

  const previousSourceRead = previous?.snapshot.source.read;
  const sourceError =
    options.selection === undefined
      ? current.source.read.error
      : previousSourceRead?.error;
  const sourceRead = createSourceRead(sourceScopes, sourceError);
  const source = createSourceFacts(sourceRead, sourceUnits);

  const translationReads = mergeTranslationReads<
    TUnit,
    TTranslation,
    TBody,
    TUnavailable
  >({
    previous,
    current,
    selection: options.selection,
    translationRangesByLanguage: translationIndexesByLanguage,
  });
  const translations = createTranslations<
    TUnit,
    TTranslation,
    TBody,
    TUnavailable
  >({
    previous,
    current,
    entries: translationReads,
    selection: translationRanges,
  });
  const snapshot = createSnapshot<TUnit, TTranslation, TBody, TUnavailable>(
    source,
    translations,
  );

  if (previous !== undefined && sameSnapshotFacts(previous.snapshot, snapshot))
    return previous;

  const result: ComparisonBaseline<TUnit, TTranslation, TBody, TUnavailable> = {
    format: COMPARISON_BASELINE_FORMAT,
    snapshot,
  };
  validateComparisonBaseline(result as unknown);
  return result;
}

/** 读取配置的源译事实并显式记录为基线；此入口不计算关联、比较、策略或 QA。 */
export async function recordComparisonBaseline<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  config: FrameworkConfig<TUnit, TTranslation, TBody, TUnavailable>,
  store: ComparisonBaselineStore<TUnit, TTranslation, TBody, TUnavailable>,
): Promise<
  RecordComparisonBaselineResult<TUnit, TTranslation, TBody, TUnavailable>
> {
  const current = await readComparisonSnapshot(config);
  assertCompleteSnapshot(current);
  const previous = await store.load();
  const baseline = replaceComparisonBaseline({
    ...(previous === undefined ? {} : { previous }),
    current,
  });
  if (
    previous !== undefined &&
    stableStringify(previous) === stableStringify(baseline)
  )
    return { outcome: "unchanged", baseline };
  await store.save(baseline);
  return { outcome: "saved", baseline };
}

/** 验证比较基线数据；旧处理基线不会转换为新格式。 */
export function validateComparisonBaseline(
  value: unknown,
): asserts value is ComparisonBaseline {
  if (!isRecord(value))
    throw new ComparisonBaselineFormatError("invalid", "比较基线必须是对象。");
  if (value.formatVersion !== undefined || value.entries !== undefined)
    throw new ComparisonBaselineFormatError(
      "unsupported",
      "该文件使用旧处理基线格式，不适用于比较基线；请删除旧文件后重新记录。",
    );
  if (value.format !== COMPARISON_BASELINE_FORMAT) {
    const format = typeof value.format === "string" ? value.format : "未标识";
    throw new ComparisonBaselineFormatError(
      "unsupported",
      `不支持比较基线格式：${format}。`,
    );
  }
  assertJsonValue(value, "比较基线");
  validateSnapshot(value.snapshot);
}

type ScopeEntry<TScope> = {
  readonly range: unknown;
  readonly value: TScope;
  readonly origin: "previous" | "current";
  readonly index: number;
};

function mergeScopeEntries<TScope extends { readonly range: unknown }>(
  previous: readonly TScope[],
  current: readonly TScope[],
  selectedCurrentIndexes: readonly number[],
): ScopeEntry<TScope>[] {
  const entries: ScopeEntry<TScope>[] = previous.map((value, index) => ({
    range: value.range,
    value,
    origin: "previous",
    index,
  }));
  for (const currentIndex of selectedCurrentIndexes) {
    const value = current[currentIndex];
    if (value === undefined) continue;
    const existingIndex = entries.findIndex(({ range }) =>
      isDeepStrictEqual(range, value.range),
    );
    const entry: ScopeEntry<TScope> = {
      range: value.range,
      value,
      origin: "current",
      index: currentIndex,
    };
    if (existingIndex === -1) entries.push(entry);
    else entries[existingIndex] = entry;
  }
  return entries;
}

function selectScopeIndexes<TScope extends { readonly range: unknown }>(
  scopes: readonly TScope[],
  ranges: readonly unknown[],
  description: string,
): number[] {
  assertDistinctRanges(ranges, `${description}替换范围`);
  return ranges.map((range) => {
    const index = scopes.findIndex((scope) =>
      isDeepStrictEqual(scope.range, range),
    );
    if (index === -1)
      throw new TypeError(
        `所选${description}范围 ${JSON.stringify(range)} 没有对应的本次读取证据。`,
      );
    return index;
  });
}

function selectTranslationScopeIndexes(
  reads: readonly TranslationReadFact[],
  ranges: readonly { readonly language: string; readonly range: unknown }[],
): Map<string, number[]> {
  const indexes = new Map<string, number[]>();
  const seen: { readonly language: string; readonly range: unknown }[] = [];
  for (const selection of ranges) {
    assertJsonValue(selection.range, "译文替换范围");
    if (
      seen.some(
        ({ language, range }) =>
          language === selection.language &&
          isDeepStrictEqual(range, selection.range),
      )
    )
      throw new TypeError(
        `译文替换范围重复：${selection.language} ${JSON.stringify(selection.range)}。`,
      );
    seen.push(selection);
    const readIndex = reads.findIndex(
      ({ language }) => language === selection.language,
    );
    const read = reads[readIndex];
    const scopeIndex =
      read?.scopes.findIndex((scope) =>
        isDeepStrictEqual(scope.range, selection.range),
      ) ?? -1;
    if (readIndex === -1 || scopeIndex === -1)
      throw new TypeError(
        `所选译文范围 ${selection.language} ${JSON.stringify(selection.range)} 没有对应的本次读取证据。`,
      );
    const languageIndexes = indexes.get(selection.language) ?? [];
    languageIndexes.push(scopeIndex);
    indexes.set(selection.language, languageIndexes);
  }
  return indexes;
}

function mergeTranslationReads<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(options: {
  readonly previous:
    | ComparisonBaseline<TUnit, TTranslation, TBody, TUnavailable>
    | undefined;
  readonly current: ComparisonSnapshot<
    TUnit,
    TTranslation,
    TBody,
    TUnavailable
  >;
  readonly selection: ComparisonBaselineSelection | undefined;
  readonly translationRangesByLanguage: ReadonlyMap<string, readonly number[]>;
}): readonly TranslationReadFact[] {
  const previousReads = options.previous?.snapshot.translations.reads ?? [];
  const currentReads = options.current.translations.reads;
  const languages = previousReads.map(({ language }) => language);
  for (const read of currentReads) {
    if (languages.includes(read.language)) continue;
    if (
      options.selection === undefined ||
      (options.translationRangesByLanguage.get(read.language)?.length ?? 0) > 0
    )
      languages.push(read.language);
  }

  return languages.flatMap((language) => {
    const previousRead = previousReads.find(
      (read) => read.language === language,
    );
    const currentRead = currentReads.find((read) => read.language === language);
    const selectedIndexes =
      options.selection === undefined
        ? (currentRead?.scopes.map((_scope, index) => index) ?? [])
        : (options.translationRangesByLanguage.get(language) ?? []);
    if (previousRead === undefined && selectedIndexes.length === 0) return [];

    const entries = mergeScopeEntries(
      previousRead?.scopes ?? [],
      currentRead?.scopes ?? [],
      selectedIndexes,
    );
    const shouldUseCurrentError =
      options.selection === undefined && currentRead !== undefined;
    const error = shouldUseCurrentError
      ? currentRead.error
      : previousRead?.error;
    return [
      {
        language,
        status: readStatus(
          entries.map(({ value }) => value),
          error,
        ),
        scopes: entries.map(({ value }) => ({ ...value })),
        ...(error === undefined ? {} : { error }),
      },
    ];
  });
}

function createTranslations<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(options: {
  readonly previous:
    | ComparisonBaseline<TUnit, TTranslation, TBody, TUnavailable>
    | undefined;
  readonly current: ComparisonSnapshot<
    TUnit,
    TTranslation,
    TBody,
    TUnavailable
  >;
  readonly entries: readonly TranslationReadFact[];
  readonly selection: readonly {
    readonly language: string;
    readonly range: unknown;
  }[];
}): ComparisonSnapshot<
  TUnit,
  TTranslation,
  TBody,
  TUnavailable
>["translations"] {
  const reads: TranslationReadFact[] = [];
  const records: ActualTranslationFact<TTranslation, TBody, TUnavailable>[] =
    [];
  for (const read of options.entries) {
    const previousRead = options.previous?.snapshot.translations.reads.find(
      (candidate) => candidate.language === read.language,
    );
    const currentRead = options.current.translations.reads.find(
      (candidate) => candidate.language === read.language,
    );
    const scopes: TranslationReadScopeFact[] = [];
    for (const [scopeIndex, scope] of read.scopes.entries()) {
      const selected = options.selection.some(
        ({ language, range }) =>
          language === read.language && isDeepStrictEqual(range, scope.range),
      );
      const originSnapshot = selected
        ? options.current
        : options.previous?.snapshot;
      const originRead = selected ? currentRead : previousRead;
      const originScopeIndex =
        originRead?.scopes.findIndex((candidate) =>
          isDeepStrictEqual(candidate.range, scope.range),
        ) ?? -1;
      const scopeRecords =
        originSnapshot === undefined || originScopeIndex === -1
          ? []
          : originSnapshot.translations.records.filter(
              (record) =>
                record.language === read.language &&
                record.scopeIndex === originScopeIndex,
            );
      const translationIndexes: number[] = [];
      for (const record of scopeRecords) {
        const index = records.length;
        translationIndexes.push(index);
        records.push({ ...record, index, scopeIndex });
      }
      scopes.push({ ...scope, translationIndexes });
    }
    reads.push({ ...read, scopes });
  }
  assertUniqueTranslationIdentities(records);
  return { reads, records };
}

function createSourceFacts<TUnit extends TranslationUnitInput>(
  read: SourceReadFact,
  units: readonly SourceFacts<TUnit>["units"][number][],
): SourceFacts<TUnit> {
  const totalUnitCount = read.status === "complete" ? units.length : null;
  const version = hashJson({ read, units });
  return { version, read, totalUnitCount, units };
}

function createSnapshot<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  source: SourceFacts<TUnit>,
  translations: ComparisonSnapshot<
    TUnit,
    TTranslation,
    TBody,
    TUnavailable
  >["translations"],
): ComparisonSnapshot<TUnit, TTranslation, TBody, TUnavailable> {
  return {
    version: hashJson({ source, translations }),
    source,
    translations,
  };
}

function createSourceRead(
  scopes: readonly SourceReadFact["scopes"][number][],
  error?: string,
): SourceReadFact {
  return {
    status: readStatus(scopes, error),
    scopes,
    ...(error === undefined ? {} : { error }),
  };
}

function readStatus(
  scopes: readonly { readonly enumeration: EnumerationCompleteness }[],
  error?: string,
): CoverageStatus {
  if (
    error !== undefined ||
    scopes.some(({ enumeration }) => enumeration === "failed")
  )
    return "failed";
  if (scopes.length === 0) return "notRead";
  return scopes.every(({ enumeration }) => enumeration === "complete")
    ? "complete"
    : "incomplete";
}

function assertCompleteSnapshot<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  snapshot: ComparisonSnapshot<TUnit, TTranslation, TBody, TUnavailable>,
): void {
  if (snapshot.source.read.status !== "complete")
    throw new ComparisonBaselineIncompleteSnapshotError(
      `原文读取${statusText(snapshot.source.read.status)}，比较基线未保存。`,
    );
  for (const read of snapshot.translations.reads) {
    if (read.status !== "complete")
      throw new ComparisonBaselineIncompleteSnapshotError(
        `目标语言 ${read.language} 读取${statusText(read.status)}，比较基线未保存。`,
        read.language,
      );
  }
}

function statusText(status: CoverageStatus): string {
  return (
    {
      complete: "完整",
      incomplete: "不完整",
      failed: "失败",
      notRead: "未读取",
    }[status] ?? status
  );
}

function assertDistinctRanges(
  ranges: readonly unknown[],
  description: string,
): void {
  for (const [index, range] of ranges.entries()) {
    assertJsonValue(range, description);
    if (
      ranges
        .slice(0, index)
        .some((existing) => isDeepStrictEqual(existing, range))
    )
      throw new TypeError(`${description}不能重复：${JSON.stringify(range)}。`);
  }
}

function assertUniqueSourceKeys(
  units: readonly { readonly key: string }[],
): void {
  const keys = new Set<string>();
  for (const { key } of units) {
    if (keys.has(key))
      throw new TypeError(`比较基线中的原文身份重复：${JSON.stringify(key)}。`);
    keys.add(key);
  }
}

function assertUniqueTranslationIdentities(
  records: readonly {
    readonly identity: {
      readonly language: string;
      readonly namespace: string;
      readonly key: string;
    };
  }[],
): void {
  const identities = new Set<string>();
  for (const { identity } of records) {
    const serialized = JSON.stringify(identity);
    if (identities.has(serialized))
      throw new TypeError(`比较基线中的译文身份重复：${serialized}。`);
    identities.add(serialized);
  }
}

function sameSnapshotFacts<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  previous: ComparisonSnapshot<TUnit, TTranslation, TBody, TUnavailable>,
  current: ComparisonSnapshot<TUnit, TTranslation, TBody, TUnavailable>,
): boolean {
  const { version: _previousVersion, ...previousSource } = previous.source;
  const { version: _currentVersion, ...currentSource } = current.source;
  return (
    stableStringify({
      source: previousSource,
      translations: previous.translations,
    }) ===
    stableStringify({
      source: currentSource,
      translations: current.translations,
    })
  );
}

function validateSnapshot(
  value: unknown,
): asserts value is ComparisonSnapshot<
  TranslationUnitInput,
  unknown,
  JsonValue,
  unknown
> {
  if (!isRecord(value)) invalidBaseline("比较快照必须是对象。");
  assertJsonValue(value, "比较快照");
  if (
    typeof value.version !== "string" ||
    !isRecord(value.source) ||
    !isRecord(value.translations)
  )
    invalidBaseline("比较快照缺少版本、原文或译文事实。");
  const source = value.source;
  const translations = value.translations;
  validateSourceFacts(source);
  validateTranslationFacts(translations);
  const expectedStatus = readStatus(source.read.scopes, source.read.error);
  if (source.read.status !== expectedStatus)
    invalidBaseline("比较快照的原文读取状态与范围证据不一致。");
}

function validateSourceFacts(
  value: unknown,
): asserts value is SourceFacts<TranslationUnitInput> {
  if (!isRecord(value) || typeof value.version !== "string")
    invalidBaseline("原文事实缺少版本。");
  if (!isRecord(value.read) || !Array.isArray(value.read.scopes))
    invalidBaseline("原文事实缺少读取范围。");
  if (value.read.error !== undefined && typeof value.read.error !== "string")
    invalidBaseline("原文读取错误必须是文本。");
  validateStatus(value.read.status);
  const scopeCounts = value.read.scopes.map(() => 0);
  for (const [index, scope] of value.read.scopes.entries()) {
    if (
      !isRecord(scope) ||
      !isEnumeration(scope.enumeration) ||
      !Number.isInteger(scope.recordCount) ||
      (scope.recordCount as number) < 0 ||
      (scope.error !== undefined && typeof scope.error !== "string")
    )
      invalidBaseline(`第 ${index + 1} 个原文范围无效。`);
    assertJsonValue(scope.range, `原文范围 ${index + 1}`);
    if (
      value.read.scopes
        .slice(0, index)
        .some((previous) => isDeepStrictEqual(previous.range, scope.range))
    )
      invalidBaseline("原文读取范围身份重复。");
  }
  if (!Array.isArray(value.units)) invalidBaseline("原文单元必须是数组。");
  const keys = new Set<string>();
  for (const [index, unit] of value.units.entries()) {
    if (
      !isRecord(unit) ||
      typeof unit.key !== "string" ||
      (unit.bodyAvailability !== "available" &&
        unit.bodyAvailability !== "unavailable") ||
      !Number.isInteger(unit.scopeIndex) ||
      (unit.scopeIndex as number) < 0 ||
      (unit.scopeIndex as number) >= value.read.scopes.length
    )
      invalidBaseline(`第 ${index + 1} 个原文单元无效。`);
    if (keys.has(unit.key)) invalidBaseline("原文单元身份重复。");
    keys.add(unit.key);
    assertJsonValue(unit.unit, `原文单元 ${index + 1}`);
    scopeCounts[unit.scopeIndex as number] =
      (scopeCounts[unit.scopeIndex as number] ?? 0) + 1;
  }
  for (const [scopeIndex, scope] of value.read.scopes.entries()) {
    if (scope.recordCount !== scopeCounts[scopeIndex])
      invalidBaseline("原文范围记录数与事实不一致。");
  }
  const expectedTotal =
    value.read.status === "complete" ? value.units.length : null;
  if (value.totalUnitCount !== expectedTotal)
    invalidBaseline("原文总数与读取状态不一致。");
}

function validateTranslationFacts(
  value: unknown,
): asserts value is ComparisonSnapshot<
  TranslationUnitInput,
  unknown,
  JsonValue,
  unknown
>["translations"] {
  if (
    !isRecord(value) ||
    !Array.isArray(value.reads) ||
    !Array.isArray(value.records)
  )
    invalidBaseline("译文事实必须包含读取结果与实际译文数组。");
  const languages = new Set<string>();
  const readsByLanguage = new Map<string, TranslationReadFact>();
  for (const [readIndex, read] of value.reads.entries()) {
    if (
      !isRecord(read) ||
      typeof read.language !== "string" ||
      !Array.isArray(read.scopes) ||
      (read.error !== undefined && typeof read.error !== "string")
    )
      invalidBaseline(`第 ${readIndex + 1} 个译文读取结果无效。`);
    validateStatus(read.status);
    if (languages.has(read.language)) invalidBaseline("目标语言读取重复。");
    languages.add(read.language);
    readsByLanguage.set(read.language, read as unknown as TranslationReadFact);
    for (const [scopeIndex, scope] of read.scopes.entries()) {
      if (
        !isRecord(scope) ||
        !Array.isArray(scope.covers) ||
        scope.covers.some((key) => typeof key !== "string") ||
        !Array.isArray(scope.translationIndexes) ||
        !isEnumeration(scope.enumeration) ||
        (scope.error !== undefined && typeof scope.error !== "string")
      )
        invalidBaseline(
          `目标语言 ${read.language} 的第 ${scopeIndex + 1} 个范围无效。`,
        );
      assertJsonValue(
        scope.range,
        `目标语言 ${read.language} 的范围 ${scopeIndex + 1}`,
      );
      if (
        read.scopes
          .slice(0, scopeIndex)
          .some((previous) => isDeepStrictEqual(previous.range, scope.range))
      )
        invalidBaseline(`目标语言 ${read.language} 的读取范围身份重复。`);
    }
    if (read.status !== readStatus(read.scopes, read.error))
      invalidBaseline(`目标语言 ${read.language} 的读取状态与范围证据不一致。`);
  }

  const translationIndexesByScope = new Map<string, number[]>();
  const identities = new Set<string>();
  for (const [index, record] of value.records.entries()) {
    if (
      !isRecord(record) ||
      record.index !== index ||
      typeof record.language !== "string" ||
      !isRecord(record.identity) ||
      record.identity.language !== record.language ||
      typeof record.identity.namespace !== "string" ||
      typeof record.identity.key !== "string" ||
      !Number.isInteger(record.scopeIndex) ||
      (record.bodyAvailability !== "available" &&
        record.bodyAvailability !== "unavailable")
    )
      invalidBaseline(`第 ${index + 1} 条实际译文无效。`);
    const identityKey = JSON.stringify(record.identity);
    if (identities.has(identityKey)) invalidBaseline("实际译文身份重复。");
    identities.add(identityKey);
    const read = readsByLanguage.get(record.language);
    const scope = read?.scopes[record.scopeIndex as number];
    if (read === undefined || scope === undefined)
      invalidBaseline("实际译文引用了不存在的语言或读取范围。");
    if (!isDeepStrictEqual(scope.range, record.range))
      invalidBaseline("实际译文的范围与读取证据不一致。");
    if (record.bodyAvailability === "available") {
      if (!Object.hasOwn(record, "content"))
        invalidBaseline("正文可用的实际译文必须包含正文。");
      assertJsonValue(record.content, `实际译文 ${index + 1} 正文`);
    } else if (Object.hasOwn(record, "content")) {
      invalidBaseline("正文不可用的实际译文不能包含正文。");
    }
    assertJsonValue(record.translation, `实际译文 ${index + 1}`);
    const scopeKey = JSON.stringify([
      record.language,
      record.scopeIndex as number,
    ]);
    const scopeIndexes = translationIndexesByScope.get(scopeKey) ?? [];
    scopeIndexes.push(index);
    translationIndexesByScope.set(scopeKey, scopeIndexes);
  }
  for (const read of value.reads as readonly TranslationReadFact[]) {
    for (const [scopeIndex, scope] of read.scopes.entries()) {
      const expectedIndexes =
        translationIndexesByScope.get(
          JSON.stringify([read.language, scopeIndex]),
        ) ?? [];
      if (!isDeepStrictEqual(scope.translationIndexes, expectedIndexes))
        invalidBaseline("译文读取范围中的索引与实际记录不一致。");
    }
  }
}

function validateStatus(value: unknown): asserts value is CoverageStatus {
  if (
    value !== "complete" &&
    value !== "incomplete" &&
    value !== "failed" &&
    value !== "notRead"
  )
    invalidBaseline("读取状态无效。");
}

function isEnumeration(value: unknown): value is EnumerationCompleteness {
  return value === "complete" || value === "partial" || value === "failed";
}

function invalidBaseline(message: string): never {
  throw new ComparisonBaselineFormatError("invalid", message);
}

function hashJson(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined)
    throw new TypeError("比较基线及事实必须可序列化为 JSON。");
  return `sha256:${createHash("sha256").update(serialized).digest("hex")}`;
}

export function stableStringify(value: unknown): string {
  assertJsonValue(value, "稳定 JSON 值");
  const serialized = JSON.stringify(sortJsonKeys(value), null, 2);
  if (serialized === undefined) throw new TypeError("值必须可序列化为 JSON。");
  return serialized;
}

function sortJsonKeys(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortJsonKeys);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => [key, sortJsonKeys(item)]),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
