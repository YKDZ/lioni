import { isDeepStrictEqual } from "node:util";

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
import {
  prepareSemanticDeletion,
  prepareSemanticEdit,
  resolveSemanticDeleteInput,
  resolveSemanticEditInput,
  type JsonValue,
  type SemanticEdit,
  type SemanticEditCandidate,
} from "./semantic-edits.ts";

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

export type UpdateDecision =
  | { readonly action: "retain"; readonly reason?: string }
  | {
      readonly action: "candidate";
      readonly candidate: SemanticEditCandidate;
      readonly reason?: string;
    }
  | { readonly action: "delete"; readonly reason?: string }
  | { readonly action: "review"; readonly reason?: string }
  | { readonly action: "none"; readonly reason?: string };

export type UpdatePlanStatus =
  | "candidate"
  | "delete"
  | "retain"
  | "review"
  | "notProcessed"
  | "blocked";

export type UpdatePlanBlockCode =
  | "historyInsufficient"
  | "changeUnknown"
  | "associationConflict"
  | "planBaselineChanged"
  | "planInputChanged"
  | "currentInputUnavailable"
  | "missingCurrentInput"
  | "sourceEnumerationIncomplete"
  | "sourceUnavailable"
  | "translationCoverageIncomplete"
  | "associationUnknown"
  | "associationUnavailable"
  | "translationScopeIncomplete"
  | "translationUnavailable"
  | "previousInputIncomplete"
  | "addedSourceEvidenceIncomplete"
  | "deleteTargetUnavailable"
  | "deleteRequiresSourceRemoval"
  | "sourceRemoved"
  | "candidateIdentityMismatch"
  | "semanticEditInputUnavailable";

export type UpdatePlanBlock = {
  readonly code: UpdatePlanBlockCode;
  readonly message?: string;
};

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
) => UpdateDecision;

export type UpdatePlanItem<TSource = unknown, TTranslation = unknown> = {
  readonly sourceKey: string;
  readonly language: string;
  readonly change: ProcessingChangeStatus;
  readonly processed: boolean;
  readonly previous?: ProcessingBaselineEntry;
  readonly current?: ProcessingBaselineEntry;
  readonly expectedInput?: UpdatePlanObservation<TSource, TTranslation>;
  readonly decision: UpdateDecision;
  readonly status: UpdatePlanStatus;
  readonly blocker?: UpdatePlanBlock;
  readonly edit?: SemanticEdit;
};

export type UpdatePlan<
  TUnit extends TranslationUnitInput = TranslationUnitInput,
  TTranslation = unknown,
