import { isDeepStrictEqual } from "node:util";

import {
  ComparisonBaselineIncompleteSnapshotError,
  recordComparisonBaselineFromSnapshot,
} from "./baselines.ts";
import type {
  ComparisonBaselineStore,
  ComparisonSnapshot,
  FrameworkConfig,
  TranslationUnitInput,
} from "./index.ts";
import { readComparisonSnapshot } from "./index.ts";
import {
  resolveLanguageSelection,
  type LanguageSelectionOptions,
} from "./language-scope.ts";
import { isRecord } from "./object-guards.ts";
import {
  assertUpdatePlanLanguages,
  previewUpdate,
  validateUpdatePlan,
} from "./plans.ts";
import type { UpdatePlan, UpdatePlanAction, UpdatePlanItem } from "./plans.ts";
import type {
  TranslationWriteCondition,
  TranslationWriteStatus,
} from "./semantic-edits.ts";
import { writeTranslationRequests } from "./semantic-edits.ts";

export type UpdatePlanExecutionStatus =
  | TranslationWriteStatus
  | "retained"
  | "review"
  | "blocked";

export type UpdatePlanExecutionItemResult<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
> = {
  readonly index: number;
  readonly action: UpdatePlanAction;
  readonly status: UpdatePlanExecutionStatus;
  readonly reason?: string;
  readonly request?: UpdatePlanItem<
    TUnit,
    TTranslation,
    TBody,
    TUnavailable
  >["request"];
};

export type UpdatePlanApplyResult<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody = unknown,
  TUnavailable = never,
> = {
  readonly status: "completed" | "failed";
  readonly results: readonly UpdatePlanExecutionItemResult<
    TUnit,
    TTranslation,
    TBody,
    TUnavailable
  >[];
};

export type UpdateResult<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody = unknown,
  TUnavailable = never,
> = UpdatePlanApplyResult<TUnit, TTranslation, TBody, TUnavailable> & {
  readonly plan: UpdatePlan<TUnit, TTranslation, TBody, TUnavailable>;
  readonly baseline?: UpdateBaselineResult;
};

export type UpdateBaselineResult =
  | { readonly outcome: "saved" | "unchanged" }
  | { readonly outcome: "notAdvanced"; readonly message: string }
  | { readonly outcome: "failed"; readonly message: string };

type UpdateOptions<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
> = LanguageSelectionOptions & {
  readonly condition?: TranslationWriteCondition<
    TUnit,
    TTranslation,
    TBody,
    TUnavailable
  >;
  /** 仅在全语言更新完整处理、回读并核对后记录比较基线。 */
  readonly recordBaseline?: boolean;
};

/**
 * 直接消费已保存的决定；不读取基线、不比较、不运行策略。
 * 显式选择语言时，越界计划整批拒绝；写入前后的复查也限定在所选语言。
 */
export async function applyUpdatePlan<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  plan: unknown,
  config: FrameworkConfig<TUnit, TTranslation, TBody, TUnavailable>,
  condition?: TranslationWriteCondition<
    TUnit,
    TTranslation,
    TBody,
    TUnavailable
  >,
  options: LanguageSelectionOptions = {},
): Promise<UpdatePlanApplyResult<TUnit, TTranslation, TBody, TUnavailable>> {
  const languages = resolveLanguageSelection(
    config.translations?.languages ?? [],
    options,
  );
  validateUpdatePlan(plan);
  const validatedPlan = plan as unknown as UpdatePlan<
    TUnit,
    TTranslation,
    TBody,
    TUnavailable
  >;
  if (options.languages !== undefined)
    assertUpdatePlanLanguages(validatedPlan, languages);
  const requests = [] as UpdatePlanItem<
    TUnit,
    TTranslation,
    TBody,
    TUnavailable
  >[];
  const requestIndexes: number[] = [];
  for (const [index, item] of validatedPlan.items.entries()) {
    if (item.action === "write" || item.action === "delete") {
      if (item.request === undefined)
        throw new TypeError(`更新计划第 ${index + 1} 项缺少写入请求。`);
      if (item.request.operation !== item.action)
        throw new TypeError(`更新计划第 ${index + 1} 项的操作与请求不匹配。`);
      requests.push(item);
      requestIndexes.push(index);
    } else if (item.request !== undefined) {
      throw new TypeError(`更新计划第 ${index + 1} 项不应包含写入请求。`);
    }
  }

  const writes =
    requests.length === 0
      ? { results: [] }
      : await writeTranslationRequests(
          requests.map(({ request }) => {
            if (request === undefined)
              throw new TypeError("更新计划写入项缺少请求。");
            return request;
          }),
          config,
          condition,
          options,
        );
  const writesByPlanIndex = new Map(
    requestIndexes.map((planIndex, writeIndex) => [
      planIndex,
      writes.results[writeIndex],
    ]),
  );

  const results: UpdatePlanExecutionItemResult<
    TUnit,
    TTranslation,
    TBody,
    TUnavailable
  >[] = validatedPlan.items.map((item, index) => {
    if (item.action === "write" || item.action === "delete") {
      const writeResult = writesByPlanIndex.get(index);
      if (writeResult === undefined)
        throw new TypeError(`更新计划第 ${index + 1} 项缺少写入结果。`);
      return {
        index,
        action: item.action,
        status: writeResult.status,
        ...(writeResult.reason === undefined
          ? {}
          : { reason: writeResult.reason }),
        request: writeResult.request,
      };
    }
    const status: UpdatePlanExecutionStatus =
      item.action === "retain" ? "retained" : item.action;
    return {
      index,
      action: item.action,
      status,
      reason: item.reason,
    };
  });
  const failed = results.some(
    ({ status }) =>
      status === "conflict" ||
      status === "notWritable" ||
      status === "writeFailed" ||
      status === "writeUnconfirmed",
  );
  return { status: failed ? "failed" : "completed", results };
}

