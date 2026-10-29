import assert from "node:assert/strict";

import {
  analyzeQuality,
  createQualityException,
  type TermbaseData,
} from "@lioni/lioni";

import { createConfig } from "./lioni.config.ts";

const cases = [
  { target: "你好 {name}", expected: undefined },
  { target: "你好 {person}", expected: "vue-i18n/variable-correspondence" },
  { target: "无效 }", expected: "vue-i18n/target-syntax" },
];
const summaries = [];
for (const { target, expected } of cases) {
  const result = await analyzeQuality(createConfig(target));
  const diagnostics = result.diagnostics.map(({ checkId }) => checkId).sort();
  if (expected === undefined) {
    assert.equal(result.status, "complete");
    assert.deepEqual(diagnostics, []);
  } else {
    assert.ok(diagnostics.includes(expected));
  }
  summaries.push({ target, status: result.status, diagnostics });
}
// 使用安装后的正式 SDK 验证无关消息编辑不会撤销术语例外。
const terms: TermbaseData = {
  concepts: [
    {
      id: "hello",
      languages: [
        {
          language: "en",
          expressions: [{ id: "en", text: "Hello", usage: "preferred" }],
        },
        {
          language: "zh-CN",
          expressions: [
            { id: "zh", text: "你好", usage: "allowed" },
            { id: "old", text: "旧称", usage: "forbidden" },
          ],
        },
      ],
    },
  ],
};
const target = "旧称 {name}";
const candidates = [
  { sourceKey: "message", language: "zh-CN", content: target },
];
const before = await analyzeQuality(
  createConfig(target, { terms, otherText: "消息 B" }),
  { candidates },
);
const exceptions = before.checks
  .filter((check) => check.checkId.startsWith("terminology/"))
  .flatMap((check) =>
    check.executions.map((execution) =>
      createQualityException({
        id: execution.checkId,
        reason: "接受消息 A",
        execution,
      }),
    ),
  );
assert.equal(exceptions.length, 2);
const after = await analyzeQuality(
  createConfig(target, { terms, otherText: "修改消息 B", exceptions }),
  { candidates },
);
assert.deepEqual(
  after.exceptionApplicability.map((item) => item.status),
  ["applicable", "applicable"],
);
assert.deepEqual(
  after.diagnostics
    .filter((item) => item.checkId.startsWith("terminology/"))
    .map((item) => item.handling.status),
  ["excepted", "excepted"],
);
const changed = await analyzeQuality(
  createConfig(target, {
    terms: { concepts: [] },
    otherText: "修改消息 B",
    exceptions,
  }),
  { candidates },
);
assert.deepEqual(
  changed.exceptionApplicability.map((item) => item.status),
  ["basis-changed", "basis-changed"],
);
process.stdout.write(JSON.stringify(summaries));
