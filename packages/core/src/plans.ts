import { isDeepStrictEqual } from "node:util";

import {
  compareProcessingBaseline,
  validateProcessingBaseline,
  validateProcessingBaselineHistory,
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
  validateSemanticEditCandidate,
  validateSemanticEditHistory,
  type JsonValue,
  type SemanticEdit,
  type SemanticEditCandidate,
} from "./semantic-edits.ts";
import {
  assertJsonValue,
  StandardSchemaContractError,
} from "./standard-schema.ts";

export type UpdatePlanObservation<
  TSource = unknown,
  TTranslation = unknown,
  TUnavailable = never,
> = {
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
    readonly translations: readonly (
      | {
          readonly range: unknown;
          readonly translation: TTranslation;
          readonly bodyAvailability: "available";
        }
      | {
          readonly range: unknown;
          readonly translation: TUnavailable;
          readonly bodyAvailability: "unavailable";
        }
    )[];
  };
};

export type UpdateDecision<TBody = JsonValue> =
  | { readonly action: "retain"; readonly reason?: string }
  | {
      readonly action: "candidate";
      readonly candidate: SemanticEditCandidate<TBody>;
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
  TUnavailable = never,
> = {
  readonly sourceKey: string;
  readonly language: string;
  readonly change: ProcessingChangeStatus;
  readonly processed: boolean;
  readonly previous?: UpdatePlanObservation<
    TUnit["source"],
    TTranslation,
    TUnavailable
  >;
  readonly expectedInput?: UpdatePlanObservation<
    TUnit["source"],
    TTranslation,
    TUnavailable
  >;
  readonly sourceUnit?: TUnit;
  readonly translations: readonly (TTranslation | TUnavailable)[];
};

export type UpdatePolicy<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody = JsonValue,
  TUnavailable = never,
> = (
  input: UpdatePolicyInput<TUnit, TTranslation, TUnavailable>,
) => UpdateDecision<TBody>;

export type UpdatePlanItem<
  TSource = unknown,
  TTranslation = unknown,
  TBody = JsonValue,
  TUnavailable = never,
  TUnit extends TranslationUnitInput = TranslationUnitInput,
> = {
  readonly sourceKey: string;
  readonly language: string;
  readonly change: ProcessingChangeStatus;
  readonly processed: boolean;
  readonly previous?: ProcessingBaselineEntry<
    TUnit,
    TTranslation,
    TUnavailable
  >;
  readonly current?: ProcessingBaselineEntry<TUnit, TTranslation, TUnavailable>;
  readonly expectedInput?: UpdatePlanObservation<
    TSource,
    TTranslation,
    TUnavailable
  >;
  readonly decision: UpdateDecision<TBody>;
  readonly status: UpdatePlanStatus;
  readonly blocker?: UpdatePlanBlock;
  readonly edit?: SemanticEdit<TBody>;
};

export type UpdatePlan<
  TUnit extends TranslationUnitInput = TranslationUnitInput,
  TTranslation = unknown,
  TBody = JsonValue,
  TUnavailable = never,
> = {
  readonly formatVersion: 3;
  readonly sourceScopeEvidence: readonly ProcessingBaselineSourceScope[];
  readonly items: readonly UpdatePlanItem<
    TUnit["source"],
    TTranslation,
    TBody,
    TUnavailable,
    TUnit
  >[];
};

/** 通过 JSON 结构检查后的计划数据；其中业务值仍保持未知类型。 */
export type UpdatePlanData = {
  readonly formatVersion: 3;
  readonly sourceScopeEvidence: readonly ProcessingBaselineSourceScope[];
  readonly items: readonly UpdatePlanDataItem[];
};

export type UpdatePlanDataItem = {
  readonly sourceKey: string;
  readonly language: string;
  readonly change: ProcessingChangeStatus;
  readonly processed: boolean;
  readonly previous?: ProcessingBaselineEntry;
  readonly current?: ProcessingBaselineEntry;
  readonly expectedInput?: UpdatePlanObservation<unknown, unknown, unknown>;
  readonly decision: UpdateDecision<unknown>;
  readonly status: UpdatePlanStatus;
  readonly blocker?: UpdatePlanBlock;
  readonly edit?: SemanticEdit<unknown>;
};

export type UpdatePlanStore = {
  load(): Promise<UpdatePlanData | undefined>;
  save(plan: UpdatePlanData): Promise<void>;
};

export function defaultUpdatePolicy<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody = JsonValue,
  TUnavailable = never,
>(
  input: UpdatePolicyInput<TUnit, TTranslation, TUnavailable>,
): UpdateDecision<TBody> {
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
  TBody,
  TUnavailable,
>(
  facts: FrameworkFacts<TUnit, TTranslation, TBody, TUnavailable>,
  baseline: ProcessingBaseline | undefined,
  config: FrameworkConfig<TUnit, TTranslation, TBody, TUnavailable>,
): Promise<UpdatePlan<TUnit, TTranslation, TBody, TUnavailable>> {
  const changes = await compareProcessingBaseline(facts, baseline, config);
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
  const items: UpdatePlanItem<
    TUnit["source"],
    TTranslation,
    TBody,
    TUnavailable,
    TUnit
  >[] = [];

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
        : observe<TUnit, TTranslation, TUnavailable>(change.previous);
    const expectedInput =
      change.current === undefined
        ? undefined
        : observe<TUnit, TTranslation, TUnavailable>(change.current);
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
    let decision = structuredClone(
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
    if (decision.action === "candidate") {
      decision = {
        ...decision,
        candidate: await validateSemanticEditCandidate(
          decision.candidate,
          config,
        ),
      };
    }

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
      const historicalSource = change.previous?.source.unit;
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
        config,
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
      config,
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
    const prepared = await prepareSemanticEdit(
      resolved.input,
      candidate,
      config,
    );
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
  value: unknown,
): asserts value is UpdatePlanData {
  assertJsonValue(value, "更新计划");
  if (
    !isRecord(value) ||
    value.formatVersion !== 3 ||
    !isUnknownArray(value.sourceScopeEvidence) ||
    !isUnknownArray(value.items)
  ) {
    invalidUpdatePlan("格式无效或版本不受支持。");
  }
  for (const scope of value.sourceScopeEvidence) {
    if (
      !isRecord(scope) ||
      !Object.hasOwn(scope, "range") ||
      !isEnumerationCompleteness(scope.enumeration) ||
      !isUnknownArray(scope.sourceKeys) ||
      scope.sourceKeys.some((key) => typeof key !== "string")
    ) {
      invalidUpdatePlan("包含无效的原文范围依据。");
    }
  }
  const seen = new Set<string>();
  for (const item of value.items) {
    if (
      !isRecord(item) ||
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
      invalidUpdatePlan("包含无效条目。");
    }
    const key = JSON.stringify([item.sourceKey, item.language]);
    if (seen.has(key)) invalidUpdatePlan("包含重复的原文身份与语言。");
    seen.add(key);
  }
}

/** 验证保存计划内的业务历史，并由完整历史快照重建策略观察。 */
export async function validateUpdatePlanHistory<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  value: unknown,
  config: FrameworkConfig<TUnit, TTranslation, TBody, TUnavailable>,
): Promise<UpdatePlan<TUnit, TTranslation, TBody, TUnavailable>> {
  validateUpdatePlan(value);
  const items: UpdatePlanItem<
    TUnit["source"],
    TTranslation,
    TBody,
    TUnavailable,
    TUnit
  >[] = [];
  for (const item of value.items) {
    const previous =
      item.previous === undefined
        ? undefined
        : await validateEntryHistory(item.previous, config);
    const current =
      item.current === undefined
        ? undefined
        : await validateEntryHistory(item.current, config);
    let expectedInput:
      | UpdatePlanObservation<TUnit["source"], TTranslation, TUnavailable>
      | undefined;
    if (item.expectedInput !== undefined) {
      if (current === undefined)
        invalidUpdatePlan("包含没有完整原文依据的策略观察。");
      const derived = observe<TUnit, TTranslation, TUnavailable>(current);
      if (!isDeepStrictEqual(item.expectedInput, derived))
        invalidUpdatePlan("策略观察与其完整历史快照不一致。");
      expectedInput = derived;
    }

    let edit: SemanticEdit<TBody> | undefined;
    if (item.edit !== undefined) {
      const validated = await validateSemanticEditHistory(item.edit, config);
      edit = validated.edit;
      if (current === undefined)
        invalidUpdatePlan("包含没有完整原文依据的语义编辑。");
      if (edit.operation === "write") {
        if (
          current.source.presence !== "present" ||
          !isDeepStrictEqual(edit.expected.source.unit, current.source.unit) ||
          !isDeepStrictEqual(
            edit.expected.source.content,
            current.source.unit.source,
          )
        )
          invalidUpdatePlan("语义编辑原文与完整历史快照不一致。");
      } else if (
        current.source.presence !== "removed" ||
        !isDeepStrictEqual(
          edit.expected.source.historicalContent,
          current.source.unit,
        )
      ) {
        invalidUpdatePlan("删除编辑原文与完整历史快照不一致。");
      }

      if (edit.expected.target.status === "present") {
        const translation = current.association.translations.find(
          ({ bodyAvailability }) => bodyAvailability === "available",
        );
        const adapter = config.translations;
        if (
          translation === undefined ||
          translation.bodyAvailability !== "available" ||
          adapter === undefined ||
          !isDeepStrictEqual(
            adapter.contentOf(translation.translation),
            edit.expected.target.content,
          )
        )
          invalidUpdatePlan("语义编辑目标与完整历史快照不一致。");
      }
    }
    let decision: UpdateDecision<TBody>;
    if (item.decision.action === "candidate") {
      if (
        item.decision.candidate.sourceKey !== item.sourceKey ||
        item.decision.candidate.language !== item.language
      )
        invalidUpdatePlan("策略候选与计划项的原文身份或语言不匹配。");
      const content =
        edit?.operation === "write"
          ? edit.content
          : (
              await validateSemanticEditCandidate(
                item.decision.candidate,
                config,
              )
            ).content;
      decision = {
        ...item.decision,
        candidate: {
          ...item.decision.candidate,
          content,
        },
      };
    } else {
      decision = item.decision;
    }
    items.push({
      sourceKey: item.sourceKey,
      language: item.language,
      change: item.change,
      processed: item.processed,
      ...(previous === undefined ? {} : { previous }),
      ...(current === undefined ? {} : { current }),
      ...(expectedInput === undefined ? {} : { expectedInput }),
      decision,
      status: item.status,
      ...(item.blocker === undefined ? {} : { blocker: item.blocker }),
      ...(edit === undefined ? {} : { edit }),
    });
  }
  return {
    formatVersion: 3,
    sourceScopeEvidence: value.sourceScopeEvidence,
    items,
  };
}

async function validateEntryHistory<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  entry: unknown,
  config: FrameworkConfig<TUnit, TTranslation, TBody, TUnavailable>,
): Promise<ProcessingBaselineEntry<TUnit, TTranslation, TUnavailable>> {
  const baseline = await validateProcessingBaselineHistory(
    { formatVersion: 1, entries: [entry], sourceScopes: [] },
    config,
  );
  const validated = baseline.entries[0];
  if (validated === undefined) invalidUpdatePlan("缺少可验证的历史条目。");
  return validated;
}

function matchesDecisionState(value: Record<string, unknown>): boolean {
  const decision = value.decision;
  if (!isUpdateDecision(decision)) return false;
  const edit = value.edit;
  if (value.status === "blocked")
    return value.blocker !== undefined && edit === undefined;
  if (value.blocker !== undefined) return false;
  if (value.status === "candidate")
    return (
      decision.action === "candidate" &&
      isRecord(edit) &&
      edit.operation === "write" &&
      edit.sourceKey === value.sourceKey &&
      edit.language === value.language &&
      isRecord(decision.candidate) &&
      isDeepStrictEqual(edit.content, decision.candidate.content)
    );
  if (value.status === "delete")
    return (
      decision.action === "delete" &&
      isRecord(edit) &&
      edit.operation === "delete" &&
      edit.sourceKey === value.sourceKey &&
      edit.language === value.language
    );
  if (edit !== undefined) return false;
  if (value.status === "retain") return decision.action === "retain";
  if (value.status === "review") return decision.action === "review";
  return decision.action === "none";
}

function observe<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TUnavailable = never,
>(
  entry: ProcessingBaselineEntry<TUnit, TTranslation, TUnavailable>,
): UpdatePlanObservation<TUnit["source"], TTranslation, TUnavailable> {
  const unit = entry.source.unit;
  return {
    source: {
      presence: entry.source.presence,
      ...(entry.source.presence === "present" ? { value: unit.source } : {}),
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
      })),
    },
  };
}

