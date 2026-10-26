import { isDeepStrictEqual } from "node:util";

import type {
  ActualTranslationFact,
  Awaitable,
  BodyAvailability,
  ComparisonSnapshot,
  CoverageStatus,
  EnumerationCompleteness,
  JsonValue,
  SourceFacts,
  SourceReadFact,
  SourceUnitFact,
  TranslationIdentity,
  TranslationReadFact,
  TranslationUnitInput,
} from "./index.ts";
import { assertJsonValue } from "./standard-schema.ts";

export type CompareInput<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody = JsonValue,
  TUnavailable = never,
> = {
  readonly previous:
    | ComparisonSnapshot<TUnit, TTranslation, TBody, TUnavailable>
    | undefined;
  readonly current: ComparisonSnapshot<
    TUnit,
    TTranslation,
    TBody,
    TUnavailable
  >;
};

export type ComparisonStatus =
  | "historyMissing"
  | "historyInsufficient"
  | "currentInsufficient"
  | "bothInsufficient"
  | "added"
  | "removed"
  | "modified"
  | "unchanged";

export type SourceChange<TUnit extends TranslationUnitInput> = {
  readonly key: string;
  readonly status: ComparisonStatus;
  readonly previous: SourceUnitFact<TUnit> | undefined;
  readonly current: SourceUnitFact<TUnit> | undefined;
};

export type TranslationChange<
  TTranslation,
  TBody = JsonValue,
  TUnavailable = never,
> = {
  readonly identity: TranslationIdentity;
  readonly status: ComparisonStatus;
  readonly previous:
    | ActualTranslationFact<TTranslation, TBody, TUnavailable>
    | undefined;
  readonly current:
    | ActualTranslationFact<TTranslation, TBody, TUnavailable>
    | undefined;
};

export type SnapshotReadEvidence = {
  readonly source: SourceReadFact;
  readonly translations: readonly TranslationReadFact[];
};

export type ComparisonResult<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody = JsonValue,
  TUnavailable = never,
> = {
  readonly sourceChanges: readonly SourceChange<TUnit>[];
  readonly translationChanges: readonly TranslationChange<
    TTranslation,
    TBody,
    TUnavailable
  >[];
  readonly reads: {
    readonly previous: SnapshotReadEvidence | undefined;
    readonly current: SnapshotReadEvidence;
  };
};

export type Compare<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody = JsonValue,
  TUnavailable = never,
> = (
  input: CompareInput<TUnit, TTranslation, TBody, TUnavailable>,
) => Awaitable<ComparisonResult<TUnit, TTranslation, TBody, TUnavailable>>;

export type ComparisonContractErrorReason = "invalid-input" | "invalid-result";

export class ComparisonContractError extends TypeError {
  readonly reason: ComparisonContractErrorReason;

  constructor(reason: ComparisonContractErrorReason, message: string) {
    super(message);
    this.name = "ComparisonContractError";
    this.reason = reason;
  }
}

export function validateComparisonInput<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody = JsonValue,
  TUnavailable = never,
>(
  value: unknown,
): asserts value is CompareInput<TUnit, TTranslation, TBody, TUnavailable> {
  assertComparisonJsonValue(value, "比较输入", "input");
  if (!isRecord(value) || !Object.hasOwn(value, "previous"))
    invalidInput("比较输入必须提供 previous 与 current。");

  validateSnapshot(value.current, "current");
  if (value.previous !== undefined)
    validateSnapshot(value.previous, "previous");
}

export function validateComparisonResult<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody = JsonValue,
  TUnavailable = never,
