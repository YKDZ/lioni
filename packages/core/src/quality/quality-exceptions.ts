const QUALITY_EXCEPTION_FORMAT = "lioni.qa-exceptions/v1" as const;

export type QualityExceptionFingerprintSummary = {
  readonly version: string;
  readonly configurationFingerprint: string;
  readonly inputFingerprint: string;
};

export type QualityException = {
  readonly id: string;
  readonly reason: string;
  readonly checkId: string;
  readonly sourceKey: string;
  readonly language: string;
  readonly inputFingerprint: string;
  readonly fingerprintSummary: QualityExceptionFingerprintSummary;
};

export type QualityExceptionFile = {
  readonly format: typeof QUALITY_EXCEPTION_FORMAT;
  readonly exceptions: readonly QualityException[];
};

export type QualityExceptionExecution = {
  readonly executionId?: number;
  readonly candidateIndex?: number;
  readonly checkId: string;
  readonly sourceKey: string;
  readonly language: string;
  readonly status: string;
  readonly inputFingerprint?: string;
  readonly fingerprintSummary?: QualityExceptionFingerprintSummary;
};

export type CreateQualityExceptionInput = {
  readonly id: string;
  readonly reason: string;
  readonly execution: QualityExceptionExecution;
};

export type UpsertQualityExceptionFromReportInput = {
  readonly report: unknown;
  readonly checkId: string;
  readonly executionId: number;
  readonly id: string;
  readonly reason: string;
  readonly store: QualityExceptionStore;
};

export type QualityExceptionFormatErrorReason = "unsupported" | "invalid";

export class QualityExceptionFormatError extends TypeError {
  readonly reason: QualityExceptionFormatErrorReason;

  constructor(
    reason: QualityExceptionFormatErrorReason,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "QualityExceptionFormatError";
    this.reason = reason;
  }
}

export type QualityExceptionStore = {
  load(): Promise<readonly QualityException[]>;
  upsert(exception: QualityException): Promise<void>;
};

export type QualityExceptionChangeReason =
  | "business-input"
  | "configuration"
  | "check-implementation";

export type QualityExceptionNotVerifiedReason =
  | "not-run"
  | "no-comparable-basis";

export type QualityExceptionApplicability = {
  readonly exceptionId: string;
  readonly checkId: string;
  readonly sourceKey: string;
  readonly language: string;
  readonly executionId?: number;
  readonly candidateIndex?: number;
  readonly status: "applicable" | "basis-changed" | "not-verified";
  readonly reasons?: readonly QualityExceptionChangeReason[];
  readonly reason?: QualityExceptionNotVerifiedReason;
};

/** 从正式报告的一条执行记录创建可手工维护的例外绑定。 */
export function createQualityException(
  input: CreateQualityExceptionInput,
): QualityException {
  const { id, reason, execution } = input;
  assertNonEmptyString(id, "例外身份");
  assertNonEmptyString(reason, "例外理由");
  assertNonEmptyString(execution.checkId, "检查项身份");
  assertString(execution.sourceKey, "原文键");
  assertNonEmptyString(execution.language, "目标语言");
  if (
    execution.inputFingerprint === undefined ||
    execution.fingerprintSummary === undefined
  )
    throw new QualityExceptionFormatError(
      "invalid",
      "报告执行记录缺少可比较的输入指纹或依据摘要，不能建立例外。",
    );

  const exception: QualityException = {
    id,
    reason,
    checkId: execution.checkId,
    sourceKey: execution.sourceKey,
    language: execution.language,
    inputFingerprint: execution.inputFingerprint,
    fingerprintSummary: {
      version: execution.fingerprintSummary.version,
      configurationFingerprint:
        execution.fingerprintSummary.configurationFingerprint,
      inputFingerprint: execution.fingerprintSummary.inputFingerprint,
    },
  };
  validateQualityException(exception);
  return exception;
}

