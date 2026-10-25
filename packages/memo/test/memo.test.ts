import assert from "node:assert/strict";
import { test } from "node:test";

import { createMemoScope, MemoScopeClosedError } from "../src/index.ts";

void test("同步结果按完整参数元组复用，参数数量与 Object.is 差异保留", () => {
  const scope = createMemoScope();
  let calls = 0;
  const operation = (...values: readonly unknown[]) => ({
    call: ++calls,
    values,
  });
  const compute = scope.memo(operation);
  assert.equal(scope.memo(operation), compute);
  assert.equal(compute("a", 1), compute("a", 1));
  assert.notEqual(compute("a"), compute("a", undefined));
  assert.notEqual(compute(0), compute(-0));
  assert.equal(compute(Number.NaN), compute(Number.NaN));
  const object = { text: "相同文本" };
  assert.equal(compute(object), compute(object));
  assert.notEqual(compute(object), compute({ ...object }));
  assert.equal(calls, 8);
  scope.dispose();
});

void test("undefined 和同步抛出的任意值均复用，新的范围重新计算", () => {
  let values = 0;
  let failures = 0;
  const empty = () => {
    values += 1;
    return undefined;
  };
  const reason = { message: "无法计算" };
  const fail = () => {
    failures += 1;
    throw reason;
  };
  const first = createMemoScope();
  assert.equal(first.memo(empty)(), undefined);
  assert.equal(first.memo(empty)(), undefined);
  assert.throws(first.memo(fail), (error) => error === reason);
  assert.throws(first.memo(fail), (error) => error === reason);
  assert.equal(values, 1);
  assert.equal(failures, 1);
  first.dispose();
  const second = createMemoScope();
  assert.throws(second.memo(fail), (error) => error === reason);
  assert.equal(failures, 2);
  second.dispose();
});

void test("显式依赖键复用等价对象，计算和键策略分别隔离", () => {
  type Input = { readonly text: string; readonly language: string };
  const scope = createMemoScope();
  let calls = 0;
  const operation = (input: Input) => ({ input, call: ++calls });
  const key = ({ text, language }: Input) => [text, language] as const;
  const compute = scope.memo(operation, { key });
  const input = { text: "工作区", language: "zh-CN" };
  assert.equal(compute(input), compute({ ...input }));
  assert.notEqual(compute(input), compute({ ...input, language: "ja" }));
  assert.notEqual(compute(input), scope.memo(operation)(input));
  assert.notEqual(
    compute(input),
    scope.memo(operation, { key: (value) => key(value) })(input),
  );
  assert.notEqual(
    compute(input),
    scope.memo((value: Input) => operation(value), { key })(input),
  );
  assert.equal(calls, 5);
  scope.dispose();
});

void test("并发消费者共享同一个 Promise，完成之后继续复用", async () => {
  const scope = createMemoScope();
  let calls = 0;
  const deferred = Promise.withResolvers<string>();
  const operation = (text: string) => {
    calls += 1;
    return deferred.promise.then((suffix) => text + suffix);
  };
  const first = scope.memo(operation)("工作");
  const second = scope.memo(operation)("工作");
  assert.equal(first, second);
  deferred.resolve("区");
  assert.deepEqual(await Promise.all([first, second]), ["工作区", "工作区"]);
  assert.equal(scope.memo(operation)("工作"), first);
  assert.equal(calls, 1);
  scope.dispose();
});

void test("拒绝的 Promise 保留失败，不隐式发起第二次调用", async () => {
  const scope = createMemoScope();
  let calls = 0;
  const reason = new Error("词典不可用");
  const operation = () => {
    calls += 1;
    return Promise.reject(reason);
  };
  const first = scope.memo(operation)();
  await assert.rejects(first, (error) => error === reason);
  const second = scope.memo(operation)();
  assert.equal(second, first);
  await assert.rejects(second, (error) => error === reason);
  assert.equal(calls, 1);
  scope.dispose();
});

void test("关闭范围拒绝新调用，但不取消已经返回的计算", async () => {
  const scope = createMemoScope();
  const deferred = Promise.withResolvers<number>();
  const compute = scope.memo(() => deferred.promise);
  const pending = compute();
  scope.dispose();
  scope.dispose();
  assert.throws(compute, MemoScopeClosedError);
  assert.throws(() => scope.memo(() => 1), MemoScopeClosedError);
  deferred.resolve(42);
  assert.equal(await pending, 42);
});
