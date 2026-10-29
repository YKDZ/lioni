import { isDeepStrictEqual } from "node:util";

import {
  readComparisonSnapshot,
  readSourceFacts,
  TranslationIdentityContractError,
} from "./index.ts";
import type {
  ActualTranslationFact,
  Awaitable,
  ComparisonSnapshot,
  FrameworkConfig,
  SourceFacts,
  SourceUnitFact,
  TranslationIdentity,
  TranslationReadFact,
  TranslationUnitInput,
} from "./index.ts";
import {
  resolveLanguageSelection,
  type LanguageSelectionOptions,
} from "./language-scope.ts";
import { isRecord } from "./object-guards.ts";
import {
  assertJsonValue,
  snapshotJsonValue,
  StandardSchemaContractError,
  validateWithStandardSchema,
} from "./standard-schema.ts";
import type { JsonValue } from "./standard-schema.ts";
import type { StandardSchemaV1 } from "./standard-schema.ts";
import { readTranslationFacts } from "./translation-snapshot.ts";

export type { JsonValue } from "./standard-schema.ts";

export type TranslationWriteTarget =
  | { readonly sourceKey: string; readonly language: string }
  | { readonly identity: TranslationIdentity };

export type SemanticEditCandidate<TBody = JsonValue> = {
  readonly sourceKey: string;
  readonly language: string;
  readonly content: TBody;
};

export type TranslationWriteSourceExpectation<TUnit = JsonValue> =
  | {
      readonly presence: "present";
      readonly key: string;
      readonly range: JsonValue;
      readonly unit: TUnit;
      readonly content: JsonValue;
    }
  | {
      readonly presence: "absent";
      readonly key: string;
      readonly range: JsonValue;
    };

export type TranslationWriteTargetExpectation<TBody = JsonValue> =
  | { readonly status: "missing" }
  | {
      readonly status: "present";
      readonly identity: TranslationIdentity;
      readonly content: TBody;
      readonly range?: JsonValue;
      /** 可选地锁定宿主原始目标记录中的关联字段等写入依据。 */
      readonly record?: JsonValue;
    };

export type TranslationWriteRequest<
  TBody = JsonValue,
  TUnit extends TranslationUnitInput = TranslationUnitInput,
> =
  | {
      readonly operation: "write";
      readonly target: TranslationWriteTarget;
      readonly content: TBody;
      readonly expectedSource?: TranslationWriteSourceExpectation<TUnit>;
      readonly expectedTarget: TranslationWriteTargetExpectation<TBody>;
    }
  | {
      readonly operation: "delete";
      readonly target: { readonly identity: TranslationIdentity };
      readonly expectedSource?: TranslationWriteSourceExpectation<TUnit>;
      readonly expectedTarget: Extract<
        TranslationWriteTargetExpectation<TBody>,
        { readonly status: "present" }
      >;
    };

export type TranslationWritebackTarget = {
  readonly kind: "existing" | "create";
  readonly locator: JsonValue;
};

export type TranslationWritebackResolution =
  | { readonly status: "located"; readonly locator: JsonValue }
  | { readonly status: "notWritable"; readonly reason: string };

type AvailableTranslationFact<TTranslation, TBody, TUnavailable> = Extract<
  ActualTranslationFact<TTranslation, TBody, TUnavailable>,
  { readonly bodyAvailability: "available" }
>;

export type TranslationWritebackInput<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody = JsonValue,
  TUnavailable = never,
> = {
  readonly request: TranslationWriteRequest<TBody, TUnit>;
  readonly target: TranslationWritebackTarget;
  readonly sourceUnit?: SourceUnitFact<TUnit>;
  readonly currentTranslation?: AvailableTranslationFact<
    TTranslation,
    TBody,
    TUnavailable
  >;
};

export type TranslationWritebackAdapter<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody = JsonValue,
  TUnavailable = never,
> = {
  readonly locateExistingTarget?: (input: {
    readonly identity: TranslationIdentity;
    readonly translation: AvailableTranslationFact<
      TTranslation,
      TBody,
      TUnavailable
    >;
  }) => Awaitable<TranslationWritebackResolution>;
  readonly locateNewTarget?: (input: {
    readonly sourceKey: string;
    readonly sourceUnit: SourceUnitFact<TUnit>;
    readonly language: string;
  }) => Awaitable<TranslationWritebackResolution>;
  /** 单目标写回；未配置 writeBatch 时按物理目标组调用。 */
  readonly write?: (
    input: TranslationWritebackInput<TUnit, TTranslation, TBody, TUnavailable>,
  ) => Awaitable<void>;
  /**
   * 配置后优先使用。一次接收同一份初始事实下完成预检的独立请求；
   * 同一物理目标的兼容请求只传一个代表项，但回读仍逐项确认。批次不承诺执行顺序或事务；
   * 返回或抛错后，框架会统一回读资源并逐项确认实际结果。
   */
  readonly writeBatch?: (input: {
    readonly requests: readonly TranslationWritebackInput<
      TUnit,
      TTranslation,
      TBody,
      TUnavailable
    >[];
  }) => Awaitable<void>;
};

export type TranslationWriteConditionInput<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
> = {
  readonly request: TranslationWriteRequest<TBody, TUnit>;
  readonly current: ComparisonSnapshot<
    TUnit,
    TTranslation,
    TBody,
    TUnavailable
  >;
  readonly target: TranslationWritebackTarget;
  readonly sourceUnit?: SourceUnitFact<TUnit>;
  readonly currentTranslation?: AvailableTranslationFact<
    TTranslation,
    TBody,
    TUnavailable
  >;
};

