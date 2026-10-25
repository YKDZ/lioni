import { testFullConsumer } from "./full-consumer.ts";

testFullConsumer(
  "完成度与无 QA 依赖的 CLI 正式制品消费者",
  async ({ runNode, typecheck }) => {
    await typecheck();
    await runNode("completion-check.ts");
  },
);