>(
  input: CompareInput<TUnit, TTranslation, TBody, TUnavailable>,
  value: unknown,
): asserts value is ComparisonResult<TUnit, TTranslation, TBody, TUnavailable> {
  assertComparisonJsonValue(value, "比较结果", "result");
  if (!isRecord(value)) invalidResult("比较结果必须是对象。");
  if (!Array.isArray(value.sourceChanges))
    invalidResult("比较结果必须提供 sourceChanges 数组。");
  if (!Array.isArray(value.translationChanges))
    invalidResult("比较结果必须提供 translationChanges 数组。");
  if (!isRecord(value.reads)) invalidResult("比较结果必须提供 reads 对象。");
  if (!Object.hasOwn(value.reads, "current"))
    invalidResult("比较结果必须提供 current 读取依据。");
  if (input.previous !== undefined && !Object.hasOwn(value.reads, "previous"))
    invalidResult("存在 previous 快照时，比较结果必须提供 previous 读取依据。");

  const expectedPrevious =
    input.previous === undefined ? undefined : readEvidence(input.previous);
  const expectedCurrent = readEvidence(input.current);
  if (!isDeepStrictEqual(value.reads.previous, expectedPrevious))
    invalidResult("比较结果的 previous 读取依据必须与输入一致。");
  if (!isDeepStrictEqual(value.reads.current, expectedCurrent))
    invalidResult("比较结果的 current 读取依据必须与输入一致。");

  validateSourceChanges(input, value.sourceChanges);
  validateTranslationChanges(input, value.translationChanges);
}

export function defaultCompare<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody = JsonValue,
  TUnavailable = never,
>(
  input: CompareInput<TUnit, TTranslation, TBody, TUnavailable>,
): ComparisonResult<TUnit, TTranslation, TBody, TUnavailable> {
  validateComparisonInput<TUnit, TTranslation, TBody, TUnavailable>(input);
  return createDefaultComparison<TUnit, TTranslation, TBody, TUnavailable>(
    input,
  );
}

export async function compareSnapshots<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody = JsonValue,
  TUnavailable = never,
>(
  input: CompareInput<TUnit, TTranslation, TBody, TUnavailable>,
  compare?: Compare<TUnit, TTranslation, TBody, TUnavailable>,
): Promise<ComparisonResult<TUnit, TTranslation, TBody, TUnavailable>> {
  validateComparisonInput<TUnit, TTranslation, TBody, TUnavailable>(input);
  if (compare !== undefined && typeof compare !== "function")
    invalidInput("compare 必须是比较函数。");

  const compared =
    compare === undefined || compare === defaultCompare
      ? createDefaultComparison<TUnit, TTranslation, TBody, TUnavailable>(input)
      : await compare(input);
  validateComparisonResult<TUnit, TTranslation, TBody, TUnavailable>(
    input,
    compared,
  );
  return compared;
}

function createDefaultComparison<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  input: CompareInput<TUnit, TTranslation, TBody, TUnavailable>,
): ComparisonResult<TUnit, TTranslation, TBody, TUnavailable> {
  const sourceChanges = createSourceChanges(input);
  const translationChanges = createTranslationChanges(input);
  return {
    sourceChanges,
    translationChanges,
    reads: {
      previous:
        input.previous === undefined ? undefined : readEvidence(input.previous),
      current: readEvidence(input.current),
    },
  };
}

function createSourceChanges<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  input: CompareInput<TUnit, TTranslation, TBody, TUnavailable>,
): SourceChange<TUnit>[] {
  const previous =
    input.previous === undefined
      ? new Map<string, SourceUnitFact<TUnit>>()
      : sourceRecordMap(input.previous);
  const current = sourceRecordMap(input.current);
  const keys = [...new Set([...previous.keys(), ...current.keys()])].sort(
    compareText,
  );

  return keys.map((key) => {
    const before = previous.get(key);
    const after = current.get(key);
    return {
      key,
      status: compareSourceStatus(
        input.previous?.source,
        input.current.source,
        before,
        after,
      ),
      previous: before,
      current: after,
    };
  });
}

function createTranslationChanges<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  input: CompareInput<TUnit, TTranslation, TBody, TUnavailable>,
): TranslationChange<TTranslation, TBody, TUnavailable>[] {
  const previous =
    input.previous === undefined
      ? new Map<
          string,
          ActualTranslationFact<TTranslation, TBody, TUnavailable>
        >()
      : translationRecordMap(input.previous);
  const current = translationRecordMap(input.current);
  const identityKeys = [
    ...new Set([...previous.keys(), ...current.keys()]),
  ].sort(compareText);

  return identityKeys.map((identityKey) => {
    const before = previous.get(identityKey);
    const after = current.get(identityKey);
    const identity = (after ?? before)?.identity;
    if (identity === undefined)
      invalidInput("比较输入中存在无法读取的译文身份。");
    return {
      identity,
      status: compareTranslationStatus(
        input.previous,
        input.current,
        before,
        after,
      ),
      previous: before,
      current: after,
    };
  });
}

