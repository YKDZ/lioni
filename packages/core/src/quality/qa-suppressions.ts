import { isPlainRecord } from "../object-guards.ts";

const QA_SUPPRESSION_FORMAT = "lioni.qa-suppressions/v1" as const;

export type QaSuppressionFingerprintSummary = {
  readonly version: string;
  readonly inputFingerprint: string;
};

export type QaSuppression = {
  readonly id: string;
  readonly reason: string;
  readonly checkId: string;
  readonly sourceKey: string;
  readonly language: string;
  readonly inputFingerprint: string;
  readonly fingerprintSummary: QaSuppressionFingerprintSummary;
};

export type QaSuppressionFile = {
  readonly format: typeof QA_SUPPRESSION_FORMAT;
  readonly suppressions: readonly QaSuppression[];
};

export type QaSuppressionExecution = {
  readonly executionId?: number;
  readonly candidateIndex?: number;
  readonly checkId: string;
  readonly sourceKey: string;
  readonly language: string;
  readonly inputFingerprint?: string;
  readonly fingerprintSummary?: QaSuppressionFingerprintSummary;
};

export type CreateQaSuppressionInput = {
  readonly id: string;
  readonly reason: string;
  readonly execution: QaSuppressionExecution;
};

export type UpsertQaSuppressionFromReportInput = {
  readonly report: unknown;
  readonly checkId: string;
  readonly executionId: number;
  readonly id: string;
  readonly reason: string;
  readonly store: QaSuppressionStore;
};

export type QaSuppressionFormatErrorReason = "unsupported" | "invalid";

export class QaSuppressionFormatError extends TypeError {
  readonly reason: QaSuppressionFormatErrorReason;

  constructor(
    reason: QaSuppressionFormatErrorReason,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "QaSuppressionFormatError";
    this.reason = reason;
  }
}

export type QaSuppressionStore = {
  load(): Promise<readonly QaSuppression[]>;
  upsert(suppression: QaSuppression): Promise<void>;
};

/** 从正式报告的一条执行记录创建可手工维护的豁免绑定。 */
export function createQaSuppression(
  input: CreateQaSuppressionInput,
): QaSuppression {
  const { id, reason, execution } = input;
  assertNonEmptyString(id, "豁免身份");
  assertNonEmptyString(reason, "豁免理由");
  assertNonEmptyString(execution.checkId, "检查项身份");
  assertString(execution.sourceKey, "原文键");
  assertNonEmptyString(execution.language, "目标语言");
  if (
    execution.inputFingerprint === undefined ||
    execution.fingerprintSummary === undefined
  )
    throw new QaSuppressionFormatError(
      "invalid",
      "报告执行记录缺少可比较的输入指纹或依据摘要，不能建立豁免。",
    );

  const suppression: QaSuppression = {
    id,
    reason,
    checkId: execution.checkId,
    sourceKey: execution.sourceKey,
    language: execution.language,
    inputFingerprint: execution.inputFingerprint,
    fingerprintSummary: {
      version: execution.fingerprintSummary.version,
      inputFingerprint: execution.fingerprintSummary.inputFingerprint,
    },
  };
  validateQaSuppression(suppression);
  return suppression;
}

/** 从 SDK 报告或 CLI 结构化报告中选择执行记录并写入豁免存储。 */
export async function upsertQaSuppressionFromReport(
  input: UpsertQaSuppressionFromReportInput,
): Promise<QaSuppression> {
  const { report, checkId, executionId, id, reason, store } = input;
  assertNonEmptyString(checkId, "检查项身份");
  if (!Number.isSafeInteger(executionId) || executionId < 0)
    throw invalid("执行身份必须是非负整数。");

  const reportValue = unwrapQualityReport(report);
  validateQaSuppressions(reportValue.suppressions);
  if (!Array.isArray(reportValue.checks))
    throw invalid("QA 报告缺少 checks 执行列表。");
  if (
    reportValue.diagnostics !== undefined &&
    !Array.isArray(reportValue.diagnostics)
  )
    throw invalid("QA 报告中的 diagnostics 列表无效。");

  let selectedCheck: Record<string, unknown> | undefined;
  let selectedExecution: Record<string, unknown> | undefined;
  for (const check of reportValue.checks) {
    if (
      !isPlainRecord(check) ||
      typeof check.checkId !== "string" ||
      !Array.isArray(check.executions)
    )
      throw invalid("QA 报告中的检查执行结构无效。");
    if (check.diagnostics !== undefined && !Array.isArray(check.diagnostics))
      throw invalid("QA 报告中的检查诊断结构无效。");
    if (check.checkId !== checkId) continue;
    for (const execution of check.executions) {
      if (!isPlainRecord(execution))
        throw invalid("QA 报告中的候选执行结构无效。");
      if (execution.executionId !== executionId) continue;
      if (execution.checkId !== checkId)
        throw invalid("候选执行的检查身份与报告分组不一致。");
      if (selectedExecution !== undefined)
        throw invalid("QA 报告中存在重复的检查与执行身份。");
      selectedCheck = check;
      selectedExecution = execution;
    }
  }
  if (selectedExecution === undefined || selectedCheck === undefined)
    throw invalid(`QA 报告中没有检查 ${checkId} 的执行 ${executionId}。`);
  assertExecutionHasDiagnostic(
    reportValue.diagnostics,
    selectedCheck.diagnostics,
    checkId,
    executionId,
  );

  const suppression = createQaSuppression({
    id,
    reason,
    execution: selectedExecution as unknown as QaSuppressionExecution,
  });
  await store.upsert(suppression);
  return suppression;
}

