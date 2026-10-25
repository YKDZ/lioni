import assert from "node:assert/strict";

import {
  createMemoScope,
  MemoScopeClosedError,
  type MemoScope,
} from "@lioni/memo";

const scope: MemoScope = createMemoScope();
let syncCalls = 0;
const calculate = (...values: readonly unknown[]) =>
  `${++syncCalls}:${values.length}`;
const memoized = scope.memo(calculate);
assert.equal(memoized("Save"), "1:1");
assert.equal(memoized("Save"), "1:1");
assert.equal(memoized("Save", undefined), "2:2");

let numericCalls = 0;
const classify = scope.memo((_value: number) => `${++numericCalls}`);
assert.equal(classify(0), "1");
assert.equal(classify(-0), "2");
assert.equal(classify(Number.NaN), "3");
assert.equal(classify(Number.NaN), "3");

type Input = { readonly text: string; readonly language: string };
let keyedCalls = 0;
const byContent = scope.memo(
  (input: Input) => `${++keyedCalls}:${input.text}:${input.language}`,
  { key: ({ text, language }) => [text, language] as const },
);
const english = { text: "workspace", language: "en" };
assert.equal(byContent(english), byContent({ ...english }));
assert.notEqual(byContent(english), byContent({ ...english, language: "ja" }));

let asyncCalls = 0;
let release!: (value: string) => void;
const gate = new Promise<string>((resolve) => {
  release = resolve;
});
const resolveText = scope.memo((text: string) => {
  asyncCalls += 1;
  return gate.then((suffix) => `${text}${suffix}`);
});
const first = resolveText("work");
const second = resolveText("work");
assert.equal(first, second);
release("space");
assert.deepEqual(await Promise.all([first, second]), [
  "workspace",
  "workspace",
]);
assert.equal(asyncCalls, 1);

scope.dispose();
scope.dispose();
assert.throws(() => memoized("Save"), MemoScopeClosedError);
