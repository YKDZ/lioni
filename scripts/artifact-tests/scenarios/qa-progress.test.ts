import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { QualityRunResult } from "@lioni/core";

import { testArtifactConsumer } from "../support/consumer.ts";

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

    // 验证 --schema=wire:structured 契约包含 progress 与 checkScope.evaluatedCount。
    const wireSchemaResult = await runCommand(cli, [
      "qa",
      "--schema=wire:structured",
    ]);
    const wireSchema = JSON.parse(wireSchemaResult.stdout) as {
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
      const progress = report.progress;
      assert.equal(progress?.length, expected.length);
      for (const [index, entry] of expected.entries()) {
        const actual = progress[index];
        assert.equal(actual?.language, entry.language);
        assert.equal(actual?.completed, entry.completed);
        assert.equal(actual?.total, entry.total);
        if (entry.total === 0) assert.equal(actual?.percentage, undefined);
        else
          assert.ok(
            Math.abs(
              actual!.percentage! - (entry.completed * 100) / entry.total,
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

    // 1. 主流程：1/3 -> 同步占位 1/3 -> 补译 2/3 -> 豁免品牌同文 3/3。
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
    await runNode("consumer.ts", ["draft"]);
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

    // 4. 恢复品牌同文豁免并验证失效豁免检查。
    await writeFile(resource("lioni.suppressions.yaml"), savedSuppressions);
    await writeFile(
      resource("fr.json"),
      JSON.stringify({ ...translations, brand: "Lion", button: "Ouvrir" }),
    );
    const partial = await runCommand(cli, [
      "qa",
      "lioni.config.ts",
      "--check",
      "same-text",
      "--output",
      "structured",
    ]);
    assert.equal(
      Object.hasOwn(JSON.parse(partial.stdout).data, "progress"),
      false,
    );
    const stale = await runProcess(cli, ["qa", "lioni.config.ts"]);
    assert.equal(stale.status, 1);
    assert.match(stale.stdout + stale.stderr, /brand-fr.*检查输入指纹已改变/u);

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
  },
);
