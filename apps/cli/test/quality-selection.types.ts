import * as z from "zod";

import {
  runQa,
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
  prepare: () => ({ mode: "strict" as const }),
  check(input) {
    const mode: "strict" = input.mode;
    void mode;
    // @ts-expect-error 检查器不会接收未经准备的框架上下文。
    void input.snapshot;
    return [];
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
  void runQa(config, { groups: ["daily"] });
  void runQa(config, { checkIds: ["sdk/custom-check"] });

  // @ts-expect-error SDK 消费者获得相同的精确检查项 ID 联合类型。
  void runQa(config, { checkIds: ["sdk/custom-chek"] });
  // @ts-expect-error SDK 消费者获得已配置的检查组名称联合类型。
  void runQa(config, { groups: ["nightly"] });
}
void verifySelectionTypes;
