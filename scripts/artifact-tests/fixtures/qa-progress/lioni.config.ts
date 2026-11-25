import { readFile, writeFile } from "node:fs/promises";

import {
  createMissingTranslationChecker,
  createSameTextChecker,
  defineConfig,
} from "@boringparts/lioni";
import * as z from "zod";

const dictionary = z.record(z.string(), z.string());
export const unitSchema = z.object({ key: z.string(), source: z.string() });
export const translationSchema = z.object({
  key: z.string(),
  text: z.string(),
});
export type Unit = z.infer<typeof unitSchema>;
export type LocaleRecord = z.infer<typeof translationSchema>;

export async function readDictionary(name: string) {
  return dictionary.parse(
    JSON.parse(await readFile(new URL(name, import.meta.url), "utf8")),
  );
}

export const baseConfig = {
  source: {
    schema: unitSchema,
    async read() {
      const entries = Object.entries(await readDictionary("source.json"));
      return {
        scopes: [
          {
            range: "source.json",
            enumeration: "complete" as const,
            records: entries.map(([key, source]) => ({
              value: { key, source },
              bodyAvailability: "available" as const,
            })),
          },
        ],
      };
    },
  },
  keyOf: ({ key }: Unit) => key,
  translations: {
    languages: ["fr"] as const,
    schema: translationSchema,
    contentSchema: z.string(),
    keyOf: ({ key }: LocaleRecord) => key,
    contentOf: ({ text }: LocaleRecord) => text,
    async read(language: string, units: readonly { readonly key: string }[]) {
      const range = `${language}.json`;
      const entries = Object.entries(await readDictionary(range));
      return {
        scopes: [
          {
            range,
            enumeration: "complete" as const,
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
    locateNewTarget: ({ sourceKey }: { readonly sourceKey: string }) => ({
      status: "located" as const,
      locator: sourceKey,
    }),
    locateExistingTarget: ({
      identity,
    }: {
      readonly identity: { readonly key: string };
    }) => ({
      status: "located" as const,
      locator: identity.key,
    }),
    async write({
      request,
      target,
    }: {
      readonly request:
        | { readonly operation: "write"; readonly content: string }
        | { readonly operation: "delete" };
      readonly target: { readonly locator: unknown };
    }) {
      if (typeof target.locator !== "string") throw new Error("译文键不可用。");
      const messages = await readDictionary("fr.json");
      if (request.operation === "delete") delete messages[target.locator];
      else messages[target.locator] = request.content;
      await writeFile(
        new URL("fr.json", import.meta.url),
        JSON.stringify(messages),
      );
    },
  },
};

export default defineConfig({
  ...baseConfig,
  quality: {
    checks: [
      createMissingTranslationChecker<Unit, LocaleRecord, string>(),
      createSameTextChecker<Unit, LocaleRecord, string>(),
    ],
    groups: {
      missingOnly: ["missing-translation"],
      sameOnly: ["same-text"],
    },
  },
});
