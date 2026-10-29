import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { defineConfig, readSourceFacts } from "@lioni/core";
import * as z from "zod";

const transformedSourceSchema = z
  .object({ source: z.string() })
  .transform(({ source }) => ({ source: source.length }));
defineConfig({
  source: {
    // @ts-expect-error 原文 schema 不得在输入和输出间转换领域值。
    schema: transformedSourceSchema,
    read: () => ({ scopes: [] }),
  },
  keyOf: (unit) => String(unit.source),
});

void describe("Standard Schema 原文契约", () => {
  void it("通过公开事实链路接入 Zod schema", async () => {
    const config = defineConfig({
      source: {
        schema: z.object({
          source: z.string(),
          context: z.object({ file: z.string(), line: z.number() }),
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
