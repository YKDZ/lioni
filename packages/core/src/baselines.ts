import type {
  ActualTranslationFact,
  BodyAvailability,
  CoverageStatus,
  EnumerationCompleteness,
  FrameworkConfig,
  FrameworkFacts,
  TranslationAssociationStatus,
  TranslationUnitInput,
} from "./index.ts";
import type { JsonValue } from "./semantic-edits.ts";
import {
  assertJsonValue,
  StandardSchemaContractError,
  validateWithStandardSchema,
} from "./standard-schema.ts";

export type ProcessingBaselineTranslationScope = {
  readonly range: unknown;
  readonly covers: readonly string[];
  readonly enumeration: EnumerationCompleteness;
};

export type ProcessingBaselineTranslation<
  TTranslation = unknown,
  TUnavailable = unknown,
> =
  | {
      readonly range: unknown;
      readonly translation: TTranslation;
      readonly bodyAvailability: "available";
    }
  | {
      readonly range: unknown;
      readonly translation: TUnavailable;
      readonly bodyAvailability: "unavailable";
    };

export type ProcessingBaselineEntry<
  TUnit = unknown,
  TTranslation = unknown,
  TUnavailable = unknown,
> = {
  readonly sourceKey: string;
  readonly language: string;
  readonly processed: boolean;
  readonly source: {
    readonly presence: "present" | "removed";
    readonly unit: TUnit;
    readonly bodyAvailability: BodyAvailability;
    readonly range: unknown;
    readonly enumeration: EnumerationCompleteness;
  };
  readonly association: {
    readonly status: TranslationAssociationStatus;
    readonly coverageStatus: CoverageStatus;
    readonly scopes: readonly ProcessingBaselineTranslationScope[];
    readonly translations: readonly ProcessingBaselineTranslation<
      TTranslation,
      TUnavailable
    >[];
  };
};

export type ProcessingBaseline<
  TUnit = unknown,
  TTranslation = unknown,
  TUnavailable = unknown,
> = {
  readonly formatVersion: 1;
  readonly entries: readonly ProcessingBaselineEntry<
    TUnit,
    TTranslation,
    TUnavailable
  >[];
  readonly sourceScopes: readonly ProcessingBaselineSourceScope[];
};

export type ProcessingBaselineSourceScope = {
  readonly range: unknown;
  readonly enumeration: EnumerationCompleteness;
  readonly sourceKeys: readonly string[];
};

/**
 * 可替换的处理基线存储。保存失败时，适配器应保留此前成功保存的基线。
 */
export type ProcessingBaselineStore = {
  load(): Promise<ProcessingBaseline | undefined>;
  save(baseline: ProcessingBaseline): Promise<void>;
};

export type ProcessingBaselineSelection = {
  readonly sourceKey: string;
  readonly language: string;
};

export type ProcessingChangeStatus =
  | "history-insufficient"
  | "added"
  | "unchanged"
  | "changed"
  | "source-removed"
  | "unknown"
  | "conflict";

export type ProcessingBaselineChange<
  TUnit = unknown,
  TTranslation = unknown,
  TUnavailable = unknown,
> = {
  readonly sourceKey: string;
  readonly language: string;
  readonly status: ProcessingChangeStatus;
  readonly processed: boolean;
  readonly previous?: ProcessingBaselineEntry<
    TUnit,
    TTranslation,
    TUnavailable
  >;
  readonly current?: ProcessingBaselineEntry<TUnit, TTranslation, TUnavailable>;
};

export type ProcessingBaselineComparison<
  TUnit = unknown,
  TTranslation = unknown,
  TUnavailable = unknown,
> = {
  readonly available: boolean;
  readonly changes: readonly ProcessingBaselineChange<
    TUnit,
    TTranslation,
    TUnavailable
  >[];
};

export type ProcessingBaselineAdvanceResult<
  TUnit = unknown,
  TTranslation = unknown,
  TUnavailable = unknown,
