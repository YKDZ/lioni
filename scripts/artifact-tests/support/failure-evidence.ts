import { testArtifactConsumer } from "./consumer.ts";

testArtifactConsumer(
  {
    name: "设施验收：制品缺失时记录失败",
    packages: ["@lioni/memo"],
  },
  async () => {
    throw new Error("此受控场景应在安装前失败。");
  },
);
