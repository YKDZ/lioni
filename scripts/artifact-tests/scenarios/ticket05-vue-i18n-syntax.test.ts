import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { testArtifactConsumer } from "../support/consumer.ts";

testArtifactConsumer(
  {
    name: "票 05/06：Vue I18n 语法和变量检查通过正式 SDK 和 CLI 制品消费",
    packages: [
      "@lioni/checks",
      "@lioni/cli",
      "@lioni/core",
      "@lioni/memo",
      "@lioni/terminology",
      "@lioni/text-analysis",
    ],
    fixtures: new URL("../fixtures/ticket05-vue-i18n-syntax/", import.meta.url),
  },
  async ({ root, runCommand, runNode, typecheck }) => {
    const declarations = await typecheck();
    assert.equal(declarations.status, 0, declarations.stderr);
    await runNode("consumer.ts");

    const cacheEventsPath = path.join(root, "qa-cache-events.txt");
    const exceptionPath = path.join(root, "lioni.exceptions.yaml");
    await rm(path.join(root, ".lioni"), { recursive: true, force: true });
    await rm(cacheEventsPath, { force: true });
    await rm(exceptionPath, { force: true });

    const executable = path.join(
      root,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "lioni.cmd" : "lioni",
    );
    const syntaxCli = await runCommand(executable, ["qa", "lioni.config.ts"]);
    const syntaxReport = reportFrom(syntaxCli.stdout);

    assert.equal(syntaxReport.status, "complete");
    assert.equal(syntaxReport.diagnostics?.length, 2);
    const diagnostics = syntaxReport.diagnostics ?? [];
    assert.deepEqual(
      diagnostics
        .map(diagnosticId)
        .filter((id): id is string => id !== undefined)
        .sort(),
      ["vue-i18n/source-syntax", "vue-i18n/target-syntax"],
    );
    const sourceExecution = executionFor(
      syntaxReport,
      "vue-i18n/source-syntax",
    );
    assert.deepEqual(await cacheEvents(cacheEventsPath), ["miss", "miss"]);

    await writeFile(
      exceptionPath,
      exceptionsYaml([
        exceptionYaml(
          "approved-source-syntax",
          "该原文语法问题已由维护者确认。",
          sourceExecution,
        ),
      ]),
      "utf8",
    );
    const exceptedSyntaxCli = await runCommand(executable, [
      "qa",
      "lioni.config.ts",
    ]);
    const exceptedSyntaxReport = reportFrom(exceptedSyntaxCli.stdout);
    const sourceSyntaxDiagnostic = diagnosticFor(
      exceptedSyntaxReport,
      "vue-i18n/source-syntax",
    );
    const targetSyntaxDiagnostic = diagnosticFor(
      exceptedSyntaxReport,
      "vue-i18n/target-syntax",
    );
    assert.deepEqual(sourceSyntaxDiagnostic?.handling, {
      status: "excepted",
      exceptionId: "approved-source-syntax",
      reason: "该原文语法问题已由维护者确认。",
    });
    assert.deepEqual(targetSyntaxDiagnostic?.handling, { status: "active" });
    assert.deepEqual(await cacheEvents(cacheEventsPath), [
      "miss",
      "miss",
      "hit",
      "hit",
    ]);

    const variableCli = await runCommand(executable, [
      "qa",
      "variable.config.ts",
    ]);
    const variableReport = reportFrom(variableCli.stdout);
    assert.equal(variableReport.status, "complete");
    assert.equal(variableReport.diagnostics?.length, 1);
    const variableDiagnostic = diagnosticFor(
      variableReport,
      "vue-i18n/variable-correspondence",
    );
    assert.ok(variableDiagnostic);
    const variableExecution = executionFor(
      variableReport,
      "vue-i18n/variable-correspondence",
    );
    assert.deepEqual(await cacheEvents(cacheEventsPath), [
      "miss",
      "miss",
      "hit",
      "hit",
      "miss",
    ]);

    const withVariableException = exceptionsYaml([
      exceptionYaml(
        "approved-source-syntax",
        "该原文语法问题已由维护者确认。",
        sourceExecution,
      ),
      exceptionYaml(
        "approved-variable-mismatch",
        "该变量差异已由维护者确认。",
        variableExecution,
      ),
    ]);
    await writeFile(exceptionPath, withVariableException, "utf8");
    const exceptedVariableCli = await runCommand(executable, [
      "qa",
      "variable.config.ts",
    ]);
    const exceptedVariableReport = reportFrom(exceptedVariableCli.stdout);
    assert.deepEqual(
      diagnosticFor(exceptedVariableReport, "vue-i18n/variable-correspondence")
        ?.handling,
      {
        status: "excepted",
        exceptionId: "approved-variable-mismatch",
        reason: "该变量差异已由维护者确认。",
      },
    );

    await writeFile(
      exceptionPath,
      exceptionsYaml([
        exceptionYaml(
          "approved-source-syntax",
          "该原文语法问题已由维护者确认。",
          sourceExecution,
        ),
        exceptionYaml(
          "approved-variable-mismatch",
          "更新后的变量差异理由。",
          variableExecution,
        ),
      ]),
      "utf8",
    );
    const updatedVariableCli = await runCommand(executable, [
      "qa",
      "variable.config.ts",
    ]);
    assert.deepEqual(
      diagnosticFor(
        reportFrom(updatedVariableCli.stdout),
        "vue-i18n/variable-correspondence",
      )?.handling,
      {
        status: "excepted",
        exceptionId: "approved-variable-mismatch",
        reason: "更新后的变量差异理由。",
      },
    );

    await writeFile(
      exceptionPath,
      exceptionsYaml([
        exceptionYaml(
          "approved-source-syntax",
          "该原文语法问题已由维护者确认。",
          sourceExecution,
        ),
      ]),
      "utf8",
    );
    const removedVariableCli = await runCommand(executable, [
      "qa",
      "variable.config.ts",
    ]);
    const removedVariableReport = reportFrom(removedVariableCli.stdout);
    assert.deepEqual(
      diagnosticFor(removedVariableReport, "vue-i18n/variable-correspondence")
        ?.handling,
      { status: "active" },
    );
    assert.deepEqual(await cacheEvents(cacheEventsPath), [
      "miss",
      "miss",
      "hit",
      "hit",
      "miss",
      "hit",
      "hit",
      "hit",
    ]);
  },
);

