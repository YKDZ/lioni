import { defineChecker, defineConfig } from "@boringparts/lioni";
import * as z from "zod";

import { baseConfig, type LocaleRecord, type Unit } from "./lioni.config.ts";

export default defineConfig({
  ...baseConfig,
  quality: {
    checks: [
      defineChecker.withTypes<Unit, LocaleRecord, string, never>()({
        id: "empty-check",
        version: "1",
        inputSchema: z.object({ key: z.string(), language: z.string() }),
        prepare: ({ association }) => ({
          key: association.sourceKey,
          language: association.language,
        }),
        check: () => [],
      }),
    ],
  },
});
