import { isDeepStrictEqual } from "node:util";

import {
  advanceProcessingBaseline,
  compareProcessingBaseline,
  validateProcessingBaseline,
  type ProcessingBaseline,
  type ProcessingBaselineEntry,
  type ProcessingBaselineSelection,
  type ProcessingBaselineStore,
} from "./baselines.ts";
import {
  applySemanticEdits,
  prepareSemanticEdit,
  type JsonValue,
  type SemanticEdit,
  type SemanticEditResult,
} from "./edits.ts";
import { readFacts } from "./index.ts";
import type {
  ActualTranslationFact,
  FrameworkConfig,
  FrameworkFacts,
  TranslationAssociationFact,
  TranslationUnitInput,
} from "./index.ts";
import {
  validateUpdatePlan,
  type UpdatePlan,
  type UpdatePlanItem,
  type UpdatePlanObservation,
} from "./plans.ts";

export type UpdatePlanSelection = ProcessingBaselineSelection & {
  readonly choice: "retain" | "candidate";
};

export type UpdatePlanContentResult<
  TUnit extends TranslationUnitInput,
  TTranslation,
> = {
  readonly sourceKey: string;
  readonly language: string;
  readonly status:
    | "notSelected"
    | "retained"
    | SemanticEditResult<TUnit, TTranslation>["status"];
  readonly reason?: string;
  readonly edit?: SemanticEditResult<TUnit, TTranslation>;
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
    | "notSelected"
    | "notAttempted";
  readonly reason?: string;
};

export type UpdatePlanApplyResult<
  TUnit extends TranslationUnitInput,
  TTranslation,
> = {
  readonly contentResults: readonly UpdatePlanContentResult<
    TUnit,
    TTranslation
  >[];
  readonly baselineResults: readonly UpdatePlanBaselineResult[];
};

/** 校验保存计划后，按明确选择执行内容处理并分别推进处理基线。 */
export async function applyUpdatePlan<
  TUnit extends TranslationUnitInput,
  TTranslation,