export type TranslationWriteConditionResult =
  | boolean
  | { readonly status: "allowed" }
  | { readonly status: "rejected"; readonly reason: string };

/** 消费者可在默认输入核对外，再组合基线、QA 或其他明确条件。 */
export type TranslationWriteCondition<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
> = (
  input: TranslationWriteConditionInput<
    TUnit,
    TTranslation,
    TBody,
    TUnavailable
  >,
) => Awaitable<TranslationWriteConditionResult>;

export type TranslationWriteStatus =
  | "written"
  | "writeUnconfirmed"
  | "conflict"
  | "notWritable"
  | "writeFailed";

export type TranslationWriteResult<
  TBody = JsonValue,
  TUnit extends TranslationUnitInput = TranslationUnitInput,
> = {
  readonly request: TranslationWriteRequest<TBody, TUnit>;
  readonly status: TranslationWriteStatus;
  readonly reason?: string;
};

export type TranslationWriteBatchResult<
  TBody = JsonValue,
  TUnit extends TranslationUnitInput = TranslationUnitInput,
> = {
  readonly results: readonly TranslationWriteResult<TBody, TUnit>[];
  /** 批量适配器抛出的原始异常；逐项回读结果仍然有效且单独表达。 */
  readonly batchError?: unknown;
};

type PreparedWrite<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
> = {
  readonly index: number;
  readonly request: TranslationWriteRequest<TBody, TUnit>;
  readonly target: TranslationWritebackTarget;
  readonly sourceUnit?: SourceUnitFact<TUnit>;
  readonly currentTranslation?: AvailableTranslationFact<
    TTranslation,
    TBody,
    TUnavailable
  >;
};

type WriteSnapshot<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
> = {
  readonly source?: SourceFacts<TUnit>;
  readonly translations: {
    readonly reads: readonly TranslationReadFact[];
    readonly records: readonly ActualTranslationFact<
      TTranslation,
      TBody,
      TUnavailable
    >[];
  };
};

/** 校验候选正文数据；是否检查或写入由调用者另外组合。 */
export async function validateSemanticEditCandidate<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  value: unknown,
  config: FrameworkConfig<TUnit, TTranslation, TBody, TUnavailable>,
): Promise<SemanticEditCandidate<TBody>> {
  if (
    !isRecord(value) ||
    typeof value.sourceKey !== "string" ||
    typeof value.language !== "string" ||
    !Object.hasOwn(value, "content")
  )
    throw new TypeError(
      "译文候选必须包含字符串 sourceKey、language 和 content。",
    );
  const contentSchema = config.translations?.contentSchema;
  if (contentSchema === undefined)
    throw new TypeError("验证译文候选需要 translations.contentSchema。");
  const validatedContent = await validateWithStandardSchema(
    contentSchema,
    value.content,
    "译文候选正文",
    { preserveValue: true, requireJson: true },
  );
  return {
    sourceKey: value.sourceKey,
    language: value.language,
    content: snapshotValue(validatedContent, "译文候选正文"),
  };
}

/** 校验可保存的写入请求，保留宿主提供的 JSON 正文与完整原文。 */
export async function validateTranslationWriteRequest<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  value: unknown,
  config: FrameworkConfig<TUnit, TTranslation, TBody, TUnavailable>,
): Promise<TranslationWriteRequest<TBody, TUnit>> {
  assertJsonValue(value, "译文写入请求");
  if (
    !isRecord(value) ||
    (value.operation !== "write" && value.operation !== "delete")
  )
    invalidWriteRequest("必须包含 write 或 delete 操作。");
  const translations = config.translations;
  if (translations === undefined)
    invalidWriteRequest("验证译文写入请求需要 translations 配置。");

  const target = validateTarget(value.target, value.operation);
  const expectedTarget = await validateExpectedTarget(
    value.expectedTarget,
    value.operation,
    target,
    translations.contentSchema,
  );
  const expectedSource = Object.hasOwn(value, "expectedSource")
    ? await validateExpectedSource(value.expectedSource, config, target)
    : undefined;
  if (value.operation === "write") {
    if (!Object.hasOwn(value, "content"))
      invalidWriteRequest("write 请求必须包含 content。");
    const validatedContent = await validateWithStandardSchema(
      translations.contentSchema,
      value.content,
      "译文写入正文",
      { preserveValue: true, requireJson: true },
    );
    const content = snapshotValue(validatedContent, "译文写入正文");
    if (
      ("sourceKey" in target && expectedTarget.status !== "missing") ||
      ("identity" in target && expectedTarget.status !== "present")
    )
      invalidWriteRequest("新建与既有目标的 expectedTarget 不匹配。");
    return {
      operation: "write",
      target,
      content,
      ...(expectedSource === undefined ? {} : { expectedSource }),
      expectedTarget,
    };
  }

  if (Object.hasOwn(value, "content"))
    invalidWriteRequest("delete 请求不能包含 content。");
  if (!("identity" in target))
    invalidWriteRequest("delete 只能引用现存译文 identity。");
  if (expectedTarget.status !== "present")
    invalidWriteRequest("delete 请求必须包含现存目标的预期身份与正文。");
  return {
    operation: "delete",
    target,
    ...(expectedSource === undefined ? {} : { expectedSource }),
    expectedTarget,
  };
}

/**
 * 直接执行人工或外部工具提供的写入候选与删除决定。
 * 显式选择语言时，越界请求整批拒绝，写入前后只读取所选语言。
 */
