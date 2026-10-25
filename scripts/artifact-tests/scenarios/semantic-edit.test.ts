import { testFullConsumer } from "./full-consumer.ts";

testFullConsumer(
  "跨进程语义编辑、冲突与条件写回",
  async ({ runNode, typecheck }) => {
    await typecheck();
    await runNode("edit-check.ts");
  },
);
