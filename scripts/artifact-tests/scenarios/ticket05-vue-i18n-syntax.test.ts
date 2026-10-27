import assert from "node:assert/strict";
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

    const executable = path.join(
      root,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "lioni.cmd" : "lioni",
    );
    const cli = await runCommand(executable, ["qa", "lioni.config.ts"]);
    const report = reportFrom(cli.stdout);

    assert.equal(report.status, "complete");
    assert.equal(report.diagnostics?.length, 2);
    const diagnostics = report.diagnostics ?? [];
    assert.deepEqual(
      diagnostics
        .map(diagnosticId)
        .filter((id): id is string => id !== undefined)
        .sort(),
      ["vue-i18n/source-syntax", "vue-i18n/target-syntax"],
    );

    const variableCli = await runCommand(executable, [
      "qa",
      "variable.config.ts",
    ]);
    const variableReport = reportFrom(variableCli.stdout);
    assert.equal(variableReport.status, "complete");
    assert.equal(variableReport.diagnostics?.length, 1);
    assert.deepEqual(variableReport.diagnostics?.map(diagnosticId), [
      "vue-i18n/variable-correspondence",
    ]);
  },
);

function reportFrom(output: string): {
  readonly status?: string;
  readonly diagnostics?: readonly unknown[];
} {
  const envelope = JSON.parse(output) as {
    readonly data?: unknown;
    readonly status?: string;
    readonly diagnostics?: readonly unknown[];
  };
  return typeof envelope.data === "object" && envelope.data !== null
    ? (envelope.data as typeof envelope)
    : envelope;
}

function diagnosticId(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  if ("checkId" in value && typeof value.checkId === "string")
    return value.checkId;
  if ("ruleId" in value && typeof value.ruleId === "string")
    return value.ruleId;
  return undefined;
}
