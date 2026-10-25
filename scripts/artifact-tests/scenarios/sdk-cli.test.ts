import { testFullConsumer } from "./full-consumer.ts";

testFullConsumer(
  "SDK、CLI 与 QA 正式制品消费者",
  async ({ runNode, typecheck }) => {
    await typecheck();
    await runNode("consumer-check.ts");
  },
);
