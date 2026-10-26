import { testArtifactConsumer } from "../support/consumer.ts";

testArtifactConsumer(
  {
    name: "票 02：YAML 术语加载器正式制品消费",
    packages: ["@lioni/memo", "@lioni/text-analysis", "@lioni/terminology"],
    fixtures: new URL("../fixtures/ticket02-termbase/", import.meta.url),
  },
  async ({ typecheck, runNode }) => {
    await typecheck();
    await runNode("consumer.ts");
  },
);
