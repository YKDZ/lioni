import { defineConfig } from "@lioni/core";

import qaConfig from "./qa.config.ts";

export default defineConfig({
  ...qaConfig,
  source: {
    ...qaConfig.source,
    read() {
      throw new Error("报告转例外命令不应读取当前原文。");
    },
  },
});
