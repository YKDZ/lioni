import { testArtifactConsumer } from "../support/consumer.ts";

testArtifactConsumer(
  {
    name: "ticket09 independent terminology discovery packages",
    packages: ["@lioni/memo", "@lioni/text-analysis", "@lioni/terminology"],
    fixtures: new URL("../fixtures/ticket09-discovery/", import.meta.url),
  },
  async ({ typecheck, runNode }) => {
    await typecheck();
    await runNode("discovery-consumer.ts");
  },
);
