import {
  compareProcessingBaseline,
  validateProcessingBaseline,
  type ProcessingBaseline,
  type ProcessingBaselineChange,
  type ProcessingBaselineEntry,
  type ProcessingBaselineSourceScope,
  type ProcessingBaselineTranslationScope,
  type ProcessingChangeStatus,
} from "./baselines.ts";
import type {
  BodyAvailability,
  CoverageStatus,
  EnumerationCompleteness,
  FrameworkConfig,
  FrameworkFacts,
  TranslationAssociationStatus,
  TranslationUnitInput,
} from "./index.ts";

export type UpdatePlanObservation<TSource = unknown, TTranslation = unknown> = {
  readonly source: {
    readonly presence: "present" | "removed";
    readonly value?: TSource;
    readonly bodyAvailability: BodyAvailability;
    readonly range: unknown;
    readonly enumeration: EnumerationCompleteness;
  };
  readonly association: {
    readonly status: TranslationAssociationStatus;
    readonly coverageStatus: CoverageStatus;
    readonly scopes: readonly ProcessingBaselineTranslationScope[];
    readonly translations: readonly {
      readonly range: unknown;
      readonly translation: TTranslation;
      readonly bodyAvailability: BodyAvailability;
    }[];
  };
};

export type UpdateRecommendation =
  | { readonly action: "retain"; readonly reason?: string }
  | {
      readonly action: "candidate";
      readonly candidate: unknown;
      readonly reason?: string;
    }
  | { readonly action: "delete"; readonly reason?: string }
  | { readonly action: "review"; readonly reason: string }
  | { readonly action: "none"; readonly reason?: string };

export type UpdatePolicyInput<
  TUnit extends TranslationUnitInput,
  TTranslation,
> = {
  readonly sourceKey: string;
  readonly language: string;
  readonly change: ProcessingChangeStatus;
  readonly processed: boolean;
  readonly previous?: UpdatePlanObservation<TUnit["source"], TTranslation>;
  readonly expectedInput?: UpdatePlanObservation<TUnit["source"], TTranslation>;
  readonly sourceUnit?: TUnit;
  readonly translations: readonly TTranslation[];
};

export type UpdatePolicy<TUnit extends TranslationUnitInput, TTranslation> = (
  input: UpdatePolicyInput<TUnit, TTranslation>,
) => UpdateRecommendation;

export type UpdatePlanItem<TSource = unknown, TTranslation = unknown> = {
  readonly sourceKey: string;
  readonly language: string;
  readonly change: ProcessingChangeStatus;
  readonly processed: boolean;
  readonly previous?: ProcessingBaselineEntry;
  readonly current?: ProcessingBaselineEntry;
  readonly expectedInput?: UpdatePlanObservation<TSource, TTranslation>;
  readonly recommendation: UpdateRecommendation;
  readonly executable: boolean;
  readonly blockedReason?: string;
};

export type UpdatePlan<
  TUnit extends TranslationUnitInput = TranslationUnitInput,
  TTranslation = unknown,
> = {
  readonly formatVersion: 1;
  readonly sourceScopeEvidence: readonly ProcessingBaselineSourceScope[];
  readonly items: readonly UpdatePlanItem<TUnit["source"], TTranslation>[];
};

export type UpdatePlanStore = {
  load(): Promise<UpdatePlan | undefined>;
  save(plan: UpdatePlan): Promise<void>;
};

export function defaultUpdatePolicy<
  TUnit extends TranslationUnitInput,
  TTranslation,
>(input: UpdatePolicyInput<TUnit, TTranslation>): UpdateRecommendation {
  if (input.change === "history-insufficient")
    return {
      action: "review",
      reason: "缺少处理历史，无法确认本次变化。",
    };
  if (input.change === "unknown")
    return {
      action: "review",
      reason: "相关原文或译文范围尚未可靠读取。",
    };
  if (input.change === "conflict")
    return { action: "review", reason: "原文与译文存在关联冲突。" };
  if (input.change === "added") {
    return input.expectedInput?.association.status === "matched"
      ? { action: "retain", reason: "保留当前译文。" }
      : {
          action: "review",
          reason: "新增原文尚无可保留的译文，请确认后续处理。",
        };
  }
  if (input.change === "source-removed")
    return {
      action: "retain",
      reason: "保留当前目标内容，不自动删除目标独有条目。",
    };
  if (
    input.change === "changed" &&
    input.expectedInput?.association.status !== "matched"
  )
    return {
      action: "review",
      reason: "当前没有可保留的译文，请核查变化；不自动删除未关联的目标条目。",
    };
  if (input.change === "changed")
    return {
      action: "retain",
      reason: "保留当前译文；若原文发生变化，请核查其影响。",
    };
  if (input.processed)
    return { action: "none", reason: "该范围没有新的待处理变化。" };
  return { action: "retain", reason: "保留当前内容。" };
}