> = {
  readonly outcome: "saved" | "unchanged" | "failed";
  readonly baseline?: ProcessingBaseline<TUnit, TTranslation, TUnavailable>;
  readonly selections: readonly {
    readonly sourceKey: string;
    readonly language: string;
    readonly outcome: "advanced" | "conflict" | "unknown" | "notFound";
  }[];
  readonly failure?: {
    readonly phase: "load" | "save";
    readonly message: string;
  };
};

type UnitWithKey<TUnit extends TranslationUnitInput> = {
  readonly key: string;
  readonly unit: TUnit;
  readonly bodyAvailability: BodyAvailability;
  readonly scopeIndex: number;
};

const FORMAT_VERSION = 1;

/**
 * 将当前事实与已保存的处理历史比较。此函数只读；缺少历史时会如实报告。
 */
export async function compareProcessingBaseline<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody = JsonValue,
  TUnavailable = never,
>(
  facts: FrameworkFacts<TUnit, TTranslation, TBody, TUnavailable>,
  baseline: ProcessingBaseline | undefined,
  config: FrameworkConfig<TUnit, TTranslation, TBody, TUnavailable>,
): Promise<ProcessingBaselineComparison<TUnit, TTranslation, TUnavailable>> {
  if (baseline === undefined) {
    return {
      available: false,
      changes: currentPairs(facts).map(({ sourceKey, language, entry }) => ({
        sourceKey,
        language,
        status: "history-insufficient",
        processed: false,
        current: entry,
      })),
    };
  }

  const validated = await validateProcessingBaselineHistory(baseline, config);
  return compareValidatedProcessingBaseline(facts, validated, config);
}

function compareValidatedProcessingBaseline<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  facts: FrameworkFacts<TUnit, TTranslation, TBody, TUnavailable>,
  baseline: ProcessingBaseline<TUnit, TTranslation, TUnavailable>,
  config: FrameworkConfig<TUnit, TTranslation, TBody, TUnavailable>,
): ProcessingBaselineComparison<TUnit, TTranslation, TUnavailable> {
  const changes: ProcessingBaselineChange<TUnit, TTranslation, TUnavailable>[] =
    [];
  const compared = new Set<string>();
  const previousByPair = new Map(
    baseline.entries.map((entry) => [
      pairKey(entry.sourceKey, entry.language),
      entry,
    ]),
  );

  for (const pair of currentPairs(facts)) {
    const id = pairKey(pair.sourceKey, pair.language);
    compared.add(id);
    const previous = previousByPair.get(id);
    if (previous === undefined) {
      const hasPriorIdentity = baseline.entries.some(
        (entry) => entry.sourceKey === pair.sourceKey,
      );
      const previousScopes = baseline.sourceScopes.filter(({ range }) =>
        sameJson(range, pair.entry.source.range),
      );
      const wasPreviouslyObserved = previousScopes.some(({ sourceKeys }) =>
        sourceKeys.includes(pair.sourceKey),
      );
      changes.push({
        sourceKey: pair.sourceKey,
        language: pair.language,
        status:
          !hasPriorIdentity &&
          !wasPreviouslyObserved &&
          previousScopes.length > 0 &&
          previousScopes.every(({ enumeration }) => enumeration === "complete")
            ? "added"
            : "history-insufficient",
        processed: false,
        current: pair.entry,
      });
      continue;
    }

    const status = comparePresentEntry(previous, pair.entry);
    changes.push({
      sourceKey: pair.sourceKey,
      language: pair.language,
      status,
      processed: previous.processed,
      previous,
      current: pair.entry,
    });
  }

  for (const previous of baseline.entries) {
    const id = pairKey(previous.sourceKey, previous.language);
    if (compared.has(id)) continue;
    const currentUnit = facts.source.units.find(
      ({ key }) => key === previous.sourceKey,
    );
    if (currentUnit !== undefined) {
      changes.push({
        sourceKey: previous.sourceKey,
        language: previous.language,
        status: "unknown",
        processed: previous.processed,
        previous,
      });
      continue;
    }

    const current = currentRemovedEntry(
      facts,
      previous,
      baseline.sourceScopes,
      config.translations?.matches,
    );
    const comparedRemoval =
      previous.source.presence === "removed" && current !== undefined
        ? comparePresentEntry(previous, current)
        : undefined;
    const status: ProcessingChangeStatus =
      current === undefined
        ? "unknown"
        : comparedRemoval === "changed" || comparedRemoval === "unchanged"
          ? comparedRemoval
          : "source-removed";
    changes.push({
      sourceKey: previous.sourceKey,
      language: previous.language,
      status,
      processed: previous.processed,
      previous,
      ...(current === undefined ? {} : { current }),
    });
  }

  return { available: true, changes };
}