export async function writeTranslationRequests<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  requests: readonly TranslationWriteRequest<TBody, TUnit>[],
  config: FrameworkConfig<TUnit, TTranslation, TBody, TUnavailable>,
  condition?: TranslationWriteCondition<
    TUnit,
    TTranslation,
    TBody,
    TUnavailable
  >,
  options: LanguageSelectionOptions = {},
): Promise<TranslationWriteBatchResult<TBody, TUnit>> {
  const languages = resolveLanguageSelection(
    config.translations?.languages ?? [],
    options,
  );
  if (!Array.isArray(requests)) invalidWriteRequest("requests 必须是数组。");
  if (requests.length === 0) return { results: [] };

  const validated = await Promise.all(
    requests.map((request) => validateTranslationWriteRequest(request, config)),
  );
  if (options.languages !== undefined) {
    for (const request of validated) {
      const language =
        "identity" in request.target
          ? request.target.identity.language
          : request.target.language;
      if (!languages.includes(language))
        invalidWriteRequest(
          `写入请求引用了本次未选择的目标语言 ${JSON.stringify(language)}。`,
        );
    }
  }
  const results: (TranslationWriteResult<TBody, TUnit> | undefined)[] =
    validated.map((request) => ({ request, status: "notWritable" }));
  const adapter = config.translationWriteback;
  if (
    adapter === undefined ||
    (adapter.write === undefined && adapter.writeBatch === undefined)
  ) {
    return {
      results: validated.map((request) => ({
        request,
        status: "notWritable",
        reason: "宿主没有提供译文写入能力。",
      })),
    };
  }
  if (
    adapter.writeBatch !== undefined &&
    typeof adapter.writeBatch !== "function"
  )
    throw new StandardSchemaContractError(
      "译文写回适配器",
      "schema-mismatch",
      "translationWriteback.writeBatch 必须是函数。",
    );
  if (adapter.writeBatch === undefined && typeof adapter.write !== "function")
    throw new StandardSchemaContractError(
      "译文写回适配器",
      "schema-mismatch",
      "translationWriteback.write 必须是函数。",
    );
  if (condition !== undefined && typeof condition !== "function")
    throw new StandardSchemaContractError(
      "译文写入条件",
      "schema-mismatch",
      "附加写入条件必须是函数。",
    );

  const needsSource =
    condition !== undefined ||
    validated.some(
      ({ expectedSource, target }) =>
        expectedSource !== undefined || "sourceKey" in target,
    );
  const readCurrent = () =>
    condition === undefined
      ? readWriteSnapshot(config, needsSource, languages)
      : readComparisonSnapshot(config, options);
  let current: WriteSnapshot<TUnit, TTranslation, TBody, TUnavailable>;
  try {
    current = await readCurrent();
  } catch (error) {
    rethrowContractError(error);
    const reason = `读取当前事实失败：${errorMessage(error)}`;
    return {
      results: validated.map((request) => ({
        request,
        status: "notWritable",
        reason,
      })),
    };
  }

  const prepared: PreparedWrite<TUnit, TTranslation, TBody, TUnavailable>[] =
    [];
  for (const [index, request] of validated.entries()) {
    const resolved = await prepareWrite(index, request, current, config);
    if (resolved.status !== "ready") {
      results[index] = {
        request,
        status: resolved.status,
        reason: resolved.reason,
      };
      continue;
    }
    if (condition !== undefined) {
      let decision: TranslationWriteConditionResult;
      try {
        decision = await condition({
          request,
          current: current as ComparisonSnapshot<
            TUnit,
            TTranslation,
            TBody,
            TUnavailable
          >,
          target: resolved.target,
          ...(resolved.sourceUnit === undefined
            ? {}
            : { sourceUnit: resolved.sourceUnit }),
          ...(resolved.currentTranslation === undefined
            ? {}
            : { currentTranslation: resolved.currentTranslation }),
        });
      } catch (error) {
        rethrowContractError(error);
        results[index] = {
          request,
          status: "notWritable",
          reason: `执行附加条件失败：${errorMessage(error)}`,
        };
        continue;
      }
      if (decision === false) {
        results[index] = {
          request,
          status: "conflict",
          reason: "消费者提供的附加条件未通过。",
        };
        continue;
      }
      if (
        decision === true ||
        (isRecord(decision) && decision.status === "allowed")
      ) {
        // 允许；继续处理已完成预检的批次。
      } else if (
        isRecord(decision) &&
        decision.status === "rejected" &&
        typeof decision.reason === "string"
      ) {
        results[index] = {
          request,
          status: "conflict",
          reason: decision.reason,
        };
        continue;
      } else {
        throw new StandardSchemaContractError(
          "译文写入条件",
          "invalid-schema-result",
          "附加条件必须返回布尔值或 allowed/rejected 结果。",
        );
      }
    }
    prepared.push(resolved);
  }

  const groups = groupByPhysicalTarget(prepared);
  const writableGroups: PreparedWrite<
    TUnit,
    TTranslation,
    TBody,
    TUnavailable
  >[][] = [];
  const writable: PreparedWrite<TUnit, TTranslation, TBody, TUnavailable>[] =
    [];
  for (const group of groups) {
    if (!compatibleRequests(group)) {
      for (const item of group) {
        results[item.index] = {
          request: item.request,
          status: "conflict",
          reason: "多个写入请求解析到同一物理目标且修改互不相容。",
        };
      }
      continue;
    }
    writableGroups.push(group);
    writable.push(...group);
  }

  if (adapter.writeBatch !== undefined) {
    if (writable.length === 0)
      return { results: completeWriteResults(validated, results) };

    const batchRequests = writableGroups.flatMap(([first]) =>
      first === undefined ? [] : [first],
    );
    let batchFailed = false;
    let batchError: unknown;
    try {
      await adapter.writeBatch({
        requests: batchRequests.map((item) => ({
          request: item.request,
          target: item.target,
          ...(item.sourceUnit === undefined
            ? {}
            : { sourceUnit: item.sourceUnit }),
          ...(item.currentTranslation === undefined
            ? {}
            : { currentTranslation: item.currentTranslation }),
        })),
      });
    } catch (error) {
      batchFailed = true;
      batchError = error;
    }

    let after: WriteSnapshot<TUnit, TTranslation, TBody, TUnavailable>;
    try {
      after = await readCurrent();
    } catch (error) {
      const reason = `批量写入后回读失败：${errorMessage(error)}`;
      for (const item of writable) {
        results[item.index] = {
          request: item.request,
          status: "writeUnconfirmed",
          reason,
        };
      }
      return {
        results: completeWriteResults(validated, results),
        ...(batchFailed ? { batchError } : {}),
      };
    }

    for (const item of writable) {
      if (confirmsWrite(item, after, config)) {
        results[item.index] = { request: item.request, status: "written" };
        continue;
      }
      if (batchFailed && canConfirmWriteFailure(item, after, config)) {
        results[item.index] = {
          request: item.request,
          status: "writeFailed",
          reason: `批量写入失败：${errorMessage(batchError)}`,
        };
        continue;
      }
      results[item.index] = {
        request: item.request,
        status: "writeUnconfirmed",
        reason: batchFailed
          ? `批量写入失败，且回读不足以确认此项：${errorMessage(batchError)}`
          : "批量写入已返回，但回读未确认预期目标结果。",
      };
    }
    return {
      results: completeWriteResults(validated, results),
      ...(batchFailed ? { batchError } : {}),
    };
  }

  for (const group of writableGroups) {
    const [first] = group;
    if (first === undefined) continue;
    try {
      await adapter.write!({
        request: first.request,
        target: first.target,
        ...(first.sourceUnit === undefined
          ? {}
          : { sourceUnit: first.sourceUnit }),
        ...(first.currentTranslation === undefined
          ? {}
          : { currentTranslation: first.currentTranslation }),
      });
    } catch (error) {
      rethrowContractError(error);
      const reason = `写入失败：${errorMessage(error)}`;
      for (const item of group) {
        results[item.index] = {
          request: item.request,
          status: "writeFailed",
          reason,
        };
      }
      continue;
    }

    let after: WriteSnapshot<TUnit, TTranslation, TBody, TUnavailable>;
    try {
      after = await readCurrent();
    } catch (error) {
      rethrowContractError(error);
      const reason = `写入已返回成功，但回读失败：${errorMessage(error)}`;
      for (const item of group) {
        results[item.index] = {
          request: item.request,
          status: "writeUnconfirmed",
          reason,
        };
      }
      continue;
    }

    for (const item of group) {
      results[item.index] = confirmsWrite(item, after, config)
        ? { request: item.request, status: "written" }
        : {
            request: item.request,
            status: "writeUnconfirmed",
            reason: "写入已返回成功，但回读未确认预期目标结果。",
          };
    }
  }

  return {
    results: completeWriteResults(validated, results),
  };
}