export function createUpdatePlan<
  TUnit extends TranslationUnitInput,
  TTranslation,
>(
  facts: FrameworkFacts<TUnit, TTranslation>,
  baseline: ProcessingBaseline | undefined,
  config: Pick<
    FrameworkConfig<TUnit, TTranslation>,
    "translations" | "updatePolicy"
  > = {},
): UpdatePlan<TUnit, TTranslation> {
  const matches = config.translations?.matches;
  const changes = compareProcessingBaseline(
    facts,
    baseline,
    matches === undefined ? {} : { matches },
  );
  const addedRanges = changes.changes.flatMap((change) =>
    change.status === "added" && change.current !== undefined
      ? [change.current.source.range]
      : [],
  );
  const sourceScopeEvidence = structuredClone(
    (baseline?.sourceScopes ?? []).filter((scope) =>
      addedRanges.some((range) => sameJson(scope.range, range)),
    ),
  );
  const policy = config.updatePolicy ?? defaultUpdatePolicy;
  const items = changes.changes.map((change) => {
    const previousEntry =
      change.previous === undefined
        ? undefined
        : structuredClone(change.previous);
    const currentEntry =
      change.current === undefined
        ? undefined
        : structuredClone(change.current);
    const previousObservation =
      change.previous === undefined
        ? undefined
        : observe<TUnit, TTranslation>(change.previous);
    const expectedInput =
      change.current === undefined
        ? undefined
        : observe<TUnit, TTranslation>(change.current);
    const previousBasis =
      previousObservation === undefined
        ? undefined
        : structuredClone(previousObservation);
    const expectedBasis =
      expectedInput === undefined ? undefined : structuredClone(expectedInput);
    const sourceUnit = currentSourceUnit(facts, change);
    const translations =
      expectedInput?.association.translations.map(
        ({ translation }) => translation,
      ) ?? [];
    const recommendation = structuredClone(
      policy({
        sourceKey: change.sourceKey,
        language: change.language,
        change: change.status,
        processed: change.processed,
        ...(previousObservation === undefined
          ? {}
          : { previous: previousObservation }),
        ...(expectedInput === undefined ? {} : { expectedInput }),
        ...(sourceUnit === undefined ? {} : { sourceUnit }),
        translations,
      }),
    );
    const blockedReason = executionBlockReason(
      change,
      previousBasis,
      expectedBasis,
      recommendation,
      sourceScopeEvidence,
    );
    return {
      sourceKey: change.sourceKey,
      language: change.language,
      change: change.status,
      processed: change.processed,
      ...(previousEntry === undefined ? {} : { previous: previousEntry }),
      ...(currentEntry === undefined ? {} : { current: currentEntry }),
      ...(expectedBasis === undefined ? {} : { expectedInput: expectedBasis }),
      recommendation,
      executable: blockedReason === undefined,
      ...(blockedReason === undefined ? {} : { blockedReason }),
    };
  });

  return { formatVersion: 1, sourceScopeEvidence, items };
}

