import { testArtifactConsumer } from "../support/consumer.ts";

testArtifactConsumer(
  {
    name: "票 04：术语包独立制品消费",
    packages: ["@lioni/memo", "@lioni/text-analysis", "@lioni/terminology"],
    fixtures: new URL("../fixtures/ticket04-05-terminology/", import.meta.url),
  },
  async ({ typecheck, runNode }) => {
    await typecheck();
    await runNode("terminology-consumer.ts");
  },
);

testArtifactConsumer(
  {
    name: "票 05：完整术语 QA 制品消费",
    packages: [
      "@lioni/core",
      "@lioni/memo",
      "@lioni/text-analysis",
      "@lioni/terminology",
      "@lioni/checks",
    ],
    fixtures: new URL("../fixtures/ticket04-05-qa/", import.meta.url),
  },
  async ({ typecheck, runNode }) => {
    await typecheck();
    await runNode("qa-consumer.ts");
  },
);
