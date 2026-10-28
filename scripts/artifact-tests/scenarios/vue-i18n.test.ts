import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import { testArtifactConsumer } from "../support/consumer.ts";

testArtifactConsumer(
  {
    name: "Vue I18n 消息检查集合通过 SDK 和 CLI 运行",
    packages: ["@lioni/cli", "@lioni/core", "@lioni/checks"],
    fixtures: new URL("../fixtures/vue-i18n/", import.meta.url),
  },
  async ({ root, typecheck, runNode, runCommand }) => {
    await typecheck();
    const sdk = await runNode("consumer.ts");
    const summaries = JSON.parse(sdk.stdout) as readonly {
      target: string;
      status: string;
      diagnostics: readonly string[];
    }[];
    const executable = path.join(
      root,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "lioni.cmd" : "lioni",
    );
    for (const { target, status, diagnostics } of summaries) {
      await writeFile(path.join(root, "target.json"), JSON.stringify(target));
      const cli = await runCommand(executable, [
        "qa",
        "lioni.config.ts",
        "--output-format",
        "structured",
      ]);
      const { data } = JSON.parse(cli.stdout) as {
        data: {
          status: string;
          diagnostics: readonly { checkId: string }[];
        };
      };
      assert.equal(data.status, status);
      assert.deepEqual(
        data.diagnostics.map(({ checkId }) => checkId).sort(),
        diagnostics,
      );
    }
  },
);
