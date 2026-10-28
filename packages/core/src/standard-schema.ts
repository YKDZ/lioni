import type {
  StandardSchemaV1 as OfficialStandardSchemaV1,
  StandardTypedV1,
} from "@standard-schema/spec";

import { isRecord } from "./object-guards.ts";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

type OfficialValidation<TOutput> = ReturnType<
  OfficialStandardSchemaV1<unknown, TOutput>["~standard"]["validate"]
>;

/** 核心 schema 契约遵循官方类型，并继续接受现有消费者使用的 PromiseLike 校验器。 */
export type StandardSchemaV1<Input = unknown, Output = Input> = Omit<
  OfficialStandardSchemaV1<Input, Output>,
  "~standard"
> & {
  readonly "~standard": Omit<
    OfficialStandardSchemaV1<Input, Output>["~standard"],
    "validate"
  > & {
    readonly validate: (
      value: unknown,
      options?: OfficialStandardSchemaV1.Options,
    ) =>
      | OfficialValidation<Output>
      | PromiseLike<Awaited<OfficialValidation<Output>>>;
  };
};

export type StandardSchemaV1Issue = OfficialStandardSchemaV1.Issue;

export type StandardSchemaV1Result<Output> =
  OfficialStandardSchemaV1.Result<Output>;

export type StandardSchemaTypes<TSchema> = TSchema extends StandardTypedV1
  ? {
      readonly input: StandardTypedV1.InferInput<TSchema>;
      readonly output: StandardTypedV1.InferOutput<TSchema>;
    }
  : never;

export type IsSameType<TLeft, TRight> =
  (<TCandidate>() => TCandidate extends TLeft ? 1 : 2) extends <
    TCandidate,
  >() => TCandidate extends TRight ? 1 : 2
    ? (<TCandidate>() => TCandidate extends TRight ? 1 : 2) extends <
        TCandidate,
      >() => TCandidate extends TLeft ? 1 : 2
      ? true
      : false
    : false;

export type PreservingStandardSchema<TValue, TSchema> =
  StandardSchemaTypes<TSchema> extends {
    readonly input: infer TInput;
    readonly output: infer TOutput;
  }
    ? IsSameType<TInput, TOutput> extends true
      ? IsSameType<TOutput, TValue> extends true
        ? unknown
        : never
      : never
    : never;

export type StandardSchemaFailureKind =
  | "invalid-json"
  | "invalid-schema-result"
  | "schema-mismatch"
  | "schema-threw"
  | "input-mutated"
  | "output-changed";

export class StandardSchemaContractError extends TypeError {
  readonly valueDescription: string;
  readonly kind: StandardSchemaFailureKind;
  readonly issues: readonly StandardSchemaV1Issue[] | undefined;

  constructor(
    valueDescription: string,
    kind: StandardSchemaFailureKind,
    message: string,
    issues?: readonly StandardSchemaV1Issue[],
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "StandardSchemaContractError";
    this.valueDescription = valueDescription;
    this.kind = kind;
    this.issues = issues;
  }
}

export type StandardSchemaValidationOptions = {
  readonly requireJson?: boolean;
  readonly preserveValue?: boolean;
};

export async function validateWithStandardSchema<TInput, TOutput>(
  schema: StandardSchemaV1<TInput, TOutput>,
  value: unknown,
  valueDescription: string,
  options: StandardSchemaValidationOptions = {},
): Promise<TOutput> {
  const preserveValue = options.preserveValue === true;
  const requireJson = options.requireJson === true || preserveValue;
  const before = requireJson
    ? copyJsonValue(value, valueDescription)
    : undefined;

  let result: unknown;
  let validationError: unknown;
  try {
    result = await schema["~standard"].validate(value);
  } catch (error) {
    validationError = error;
  }

  if (preserveValue && !matchesJsonSnapshot(value, before, valueDescription))
    throw new StandardSchemaContractError(
      valueDescription,
      "input-mutated",
      `${valueDescription}的 Standard Schema 在验证时修改了输入值。`,
      undefined,
      validationError === undefined ? undefined : { cause: validationError },
    );
  if (validationError !== undefined)
    throw new StandardSchemaContractError(
      valueDescription,
      "schema-threw",
      `${valueDescription}的 Standard Schema 执行失败。`,
      undefined,
      { cause: validationError },
    );

  if (!isRecord(result))
    throw new StandardSchemaContractError(
      valueDescription,
      "invalid-schema-result",
      `${valueDescription}的 Standard Schema 返回了无效结果。`,
    );

  const issues = result.issues;
  if (issues !== undefined) {
    if (
      !Array.isArray(issues) ||
      issues.some(
        (issue) => !isRecord(issue) || typeof issue.message !== "string",
      )
    )
      throw new StandardSchemaContractError(
        valueDescription,
        "invalid-schema-result",
        `${valueDescription}的 Standard Schema 返回了无效问题列表。`,
      );
    throw new StandardSchemaContractError(
      valueDescription,
      "schema-mismatch",
      `${valueDescription}不符合 Standard Schema：${issues
        .map((issue) => formatIssue(issue as unknown as StandardSchemaV1Issue))
        .join("；")}`,
      issues as readonly StandardSchemaV1Issue[],
    );
  }

  if (!Object.hasOwn(result, "value"))
    throw new StandardSchemaContractError(
      valueDescription,
      "invalid-schema-result",
      `${valueDescription}的 Standard Schema 成功结果缺少 value。`,
    );

  const output = result.value;
  if (requireJson) copyJsonValue(output, `${valueDescription}的验证结果`);
  if (preserveValue && !sameJsonValue(output, before))
    throw new StandardSchemaContractError(
      valueDescription,
      "output-changed",
      `${valueDescription}的 Standard Schema 验证结果改动了领域值。`,
    );

  return output as TOutput;
}

