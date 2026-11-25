import {
  createMissingTranslationChecker,
  createSameTextChecker,
  defineConfig,
} from "@boringparts/lioni";

import { baseConfig, type LocaleRecord, type Unit } from "./lioni.config.ts";

export default defineConfig({
  ...baseConfig,
  translations: {
    ...baseConfig.translations,
    languages: ["fr", "de"],
  },
  quality: {
    checks: [
      createMissingTranslationChecker<Unit, LocaleRecord, string>(),
      createSameTextChecker<Unit, LocaleRecord, string>(),
    ],
  },
});
