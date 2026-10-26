import { isDeepStrictEqual } from "node:util";

import { readFacts } from "./index.ts";
import type {
  FrameworkConfig,
  FrameworkFacts,
  JsonValue,
  TranslationUnitInput,
} from "./index.ts";
import {
  advanceProcessingBaseline,
  compareProcessingBaseline,
  validateProcessingBaseline,
  type ProcessingBaseline,
  type ProcessingBaselineChange,
  type ProcessingBaselineEntry,
  type ProcessingBaselineSelection,
  type ProcessingBaselineStore,
} from "./legacy-baselines.ts";
import {
  validateUpdatePlanHistory,
  type UpdatePlan,
  type UpdatePlanBlock,
  type UpdatePlanItem,
  type UpdatePlanObservation,
  type UpdatePlanStatus,
} from "./plans.ts";
import {
  applySemanticEdits,
  type SemanticEditResult,
} from "./semantic-edits.ts";
import { StandardSchemaContractError } from "./standard-schema.ts";

export type UpdatePlanContentResult<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody = JsonValue,
  TUnavailable = never,
> = {
  readonly sourceKey: string;
  readonly language: string;
  readonly planStatus: UpdatePlanStatus;
  readonly status:
    | "notAttempted"
    | "retained"
    | SemanticEditResult<TUnit, TTranslation, TBody, TUnavailable>["status"];
  readonly reason?: string;
  readonly blocker?: UpdatePlanBlock;
  readonly edit?: SemanticEditResult<TUnit, TTranslation, TBody, TUnavailable>;
};

export type UpdatePlanBaselineResult = {
  readonly sourceKey: string;
  readonly language: string;
  readonly status:
    | "advanced"
    | "conflict"
    | "unknown"
    | "notFound"
    | "failed"
    | "notAttempted";
  readonly reason?: string;
};

export type UpdatePlanApplyResult<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody = JsonValue,
  TUnavailable = never,
> = {
  readonly contentResults: readonly UpdatePlanContentResult<
    TUnit,
    TTranslation,
    TBody,
    TUnavailable
  >[];
  readonly baselineResults: readonly UpdatePlanBaselineResult[];
};

