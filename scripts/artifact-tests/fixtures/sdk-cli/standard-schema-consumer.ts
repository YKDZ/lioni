import assert from "node:assert/strict";

import { defineConfig, readFacts, type StandardSchemaV1 } from "@lioni/lioni";

type Unit = { source: string; context: { file: string } };
// 专门验证非 Zod、异步的标准协议接入；普通业务夹具由其宿主选择 Zod。
const sourceSchema: StandardSchemaV1<Unit> = {
  "~standard": {
    version: 1,
    vendor: "consumer-protocol",
    async validate(value) {
      if (
        typeof value === "object" &&
        value !== null &&
        "source" in value &&
        typeof value.source === "string" &&
        "context" in value &&
        typeof value.context === "object" &&
        value.context !== null &&
        "file" in value.context &&
        typeof value.context.file === "string"
      )
        return { value: value as Unit };
      return { issues: [{ path: ["source"], message: "原文单元格式无效。" }] };
    },
  },
};
const input = { source: "Save", context: { file: "messages.ts" } };
const config = defineConfig({
  source: {
    schema: sourceSchema,
    read: () => ({
      scopes: [
        {
          range: "source",
          enumeration: "complete",
          records: [{ value: input, bodyAvailability: "available" }],
        },
      ],
    }),
  },
  keyOf: ({ source }) => source,
});
const facts = await readFacts(config);
assert.deepEqual(facts.source.units[0]?.unit, input);
