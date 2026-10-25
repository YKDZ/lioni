import { mkdir } from "node:fs/promises";
import path from "node:path";

import { testFullConsumer } from "./full-consumer.ts";

testFullConsumer(
  "跨进程语义编辑、冲突与条件写回",
  async ({ root, runNode, typecheck }) => {
    await typecheck();
    await mkdir(path.join(root, ".lioni"), { recursive: true });
    await runNode("edit-check.ts");
  },
);