function completeWriteResults<TBody, TUnit extends TranslationUnitInput>(
  validated: readonly TranslationWriteRequest<TBody, TUnit>[],
  results: readonly (TranslationWriteResult<TBody, TUnit> | undefined)[],
): TranslationWriteResult<TBody, TUnit>[] {
  return results.map((result, index) => {
    if (result !== undefined) return result;
    const request = validated[index];
    if (request === undefined)
      throw new StandardSchemaContractError(
        "译文写入结果",
        "invalid-schema-result",
        "执行结果缺少对应请求。",
      );
    return { request, status: "notWritable", reason: "写入项未处理。" };
  });
}

async function readWriteSnapshot<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  config: FrameworkConfig<TUnit, TTranslation, TBody, TUnavailable>,
  includeSource: boolean,
  languages: readonly string[],
): Promise<WriteSnapshot<TUnit, TTranslation, TBody, TUnavailable>> {
  const source = includeSource ? await readSourceFacts(config) : undefined;
  const translations = await readTranslationFacts(
    config.translations,
    source?.units ?? [],
    languages,
  );
  return {
    ...(source === undefined ? {} : { source }),
    translations,
  };
}

type PreparedWriteResolution<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
> =
  | (PreparedWrite<TUnit, TTranslation, TBody, TUnavailable> & {
      readonly status: "ready";
    })
  | {
      readonly status: "conflict" | "notWritable";
      readonly reason: string;
    };

