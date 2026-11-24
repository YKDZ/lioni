import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { QualityRunResult } from "../src/quality/qa.ts";
import {
  decideQualityReport,
  formatQualityReport,
  isQualityReportPassing,
} from "../src/quality/report.ts";

const passingReport: QualityRunResult = {
  version: "snapshot-v1",
  candidates: [{ sourceKey: "welcome", language: "fr", content: "Bonjour" }],
  readCoverage: {
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
    associations: [
      {
        sourceKey: "welcome",
        language: "fr",
        status: "matched",
        coverageStatus: "complete",
        scopeIndexes: [0],
        translationIndexes: [0],
        subjectSelected: true,
      },
    ],
  },
  checkScope: { configuredCount: 1, selectedIds: ["messages"] },
  relationships: [],
  suppressions: [],
  diagnostics: [],
  checks: [
    {
      checkId: "messages",
      version: "messages-v1",
      diagnostics: [],
      coverage: {
        selected: 1,
        evaluated: 1,
      },
      executions: [
        {
          executionId: 0,
          candidateIndex: 0,
          checkId: "messages",
          sourceKey: "welcome",
          language: "fr",
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
    const suppressedError = changedReport({
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
            status: "suppressed",
            suppressionId: "known",
            reason: "已接受",
          },
        },
      ],
    });

    assert.equal(isQualityReportPassing(passingReport), true);
    assert.equal(isQualityReportPassing(warning), true);
    assert.equal(isQualityReportPassing(suppressedError), true);
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
      isQualityReportPassing(
        changedReport({
          candidates: [],
          readCoverage: { ...passingReport.readCoverage, associations: [] },
        }),
      ),
      false,
    );
    assert.equal(
      decideQualityReport(
        changedReport({
          candidates: [],
          readCoverage: { ...passingReport.readCoverage, associations: [] },
        }),
      ).status,
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
          candidates: [],
          checks: [],
          progress: [{ language: "fr", completed: 0, total: 0 }],
          readCoverage: { ...passingReport.readCoverage, associations: [] },
        }),
      ),
      true,
    );
  });

  void it("显示语言和候选范围、有效问题与位置且省去重复状态", () => {
    const report = changedReport({
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
    });

    const text = formatQualityReport(report);

    assert.match(text, /质量结论：未通过/u);
    assert.match(text, /语言范围：读取 fr；所选候选语言 fr/u);
    assert.match(text, /检查项范围：配置 1 项，本次全量 1 项（messages）/u);
    assert.match(text, /送检范围：1 项，其中 1 项提供了译文/u);
    assert.match(text, /有效问题：错误 1，警告 0，提示 0/u);
    assert.match(text, /locales\/fr\.json.*welcome\.title.*缺少必要内容/u);
    assert.doesNotMatch(text, /执行状态：|未完成原因：/u);
    assert.doesNotMatch(text, /private-fingerprint|sha256:|执行 0/u);
    assert.doesNotMatch(text, /全项目通过/u);
  });

  void it("说明没有检查对象或检查项的情况", () => {
    const noCandidates = formatQualityReport(
      changedReport({
        candidates: [],
        readCoverage: { ...passingReport.readCoverage, associations: [] },
      }),
    );
    const noChecks = formatQualityReport(
      changedReport({
        checkScope: { configuredCount: 0, selectedIds: [] },
        checks: [],
      }),
    );
    assert.match(noCandidates, /送检范围：0 项，其中 0 项提供了译文/u);
    assert.match(noCandidates, /语言范围：读取 fr；所选候选语言 无/u);
    assert.match(noChecks, /检查项范围：配置 0 项，本次无检查项/u);
    assert.equal(isQualityReportPassing(changedReport({ checks: [] })), false);
  });

  void it("进度百分比最多显示两位小数，未完成时不会舍入为 100%", () => {
    const text = formatQualityReport(
      changedReport({
        progress: [
          { language: "fr", completed: 2, total: 3, percentage: 200 / 3 },
          {
            language: "de",
            completed: 99_999,
            total: 100_000,
            percentage: 99.999,
          },
        ],
      }),
    );
    assert.ok(text.includes("翻译进度 fr：2/3（66.67%）"));
    assert.ok(text.includes("翻译进度 de：99999/100000（99.99%）"));
  });
});