/** 直接执行计划中已确定的候选与保留意图，并分别报告内容和基线结果。 */
export async function applyUpdatePlan<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  plan: unknown,
  config: FrameworkConfig<TUnit, TTranslation, TBody, TUnavailable>,
  baselineStore: ProcessingBaselineStore,
): Promise<UpdatePlanApplyResult<TUnit, TTranslation, TBody, TUnavailable>> {
  const validatedPlan = await validateUpdatePlanHistory(plan, config);

  const contentResults = new Map<
    string,
    UpdatePlanContentResult<TUnit, TTranslation, TBody, TUnavailable>
  >();
  const baselineResults = new Map<string, UpdatePlanBaselineResult>();
  for (const item of validatedPlan.items) {
    const id = pairKey(item.sourceKey, item.language);
    contentResults.set(id, initialContentResult(item));
    baselineResults.set(id, {
      sourceKey: item.sourceKey,
      language: item.language,
      status: "notAttempted",
      ...(item.blocker?.message === undefined
        ? {}
        : { reason: item.blocker.message }),
    });
  }

  const actionable = validatedPlan.items.filter(
    ({ status }) =>
      status === "candidate" || status === "delete" || status === "retain",
  );
  if (actionable.length === 0)
    return finishResult(contentResults, baselineResults);

  let baseline: ProcessingBaseline | undefined;
  try {
    baseline = await baselineStore.load();
    if (baseline !== undefined) validateProcessingBaseline(baseline);
  } catch (error) {
    rethrowContractError(error);
    failActionableItems(
      actionable,
      contentResults,
      baselineResults,
      "failed",
      `读取处理基线失败：${errorMessage(error)}`,
    );
    return finishResult(contentResults, baselineResults);
  }

  let facts: FrameworkFacts<TUnit, TTranslation, TBody, TUnavailable>;
  try {
    facts = await readFacts(config);
  } catch (error) {
    rethrowContractError(error);
    failActionableItems(
      actionable,
      contentResults,
      baselineResults,
      "notAttempted",
      `读取当前事实失败：${errorMessage(error)}`,
    );
    return finishResult(contentResults, baselineResults);
  }

  const comparison = await compareProcessingBaseline(facts, baseline, config);
  const changesByPair = new Map(
    comparison.changes.map((change) => [
      pairKey(change.sourceKey, change.language),
      change,
    ]),
  );
  const retainItems: UpdatePlanItem<
    TUnit["source"],
    TTranslation,
    TBody,
    TUnavailable,
    TUnit
  >[] = [];
  const candidateItems: UpdatePlanItem<
    TUnit["source"],
    TTranslation,
    TBody,
    TUnavailable,
    TUnit
  >[] = [];

  for (const item of actionable) {
    const id = pairKey(item.sourceKey, item.language);
    const conflict = planInputConflict(
      item,
      validatedPlan,
      baseline,
      changesByPair.get(id),
      config,
    );
    if (conflict !== undefined) {
      contentResults.set(id, {
        ...itemPair(item),
        planStatus: item.status,
        status: "conflict",
        reason: conflict.message ?? conflict.code,
        blocker: conflict,
      });
      continue;
    }
    if (item.status === "retain") {
      retainItems.push(item);
      contentResults.set(id, {
        ...itemPair(item),
        planStatus: item.status,
        status: "retained",
      });
    } else {
      candidateItems.push(item);
    }
  }

  const confirmedSelections: ProcessingBaselineSelection[] =
    retainItems.map(itemPair);
  if (candidateItems.length > 0) {
    let editResults: readonly SemanticEditResult<
      TUnit,
      TTranslation,
      TBody,
      TUnavailable
    >[];
    try {
      const edits = candidateItems.flatMap((item) =>
        item.edit === undefined ? [] : [item.edit],
      );
      editResults = (await applySemanticEdits(edits, config)).results;
    } catch (error) {
      rethrowContractError(error);
      failActionableItems(
        candidateItems,
        contentResults,
        baselineResults,
        "notAttempted",
        `执行语义编辑失败：${errorMessage(error)}`,
      );
      editResults = [];
    }

    for (const [index, item] of candidateItems.entries()) {
      const id = pairKey(item.sourceKey, item.language);
      const editResult = editResults[index];
      if (editResult === undefined) {
        if (contentResults.get(id)?.status === "notAttempted") {
          contentResults.set(id, {
            ...itemPair(item),
            planStatus: item.status,
            status: "unprocessed",
            reason: "正式语义编辑没有返回此项结果。",
          });
          baselineResults.set(id, {
            ...itemPair(item),
            status: "notAttempted",
          });
        }
        continue;
      }
      contentResults.set(id, {
        ...itemPair(item),
        planStatus: item.status,
        status: editResult.status,
        ...(editResult.reason === undefined
          ? {}
          : { reason: editResult.reason }),
        edit: editResult,
      });
      if (editResult.status === "written") {
        confirmedSelections.push(itemPair(item));
      } else {
        baselineResults.set(id, {
          ...itemPair(item),
          status: "notAttempted",
          ...(editResult.reason === undefined
            ? {}
            : { reason: editResult.reason }),
        });
      }
    }
  }

  if (confirmedSelections.length > 0) {
    let afterFacts: FrameworkFacts<TUnit, TTranslation, TBody, TUnavailable>;
    try {
      afterFacts = await readFacts(config);
    } catch (error) {
      rethrowContractError(error);
      const reason = `内容结果已确认，但重新读取事实失败：${errorMessage(error)}`;
      for (const selection of confirmedSelections) {
        baselineResults.set(pairKey(selection.sourceKey, selection.language), {
          ...selection,
          status: "failed",
          reason,
        });
      }
      return finishResult(contentResults, baselineResults);
    }

    const result = await advanceProcessingBaseline(
      baselineStore,
      afterFacts,
      confirmedSelections,
      config,
    );
    recordBaselineResults(confirmedSelections, result, baselineResults);
  }

  return finishResult(contentResults, baselineResults);
}

function rethrowContractError(error: unknown): void {
  if (error instanceof StandardSchemaContractError) throw error;
}

function initialContentResult<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  item: UpdatePlanItem<
    TUnit["source"],
    TTranslation,
    TBody,
    TUnavailable,
    TUnit
  >,
): UpdatePlanContentResult<TUnit, TTranslation, TBody, TUnavailable> {
  return {
    ...itemPair(item),
    planStatus: item.status,
    status: "notAttempted",
    ...(item.blocker === undefined ? {} : { blocker: item.blocker }),
    ...(item.blocker?.message === undefined
      ? item.decision.reason === undefined
        ? {}
        : { reason: item.decision.reason }
      : { reason: item.blocker.message }),
  };
}

