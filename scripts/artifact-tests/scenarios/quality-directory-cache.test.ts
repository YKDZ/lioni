import { testArtifactConsumer } from "../support/consumer.ts";

testArtifactConsumer(
  {
    name: "正式 tarball 的目录缓存规模与文件成本",
    fixtures: new URL("../fixtures/directory-cache/", import.meta.url),
  },
  async ({ typecheck, runNode }) => {
    await typecheck();
    await runNode("scale.ts");
  },
);