/**
 * 显式建立或推进选定源身份和语言的处理历史。首次保存时也记录其他当前事实，
 * 并标记为未处理，以便后续区分旧工作与新增内容。
 */
export async function advanceProcessingBaseline<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody = JsonValue,
  TUnavailable = never,
>(
  store: ProcessingBaselineStore,
  facts: FrameworkFacts<TUnit, TTranslation, TBody, TUnavailable>,
  selections: readonly ProcessingBaselineSelection[],
  config: FrameworkConfig<TUnit, TTranslation, TBody, TUnavailable>,
): Promise<ProcessingBaselineAdvanceResult<TUnit, TTranslation, TUnavailable>> {
  let loaded: ProcessingBaseline | undefined;
  try {
    loaded = await store.load();
  } catch (error) {
    rethrowContractError(error);
    return {
      outcome: "failed",
      selections: selections.map(({ sourceKey, language }) => ({
        sourceKey,
        language,
        outcome: "unknown",
      })),
      failure: { phase: "load", message: errorMessage(error) },
    };
  }
  const previous =
    loaded === undefined
      ? undefined
      : await validateProcessingBaselineHistory(loaded, config);

  const selectionResults: {
    sourceKey: string;
    language: string;
    outcome: "advanced" | "conflict" | "unknown" | "notFound";
  }[] = [];
  const observedPairs = currentPairs(facts);
  const observedByPair = new Map(
    observedPairs.map((pair) => [pairKey(pair.sourceKey, pair.language), pair]),
  );
  const updates = new Map<
    string,
    ProcessingBaselineEntry<TUnit, TTranslation, TUnavailable>
  >();
  for (const selection of uniqueSelections(selections)) {
    const pair = observedByPair.get(
      pairKey(selection.sourceKey, selection.language),
    );
    let current:
      | ProcessingBaselineEntry<TUnit, TTranslation, TUnavailable>
      | undefined = pair?.entry;
    if (pair === undefined) {
      const oldEntry = previous?.entries.find(
        (entry) =>
          entry.sourceKey === selection.sourceKey &&
          entry.language === selection.language,
      );
      if (oldEntry === undefined) {
        selectionResults.push({ ...selection, outcome: "notFound" });
        continue;
      }
      if (config.translations?.matches === undefined) {
        selectionResults.push({ ...selection, outcome: "unknown" });
        continue;
      }
      current = currentRemovedEntry(
        facts,
        oldEntry,
        previous?.sourceScopes ?? [],
        config.translations.matches,
      );
      if (current === undefined) {
        selectionResults.push({ ...selection, outcome: "unknown" });
        continue;
      }
    }
    if (current === undefined) {
      selectionResults.push({ ...selection, outcome: "unknown" });
      continue;
    }
    if (current.association.status === "conflict") {
      selectionResults.push({ ...selection, outcome: "conflict" });
      continue;
    }
    if (current.association.status === "unknown") {
      selectionResults.push({ ...selection, outcome: "unknown" });
      continue;
    }
    updates.set(pairKey(selection.sourceKey, selection.language), {
      ...current,
      processed: true,
    });
    selectionResults.push({ ...selection, outcome: "advanced" });
  }

  if (updates.size === 0) {
    return {
      outcome: "unchanged",
      ...(previous === undefined ? {} : { baseline: previous }),
      selections: selectionResults,
    };
  }

  const entries = new Map<
    string,
    ProcessingBaselineEntry<TUnit, TTranslation, TUnavailable>
  >();
  let sourceScopes: ProcessingBaselineSourceScope[];
  if (previous === undefined) {
    sourceScopes = snapshotSourceScopes(facts);
    for (const pair of observedPairs) {
      entries.set(pairKey(pair.sourceKey, pair.language), {
        ...pair.entry,
        processed: false,
      });
    }
  } else {
    for (const entry of previous.entries)
      entries.set(pairKey(entry.sourceKey, entry.language), entry);
    sourceScopes = [...previous.sourceScopes];

    const newRanges = uniqueRanges(
      [...updates.values()]
        .map(({ source }) => source.range)
        .filter(
          (range) =>
            !sourceScopes.some((scope) => sameJson(scope.range, range)),
        ),
    );
    if (newRanges.length > 0) {
      sourceScopes.push(
        ...snapshotSourceScopes(facts).filter(({ range }) =>
          newRanges.some((newRange) => sameJson(newRange, range)),
        ),
      );
      for (const pair of observedPairs) {
        if (
          newRanges.some((range) => sameJson(pair.entry.source.range, range)) &&
          !entries.has(pairKey(pair.sourceKey, pair.language))
        ) {
          entries.set(pairKey(pair.sourceKey, pair.language), {
            ...pair.entry,
            processed: false,
          });
        }
      }
    }
  }
  const sourceKeysByRange = new Map<string, string[]>();
  for (const entry of updates.values()) {
    const rangeKey = canonicalJson(entry.source.range);
    const sourceKeys = sourceKeysByRange.get(rangeKey) ?? [];
    sourceKeys.push(entry.sourceKey);
    sourceKeysByRange.set(rangeKey, sourceKeys);
  }
  sourceScopes = sourceScopes.map((scope) => {
    const sourceKeys = sourceKeysByRange.get(canonicalJson(scope.range));
    return sourceKeys === undefined
      ? scope
      : {
          ...scope,
          sourceKeys: [...new Set([...scope.sourceKeys, ...sourceKeys])],
        };
  });
  const previouslyObservedKeys = new Set(
    (previous?.entries ?? []).map(({ sourceKey }) => sourceKey),
  );
  for (const entry of updates.values()) {
    if (previouslyObservedKeys.has(entry.sourceKey)) continue;
    for (const pair of observedPairs) {
      if (
        pair.sourceKey === entry.sourceKey &&
        !entries.has(pairKey(pair.sourceKey, pair.language))
      ) {
        entries.set(pairKey(pair.sourceKey, pair.language), {
          ...pair.entry,
          processed: false,
        });
      }
    }
  }
  for (const [id, entry] of updates) entries.set(id, entry);

  const next: ProcessingBaseline<TUnit, TTranslation, TUnavailable> = {
    formatVersion: FORMAT_VERSION,
    entries: [...entries.values()],
    sourceScopes,
  };
  try {
    await store.save(next);
    return { outcome: "saved", baseline: next, selections: selectionResults };
  } catch (error) {
    rethrowContractError(error);
    return {
      outcome: "failed",
      ...(previous === undefined ? {} : { baseline: previous }),
      selections: selectionResults.map((selection) =>
        selection.outcome === "advanced"
          ? { ...selection, outcome: "unknown" as const }
          : selection,
      ),
      failure: { phase: "save", message: errorMessage(error) },
    };
  }
}