async function prepareWrite<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  index: number,
  request: TranslationWriteRequest<TBody, TUnit>,
  current: WriteSnapshot<TUnit, TTranslation, TBody, TUnavailable>,
  config: FrameworkConfig<TUnit, TTranslation, TBody, TUnavailable>,
): Promise<PreparedWriteResolution<TUnit, TTranslation, TBody, TUnavailable>> {
  const sourceCheck = checkExpectedSource(request, current);
  if (sourceCheck.status !== "ready") return sourceCheck;
  const adapter = config.translationWriteback;
  if (adapter === undefined)
    return { status: "notWritable", reason: "宿主没有提供译文写入适配器。" };

  let sourceUnit = sourceCheck.sourceUnit;
  let currentTranslation:
    | AvailableTranslationFact<TTranslation, TBody, TUnavailable>
    | undefined;
  let target: TranslationWritebackTarget;
  let resolved: TranslationWritebackResolution;
  try {
    if ("sourceKey" in request.target) {
      sourceUnit = findSourceUnit(current, request.target.sourceKey);
      if (sourceUnit === undefined)
        return sourceAbsenceResult(current, request.target.sourceKey);
      const targetAbsence = checkSourceTargetMissing(
        current,
        sourceUnit,
        request.target.language,
        config,
      );
      if (targetAbsence.status !== "ready") return targetAbsence;
      if (adapter.locateNewTarget === undefined)
        return {
          status: "notWritable",
          reason: "宿主没有提供新目标定位能力。",
        };
      if (typeof adapter.locateNewTarget !== "function")
        throw new StandardSchemaContractError(
          "译文写回适配器",
          "schema-mismatch",
          "translationWriteback.locateNewTarget 必须是函数。",
        );
      resolved = validateWritebackResolution(
        await adapter.locateNewTarget({
          sourceKey: request.target.sourceKey,
          sourceUnit,
          language: request.target.language,
        }),
      );
      if (resolved.status === "notWritable")
        return { status: "notWritable", reason: resolved.reason };
      target = {
        kind: "create",
        locator: snapshotJson(resolved.locator, "目标定位"),
      };
    } else {
      currentTranslation = findTranslationByIdentity(
        current,
        request.target.identity,
      ) as
        | AvailableTranslationFact<TTranslation, TBody, TUnavailable>
        | undefined;
      if (currentTranslation === undefined) {
        if (
          isTranslationReadComplete(current, request.target.identity.language)
        )
          return {
            status: "conflict",
            reason: "预期存在的译文目标现在已缺失。",
          };
        return {
          status: "notWritable",
          reason: "目标语言读取不足，无法确认译文目标。",
        };
      }
      if (currentTranslation.bodyAvailability !== "available")
        return {
          status: "notWritable",
          reason: "目标译文正文不可用，无法核对写入条件。",
        };
      if (request.expectedTarget.status !== "present")
        return {
          status: "notWritable",
          reason: "现有目标请求缺少预期译文事实。",
        };
      if (
        !isDeepStrictEqual(
          currentTranslation.content,
          request.expectedTarget.content,
        )
      )
        return { status: "conflict", reason: "目标译文正文已变化。" };
      if (
        request.expectedTarget.range !== undefined &&
        !isDeepStrictEqual(
          currentTranslation.range,
          request.expectedTarget.range,
        )
      )
        return { status: "conflict", reason: "目标译文所在范围已变化。" };
      if (
        request.expectedTarget.record !== undefined &&
        !isDeepStrictEqual(
          currentTranslation.translation,
          request.expectedTarget.record,
        )
      )
        return { status: "conflict", reason: "目标译文记录已变化。" };
      if (adapter.locateExistingTarget === undefined)
        return {
          status: "notWritable",
          reason: "宿主没有提供现有目标定位能力。",
        };
      if (typeof adapter.locateExistingTarget !== "function")
        throw new StandardSchemaContractError(
          "译文写回适配器",
          "schema-mismatch",
          "translationWriteback.locateExistingTarget 必须是函数。",
        );
      resolved = validateWritebackResolution(
        await adapter.locateExistingTarget({
          identity: request.target.identity,
          translation: currentTranslation,
        }),
      );
      if (resolved.status === "notWritable")
        return { status: "notWritable", reason: resolved.reason };
      target = {
        kind: "existing",
        locator: snapshotJson(resolved.locator, "目标定位"),
      };
    }
  } catch (error) {
    rethrowContractError(error);
    return { status: "notWritable", reason: errorMessage(error) };
  }
  return {
    status: "ready",
    index,
    request,
    target,
    ...(sourceUnit === undefined ? {} : { sourceUnit }),
    ...(currentTranslation === undefined ? {} : { currentTranslation }),
  };
}

function validateWritebackResolution(
  value: unknown,
): TranslationWritebackResolution {
  if (!isRecord(value))
    throw new StandardSchemaContractError(
      "译文写入定位",
      "invalid-schema-result",
      "定位器必须返回对象结果。",
    );
  if (value.status === "notWritable") {
    if (typeof value.reason !== "string")
      throw new StandardSchemaContractError(
        "译文写入定位",
        "invalid-schema-result",
        "notWritable 定位结果必须包含字符串原因。",
      );
    return { status: "notWritable", reason: value.reason };
  }
  if (value.status !== "located" || !Object.hasOwn(value, "locator"))
    throw new StandardSchemaContractError(
      "译文写入定位",
      "invalid-schema-result",
      "定位器必须返回 located 或 notWritable 结果。",
    );
  return {
    status: "located",
    locator: snapshotJson(value.locator, "目标定位"),
  };
}

