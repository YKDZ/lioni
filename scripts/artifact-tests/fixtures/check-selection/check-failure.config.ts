import { defineChecker } from "@lioni/lioni";
import * as z from "zod";

import baseConfig from "./lioni.config.ts";

export default {
  ...baseConfig,
  quality: {
    checks: [
      defineChecker({
        id: "check-boom",
        version: "1",
        inputSchema: z.string(),
        prepare: ({ association }) => association.sourceKey,
        check() {
          throw new Error("执行阶段崩溃");
        },
      }),
    ],
  },
};