export function validateProcessingBaseline(
  value: unknown,
): asserts value is ProcessingBaseline {
  assertJsonValue(value, "处理基线");
  if (!isRecord(value)) invalidBaseline("格式无效或版本不受支持。");
  const entries = value.entries;
  const sourceScopes = value.sourceScopes;
  if (
    value.formatVersion !== FORMAT_VERSION ||
    !isUnknownArray(entries) ||
    !isUnknownArray(sourceScopes)
  )
    invalidBaseline("格式无效或版本不受支持。");

  const seen = new Set<string>();
  for (const entry of entries) {
    if (
      !isRecord(entry) ||
      typeof entry.sourceKey !== "string" ||
      typeof entry.language !== "string" ||
      typeof entry.processed !== "boolean" ||
      !isRecord(entry.source) ||
      !Object.hasOwn(entry.source, "unit") ||
      !Object.hasOwn(entry.source, "range") ||
      (entry.source.presence !== "present" &&
        entry.source.presence !== "removed") ||
      !isRecord(entry.association) ||
      !isUnknownArray(entry.association.scopes) ||
      !isUnknownArray(entry.association.translations)
    ) {
      invalidBaseline("包含无效条目。");
    }
    if (
      !isAssociationStatus(entry.association.status) ||
      !isCoverageStatus(entry.association.coverageStatus) ||
      !isBodyAvailability(entry.source.bodyAvailability) ||
      !isEnumerationCompleteness(entry.source.enumeration)
    ) {
      invalidBaseline("包含无效状态。");
    }
    for (const [index, scope] of entry.association.scopes.entries()) {
      if (
        !isRecord(scope) ||
        !Object.hasOwn(scope, "range") ||
        !isUnknownArray(scope.covers) ||
        scope.covers.some((key) => typeof key !== "string") ||
        !isEnumerationCompleteness(scope.enumeration)
      )
        invalidBaseline("包含无效译文范围依据。");
      assertJsonValue(scope.range, `处理基线译文范围 ${index + 1}`);
    }
    for (const [
      index,
      translation,
    ] of entry.association.translations.entries()) {
      if (
        !isRecord(translation) ||
        !Object.hasOwn(translation, "range") ||
        !Object.hasOwn(translation, "translation") ||
        !isBodyAvailability(translation.bodyAvailability)
      )
        invalidBaseline("包含无效译文依据。");
      assertJsonValue(translation.range, `处理基线译文记录范围 ${index + 1}`);
      assertJsonValue(translation.translation, `处理基线译文记录 ${index + 1}`);
    }
    assertJsonValue(entry.source.unit, `处理基线原文 ${entry.sourceKey}`);
    assertJsonValue(entry.source.range, `处理基线原文范围 ${entry.sourceKey}`);
    const id = pairKey(entry.sourceKey, entry.language);
    if (seen.has(id)) invalidBaseline("包含重复的源身份与语言。");
    seen.add(id);
  }
  for (const [index, scope] of sourceScopes.entries()) {
    if (
      !isRecord(scope) ||
      !Object.hasOwn(scope, "range") ||
      !isEnumerationCompleteness(scope.enumeration) ||
      !isUnknownArray(scope.sourceKeys) ||
      scope.sourceKeys.some((key) => typeof key !== "string")
    ) {
      invalidBaseline("包含无效的原文范围依据。");
    }
    assertJsonValue(scope.range, `处理基线原文范围依据 ${index + 1}`);
  }
}

