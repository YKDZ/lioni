import { assertJsonValue, type JsonValue } from "./standard-schema.ts";

export function stableStringify(value: unknown): string {
  assertJsonValue(value, "稳定 JSON 值");
  const serialized = JSON.stringify(sortJsonKeys(value as JsonValue), null, 2);
  if (serialized === undefined) throw new TypeError("值必须可序列化为 JSON。");
  return serialized;
}

function sortJsonKeys(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortJsonKeys);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => [key, sortJsonKeys(item)]),
  );
}
