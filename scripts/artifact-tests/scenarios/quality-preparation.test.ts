import { testArtifactConsumer } from "../support/consumer.ts";

testArtifactConsumer(
  {
    name: "正式产品包的 QA 准备、结果接入与分配成本",
    fixtures: new URL("../fixtures/libraries/", import.meta.url),
  },
  async ({ typecheck, runNode }) => {
    await typecheck();
    await runNode("consumer.ts");
    await runNode("quality-preparation.ts");
  },
);