/** 将持久化结构按当前装配的 schema 验证并窄化为内部可消费的视图。 */
export async function validateProcessingBaselineHistory<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  value: unknown,
  config: FrameworkConfig<TUnit, TTranslation, TBody, TUnavailable>,
): Promise<ProcessingBaseline<TUnit, TTranslation, TUnavailable>> {
  validateProcessingBaseline(value);
  const entries: ProcessingBaselineEntry<TUnit, TTranslation, TUnavailable>[] =
    [];
  for (const entry of value.entries) {
    const unit = await validateWithStandardSchema(
      config.source.schema,
      entry.source.unit,
      `处理基线原文 ${entry.sourceKey}`,
      { preserveValue: true, requireJson: true },
    );
    const translations: ProcessingBaselineTranslation<
      TTranslation,
      TUnavailable
    >[] = [];
    for (const [index, previous] of entry.association.translations.entries()) {
      const adapter = config.translations;
      if (adapter === undefined)
        throw new StandardSchemaContractError(
          `处理基线译文 ${entry.sourceKey}/${entry.language}`,
          "schema-mismatch",
          "当前装配未声明处理历史所需的译文契约。",
        );
      if (previous.bodyAvailability === "available") {
        const translation = await validateWithStandardSchema(
          adapter.schema,
          previous.translation,
          `处理基线译文 ${entry.sourceKey}/${entry.language} #${index + 1}`,
          { preserveValue: true, requireJson: true },
        );
        const content = adapter.contentOf(translation);
        await validateWithStandardSchema(
          adapter.contentSchema,
          content,
          `处理基线译文正文 ${entry.sourceKey}/${entry.language} #${index + 1}`,
          { preserveValue: true, requireJson: true },
        );
        translations.push({
          ...previous,
          bodyAvailability: "available",
          translation,
        });
      } else {
        const unavailableSchema = adapter.unavailableSchema;
        if (unavailableSchema === undefined)
          throw new StandardSchemaContractError(
            `处理基线不可用译文 ${entry.sourceKey}/${entry.language}`,
            "schema-mismatch",
            "当前装配未声明处理历史中的不可用译文契约。",
          );
        const translation = await validateWithStandardSchema(
          unavailableSchema,
          previous.translation,
          `处理基线不可用译文 ${entry.sourceKey}/${entry.language} #${index + 1}`,
          { preserveValue: true, requireJson: true },
        );
        translations.push({
          ...previous,
          bodyAvailability: "unavailable",
          translation,
        });
      }
    }
    entries.push({
      ...entry,
      source: { ...entry.source, unit },
      association: { ...entry.association, translations },
    });
  }
  return { ...value, entries };
}