function compareSourceStatus<TUnit extends TranslationUnitInput>(
  previousSource: SourceFacts<TUnit> | undefined,
  currentSource: SourceFacts<TUnit>,
  previous: SourceUnitFact<TUnit> | undefined,
  current: SourceUnitFact<TUnit> | undefined,
): ComparisonStatus {
  const evidenceStatus = sourceEvidenceStatus(
    previousSource,
    currentSource,
    previous,
    current,
  );
  if (evidenceStatus !== "comparable") return evidenceStatus;
  if (previous === undefined || current === undefined)
    invalidInput("可比较的原文必须同时提供前后事实。");
  return isDeepStrictEqual(previous.unit, current.unit)
    ? "unchanged"
    : "modified";
}

function sourceEvidenceStatus<TUnit extends TranslationUnitInput>(
  previousSource: SourceFacts<TUnit> | undefined,
  currentSource: SourceFacts<TUnit>,
  previous: SourceUnitFact<TUnit> | undefined,
  current: SourceUnitFact<TUnit> | undefined,
): ComparisonStatus | "comparable" {
  if (previous === undefined && current !== undefined) {
    if (previousSource === undefined) return "historyMissing";
    return hasCompleteSourceScope(
      previousSource.read,
      sourceRange(currentSource, current),
    )
      ? "added"
      : "historyInsufficient";
  }
  if (previous !== undefined && current === undefined) {
    if (previousSource === undefined)
      invalidInput("缺少 previous 快照，却提供了历史原文事实。");
    return hasCompleteSourceScope(
      currentSource.read,
      sourceRange(previousSource, previous),
    )
      ? "removed"
      : "currentInsufficient";
  }
  if (previous === undefined || current === undefined)
    return "historyInsufficient";
  if (
    previous.bodyAvailability === "unavailable" &&
    current.bodyAvailability === "unavailable"
  )
    return "bothInsufficient";
  if (previous.bodyAvailability === "unavailable") return "historyInsufficient";
  if (current.bodyAvailability === "unavailable") return "currentInsufficient";
  return "comparable";
}

function compareTranslationStatus<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  previousSnapshot:
    | ComparisonSnapshot<TUnit, TTranslation, TBody, TUnavailable>
    | undefined,
  currentSnapshot: ComparisonSnapshot<TUnit, TTranslation, TBody, TUnavailable>,
  previous:
    | ActualTranslationFact<TTranslation, TBody, TUnavailable>
    | undefined,
  current: ActualTranslationFact<TTranslation, TBody, TUnavailable> | undefined,
): ComparisonStatus {
  const evidenceStatus = translationEvidenceStatus(
    previousSnapshot,
    currentSnapshot,
    previous,
    current,
  );
  if (evidenceStatus !== "comparable") return evidenceStatus;
  if (previous === undefined || current === undefined)
    invalidInput("可比较的译文必须同时提供前后事实。");
  return isDeepStrictEqual(previous.content, current.content)
    ? "unchanged"
    : "modified";
}

function translationEvidenceStatus<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  previousSnapshot:
    | ComparisonSnapshot<TUnit, TTranslation, TBody, TUnavailable>
    | undefined,
  currentSnapshot: ComparisonSnapshot<TUnit, TTranslation, TBody, TUnavailable>,
  previous:
    | ActualTranslationFact<TTranslation, TBody, TUnavailable>
    | undefined,
  current: ActualTranslationFact<TTranslation, TBody, TUnavailable> | undefined,
): ComparisonStatus | "comparable" {
  if (previous === undefined && current !== undefined) {
    if (previousSnapshot === undefined) return "historyMissing";
    return hasCompleteTranslationScope(
      previousSnapshot.translations.reads,
      current.identity.language,
      current.range,
    )
      ? "added"
      : "historyInsufficient";
  }
  if (previous !== undefined && current === undefined) {
    if (previousSnapshot === undefined)
      invalidInput("缺少 previous 快照，却提供了历史译文事实。");
    return hasCompleteTranslationScope(
      currentSnapshot.translations.reads,
      previous.identity.language,
      previous.range,
    )
      ? "removed"
      : "currentInsufficient";
  }
  if (previous === undefined || current === undefined)
    return "historyInsufficient";
  if (
    previous.bodyAvailability === "unavailable" &&
    current.bodyAvailability === "unavailable"
  )
    return "bothInsufficient";
  if (previous.bodyAvailability === "unavailable") return "historyInsufficient";
  if (current.bodyAvailability === "unavailable") return "currentInsufficient";
  return "comparable";
}