function assertExecutionHasDiagnostic(
  reportDiagnostics: unknown,
  checkDiagnostics: unknown,
  checkId: string,
  executionId: number,
): void {
  const hasReportDiagnostics = Array.isArray(reportDiagnostics);
  const hasCheckDiagnostics = Array.isArray(checkDiagnostics);
  if (!hasReportDiagnostics && !hasCheckDiagnostics)
    throw invalid(
      `QA 报告缺少检查 ${checkId} 的诊断明细，不能确认执行 ${executionId} 产生了实际诊断。`,
    );

  if (
    hasReportDiagnostics &&
    !hasMatchedDiagnostic(reportDiagnostics, checkId, executionId, true)
  )
    throw invalid(
      `检查 ${checkId} 的执行 ${executionId} 没有实际诊断，不能建立豁免。`,
    );

  if (
    hasCheckDiagnostics &&
    !hasMatchedDiagnostic(checkDiagnostics, checkId, executionId, false)
  )
    throw invalid(
      `检查 ${checkId} 的执行 ${executionId} 没有实际诊断，不能建立豁免。`,
    );
}

function hasMatchedDiagnostic(
  diagnostics: readonly unknown[],
  checkId: string,
  executionId: number,
  requireCheckId: boolean,
): boolean {
  let matched = false;
  for (const diagnostic of diagnostics) {
    if (!isPlainRecord(diagnostic)) throw invalid("QA 报告中的诊断结构无效。");
    if (
      diagnostic.checkId !== undefined &&
      diagnostic.checkId !== checkId &&
      !requireCheckId
    )
      throw invalid("候选诊断的检查身份与报告分组不一致。");
    if (
      (requireCheckId
        ? diagnostic.checkId === checkId
        : diagnostic.checkId === undefined || diagnostic.checkId === checkId) &&
      diagnostic.executionId === executionId
    )
      matched = true;
  }
  return matched;
}

function unwrapQualityReport(value: unknown): Record<string, unknown> {
  if (!isPlainRecord(value)) throw invalid("QA 报告必须是对象。");
  if (!Object.hasOwn(value, "data")) return value;
  if (!isPlainRecord(value.data))
    throw invalid("CLI QA 报告的 data 结果必须是对象。");
  return value.data;
}

/** 验证单条豁免；手写 YAML、SDK 与命令共用此契约。 */
export function validateQaSuppression(
  value: unknown,
): asserts value is QaSuppression {
  if (!isPlainRecord(value)) throw invalid("豁免记录必须是对象。");
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
    "豁免记录",
  );
  assertNonEmptyString(value.id, "豁免身份");
  assertNonEmptyString(value.reason, "豁免理由");
  assertNonEmptyString(value.checkId, "检查项身份");
  assertString(value.sourceKey, "原文键");
  assertNonEmptyString(value.language, "目标语言");
  assertNonEmptyString(value.inputFingerprint, "输入指纹");
  if (!isPlainRecord(value.fingerprintSummary))
    throw invalid("豁免依据摘要必须是对象。");
  assertExactKeys(
    value.fingerprintSummary,
    ["version", "inputFingerprint"],
    "豁免依据摘要",
  );
  assertNonEmptyString(value.fingerprintSummary.version, "检查实现版本");
  assertNonEmptyString(
    value.fingerprintSummary.inputFingerprint,
    "业务输入指纹",
  );
}

/** 验证版本化豁免文件及其身份唯一性。 */
export function validateQaSuppressionFile(
  value: unknown,
): asserts value is QaSuppressionFile {
  if (!isPlainRecord(value)) throw invalid("豁免文件顶层必须是对象。");
  if (value.format !== QA_SUPPRESSION_FORMAT) {
    const actual = typeof value.format === "string" ? value.format : "未标识";
    throw new QaSuppressionFormatError(
      "unsupported",
      `不支持 QA 豁免文件格式：${actual}。请依据当前 QA 报告重新建立需要保留的豁免。`,
    );
  }
  assertExactKeys(value, ["format", "suppressions"], "豁免文件");
  validateQaSuppressions(value.suppressions);
}

/** 验证由自定义存储或低层 QA 请求提供的豁免列表。 */
export function validateQaSuppressions(
  value: unknown,
): asserts value is readonly QaSuppression[] {
  if (!Array.isArray(value)) throw invalid("豁免列表必须是数组。");
  const ids = new Set<string>();
  const bindings = new Map<string, string>();
  for (const suppression of value) {
    validateQaSuppression(suppression);
    if (ids.has(suppression.id))
      throw invalid(`豁免身份重复：${suppression.id}。`);
    ids.add(suppression.id);
    const binding = qaSuppressionBindingKey(suppression);
    const existingId = bindings.get(binding);
    if (existingId !== undefined)
      throw invalid(
        `检查豁免绑定冲突：${existingId} 与 ${suppression.id} 指向同一检查绑定（${suppression.checkId}，${suppression.sourceKey}，${suppression.language}）。`,
      );
    bindings.set(binding, suppression.id);
  }
}