function currentSourceUnit<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  facts: FrameworkFacts<TUnit, TTranslation, TBody, TUnavailable>,
  change: ProcessingBaselineChange,
): TUnit | undefined {
  return facts.source.units.find(({ key }) => key === change.sourceKey)?.unit;
}

function processingBlocker<TSource, TTranslation, TBody, TUnavailable>(
  change: ProcessingBaselineChange,
  previous:
    | UpdatePlanObservation<TSource, TTranslation, TUnavailable>
    | undefined,
  expectedInput:
    | UpdatePlanObservation<TSource, TTranslation, TUnavailable>
    | undefined,
  decision: UpdateDecision<TBody>,
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

function observationBlocker<TSource, TTranslation, TUnavailable>(
  observation: UpdatePlanObservation<TSource, TTranslation, TUnavailable>,
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
  if (!isRecord(value)) return false;
  const decision = value;
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
  const candidate = decision.candidate;
  return (
    isRecord(candidate) &&
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
  if (!isRecord(value)) return false;
  const blocker = value;
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
  if (!isRecord(value)) return false;
  const edit = value;
  if (
    edit.formatVersion !== "lioni.semantic-edit/v2" ||
    typeof edit.createdFromFactsVersion !== "string" ||
    typeof edit.sourceKey !== "string" ||
    typeof edit.language !== "string" ||
    !isSemanticEditTarget(edit.target) ||
    !isRecord(edit.expected)
  )
    return false;
  const expected = edit.expected;
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
    isRecord(edit.target) &&
    edit.target.kind === "existing" &&
    expected.source.presence === "removed" &&
    isRecord(expected.target) &&
    expected.target.status === "present"
  );
}

function isSemanticEditSourceExpectation(
  value: unknown,
): value is SemanticEdit["expected"]["source"] {
  if (!isRecord(value)) return false;
  const source = value;
  if (source.presence === "present")
    return (
      isJsonValue(source.range) &&
      isJsonValue(source.unit) &&
      isJsonValue(source.content)
    );
  return (
    source.presence === "removed" &&
    isJsonValue(source.range) &&
    isJsonValue(source.historicalContent)
  );
}

function isSemanticEditTarget(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const target = value;
  return (
    (target.kind === "existing" || target.kind === "create") &&
    isJsonValue(target.locator)
  );
}

function isSemanticEditTargetExpected(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const target = value;
  return target.status === "missing"
    ? true
    : target.status === "present" &&
        isJsonValue(target.content) &&
        isJsonValue(target.range) &&
        Array.isArray(target.scopes) &&
        target.scopes.every((range) => isJsonValue(range));
}

function isJsonValue(value: unknown): value is JsonValue {
  try {
    assertJsonValue(value, "更新计划字段");
    return true;
  } catch {
    return false;
  }
}

function isBaselineEntry(value: unknown): boolean {
  try {
    const baseline: unknown = {
      formatVersion: 1,
      entries: [value],
      sourceScopes: [],
    };
    validateProcessingBaseline(baseline);
    return true;
  } catch {
    return false;
  }
}

function isUpdatePlanObservation(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const source = value.source;
  const association = value.association;
  if (
    !isRecord(source) ||
    (source.presence !== "present" && source.presence !== "removed") ||
    !isBodyAvailability(source.bodyAvailability) ||
    !isEnumerationCompleteness(source.enumeration) ||
    !isRecord(association) ||
    !isAssociationStatus(association.status) ||
    !isCoverageStatus(association.coverageStatus) ||
    !isUnknownArray(association.scopes) ||
    !isUnknownArray(association.translations)
  ) {
    return false;
  }
  return (
    association.scopes.every((scope) => {
      if (!isRecord(scope) || !Object.hasOwn(scope, "range")) return false;
      const translationScope = scope;
      return (
        isUnknownArray(translationScope.covers) &&
        translationScope.covers.every((key) => typeof key === "string") &&
        isEnumerationCompleteness(translationScope.enumeration)
      );
    }) &&
    association.translations.every((translation) => {
      if (
        !isRecord(translation) ||
        !Object.hasOwn(translation, "range") ||
        !Object.hasOwn(translation, "translation")
      )
        return false;
      return isBodyAvailability(translation.bodyAvailability);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function invalidUpdatePlan(message: string): never {
  throw new StandardSchemaContractError(
    "更新计划",
    "schema-mismatch",
    `更新计划${message}`,
  );
}

function sameJson(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(left, right);
}