function planInputConflict<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  item: UpdatePlanItem<
    TUnit["source"],
    TTranslation,
    TBody,
    TUnavailable,
    TUnit
  >,
  plan: UpdatePlan<TUnit, TTranslation, TBody, TUnavailable>,
  baseline: ProcessingBaseline | undefined,
  change:
    | ProcessingBaselineChange<TUnit, TTranslation, TUnavailable>
    | undefined,
  config: FrameworkConfig<TUnit, TTranslation, TBody, TUnavailable>,
): UpdatePlanBlock | undefined {
  if (item.expectedInput === undefined || change?.current === undefined)
    return {
      code: "missingCurrentInput",
      message: "当前缺少计划所需的可靠事实。",
    };
  if (!planPreviousMatches(item, plan, baseline, change, config))
    return {
      code: "planBaselineChanged",
      message: "处理基线已变化，保存计划已过期。",
    };
  if (!matchesExpectedInput(item.expectedInput, change.current, config))
    return {
      code: "planInputChanged",
      message: "原文、译文或相关范围已变化，保存计划已过期。",
    };
  if (!entryIsReliable(change.current))
    return {
      code: "currentInputUnavailable",
      message: "当前事实读取不完整，不能应用此项。",
    };
  return undefined;
}

function planPreviousMatches<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  item: UpdatePlanItem<
    TUnit["source"],
    TTranslation,
    TBody,
    TUnavailable,
    TUnit
  >,
  plan: UpdatePlan<TUnit, TTranslation, TBody, TUnavailable>,
  baseline: ProcessingBaseline | undefined,
  change:
    | ProcessingBaselineChange<TUnit, TTranslation, TUnavailable>
    | undefined,
  config: FrameworkConfig<TUnit, TTranslation, TBody, TUnavailable>,
): boolean {
  const current = change?.previous;
  if (item.previous !== undefined)
    return current !== undefined && isDeepStrictEqual(current, item.previous);
  if (current !== undefined)
    return (
      item.change === "added" &&
      !current.processed &&
      item.expectedInput !== undefined &&
      entryIsReliable(current) &&
      matchesExpectedInput(item.expectedInput, current, config)
    );
  if (item.change !== "added") return true;
  if (baseline === undefined || item.current === undefined) return false;

  const range = item.current.source.range;
  const expectedScopes = plan.sourceScopeEvidence.filter(
    ({ range: oldRange }) => isDeepStrictEqual(oldRange, range),
  );
  const currentScopes = baseline.sourceScopes.filter(({ range: oldRange }) =>
    isDeepStrictEqual(oldRange, range),
  );
  return sourceScopeEvidenceStillProvesAddition(
    expectedScopes,
    currentScopes,
    item.sourceKey,
  );
}

function sourceScopeEvidenceStillProvesAddition(
  expectedScopes: readonly ProcessingBaseline["sourceScopes"][number][],
  currentScopes: readonly ProcessingBaseline["sourceScopes"][number][],
  sourceKey: string,
): boolean {
  return (
    expectedScopes.length > 0 &&
    currentScopes.length === expectedScopes.length &&
    expectedScopes.every((expected, index) => {
      const current = currentScopes[index];
      return (
        current !== undefined &&
        expected.enumeration === "complete" &&
        current.enumeration === "complete" &&
        !current.sourceKeys.includes(sourceKey) &&
        expected.sourceKeys.every((key) => current.sourceKeys.includes(key))
      );
    })
  );
}

