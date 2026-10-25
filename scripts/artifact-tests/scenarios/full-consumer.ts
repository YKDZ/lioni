import { testArtifactConsumer } from "../support/consumer.ts";
import type { ConsumerScenario } from "../support/consumer.ts";

const packages = [
  "@lioni/cli",
  "@lioni/checks",
  "@lioni/core",
  "@lioni/memo",
  "@lioni/terminology",
  "@lioni/text-analysis",
];
export function testFullConsumer(
  name: string,
  execute: ConsumerScenario,
): void {
  testArtifactConsumer(
    {
      name,
      packages,
      fixtures: new URL("../fixtures/full-consumer/", import.meta.url),
    },
    execute,
  );
}
