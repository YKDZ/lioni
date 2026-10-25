import assert from "node:assert/strict";

import { testArtifactConsumer } from "../support/consumer.ts";

testArtifactConsumer(
  {
    name: "票 06：消息族通过公开 QA SDK 和正式声明消费",
    packages: [
      "@lioni/checks",
      "@lioni/core",
      "@lioni/memo",
      "@lioni/terminology",
      "@lioni/text-analysis",
    ],
    fixtures: new URL("../fixtures/message-families/", import.meta.url),
  },
  async ({ typecheck, runNode }) => {
    const declarations = await typecheck();
    assert.equal(declarations.status, 0);
    await runNode("consumer.ts");
  },
);