function qaSuppressionBindingKey(suppression: QaSuppression): string {
  return JSON.stringify([
    suppression.checkId,
    suppression.sourceKey,
    suppression.language,
    suppression.inputFingerprint,
  ]);
}

/** 判断执行记录是否与豁免绑定的检查依据完全一致。 */
export function qaSuppressionMatchesExecution(
  suppression: QaSuppression,
  execution: QaSuppressionExecution,
): boolean {
  return (
    execution.checkId === suppression.checkId &&
    execution.sourceKey === suppression.sourceKey &&
    execution.language === suppression.language &&
    execution.inputFingerprint === suppression.inputFingerprint
  );
}

/** 只在选定语言的完整已保存资源检查成功后调用，以免把局部未执行误判成失效。 */
export function assertQaSuppressionBindings(input: {
  readonly suppressions: readonly QaSuppression[];
  readonly configuredCheckIds: readonly string[];
  readonly configuredLanguages: readonly string[];
  readonly completeSourceKeys: ReadonlySet<string>;
  readonly selectedLanguages?: readonly string[];
  readonly savedChecks: readonly {
    readonly executions: readonly QaSuppressionExecution[];
    readonly diagnostics: readonly {
      readonly checkId?: string;
      readonly executionId: number;
    }[];
  }[];
}): void {
  if (input.suppressions.length === 0) return;
  const executions = new Map<
    string,
    { readonly checkIndex: number; readonly execution: QaSuppressionExecution }
  >();
  const diagnosedByCheckId = new Set<string>();
  const diagnosedByCheckIndex = new Set<string>();
  const identity = ({
    checkId,
    sourceKey,
    language,
  }: QaSuppressionExecution | QaSuppression) =>
    JSON.stringify([checkId, sourceKey, language]);
  for (const [checkIndex, check] of input.savedChecks.entries()) {
    for (const execution of check.executions)
      executions.set(identity(execution), { checkIndex, execution });
    for (const diagnostic of check.diagnostics) {
      if (diagnostic.checkId !== undefined)
        diagnosedByCheckId.add(
          JSON.stringify([diagnostic.checkId, diagnostic.executionId]),
        );
      else
        diagnosedByCheckIndex.add(
          JSON.stringify([checkIndex, diagnostic.executionId]),
        );
    }
  }

  const errors: string[] = [];
  for (const suppression of input.suppressions) {
    const { id, checkId, sourceKey, language } = suppression;
    if (input.selectedLanguages && !input.selectedLanguages.includes(language))
      continue;
    const reasons: string[] = [];
    const checkExists = input.configuredCheckIds.includes(checkId);
    const languageExists = input.configuredLanguages.includes(language);
    const sourceKeyExists = input.completeSourceKeys.has(sourceKey);
    if (!checkExists) reasons.push("检查项已不存在");
    if (!languageExists) reasons.push("目标语言已不存在");
    if (!sourceKeyExists) reasons.push("原文键已不存在");
    const entry = executions.get(identity(suppression));
    if (entry?.execution.inputFingerprint !== undefined) {
      const { checkIndex, execution } = entry;
      if (execution.inputFingerprint !== suppression.inputFingerprint) {
        const recorded = suppression.fingerprintSummary;
        const current = execution.fingerprintSummary;
        if (current === undefined) reasons.push("检查指纹已改变");
        else {
          const versionChanged = recorded.version !== current.version;
          const inputChanged =
            recorded.inputFingerprint !== current.inputFingerprint;
          if (versionChanged) reasons.push("检查实现版本已改变");
          if (inputChanged) reasons.push("检查输入指纹已改变");
          if (!versionChanged && !inputChanged) reasons.push("检查指纹已改变");
        }
      } else if (
        execution.executionId === undefined ||
        !(
          diagnosedByCheckId.has(
            JSON.stringify([execution.checkId, execution.executionId]),
          ) ||
          diagnosedByCheckIndex.has(
            JSON.stringify([checkIndex, execution.executionId]),
          )
        )
      )
        reasons.push("当前依据下没有可豁免的诊断");
    } else if (checkExists && languageExists && sourceKeyExists) {
      reasons.push(
        entry === undefined
          ? "当前依据下没有可豁免的诊断"
          : "检查输入指纹已改变",
      );
    }
    if (reasons.length > 0)
      errors.push(
        `${id}（${checkId}，${sourceKey}，${language}）：${reasons.join("、")}`,
      );
  }

  if (errors.length > 0)
    throw new Error(`请清理以下检查豁免：\n${errors.join("\n")}`);
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

function invalid(message: string): QaSuppressionFormatError {
  return new QaSuppressionFormatError("invalid", message);
}
