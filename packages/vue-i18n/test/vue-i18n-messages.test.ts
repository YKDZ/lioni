import assert from "node:assert/strict";
import test from "node:test";

import { parseVueI18nMessage } from "@lioni/vue-i18n";

void test("保留 Vue I18n 分支变量次数、范围和关联目标", () => {
  const parsed = parseVueI18nMessage("{name} @:{linked} @:account | {n} {n}");

  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.branches, [
    {
      range: { start: 0, end: 27 },
      text: "     ",
      variables: ["named:name", "named:linked"],
    },
    {
      range: { start: 30, end: 37 },
      text: "   ",
      variables: ["named:n", "named:n"],
    },
  ]);
  assert.deepEqual(
    parsed.tokens.map(({ identity, start, end }) => ({ identity, start, end })),
    [
      { identity: "named:name", start: 0, end: 6 },
      { identity: "named:linked", start: 9, end: 17 },
      { identity: "named:n", start: 30, end: 33 },
      { identity: "named:n", start: 34, end: 37 },
    ],
  );
  assert.deepEqual(parsed.links, ["account"]);
  assert.deepEqual(parsed.linkFacts, [
    {
      kind: "dynamic",
      variables: ["named:linked"],
      range: { start: 7, end: 17 },
    },
    { kind: "static", key: "account", range: { start: 18, end: 27 } },
  ]);
});

void test("Vue I18n 语法错误保留编译器范围", () => {
  const parsed = parseVueI18nMessage("prefix } suffix");

  assert.deepEqual(parsed.errors, [
    {
      code: 6,
      domain: "tokenizer",
      message: "Unbalanced closing brace",
      range: { start: 7, end: 7 },
    },
  ]);
});