>(
  plan: UpdatePlan<TUnit, TTranslation>,
  selections: readonly UpdatePlanSelection[],
  config: FrameworkConfig<TUnit, TTranslation>,
  baselineStore: ProcessingBaselineStore,
): Promise<UpdatePlanApplyResult<TUnit, TTranslation>> {
  validateUpdatePlan(plan);
  assertUniqueSelections(selections);

  const contentResults = new Map<
    string,
    UpdatePlanContentResult<TUnit, TTranslation>
  >();
  const baselineResults = new Map<string, UpdatePlanBaselineResult>();
  const itemsByPair = new Map(
    plan.items.map((item) => [pairKey(item.sourceKey, item.language), item]),
  );

  for (const item of plan.items) {
    const id = pairKey(item.sourceKey, item.language);
    contentResults.set(id, {
      sourceKey: item.sourceKey,
      language: item.language,
      status: "notSelected",
    });
    baselineResults.set(id, {
      sourceKey: item.sourceKey,
      language: item.language,
      status: "notSelected",
    });
  }

  for (const selection of selections) {
    const id = pairKey(selection.sourceKey, selection.language);
    if (!itemsByPair.has(id)) {
      contentResults.set(id, {
        sourceKey: selection.sourceKey,
        language: selection.language,
        status: "unprocessed",
        reason: "保存计划中没有对应的原文与语言。",
      });
      baselineResults.set(id, {
        sourceKey: selection.sourceKey,
        language: selection.language,
        status: "notFound",
      });
    }
  }

  let baseline: ProcessingBaseline | undefined;
  try {
    baseline = await baselineStore.load();
    if (baseline !== undefined) validateProcessingBaseline(baseline);
  } catch (error) {
    return failSelections(
      selections,
      contentResults,
      baselineResults,
      "failed",
      `读取处理基线失败：${errorMessage(error)}`,
    );
  }

  let facts: FrameworkFacts<TUnit, TTranslation>;
  try {
    facts = await readFacts(config);
  } catch (error) {
    return failSelections(
      selections,
      contentResults,
      baselineResults,
      "notAttempted",
      `读取当前事实失败：${errorMessage(error)}`,
    );
  }

  const matches = config.translations?.matches;
  const comparison = compareProcessingBaseline(
    facts,
    baseline,
    matches === undefined ? {} : { matches },
  );
  const changesByPair = new Map(
    comparison.changes.map((change) => [
      pairKey(change.sourceKey, change.language),
      change,
    ]),
  );
  const retainSelections: ProcessingBaselineSelection[] = [];
  const preparedEdits: {
    readonly selection: ProcessingBaselineSelection;
    readonly edit: SemanticEdit;
  }[] = [];

  for (const selection of selections) {
    const id = pairKey(selection.sourceKey, selection.language);
    const item = itemsByPair.get(id);
    if (item === undefined) continue;

    const staleReason = planInputConflict(
      item,
      plan,
      baseline,
      changesByPair.get(id),
      config,
    );
    if (staleReason !== undefined) {
      contentResults.set(id, {
        ...selectionPair(selection),
        status: "conflict",
        reason: staleReason,
      });
      baselineResults.set(id, {
        ...selectionPair(selection),
        status: "notAttempted",
        reason: staleReason,
      });
      continue;
    }

    if (selection.choice === "retain") {
      retainSelections.push(selection);
      contentResults.set(id, {
        ...selectionPair(selection),
        status: "retained",
      });
      continue;
    }

    if (!item.executable || item.recommendation.action !== "candidate") {
      const reason = item.blockedReason ?? "此计划项没有可采用的候选内容。";
      contentResults.set(id, {
        ...selectionPair(selection),
        status: "notWritable",
        reason,
      });
      baselineResults.set(id, {
        ...selectionPair(selection),
        status: "notAttempted",
        reason,
      });
      continue;
    }

    if (item.expectedInput?.source.presence !== "present") {
      const reason = "已删除原文没有可写入的候选目标。";
      contentResults.set(id, {
        ...selectionPair(selection),
        status: "notWritable",
        reason,
      });
      baselineResults.set(id, {
        ...selectionPair(selection),
        status: "notAttempted",
        reason,
      });
      continue;
    }

    const prepared = await prepareSemanticEdit(
      facts,
      {
        sourceKey: selection.sourceKey,
        language: selection.language,
        content: item.recommendation.candidate as JsonValue,
      },
      config,
    );
    if (prepared.status !== "prepared") {
      contentResults.set(id, {
        ...selectionPair(selection),
        status: "notWritable",
        reason: prepared.reason,
      });
      baselineResults.set(id, {
        ...selectionPair(selection),
        status: "notAttempted",
        reason: prepared.reason,
      });
      continue;
    }

    const dependencyMatches = await oldPlanDependenciesMatch(
      item,
      prepared.edit,
      facts,
      config,
    );
    if (dependencyMatches !== undefined) {
      contentResults.set(id, {
        ...selectionPair(selection),
        status: "conflict",
        reason: dependencyMatches,
      });
      baselineResults.set(id, {
        ...selectionPair(selection),
        status: "notAttempted",
        reason: dependencyMatches,
      });
      continue;
    }

    preparedEdits.push({
      selection,
      edit: prepared.edit,
    });
  }

  if (retainSelections.length > 0) {
    const result = await advanceProcessingBaseline(
      baselineStore,
      facts,
      retainSelections,
      matches === undefined ? {} : { matches },
    );
    recordBaselineResults(retainSelections, result, baselineResults);
  }

  if (preparedEdits.length > 0) {
    let editResults: readonly SemanticEditResult<TUnit, TTranslation>[];
    try {
      editResults = (
        await applySemanticEdits(
          preparedEdits.map(({ edit }) => edit),
          config,
        )
      ).results;
    } catch (error) {
      const reason = `执行语义编辑失败：${errorMessage(error)}`;
      for (const { selection } of preparedEdits) {
        const id = pairKey(selection.sourceKey, selection.language);
        contentResults.set(id, {
          ...selectionPair(selection),
          status: "unprocessed",
          reason,
        });
        baselineResults.set(id, {
          ...selectionPair(selection),
          status: "notAttempted",
          reason,
        });
      }
      return finishResult(contentResults, baselineResults);
    }

    const writtenSelections: ProcessingBaselineSelection[] = [];
    for (const [index, preparedEdit] of preparedEdits.entries()) {
      const id = pairKey(
        preparedEdit.selection.sourceKey,
        preparedEdit.selection.language,
      );
      const editResult = editResults[index];
      if (editResult === undefined) {
        const reason = "正式语义编辑没有返回此项结果。";
        contentResults.set(id, {
          ...selectionPair(preparedEdit.selection),
          status: "unprocessed",
          reason,
        });
        baselineResults.set(id, {
          ...selectionPair(preparedEdit.selection),
          status: "notAttempted",
          reason,
        });
        continue;
      }
      contentResults.set(id, {
        ...selectionPair(preparedEdit.selection),
        status: editResult.status,
        ...(editResult.reason === undefined
          ? {}
          : { reason: editResult.reason }),
        edit: editResult,
      });
      if (editResult.status === "written") {
        writtenSelections.push(preparedEdit.selection);
      } else {
        baselineResults.set(id, {
          ...selectionPair(preparedEdit.selection),
          status: "notAttempted",
          reason: editResult.reason ?? "内容写入未确认，未推进处理基线。",
        });
      }
    }

    if (writtenSelections.length > 0) {
      let afterFacts: FrameworkFacts<TUnit, TTranslation>;
      try {
        afterFacts = await readFacts(config);
      } catch (error) {
        const reason = `写入已确认，但重新读取事实失败：${errorMessage(error)}`;
        for (const selection of writtenSelections) {
          baselineResults.set(
            pairKey(selection.sourceKey, selection.language),
            {
              ...selectionPair(selection),
              status: "failed",
              reason,
            },
          );
        }
        return finishResult(contentResults, baselineResults);
      }

      const result = await advanceProcessingBaseline(
        baselineStore,
        afterFacts,
        writtenSelections,
        matches === undefined ? {} : { matches },
      );
      recordBaselineResults(writtenSelections, result, baselineResults);
    }
  }

  return finishResult(contentResults, baselineResults);
}

