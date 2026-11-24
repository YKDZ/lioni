import { readFile, writeFile } from "node:fs/promises";

import {
  createMissingTranslationChecker,
  createSameTextChecker,
  defineConfig,
} from "@lioni/lioni";
import * as z from "zod";

const dictionary = z.record(z.string(), z.string());
const unitSchema = z.object({ key: z.string(), source: z.string() });
const translationSchema = z.object({ key: z.string(), text: z.string() });
type Unit = z.infer<typeof unitSchema>;
type LocaleRecord = z.infer<typeof translationSchema>;

async function readDictionary(name: string) {
  return dictionary.parse(
    JSON.parse(await readFile(new URL(name, import.meta.url), "utf8")),
  );
}

export default defineConfig({
  source: {
    schema: unitSchema,
    async read() {
      const entries = Object.entries(await readDictionary("source.json"));
      return {
        scopes: [
          {
            range: "source.json",
            enumeration: "complete",
            records: entries.map(([key, source]) => ({
              value: { key, source },
              bodyAvailability: "available" as const,
            })),
          },
        ],
      };
    },
  },
  keyOf: ({ key }) => key,
  translations: {
    languages: ["fr"],
    schema: translationSchema,
    contentSchema: z.string(),
    keyOf: ({ key }) => key,
    contentOf: ({ text }) => text,
    async read(language, units) {
      const range = `${language}.json`;
      const entries = Object.entries(await readDictionary(range));
      return {
        scopes: [
          {
            range,
            enumeration: "complete",
            covers: units.map(({ key }) => key),
            records: entries.map(([key, text]) => ({
              value: { key, text },
              bodyAvailability: "available" as const,
            })),
          },
        ],
      };
    },
  },
  translationWriteback: {
    locateNewTarget: ({ sourceKey }) => ({
      status: "located",
      locator: sourceKey,
    }),
    locateExistingTarget: ({ identity }) => ({
      status: "located",
      locator: identity.key,
    }),
    async write({ request, target }) {
      if (typeof target.locator !== "string") throw new Error("译文键不可用。");
      const messages = await readDictionary("fr.json");
      if (request.operation === "delete") delete messages[target.locator];
      else messages[target.locator] = request.content;
      await writeFile(new URL("fr.json", import.meta.url), JSON.stringify(messages));
    },
  },
  quality: {
    checks: [
      createMissingTranslationChecker<Unit, LocaleRecord, string>(),
      createSameTextChecker<Unit, LocaleRecord, string>(),
    ],
  },
});
