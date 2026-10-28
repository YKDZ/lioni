import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { QualityRunResult } from "../src/quality/qa.ts";
import {
  decideQualityReport,
  formatQualityReport,
  isQualityReportPassing,
} from "../src/quality/report.ts";

const passingReport: QualityRunResult = {
  version: "facts-v1",
  candidates: [{ sourceKey: "welcome", language: "fr", content: "Bonjour" }],
  factCoverage: {
    source: {
      status: "complete",
      scopes: [
        {
          range: "src/messages.ts",
          enumeration: "complete",
          recordCount: 1,
        },
      ],
    },
    translations: [
      {
        language: "fr",
        status: "complete",
        scopes: [
          {
            range: "locales/fr.json",
            covers: ["welcome"],
            enumeration: "complete",
            translationIndexes: [0],
          },
        ],
      },
    ],
    associations: [],
  },
  dependencies: {},
  relationships: [],
  exceptions: [],
  exceptionApplicability: [],
  status: "complete",
  diagnostics: [],
  checks: [
    {
      checkId: "messages",
      version: "messages-v1",
      configuration: {},
      status: "complete",
      diagnostics: [],
      issues: [],
      coverage: {
        selected: 1,
        evaluated: 1,
        notApplicable: 0,
        incomplete: 0,
        failed: 0,
      },
      executions: [
        {
          executionId: 0,
          candidateIndex: 0,
          checkId: "messages",
          sourceKey: "welcome",
          language: "fr",
          status: "complete",
          inputFingerprint: "sha256:private-fingerprint",
        },
      ],
    },
  ],
};

function changedReport(changes: Partial<QualityRunResult>): QualityRunResult {
  return { ...passingReport, ...changes };
}

void describe("质量报告", () => {
  void it("仅在执行完整且没有未豁免错误时通过", () => {
    const warning = changedReport({
      diagnostics: [
        {
          checkId: "messages",
          executionId: 0,
          severity: "warning",
          object: { kind: "translation-unit", key: "welcome", language: "fr" },
          location: { language: "fr", range: "locales/fr.json" },
          message: "请复核措辞。",
          evidence: [],
          handling: { status: "active" },
        },
      ],
    });
    const exceptedError = changedReport({
      diagnostics: [
        {
          checkId: "messages",
          executionId: 0,
          severity: "error",
          object: { kind: "translation-unit", key: "welcome", language: "fr" },
          location: { language: "fr", range: "locales/fr.json" },
          message: "已确认的历史问题。",
          evidence: [],
          handling: {
            status: "excepted",
            exceptionId: "known",
            reason: "已接受",
          },
        },
      ],
    });

    assert.equal(isQualityReportPassing(passingReport), true);
    assert.equal(isQualityReportPassing(warning), true);
    assert.equal(isQualityReportPassing(exceptedError), true);
    assert.equal(decideQualityReport(passingReport).status, "passed");
    assert.equal(
      isQualityReportPassing(
        changedReport({
          diagnostics: [
            {
              checkId: "messages",
              executionId: 0,
              severity: "error",
              object: {
                kind: "translation-unit",
                key: "welcome",
                language: "fr",
              },
              location: { language: "fr", range: "locales/fr.json" },
              message: "缺少必要内容。",
              evidence: [],
              handling: { status: "active" },
            },
          ],
        }),
      ),
      false,
    );
    assert.equal(
      decideQualityReport(changedReport({ status: "failed" })).status,
      "failed",
    );
    assert.equal(
      decideQualityReport(changedReport({ status: "incomplete" })).status,
      "incomplete",
    );
    assert.equal(
      isQualityReportPassing(changedReport({ status: "failed" })),
      false,
    );
    assert.equal(
      isQualityReportPassing(changedReport({ status: "incomplete" })),
      false,
    );
    assert.equal(
      decideQualityReport(
        changedReport({
          factCoverage: {
            ...passingReport.factCoverage,
            source: {
              ...passingReport.factCoverage.source,
              status: "incomplete",
            },
          },
        }),
      ).status,
      "incomplete",
    );
    assert.equal(
      isQualityReportPassing(changedReport({ candidates: [] })),
      false,
    );
    assert.equal(
      decideQualityReport(changedReport({ candidates: [] })).status,
      "no-candidates",
    );
    assert.equal(isQualityReportPassing(changedReport({ checks: [] })), false);
    assert.equal(
      decideQualityReport(changedReport({ checks: [] })).status,
      "no-checks",
    );
    assert.equal(
      isQualityReportPassing(
        changedReport({
          status: "not-applicable",
          checks: passingReport.checks.map((check) => ({
            ...check,
            status: "not-applicable",
          })),
        }),
      ),
      false,
    );
    assert.equal(
      decideQualityReport(
        changedReport({
          status: "not-applicable",
          checks: passingReport.checks.map((check) => ({
            ...check,
            status: "not-applicable",
          })),
        }),
      ).status,
      "not-applicable",
    );
  });

  void it("显示语言和候选范围、有效问题、位置与未完成原因", () => {
    const report = changedReport({
      status: "incomplete",
      diagnostics: [
        {
          checkId: "messages",
          executionId: 0,
          severity: "error",
          object: { kind: "translation-unit", key: "welcome", language: "fr" },
          location: {
            language: "fr",
            range: "locales/fr.json",
            key: "welcome.title",
          },
          message: "缺少必要内容。",
          evidence: [],
          handling: { status: "active" },
        },
      ],
      checks: passingReport.checks.map((check) => ({
        ...check,
        status: "incomplete",
        issues: [{ code: "partial-read", message: "宿主只返回部分目录。" }],
      })),
    });

    const text = formatQualityReport(report);

    assert.match(text, /质量结论：未通过/u);
    assert.match(text, /执行状态：未完成/u);
    assert.match(text, /语言范围：读取 fr；所选候选语言 fr/u);
    assert.match(text, /检查范围：已选候选 1 条，检查项 1 项/u);
    assert.match(text, /有效问题：错误 1，警告 0，提示 0/u);
    assert.match(text, /locales\/fr\.json.*welcome\.title.*缺少必要内容/u);
    assert.match(text, /未完成原因：/u);
    assert.match(text, /宿主只返回部分目录/u);
    assert.doesNotMatch(text, /private-fingerprint|sha256:|执行 0/u);
    assert.doesNotMatch(text, /全项目通过/u);
  });

  void it("说明没有候选、检查项或适用检查的情况", () => {
    const noCandidates = formatQualityReport(
      changedReport({ candidates: [], status: "not-run" }),
    );
    const noChecks = formatQualityReport(
      changedReport({ checks: [], status: "not-run" }),
    );
    const allNotApplicable = formatQualityReport(
      changedReport({
        status: "not-applicable",
        checks: passingReport.checks.map((check) => ({
          ...check,
          status: "not-applicable",
        })),
      }),
    );

    assert.match(noCandidates, /没有候选可检查/u);
    assert.match(noCandidates, /语言范围：读取 fr；所选候选语言 无/u);
    assert.match(noChecks, /没有配置检查项/u);
    assert.match(allNotApplicable, /全部检查项均不适用/u);
    assert.equal(
      isQualityReportPassing(changedReport({ status: "not-run" })),
      false,
    );
  });
});
