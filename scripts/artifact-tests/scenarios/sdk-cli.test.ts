import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { QualityRunResult } from "@lioni/core";

import { testArtifactConsumer } from "../support/consumer.ts";
import { runSubprocess } from "../support/process.ts";

type JsonSchemaNode = boolean | Readonly<Record<string, unknown>>;

/** 校验安装后 CLI 返回的实际 JSON 载荷是否满足 `--schema=wire:structured` 导出的 Draft 2020-12 Schema。 */
function assertMatchesJsonSchema(
  value: unknown,
  schema: JsonSchemaNode,
  rootSchema: Readonly<Record<string, unknown>>,
  location = "$",
): void {
  if (typeof schema === "boolean") {
    assert.equal(schema, true, `${location} 被布尔 schema 拒绝`);
    return;
  }
  if (typeof schema.$ref === "string") {
    const pointer = schema.$ref;
    assert.ok(
      pointer.startsWith("#/"),
      `${location} 遇到未支持的 $ref: ${pointer}`,
    );
    let target: unknown = rootSchema;
    for (const segment of pointer.slice(2).split("/")) {
      const key = segment.replace(/~1/gu, "/").replace(/~0/gu, "~");
      assert.ok(
        typeof target === "object" && target !== null && key in target,
        `${location} 无法解析 $ref: ${pointer}`,
      );
      target = (target as Readonly<Record<string, unknown>>)[key];
    }
    assertMatchesJsonSchema(
      value,
      target as JsonSchemaNode,
      rootSchema,
      location,
    );
    return;
  }
  if ("const" in schema) {
    assert.deepEqual(value, schema.const, `${location} 不匹配 const`);
  }
  if (Array.isArray(schema.enum)) {
    assert.ok(
      schema.enum.some((entry) => {
        try {
          assert.deepEqual(value, entry);
          return true;
        } catch {
          return false;
        }
      }),
      `${location} 不在 enum 允许值内: ${JSON.stringify(value)}`,
    );
  }
  if (Array.isArray(schema.anyOf)) {
    const matched = schema.anyOf.some((branch) => {
      try {
        assertMatchesJsonSchema(
          value,
          branch as JsonSchemaNode,
          rootSchema,
          location,
        );
        return true;
      } catch {
        return false;
      }
    });
    assert.ok(matched, `${location} 未满足 anyOf 任一分支`);
  }
  if (Array.isArray(schema.oneOf)) {
    let matches = 0;
    for (const branch of schema.oneOf) {
      try {
        assertMatchesJsonSchema(
          value,
          branch as JsonSchemaNode,
          rootSchema,
          location,
        );
        matches += 1;
      } catch {
        // 仅统计匹配分支数。
      }
    }
    assert.equal(matches, 1, `${location} 必须恰好匹配 oneOf 中的一个分支`);
  }
  if (Array.isArray(schema.allOf)) {
    for (const branch of schema.allOf) {
      assertMatchesJsonSchema(
        value,
        branch as JsonSchemaNode,
        rootSchema,
        location,
      );
    }
  }
  if (schema.type !== undefined) {
    const allowedTypes = Array.isArray(schema.type)
      ? schema.type
      : [schema.type];
    const actualType =
      value === null
        ? "null"
        : Array.isArray(value)
          ? "array"
          : typeof value === "number" && Number.isInteger(value)
            ? "integer"
            : typeof value;
    const typeMatches = allowedTypes.some(
      (expected) =>
        expected === actualType ||
        (expected === "number" && actualType === "integer"),
    );
    assert.ok(
      typeMatches,
      `${location} 类型应为 ${JSON.stringify(schema.type)}，实际为 ${actualType}`,
    );
  }
  if (Array.isArray(value) && schema.items !== undefined) {
    value.forEach((item, index) => {
      assertMatchesJsonSchema(
        item,
        schema.items as JsonSchemaNode,
        rootSchema,
        `${location}[${index}]`,
      );
    });
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as Readonly<Record<string, unknown>>;
    if (Array.isArray(schema.required)) {
      for (const requiredKey of schema.required) {
        assert.ok(
          typeof requiredKey === "string" && Object.hasOwn(record, requiredKey),
          `${location} 缺少必需字段 ${String(requiredKey)}`,
        );
      }
    }
    const properties =
      typeof schema.properties === "object" && schema.properties !== null
        ? (schema.properties as Readonly<Record<string, JsonSchemaNode>>)
        : {};
    for (const [key, propValue] of Object.entries(record)) {
      if (Object.hasOwn(properties, key)) {
        assertMatchesJsonSchema(
          propValue,
          properties[key]!,
          rootSchema,
          `${location}.${key}`,
        );
      } else if (schema.additionalProperties === false) {
        assert.fail(`${location} 包含未允许的额外字段 ${key}`);
      } else if (
        typeof schema.additionalProperties === "object" &&
        schema.additionalProperties !== null
      ) {
        assertMatchesJsonSchema(
          propValue,
          schema.additionalProperties as JsonSchemaNode,
          rootSchema,
          `${location}.${key}`,
        );
      }
    }
  }
}

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
      const inputFieldKeys = (
        qaInput.fields as readonly { readonly key: string }[]
      ).map(({ key }) => key);
      assert.deepEqual(inputFieldKeys, [
        "config",
        "languages",
        "checks",
        "groups",
        "severity",
        "maxPerCheck",
      ]);
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

    const oldSuppressionContents = "format: unsupported\nsuppressions: []\n";
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
    assert.equal(
      await readFile(suppressionPath, "utf8"),
      oldSuppressionContents,
    );
  },
);
