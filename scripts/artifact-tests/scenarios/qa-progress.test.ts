import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { QualityRunResult, TranslationProgress } from "@lioni/core";

import { testArtifactConsumer } from "../support/consumer.ts";
import { assertMatchesJsonSchema } from "../support/json-schema.ts";
import { runSubprocess } from "../support/process.ts";

type ExpectedProgress = {
  readonly language: string;
  readonly completed: number;
  readonly total: number;
};

testArtifactConsumer(
  {
    name: "已保存资源的翻译进度、检查豁免与正式同步",
    fixtures: new URL("../fixtures/qa-progress/", import.meta.url),
  },
  async ({ root, runProcess, runCommand, runNode, typecheck }) => {
    await typecheck();
    const cli = path.join(
      root,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "lioni.cmd" : "lioni",
    );
    const resource = (name: string) => path.join(root, name);
    const source = { greeting: "Hello", button: "Open", brand: "Lioni" };
    const translations = { greeting: "Bonjour", brand: "Lioni" };
    await writeFile(resource("source.json"), JSON.stringify(source));
    await writeFile(resource("fr.json"), JSON.stringify(translations));
    await writeFile(
      resource("de.json"),
      JSON.stringify({ greeting: "Hallo", button: "Öffnen" }),
    );

    // 免配置验证：从 lioni --schema 找到 qa，从 --schema=input 查到展示参数，
    // 从 --schema=wire:structured 取得并校验输出 JSON Schema。
    const noConfigDir = await mkdtemp(path.join(root, "qa-no-config-"));
    let wireNotPassedSchema: Readonly<Record<string, unknown>>;
    try {
      const runSchema = async (args: readonly string[]) => {
        const result = await runSubprocess(cli, args, {
          cwd: noConfigDir,
          shell: process.platform === "win32",
        });
        assert.equal(result.status, 0, result.stderr || result.stdout);
        return JSON.parse(result.stdout) as Readonly<Record<string, unknown>>;
      };

      const rootDirectory = await runSchema(["--schema"]);
      const children = rootDirectory.children as readonly {
        readonly name: string;
      }[];
      assert.ok(children.some(({ name }) => name === "qa"));

      const qaInputSchema = await runSchema(["qa", "--schema=input"]);
      const qaFields = qaInputSchema.fields as readonly {
        readonly key: string;
        readonly longOption?: string;
      }[];
      assert.ok(
        qaFields.some(
          ({ key, longOption }) =>
            key === "severity" && longOption === "--severity",
        ),
      );
      assert.ok(
        qaFields.some(
          ({ key, longOption }) =>
            key === "maxPerCheck" && longOption === "--max-per-check",
        ),
      );

      const wireSchema = (await runSchema([
        "qa",
        "--schema=wire:structured",
      ])) as {
        readonly wire: {
          readonly data: {
            readonly checked: {
              readonly properties: {
                readonly data: {
                  readonly properties: Readonly<Record<string, unknown>>;
                };
              };
            };
            readonly notPassed: {
              readonly properties: {
                readonly data: {
                  readonly properties: Readonly<Record<string, unknown>>;
                };
              };
            };
          };
        };
      };
      wireNotPassedSchema = wireSchema.wire.data.notPassed;
      for (const variant of [
        wireSchema.wire.data.checked,
        wireSchema.wire.data.notPassed,
      ]) {
        const dataProps = variant.properties.data.properties as Readonly<
          Record<
            string,
            { readonly properties?: Readonly<Record<string, unknown>> }
          >
        >;
        assert.ok("progress" in dataProps);
        assert.ok("evaluatedCount" in (dataProps.checkScope?.properties ?? {}));
      }
    } finally {
      await rm(noConfigDir, { recursive: true, force: true });
    }

    async function verifyProgress(
      expected: readonly ExpectedProgress[],
      options: {
        readonly configFile?: string;
        readonly cliArgs?: readonly string[];
        readonly sdkOptions?: Readonly<Record<string, unknown>>;
        readonly expectedExitCode?: number;
        readonly expectedEvaluatedCount?: number;
        readonly verifyText?: boolean;
      } = {},
    ) {
      const configFile = options.configFile ?? "lioni.config.ts";
      const cliArgs = options.cliArgs ?? [];
      const sdkArgs =
        options.sdkOptions === undefined
          ? ["run", configFile]
          : ["run", configFile, JSON.stringify(options.sdkOptions)];
      const sdk = JSON.parse(
        (await runNode("consumer.ts", sdkArgs)).stdout,
      ) as QualityRunResult;
      const result = await runProcess(cli, [
        "qa",
        configFile,
        ...cliArgs,
        "--output",
        "structured",
      ]);
      const expectedStatus =
        options.expectedExitCode ??
        (expected.every(({ completed, total }) => completed === total) ? 0 : 1);
      assert.equal(result.status, expectedStatus, result.stderr);
      const envelope = JSON.parse(result.stdout) as {
        readonly schemaVersion: string;
        readonly variant: string;
        readonly data: QualityRunResult;
      };
      assert.equal(envelope.schemaVersion, "3");
      assert.equal(
        envelope.variant,
        expectedStatus === 0 ? "checked" : "notPassed",
      );
      const report = envelope.data;
      assert.deepEqual(report, sdk);
      if (options.expectedEvaluatedCount !== undefined) {
        assert.equal(
          report.checkScope.evaluatedCount,
          options.expectedEvaluatedCount,
        );
      }
      const progress: readonly TranslationProgress[] | undefined =
        report.progress;
      assert.ok(progress);
      assert.equal(progress.length, expected.length);
      for (const [index, entry] of expected.entries()) {
        const actual: TranslationProgress | undefined = progress[index];
        assert.ok(actual);
        assert.equal(actual.language, entry.language);
        assert.equal(actual.completed, entry.completed);
        assert.equal(actual.total, entry.total);
        if (entry.total === 0) assert.equal(actual.percentage, undefined);
        else
          assert.ok(
            Math.abs(
              actual.percentage! - (entry.completed * 100) / entry.total,
            ) < 0.0001,
          );
      }
      if (
        options.verifyText === true &&
        options.expectedEvaluatedCount !== undefined
      ) {
        const textResult = await runProcess(cli, [
          "qa",
          configFile,
          ...cliArgs,
        ]);
        assert.equal(textResult.status, expectedStatus, textResult.stderr);
        assert.match(
          textResult.stdout,
          new RegExp(`运行了 ${options.expectedEvaluatedCount} 项检查`, "u"),
        );
      }
      return report;
    }

    // 1. 主流程与缺译/草稿/不可读边界：1/3 -> 关闭或豁免缺译检查 -> 草稿不改已保存进度 -> 同步占位 1/3 -> 补译 2/3 -> 豁免品牌同文 3/3。
    const first = await verifyProgress(
      [{ language: "fr", completed: 1, total: 3 }],
      { expectedEvaluatedCount: 2, verifyText: true },
    );
    assert.deepEqual(
      first.diagnostics.map(({ checkId, object }) => [checkId, object.key]),
      [
        ["missing-translation", "button"],
        ["same-text", "brand"],
      ],
    );

    // 关闭 missing-translation 检查时不产生缺译诊断，其他检查仍影响进度（2/3）。
    const withoutMissing = await verifyProgress(
      [{ language: "fr", completed: 2, total: 3 }],
      {
        configFile: "same-text-only.config.ts",
        expectedExitCode: 1,
        expectedEvaluatedCount: 1,
      },
    );
    assert.deepEqual(
      withoutMissing.diagnostics.map(({ checkId, object }) => [
        checkId,
        object.key,
      ]),
      [["same-text", "brand"]],
    );

    // 为缺译诊断建立豁免后，已豁免缺译诊断保留在报告中、该对象仍计入 total=3 分母，
    // 其他检查（same-text）发现的问题仍影响进度（2/3）。
    const missingButton = first.diagnostics.find(
      ({ checkId, object }) =>
        checkId === "missing-translation" && object.key === "button",
    );
    assert.ok(missingButton);
    await writeFile(resource("first-report.json"), JSON.stringify(first));
    await runCommand(cli, [
      "suppressions",
      "upsert",
      "lioni.config.ts",
      "first-report.json",
      "--check-id",
      missingButton.checkId,
      "--execution-id",
      String(missingButton.executionId),
      "--id",
      "suppress-missing-button",
      "--reason",
      "按钮暂保留未译。",
    ]);
    const suppressedMissing = await verifyProgress(
      [{ language: "fr", completed: 2, total: 3 }],
      { expectedExitCode: 1, expectedEvaluatedCount: 2 },
    );
    const suppressedMissingDiag = suppressedMissing.diagnostics.find(
      ({ checkId, object }) =>
        checkId === "missing-translation" && object.key === "button",
    );
    assert.equal(suppressedMissingDiag?.handling.status, "suppressed");
    if (suppressedMissingDiag?.handling.status === "suppressed") {
      assert.equal(
        suppressedMissingDiag.handling.suppressionId,
        "suppress-missing-button",
      );
    }
    assert.equal(
      suppressedMissing.diagnostics.find(
        ({ checkId, object }) =>
          checkId === "same-text" && object.key === "brand",
      )?.handling.status,
      "active",
    );
    await rm(resource("lioni.suppressions.yaml"), { force: true });

    // 草稿送检与空候选后，再次全量检查已保存资源仍报告缺译 1/3。
    await runNode("consumer.ts", ["draft"]);
    await verifyProgress([{ language: "fr", completed: 1, total: 3 }], {
      expectedEvaluatedCount: 2,
    });

    // 已保存资源存在记录但正文不可读时，CLI 非零退出、显示原因且无最终进度。
    for (const args of [
      ["qa", "unavailable.config.ts"],
      ["qa", "unavailable.config.ts", "--output", "structured"],
    ]) {
      const unavailableResult = await runProcess(cli, args);
      assert.equal(unavailableResult.status, 1);
      assert.match(
        unavailableResult.stdout + unavailableResult.stderr,
        /缺少可靠的译文读取依据|无法读取候选正文/u,
      );
      assert.doesNotMatch(
        unavailableResult.stdout + unavailableResult.stderr,
        /翻译进度|"progress"/u,
      );
    }

    await runNode("consumer.ts", ["severity"]);
    await runCommand(cli, ["update", "lioni.config.ts"]);
    assert.equal(
      JSON.parse(await readFile(resource("fr.json"), "utf8")).button,
      "Open",
    );
    const filled = await verifyProgress(
      [{ language: "fr", completed: 1, total: 3 }],
      { expectedEvaluatedCount: 2 },
    );
    assert.deepEqual(
      filled.diagnostics
        .map(({ checkId, object }) => [checkId, object.key])
        .sort(([aCheck, aKey], [bCheck, bKey]) =>
          aCheck === bCheck
            ? (aKey ?? "").localeCompare(bKey ?? "")
            : (aCheck ?? "").localeCompare(bCheck ?? ""),
        ),
      [
        ["same-text", "brand"],
        ["same-text", "button"],
      ],
    );
    await writeFile(
      resource("fr.json"),
      JSON.stringify({ ...translations, button: "Ouvrir" }),
    );
    const translated = await verifyProgress(
      [{ language: "fr", completed: 2, total: 3 }],
      { expectedEvaluatedCount: 2 },
    );
    assert.equal(translated.diagnostics.length, 1);
    const brand = translated.diagnostics[0]!;
    await writeFile(resource("qa-report.json"), JSON.stringify(translated));
    await runCommand(cli, [
      "suppressions",
      "upsert",
      "lioni.config.ts",
      "qa-report.json",
      "--check-id",
      brand.checkId,
      "--execution-id",
      String(brand.executionId),
      "--id",
      "brand-fr",
      "--reason",
      "品牌名称保留原文。",
    ]);
    const done = await verifyProgress(
      [{ language: "fr", completed: 3, total: 3 }],
      { expectedEvaluatedCount: 2 },
    );
    assert.equal(done.diagnostics[0]?.handling.status, "suppressed");

    // 2. 范围控制：显式全部规则、分组并集覆盖全部规则与单语言选择均返回完整进度；子集省略进度。
    await verifyProgress([{ language: "fr", completed: 3, total: 3 }], {
      cliArgs: ["--check", "missing-translation", "--check", "same-text"],
      sdkOptions: { checkIds: ["same-text", "missing-translation"] },
      expectedEvaluatedCount: 2,
    });
    await verifyProgress([{ language: "fr", completed: 3, total: 3 }], {
      cliArgs: ["--group", "missingOnly", "--group", "sameOnly"],
      sdkOptions: { groups: ["sameOnly", "missingOnly"] },
      expectedEvaluatedCount: 2,
    });
    for (const subsetArgs of [
      ["--check", "same-text"],
      ["--group", "missingOnly"],
    ]) {
      const partial = await runCommand(cli, [
        "qa",
        "lioni.config.ts",
        ...subsetArgs,
        "--output",
        "structured",
      ]);
      assert.equal(
        Object.hasOwn(JSON.parse(partial.stdout).data, "progress"),
        false,
      );
    }
    await verifyProgress([{ language: "fr", completed: 3, total: 3 }], {
      configFile: "multi-language.config.ts",
      cliArgs: ["--language", "fr"],
      sdkOptions: { languages: ["fr"] },
      expectedEvaluatedCount: 2,
    });
    await verifyProgress(
      [
        { language: "fr", completed: 3, total: 3 },
        { language: "de", completed: 2, total: 3 },
      ],
      {
        configFile: "multi-language.config.ts",
        expectedEvaluatedCount: 2,
      },
    );

    // 3. 多检查项与各严重度（error/warning/info）、跨消息 evidence、豁免后仅剩 warning/info 退出码 0。
    const savedSuppressions = await readFile(
      resource("lioni.suppressions.yaml"),
      "utf8",
    );
    await writeFile(
      resource("lioni.suppressions.yaml"),
      "format: lioni.qa-suppressions/v1\nsuppressions: []\n",
    );
    const severityInitial = await verifyProgress(
      [{ language: "fr", completed: 1, total: 3 }],
      {
        configFile: "severity.config.ts",
        expectedExitCode: 1,
        expectedEvaluatedCount: 2,
        verifyText: true,
      },
    );
    const buttonError = severityInitial.diagnostics.find(
      ({ checkId, object }) => checkId === "tone-b" && object.key === "button",
    );
    assert.ok(buttonError);
    await writeFile(
      resource("severity-report.json"),
      JSON.stringify(severityInitial),
    );
    await runCommand(cli, [
      "suppressions",
      "upsert",
      "severity.config.ts",
      "severity-report.json",
      "--check-id",
      buttonError.checkId,
      "--execution-id",
      String(buttonError.executionId),
      "--id",
      "suppress-tone-b-button",
      "--reason",
      "仅留提示与警告待复核。",
    ]);
    // 豁免 tone-b 错误后，button 仍有 tone-a 的 info/warning，进度仍为 1/3，但 CLI 以 0 退出。
    const onlyWarnInfo = await verifyProgress(
      [{ language: "fr", completed: 1, total: 3 }],
      {
        configFile: "severity.config.ts",
        expectedExitCode: 0,
        expectedEvaluatedCount: 2,
        verifyText: true,
      },
    );
    assert.equal(
      onlyWarnInfo.diagnostics.find(({ checkId }) => checkId === "tone-b")
        ?.handling.status,
      "suppressed",
    );

    // 同一检查在一对象产生 2 条诊断、另一对象 0 条诊断时的豁免绑定与冲突校验：
    // 任选一条建立豁免 -> 两条均 suppressed；同 ID 更新理由生效；换用另一 ID 冲突列出两 ID；零诊断执行拒绝建立。
    const toneAButtonDiag = severityInitial.diagnostics.find(
      ({ checkId, object }) => checkId === "tone-a" && object.key === "button",
    );
    assert.ok(toneAButtonDiag);
    await runCommand(cli, [
      "suppressions",
      "upsert",
      "severity.config.ts",
      "severity-report.json",
      "--check-id",
      toneAButtonDiag.checkId,
      "--execution-id",
      String(toneAButtonDiag.executionId),
      "--id",
      "suppress-tone-a-button",
      "--reason",
      "首次接受按钮两项待复核。",
    ]);
    const bothSuppressed = await verifyProgress(
      [{ language: "fr", completed: 2, total: 3 }],
      {
        configFile: "severity.config.ts",
        expectedExitCode: 0,
        expectedEvaluatedCount: 2,
      },
    );
    const toneAButtonAfter = bothSuppressed.diagnostics.filter(
      ({ checkId, object }) => checkId === "tone-a" && object.key === "button",
    );
    assert.equal(toneAButtonAfter.length, 2);
    for (const diag of toneAButtonAfter) {
      assert.equal(diag.handling.status, "suppressed");
      if (diag.handling.status === "suppressed") {
        assert.equal(diag.handling.suppressionId, "suppress-tone-a-button");
        assert.equal(diag.handling.reason, "首次接受按钮两项待复核。");
      }
    }
    assert.equal(
      bothSuppressed.diagnostics.find(
        ({ checkId, object }) =>
          checkId === "tone-a" && object.key === "greeting",
      )?.handling.status,
      "active",
    );
    assert.equal(
      bothSuppressed.diagnostics.some(({ object }) => object.key === "brand"),
      false,
    );

    // 用相同 ID 更新理由生效。
    await runCommand(cli, [
      "suppressions",
      "upsert",
      "severity.config.ts",
      "severity-report.json",
      "--check-id",
      toneAButtonDiag.checkId,
      "--execution-id",
      String(toneAButtonDiag.executionId),
      "--id",
      "suppress-tone-a-button",
      "--reason",
      "更新后的按钮复核理由。",
    ]);
    const updatedReason = await verifyProgress(
      [{ language: "fr", completed: 2, total: 3 }],
      {
        configFile: "severity.config.ts",
        expectedExitCode: 0,
        expectedEvaluatedCount: 2,
      },
    );
    for (const diag of updatedReason.diagnostics.filter(
      ({ checkId, object }) => checkId === "tone-a" && object.key === "button",
    )) {
      assert.equal(diag.handling.status, "suppressed");
      if (diag.handling.status === "suppressed") {
        assert.equal(diag.handling.reason, "更新后的按钮复核理由。");
      }
    }

    // 换用另一 ID 指向同一绑定时，CLI 与 SDK 均报错并同时列出两个冲突 ID。
    const conflictCli = await runProcess(cli, [
      "suppressions",
      "upsert",
      "severity.config.ts",
      "severity-report.json",
      "--check-id",
      toneAButtonDiag.checkId,
      "--execution-id",
      String(toneAButtonDiag.executionId),
      "--id",
      "suppress-tone-a-button-conflict",
      "--reason",
      "重复绑定应当冲突。",
    ]);
    assert.equal(conflictCli.status, 1);
    assert.match(
      conflictCli.stdout + conflictCli.stderr,
      /suppress-tone-a-button.*suppress-tone-a-button-conflict/u,
    );
    const conflictSdk = await runNode("consumer.ts", [
      "expect-upsert-error",
      "severity.config.ts",
      "severity-report.json",
      toneAButtonDiag.checkId,
      String(toneAButtonDiag.executionId),
      "suppress-tone-a-button-conflict",
      "重复绑定应当冲突。",
    ]);
    assert.match(
      conflictSdk.stdout,
      /suppress-tone-a-button.*suppress-tone-a-button-conflict/u,
    );

    // 用零诊断执行（includeCleanExecutions: true 导出的无诊断执行 ID）建立豁免时，CLI 与 SDK 均报错拒绝。
    const cleanReportJson = (
      await runNode("consumer.ts", [
        "run",
        "severity.config.ts",
        JSON.stringify({ includeCleanExecutions: true }),
      ])
    ).stdout;
    const cleanReport = JSON.parse(cleanReportJson) as QualityRunResult;
    const zeroDiagExec = cleanReport.checks
      .find(({ checkId }) => checkId === "tone-a")
      ?.executions.find(({ sourceKey }) => sourceKey === "brand");
    assert.ok(zeroDiagExec);
    await writeFile(resource("severity-clean-report.json"), cleanReportJson);
    const zeroDiagCli = await runProcess(cli, [
      "suppressions",
      "upsert",
      "severity.config.ts",
      "severity-clean-report.json",
      "--check-id",
      zeroDiagExec.checkId,
      "--execution-id",
      String(zeroDiagExec.executionId),
      "--id",
      "suppress-clean-brand",
      "--reason",
      "零诊断执行不应建豁免。",
    ]);
    assert.equal(zeroDiagCli.status, 1);
    assert.match(
      zeroDiagCli.stdout + zeroDiagCli.stderr,
      /没有实际诊断，不能建立豁免/u,
    );
    const zeroDiagSdk = await runNode("consumer.ts", [
      "expect-upsert-error",
      "severity.config.ts",
      "severity-clean-report.json",
      zeroDiagExec.checkId,
      String(zeroDiagExec.executionId),
      "suppress-clean-brand",
      "零诊断执行不应建豁免。",
    ]);
    assert.match(zeroDiagSdk.stdout, /没有实际诊断，不能建立豁免/u);

    // 4. 失效豁免核验：已保存资源同时存在有效豁免与全部五类失效豁免时，
    // 验证部分检查、草稿送检、单一语言、全项目完整检查与手工清理恢复。
    await writeFile(
      resource("lioni.suppressions.yaml"),
      "format: lioni.qa-suppressions/v1\nsuppressions: []\n",
    );
    await writeFile(
      resource("fr.json"),
      JSON.stringify({ greeting: "Bonjour", button: "Ouvrir", brand: "Lioni" }),
    );
    await writeFile(
      resource("de.json"),
      JSON.stringify({ greeting: "Hallo", button: "Öffnen", brand: "Lioni" }),
    );
    await writeFile(resource(".emit-conditional-note"), "1");
    const staleBaselineReport = JSON.parse(
      (await runNode("consumer.ts", ["run", "stale-suppressions.config.ts"]))
        .stdout,
    ) as QualityRunResult;
    await writeFile(
      resource("stale-baseline-report.json"),
      JSON.stringify(staleBaselineReport),
    );
    const staleHeaderAndStaticRecords = [
      "format: lioni.qa-suppressions/v1",
      "suppressions:",
      "  - id: stale-missing-check",
      "    reason: 规则已移除。",
      "    checkId: removed-check",
      "    sourceKey: greeting",
      "    language: de",
      "    inputFingerprint: unused",
      "    fingerprintSummary:",
      "      version: '1'",
      "      inputFingerprint: unused",
      "  - id: stale-missing-key",
      "    reason: 原文键已删除。",
      "    checkId: same-text",
      "    sourceKey: removed-key",
      "    language: de",
      "    inputFingerprint: unused",
      "    fingerprintSummary:",
      "      version: '1'",
      "      inputFingerprint: unused",
      "  - id: stale-missing-lang",
      "    reason: 语言已移除。",
      "    checkId: same-text",
      "    sourceKey: brand",
      "    language: es",
      "    inputFingerprint: unused",
      "    fingerprintSummary:",
      "      version: '1'",
      "      inputFingerprint: unused",
      "",
    ].join("\n");
    await writeFile(
      resource("lioni.suppressions.yaml"),
      staleHeaderAndStaticRecords,
    );
    const validFrDiag = staleBaselineReport.diagnostics.find(
      ({ checkId, object }) =>
        checkId === "same-text" &&
        object.key === "brand" &&
        object.language === "fr",
    );
    const deBrandDiag = staleBaselineReport.diagnostics.find(
      ({ checkId, object }) =>
        checkId === "same-text" &&
        object.key === "brand" &&
        object.language === "de",
    );
    const deNoteDiag = staleBaselineReport.diagnostics.find(
      ({ checkId, object }) =>
        checkId === "conditional-note" &&
        object.key === "greeting" &&
        object.language === "de",
    );
    assert.ok(validFrDiag && deBrandDiag && deNoteDiag);
    for (const [id, diag, reason] of [
      ["valid-brand-fr", validFrDiag, "法语品牌保留原文。"],
      ["stale-fingerprint", deBrandDiag, "等待后续改写触发指纹变化。"],
      ["stale-no-diag", deNoteDiag, "等待条件消失后验证零诊断失效。"],
    ] as const) {
      await runCommand(cli, [
        "suppressions",
        "upsert",
        "stale-suppressions.config.ts",
        "stale-baseline-report.json",
        "--check-id",
        diag.checkId,
        "--execution-id",
        String(diag.executionId),
        "--id",
        id,
        "--reason",
        reason,
      ]);
    }
    // 触发指纹改变与同指纹下已无原始诊断。
    await writeFile(
      resource("de.json"),
      JSON.stringify({
        greeting: "Hallo",
        button: "Öffnen",
        brand: "Lioni DE",
      }),
    );
    await rm(resource(".emit-conditional-note"), { force: true });

    // (1) 部分检查：应用有效豁免，省略进度并跳过失效核验。
    const partial = await runCommand(cli, [
      "qa",
      "stale-suppressions.config.ts",
      "--check",
      "same-text",
      "--output",
      "structured",
    ]);
    const partialData = JSON.parse(partial.stdout).data as QualityRunResult;
    assert.equal(Object.hasOwn(partialData, "progress"), false);
    assert.equal(
      partialData.diagnostics.find(
        ({ checkId, object }) =>
          checkId === "same-text" &&
          object.key === "brand" &&
          object.language === "fr",
      )?.handling.status,
      "suppressed",
    );

    // (2) 草稿送检：应用有效豁免，省略进度并跳过失效核验。
    const draftWithStale = JSON.parse(
      (
        await runNode("consumer.ts", [
          "run",
          "stale-suppressions.config.ts",
          JSON.stringify({
            candidates: [
              { sourceKey: "brand", language: "fr", content: "Lioni" },
            ],
          }),
        ])
      ).stdout,
    ) as QualityRunResult;
    assert.equal(draftWithStale.progress, undefined);
    assert.equal(draftWithStale.diagnostics[0]?.handling.status, "suppressed");

    // (3) 单一语言完整检查：法语只核验法语（无失效，返回进度）；德语只报德语失效（不含 es）。
    const frOnly = await verifyProgress(
      [{ language: "fr", completed: 3, total: 3 }],
      {
        configFile: "stale-suppressions.config.ts",
        cliArgs: ["--language", "fr"],
        sdkOptions: { languages: ["fr"] },
        expectedExitCode: 0,
        expectedEvaluatedCount: 3,
      },
    );
    assert.equal(frOnly.diagnostics[0]?.handling.status, "suppressed");

    const deOnly = await runProcess(cli, [
      "qa",
      "stale-suppressions.config.ts",
      "--language",
      "de",
    ]);
    assert.equal(deOnly.status, 1);
    const deOnlyText = deOnly.stdout + deOnly.stderr;
    for (const expectedId of [
      "stale-missing-check",
      "stale-missing-key",
      "stale-fingerprint",
      "stale-no-diag",
    ]) {
      assert.ok(
        deOnlyText.includes(expectedId),
        `缺少德语失效记录 ${expectedId}`,
      );
    }
    assert.equal(deOnlyText.includes("stale-missing-lang"), false);
    assert.equal(deOnlyText.includes("valid-brand-fr"), false);
    assert.doesNotMatch(deOnlyText, /翻译进度/u);

    // (4) 全项目完整检查：CLI 非零退出、SDK 抛错、无最终进度，一次列出全部五类失效 ID 与原因。
    for (const args of [
      ["qa", "stale-suppressions.config.ts"],
      ["qa", "stale-suppressions.config.ts", "--output", "structured"],
    ]) {
      const fullStaleCli = await runProcess(cli, args);
      assert.equal(fullStaleCli.status, 1);
      const output = fullStaleCli.stdout + fullStaleCli.stderr;
      assert.doesNotMatch(output, /翻译进度|"progress"/u);
      assert.equal(output.includes("valid-brand-fr"), false);
      assert.match(output, /stale-missing-check.*检查项已不存在/u);
      assert.match(output, /stale-missing-key.*原文键已不存在/u);
      assert.match(output, /stale-missing-lang.*目标语言已不存在/u);
      assert.match(output, /stale-fingerprint.*检查输入指纹已改变/u);
      assert.match(output, /stale-no-diag.*当前依据下没有可豁免的诊断/u);
    }
    const fullStaleSdk = (
      await runNode("consumer.ts", [
        "expect-run-error",
        "stale-suppressions.config.ts",
      ])
    ).stdout;
    assert.match(fullStaleSdk, /stale-missing-check.*检查项已不存在/u);
    assert.match(fullStaleSdk, /stale-missing-key.*原文键已不存在/u);
    assert.match(fullStaleSdk, /stale-missing-lang.*目标语言已不存在/u);
    assert.match(fullStaleSdk, /stale-fingerprint.*检查输入指纹已改变/u);
    assert.match(fullStaleSdk, /stale-no-diag.*当前依据下没有可豁免的诊断/u);

    // (5) 手工删除失效记录只保留 valid-brand-fr 后重新运行，成功取得完整进度。
    await writeFile(resource("lioni.suppressions.yaml"), savedSuppressions);
    const recovered = await verifyProgress(
      [
        { language: "fr", completed: 3, total: 3 },
        { language: "de", completed: 3, total: 3 },
      ],
      {
        configFile: "stale-suppressions.config.ts",
        expectedExitCode: 0,
        expectedEvaluatedCount: 3,
      },
    );
    assert.equal(recovered.diagnostics[0]?.handling.status, "suppressed");

    // 5. 边界场景：10 条全缺译 + 0 项检查 / 1 项空诊断检查 / 缓存命中 / 完整空项目含孤立译文。
    await writeFile(
      resource("lioni.suppressions.yaml"),
      "format: lioni.qa-suppressions/v1\nsuppressions: []\n",
    );
    await writeFile(
      resource("source.json"),
      JSON.stringify(
        Object.fromEntries(
          Array.from({ length: 10 }, (_, i) => [`k${i}`, `Source ${i}`]),
        ),
      ),
    );
    await writeFile(resource("fr.json"), "{}");
    const zero = await runNode("consumer.ts", ["zero"]);
    const zeroCli = await runProcess(cli, [
      "qa",
      "no-checks.config.ts",
      "--output",
      "structured",
    ]);
    assert.equal(zeroCli.status, 1);
    const zeroReport = JSON.parse(zeroCli.stdout);
    assert.equal(zeroReport.variant, "notPassed");
    assert.deepEqual(zeroReport.data, JSON.parse(zero.stdout));
    const zeroText = await runProcess(cli, ["qa", "no-checks.config.ts"]);
    assert.equal(zeroText.status, 1);
    assert.match(zeroText.stdout, /运行了 0 项检查/u);
    assert.match(zeroText.stdout, /翻译进度 fr：10\/10（100%）/u);

    await verifyProgress([{ language: "fr", completed: 10, total: 10 }], {
      configFile: "empty-check.config.ts",
      expectedExitCode: 0,
      expectedEvaluatedCount: 1,
      verifyText: true,
    });

    // 缓存命中照常计入运行的检查项数。
    await verifyProgress([{ language: "fr", completed: 10, total: 10 }], {
      configFile: "cached.config.ts",
      expectedExitCode: 0,
      expectedEvaluatedCount: 1,
      verifyText: true,
    });
    const firstCacheCalls = (
      await readFile(resource(".cache-calls.log"), "utf8")
    )
      .trim()
      .split("\n").length;
    assert.equal(firstCacheCalls, 10);
    await verifyProgress([{ language: "fr", completed: 10, total: 10 }], {
      configFile: "cached.config.ts",
      expectedExitCode: 0,
      expectedEvaluatedCount: 1,
      verifyText: true,
    });
    const secondCacheCalls = (
      await readFile(resource(".cache-calls.log"), "utf8")
    )
      .trim()
      .split("\n").length;
    assert.equal(secondCacheCalls, 10);

    // 完整空项目（另有目标孤立译文）：0/0、省略 percentage、运行了 0 项检查、以 0 退出。
    await writeFile(resource("source.json"), "{}");
    await writeFile(resource("fr.json"), JSON.stringify({ orphan: "Ancien" }));
    await verifyProgress([{ language: "fr", completed: 0, total: 0 }], {
      expectedExitCode: 0,
      expectedEvaluatedCount: 0,
      verifyText: true,
    });
    const emptyText = await runProcess(cli, ["qa", "lioni.config.ts"]);
    assert.equal(emptyText.status, 0);
    assert.match(emptyText.stdout, /^翻译进度 fr：0\/0$/mu);
    assert.match(emptyText.stdout, /运行了 0 项检查/u);

    // 6. 终端明细筛选与按检查项折叠：汇总、进度、退出码、结构化输出与豁免均依据完整结果。
    await writeFile(resource("source.json"), JSON.stringify(source));
    await writeFile(
      resource("fr.json"),
      JSON.stringify({ greeting: "Bonjour", button: "Ouvrir", brand: "Lioni" }),
    );
    await writeFile(
      resource("lioni.suppressions.yaml"),
      "format: lioni.qa-suppressions/v1\nsuppressions: []\n",
    );

    const detailsSdk = JSON.parse(
      (await runNode("consumer.ts", ["run", "terminal-details.config.ts"]))
        .stdout,
    ) as QualityRunResult;
    const detailsDefaultText = await runProcess(cli, [
      "qa",
      "terminal-details.config.ts",
    ]);
    assert.equal(detailsDefaultText.status, 1);
    assert.match(
      detailsDefaultText.stdout,
      /有效问题：错误 2，警告 2，提示 2；已豁免 0/u,
    );
    assert.match(detailsDefaultText.stdout, /翻译进度 fr：0\/3（0%）/u);
    for (const expectedLine of [
      "警告一",
      "错误一",
      "警告二",
      "错误二",
      "提示一",
      "附加术语提示",
    ]) {
      assert.ok(detailsDefaultText.stdout.includes(expectedLine));
    }
    assert.doesNotMatch(detailsDefaultText.stdout, /被省略/u);

    const detailsWarningOnly = await runProcess(cli, [
      "qa",
      "terminal-details.config.ts",
      "--severity",
      "warning",
    ]);
    assert.equal(detailsWarningOnly.status, 1);
    assert.match(
      detailsWarningOnly.stdout,
      /有效问题：错误 2，警告 2，提示 2；已豁免 0/u,
    );
    assert.match(detailsWarningOnly.stdout, /翻译进度 fr：0\/3（0%）/u);
    assert.ok(detailsWarningOnly.stdout.includes("警告一"));
    assert.ok(detailsWarningOnly.stdout.includes("警告二"));
    assert.doesNotMatch(
      detailsWarningOnly.stdout,
      /错误一|错误二|提示一|附加术语提示|被省略/u,
    );

    const detailsUnion = await runProcess(cli, [
      "qa",
      "terminal-details.config.ts",
      "--severity",
      "warning",
      "--severity",
      "error",
    ]);
    assert.equal(detailsUnion.status, 1);
    for (const expectedLine of ["警告一", "错误一", "警告二", "错误二"]) {
      assert.ok(detailsUnion.stdout.includes(expectedLine));
    }
    assert.doesNotMatch(detailsUnion.stdout, /提示一|附加术语提示|被省略/u);

    const trackReadsMarker = resource(".track-reads");
    const readsLogPath = resource(".qa-reads.log");
    await writeFile(trackReadsMarker, "", "utf8");
    await writeFile(readsLogPath, "", "utf8");

    const detailsFolded = await runProcess(cli, [
      "qa",
      "terminal-details.config.ts",
      "--severity",
      "warning",
      "--severity",
      "error",
      "--max-per-check",
      "1",
    ]);
    assert.equal(detailsFolded.status, 1);
    assert.equal(
      (await readFile(readsLogPath, "utf8")).trim().split("\n").length,
      1,
    );
    assert.match(
      detailsFolded.stdout,
      /有效问题：错误 2，警告 2，提示 2；已豁免 0/u,
    );
    assert.match(detailsFolded.stdout, /翻译进度 fr：0\/3（0%）/u);
    assert.ok(detailsFolded.stdout.includes("警告一"));
    assert.doesNotMatch(
      detailsFolded.stdout,
      /错误一|警告二|错误二|提示一|附加术语提示/u,
    );
    assert.match(
      detailsFolded.stdout,
      /details-check：另有 3 条匹配明细因上限（1）被省略/u,
    );
    assert.doesNotMatch(detailsFolded.stdout, /extra-info.*被省略/u);

    await writeFile(readsLogPath, "", "utf8");
    const detailsStructuredFiltered = await runProcess(cli, [
      "qa",
      "terminal-details.config.ts",
      "--severity",
      "warning",
      "--max-per-check",
      "1",
      "--output",
      "structured",
    ]);
    assert.equal(detailsStructuredFiltered.status, 1);
    assert.equal(
      (await readFile(readsLogPath, "utf8")).trim().split("\n").length,
      1,
    );
    const detailsEnvelope = JSON.parse(detailsStructuredFiltered.stdout) as {
      readonly schemaVersion: string;
      readonly variant: string;
      readonly data: QualityRunResult;
    };
    assert.equal(detailsEnvelope.schemaVersion, "3");
    assert.equal(detailsEnvelope.variant, "notPassed");
    assertMatchesJsonSchema(
      detailsEnvelope,
      wireNotPassedSchema,
      wireNotPassedSchema,
    );
    assert.deepEqual(detailsEnvelope.data.progress, [
      { language: "fr", completed: 0, total: 3, percentage: 0 },
    ]);
    assert.deepEqual(detailsEnvelope.data, detailsSdk);

    // 仍可用结构化报告中在文本里被隐藏的错误诊断建立豁免。
    const hiddenError = detailsEnvelope.data.diagnostics.find(
      ({ checkId, severity, object }) =>
        checkId === "details-check" &&
        severity === "error" &&
        object.key === "greeting",
    );
    assert.ok(hiddenError);
    await writeFile(
      resource("terminal-details-report.json"),
      detailsStructuredFiltered.stdout,
    );
    await runCommand(cli, [
      "suppressions",
      "upsert",
      "terminal-details.config.ts",
      "terminal-details-report.json",
      "--check-id",
      hiddenError.checkId,
      "--execution-id",
      String(hiddenError.executionId),
      "--id",
      "suppress-greeting-details",
      "--reason",
      "确认允许当前问候语结构。",
    ]);
    const afterSuppressionWarningOnly = await runProcess(cli, [
      "qa",
      "terminal-details.config.ts",
      "--severity",
      "warning",
    ]);
    assert.equal(afterSuppressionWarningOnly.status, 1);
    assert.match(
      afterSuppressionWarningOnly.stdout,
      /有效问题：错误 1，警告 1，提示 2；已豁免 2/u,
    );
    assert.match(
      afterSuppressionWarningOnly.stdout,
      /翻译进度 fr：1\/3（33\.33%）/u,
    );
  },
);