export function assertJsonValue(
  value: unknown,
  valueDescription: string,
  options: { readonly omitUndefinedObjectProperties?: boolean } = {},
): asserts value is JsonValue {
  snapshotJsonValue(value, valueDescription, options);
}

export function snapshotJsonValue(
  value: unknown,
  valueDescription: string,
  options: { readonly omitUndefinedObjectProperties?: boolean } = {},
): JsonValue {
  return copyJsonValue(value, valueDescription, options);
}

function copyJsonValue(
  value: unknown,
  valueDescription: string,
  options: { readonly omitUndefinedObjectProperties?: boolean } = {},
): JsonValue {
  const active = new Set<object>();

  function visit(current: unknown, path: string): JsonValue {
    if (
      current === null ||
      typeof current === "string" ||
      typeof current === "boolean"
    )
      return current;
    if (
      typeof current === "number" &&
      Number.isFinite(current) &&
      !Object.is(current, -0)
    )
      return current;

    const location =
      path.length === 0 ? valueDescription : `${valueDescription}${path}`;
    if (typeof current !== "object") throw invalidJson(location);
    if (active.has(current)) throw invalidJson(location);
    active.add(current);
    try {
      if (Array.isArray(current)) {
        if (Object.getPrototypeOf(current) !== Array.prototype)
          throw invalidJson(location);
        const ownKeys = Reflect.ownKeys(current);
        if (ownKeys.some((key) => typeof key === "symbol"))
          throw invalidJson(location);
        const result: JsonValue[] = [];
        for (let index = 0; index < current.length; index += 1) {
          if (!Object.hasOwn(current, index)) throw invalidJson(location);
          const descriptor = Object.getOwnPropertyDescriptor(
            current,
            String(index),
          );
          if (
            descriptor === undefined ||
            !descriptor.enumerable ||
            !Object.hasOwn(descriptor, "value")
          )
            throw invalidJson(location);
          result.push(visit(descriptor.value, `${path}[${index}]`));
        }
        if (
          ownKeys.some(
            (key) =>
              key !== "length" &&
              (typeof key !== "string" ||
                !isArrayIndexKey(key, current.length)),
          )
        )
          throw invalidJson(location);
        return result;
      }

      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null)
        throw invalidJson(location);
      const keys = Reflect.ownKeys(current);
      if (keys.some((key) => typeof key === "symbol"))
        throw invalidJson(location);
      const result: Record<string, JsonValue> = {};
      for (const key of keys) {
        if (typeof key !== "string") throw invalidJson(location);
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (
          descriptor === undefined ||
          !descriptor.enumerable ||
          !Object.hasOwn(descriptor, "value")
        )
          throw invalidJson(`${location}.${key}`);
        if (
          options.omitUndefinedObjectProperties === true &&
          descriptor.value === undefined
        )
          continue;
        Object.defineProperty(result, key, {
          configurable: true,
          enumerable: true,
          value: visit(descriptor.value, `${path}.${key}`),
          writable: true,
        });
      }
      return result;
    } catch (error) {
      if (error instanceof StandardSchemaContractError) throw error;
      throw invalidJson(location, error);
    } finally {
      active.delete(current);
    }
  }

  return visit(value, "");
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  if (left === null || right === null) return left === right;
  if (typeof left !== typeof right) return false;
  if (typeof left !== "object" || typeof right !== "object")
    return Object.is(left, right);
  if (Array.isArray(left) || Array.isArray(right)) {
    if (
      !Array.isArray(left) ||
      !Array.isArray(right) ||
      left.length !== right.length
    )
      return false;
    for (let index = 0; index < left.length; index += 1) {
      if (
        !Object.hasOwn(left, index) ||
        !Object.hasOwn(right, index) ||
        !sameJsonValue(left[index], right[index])
      )
        return false;
    }
    const leftKeys = Reflect.ownKeys(left).filter((key) => key !== "length");
    const rightKeys = Reflect.ownKeys(right).filter((key) => key !== "length");
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every((key) => rightKeys.includes(key))
    );
  }

  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) =>
        Object.hasOwn(right, key) &&
        sameJsonValue(
          (left as Record<string, unknown>)[key],
          (right as Record<string, unknown>)[key],
        ),
    )
  );
}

function matchesJsonSnapshot(
  value: unknown,
  snapshot: unknown,
  valueDescription: string,
): boolean {
  try {
    copyJsonValue(value, valueDescription);
  } catch {
    return false;
  }
  return sameJsonValue(value, snapshot);
}

function invalidJson(
  valueDescription: string,
  cause?: unknown,
): StandardSchemaContractError {
  return new StandardSchemaContractError(
    valueDescription,
    "invalid-json",
    `${valueDescription}必须是可无损保存的 JSON 数据。`,
    undefined,
    cause === undefined ? undefined : { cause },
  );
}

function isArrayIndexKey(key: string, length: number): boolean {
  const index = Number(key);
  return (
    Number.isInteger(index) &&
    index >= 0 &&
    index < length &&
    String(index) === key
  );
}

export function isStandardSchema(value: unknown): value is StandardSchemaV1 {
  if (!isRecord(value) || !isRecord(value["~standard"])) return false;
  const standard = value["~standard"];
  return (
    standard.version === 1 &&
    typeof standard.vendor === "string" &&
    typeof standard.validate === "function"
  );
}

function formatIssue(issue: StandardSchemaV1Issue): string {
  if (issue.path === undefined || issue.path.length === 0) return issue.message;
  const path = issue.path
    .map((segment) =>
      typeof segment === "object" && segment !== null && "key" in segment
        ? String(segment.key)
        : String(segment),
    )
    .join(".");
  return `${path}：${issue.message}`;
}