function checkExpectedSource<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  request: TranslationWriteRequest<TBody, TUnit>,
  current: WriteSnapshot<TUnit, TTranslation, TBody, TUnavailable>,
):
  | { readonly status: "ready"; readonly sourceUnit?: SourceUnitFact<TUnit> }
  | { readonly status: "conflict" | "notWritable"; readonly reason: string } {
  const expectation = request.expectedSource;
  if (expectation === undefined) return { status: "ready" };
  if (current.source === undefined)
    return { status: "notWritable", reason: "本次写入没有读取原文依据。" };
  if (expectation.presence === "present") {
    const sourceUnit = findSourceUnit(current, expectation.key);
    if (sourceUnit === undefined) {
      if (isSourceRangeComplete(current, expectation.range))
        return { status: "conflict", reason: "预期原文现在已缺失。" };
      return {
        status: "notWritable",
        reason: "原文读取不足，无法核对预期原文。",
      };
    }
    if (sourceUnit.bodyAvailability !== "available")
      return { status: "notWritable", reason: "当前原文正文不可用。" };
    const scope = current.source.read.scopes[sourceUnit.scopeIndex];
    if (
      scope === undefined ||
      !isDeepStrictEqual(scope.range, expectation.range)
    )
      return { status: "conflict", reason: "原文所在范围已变化。" };
    if (!isDeepStrictEqual(sourceUnit.unit, expectation.unit))
      return { status: "conflict", reason: "原文单元已变化。" };
    if (!isDeepStrictEqual(sourceUnit.unit.source, expectation.content))
      return { status: "conflict", reason: "原文正文已变化。" };
    return { status: "ready", sourceUnit };
  }

  if (findSourceUnit(current, expectation.key) !== undefined)
    return { status: "conflict", reason: "预期移除的原文现在已存在。" };
  if (!isSourceRangeComplete(current, expectation.range))
    return {
      status: "notWritable",
      reason: "原文范围读取不完整，无法核对预期缺席。",
    };
  return { status: "ready" };
}

function checkSourceTargetMissing<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  current: WriteSnapshot<TUnit, TTranslation, TBody, TUnavailable>,
  sourceUnit: SourceUnitFact<TUnit>,
  language: string,
  config: FrameworkConfig<TUnit, TTranslation, TBody, TUnavailable>,
):
  | { readonly status: "ready" }
  | {
      readonly status: "conflict" | "notWritable";
      readonly reason: string;
    } {
  const translations = config.translations;
  const languageRead = current.translations.reads.find(
    (read) => read.language === language,
  );
  if (
    translations === undefined ||
    !translations.languages.includes(language) ||
    typeof translations.matches !== "function"
  )
    return {
      status: "notWritable",
      reason: "确认新目标缺失需要当前原文与目标的匹配能力。",
    };
  if (languageRead === undefined)
    return { status: "notWritable", reason: "目标语言尚未读取。" };
  const relevantScopes = languageRead.scopes.filter((scope) =>
    scope.covers.includes(sourceUnit.key),
  );
  if (
    relevantScopes.length === 0 ||
    relevantScopes.some(({ enumeration }) => enumeration !== "complete")
  )
    return { status: "notWritable", reason: "目标范围读取不完整。" };
  const scopeIndexes = new Set(
    relevantScopes.map((scope) => languageRead.scopes.indexOf(scope)),
  );
  const matching = current.translations.records.filter(
    (translation) =>
      translation.language === language &&
      scopeIndexes.has(translation.scopeIndex) &&
      translations.matches!(sourceUnit.unit, translation.translation),
  );
  return matching.length === 0
    ? { status: "ready" }
    : { status: "conflict", reason: "预期缺失的目标现在已存在。" };
}

function groupByPhysicalTarget<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  prepared: readonly PreparedWrite<TUnit, TTranslation, TBody, TUnavailable>[],
): PreparedWrite<TUnit, TTranslation, TBody, TUnavailable>[][] {
  const groups: PreparedWrite<TUnit, TTranslation, TBody, TUnavailable>[][] =
    [];
  for (const item of prepared) {
    const group = groups.find((items) =>
      isDeepStrictEqual(items[0]?.target.locator, item.target.locator),
    );
    if (group === undefined) groups.push([item]);
    else group.push(item);
  }
  return groups;
}

function compatibleRequests<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  group: readonly PreparedWrite<TUnit, TTranslation, TBody, TUnavailable>[],
): boolean {
  const first = group[0]?.request;
  if (first === undefined) return true;
  return group.every(
    ({ request }) =>
      request.operation === first.operation &&
      (request.operation === "delete" ||
        (first.operation === "write" &&
          isDeepStrictEqual(request.content, first.content))),
  );
}

function confirmsWrite<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  prepared: PreparedWrite<TUnit, TTranslation, TBody, TUnavailable>,
  after: WriteSnapshot<TUnit, TTranslation, TBody, TUnavailable>,
  config: FrameworkConfig<TUnit, TTranslation, TBody, TUnavailable>,
): boolean {
  const { request } = prepared;
  if ("identity" in request.target) {
    const target = findTranslationByIdentity(after, request.target.identity);
    if (request.operation === "delete") {
      const prior = prepared.currentTranslation;
      return (
        target === undefined &&
        prior !== undefined &&
        isTranslationRangeComplete(
          after,
          request.target.identity.language,
          prior.range,
        )
      );
    }
    return (
      target !== undefined &&
      target.bodyAvailability === "available" &&
      isDeepStrictEqual(target.content, request.content)
    );
  }
  if (request.operation !== "write" || prepared.sourceUnit === undefined)
    return false;
  const sourceTarget = request.target;
  if (!("sourceKey" in sourceTarget)) return false;
  const adapter = config.translations;
  if (adapter?.matches === undefined) return false;
  const currentSource = findSourceUnit(after, sourceTarget.sourceKey);
  if (currentSource === undefined) return false;
  const languageRead = after.translations.reads.find(
    ({ language }) => language === sourceTarget.language,
  );
  if (languageRead === undefined) return false;
  const relevantScopes = languageRead.scopes.filter((scope) =>
    scope.covers.includes(sourceTarget.sourceKey),
  );
  if (
    relevantScopes.length === 0 ||
    relevantScopes.some(({ enumeration }) => enumeration !== "complete")
  )
    return false;
  const indexes = new Set(
    relevantScopes.map((scope) => languageRead.scopes.indexOf(scope)),
  );
  const matching = after.translations.records.filter(
    (translation) =>
      translation.language === sourceTarget.language &&
      indexes.has(translation.scopeIndex) &&
      adapter.matches!(currentSource.unit, translation.translation),
  );
  return (
    matching.length === 1 &&
    matching[0]?.bodyAvailability === "available" &&
    isDeepStrictEqual(matching[0].content, request.content)
  );
}