function planInputConflict<TUnit extends TranslationUnitInput, TTranslation>(
  item: UpdatePlanItem<TUnit["source"], TTranslation>,
  plan: UpdatePlan<TUnit, TTranslation>,
  baseline: ProcessingBaseline | undefined,
  change:
    | ReturnType<typeof compareProcessingBaseline>["changes"][number]
    | undefined,
  config: FrameworkConfig<TUnit, TTranslation>,
): string | undefined {
  if (item.expectedInput === undefined || change?.current === undefined)
    return "当前缺少计划所需的可靠事实，不能应用此项。";
  if (!planPreviousMatches(item, plan, baseline))
    return "处理基线已变化，保存计划已过期。";
  if (!matchesExpectedInput(item.expectedInput, change.current, config))
    return "原文、译文或相关范围已变化，保存计划已过期。";
  if (!entryIsReliable(change.current))
    return "当前事实读取不完整，不能应用此项。";
  return undefined;
}

function planPreviousMatches<TUnit extends TranslationUnitInput, TTranslation>(
  item: UpdatePlanItem<TUnit["source"], TTranslation>,
  plan: UpdatePlan<TUnit, TTranslation>,
  baseline: ProcessingBaseline | undefined,
): boolean {
  const current = baseline?.entries.find(
    (entry) =>
      entry.sourceKey === item.sourceKey && entry.language === item.language,
  );
  if (item.previous !== undefined)
    return current !== undefined && isDeepStrictEqual(current, item.previous);
  if (current !== undefined) return false;
  if (item.change !== "added") return true;
  if (baseline === undefined || item.current === undefined) return false;

  const range = item.current.source.range;
  const expectedScopes = plan.sourceScopeEvidence.filter(
    ({ range: oldRange }) => isDeepStrictEqual(oldRange, range),
  );
  const currentScopes = baseline.sourceScopes.filter(({ range: oldRange }) =>
    isDeepStrictEqual(oldRange, range),
  );
  return (
    expectedScopes.length > 0 &&
    isDeepStrictEqual(currentScopes, expectedScopes)
  );
}

