import type { StandardSchemaV1, TranslationUnitInput } from "../src/index.ts";
import type { JsonValue } from "../src/semantic-edits.ts";

export function sourceSchemaFromExamples<TUnit extends TranslationUnitInput>(
  ...examples: TUnit[]
): StandardSchemaV1<TUnit, TUnit> {
  return schemaFromExamples(...examples);
}

export function schemaFromExamples<TValue>(
  ...examples: TValue[]
): StandardSchemaV1<TValue, TValue> {
  return {
    "~standard": {
      version: 1,
      vendor: "lioni-test-fixture",
      validate(value) {
        return matchesOneExample(value, examples)
          ? { value }
          : { issues: [{ message: "测试样例结构不匹配。" }] };
      },
    },
  };
}

export const jsonValueSchema: StandardSchemaV1<JsonValue, JsonValue> = {
  "~standard": {
    version: 1,
    vendor: "lioni-test-json",
    validate(value) {
      return isJsonValue(value)
        ? { value }
        : { issues: [{ message: "测试值必须符合 JSON 数据契约。" }] };
    },
  },
};

export const emptySourceSchema: StandardSchemaV1<
  TranslationUnitInput,
  TranslationUnitInput
> = {
  "~standard": {
    version: 1,
    vendor: "lioni-test-fixture",
    validate(value) {
      return isTranslationUnitShape(value)
        ? { value }
        : { issues: [{ message: "原文单元结构不匹配。" }] };
    },
  },
};

function matchesOneExample<TUnit>(
  value: unknown,
  examples: readonly TUnit[],
): value is TUnit {
  return examples.some((example) => matchesShape(value, example));
}

function matchesShape(value: unknown, example: unknown): boolean {
  if (example === null || typeof example !== "object")
    return (
      Object.is(typeof example, typeof value) &&
      (example === null ? value === null : true)
    );
  if (Array.isArray(example))
    return (
      Array.isArray(value) &&
      value.every((entry) =>
        example.length === 0
          ? isJsonShape(entry)
          : example.some((candidate) => matchesShape(entry, candidate)),
      )
    );
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;

  return Object.entries(example).every(([key, childExample]) =>
    Object.hasOwn(value, key)
      ? matchesShape((value as Record<string, unknown>)[key], childExample)
      : childExample === undefined,
  );
}

function isTranslationUnitShape(value: unknown): value is TranslationUnitInput {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const unit = value as Record<string, unknown>;
  return (
    Object.hasOwn(unit, "source") &&
    isJsonShape(unit.source) &&
    (unit.context === undefined || isJsonShape(unit.context))
  );
}

function isJsonShape(value: unknown, active = new Set<object>()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || active.has(value)) return false;
  active.add(value);
  const valid = Array.isArray(value)
    ? value.every((entry) => isJsonShape(entry, active))
    : Object.values(value).every((entry) => isJsonShape(entry, active));
  active.delete(value);
  return valid;
}

function isJsonValue(
  value: unknown,
  active = new Set<object>(),
): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || active.has(value)) return false;
  if (!Array.isArray(value)) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
  }
  active.add(value);
  const valid = Array.isArray(value)
    ? value.every((entry) => isJsonValue(entry, active))
    : Object.values(value).every((entry) => isJsonValue(entry, active));
  active.delete(value);
  return valid;
}
