import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import { testArtifactConsumer } from "../support/consumer.ts";

testArtifactConsumer(
  {
    name: "Vue I18n 消息检查集合通过 SDK 和 CLI 运行",
    fixtures: new URL("../fixtures/vue-i18n/", import.meta.url),
  },
  async ({ root, typecheck, runNode, runProcess }) => {
    await typecheck();
    await runNode("basic-consumer.ts");
    await runNode("families-consumer.ts");
    await runNode("selection-consumer.ts");
    const sdk = await runNode("consumer.ts");
    const summaries = JSON.parse(sdk.stdout) as readonly {
      target: string;
      diagnostics: readonly string[];
    }[];
    const executable = path.join(
      root,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "lioni.cmd" : "lioni",
    );
    for (const { target, diagnostics } of summaries) {
      await writeFile(path.join(root, "target.json"), JSON.stringify(target));
      const cli = await runProcess(executable, [
        "qa",
        "lioni.config.ts",
        "--output",
        "structured",
      ]);
      assert.equal(cli.status, diagnostics.length === 0 ? 0 : 1);
      const { data } = JSON.parse(cli.stdout) as {
        data: {
          diagnostics: readonly { checkId: string }[];
        };
      };
      assert.deepEqual(
        data.diagnostics.map(({ checkId }) => checkId).sort(),
        diagnostics,
      );
    }
    await writeFile(path.join(root, "target.json"), JSON.stringify("无效 }"));
    const invalidFull = await runProcess(executable, [
      "qa",
      "lioni.config.ts",
      "--output-format",
      "structured",
    ]);
    assert.equal(invalidFull.status, 1);
    const invalidEnvelope = JSON.parse(
      invalidFull.stdout || invalidFull.stderr,
    ) as {
      readonly ok?: boolean;
      readonly variant?: string;
      readonly data?: {
        readonly message?: string;
        readonly diagnostics?: unknown;
      };
      readonly error?: { readonly data?: { readonly message?: string } };
    };
    assert.equal(invalidEnvelope.data?.diagnostics, undefined);
    assert.match(
      invalidEnvelope.error?.data?.message ??
        invalidEnvelope.data?.message ??
        "",
      /vue-i18n\/variable-correspondence.*message.*zh-CN/u,
    );
    const invalidSyntaxOnly = await runProcess(executable, [
      "qa",
      "lioni.config.ts",
      "--check",
      "vue-i18n/target-syntax",
      "--output-format",
      "structured",
    ]);
    assert.equal(invalidSyntaxOnly.status, 1);
    const { data: syntaxData } = JSON.parse(invalidSyntaxOnly.stdout) as {
      data: { diagnostics: readonly { checkId: string }[] };
    };
    assert.deepEqual(
      syntaxData.diagnostics.map(({ checkId }) => checkId),
      ["vue-i18n/target-syntax"],
    );
  },
);
