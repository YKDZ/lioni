import type {
  ComparisonBaselineStore,
  FrameworkConfig,
  TranslationUnitInput,
} from "./index.ts";
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
  /** 批量写回抛出的原始异常；逐项结果仍保留回读确认的实际状态。 */
  readonly batchError?: unknown;
};

export type UpdateResult<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody = unknown,
  TUnavailable = never,
> = UpdatePlanApplyResult<TUnit, TTranslation, TBody, TUnavailable> & {
  readonly plan: UpdatePlan<TUnit, TTranslation, TBody, TUnavailable>;
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
  const batchFailed = Object.hasOwn(writes, "batchError");
  const batchError = "batchError" in writes ? writes.batchError : undefined;
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
  const failed =
    batchFailed ||
    results.some(
      ({ status }) =>
        status === "conflict" ||
        status === "notWritable" ||
        status === "writeFailed" ||
        status === "writeUnconfirmed",
    );
  return {
    status: failed ? "failed" : "completed",
    results,
    ...(batchFailed ? { batchError } : {}),
  };
}

/**
 * 正式更新入口：在本次语言范围内规划并执行，不自动记录比较基线。
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
  options: LanguageSelectionOptions & {
    readonly condition?: TranslationWriteCondition<
      TUnit,
      TTranslation,
      TBody,
      TUnavailable
    >;
  } = {},
): Promise<UpdateResult<TUnit, TTranslation, TBody, TUnavailable>> {
  if (!isRecord(options))
    throw new TypeError(
      "update 的第三参数必须是选项对象；请通过 options.condition 传入附加写入条件。",
    );
  const plan = await previewUpdate(config, store, options);
  const execution = await applyUpdatePlan(
    plan,
    config,
    options.condition,
    options,
  );
  return { ...execution, plan };
}