function canConfirmWriteFailure<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  prepared: PreparedWrite<TUnit, TTranslation, TBody, TUnavailable>,
  after: WriteSnapshot<TUnit, TTranslation, TBody, TUnavailable>,
  config: FrameworkConfig<TUnit, TTranslation, TBody, TUnavailable>,
): boolean {
  const { request } = prepared;
  if ("identity" in request.target) {
    const target = findTranslationByIdentity(after, request.target.identity);
    if (request.operation === "delete") return target !== undefined;
    if (target === undefined)
      return isTranslationReadComplete(after, request.target.identity.language);
    return (
      target.bodyAvailability === "available" &&
      !isDeepStrictEqual(target.content, request.content)
    );
  }

  if (request.operation !== "write") return false;
  const sourceTarget = request.target;
  if (!("sourceKey" in sourceTarget)) return false;
  const currentSource = findSourceUnit(after, sourceTarget.sourceKey);
  const adapter = config.translations;
  if (currentSource === undefined || adapter?.matches === undefined)
    return false;
  const languageRead = after.translations.reads.find(
    ({ language }) => language === sourceTarget.language,
  );
  if (languageRead === undefined) return false;
  const relevantScopes = languageRead.scopes.filter((scope) =>
    scope.covers.includes(sourceTarget.sourceKey),
  );
  if (
    relevantScopes.length === 0 ||
    relevantScopes.some(({ enumeration }) => enumeration !== "complete")
  )
    return false;
  const scopeIndexes = new Set(
    relevantScopes.map((scope) => languageRead.scopes.indexOf(scope)),
  );
  const matching = after.translations.records.filter(
    (translation) =>
      translation.language === sourceTarget.language &&
      scopeIndexes.has(translation.scopeIndex) &&
      adapter.matches!(currentSource.unit, translation.translation),
  );
  return (
    matching.length !== 1 ||
    (matching[0]?.bodyAvailability === "available" &&
      !isDeepStrictEqual(matching[0].content, request.content))
  );
}

function validateTarget(
  value: unknown,
  operation: "write" | "delete",
): TranslationWriteTarget {
  if (!isRecord(value)) invalidWriteRequest("target 结构无效。");
  if (Object.hasOwn(value, "identity")) {
    assertOnlyKeys(value, ["identity"], "target");
    const identity = validateIdentity(value.identity);
    return { identity };
  }
  if (operation === "delete")
    invalidWriteRequest("delete 只能引用现存译文 identity。");
  assertOnlyKeys(value, ["sourceKey", "language"], "target");
  if (
    typeof value.sourceKey !== "string" ||
    value.sourceKey.trim().length === 0 ||
    typeof value.language !== "string" ||
    value.language.trim().length === 0
  )
    invalidWriteRequest("新建目标必须包含 sourceKey 与 language。");
  return { sourceKey: value.sourceKey, language: value.language };
}

async function validateExpectedTarget<TBody>(
  value: unknown,
  operation: "write" | "delete",
  target: TranslationWriteTarget,
  contentSchema: StandardSchemaV1<TBody, TBody>,
): Promise<TranslationWriteTargetExpectation<TBody>> {
  if (!isRecord(value)) invalidWriteRequest("expectedTarget 结构无效。");
  if (value.status === "missing") {
    assertOnlyKeys(value, ["status"], "expectedTarget");
    if (operation !== "write" || "identity" in target)
      invalidWriteRequest("仅 sourceKey+language 写入可以预期目标缺失。");
    return { status: "missing" };
  }
  if (value.status !== "present")
    invalidWriteRequest("expectedTarget.status 必须为 missing 或 present。");
  assertOnlyKeys(
    value,
    ["status", "identity", "content", "range", "record"],
    "expectedTarget",
  );
  const identity = validateIdentity(value.identity);
  const validatedContent = await validateWithStandardSchema(
    contentSchema,
    value.content,
    "预期译文正文",
    { preserveValue: true, requireJson: true },
  );
  const content = snapshotValue(validatedContent, "预期译文正文");
  if ("identity" in target && !isDeepStrictEqual(target.identity, identity))
    invalidWriteRequest(
      "expectedTarget identity 必须与 target identity 相同。",
    );
  return {
    status: "present",
    identity,
    content,
    ...(Object.hasOwn(value, "range")
      ? { range: snapshotJson(value.range, "预期译文范围") }
      : {}),
    ...(Object.hasOwn(value, "record")
      ? { record: snapshotJson(value.record, "预期译文记录") }
      : {}),
  };
}

