/** 键函数只描述计算的实际依赖，不读取或修改外部可变状态。 */
export type MemoOptions<TArguments extends readonly unknown[]> = {
  readonly key?: (...args: TArguments) => readonly unknown[];
};

export type MemoScope = {
  /** 同一函数与键函数共享缓存；返回值及失败保持原样。 */
  readonly memo: <TArguments extends readonly unknown[], TResult>(
    operation: (...args: TArguments) => TResult,
    options?: MemoOptions<TArguments>,
  ) => (...args: TArguments) => TResult;
  /** 释放缓存；不取消已经返回的 Promise。 */
  readonly dispose: () => void;
};

export class MemoScopeClosedError extends Error {
  constructor() {
    super("计算复用范围已经结束，不能继续计算。");
    this.name = "MemoScopeClosedError";
  }
}

type Entry =
  | { readonly kind: "value"; readonly value: unknown }
  | { readonly kind: "failure"; readonly error: unknown };

type Node = {
  readonly children: Map<unknown, Node>;
  entry?: Entry;
};

type Computation = {
  readonly root: Node;
  readonly invoke: unknown;
};

const negativeZero = Symbol("负零键");
const argumentKeys = (...args: readonly unknown[]): readonly unknown[] => args;

function createNode(): Node {
  return { children: new Map() };
}

/**
 * 创建一个显式拥有的计算复用范围。
 * 参数按 Object.is 比较，对象按身份；输入、策略和复用结果须保持不可变。
 * 同步异常和拒绝的 Promise 也保留到范围结束，不隐式重试。
 */
export function createMemoScope(): MemoScope {
  const operations = new Map<object, Map<object, Computation>>();
  let closed = false;

  function ensureOpen(): void {
    if (closed) throw new MemoScopeClosedError();
  }

  function memo<TArguments extends readonly unknown[], TResult>(
    operation: (...args: TArguments) => TResult,
    options: MemoOptions<TArguments> = {},
  ): (...args: TArguments) => TResult {
    ensureOpen();
    const keyOf = options.key ?? argumentKeys;
    let policies = operations.get(operation);
    if (policies === undefined) {
      policies = new Map();
      operations.set(operation, policies);
    }
    const existing = policies.get(keyOf);
    if (existing !== undefined)
      return existing.invoke as (...args: TArguments) => TResult;

    const root = createNode();
    const invoke = (...args: TArguments): TResult => {
      ensureOpen();
      const keys = keyOf(...args);
      if (!Array.isArray(keys))
        throw new TypeError("计算缓存的键函数必须返回参数元组。");
      let node = root;
      for (const value of keys) {
        const key = Object.is(value, -0) ? negativeZero : value;
        let child = node.children.get(key);
        if (child === undefined) {
          child = createNode();
          node.children.set(key, child);
        }
        node = child;
      }
      const entry = node.entry;
      if (entry?.kind === "value") return entry.value as TResult;
      if (entry?.kind === "failure") throw entry.error;

      try {
        const value = operation(...args);
        if (!closed) node.entry = { kind: "value", value };
        return value;
      } catch (error) {
        if (!closed) node.entry = { kind: "failure", error };
        throw error;
      }
    };
    policies.set(keyOf, { root, invoke });
    return invoke;
  }

  return {
    memo,
    dispose: () => {
      if (closed) return;
      closed = true;
      for (const policies of operations.values())
        for (const { root } of policies.values()) {
          root.children.clear();
          delete root.entry;
        }
      operations.clear();
    },
  };
}
