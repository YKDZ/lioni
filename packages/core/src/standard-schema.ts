export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type StandardSchemaV1Issue = {
  readonly message: string;
  readonly path?:
    | readonly (PropertyKey | { readonly key: PropertyKey })[]
    | undefined;
};

export type StandardSchemaV1Result<TOutput> =
  | { readonly value: TOutput; readonly issues?: undefined }
  | {
      readonly issues: readonly StandardSchemaV1Issue[];
      readonly value?: never;
    };

export type StandardSchemaV1<Input = unknown, Output = Input> = {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly types?:
      | {
          readonly input: Input;
          readonly output: Output;
        }
      | undefined;
    readonly validate: (
      value: unknown,
    ) =>
      | StandardSchemaV1Result<Output>
      | PromiseLike<StandardSchemaV1Result<Output>>;
  };
};

export type StandardSchemaTypes<TSchema> = TSchema extends {
  readonly "~standard": {
    readonly types?: infer TTypes;
  };
}
  ? NonNullable<TTypes>
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
): asserts value is JsonValue {
  snapshotJsonValue(value, valueDescription);
}

export function snapshotJsonValue(
  value: unknown,
  valueDescription: string,
): JsonValue {
  return copyJsonValue(value, valueDescription);
}

function copyJsonValue(value: unknown, valueDescription: string): JsonValue {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
