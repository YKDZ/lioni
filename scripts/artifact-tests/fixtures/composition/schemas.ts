import type { StandardSchemaV1, StandardSchemaV1Result } from "@lioni/core";

export function standardSchema<T>(
  isValue: (value: unknown) => value is T,
): StandardSchemaV1<T, T> {
  return {
    "~standard": {
      version: 1,
      vendor: "lioni-composition-consumer",
      validate(value): StandardSchemaV1Result<T> {
        if (isValue(value)) return { value };
        return { issues: [{ message: "组合消费者数据结构不匹配。" }] };
      },
    },
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
