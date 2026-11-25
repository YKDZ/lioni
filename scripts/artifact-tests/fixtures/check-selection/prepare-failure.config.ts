import { defineChecker } from "@boringparts/lioni";
import * as z from "zod";

import baseConfig from "./lioni.config.ts";

export default {
  ...baseConfig,
  quality: {
    checks: [
      defineChecker({
        id: "prepare-boom",
        version: "1",
        inputSchema: z.string(),
        prepare() {
          throw new Error("准备阶段缺材料");
        },
        check: () => [],
      }),
    ],
  },
};
