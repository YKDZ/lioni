import type { QualityObject, QualityRunResult } from "./qa.ts";

type QualityReport = QualityRunResult<QualityObject, unknown>;

export type QualityExecutionStatus =
  | "complete"
  | "incomplete"
  | "failed"
  | "not-run";

export type QualityReportDecisionStatus =
  | "passed"
  | "failed"
  | "incomplete"
  | "no-candidates"
  | "no-checks"
  | "not-run";

export type QualityReportDecision = {
  readonly status: QualityReportDecisionStatus;
  readonly passed: boolean;
  readonly executionStatus: QualityExecutionStatus;
  readonly activeErrorCount: number;
};

const executionStatusText: Readonly<Record<QualityExecutionStatus, string>> = {
  complete: "完整",
  incomplete: "未完成",
  failed: "失败",
  "not-run": "未执行",
};

const severityText = {
  error: "错误",
  warning: "警告",
  info: "提示",
} as const;

/**
 * 判断本次质量检查是否足以通过。
 * 完整空项目可正常结束；有检查对象时仍须运行检查并通过现有错误门禁。
 */
export function isQualityReportPassing(report: QualityReport): boolean {
  return decideQualityReport(report).passed;
}

/** 返回可供脚本按执行状态和未通过原因分支处理的结论。 */
export function decideQualityReport(
  report: QualityReport,
): QualityReportDecision {
  const currentExecutionStatus = executionStatus(report);
  const activeErrorCount = report.diagnostics.filter(
    (diagnostic) =>
      diagnostic.severity === "error" &&
      diagnostic.handling.status === "active",
  ).length;
  let status: QualityReportDecisionStatus;

  if (currentExecutionStatus === "failed") status = "failed";
  else if (currentExecutionStatus === "incomplete") status = "incomplete";
  else if (
    !report.readCoverage.associations.some((a) => a.subjectSelected) &&
    report.progress === undefined
  )
    status = "no-candidates";
  else if (report.checks.length === 0 && !isEmptyProjectRun(report))
    status = "no-checks";
  else if (currentExecutionStatus === "not-run") status = "not-run";
  else if (activeErrorCount > 0) status = "failed";
  else status = "passed";

  return {
    status,
    passed: status === "passed",
    executionStatus: currentExecutionStatus,
    activeErrorCount,
  };
}

/** 生成可供 CLI 与 SDK 脚本共用的简体中文质量报告。 */
export function formatQualityReport(report: QualityReport): string {
  const activeDiagnostics = report.diagnostics.filter(
    ({ handling }) => handling.status === "active",
  );
  const suppressedCount = report.diagnostics.length - activeDiagnostics.length;
  const readLanguages = report.readCoverage.translations.map(
    ({ language }) => language,
  );
  const candidateLanguages = report.candidates.map(({ language }) => language);
  const reasons = unfinishedReasons(report);
  const decision = decideQualityReport(report);
  const { configuredCount, selectedIds } = report.checkScope;
  const checkScope =
    configuredCount === 0
      ? "配置 0 项，本次无检查项"
      : `配置 ${configuredCount} 项，本次${selectedIds.length === configuredCount ? "全量" : "子集"} ${selectedIds.length} 项（${selectedIds.join("、")}）`;
  const lines = [
    `质量结论：${decision.passed ? "通过" : "未通过"}`,
    `执行状态：${executionStatusText[decision.executionStatus]}`,
    `语言范围：${readLanguages.length === 0 ? "无译文语言" : `读取 ${readLanguages.join("、")}`}；所选候选语言 ${candidateLanguages.length === 0 ? "无" : [...new Set(candidateLanguages)].join("、")}`,
    `检查项范围：${checkScope}`,
    `送检范围：${report.readCoverage.associations.filter((a) => a.subjectSelected).length} 项，其中 ${report.candidates.length} 项提供了译文`,
    ...(report.progress ?? []).map(
      ({ language, completed, total, percentage }) =>
        `翻译进度 ${language}：${completed}/${total}${percentage === undefined ? "" : `（${formatPercentage(percentage, completed === total)}%）`}`,
    ),
    `有效问题：错误 ${countSeverity(activeDiagnostics, "error")}，警告 ${countSeverity(activeDiagnostics, "warning")}，提示 ${countSeverity(activeDiagnostics, "info")}；已豁免 ${suppressedCount}`,
  ];

  if (report.diagnostics.length === 0) {
    lines.push("问题：无");
  } else {
    lines.push("问题：");
    lines.push(...report.diagnostics.map(formatDiagnostic));
  }

  if (reasons.length === 0) lines.push("未完成原因：无");
  else lines.push("未完成原因：", ...reasons.map((reason) => `- ${reason}`));

  return lines.join("\n");
}

