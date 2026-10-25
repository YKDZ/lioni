import type { StandardSchemaV1, StandardSchemaV1Result } from "@lioni/core";

export function parseJson<T>(text: string): T {
  return JSON.parse(text) as T;
}

export function standardSchema<T>(
  isValue: (value: unknown) => value is T,
): StandardSchemaV1<T, T> {
  return {
    "~standard": {
      version: 1,
      vendor: "lioni-independent-consumer",
      validate(value): StandardSchemaV1Result<T> {
        if (isValue(value)) return { value };
        return { issues: [{ message: "独立消费者数据结构不匹配。" }] };
      },
    },
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isNumberArray(value: unknown): value is readonly number[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "number")
  );
}
