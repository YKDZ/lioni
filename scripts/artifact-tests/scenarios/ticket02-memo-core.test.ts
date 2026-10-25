import { testArtifactConsumer } from "../support/consumer.ts";

testArtifactConsumer(
  {
    name: "票 02：memo 独立制品消费",
    packages: ["@lioni/memo"],
    fixtures: new URL("../fixtures/ticket02-memo/", import.meta.url),
  },
  async ({ typecheck, runNode }) => {
    await typecheck();
    await runNode("memo-consumer.ts");
  },
);

testArtifactConsumer(
  {
    name: "票 02：core QA 与独立 memo 依赖",
    packages: ["@lioni/core", "@lioni/memo"],
    fixtures: new URL("../fixtures/ticket02-core/", import.meta.url),
  },
  async ({ typecheck, runNode }) => {
    await typecheck();
    await runNode("core-consumer.ts");
  },
);
