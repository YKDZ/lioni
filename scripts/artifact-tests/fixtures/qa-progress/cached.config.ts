import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { defineChecker, defineConfig } from "@lioni/lioni";
import { createDirectoryQualityCheckResultCache } from "@lioni/lioni/node";
import * as z from "zod";

import { baseConfig, type LocaleRecord, type Unit } from "./lioni.config.ts";

const cacheDir = fileURLToPath(new URL(".qa-cache", import.meta.url));
const callLog = fileURLToPath(new URL(".cache-calls.log", import.meta.url));

export default defineConfig({
  ...baseConfig,
  quality: {
    resultCache: createDirectoryQualityCheckResultCache(cacheDir),
    checks: [
      defineChecker.withTypes<Unit, LocaleRecord, string, never>()({
        id: "cached-check",
        version: "1",
        inputSchema: z.object({ key: z.string(), language: z.string() }),
        prepare: ({ association }) => ({
          key: association.sourceKey,
          language: association.language,
        }),
        check(subject) {
          appendFileSync(callLog, `${subject.key}:${subject.language}\n`);
          return [];
        },
      }),
    ],
  },
});