function validateSourceChanges<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  input: CompareInput<TUnit, TTranslation, TBody, TUnavailable>,
  value: readonly unknown[],
): void {
  const previous =
    input.previous === undefined
      ? new Map<string, SourceUnitFact<TUnit>>()
      : sourceRecordMap(input.previous);
  const current = sourceRecordMap(input.current);
  const expectedKeys = new Set([...previous.keys(), ...current.keys()]);
  const seen = new Set<string>();

  for (const [index, rawChange] of value.entries()) {
    if (!isRecord(rawChange) || typeof rawChange.key !== "string")
      invalidResult(`第 ${index + 1} 个原文变化必须提供 key。`);
    if (seen.has(rawChange.key))
      invalidResult(`原文变化身份重复：${rawChange.key}。`);
    seen.add(rawChange.key);
    if (!expectedKeys.has(rawChange.key))
      invalidResult(`原文变化身份不在输入中：${rawChange.key}。`);

    const before = previous.get(rawChange.key);
    const after = current.get(rawChange.key);
    validateBeforeAndAfter(rawChange, before, after, `原文 ${rawChange.key}`);
    validateSourceStatus(
      input.previous?.source,
      input.current.source,
      before,
      after,
      rawChange.status,
      `原文 ${rawChange.key}`,
    );
  }
  if (seen.size !== expectedKeys.size)
    invalidResult("sourceChanges 必须覆盖输入中的每个原文身份。");
}

function validateTranslationChanges<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  input: CompareInput<TUnit, TTranslation, TBody, TUnavailable>,
  value: readonly unknown[],
): void {
  const previous =
    input.previous === undefined
      ? new Map<
          string,
          ActualTranslationFact<TTranslation, TBody, TUnavailable>
        >()
      : translationRecordMap(input.previous);
  const current = translationRecordMap(input.current);
  const expectedKeys = new Set([...previous.keys(), ...current.keys()]);
  const seen = new Set<string>();

  for (const [index, rawChange] of value.entries()) {
    if (!isRecord(rawChange) || !isIdentity(rawChange.identity))
      invalidResult(`第 ${index + 1} 个译文变化必须提供完整身份。`);
    const identityKey = translationIdentityKey(rawChange.identity);
    if (seen.has(identityKey))
      invalidResult(
        `译文变化身份重复：${JSON.stringify(rawChange.identity)}。`,
      );
    seen.add(identityKey);
    if (!expectedKeys.has(identityKey))
      invalidResult(
        `译文变化身份不在输入中：${JSON.stringify(rawChange.identity)}。`,
      );

    const before = previous.get(identityKey);
    const after = current.get(identityKey);
    const expectedIdentity = (after ?? before)?.identity;
    if (
      expectedIdentity === undefined ||
      !isDeepStrictEqual(rawChange.identity, expectedIdentity)
    )
      invalidResult("译文变化的 identity 必须与输入事实一致。");
    validateBeforeAndAfter(
      rawChange,
      before,
      after,
      `译文 ${JSON.stringify(rawChange.identity)}`,
    );
    validateTranslationStatus(
      input.previous,
      input.current,
      before,
      after,
      rawChange.status,
      `译文 ${JSON.stringify(rawChange.identity)}`,
    );
  }
  if (seen.size !== expectedKeys.size)
    invalidResult("translationChanges 必须覆盖输入中的每个译文身份。");
}

function validateBeforeAndAfter(
  change: Record<string, unknown>,
  previous: unknown,
  current: unknown,
  description: string,
): void {
  const previousMatches =
    previous === undefined
      ? change.previous === undefined
      : Object.hasOwn(change, "previous") &&
        isDeepStrictEqual(change.previous, previous);
  const currentMatches =
    current === undefined
      ? change.current === undefined
      : Object.hasOwn(change, "current") &&
        isDeepStrictEqual(change.current, current);
  if (!previousMatches || !currentMatches)
    invalidResult(`${description} 的前后事实必须与输入一致。`);
}