/** 从 SDK 报告或 CLI 结构化报告中选择执行记录并写入例外存储。 */
export async function upsertQualityExceptionFromReport(
  input: UpsertQualityExceptionFromReportInput,
): Promise<QualityException> {
  const { report, checkId, executionId, id, reason, store } = input;
  assertNonEmptyString(checkId, "检查项身份");
  if (!Number.isSafeInteger(executionId) || executionId < 0)
    throw invalid("执行身份必须是非负整数。");

  const reportValue = unwrapQualityReport(report);
  if (!Array.isArray(reportValue.checks))
    throw invalid("QA 报告缺少 checks 执行列表。");

  let selectedExecution: Record<string, unknown> | undefined;
  for (const check of reportValue.checks) {
    if (
      !isRecord(check) ||
      typeof check.checkId !== "string" ||
      !Array.isArray(check.executions)
    )
      throw invalid("QA 报告中的检查执行结构无效。");
    if (check.checkId !== checkId) continue;
    for (const execution of check.executions) {
      if (!isRecord(execution)) throw invalid("QA 报告中的候选执行结构无效。");
      if (execution.executionId !== executionId) continue;
      if (execution.checkId !== checkId)
        throw invalid("候选执行的检查身份与报告分组不一致。");
      if (selectedExecution !== undefined)
        throw invalid("QA 报告中存在重复的检查与执行身份。");
      selectedExecution = execution;
    }
  }
  if (selectedExecution === undefined)
    throw invalid(`QA 报告中没有检查 ${checkId} 的执行 ${executionId}。`);

  const exception = createQualityException({
    id,
    reason,
    execution: selectedExecution as unknown as QualityExceptionExecution,
  });
  await store.upsert(exception);
  return exception;
}

function unwrapQualityReport(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw invalid("QA 报告必须是对象。");
  if (!Object.hasOwn(value, "data")) return value;
  if (!isRecord(value.data))
    throw invalid("CLI QA 报告的 data 结果必须是对象。");
  return value.data;
}

/** 验证单条例外；手写 YAML、SDK 与命令共用此契约。 */
export function validateQualityException(
  value: unknown,
): asserts value is QualityException {
  if (!isRecord(value)) throw invalid("例外记录必须是对象。");
  assertExactKeys(
    value,
    [
      "id",
      "reason",
      "checkId",
      "sourceKey",
      "language",
      "inputFingerprint",
      "fingerprintSummary",
    ],
    "例外记录",
  );
  assertNonEmptyString(value.id, "例外身份");
  assertNonEmptyString(value.reason, "例外理由");
  assertNonEmptyString(value.checkId, "检查项身份");
  assertString(value.sourceKey, "原文键");
  assertNonEmptyString(value.language, "目标语言");
  assertNonEmptyString(value.inputFingerprint, "输入指纹");
  if (!isRecord(value.fingerprintSummary))
    throw invalid("例外依据摘要必须是对象。");
  assertExactKeys(
    value.fingerprintSummary,
    ["version", "configurationFingerprint", "inputFingerprint"],
    "例外依据摘要",
  );
  assertNonEmptyString(value.fingerprintSummary.version, "检查实现版本");
  assertNonEmptyString(
    value.fingerprintSummary.configurationFingerprint,
    "最终配置指纹",
  );
  assertNonEmptyString(
    value.fingerprintSummary.inputFingerprint,
    "业务输入指纹",
  );
}

/** 验证版本化例外文件及其身份唯一性。 */
export function validateQualityExceptionFile(
  value: unknown,
): asserts value is QualityExceptionFile {
  if (!isRecord(value)) throw invalid("例外文件顶层必须是对象。");
  if (value.format !== QUALITY_EXCEPTION_FORMAT) {
    const actual = typeof value.format === "string" ? value.format : "未标识";
    throw new QualityExceptionFormatError(
      "unsupported",
      `不支持 QA 例外文件格式：${actual}。`,
    );
  }
  assertExactKeys(value, ["format", "exceptions"], "例外文件");
  validateQualityExceptions(value.exceptions);
}

