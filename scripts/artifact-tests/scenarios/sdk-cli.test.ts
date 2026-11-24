import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { QualityRunResult } from "@lioni/core";

import { testArtifactConsumer } from "../support/consumer.ts";
import { assertMatchesJsonSchema } from "../support/json-schema.ts";
import { runSubprocess } from "../support/process.ts";

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

    // 1. 免配置契约发现（在无 lioni.config.ts 的空目录中执行）
    const emptyDir = await mkdtemp(path.join(root, "no-config-"));
    let wireNotPassedSchema: Readonly<Record<string, unknown>>;
    let wireCheckedSchema: Readonly<Record<string, unknown>>;
    try {
      const runSchemaQuery = async (args: readonly string[]) => {
        const result = await runSubprocess(executable, args, {
          cwd: emptyDir,
          shell: process.platform === "win32",
        });
        assert.equal(result.status, 0, result.stderr || result.stdout);
        assert.equal(result.stderr, "");
        return JSON.parse(result.stdout) as Readonly<Record<string, unknown>>;
      };

      const rootDirectory = await runSchemaQuery(["--schema"]);
      assert.equal(rootDirectory.kind, "directory");
      assert.equal(rootDirectory.schemaVersion, "5");
      assert.equal(rootDirectory.command, "cli");
      const children = rootDirectory.children as readonly {
        readonly command: string;
        readonly name: string;
      }[];
      assert.ok(children.some(({ name }) => name === "qa"));
      assert.ok(children.some(({ name }) => name === "inspect"));
      assert.ok(children.some(({ name }) => name === "baseline"));
      assert.ok(children.some(({ name }) => name === "update"));

      const qaSummary = await runSchemaQuery(["qa", "--schema"]);
      assert.equal(qaSummary.kind, "summary");
      assert.equal(qaSummary.schemaVersion, "5");
      assert.equal(qaSummary.command, "qa");
      assert.partialDeepStrictEqual(qaSummary.outputs, {
        default: "text",
        modes: {
          text: { delivery: "atomic", format: "text" },
          structured: { delivery: "atomic", format: "structured" },
        },
      });

      const qaInput = await runSchemaQuery(["qa", "--schema=input"]);
      assert.equal(qaInput.kind, "input");
      assert.equal(qaInput.schemaVersion, "5");
      assert.equal(qaInput.command, "qa");
      const inputFields = qaInput.fields as readonly {
        readonly key: string;
        readonly longOption?: string;
      }[];
      assert.deepEqual(
        inputFields.map(({ key, longOption }) => [key, longOption]),
        [
          ["config", undefined],
          ["languages", "--language"],
          ["checks", "--check"],
          ["groups", "--group"],
          ["severity", "--severity"],
          ["maxPerCheck", "--max-per-check"],
        ],
      );
      const inputSchemaProperties = (
        qaInput.input as {
          readonly inputSchema: {
            readonly properties: Readonly<Record<string, unknown>>;
          };
        }
      ).inputSchema.properties;
      assert.deepEqual(Object.keys(inputSchemaProperties), [
        "config",
        "languages",
        "checks",
        "groups",
        "severity",
        "maxPerCheck",
      ]);
      assert.partialDeepStrictEqual(inputSchemaProperties.severity, {
        type: "array",
        items: { type: "string", enum: ["error", "warning", "info"] },
      });
      assert.partialDeepStrictEqual(inputSchemaProperties.maxPerCheck, {
        type: "string",
        pattern: "^[1-9]\\d*$",
      });

      const qaWire = await runSchemaQuery(["qa", "--schema=wire:structured"]);
      assert.equal(qaWire.kind, "wire");
      assert.equal(qaWire.schemaVersion, "5");
      assert.equal(qaWire.command, "qa");
      assert.equal(qaWire.mode, "structured");
      const wire = qaWire.wire as {
        readonly data: {
          readonly checked: Readonly<Record<string, unknown>>;
          readonly notPassed: Readonly<Record<string, unknown>>;
        };
        readonly failure: {
          readonly checkFailed: Readonly<Record<string, unknown>>;
        };
      };
      wireCheckedSchema = wire.data.checked;
      wireNotPassedSchema = wire.data.notPassed;
      const checkedDataSchema = (
        wireCheckedSchema.properties as Readonly<
          Record<string, Readonly<Record<string, unknown>>>
        >
      ).data!;
      const checkedDataProperties = checkedDataSchema.properties as Readonly<
        Record<string, unknown>
      >;
      assert.ok("progress" in checkedDataProperties);
      assert.ok("diagnostics" in checkedDataProperties);
      assert.ok("checks" in checkedDataProperties);

      const invalidSchemaQuery = await runSubprocess(
        executable,
        ["qa", "--schema=wire:text"],
        { cwd: emptyDir, shell: process.platform === "win32" },
      );
      assert.equal(invalidSchemaQuery.status, 2);
      assert.partialDeepStrictEqual(JSON.parse(invalidSchemaQuery.stderr), {
        schemaVersion: "3",
        kind: "usageFailure",
        issues: [{ code: "invalidSchemaQuery" }],
      });
    } finally {
      await rm(emptyDir, { recursive: true, force: true });
    }

    // 2. 各命令默认输出与 v3 信封验证
    const cli = (...args: string[]) => runCommand(executable, args);
    const inspection = await cli("inspect", "lioni.config.ts");
    assert.partialDeepStrictEqual(JSON.parse(inspection.stdout), {
      schemaVersion: "3",
      outputMode: "structured",
      kind: "data",
      data: JSON.parse(sdk.stdout),
    });
    assert.partialDeepStrictEqual(
      JSON.parse((await cli("baseline", "lioni.config.ts")).stdout),
      {
        schemaVersion: "3",
        outputMode: "structured",
        data: { outcome: "saved" },
      },
    );
    const baselinePath = path.join(root, "lioni.baseline.json");
    const baseline = await readFile(baselinePath);
    assert.partialDeepStrictEqual(
      JSON.parse((await cli("update", "lioni.config.ts", "--dry-run")).stdout),
      {
        schemaVersion: "3",
        outputMode: "structured",
        variant: "previewed",
      },
    );

    const legacyOutputFlag = await runProcess(executable, [
      "qa",
      "lioni.config.ts",
      "--output-format",
      "structured",
    ]);
    assert.equal(legacyOutputFlag.status, 2);
    assert.partialDeepStrictEqual(JSON.parse(legacyOutputFlag.stderr), {
      schemaVersion: "3",
      kind: "usageFailure",
      issues: [{ code: "unknownOption" }],
    });

    // 3. 验证有配置时每次 QA 调用（文本与结构化）均只执行一次业务流程，且输出符合查询到的契约
    const trackMarker = path.join(root, ".track-reads");
    const readLogPath = path.join(root, ".qa-reads.log");
    await writeFile(trackMarker, "", "utf8");

    await writeFile(readLogPath, "", "utf8");
    const textReport = await runProcess(executable, ["qa", "lioni.config.ts"]);
    assert.equal(textReport.status, 1);
    assert.equal(
      (await readFile(readLogPath, "utf8")).trim().split("\n").length,
      1,
    );
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

    await writeFile(readLogPath, "", "utf8");
    const report = await runProcess(executable, [
      "qa",
      "lioni.config.ts",
      "--output",
      "structured",
    ]);
    assert.equal(report.status, 1);
    assert.equal(
      (await readFile(readLogPath, "utf8")).trim().split("\n").length,
      1,
    );
    const reportEnvelope = JSON.parse(report.stdout) as {
      schemaVersion: string;
      outputMode: string;
      kind: string;
      variant: string;
      data: QualityRunResult;
    };
    assert.equal(reportEnvelope.schemaVersion, "3");
    assert.equal(reportEnvelope.outputMode, "structured");
    assert.equal(reportEnvelope.variant, "notPassed");
    assertMatchesJsonSchema(
      reportEnvelope,
      wireNotPassedSchema,
      wireNotPassedSchema,
    );
    const quality = reportEnvelope.data;
    assert.equal(quality.diagnostics.length, 1);

    // 筛选参数隐藏全部错误明细时，汇总、退出码 1 与 --output structured 报告均保持完整一致。
    const hiddenErrorsText = await runProcess(executable, [
      "qa",
      "lioni.config.ts",
      "--severity",
      "warning",
      "--max-per-check",
      "1",
    ]);
    assert.equal(hiddenErrorsText.status, 1);
    assert.match(hiddenErrorsText.stdout, /有效问题：错误 1，警告 0，提示 0/u);
    assert.match(hiddenErrorsText.stdout, /问题：按所选严重度无匹配明细/u);

    const filteredStructured = await runProcess(executable, [
      "qa",
      "lioni.config.ts",
      "--severity",
      "warning",
      "--max-per-check",
      "1",
      "--output",
      "structured",
    ]);
    assert.equal(filteredStructured.status, 1);
    const filteredEnvelope = JSON.parse(filteredStructured.stdout) as {
      schemaVersion: string;
      outputMode: string;
      kind: string;
      variant: string;
      data: QualityRunResult;
    };
    assertMatchesJsonSchema(
      filteredEnvelope,
      wireNotPassedSchema,
      wireNotPassedSchema,
    );
    assert.deepEqual(filteredEnvelope.data, quality);
    assert.deepEqual(filteredEnvelope.data.progress, [
      { language: "fr", completed: 1, total: 2, percentage: 50 },
      { language: "de", completed: 2, total: 2, percentage: 100 },
    ]);

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
      "--output",
      "structured",
    ]);
    assert.equal(selectedReport.status, 0);
    const selectedEnvelope = JSON.parse(selectedReport.stdout) as {
      schemaVersion: string;
      outputMode: string;
      kind: string;
      variant: string;
      data: QualityRunResult;
    };
    assert.equal(selectedEnvelope.schemaVersion, "3");
    assert.equal(selectedEnvelope.variant, "checked");
    assertMatchesJsonSchema(
      selectedEnvelope,
      wireCheckedSchema,
      wireCheckedSchema,
    );
    const selectedQuality = selectedEnvelope.data;
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
      "--output",
      "structured",
    ]);
    assert.equal(suppressed.status, 0);
    const suppressedEnvelope = JSON.parse(suppressed.stdout) as Record<
      string,
      unknown
    >;
    assertMatchesJsonSchema(
      suppressedEnvelope,
      wireCheckedSchema,
      wireCheckedSchema,
    );
    assert.partialDeepStrictEqual(suppressedEnvelope, {
      schemaVersion: "3",
      outputMode: "structured",
      data: {
        diagnostics: [
          {
            handling: {
              status: "suppressed",
              suppressionId: "approved-number",
            },
          },
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
      "--output",
      "structured",
    ]);
    assert.equal(unrelatedEdit.status, 0);
    assert.partialDeepStrictEqual(JSON.parse(unrelatedEdit.stdout), {
      schemaVersion: "3",
      data: {
        diagnostics: [{ handling: { status: "suppressed" } }],
      },
    });
    assert.deepEqual(await readFile(baselinePath), baseline);

    const oldSuppressionContents = [
      "format: lioni.quality-exceptions/v1",
      "exceptions:",
      "  - id: approved-number",
      "    reason: 升级前旧豁免。",
      "",
    ].join("\n");
    await writeFile(suppressionPath, oldSuppressionContents, "utf8");
    const rejectedLegacyQa = await runProcess(executable, [
      "qa",
      "lioni.config.ts",
    ]);
    assert.equal(rejectedLegacyQa.status, 1);
    assert.match(
      rejectedLegacyQa.stdout + rejectedLegacyQa.stderr,
      /lioni\.quality-exceptions\/v1.*依据当前 QA 报告重新建立/u,
    );
    assert.equal(
      await readFile(suppressionPath, "utf8"),
      oldSuppressionContents,
    );
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
      /lioni\.quality-exceptions\/v1.*依据当前 QA 报告重新建立/u,
    );
    assert.equal(
      await readFile(suppressionPath, "utf8"),
      oldSuppressionContents,
    );
    // 宿主处理旧豁免文件后，按新版 QA 报告重新确认需要保留的豁免。
    await rm(suppressionPath);
    const freshReportAfterUpgrade = await runProcess(executable, [
      "qa",
      "lioni.config.ts",
      "--output",
      "structured",
    ]);
    assert.equal(freshReportAfterUpgrade.status, 1);
    const freshDiagnostic = (
      JSON.parse(freshReportAfterUpgrade.stdout) as {
        readonly data: QualityRunResult;
      }
    ).data.diagnostics[0];
    assert.ok(freshDiagnostic);
    await writeFile(
      path.join(root, "fresh-qa-report.json"),
      freshReportAfterUpgrade.stdout,
    );
    await cli(
      "suppressions",
      "upsert",
      "lioni.config.ts",
      "fresh-qa-report.json",
      "--check-id",
      freshDiagnostic.checkId,
      "--execution-id",
      String(freshDiagnostic.executionId),
      "--id",
      "reconfirmed-after-upgrade",
      "--reason",
      "升级后按新版报告重新确认。",
    );
    const reconfirmed = await runProcess(executable, [
      "qa",
      "lioni.config.ts",
      "--output",
      "structured",
    ]);
    assert.equal(reconfirmed.status, 0);
    assert.partialDeepStrictEqual(JSON.parse(reconfirmed.stdout), {
      schemaVersion: "3",
      data: {
        diagnostics: [
          {
            handling: {
              status: "suppressed",
              suppressionId: "reconfirmed-after-upgrade",
            },
          },
        ],
      },
    });
  },
);
