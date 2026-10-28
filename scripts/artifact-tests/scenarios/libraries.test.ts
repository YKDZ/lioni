import { testArtifactConsumer } from "../support/consumer.ts";

testArtifactConsumer(
  {
    name: "单一产品包的 SDK 声明、运行入口与 Node 子路径",
    fixtures: new URL("../fixtures/libraries/", import.meta.url),
  },
  async ({ typecheck, runNode }) => {
    await typecheck();
    await runNode("consumer.ts");
  },
);
