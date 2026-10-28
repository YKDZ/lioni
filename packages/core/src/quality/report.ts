import type { QualityRunResult } from "./qa.ts";

export type QualityExecutionStatus =
  | "complete"
  | "incomplete"
  | "failed"
  | "not-applicable"
  | "not-run";

export type QualityReportDecisionStatus =
  | "passed"
  | "failed"
  | "incomplete"
  | "no-candidates"
  | "no-checks"
  | "not-applicable"
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
  "not-applicable": "全部不适用",
  "not-run": "未执行",
};

const severityText = {
  error: "错误",
  warning: "警告",
  info: "提示",
} as const;

/**
 * 判断本次质量检查是否足以通过。
 * 只有存在可评估工作、执行完整且没有未豁免错误时才通过。
 */
export function isQualityReportPassing(report: QualityRunResult): boolean {
  return decideQualityReport(report).passed;
}

/** 返回可供脚本按执行状态和未通过原因分支处理的结论。 */
export function decideQualityReport(
  report: QualityRunResult,
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
  else if (report.candidates.length === 0) status = "no-candidates";
  else if (report.checks.length === 0) status = "no-checks";
  else if (currentExecutionStatus === "not-applicable")
    status = "not-applicable";
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
export function formatQualityReport(report: QualityRunResult): string {
  const activeDiagnostics = report.diagnostics.filter(
    ({ handling }) => handling.status === "active",
  );
  const exceptedCount = report.diagnostics.length - activeDiagnostics.length;
  const readLanguages = report.factCoverage.translations.map(
    ({ language }) => language,
  );
  const candidateLanguages = report.candidates.map(({ language }) => language);
  const reasons = unfinishedReasons(report);
  const decision = decideQualityReport(report);
  const lines = [
    `质量结论：${decision.passed ? "通过" : "未通过"}`,
    `执行状态：${executionStatusText[decision.executionStatus]}`,
    `语言范围：${readLanguages.length === 0 ? "无译文语言" : `读取 ${readLanguages.join("、")}`}；所选候选语言 ${candidateLanguages.length === 0 ? "无" : [...new Set(candidateLanguages)].join("、")}`,
    `检查范围：已选候选 ${report.candidates.length} 条，检查项 ${report.checks.length} 项`,
    `有效问题：错误 ${countSeverity(activeDiagnostics, "error")}，警告 ${countSeverity(activeDiagnostics, "warning")}，提示 ${countSeverity(activeDiagnostics, "info")}；已豁免 ${exceptedCount}`,
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

function executionStatus(report: QualityRunResult): QualityExecutionStatus {
  const readStatuses = [
    report.factCoverage.source,
    ...report.factCoverage.translations,
  ];
  const checkStatuses = report.checks.map(({ status, coverage }) => {
    if (status === "failed" || coverage.failed > 0) return "failed";
    if (status === "incomplete" || coverage.incomplete > 0) return "incomplete";
    return status;
  });

  if (
    report.status === "failed" ||
    checkStatuses.includes("failed") ||
    readStatuses.some(
      (read) =>
        read.status === "failed" ||
        read.scopes.some(({ enumeration }) => enumeration === "failed"),
    )
  )
    return "failed";

  if (
    report.status === "incomplete" ||
    checkStatuses.includes("incomplete") ||
    readStatuses.some(
      (read) =>
        read.status !== "complete" ||
        read.scopes.some(({ enumeration }) => enumeration !== "complete"),
    )
  )
    return "incomplete";

  if (
    report.candidates.length === 0 ||
    report.checks.length === 0 ||
    report.status === "not-run" ||
    checkStatuses.includes("not-run")
  )
    return "not-run";

  if (
    report.status === "not-applicable" ||
    (checkStatuses.length > 0 &&
      checkStatuses.every((status) => status === "not-applicable"))
  )
    return "not-applicable";

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
  const exception =
    diagnostic.handling.status === "excepted"
      ? `（已豁免：${diagnostic.handling.reason}）`
      : "";
  return `- [${severityText[diagnostic.severity]}] ${diagnostic.checkId} ${diagnostic.object.key}（${language}，${range}${key}）：${diagnostic.message}${exception}`;
}

function displayRange(range: unknown): string {
  if (typeof range === "string") return range;
  if (range === null || range === undefined) return "位置未知";
  return JSON.stringify(range) ?? "位置未知";
}

function unfinishedReasons(report: QualityRunResult): string[] {
  const reasons = new Set<string>();
  addReadReasons(reasons, "原文", report.factCoverage.source);
  for (const read of report.factCoverage.translations)
    addReadReasons(reasons, `译文 ${read.language}`, read);

  if (report.candidates.length === 0) reasons.add("本次没有候选可检查");
  if (report.checks.length === 0) reasons.add("没有配置检查项");
  if (
    report.checks.length > 0 &&
    report.checks.every(({ status }) => status === "not-applicable")
  )
    reasons.add("全部检查项均不适用");

  for (const check of report.checks) {
    const checkStatus = checkExecutionStatus(check);
    if (checkStatus === "complete") continue;

    if (check.issues.length === 0) {
      reasons.add(
        `检查项 ${check.checkId}：${executionStatusText[checkStatus]}`,
      );
      continue;
    }
    for (const issue of check.issues)
      reasons.add(`检查项 ${check.checkId}：${issue.message}`);
  }

  if (
    report.status === "failed" &&
    report.checks.every(({ status }) => status !== "failed")
  )
    reasons.add("质量检查执行失败");
  else if (
    report.status === "incomplete" &&
    report.checks.every(({ status }) => status !== "incomplete")
  )
    reasons.add("质量检查未完整完成");

  if (
    report.status === "not-run" &&
    report.candidates.length > 0 &&
    report.checks.length > 0
  )
    reasons.add("本次没有完成任何检查");

  return [...reasons];
}

function addReadReasons(
  reasons: Set<string>,
  label: string,
  read:
    | QualityRunResult["factCoverage"]["source"]
    | QualityRunResult["factCoverage"]["translations"][number],
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

function statusForCheck(
  status: QualityRunResult["status"],
): QualityExecutionStatus {
  if (status === "not-applicable") return "not-applicable";
  if (status === "not-run") return "not-run";
  if (status === "incomplete") return "incomplete";
  if (status === "failed") return "failed";
  return "complete";
}

function checkExecutionStatus(
  check: QualityRunResult["checks"][number],
): QualityExecutionStatus {
  if (check.status === "failed" || check.coverage.failed > 0) return "failed";
  if (check.status === "incomplete" || check.coverage.incomplete > 0)
    return "incomplete";
  return statusForCheck(check.status);
}