/** 验证由自定义存储或低层 QA 请求提供的例外列表。 */
export function validateQualityExceptions(
  value: unknown,
): asserts value is readonly QualityException[] {
  if (!Array.isArray(value)) throw invalid("例外列表必须是数组。");
  const ids = new Set<string>();
  for (const exception of value) {
    validateQualityException(exception);
    if (ids.has(exception.id)) throw invalid(`例外身份重复：${exception.id}。`);
    ids.add(exception.id);
  }
}

/** 判断执行记录是否与例外绑定的检查依据完全一致。 */
export function qualityExceptionMatchesExecution(
  exception: QualityException,
  execution: QualityExceptionExecution,
): boolean {
  return (
    execution.checkId === exception.checkId &&
    execution.sourceKey === exception.sourceKey &&
    execution.language === exception.language &&
    execution.inputFingerprint === exception.inputFingerprint
  );
}

/** 逐执行报告例外适用性；未执行和缺少依据均不会伪装成依据变化。 */
export function evaluateQualityExceptionApplicability(
  exceptions: readonly QualityException[],
  executions: readonly QualityExceptionExecution[],
): readonly QualityExceptionApplicability[] {
  validateQualityExceptions(exceptions);
  const results: QualityExceptionApplicability[] = [];
  for (const exception of exceptions) {
    const candidates = executions.filter(
      (execution) =>
        execution.checkId === exception.checkId &&
        execution.sourceKey === exception.sourceKey &&
        execution.language === exception.language,
    );
    if (candidates.length === 0) {
      results.push(
        applicability(exception, "not-verified", undefined, {
          reason: "not-run",
        }),
      );
      continue;
    }

    for (const execution of candidates) {
      if (execution.inputFingerprint === undefined) {
        results.push(
          applicability(exception, "not-verified", execution, {
            reason: "no-comparable-basis",
          }),
        );
        continue;
      }
      if (qualityExceptionMatchesExecution(exception, execution)) {
        results.push(applicability(exception, "applicable", execution));
        continue;
      }
      if (execution.fingerprintSummary === undefined) {
        results.push(
          applicability(exception, "not-verified", execution, {
            reason: "no-comparable-basis",
          }),
        );
        continue;
      }

      const reasons: QualityExceptionChangeReason[] = [];
      if (
        execution.fingerprintSummary.inputFingerprint !==
        exception.fingerprintSummary.inputFingerprint
      )
        reasons.push("business-input");
      if (
        execution.fingerprintSummary.configurationFingerprint !==
        exception.fingerprintSummary.configurationFingerprint
      )
        reasons.push("configuration");
      if (
        execution.fingerprintSummary.version !==
        exception.fingerprintSummary.version
      )
        reasons.push("check-implementation");
      if (reasons.length === 0) {
        results.push(
          applicability(exception, "not-verified", execution, {
            reason: "no-comparable-basis",
          }),
        );
        continue;
      }
      results.push(
        applicability(exception, "basis-changed", execution, { reasons }),
      );
    }
  }
  return results;
}

function applicability(
  exception: QualityException,
  status: QualityExceptionApplicability["status"],
  execution?: QualityExceptionExecution,
  details?: Pick<QualityExceptionApplicability, "reason" | "reasons">,
): QualityExceptionApplicability {
  return {
    exceptionId: exception.id,
    checkId: exception.checkId,
    sourceKey: exception.sourceKey,
    language: exception.language,
    ...(execution?.executionId === undefined
      ? {}
      : { executionId: execution.executionId }),
    ...(execution?.candidateIndex === undefined
      ? {}
      : { candidateIndex: execution.candidateIndex }),
    status,
    ...details,
  };
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  description: string,
): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  )
    throw invalid(`${description}包含未知字段或缺少必需字段。`);
}

function assertNonEmptyString(
  value: unknown,
  description: string,
): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0)
    throw invalid(`${description}必须是非空文本。`);
}

function assertString(
  value: unknown,
  description: string,
): asserts value is string {
  if (typeof value !== "string") throw invalid(`${description}必须是文本。`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function invalid(message: string): QualityExceptionFormatError {
  return new QualityExceptionFormatError("invalid", message);
}