function currentPairs<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  facts: FrameworkFacts<TUnit, TTranslation, TBody, TUnavailable>,
): readonly {
  readonly sourceKey: string;
  readonly language: string;
  readonly entry: ProcessingBaselineEntry<TUnit, TTranslation, TUnavailable>;
}[] {
  const pairs: {
    sourceKey: string;
    language: string;
    entry: ProcessingBaselineEntry<TUnit, TTranslation, TUnavailable>;
  }[] = [];
  const readsByLanguage = new Map(
    facts.translations.reads.map((read) => [read.language, read]),
  );
  const associationsByPair = new Map(
    facts.associations.map((association) => [
      pairKey(association.sourceKey, association.language),
      association,
    ]),
  );
  for (const source of facts.source.units) {
    for (const language of readsByLanguage.keys()) {
      pairs.push({
        sourceKey: source.key,
        language,
        entry: currentEntry(
          facts,
          source,
          language,
          readsByLanguage.get(language),
          associationsByPair.get(pairKey(source.key, language)),
        ),
      });
    }
  }
  return pairs;
}

function snapshotSourceScopes<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  facts: FrameworkFacts<TUnit, TTranslation, TBody, TUnavailable>,
): ProcessingBaselineSourceScope[] {
  const keysByScope = new Map<number, string[]>();
  for (const source of facts.source.units) {
    const keys = keysByScope.get(source.scopeIndex) ?? [];
    keys.push(source.key);
    keysByScope.set(source.scopeIndex, keys);
  }
  return facts.source.read.scopes.map((scope, scopeIndex) => ({
    range: scope.range,
    enumeration: scope.enumeration,
    sourceKeys: keysByScope.get(scopeIndex) ?? [],
  }));
}

function uniqueRanges(ranges: readonly unknown[]): unknown[] {
  const seen = new Set<string>();
  const unique: unknown[] = [];
  for (const range of ranges) {
    const key = canonicalJson(range);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(range);
  }
  return unique;
}

function currentEntry<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  facts: FrameworkFacts<TUnit, TTranslation, TBody, TUnavailable>,
  source: UnitWithKey<TUnit>,
  language: string,
  languageRead:
    | FrameworkFacts<
        TUnit,
        TTranslation,
        TBody,
        TUnavailable
      >["translations"]["reads"][number]
    | undefined,
  association:
    | FrameworkFacts<
        TUnit,
        TTranslation,
        TBody,
        TUnavailable
      >["associations"][number]
    | undefined,
): ProcessingBaselineEntry<TUnit, TTranslation, TUnavailable> {
  const sourceScope = facts.source.read.scopes[source.scopeIndex];
  const scopes =
    languageRead === undefined || association === undefined
      ? []
      : association.scopeIndexes.flatMap((scopeIndex) => {
          const scope = languageRead.scopes[scopeIndex];
          return scope === undefined
            ? []
            : [
                {
                  range: scope.range,
                  covers: [source.key],
                  enumeration: scope.enumeration,
                },
              ];
        });
  const translations =
    association === undefined
      ? []
      : association.translationIndexes.flatMap((translationIndex) => {
          const translation = facts.translations.records[translationIndex];
          return translation === undefined
            ? []
            : [baselineTranslation(translation)];
        });
  return {
    sourceKey: source.key,
    language,
    processed: false,
    source: {
      presence: "present",
      unit: source.unit,
      bodyAvailability: source.bodyAvailability,
      range: sourceScope?.range,
      enumeration: sourceScope?.enumeration ?? "failed",
    },
    association: {
      status: association?.status ?? "unknown",
      coverageStatus: association?.coverageStatus ?? "notRead",
      scopes,
      translations,
    },
  };
}

