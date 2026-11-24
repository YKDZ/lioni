import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { defineConfig, readSourceSnapshot } from "@lioni/core";
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
  void it("原文快照保留宿主通过 Zod 声明的字段", async () => {
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
    const snapshot = await readSourceSnapshot(config);

    assert.equal(snapshot.units[0]?.key, "messages.ts:18");
    assert.deepStrictEqual(snapshot.units[0]?.unit, {
      source: "Save",
      context: { file: "messages.ts", line: 18 },
    });
  });
});