function validateSourceStatus<TUnit extends TranslationUnitInput>(
  previousSource: SourceFacts<TUnit> | undefined,
  currentSource: SourceFacts<TUnit>,
  previous: SourceUnitFact<TUnit> | undefined,
  current: SourceUnitFact<TUnit> | undefined,
  status: unknown,
  description: string,
): void {
  if (typeof status !== "string" || !isComparisonStatus(status))
    invalidResult(`${description} 的 status 无效。`);
  if (previous !== undefined && current !== undefined) {
    if (
      status === "historyMissing" ||
      status === "added" ||
      status === "removed"
    )
      invalidResult(
        `${description} 前后都有同一身份，只能标记比较或依据不足。`,
      );
    return;
  }
  const expected = sourceEvidenceStatus(
    previousSource,
    currentSource,
    previous,
    current,
  );
  validateStatusChoice(status, expected, description);
}

function validateTranslationStatus<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  previousSnapshot:
    | ComparisonSnapshot<TUnit, TTranslation, TBody, TUnavailable>
    | undefined,
  currentSnapshot: ComparisonSnapshot<TUnit, TTranslation, TBody, TUnavailable>,
  previous:
    | ActualTranslationFact<TTranslation, TBody, TUnavailable>
    | undefined,
  current: ActualTranslationFact<TTranslation, TBody, TUnavailable> | undefined,
  status: unknown,
  description: string,
): void {
  if (typeof status !== "string" || !isComparisonStatus(status))
    invalidResult(`${description} 的 status 无效。`);
  if (previous !== undefined && current !== undefined) {
    if (
      status === "historyMissing" ||
      status === "added" ||
      status === "removed"
    )
      invalidResult(
        `${description} 前后都有同一身份，只能标记比较或依据不足。`,
      );
    return;
  }
  const expected = translationEvidenceStatus(
    previousSnapshot,
    currentSnapshot,
    previous,
    current,
  );
  validateStatusChoice(status, expected, description);
}

function validateStatusChoice(
  status: ComparisonStatus,
  expected: ComparisonStatus | "comparable",
  description: string,
): void {
  if (expected === "comparable") {
    if (status !== "modified" && status !== "unchanged")
      invalidResult(
        `${description} 已有双方可用正文，只能标记 modified 或 unchanged。`,
      );
    return;
  }
  if (status !== expected)
    invalidResult(`${description} 的 status 必须是 ${expected}。`);
}

function sourceRecordMap<TUnit extends TranslationUnitInput>(
  snapshot: ComparisonSnapshot<TUnit, unknown, unknown, unknown>,
): Map<string, SourceUnitFact<TUnit>> {
  return new Map(
    snapshot.source.units.map((unit) => [unit.key, unit] as const),
  );
}

function translationRecordMap<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  snapshot: ComparisonSnapshot<TUnit, TTranslation, TBody, TUnavailable>,
): Map<string, ActualTranslationFact<TTranslation, TBody, TUnavailable>> {
  return new Map(
    snapshot.translations.records.map(
      (record) => [translationIdentityKey(record.identity), record] as const,
    ),
  );
}

