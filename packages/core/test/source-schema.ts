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

export function fixtureTranslationIdentity(value: unknown): {
  readonly namespace: string;
  readonly key: string;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new TypeError("测试译文必须提供稳定的 fixture 身份字段。");
  const record = value as Record<string, unknown>;
  const context =
    typeof record.context === "object" &&
    record.context !== null &&
    !Array.isArray(record.context)
      ? (record.context as Record<string, unknown>)
      : undefined;
  // 测试身份只从译文自身的目标键字段读取，不借用原文关联或物理定位。
  const identityValue =
    record.targetId ??
    record.targetKey ??
    record.id ??
    record.key ??
    context?.targetId ??
    context?.targetKey ??
    context?.id ??
    context?.key;
  if (
    (typeof identityValue !== "string" &&
      typeof identityValue !== "number" &&
      !Array.isArray(identityValue)) ||
    (typeof identityValue === "string" && identityValue.length === 0)
  )
    throw new TypeError("测试译文必须提供稳定的 fixture 身份字段。");
  const namespaceValue = record.namespace ?? context?.namespace ?? "fixture";
  if (typeof namespaceValue !== "string" || namespaceValue.length === 0)
    throw new TypeError("测试译文 fixture 身份空间必须是非空字符串。");
  return {
    namespace: namespaceValue,
    key:
      typeof identityValue === "string"
        ? identityValue
        : JSON.stringify(identityValue),
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