/** 显示到小数点后两位，仅在所有检查对象均已完成时显示 100%。 */
function formatPercentage(percentage: number, complete: boolean): number {
  return complete ? 100 : Math.min(99.99, Number(percentage.toFixed(2)));
}

function isEmptyProjectRun(report: QualityReport): boolean {
  return report.progress?.every(({ total }) => total === 0) === true;
}

function executionStatus(report: QualityReport): QualityExecutionStatus {
  const readStatuses = [
    report.readCoverage.source,
    ...report.readCoverage.translations,
  ];
  if (
    report.status === "failed" ||
    readStatuses.some((read) => read.status === "failed")
  )
    return "failed";
  if (
    readStatuses.some((read) => read.status !== "complete") ||
    report.readCoverage.associations.some(
      (a) => a.subjectSelected && a.coverageStatus !== "complete",
    )
  )
    return "incomplete";
  if (report.status === "not-run" && isEmptyProjectRun(report))
    return "complete";
  return report.status;
}

function countSeverity(
  diagnostics: QualityRunResult["diagnostics"],
  severity: "error" | "warning" | "info",
): number {
  return diagnostics.filter((diagnostic) => diagnostic.severity === severity)
    .length;
}

function formatDiagnostic(
  diagnostic: QualityRunResult["diagnostics"][number],
): string {
  const language =
    diagnostic.object.language ?? diagnostic.location.language ?? "原文";
  const range = displayRange(diagnostic.location.range);
  const key =
    diagnostic.location.key === undefined
      ? ""
      : `，位置键 ${diagnostic.location.key}`;
  const suppression =
    diagnostic.handling.status === "suppressed"
      ? `（已豁免：${diagnostic.handling.reason}）`
      : "";
  return `- [${severityText[diagnostic.severity]}] ${diagnostic.checkId} ${diagnostic.object.key}（${language}，${range}${key}）：${diagnostic.message}${suppression}`;
}

function displayRange(range: unknown): string {
  if (typeof range === "string") return range;
  if (range === null || range === undefined) return "位置未知";
  return JSON.stringify(range) ?? "位置未知";
}

function unfinishedReasons(report: QualityReport): string[] {
  const reasons = new Set<string>();
  addReadReasons(reasons, "原文", report.readCoverage.source);
  for (const read of report.readCoverage.translations)
    addReadReasons(reasons, `译文 ${read.language}`, read);

  for (const association of report.readCoverage.associations) {
    if (
      association.subjectSelected &&
      association.coverageStatus !== "complete"
    )
      reasons.add(
        `译文 ${association.language} 的 ${association.sourceKey} 未完整读取`,
      );
  }
  for (const check of report.checks) {
    for (const execution of check.executions) {
      if (execution.status === "failed")
        reasons.add(
          `检查项 ${check.checkId}（${execution.language}，${execution.sourceKey}）：${execution.error ?? "检查失败"}`,
        );
    }
  }
  if (
    report.progress === undefined &&
    !report.readCoverage.associations.some((a) => a.subjectSelected)
  )
    reasons.add("本次没有检查对象");
  if (report.checkScope.configuredCount === 0 && !isEmptyProjectRun(report))
    reasons.add("没有配置检查项");
  return [...reasons];
}

function addReadReasons(
  reasons: Set<string>,
  label: string,
  read:
    | QualityRunResult["readCoverage"]["source"]
    | QualityRunResult["readCoverage"]["translations"][number],
): void {
  const partialScopes = read.scopes.filter(
    ({ enumeration }) => enumeration !== "complete",
  );
  if (read.status === "complete" && partialScopes.length === 0) return;

  const status =
    read.status === "complete"
      ? "部分枚举"
      : read.status === "notRead"
        ? "未读取"
        : read.status === "incomplete"
          ? "不完整"
          : "失败";
  const details = [
    ...(read.error === undefined ? [] : [read.error]),
    ...partialScopes.flatMap(({ range, error }) => [
      ...(range === undefined ? [] : [displayRange(range)]),
      ...(error === undefined ? [] : [error]),
    ]),
  ];
  reasons.add(
    `${label}读取${status}${details.length === 0 ? "" : `：${details.join("；")}`}`,
  );
}