> = {
  readonly formatVersion: 3;
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
>(input: UpdatePolicyInput<TUnit, TTranslation>): UpdateDecision {
  if (input.change === "history-insufficient")
    return { action: "review", reason: "缺少处理历史，无法确认本次变化。" };
  if (input.change === "unknown")
    return { action: "review", reason: "相关原文或译文范围尚未可靠读取。" };
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

/** 根据变化、历史与策略计算已确定的更新意图。 */
export async function createUpdatePlan<
  TUnit extends TranslationUnitInput,
  TTranslation,
>(
  facts: FrameworkFacts<TUnit, TTranslation>,
  baseline: ProcessingBaseline | undefined,
  config: Pick<
    FrameworkConfig<TUnit, TTranslation>,
    "translations" | "translationWriteback" | "updatePolicy"
  > = {},
): Promise<UpdatePlan<TUnit, TTranslation>> {
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
  const items: UpdatePlanItem<TUnit["source"], TTranslation>[] = [];

  for (const change of changes.changes) {
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
    const decision = structuredClone(
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

    const baseItem = {
      sourceKey: change.sourceKey,
      language: change.language,
      change: change.status,
      processed: change.processed,
      ...(previousEntry === undefined ? {} : { previous: previousEntry }),
      ...(currentEntry === undefined ? {} : { current: currentEntry }),
      ...(expectedBasis === undefined ? {} : { expectedInput: expectedBasis }),
      decision,
    };

    if (decision.action === "review") {
      items.push({ ...baseItem, status: "review" });
      continue;
    }
    if (decision.action === "none") {
      items.push({ ...baseItem, status: "notProcessed" });
      continue;
    }

    const blocker = processingBlocker(
      change,
      previousBasis,
      expectedBasis,
      decision,
      sourceScopeEvidence,
    );
    if (blocker !== undefined) {
      items.push({ ...baseItem, status: "blocked", blocker });
      continue;
    }

    if (decision.action === "delete") {
      const historicalSource = change.previous?.source.unit as
        | TUnit
        | undefined;
      if (
        historicalSource === undefined ||
        expectedBasis?.source.presence !== "removed"
      ) {
        items.push({
          ...baseItem,
          status: "blocked",
          blocker: {
            code: "deleteTargetUnavailable",
            message: "缺少用于定位删除目标的历史原文。",
          },
        });
        continue;
      }
      const resolved = await resolveSemanticDeleteInput(
        facts,
        { sourceKey: change.sourceKey, language: change.language },
        historicalSource,
        expectedBasis.source.range,
        expectedBasis.association.scopes.map(({ range }) => range),
        config as FrameworkConfig<TUnit, TTranslation>,
      );
      if (resolved.status !== "resolved") {
        items.push({
          ...baseItem,
          status: "blocked",
          blocker: {
            code: "semanticEditInputUnavailable",
            message: resolved.reason,
          },
        });
        continue;
      }
      const prepared = prepareSemanticDeletion(resolved.input);
      if (prepared.status !== "prepared") {
        items.push({
          ...baseItem,
          status: "blocked",
          blocker: {
            code: "semanticEditInputUnavailable",
            message: prepared.reason,
          },
        });
        continue;
      }
      items.push({
        ...baseItem,
        status: "delete",
        edit: prepared.edit,
      });
      continue;
    }
    if (decision.action === "retain") {
      items.push({ ...baseItem, status: "retain" });
      continue;
    }

    const candidate = decision.candidate;
    if (
      candidate.sourceKey !== change.sourceKey ||
      candidate.language !== change.language
    ) {
      items.push({
        ...baseItem,
        status: "blocked",
        blocker: {
          code: "candidateIdentityMismatch",
          message: "策略候选与计划项的原文身份或语言不匹配。",
        },
      });
      continue;
    }
    const resolved = await resolveSemanticEditInput(
      facts,
      { sourceKey: change.sourceKey, language: change.language },
      config as FrameworkConfig<TUnit, TTranslation>,
    );
    if (resolved.status !== "resolved") {
      items.push({
        ...baseItem,
        status: "blocked",
        blocker: {
          code: "semanticEditInputUnavailable",
          message: resolved.reason,
        },
      });
      continue;
    }
    const prepared = prepareSemanticEdit(resolved.input, candidate);
    if (prepared.status !== "prepared") {
      items.push({
        ...baseItem,
        status: "blocked",
        blocker: {
          code: "semanticEditInputUnavailable",
          message: prepared.reason,
        },
      });
      continue;
    }
    items.push({ ...baseItem, status: "candidate", edit: prepared.edit });
  }

  return { formatVersion: 3, sourceScopeEvidence, items };
}

export function validateUpdatePlan(
  value: UpdatePlan,
): asserts value is UpdatePlan {
  if (
    typeof value !== "object" ||
    value === null ||
    value.formatVersion !== 3 ||
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
      !isChangeStatus(item.change) ||
      !isUpdateDecision(item.decision) ||
      !isUpdatePlanStatus(item.status) ||
      (item.previous !== undefined && !isBaselineEntry(item.previous)) ||
      (item.current !== undefined && !isBaselineEntry(item.current)) ||
      (item.expectedInput !== undefined &&
        !isUpdatePlanObservation(item.expectedInput)) ||
      (item.blocker !== undefined && !isUpdatePlanBlock(item.blocker)) ||
      (item.edit !== undefined && !isSemanticEdit(item.edit)) ||
      !matchesDecisionState(item)
    ) {
      throw new TypeError("更新计划包含无效条目。");
    }
    const key = JSON.stringify([item.sourceKey, item.language]);
    if (seen.has(key))
      throw new TypeError("更新计划包含重复的原文身份与语言。");
    seen.add(key);
  }
}

function matchesDecisionState(item: UpdatePlanItem): boolean {
  if (item.status === "blocked")
    return item.blocker !== undefined && item.edit === undefined;
  if (item.blocker !== undefined) return false;
  if (item.status === "candidate")
    return (
      item.decision.action === "candidate" &&
      item.edit !== undefined &&
      item.edit.operation === "write" &&
      item.edit.sourceKey === item.sourceKey &&
      item.edit.language === item.language &&
      isDeepStrictEqual(item.edit.content, item.decision.candidate.content)
    );
  if (item.status === "delete")
    return (
      item.decision.action === "delete" &&
      item.edit?.operation === "delete" &&
      item.edit.sourceKey === item.sourceKey &&
      item.edit.language === item.language
    );
  if (item.edit !== undefined) return false;
  if (item.status === "retain") return item.decision.action === "retain";
  if (item.status === "review") return item.decision.action === "review";
  return item.decision.action === "none";
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
  return facts.source.units.find(({ key }) => key === change.sourceKey)?.unit;
}

function processingBlocker<TSource, TTranslation>(
  change: ProcessingBaselineChange,
  previous: UpdatePlanObservation<TSource, TTranslation> | undefined,
  expectedInput: UpdatePlanObservation<TSource, TTranslation> | undefined,
  decision: UpdateDecision,
  sourceScopeEvidence: readonly ProcessingBaselineSourceScope[],
): UpdatePlanBlock | undefined {
  if (change.status === "history-insufficient")
    return { code: "historyInsufficient", message: "缺少足够的历史依据。" };
  if (change.status === "unknown")
    return { code: "changeUnknown", message: "相关范围的读取证据不足。" };
  if (change.status === "conflict")
    return { code: "associationConflict", message: "源译关联存在冲突。" };
  if (expectedInput === undefined)
    return {
      code: "missingCurrentInput",
      message: "缺少当前原文或译文范围依据。",
    };
  const currentBlock = observationBlocker(expectedInput);
  if (currentBlock !== undefined) return currentBlock;
  if (previous !== undefined) {
    const previousBlock = observationBlocker(previous);
    if (previousBlock !== undefined)
      return {
        code: "previousInputIncomplete",
        message: `历史依据不足：${previousBlock.message ?? previousBlock.code}`,
      };
  }
  if (decision.action === "delete") {
    if (
      change.status !== "source-removed" ||
      expectedInput.source.presence !== "removed"
    )
      return {
        code: "deleteRequiresSourceRemoval",
        message: "只能在原文已确认移除后处理删除译文。",
      };
    if (
      expectedInput.association.status !== "matched" ||
      expectedInput.association.translations.length !== 1
    )
      return {
        code: "deleteTargetUnavailable",
        message: "没有唯一且可读取的历史关联目标。",
      };
  }
  if (
    decision.action === "candidate" &&
    expectedInput.source.presence !== "present"
  )
    return {
      code: "sourceRemoved",
      message: "已移除原文没有可写入的候选目标。",
    };
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
      return {
        code: "addedSourceEvidenceIncomplete",
        message: "没有完整的历史原文范围依据证明此项为新增。",
      };
    }
  }
  return undefined;
}

