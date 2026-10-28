import { testArtifactConsumer } from "../support/consumer.ts";

testArtifactConsumer(
  {
    name: "公共库的发布声明、运行入口与 Node 子路径",
    packages: [
      "@lioni/checks",
      "@lioni/memo",
      "@lioni/terminology",
      "@lioni/text-analysis",
    ],
    fixtures: new URL("../fixtures/libraries/", import.meta.url),
  },
  async ({ typecheck, runNode }) => {
    await typecheck();
    await runNode("consumer.ts");
  },
);
