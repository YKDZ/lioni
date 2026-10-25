import { testArtifactConsumer } from "../support/consumer.ts";

testArtifactConsumer(
  {
    name: "票 09：术语候选发现独立制品消费",
    packages: ["@lioni/memo", "@lioni/text-analysis", "@lioni/terminology"],
    fixtures: new URL("../fixtures/ticket09-discovery/", import.meta.url),
  },
  async ({ typecheck, runNode }) => {
    await typecheck();
    await runNode("discovery-consumer.ts");
  },
);
