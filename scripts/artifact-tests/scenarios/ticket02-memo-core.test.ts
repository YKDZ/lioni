import { testArtifactConsumer } from "../support/consumer.ts";

testArtifactConsumer(
  {
    name: "ticket02 memo standalone package",
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
    name: "ticket02 core QA with its memo dependency",
    packages: ["@lioni/core", "@lioni/memo"],
    fixtures: new URL("../fixtures/ticket02-core/", import.meta.url),
  },
  async ({ typecheck, runNode }) => {
    await typecheck();
    await runNode("core-consumer.ts");
  },
);
