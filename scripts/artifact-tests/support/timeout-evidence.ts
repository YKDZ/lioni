import { testArtifactConsumer } from "./consumer.ts";

testArtifactConsumer(
  {
    name: "设施验收：子进程超时记为失败",
    packages: [],
    timeoutMs: 2_000,
  },
  async ({ runCommand }) => {
    await runCommand(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      40,
    );
  },
);