/**
 * 正式更新入口默认只规划并执行资源修改；recordBaseline 显式组合全语言完整更新与基线记录。
 * options.condition 可为每次写入追加业务条件。
 */
export async function update<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  config: FrameworkConfig<TUnit, TTranslation, TBody, TUnavailable>,
  store?: ComparisonBaselineStore<TUnit, TTranslation, TBody, TUnavailable>,
  options: UpdateOptions<TUnit, TTranslation, TBody, TUnavailable> = {},
): Promise<UpdateResult<TUnit, TTranslation, TBody, TUnavailable>> {
  if (!isRecord(options))
    throw new TypeError(
      "update 的第三参数必须是选项对象；请通过 options.condition 传入附加写入条件。",
    );
  if (
    options.recordBaseline !== undefined &&
    typeof options.recordBaseline !== "boolean"
  )
    throw new TypeError("update 的 options.recordBaseline 必须是布尔值。");
  if (options.recordBaseline === true) {
    if (store === undefined)
      throw new TypeError("记录比较基线需要提供比较基线存储。");
    const configuredLanguages = [
      ...new Set(config.translations?.languages ?? []),
    ];
    const selectedLanguages = resolveLanguageSelection(
      config.translations?.languages ?? [],
      options,
    );
    if (selectedLanguages.length !== configuredLanguages.length)
      throw new TypeError("记录比较基线要求本次更新覆盖全部配置语言。");
  }
  const plan = await previewUpdate(config, store, options);
  const execution = await applyUpdatePlan(
    plan,
    config,
    options.condition,
    options,
  );
  if (options.recordBaseline !== true) return { ...execution, plan };
  if (store === undefined)
    throw new TypeError("记录比较基线需要提供比较基线存储。");

  const baseline = await advanceBaselineAfterUpdate(
    config,
    store,
    plan,
    execution,
  );
  return {
    ...execution,
    status:
      baseline.outcome === "saved" || baseline.outcome === "unchanged"
        ? execution.status
        : "failed",
    plan,
    baseline,
  };
}