export function validateUpdatePlan(
  value: UpdatePlan,
): asserts value is UpdatePlan {
  if (
    typeof value !== "object" ||
    value === null ||
    value.formatVersion !== 1 ||
    !Array.isArray(value.sourceScopeEvidence) ||
    !Array.isArray(value.items)
  ) {
    throw new TypeError("更新计划格式无效或版本不受支持。");
  }
  for (const scope of value.sourceScopeEvidence) {
    if (
      typeof scope !== "object" ||
      scope === null ||
      !isEnumerationCompleteness(scope.enumeration) ||
      !Array.isArray(scope.sourceKeys) ||
      scope.sourceKeys.some((key: unknown) => typeof key !== "string")
    ) {
      throw new TypeError("更新计划包含无效的原文范围依据。");
    }
  }
  const seen = new Set<string>();
  for (const item of value.items) {
    if (
      typeof item !== "object" ||
      item === null ||
      typeof item.sourceKey !== "string" ||
      typeof item.language !== "string" ||
      typeof item.processed !== "boolean" ||
      typeof item.executable !== "boolean" ||
      !isChangeStatus(item.change) ||
      !isRecommendation(item.recommendation) ||
      (item.previous !== undefined && !isBaselineEntry(item.previous)) ||
      (item.current !== undefined && !isBaselineEntry(item.current)) ||
      (item.expectedInput !== undefined &&
        !isUpdatePlanObservation(item.expectedInput)) ||
      (!item.executable && typeof item.blockedReason !== "string") ||
      (item.executable && item.blockedReason !== undefined)
    ) {
      throw new TypeError("更新计划包含无效条目。");
    }
    const key = JSON.stringify([item.sourceKey, item.language]);
    if (seen.has(key))
      throw new TypeError("更新计划包含重复的原文身份与语言。");
    seen.add(key);
  }
}

function observe<TUnit extends TranslationUnitInput, TTranslation>(
  entry: ProcessingBaselineEntry,
): UpdatePlanObservation<TUnit["source"], TTranslation> {
  const unit = entry.source.unit as TUnit;
  return {
    source: {
      presence: entry.source.presence,
      ...(entry.source.presence === "present"
        ? { value: unit.source as TUnit["source"] }
        : {}),
      bodyAvailability: entry.source.bodyAvailability,
      range: entry.source.range,
      enumeration: entry.source.enumeration,
    },
    association: {
      status: entry.association.status,
      coverageStatus: entry.association.coverageStatus,
      scopes: entry.association.scopes.map((scope) => ({ ...scope })),
      translations: entry.association.translations.map((translation) => ({
        ...translation,
        translation: translation.translation as TTranslation,
      })),
    },
  };
}

function currentSourceUnit<TUnit extends TranslationUnitInput, TTranslation>(
  facts: FrameworkFacts<TUnit, TTranslation>,
  change: ProcessingBaselineChange,
): TUnit | undefined {
  const current = facts.source.units.find(
    ({ key }) => key === change.sourceKey,
  );
  if (current !== undefined) return current.unit;
  const oldUnit = change.current?.source.unit ?? change.previous?.source.unit;
  return oldUnit as TUnit | undefined;
}

function executionBlockReason<TSource, TTranslation>(
  change: ProcessingBaselineChange,
  previous: UpdatePlanObservation<TSource, TTranslation> | undefined,
  expectedInput: UpdatePlanObservation<TSource, TTranslation> | undefined,
  recommendation: UpdateRecommendation,
  sourceScopeEvidence: readonly ProcessingBaselineSourceScope[],
): string | undefined {
  if (change.status === "history-insufficient")
    return "缺少足够的历史依据，不能安全执行。";
  if (change.status === "unknown")
    return "相关范围的读取证据不足，不能安全执行。";
  if (change.status === "conflict") return "源译关联存在冲突，不能安全执行。";
  if (expectedInput === undefined)
    return "缺少当前原文或译文范围依据，不能校验计划输入。";
  if (recommendation.action === "review") return recommendation.reason;
  if (recommendation.action === "none")
    return recommendation.reason ?? "策略未建议处理此项。";
  const currentBlock = observationBlockReason(expectedInput);
  if (currentBlock !== undefined) return currentBlock;
  if (previous !== undefined) {
    const previousBlock = observationBlockReason(previous);
    if (previousBlock !== undefined) return `历史依据不足：${previousBlock}`;
  }
  if (
    recommendation.action === "delete" &&
    expectedInput.association.translations.length === 0
  )
    return "没有可关联到该原文的目标条目，不能建议删除。";
  if (recommendation.action === "delete")
    return "当前语义编辑契约不支持删除译文，不能执行该建议。";
  if (change.status === "added") {
    const matchingScopes = sourceScopeEvidence.filter(({ range }) =>
      sameJson(range, expectedInput.source.range),
    );
    if (
      matchingScopes.length === 0 ||
      matchingScopes.some(
        ({ enumeration, sourceKeys }) =>
          enumeration !== "complete" || sourceKeys.includes(change.sourceKey),
      )
    ) {
      return "没有完整的历史原文范围依据证明此项为新增。";
    }
  }
  return undefined;
}

