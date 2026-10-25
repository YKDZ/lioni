import { testArtifactConsumer } from "../support/consumer.ts";

testArtifactConsumer(
  {
    name: "ticket04 independent terminology packages",
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
    name: "ticket05 full terminology QA packages",
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
