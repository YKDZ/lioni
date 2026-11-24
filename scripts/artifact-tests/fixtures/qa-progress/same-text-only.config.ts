import { createSameTextChecker, defineConfig } from "@lioni/lioni";

import { baseConfig, type LocaleRecord, type Unit } from "./lioni.config.ts";

export default defineConfig({
  ...baseConfig,
  quality: {
    checks: [createSameTextChecker<Unit, LocaleRecord, string>()],
  },
});
