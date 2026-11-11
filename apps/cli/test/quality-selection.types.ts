import * as z from "zod";

import {
  analyzeQuality,
  defineChecker,
  defineConfig,
  type JsonValue,
} from "../src/index.ts";

const sourceSchema = z.object({
  source: z.string(),
  context: z.object({ key: z.string() }),
});
type Unit = z.output<typeof sourceSchema>;
const inputSchema = z.object({ mode: z.literal("strict") });

const checker = defineChecker.withTypes<Unit, unknown, JsonValue>()({
  id: "sdk/custom-check",
  version: "1",
  inputSchema,
  prepare: () => ({
    status: "ready",
    input: { mode: "strict" as const },
  }),
  check(input) {
    const mode: "strict" = input.mode;
    void mode;
    // @ts-expect-error 检查器不会接收未经准备的框架上下文。
    void input.facts;
    return {
      status: "complete",
      diagnostics: [],
      issues: [],
      coverage: {
        selected: 1,
        evaluated: 1,
        notApplicable: 0,
        incomplete: 0,
        failed: 0,
      },
    };
  },
});
const checkerId: "sdk/custom-check" = checker.id;
void checkerId;

const config = defineConfig.withTypes<Unit, typeof sourceSchema>()({
  source: { schema: sourceSchema, read: () => ({ scopes: [] }) },
  keyOf: (unit) => unit.context.key,
  quality: {
    checks: [checker],
    groups: { daily: ["sdk/custom-check"] },
  },
});

function verifySelectionTypes() {
  void analyzeQuality(config, { groups: ["daily"] });
  void analyzeQuality(config, { checkIds: ["sdk/custom-check"] });

  // @ts-expect-error SDK 消费者获得相同的精确检查项 ID 联合类型。
  void analyzeQuality(config, { checkIds: ["sdk/custom-chek"] });
  // @ts-expect-error SDK consumers receive the configured group-name union.
  void analyzeQuality(config, { groups: ["nightly"] });
}
void verifySelectionTypes;
