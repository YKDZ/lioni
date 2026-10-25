import assert from "node:assert/strict";

import { testArtifactConsumer } from "../support/consumer.ts";

testArtifactConsumer(
  {
    name: "文本分析通过隔离安装的 memo 与 text-analysis 正式制品运行",
    packages: ["@lioni/memo", "@lioni/text-analysis"],
    fixtures: new URL("../fixtures/text-analysis/", import.meta.url),
  },
  async ({ runNode, typecheck }) => {
    const declarations = await typecheck();
    assert.equal(declarations.status, 0);
    await runNode("consumer.ts");
  },
);