function matchesExpectedInput<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  expected: UpdatePlanObservation<TUnit["source"], TTranslation, TUnavailable>,
  current: ProcessingBaselineEntry<TUnit, TTranslation, TUnavailable>,
  config: FrameworkConfig<TUnit, TTranslation, TBody, TUnavailable>,
): boolean {
  if (
    expected.source.presence !== current.source.presence ||
    expected.source.bodyAvailability !== current.source.bodyAvailability ||
    expected.source.enumeration !== current.source.enumeration ||
    !isDeepStrictEqual(expected.source.range, current.source.range)
  )
    return false;
  if (expected.source.presence === "present") {
    if (!isDeepStrictEqual(expected.source.value, current.source.unit.source))
      return false;
  }

  const association = expected.association;
  const currentAssociation = current.association;
  if (
    association.status !== currentAssociation.status ||
    association.coverageStatus !== currentAssociation.coverageStatus ||
    !isDeepStrictEqual(association.scopes, currentAssociation.scopes) ||
    association.translations.length !== currentAssociation.translations.length
  )
    return false;

  return association.translations.every((translation, index) => {
    const currentTranslation = currentAssociation.translations[index];
    if (
      currentTranslation === undefined ||
      translation.bodyAvailability !== currentTranslation.bodyAvailability ||
      !isDeepStrictEqual(translation.range, currentTranslation.range)
    )
      return false;
    if (translation.bodyAvailability === "available") {
      const adapter = config.translations;
      return (
        currentTranslation.bodyAvailability === "available" &&
        adapter !== undefined &&
        isDeepStrictEqual(
          adapter.contentOf(translation.translation),
          adapter.contentOf(currentTranslation.translation),
        )
      );
    }
    return isDeepStrictEqual(
      translation.translation,
      currentTranslation.translation,
    );
  });
}

function entryIsReliable(entry: ProcessingBaselineEntry): boolean {
  return (
    entry.source.enumeration === "complete" &&
    entry.source.bodyAvailability === "available" &&
    entry.association.coverageStatus === "complete" &&
    entry.association.status !== "unknown" &&
    entry.association.status !== "conflict" &&
    entry.association.status !== "unavailable" &&
    entry.association.scopes.length > 0 &&
    entry.association.scopes.every(
      ({ enumeration }) => enumeration === "complete",
    ) &&
    entry.association.translations.every(
      ({ bodyAvailability }) => bodyAvailability === "available",
    )
  );
}

function recordBaselineResults(
  selections: readonly ProcessingBaselineSelection[],
  result: Awaited<ReturnType<typeof advanceProcessingBaseline>>,
  results: Map<string, UpdatePlanBaselineResult>,
): void {
  const outcomes = new Map(
    result.selections.map((selection) => [
      pairKey(selection.sourceKey, selection.language),
      selection.outcome,
    ]),
  );
  for (const selection of selections) {
    const id = pairKey(selection.sourceKey, selection.language);
    const outcome = outcomes.get(id);
    const status =
      result.outcome === "failed"
        ? "failed"
        : outcome === "advanced"
          ? "advanced"
          : (outcome ?? "unknown");
    results.set(id, {
      ...selection,
      status,
      ...(result.failure === undefined
        ? {}
        : {
            reason: `${result.failure.phase === "load" ? "读取" : "保存"}处理基线失败：${result.failure.message}`,
          }),
    });
  }
}

function failActionableItems<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  items: readonly UpdatePlanItem<
    TUnit["source"],
    TTranslation,
    TBody,
    TUnavailable,
    TUnit
  >[],
  contentResults: Map<
    string,
    UpdatePlanContentResult<TUnit, TTranslation, TBody, TUnavailable>
  >,
  baselineResults: Map<string, UpdatePlanBaselineResult>,
  baselineStatus: "failed" | "notAttempted",
  reason: string,
): void {
  for (const item of items) {
    const id = pairKey(item.sourceKey, item.language);
    contentResults.set(id, {
      ...itemPair(item),
      planStatus: item.status,
      status: "unprocessed",
      reason,
    });
    baselineResults.set(id, {
      ...itemPair(item),
      status: baselineStatus,
      reason,
    });
  }
}

function finishResult<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  contentResults: Map<
    string,
    UpdatePlanContentResult<TUnit, TTranslation, TBody, TUnavailable>
  >,
  baselineResults: Map<string, UpdatePlanBaselineResult>,
): UpdatePlanApplyResult<TUnit, TTranslation, TBody, TUnavailable> {
  return {
    contentResults: [...contentResults.values()],
    baselineResults: [...baselineResults.values()],
  };
}

function itemPair(item: {
  readonly sourceKey: string;
  readonly language: string;
}): {
  sourceKey: string;
  language: string;
} {
  return { sourceKey: item.sourceKey, language: item.language };
}

function pairKey(sourceKey: string, language: string): string {
  return JSON.stringify([sourceKey, language]);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
