import { testArtifactConsumer } from "../support/consumer.ts";

testArtifactConsumer(
  {
    name: "既有术语消费者与独立发现正式制品验收",
    packages: ["@lioni/memo", "@lioni/text-analysis", "@lioni/terminology"],
    fixtures: new URL("../fixtures/terminology/", import.meta.url),
  },
  async ({ typecheck, runNode }) => {
    await typecheck();
    await runNode("consumer.ts");
  },
);
