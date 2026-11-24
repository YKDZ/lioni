import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { QualityRunResult } from "@lioni/core";

import { testArtifactConsumer } from "../support/consumer.ts";

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

    async function verifyProgress(completed: number, total: number) {
      const sdk = JSON.parse(
        (await runNode("consumer.ts")).stdout,
      ) as QualityRunResult;
      const argv = ["qa", "lioni.config.ts", "--output-format", "structured"];
      const result = await runProcess(cli, argv);
      assert.equal(result.status, completed === total ? 0 : 1, result.stderr);
      const report = (JSON.parse(result.stdout) as { data: QualityRunResult })
        .data;
      assert.deepEqual(report, sdk);
      const progress = report.progress;
      assert.equal(progress?.length, 1);
      assert.equal(progress[0]?.language, "fr");
      assert.equal(progress[0]?.completed, completed);
      assert.equal(progress[0]?.total, total);
      if (total === 0) assert.equal(progress[0]?.percentage, undefined);
      else
        assert.ok(
          Math.abs(progress[0]!.percentage! - (completed * 100) / total) <
            0.0001,
        );
      return report;
    }

    const first = await verifyProgress(1, 3);
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
    const filled = await verifyProgress(1, 3);
    assert.deepEqual(
      filled.diagnostics
        .map(({ checkId, object }) => [checkId, object.key])
        .sort(),
      [
        ["same-text", "brand"],
        ["same-text", "button"],
      ],
    );
    await writeFile(
      resource("fr.json"),
      JSON.stringify({ ...translations, button: "Ouvrir" }),
    );
    const translated = await verifyProgress(2, 3);
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
    const done = await verifyProgress(3, 3);
    assert.equal(done.diagnostics[0]?.handling.status, "suppressed");

    await writeFile(
      resource("fr.json"),
      JSON.stringify({ ...translations, brand: "Lion", button: "Ouvrir" }),
    );
    const partial = await runCommand(cli, [
      "qa",
      "lioni.config.ts",
      "--check",
      "same-text",
      "--output-format",
      "structured",
    ]);
    assert.equal(
      Object.hasOwn(JSON.parse(partial.stdout).data, "progress"),
      false,
    );
    const stale = await runProcess(cli, ["qa", "lioni.config.ts"]);
    assert.equal(stale.status, 1);
    assert.match(stale.stdout + stale.stderr, /brand-fr.*检查输入指纹已改变/u);

    // 宿主清理失效豁免后，零项检查与完整读取的空范围各有独立含义。
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
    const zeroCli = await runProcess(cli, ["qa", "no-checks.config.ts", "--output-format", "structured"]);
    assert.equal(zeroCli.status, 1);
    const zeroReport = JSON.parse(zeroCli.stdout);
    assert.equal(zeroReport.variant, "notPassed");
    assert.deepEqual(zeroReport.data, JSON.parse(zero.stdout));
    await writeFile(resource("source.json"), "{}");
    await writeFile(resource("fr.json"), JSON.stringify({ orphan: "Ancien" }));
    await verifyProgress(0, 0);
  },
);