type QaExecution = {
  readonly checkId: string;
  readonly sourceKey: string;
  readonly language: string;
  readonly inputFingerprint?: string;
  readonly fingerprintSummary?: {
    readonly version: string;
    readonly configurationFingerprint: string;
    readonly inputFingerprint: string;
  };
};

type QaDiagnostic = {
  readonly checkId: string;
  readonly handling?: {
    readonly status: string;
    readonly exceptionId?: string;
    readonly reason?: string;
  };
};

type QaReport = {
  readonly status: string;
  readonly diagnostics: readonly QaDiagnostic[];
  readonly checks: readonly {
    readonly checkId: string;
    readonly executions: readonly QaExecution[];
  }[];
};

function reportFrom(output: string): QaReport {
  const envelope: QaReport | { readonly data: QaReport } = JSON.parse(output);
  return "data" in envelope ? envelope.data : envelope;
}

function executionFor(report: QaReport, checkId: string): QaExecution {
  const execution = report.checks?.find((check) => check.checkId === checkId)
    ?.executions[0];
  assert.ok(execution, `报告中没有 ${checkId} 的执行记录。`);
  return execution;
}

function diagnosticFor(
  report: QaReport,
  checkId: string,
): QaDiagnostic | undefined {
  return report.diagnostics?.find(
    (diagnostic) => diagnostic.checkId === checkId,
  );
}

function exceptionYaml(
  id: string,
  reason: string,
  execution: QaExecution,
): string {
  assert.ok(execution.inputFingerprint);
  assert.ok(execution.fingerprintSummary);
  return [
    `  - id: ${id}`,
    `    reason: ${JSON.stringify(reason)}`,
    `    checkId: ${execution.checkId}`,
    `    sourceKey: ${execution.sourceKey}`,
    `    language: ${execution.language}`,
    `    inputFingerprint: ${execution.inputFingerprint}`,
    "    fingerprintSummary:",
    `      version: ${JSON.stringify(execution.fingerprintSummary.version)}`,
    `      configurationFingerprint: ${execution.fingerprintSummary.configurationFingerprint}`,
    `      inputFingerprint: ${execution.fingerprintSummary.inputFingerprint}`,
  ].join("\n");
}

function exceptionsYaml(records: readonly string[]): string {
  return ["format: lioni.qa-exceptions/v1", "exceptions:", ...records, ""].join(
    "\n",
  );
}

async function cacheEvents(filePath: string): Promise<readonly string[]> {
  return (await readFile(filePath, "utf8")).trim().split("\n");
}

function diagnosticId(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  if ("checkId" in value && typeof value.checkId === "string")
    return value.checkId;
  if ("ruleId" in value && typeof value.ruleId === "string")
    return value.ruleId;
  return undefined;
}
