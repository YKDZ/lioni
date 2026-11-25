import {
  createMissingTranslationChecker,
  createSameTextChecker,
  defineConfig,
} from "@boringparts/lioni";
import * as z from "zod";

import {
  baseConfig,
  readDictionary,
  type LocaleRecord,
  type Unit,
} from "./lioni.config.ts";

const unavailableTranslationSchema = z.object({
  key: z.string(),
  reason: z.string(),
});
type UnavailableRecord = z.infer<typeof unavailableTranslationSchema>;

export default defineConfig({
  ...baseConfig,
  translations: {
    ...baseConfig.translations,
    unavailableSchema: unavailableTranslationSchema,
    keyOf: ({ key }) => key,
    async read(language: string, units: readonly { readonly key: string }[]) {
      const range = `${language}.json`;
      const entries = Object.entries(await readDictionary(range));
      return {
        scopes: [
          {
            range,
            enumeration: "complete" as const,
            covers: units.map(({ key }) => key),
            records: [
              ...entries.map(([key, text]) => ({
                value: { key, text },
                bodyAvailability: "available" as const,
              })),
              {
                value: { key: "button", reason: "unreadable" },
                bodyAvailability: "unavailable" as const,
              },
            ],
          },
        ],
      };
    },
  },
  quality: {
    checks: [
      createMissingTranslationChecker<
        Unit,
        LocaleRecord,
        string,
        UnavailableRecord
      >(),
      createSameTextChecker<Unit, LocaleRecord, string, UnavailableRecord>(),
    ],
  },
});