async function advanceBaselineAfterUpdate<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  config: FrameworkConfig<TUnit, TTranslation, TBody, TUnavailable>,
  store: ComparisonBaselineStore<TUnit, TTranslation, TBody, TUnavailable>,
  plan: UpdatePlan<TUnit, TTranslation, TBody, TUnavailable>,
  execution: UpdatePlanApplyResult<TUnit, TTranslation, TBody, TUnavailable>,
): Promise<UpdateBaselineResult> {
  if (Object.hasOwn(execution, "batchError"))
    return {
      outcome: "notAdvanced",
      message: "批次写回发生异常；比较基线保留。",
    };
  if (execution.status !== "completed")
    return {
      outcome: "notAdvanced",
      message: "更新未完整成功；比较基线保留。",
    };
  if (!allUpdateChangesProcessed(plan, execution.results))
    return {
      outcome: "notAdvanced",
      message: "仍有更新变化未处理或待复核；比较基线保留。",
    };

  let current: ComparisonSnapshot<TUnit, TTranslation, TBody, TUnavailable>;
  try {
    current = await readComparisonSnapshot(config);
  } catch (error) {
    return {
      outcome: "notAdvanced",
      message: `执行后完整回读失败；比较基线保留：${errorMessage(error)}`,
    };
  }
  if (!isDeepStrictEqual(plan.current.source, current.source))
    return {
      outcome: "notAdvanced",
      message: "执行后原文与本次更新依据不一致；比较基线保留。",
    };

  try {
    const result = await recordComparisonBaselineFromSnapshot(current, store);
    return { outcome: result.outcome };
  } catch (error) {
    if (error instanceof ComparisonBaselineIncompleteSnapshotError)
      return {
        outcome: "notAdvanced",
        message: `${error.message}比较基线保留。`,
      };
    return {
      outcome: "failed",
      message: `译文已写入，基线未推进：${errorMessage(error)}`,
    };
  }
}

function allUpdateChangesProcessed<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  plan: UpdatePlan<TUnit, TTranslation, TBody, TUnavailable>,
  results: readonly UpdatePlanExecutionItemResult<
    TUnit,
    TTranslation,
    TBody,
    TUnavailable
  >[],
): boolean {
  if (
    results.length !== plan.items.length ||
    results.some(({ status }) => status !== "written" && status !== "retained")
  )
    return false;

  const sourceLanguagePairs = new Set(
    plan.items.flatMap(({ sourceKey, language, changes }) => {
      const key = sourceKey ?? changes.source?.key;
      return key === undefined ? [] : [sourceLanguageKey(key, language)];
    }),
  );
  const changedSourceKeys = new Set(
    plan.comparisons.sourceChanges.flatMap(({ key, status, current }) =>
      status === "unchanged" || current === undefined ? [] : [key],
    ),
  );
  for (const source of plan.current.source.units) {
    for (const read of plan.current.translations.reads) {
      const association = plan.associations.current.find(
        (item) =>
          item.sourceKey === source.key && item.language === read.language,
      );
      const requiresDecision =
        changedSourceKeys.has(source.key) ||
        association === undefined ||
        association.status !== "matched";
      if (
        requiresDecision &&
        !sourceLanguagePairs.has(sourceLanguageKey(source.key, read.language))
      )
        return false;
    }
  }

  const translationKeys = new Set(
    plan.items.flatMap(({ changes }) =>
      changes.translations.map(({ identity }) =>
        JSON.stringify([identity.language, identity.namespace, identity.key]),
      ),
    ),
  );
  if (
    plan.comparisons.translationChanges.some(
      ({ identity, status, current }) =>
        status !== "unchanged" &&
        current !== undefined &&
        !translationKeys.has(
          JSON.stringify([identity.language, identity.namespace, identity.key]),
        ),
    )
  )
    return false;

  return removedSourceTargetsAreProcessed(plan);
}

function sourceLanguageKey(sourceKey: string, language: string): string {
  return JSON.stringify([sourceKey, language]);
}

function removedSourceTargetsAreProcessed<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(plan: UpdatePlan<TUnit, TTranslation, TBody, TUnavailable>): boolean {
  if (plan.previous === undefined) return true;
  const currentTargets = new Set(
    plan.current.translations.records.map(({ identity }) =>
      JSON.stringify([identity.language, identity.namespace, identity.key]),
    ),
  );
  for (const sourceChange of plan.comparisons.sourceChanges) {
    if (sourceChange.status !== "removed") continue;
    for (const association of plan.associations.previous) {
      if (association.sourceKey !== sourceChange.key) continue;
      for (const index of association.translationIndexes) {
        const previous = plan.previous.translations.records[index];
        if (previous === undefined) return false;
        const key = JSON.stringify([
          previous.identity.language,
          previous.identity.namespace,
          previous.identity.key,
        ]);
        if (!currentTargets.has(key)) continue;
        const isProcessed = plan.items.some(
          (item) =>
            item.language === association.language &&
            item.changes.translations.some(
              ({ identity }) =>
                JSON.stringify([
                  identity.language,
                  identity.namespace,
                  identity.key,
                ]) === key,
            ),
        );
        if (!isProcessed) return false;
      }
    }
  }
  return true;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
