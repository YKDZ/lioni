import type {
  ComparisonBaselineStore,
  FrameworkConfig,
  TranslationUnitInput,
} from "./index.ts";
import { previewUpdate, validateUpdatePlan } from "./plans.ts";
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
};

/** 直接消费已保存的决定；不读取基线、不比较、不运行策略。 */
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
): Promise<UpdatePlanApplyResult<TUnit, TTranslation, TBody, TUnavailable>> {
  validateUpdatePlan(plan);
  const validatedPlan = plan as unknown as UpdatePlan<
    TUnit,
    TTranslation,
    TBody,
    TUnavailable
  >;
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

/** 正式更新入口：规划一次，再直接执行该计划，不自动记录比较基线。 */
export async function update<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  config: FrameworkConfig<TUnit, TTranslation, TBody, TUnavailable>,
  store?: ComparisonBaselineStore<TUnit, TTranslation, TBody, TUnavailable>,
  condition?: TranslationWriteCondition<
    TUnit,
    TTranslation,
    TBody,
    TUnavailable
  >,
): Promise<UpdateResult<TUnit, TTranslation, TBody, TUnavailable>> {
  const plan = await previewUpdate(config, store);
  const execution = await applyUpdatePlan(plan, config, condition);
  return { ...execution, plan };
}
