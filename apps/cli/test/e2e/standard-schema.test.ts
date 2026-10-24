import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { defineConfig, readSourceFacts } from "@lioni/core";
import * as v from "valibot";

const transformedSourceSchema = v.pipe(
  v.object({ source: v.string() }),
  v.transform(({ source }) => ({ source: source.length })),
);
defineConfig({
  source: {
    // @ts-expect-error 原文 schema 不得在输入和输出间转换领域值。
    schema: transformedSourceSchema,
    read: () => ({ scopes: [] }),
  },
  keyOf: (unit) => String(unit.source),
});

void describe("Standard Schema source contract", () => {
  void it("accepts a Valibot schema through the public facts workflow", async () => {
    const config = defineConfig({
      source: {
        schema: v.object({
          source: v.string(),
          context: v.object({ file: v.string(), line: v.number() }),
        }),
        read: () => ({
          scopes: [
            {
              range: "messages.ts",
              enumeration: "complete" as const,
              records: [
                {
                  value: {
                    source: "Save",
                    context: { file: "messages.ts", line: 18 },
                  },
                  bodyAvailability: "available" as const,
                },
              ],
            },
          ],
        }),
      },
      keyOf: (unit) => `${unit.context.file}:${unit.context.line}`,
    });
    const facts = await readSourceFacts(config);

    assert.equal(facts.units[0]?.key, "messages.ts:18");
    assert.deepStrictEqual(facts.units[0]?.unit, {
      source: "Save",
      context: { file: "messages.ts", line: 18 },
    });
  });
});