function observationBlocker<TSource, TTranslation>(
  observation: UpdatePlanObservation<TSource, TTranslation>,
): UpdatePlanBlock | undefined {
  if (observation.source.enumeration !== "complete")
    return {
      code: "sourceEnumerationIncomplete",
      message: "原文范围枚举不完整。",
    };
  if (observation.source.bodyAvailability !== "available")
    return { code: "sourceUnavailable", message: "原文内容不可用。" };
  if (observation.association.coverageStatus !== "complete")
    return {
      code: "translationCoverageIncomplete",
      message: "译文范围覆盖不完整。",
    };
  if (observation.association.status === "unknown")
    return {
      code: "associationUnknown",
      message: "源译关联未知。",
    };
  if (observation.association.status === "conflict")
    return {
      code: "associationConflict",
      message: "源译关联存在冲突。",
    };
  if (observation.association.status === "unavailable")
    return {
      code: "associationUnavailable",
      message: "相关译文正文不可用。",
    };
  if (
    observation.association.scopes.length === 0 ||
    observation.association.scopes.some(
      ({ enumeration }) => enumeration !== "complete",
    )
  )
    return {
      code: "translationScopeIncomplete",
      message: "相关译文范围枚举不完整。",
    };
  if (
    observation.association.translations.some(
      ({ bodyAvailability }) => bodyAvailability !== "available",
    )
  )
    return {
      code: "translationUnavailable",
      message: "相关译文内容不可用。",
    };
  return undefined;
}

function isUpdateDecision(value: unknown): value is UpdateDecision {
  if (typeof value !== "object" || value === null || !("action" in value))
    return false;
  const decision = value as Record<string, unknown>;
  if (
    decision.action !== "retain" &&
    decision.action !== "delete" &&
    decision.action !== "none" &&
    decision.action !== "candidate" &&
    decision.action !== "review"
  )
    return false;
  if ("reason" in decision && typeof decision.reason !== "string") return false;
  if (decision.action !== "candidate") return true;
  const candidate = decision.candidate as Record<string, unknown> | undefined;
  return (
    typeof candidate === "object" &&
    candidate !== null &&
    typeof candidate.sourceKey === "string" &&
    typeof candidate.language === "string" &&
    isJsonValue(candidate.content)
  );
}