function observationBlockReason<TSource, TTranslation>(
  observation: UpdatePlanObservation<TSource, TTranslation>,
): string | undefined {
  if (observation.source.enumeration !== "complete")
    return "原文范围枚举不完整。";
  if (observation.source.bodyAvailability !== "available")
    return "原文内容不可用。";
  if (observation.association.coverageStatus !== "complete")
    return "译文范围覆盖不完整。";
  if (
    observation.association.status === "unknown" ||
    observation.association.status === "conflict"
  )
    return "源译关联未知或存在冲突。";
  if (
    observation.association.scopes.length === 0 ||
    observation.association.scopes.some(
      ({ enumeration }) => enumeration !== "complete",
    )
  )
    return "相关译文范围枚举不完整。";
  if (
    observation.association.translations.some(
      ({ bodyAvailability }) => bodyAvailability !== "available",
    )
  )
    return "相关译文内容不可用。";
  return undefined;
}

function isRecommendation(value: unknown): value is UpdateRecommendation {
  if (typeof value !== "object" || value === null || !("action" in value))
    return false;
  const recommendation = value as Record<string, unknown>;
  if (
    recommendation.action === "retain" ||
    recommendation.action === "delete" ||
    recommendation.action === "none"
  )
    return (
      !("reason" in recommendation) || typeof recommendation.reason === "string"
    );
  if (recommendation.action === "candidate")
    return (
      "candidate" in recommendation &&
      (!("reason" in recommendation) ||
        typeof recommendation.reason === "string")
    );
  return (
    recommendation.action === "review" &&
    typeof recommendation.reason === "string"
  );
}

function isBaselineEntry(value: ProcessingBaselineEntry): boolean {
  try {
    validateProcessingBaseline({
      formatVersion: 1,
      entries: [value],
      sourceScopes: [],
    });
    return true;
  } catch {
    return false;
  }
}

function isUpdatePlanObservation(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  if (!("source" in value) || !("association" in value)) return false;
  const observation = value as Record<string, unknown>;
  const source = observation.source as Record<string, unknown>;
  const association = observation.association as Record<string, unknown>;
  if (
    typeof source !== "object" ||
    source === null ||
    (source.presence !== "present" && source.presence !== "removed") ||
    !isBodyAvailability(source.bodyAvailability) ||
    !isEnumerationCompleteness(source.enumeration) ||
    typeof association !== "object" ||
    association === null ||
    !isAssociationStatus(association.status) ||
    !isCoverageStatus(association.coverageStatus) ||
    !Array.isArray(association.scopes) ||
    !Array.isArray(association.translations)
  ) {
    return false;
  }
  return (
    association.scopes.every((scope: unknown) => {
      if (typeof scope !== "object" || scope === null || !("range" in scope))
        return false;
      const translationScope = scope as Record<string, unknown>;
      return (
        Array.isArray(translationScope.covers) &&
        translationScope.covers.every(
          (key: unknown) => typeof key === "string",
        ) &&
        isEnumerationCompleteness(translationScope.enumeration)
      );
    }) &&
    association.translations.every((translation: unknown) => {
      if (
        typeof translation !== "object" ||
        translation === null ||
        !("range" in translation) ||
        !("translation" in translation)
      )
        return false;
      return isBodyAvailability(
        (translation as Record<string, unknown>).bodyAvailability,
      );
    })
  );
}

function isChangeStatus(value: unknown): value is ProcessingChangeStatus {
  return (
    value === "history-insufficient" ||
    value === "added" ||
    value === "unchanged" ||
    value === "changed" ||
    value === "source-removed" ||
    value === "unknown" ||
    value === "conflict"
  );
}

function isEnumerationCompleteness(
  value: unknown,
): value is EnumerationCompleteness {
  return value === "complete" || value === "partial" || value === "failed";
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

function isAssociationStatus(
  value: unknown,
): value is TranslationAssociationStatus {
  return (
    value === "matched" ||
    value === "missing" ||
    value === "unavailable" ||
    value === "unknown" ||
    value === "conflict"
  );
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
