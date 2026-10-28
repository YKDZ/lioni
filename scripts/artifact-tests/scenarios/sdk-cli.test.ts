import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { QualityRunResult } from "lioni";

import { testArtifactConsumer } from "../support/consumer.ts";

testArtifactConsumer(
  {
    name: "安装后的 SDK 配置与 CLI 质量报告",
    fixtures: new URL("../fixtures/sdk-cli/", import.meta.url),
  },
  async ({ root, runNode, runCommand, runProcess, typecheck }) => {
    await typecheck();
    const sdk = await runNode("consumer.ts");
    const executable = path.join(
      root,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "lioni.cmd" : "lioni",
    );
    const cli = (...args: string[]) => runCommand(executable, args);
    const inspection = await cli("inspect", "lioni.config.ts");
    assert.partialDeepStrictEqual(JSON.parse(inspection.stdout), {
      schemaVersion: "2",
      data: JSON.parse(sdk.stdout),
    });
    assert.partialDeepStrictEqual(
      JSON.parse((await cli("completion", "lioni.config.ts")).stdout),
      { data: { status: "complete" } },
    );
    assert.partialDeepStrictEqual(
      JSON.parse((await cli("baseline", "lioni.config.ts")).stdout),
      { data: { outcome: "saved" } },
    );
    const baselinePath = path.join(root, "lioni.baseline.json");
    const baseline = await readFile(baselinePath);
    assert.partialDeepStrictEqual(
      JSON.parse((await cli("update", "lioni.config.ts", "--dry-run")).stdout),
      { schemaVersion: "2", variant: "previewed" },
    );

    const textReport = await runProcess(executable, ["qa", "lioni.config.ts"]);
    assert.equal(textReport.status, 1);
    assert.match(textReport.stdout, /质量结论：未通过/u);
    assert.match(
      textReport.stdout,
      /语言范围：读取 fr、de；所选候选语言 fr、de/u,
    );
    assert.match(textReport.stdout, /检查范围：已选候选 4 条，检查项 1 项/u);

    const report = await runProcess(executable, [
      "qa",
      "lioni.config.ts",
      "--output-format",
      "structured",
    ]);
    assert.equal(report.status, 1);
    const quality = (JSON.parse(report.stdout) as { data: QualityRunResult })
      .data;
    assert.equal(quality.status, "complete");
    assert.equal(quality.diagnostics.length, 1);
    const selectedReport = await runProcess(executable, [
      "qa",
      "lioni.config.ts",
      "--language",
      "de",
      "--output-format",
      "structured",
    ]);
    assert.equal(selectedReport.status, 0);
    const selectedQuality = (
      JSON.parse(selectedReport.stdout) as { data: QualityRunResult }
    ).data;
    assert.equal(selectedQuality.status, "complete");
    assert.equal(selectedQuality.diagnostics.length, 0);
    assert.equal(selectedQuality.candidates.length, 2);
    assert.ok(
      selectedQuality.candidates.every(({ language }) => language === "de"),
    );
    const execution = quality.checks[0]?.executions[0];
    assert.ok(execution?.inputFingerprint);
    await writeFile(path.join(root, "qa-report.json"), report.stdout);
    await cli(
      "exceptions",
      "upsert",
      "lioni.config.ts",
      "qa-report.json",
      "--check-id",
      execution.checkId,
      "--execution-id",
      String(execution.executionId),
      "--id",
      "approved-number",
      "--reason",
      "已确认的数字差异。",
    );
    const excepted = await runProcess(executable, [
      "qa",
      "lioni.config.ts",
      "--output-format",
      "structured",
    ]);
    assert.equal(excepted.status, 0);
    assert.partialDeepStrictEqual(JSON.parse(excepted.stdout), {
      data: {
        diagnostics: [
          { handling: { status: "excepted", exceptionId: "approved-number" } },
        ],
      },
    });
    assert.match(
      await readFile(path.join(root, "lioni.exceptions.yaml"), "utf8"),
      /approved-number/u,
    );
    assert.deepEqual(await readFile(baselinePath), baseline);
  },
);
