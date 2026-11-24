import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { QualityRunResult } from "@lioni/core";

import { testArtifactConsumer } from "../support/consumer.ts";

testArtifactConsumer(
  {
    name: "安装后的 SDK 事实读取与 CLI 质量报告",
    fixtures: new URL("../fixtures/sdk-cli/", import.meta.url),
  },
  async ({ root, runNode, runCommand, runProcess, typecheck }) => {
    await typecheck();
    await runNode("standard-schema-consumer.ts");
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
    assert.match(
      textReport.stdout,
      /检查项范围：配置 1 项，本次全量 1 项（number-correspondence）/u,
    );
    assert.match(textReport.stdout, /送检范围：4 项，其中 4 项提供了译文/u);

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
    const qualityCheck = quality.checks[0];
    assert.ok(qualityCheck);
    const execution = qualityCheck.executions[0];
    assert.ok(execution?.inputFingerprint);
    assert.deepEqual(Object.keys(execution?.fingerprintSummary ?? {}).sort(), [
      "inputFingerprint",
      "version",
    ]);
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
    await writeFile(path.join(root, "qa-report.json"), report.stdout);
    await cli(
      "suppressions",
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
    const suppressed = await runProcess(executable, [
      "qa",
      "lioni.config.ts",
      "--output-format",
      "structured",
    ]);
    assert.equal(suppressed.status, 0);
    assert.partialDeepStrictEqual(JSON.parse(suppressed.stdout), {
      data: {
        diagnostics: [
          { handling: { status: "suppressed", suppressionId: "approved-number" } },
        ],
      },
    });
    const suppressionPath = path.join(root, "lioni.suppressions.yaml");
    const suppressionContents = await readFile(suppressionPath, "utf8");
    assert.match(suppressionContents, /^format: lioni\.qa-suppressions\/v1$/mu);
    assert.match(suppressionContents, /approved-number/u);
    await writeFile(
      path.join(root, "fr.json"),
      JSON.stringify([
        { id: "catalog", body: "Enregistrer 1 fichier" },
        { id: "guide", body: { text: "Consulter 3 pages" } },
      ]),
    );
    const unrelatedEdit = await runProcess(executable, [
      "qa",
      "lioni.config.ts",
      "--output-format",
      "structured",
    ]);
    assert.equal(unrelatedEdit.status, 0);
    assert.partialDeepStrictEqual(JSON.parse(unrelatedEdit.stdout), {
      data: {
        diagnostics: [{ handling: { status: "suppressed" } }],
      },
    });
    assert.deepEqual(await readFile(baselinePath), baseline);

    const oldSuppressionContents =
      "format: unsupported\nsuppressions: []\n";
    await writeFile(suppressionPath, oldSuppressionContents, "utf8");
    const rejectedLegacySuppression = await runProcess(executable, [
      "suppressions",
      "upsert",
      "lioni.config.ts",
      "qa-report.json",
      "--check-id",
      execution.checkId,
      "--execution-id",
      String(execution.executionId),
      "--id",
      "legacy-approval",
      "--reason",
      "旧格式必须重新确认。",
    ]);
    assert.equal(rejectedLegacySuppression.status, 1);
    assert.match(
      rejectedLegacySuppression.stdout + rejectedLegacySuppression.stderr,
      /依据当前 QA 报告重新建立/u,
    );
    assert.equal(await readFile(suppressionPath, "utf8"), oldSuppressionContents);
  },
);