function isUpdatePlanStatus(value: unknown): value is UpdatePlanStatus {
  return (
    value === "candidate" ||
    value === "delete" ||
    value === "retain" ||
    value === "review" ||
    value === "notProcessed" ||
    value === "blocked"
  );
}

function isUpdatePlanBlock(value: unknown): value is UpdatePlanBlock {
  if (typeof value !== "object" || value === null || !("code" in value))
    return false;
  const blocker = value as Record<string, unknown>;
  return (
    isUpdatePlanBlockCode(blocker.code) &&
    (!("message" in blocker) || typeof blocker.message === "string")
  );
}

function isUpdatePlanBlockCode(value: unknown): value is UpdatePlanBlockCode {
  return (
    value === "historyInsufficient" ||
    value === "changeUnknown" ||
    value === "associationConflict" ||
    value === "planBaselineChanged" ||
    value === "planInputChanged" ||
    value === "currentInputUnavailable" ||
    value === "missingCurrentInput" ||
    value === "sourceEnumerationIncomplete" ||
    value === "sourceUnavailable" ||
    value === "translationCoverageIncomplete" ||
    value === "associationUnknown" ||
    value === "associationUnavailable" ||
    value === "translationScopeIncomplete" ||
    value === "translationUnavailable" ||
    value === "previousInputIncomplete" ||
    value === "addedSourceEvidenceIncomplete" ||
    value === "deleteTargetUnavailable" ||
    value === "deleteRequiresSourceRemoval" ||
    value === "sourceRemoved" ||
    value === "candidateIdentityMismatch" ||
    value === "semanticEditInputUnavailable"
  );
}

function isSemanticEdit(value: unknown): value is SemanticEdit {
  if (typeof value !== "object" || value === null) return false;
  const edit = value as Record<string, unknown>;
  if (
    edit.formatVersion !== "lioni.semantic-edit/v2" ||
    typeof edit.createdFromFactsVersion !== "string" ||
    typeof edit.sourceKey !== "string" ||
    typeof edit.language !== "string" ||
    !isSemanticEditTarget(edit.target) ||
    typeof edit.expected !== "object" ||
    edit.expected === null
  )
    return false;
  const expected = edit.expected as Record<string, unknown>;
  if (
    !isSemanticEditSourceExpectation(expected.source) ||
    !isJsonValue(expected.dependencies) ||
    !isSemanticEditTargetExpected(expected.target)
  )
    return false;
  if (edit.operation === "write")
    return isJsonValue(edit.content) && expected.source.presence === "present";
  return (
    edit.operation === "delete" &&
    !Object.hasOwn(edit, "content") &&
    (edit.target as Record<string, unknown>).kind === "existing" &&
    expected.source.presence === "removed" &&
    (expected.target as Record<string, unknown>).status === "present"
  );
}

function isSemanticEditSourceExpectation(
  value: unknown,
): value is SemanticEdit["expected"]["source"] {
  if (typeof value !== "object" || value === null) return false;
  const source = value as Record<string, unknown>;
  if (source.presence === "present")
    return isJsonValue(source.range) && isJsonValue(source.content);
  return (
    source.presence === "removed" &&
    isJsonValue(source.range) &&
    isJsonValue(source.historicalContent)
  );
}

function isSemanticEditTarget(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const target = value as Record<string, unknown>;
  return (
    (target.kind === "existing" || target.kind === "create") &&
    isJsonValue(target.locator)
  );
}

function isSemanticEditTargetExpected(value: unknown): boolean {
  if (typeof value !== "object" || value === null || !("status" in value))
    return false;
  const target = value as Record<string, unknown>;
  return target.status === "missing"
    ? true
    : target.status === "present" &&
        isJsonValue(target.content) &&
        isJsonValue(target.range) &&
        Array.isArray(target.scopes) &&
        target.scopes.every((range) => isJsonValue(range));
}

function isJsonValue(
  value: unknown,
  seen = new Set<object>(),
): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  const valid = Array.isArray(value)
    ? value.every((entry) => isJsonValue(entry, seen))
    : Object.getPrototypeOf(value) === Object.prototype &&
      Object.values(value).every((entry) => isJsonValue(entry, seen));
  seen.delete(value);
  return valid;
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
  return isDeepStrictEqual(left, right);
}