async function validateExpectedSource<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  value: unknown,
  config: FrameworkConfig<TUnit, TTranslation, TBody, TUnavailable>,
  target: TranslationWriteTarget,
): Promise<TranslationWriteSourceExpectation<TUnit>> {
  if (!isRecord(value)) invalidWriteRequest("expectedSource 结构无效。");
  if (value.presence === "absent") {
    assertOnlyKeys(value, ["presence", "key", "range"], "expectedSource");
    if (typeof value.key !== "string" || value.key.trim().length === 0)
      invalidWriteRequest("expectedSource.key 必须是非空字符串。");
    const range = snapshotJson(value.range, "预期原文范围");
    return { presence: "absent", key: value.key, range };
  }
  if (value.presence !== "present")
    invalidWriteRequest("expectedSource.presence 必须为 present 或 absent。");
  assertOnlyKeys(
    value,
    ["presence", "key", "range", "unit", "content"],
    "expectedSource",
  );
  if (typeof value.key !== "string" || value.key.trim().length === 0)
    invalidWriteRequest("expectedSource.key 必须是非空字符串。");
  if ("sourceKey" in target && target.sourceKey !== value.key)
    invalidWriteRequest("expectedSource.key 必须与新建目标 sourceKey 相同。");
  const validatedUnit = await validateWithStandardSchema(
    config.source.schema,
    value.unit,
    "预期原文单元",
    { preserveValue: true, requireJson: true },
  );
  const unit = snapshotValue(validatedUnit, "预期原文单元");
  const range = snapshotJson(value.range, "预期原文范围");
  const content = snapshotJson(value.content, "预期原文正文");
  if (config.keyOf(unit) !== value.key)
    invalidWriteRequest("expectedSource.key 与原文单元身份不匹配。");
  if (!isDeepStrictEqual(unit.source, content))
    invalidWriteRequest("expectedSource.content 与原文单元正文不匹配。");
  return { presence: "present", key: value.key, range, unit, content };
}

function validateIdentity(value: unknown): TranslationIdentity {
  if (
    !isRecord(value) ||
    typeof value.language !== "string" ||
    value.language.trim().length === 0 ||
    typeof value.namespace !== "string" ||
    value.namespace.trim().length === 0 ||
    typeof value.key !== "string" ||
    value.key.trim().length === 0
  )
    invalidWriteRequest("identity 必须包含非空 language、namespace 与 key。");
  assertOnlyKeys(value, ["language", "namespace", "key"], "identity");
  return {
    language: value.language,
    namespace: value.namespace,
    key: value.key,
  };
}

function findSourceUnit<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  current: WriteSnapshot<TUnit, TTranslation, TBody, TUnavailable>,
  key: string,
): SourceUnitFact<TUnit> | undefined {
  return current.source?.units.find((unit) => unit.key === key);
}

function findTranslationByIdentity<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  current: WriteSnapshot<TUnit, TTranslation, TBody, TUnavailable>,
  identity: TranslationIdentity,
): ActualTranslationFact<TTranslation, TBody, TUnavailable> | undefined {
  return current.translations.records.find((translation) =>
    isDeepStrictEqual(translation.identity, identity),
  );
}

function sourceAbsenceResult<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  current: WriteSnapshot<TUnit, TTranslation, TBody, TUnavailable>,
  key: string,
): { readonly status: "conflict" | "notWritable"; readonly reason: string } {
  return current.source?.read.status === "complete"
    ? { status: "conflict", reason: `原文 ${key} 已不存在。` }
    : {
        status: "notWritable",
        reason: `原文读取不足，无法确认 ${key} 存在。`,
      };
}

function isSourceRangeComplete<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  current: WriteSnapshot<TUnit, TTranslation, TBody, TUnavailable>,
  range: JsonValue,
): boolean {
  const source = current.source;
  if (source === undefined) return false;
  const scopes = source.read.scopes.filter(({ range: currentRange }) =>
    isDeepStrictEqual(currentRange, range),
  );
  return (
    scopes.length > 0 &&
    scopes.every(({ enumeration }) => enumeration === "complete")
  );
}

function isTranslationReadComplete<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  current: WriteSnapshot<TUnit, TTranslation, TBody, TUnavailable>,
  language: string,
): boolean {
  const read = current.translations.reads.find(
    (item) => item.language === language,
  );
  return (
    read !== undefined &&
    read.status === "complete" &&
    read.scopes.length > 0 &&
    read.scopes.every(({ enumeration }) => enumeration === "complete")
  );
}

function isTranslationRangeComplete<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  current: WriteSnapshot<TUnit, TTranslation, TBody, TUnavailable>,
  language: string,
  range: unknown,
): boolean {
  const read = current.translations.reads.find(
    (item) => item.language === language,
  );
  const scopes = read?.scopes.filter((scope) =>
    isDeepStrictEqual(scope.range, range),
  );
  return (
    scopes !== undefined &&
    scopes.length > 0 &&
    scopes.every(({ enumeration }) => enumeration === "complete")
  );
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  name: string,
): void {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    invalidWriteRequest(`${name} 包含不支持的字段。`);
}

function invalidWriteRequest(message: string): never {
  throw new TypeError(`译文写入请求无效：${message}`);
}

function snapshotJson(value: unknown, description: string): JsonValue {
  return snapshotJsonValue(value, description);
}

function snapshotValue<TValue>(value: TValue, description: string): TValue {
  return snapshotJsonValue(value, description) as TValue;
}

function rethrowContractError(error: unknown): void {
  if (
    error instanceof StandardSchemaContractError ||
    error instanceof TranslationIdentityContractError
  )
    throw error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
