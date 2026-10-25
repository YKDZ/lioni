import path from "node:path";

import { testArtifactConsumer } from "./consumer.ts";

testArtifactConsumer(
  {
    name: "设施验收：node:test 超时中断子进程树",
    packages: [],
    timeoutMs: 200,
  },
  async ({ root, runCommand }) => {
    const marker = path.join(root, "node-test-timeout-child-stopped");
    const childSource = [
      `process.on("SIGTERM", () => { require("node:fs").writeFileSync(${JSON.stringify(marker)}, "stopped"); process.exit(0); });`,
      "setInterval(() => {}, 1000)",
    ].join(";");
    const parentSource = [
      `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(childSource)}], { stdio: "ignore" });`,
      "setInterval(() => {}, 1000)",
    ].join(";");
    await runCommand(process.execPath, ["-e", parentSource], 10_000);
  },
);
