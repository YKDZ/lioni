import { defineConfig } from "@lioni/core";

import { isRecord, standardSchema } from "./schemas.ts";

type Unit = {
  readonly source: string;
  readonly context: { readonly file: string };
};
const sourceSchema = standardSchema<Unit>(
  (value): value is Unit =>
    isRecord(value) &&
    typeof value.source === "string" &&
    isRecord(value.context) &&
    typeof value.context.file === "string",
);

export default defineConfig({
  source: {
    schema: sourceSchema,
    read: () => ({
      scopes: [
        {
          range: "src/messages.ts",
          enumeration: "complete",
          records: [
            {
              value: { source: "Save", context: { file: "src/messages.ts" } },
              bodyAvailability: "available",
            },
            {
              value: { source: "Submit", context: { file: "src/messages.ts" } },
              bodyAvailability: "available",
            },
          ],
        },
      ],
    }),
  },
  keyOf(unit) {
    return unit.context.file;
  },
});
