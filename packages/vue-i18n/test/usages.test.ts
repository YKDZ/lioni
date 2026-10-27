import assert from "node:assert/strict";
import test from "node:test";

import { extractVueI18nUsages } from "@lioni/vue-i18n";

void test("从 JavaScript 语法树提取静态键、参数形状和无法解析的调用", () => {
  const usages = extractVueI18nUsages(
    [
      "t('welcome', { named: { user }, list: ['first'] });",
      "t(key, params);",
      "$tc(`items`, 2);",
      "t('unknown-parameters', params);",
    ].join("\n"),
    "src/messages.ts",
  );

  assert.deepEqual(usages.entries, [
    {
      key: "welcome",
      file: "src/messages.ts",
      kind: "call",
      supplied: ["named:user", "list:0"],
      parametersKnown: true,
    },
    {
      key: "items",
      file: "src/messages.ts",
      kind: "call",
      supplied: ["plural", "named:n", "named:count"],
      parametersKnown: true,
    },
    {
      key: "unknown-parameters",
      file: "src/messages.ts",
      kind: "call",
      supplied: [],
      parametersKnown: false,
    },
  ]);
  assert.deepEqual(usages.unresolved, [
    { file: "src/messages.ts", expression: "t(key, params)" },
  ]);
  assert.deepEqual(usages.errors, []);
});

void test("从 Vue 语法树提取插值调用、组件槽位和动态键", () => {
  const usages = extractVueI18nUsages(
    `<template>
      <p>{{ t('inline', { text }) }}</p>
      <i18n-t keypath="greeting"><template #name><b /></template></i18n-t>
      <i18n-t :keypath="dynamicKey"><b /></i18n-t>
    </template>
    <script setup lang="ts">const label = $t('setup');</script>`,
    "src/Message.vue",
  );

  assert.deepEqual(
    usages.entries.map(({ key, file, kind, supplied, parametersKnown }) => ({
      key,
      file,
      kind,
      supplied,
      parametersKnown,
    })),
    [
      {
        key: "setup",
        file: "src/Message.vue",
        kind: "call",
        supplied: [],
        parametersKnown: true,
      },
      {
        key: "inline",
        file: "src/Message.vue",
        kind: "call",
        supplied: ["named:text"],
        parametersKnown: true,
      },
      {
        key: "greeting",
        file: "src/Message.vue",
        kind: "component",
        supplied: ["named:name"],
        parametersKnown: true,
      },
    ],
  );
  assert.deepEqual(usages.unresolved, [
    { file: "src/Message.vue", expression: "动态 i18n-t keypath" },
  ]);
  assert.deepEqual(usages.errors, []);
});

void test("保留真实文件名和语法树解析错误", () => {
  const file = "src/broken.ts";
  const usages = extractVueI18nUsages("const = ;", file);

  assert.deepEqual(usages.entries, []);
  assert.deepEqual(usages.unresolved, []);
  assert.equal(usages.errors.length, 1);
  assert.equal(usages.errors[0]?.file, file);
  assert.ok(usages.errors[0]?.message);
});