function baselineTranslation<TTranslation, TBody, TUnavailable>(
  translation: ActualTranslationFact<TTranslation, TBody, TUnavailable>,
): ProcessingBaselineTranslation<TTranslation, TUnavailable> {
  if (translation.bodyAvailability === "available")
    return {
      range: translation.range,
      translation: translation.translation,
      bodyAvailability: "available",
    };
  return {
    range: translation.range,
    translation: translation.translation,
    bodyAvailability: "unavailable",
  };
}

function comparePresentEntry(
  previous: ProcessingBaselineEntry,
  current: ProcessingBaselineEntry,
): ProcessingChangeStatus {
  if (current.association.status === "conflict") return "conflict";
  if (current.association.status === "unknown") return "unknown";
  if (previous.association.status === "conflict") return "conflict";
  if (previous.association.status === "unknown") return "history-insufficient";
  return sameObservedState(previous, current) ? "unchanged" : "changed";
}

function sameObservedState(
  previous: ProcessingBaselineEntry,
  current: ProcessingBaselineEntry,
): boolean {
  return (
    previous.source.presence === current.source.presence &&
    sameJson(previous.source.unit, current.source.unit) &&
    previous.source.bodyAvailability === current.source.bodyAvailability &&
    sameJson(previous.source.range, current.source.range) &&
    previous.association.status === current.association.status &&
    sameJson(
      previous.association.translations,
      current.association.translations,
    )
  );
}

function confirmedSourceRemovalScope<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  facts: FrameworkFacts<TUnit, TTranslation, TBody, TUnavailable>,
  previous: ProcessingBaselineEntry<TUnit, TTranslation, TUnavailable>,
  historicalScopes: readonly ProcessingBaselineSourceScope[],
):
  | FrameworkFacts<
      TUnit,
      TTranslation,
      TBody,
      TUnavailable
    >["source"]["read"]["scopes"][number]
  | undefined {
  if (
    previous.source.enumeration !== "complete" ||
    !historicalScopes.some(
      (scope) =>
        sameJson(scope.range, previous.source.range) &&
        scope.sourceKeys.includes(previous.sourceKey),
    )
  )
    return undefined;

  const currentSourceScopes = facts.source.read.scopes.filter(({ range }) =>
    sameJson(range, previous.source.range),
  );
  if (
    currentSourceScopes.length === 0 ||
    currentSourceScopes.some(({ enumeration }) => enumeration !== "complete")
  )
    return undefined;
  return currentSourceScopes[0];
}