function matchesExpectedInput<TUnit extends TranslationUnitInput, TTranslation>(
  expected: UpdatePlanObservation<TUnit["source"], TTranslation>,
  current: ProcessingBaselineEntry,
  config: FrameworkConfig<TUnit, TTranslation>,
): boolean {
  if (
    expected.source.presence !== current.source.presence ||
    expected.source.bodyAvailability !== current.source.bodyAvailability ||
    expected.source.enumeration !== current.source.enumeration ||
    !isDeepStrictEqual(expected.source.range, current.source.range)
  )
    return false;
  if (expected.source.presence === "present") {
    const unit = current.source.unit as TUnit;
    if (!isDeepStrictEqual(expected.source.value, unit.source)) return false;
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

  try {
    return association.translations.every((translation, index) => {
      const currentTranslation = currentAssociation.translations[index];
      if (
        currentTranslation === undefined ||
        translation.bodyAvailability !== currentTranslation.bodyAvailability ||
        !isDeepStrictEqual(translation.range, currentTranslation.range)
      )
        return false;
      const expectedContent = config.edits?.targetContent
        ? config.edits.targetContent(translation.translation)
        : translation.translation;
      const currentContent = config.edits?.targetContent
        ? config.edits.targetContent(
            currentTranslation.translation as TTranslation,
          )
        : currentTranslation.translation;
      return isDeepStrictEqual(expectedContent, currentContent);
    });
  } catch {
    return false;
  }
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

async function oldPlanDependenciesMatch<
  TUnit extends TranslationUnitInput,
  TTranslation,
>(
  item: UpdatePlanItem<TUnit["source"], TTranslation>,
  edit: SemanticEdit,
  facts: FrameworkFacts<TUnit, TTranslation>,
  config: FrameworkConfig<TUnit, TTranslation>,
): Promise<string | undefined> {
  const adapter = config.edits;
  if (adapter?.dependencies === undefined) return undefined;
  const expected = item.expectedInput;
  const current = item.current;
  if (
    expected === undefined ||
    current === undefined ||
    current.source.presence !== "present"
  )
    return "保存计划没有保留声明依赖的原始上下文。";

  const sourceScopeIndex = facts.source.read.scopes.findIndex(({ range }) =>
    isDeepStrictEqual(range, expected.source.range),
  );
  const sourceUnit = {
    key: item.sourceKey,
    unit: current.source.unit as TUnit,
    bodyAvailability: current.source.bodyAvailability,
    scopeIndex: Math.max(sourceScopeIndex, 0),
  };
  const association = oldAssociationFact(
    item.sourceKey,
    item.language,
    expected,
  );
  const translations = oldTranslationFacts(item.language, expected);

  try {
    const dependencies = await adapter.dependencies({
      sourceUnit,
      language: item.language,
      association,
      translations,
    });
    const serialized = JSON.stringify(dependencies ?? null);
    if (serialized === undefined) return "计划中的编辑依赖不能表示为 JSON。";
    const oldDependencies = JSON.parse(serialized) as JsonValue;
    return isDeepStrictEqual(oldDependencies, edit.expected.dependencies)
      ? undefined
      : "候选生成时声明的上下文依赖已变化。";
  } catch (error) {
    return `无法核对候选生成时的上下文依赖：${errorMessage(error)}`;
  }
}

function oldAssociationFact<TSource, TTranslation>(
  sourceKey: string,
  language: string,
  observation: UpdatePlanObservation<TSource, TTranslation>,
): TranslationAssociationFact {
  return {
    sourceKey,
    language,
    status: observation.association.status,
    coverageStatus: observation.association.coverageStatus,
    scopeIndexes: observation.association.scopes.map((_, index) => index),
    translationIndexes: observation.association.translations.map(
      (_, index) => index,
    ),
  };
}

function oldTranslationFacts<TSource, TTranslation>(
  language: string,
  observation: UpdatePlanObservation<TSource, TTranslation>,
): ActualTranslationFact<TTranslation>[] {
  return observation.association.translations.map(
    ({ range, translation, bodyAvailability }, index) => ({
      index,
      language,
      scopeIndex: Math.max(
        observation.association.scopes.findIndex((scope) =>
          isDeepStrictEqual(scope.range, range),
        ),
        0,
      ),
      range,
      translation,
      bodyAvailability,
    }),
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

function failSelections<TUnit extends TranslationUnitInput, TTranslation>(
  selections: readonly UpdatePlanSelection[],
  contentResults: Map<string, UpdatePlanContentResult<TUnit, TTranslation>>,
  baselineResults: Map<string, UpdatePlanBaselineResult>,
  baselineStatus: "failed" | "notAttempted",
  reason: string,
): UpdatePlanApplyResult<TUnit, TTranslation> {
  for (const selection of selections) {
    const id = pairKey(selection.sourceKey, selection.language);
    contentResults.set(id, {
      ...selectionPair(selection),
      status: "unprocessed",
      reason,
    });
    baselineResults.set(id, {
      ...selectionPair(selection),
      status: baselineStatus,
      reason,
    });
  }
  return finishResult(contentResults, baselineResults);
}

function finishResult<TUnit extends TranslationUnitInput, TTranslation>(
  contentResults: Map<string, UpdatePlanContentResult<TUnit, TTranslation>>,
  baselineResults: Map<string, UpdatePlanBaselineResult>,
): UpdatePlanApplyResult<TUnit, TTranslation> {
  return {
    contentResults: [...contentResults.values()],
    baselineResults: [...baselineResults.values()],
  };
}

function assertUniqueSelections(
  selections: readonly UpdatePlanSelection[],
): void {
  const seen = new Set<string>();
  for (const selection of selections) {
    const id = pairKey(selection.sourceKey, selection.language);
    if (seen.has(id))
      throw new TypeError("应用计划不能重复选择同一原文与语言。");
    seen.add(id);
  }
}

function selectionPair(selection: ProcessingBaselineSelection): {
  sourceKey: string;
  language: string;
} {
  return { sourceKey: selection.sourceKey, language: selection.language };
}

function pairKey(sourceKey: string, language: string): string {
  return JSON.stringify([sourceKey, language]);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
