import type { QualityObject, QualityRunResult } from "./qa.ts";

type QualityReport = QualityRunResult<QualityObject, unknown>;

export type QualityReportDecisionStatus =
  | "passed"
  | "failed"
  | "no-candidates"
  | "no-checks";

export type QualityReportDecision = {
  readonly status: QualityReportDecisionStatus;
  readonly passed: boolean;
  readonly activeErrorCount: number;
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

/** 返回可供脚本按报告结果分支处理的结论。 */
export function decideQualityReport(
  report: QualityReport,
): QualityReportDecision {
  const activeErrorCount = report.diagnostics.filter(
    (diagnostic) =>
      diagnostic.severity === "error" &&
      diagnostic.handling.status === "active",
  ).length;
  let status: QualityReportDecisionStatus;

  if (
    !report.readCoverage.associations.some((a) => a.subjectSelected) &&
    report.progress === undefined
  )
    status = "no-candidates";
  else if (report.checks.length === 0 && !isEmptyProjectRun(report))
    status = "no-checks";
  else if (activeErrorCount > 0) status = "failed";
  else status = "passed";

  return {
    status,
    passed: status === "passed",
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
  const decision = decideQualityReport(report);
  const { configuredCount, selectedIds } = report.checkScope;
  const checkScope =
    configuredCount === 0
      ? "配置 0 项，本次无检查项"
      : `配置 ${configuredCount} 项，本次${selectedIds.length === configuredCount ? "全量" : "子集"} ${selectedIds.length} 项（${selectedIds.join("、")}）`;
  const lines = [
    `质量结论：${decision.passed ? "通过" : "未通过"}`,
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

  return lines.join("\n");
}

/** 显示到小数点后两位，仅在所有检查对象均已完成时显示 100%。 */
function formatPercentage(percentage: number, complete: boolean): number {
  return complete ? 100 : Math.min(99.99, Number(percentage.toFixed(2)));
}

function isEmptyProjectRun(report: QualityReport): boolean {
  return report.progress?.every(({ total }) => total === 0) === true;
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