function currentRemovedEntry<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  facts: FrameworkFacts<TUnit, TTranslation, TBody, TUnavailable>,
  previous: ProcessingBaselineEntry<TUnit, TTranslation, TUnavailable>,
  historicalScopes: readonly ProcessingBaselineSourceScope[],
  matches?: (unit: TUnit, translation: TTranslation | TUnavailable) => boolean,
): ProcessingBaselineEntry<TUnit, TTranslation, TUnavailable> | undefined {
  const sourceScope = confirmedSourceRemovalScope(
    facts,
    previous,
    historicalScopes,
  );
  if (sourceScope === undefined) return undefined;
  const languageRead = facts.translations.reads.find(
    (read) => read.language === previous.language,
  );

  const scopes =
    languageRead === undefined
      ? []
      : previous.association.scopes.flatMap((oldScope) =>
          languageRead.scopes
            .filter(({ range }) => sameJson(range, oldScope.range))
            .map((scope) => ({
              range: scope.range,
              covers: [previous.sourceKey],
              enumeration: scope.enumeration,
            })),
        );
  const missingHistoricalScope = previous.association.scopes.some(
    (oldScope) => !scopes.some(({ range }) => sameJson(range, oldScope.range)),
  );
  const coverageStatus = removedAssociationCoverage(
    languageRead,
    previous.association.scopes,
    scopes,
    missingHistoricalScope,
  );
  const currentTranslations =
    matches === undefined
      ? []
      : facts.translations.records.filter(
          (record) =>
            record.language === previous.language &&
            scopes.some(({ range }) => sameJson(range, record.range)) &&
            matches(previous.source.unit, record.translation),
        );
  const status: TranslationAssociationStatus =
    currentTranslations.length > 1
      ? "conflict"
      : matches === undefined || coverageStatus !== "complete"
        ? "unknown"
        : currentTranslations.length === 0
          ? "missing"
          : currentTranslations[0]?.bodyAvailability === "available"
            ? "matched"
            : "unavailable";

  return {
    ...previous,
    processed: false,
    source: {
      ...previous.source,
      presence: "removed",
      enumeration: sourceScope.enumeration,
    },
    association: {
      status,
      coverageStatus,
      scopes,
      translations: currentTranslations.map(baselineTranslation),
    },
  };
}

function removedAssociationCoverage(
  languageRead:
    | FrameworkFacts<
        TranslationUnitInput,
        unknown
      >["translations"]["reads"][number]
    | undefined,
  previousScopes: readonly ProcessingBaselineTranslationScope[],
  currentScopes: readonly ProcessingBaselineTranslationScope[],
  missingHistoricalScope: boolean,
): CoverageStatus {
  if (languageRead === undefined) return "notRead";
  if (languageRead.error !== undefined) return "failed";
  if (previousScopes.length === 0) return "notRead";
  if (currentScopes.some(({ enumeration }) => enumeration === "failed"))
    return "failed";
  if (missingHistoricalScope) return "incomplete";
  if (currentScopes.some(({ enumeration }) => enumeration === "partial"))
    return "incomplete";
  return "complete";
}

function uniqueSelections(
  selections: readonly ProcessingBaselineSelection[],
): readonly ProcessingBaselineSelection[] {
  const unique = new Map<string, ProcessingBaselineSelection>();
  for (const selection of selections)
    unique.set(pairKey(selection.sourceKey, selection.language), selection);
  return [...unique.values()];
}

function pairKey(sourceKey: string, language: string): string {
  return JSON.stringify([sourceKey, language]);
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function canonicalJson(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined) return "undefined";
  return JSON.stringify(sortJsonKeys(JSON.parse(json) as unknown));
}

function sortJsonKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonKeys);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => [key, sortJsonKeys(item)]),
  );
}

function isAssociationStatus(
  status: unknown,
): status is TranslationAssociationStatus {
  return (
    status === "matched" ||
    status === "missing" ||
    status === "unavailable" ||
    status === "unknown" ||
    status === "conflict"
  );
}

function isCoverageStatus(status: unknown): status is CoverageStatus {
  return (
    status === "complete" ||
    status === "incomplete" ||
    status === "failed" ||
    status === "notRead"
  );
}

function isBodyAvailability(
  availability: unknown,
): availability is BodyAvailability {
  return availability === "available" || availability === "unavailable";
}

function isEnumerationCompleteness(
  completeness: unknown,
): completeness is EnumerationCompleteness {
  return (
    completeness === "complete" ||
    completeness === "partial" ||
    completeness === "failed"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function invalidBaseline(message: string): never {
  throw new StandardSchemaContractError(
    "处理基线",
    "schema-mismatch",
    `处理基线${message}`,
  );
}

function rethrowContractError(error: unknown): void {
  if (error instanceof StandardSchemaContractError) throw error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
