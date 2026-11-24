import assert from "node:assert/strict";

export type JsonSchemaNode = boolean | Readonly<Record<string, unknown>>;

/** 校验安装后 CLI 返回的实际 JSON 载荷是否满足 `--schema=wire:structured` 导出的 Draft 2020-12 Schema。 */
export function assertMatchesJsonSchema(
  value: unknown,
  schema: JsonSchemaNode,
  rootSchema: Readonly<Record<string, unknown>>,
  location = "$",
): void {
  if (typeof schema === "boolean") {
    assert.equal(schema, true, `${location} 被布尔 schema 拒绝`);
    return;
  }
  if (typeof schema.$ref === "string") {
    const pointer = schema.$ref;
    assert.ok(
      pointer.startsWith("#/"),
      `${location} 遇到未支持的 $ref: ${pointer}`,
    );
    let target: unknown = rootSchema;
    for (const segment of pointer.slice(2).split("/")) {
      const key = segment.replace(/~1/gu, "/").replace(/~0/gu, "~");
      assert.ok(
        typeof target === "object" && target !== null && key in target,
        `${location} 无法解析 $ref: ${pointer}`,
      );
      target = (target as Readonly<Record<string, unknown>>)[key];
    }
    assertMatchesJsonSchema(
      value,
      target as JsonSchemaNode,
      rootSchema,
      location,
    );
    return;
  }
  if ("const" in schema) {
    assert.deepEqual(value, schema.const, `${location} 不匹配 const`);
  }
  if (Array.isArray(schema.enum)) {
    assert.ok(
      schema.enum.some((entry) => {
        try {
          assert.deepEqual(value, entry);
          return true;
        } catch {
          return false;
        }
      }),
      `${location} 不在 enum 允许值内: ${JSON.stringify(value)}`,
    );
  }
  if (Array.isArray(schema.anyOf)) {
    const matched = schema.anyOf.some((branch) => {
      try {
        assertMatchesJsonSchema(
          value,
          branch as JsonSchemaNode,
          rootSchema,
          location,
        );
        return true;
      } catch {
        return false;
      }
    });
    assert.ok(matched, `${location} 未满足 anyOf 任一分支`);
  }
  if (Array.isArray(schema.oneOf)) {
    let matches = 0;
    for (const branch of schema.oneOf) {
      try {
        assertMatchesJsonSchema(
          value,
          branch as JsonSchemaNode,
          rootSchema,
          location,
        );
        matches += 1;
      } catch {
        // 仅统计匹配分支数。
      }
    }
    assert.equal(matches, 1, `${location} 必须恰好匹配 oneOf 中的一个分支`);
  }
  if (Array.isArray(schema.allOf)) {
    for (const branch of schema.allOf) {
      assertMatchesJsonSchema(
        value,
        branch as JsonSchemaNode,
        rootSchema,
        location,
      );
    }
  }
  if (schema.type !== undefined) {
    const allowedTypes = Array.isArray(schema.type)
      ? schema.type
      : [schema.type];
    const actualType =
      value === null
        ? "null"
        : Array.isArray(value)
          ? "array"
          : typeof value === "number" && Number.isInteger(value)
            ? "integer"
            : typeof value;
    const typeMatches = allowedTypes.some(
      (expected) =>
        expected === actualType ||
        (expected === "number" && actualType === "integer"),
    );
    assert.ok(
      typeMatches,
      `${location} 类型应为 ${JSON.stringify(schema.type)}，实际为 ${actualType}`,
    );
  }
  if (Array.isArray(value) && schema.items !== undefined) {
    value.forEach((item, index) => {
      assertMatchesJsonSchema(
        item,
        schema.items as JsonSchemaNode,
        rootSchema,
        `${location}[${index}]`,
      );
    });
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as Readonly<Record<string, unknown>>;
    if (Array.isArray(schema.required)) {
      for (const requiredKey of schema.required) {
        assert.ok(
          typeof requiredKey === "string" && Object.hasOwn(record, requiredKey),
          `${location} 缺少必需字段 ${String(requiredKey)}`,
        );
      }
    }
    const properties =
      typeof schema.properties === "object" && schema.properties !== null
        ? (schema.properties as Readonly<Record<string, JsonSchemaNode>>)
        : {};
    for (const [key, propValue] of Object.entries(record)) {
      if (Object.hasOwn(properties, key)) {
        assertMatchesJsonSchema(
          propValue,
          properties[key]!,
          rootSchema,
          `${location}.${key}`,
        );
      } else if (schema.additionalProperties === false) {
        assert.fail(`${location} 包含未允许的额外字段 ${key}`);
      } else if (
        typeof schema.additionalProperties === "object" &&
        schema.additionalProperties !== null
      ) {
        assertMatchesJsonSchema(
          propValue,
          schema.additionalProperties as JsonSchemaNode,
          rootSchema,
          `${location}.${key}`,
        );
      }
    }
  }
}