function validateSnapshot(
  value: unknown,
  description: "previous" | "current",
): void {
  if (!isRecord(value) || typeof value.version !== "string")
    invalidInput(`${description} 快照结构无效。`);
  if (!isRecord(value.source) || !isRecord(value.source.read))
    invalidInput(`${description} 快照缺少 source.read。`);
  if (
    !Array.isArray(value.source.read.scopes) ||
    !Array.isArray(value.source.units)
  )
    invalidInput(`${description} 快照的原文事实结构无效。`);
  if (!isCoverageStatus(value.source.read.status))
    invalidInput(`${description} 快照的原文读取状态无效。`);
  for (const scope of value.source.read.scopes) {
    if (!isRecord(scope) || !isEnumerationCompleteness(scope.enumeration))
      invalidInput(`${description} 快照的原文读取范围结构无效。`);
  }

  const sourceKeys = new Set<string>();
  for (const unit of value.source.units) {
    if (
      !isRecord(unit) ||
      typeof unit.key !== "string" ||
      !isBodyAvailability(unit.bodyAvailability) ||
      !Number.isInteger(unit.scopeIndex) ||
      (unit.scopeIndex as number) < 0 ||
      (unit.scopeIndex as number) >= value.source.read.scopes.length
    )
      invalidInput(`${description} 快照包含无效原文事实。`);
    if (sourceKeys.has(unit.key))
      invalidInput(`${description} 快照原文身份重复：${unit.key}。`);
    sourceKeys.add(unit.key);
  }

  if (
    !isRecord(value.translations) ||
    !Array.isArray(value.translations.reads) ||
    !Array.isArray(value.translations.records)
  )
    invalidInput(`${description} 快照的译文事实结构无效。`);
  for (const read of value.translations.reads) {
    if (
      !isRecord(read) ||
      typeof read.language !== "string" ||
      !isCoverageStatus(read.status) ||
      !Array.isArray(read.scopes)
    )
      invalidInput(`${description} 快照的译文读取依据无效。`);
    for (const scope of read.scopes) {
      if (!isRecord(scope) || !isEnumerationCompleteness(scope.enumeration))
        invalidInput(`${description} 快照的译文读取范围结构无效。`);
    }
  }

  const translationKeys = new Set<string>();
  for (const translation of value.translations.records) {
    if (
      !isRecord(translation) ||
      typeof translation.language !== "string" ||
      !isIdentity(translation.identity) ||
      translation.identity.language !== translation.language ||
      !isBodyAvailability(translation.bodyAvailability)
    )
      invalidInput(`${description} 快照包含无效译文事实。`);
    const identityKey = translationIdentityKey(translation.identity);
    if (translationKeys.has(identityKey))
      invalidInput(
        `${description} 快照译文身份重复：${JSON.stringify(translation.identity)}。`,
      );
    translationKeys.add(identityKey);
  }
}

function hasCompleteSourceScope(
  read: SourceFacts<TranslationUnitInput>["read"],
  range: unknown,
): boolean {
  return read.scopes.some(
    (scope) =>
      scope.enumeration === "complete" && isDeepStrictEqual(scope.range, range),
  );
}

function hasCompleteTranslationScope(
  reads: readonly TranslationReadFact[],
  language: string,
  range: unknown,
): boolean {
  return reads.some(
    (read) =>
      read.language === language &&
      read.scopes.some(
        (scope) =>
          scope.enumeration === "complete" &&
          isDeepStrictEqual(scope.range, range),
      ),
  );
}

function sourceRange<TUnit extends TranslationUnitInput>(
  source: SourceFacts<TUnit>,
  fact: SourceUnitFact<TUnit>,
): unknown {
  return source.read.scopes[fact.scopeIndex]?.range;
}

function readEvidence<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  snapshot: ComparisonSnapshot<TUnit, TTranslation, TBody, TUnavailable>,
): SnapshotReadEvidence {
  return {
    source: snapshot.source.read,
    translations: snapshot.translations.reads,
  };
}

function translationIdentityKey(identity: TranslationIdentity): string {
  return JSON.stringify([identity.language, identity.namespace, identity.key]);
}

function isIdentity(value: unknown): value is TranslationIdentity {
  return (
    isRecord(value) &&
    typeof value.language === "string" &&
    typeof value.namespace === "string" &&
    value.namespace.length > 0 &&
    typeof value.key === "string" &&
    value.key.length > 0
  );
}

function isComparisonStatus(value: string): value is ComparisonStatus {
  return (
    value === "historyMissing" ||
    value === "historyInsufficient" ||
    value === "currentInsufficient" ||
    value === "bothInsufficient" ||
    value === "added" ||
    value === "removed" ||
    value === "modified" ||
    value === "unchanged"
  );
}

function isBodyAvailability(value: unknown): value is BodyAvailability {
  return value === "available" || value === "unavailable";
}

function isCoverageStatus(value: unknown): value is CoverageStatus {
  return (
    value === "complete" ||
    value === "incomplete" ||
    value === "failed" ||
    value === "notRead"
  );
}

function isEnumerationCompleteness(
  value: unknown,
): value is EnumerationCompleteness {
  return value === "complete" || value === "partial" || value === "failed";
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidInput(message: string): never {
  throw new ComparisonContractError("invalid-input", message);
}

function assertComparisonJsonValue(
  value: unknown,
  description: string,
  kind: "input" | "result",
): void {
  try {
    assertJsonValue(value, description, {
      omitUndefinedObjectProperties: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (kind === "input") invalidInput(message);
    invalidResult(message);
  }
}

function invalidResult(message: string): never {
  throw new ComparisonContractError("invalid-result", message);
}
