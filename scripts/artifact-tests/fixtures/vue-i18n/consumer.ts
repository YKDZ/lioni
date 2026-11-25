import assert from "node:assert/strict";

import {
  runQa,
  createQaSuppression,
  type TermbaseData,
} from "@boringparts/lioni";

import { createConfig } from "./lioni.config.ts";

const cases = [
  { target: "你好 {name}", expected: undefined },
  { target: "你好 {person}", expected: "vue-i18n/variable-correspondence" },
];
const summaries = [];
for (const { target, expected } of cases) {
  const result = await runQa(createConfig(target));
  const diagnostics = result.diagnostics.map(({ checkId }) => checkId).sort();
  if (expected === undefined) {
    assert.deepEqual(diagnostics, []);
  } else {
    assert.ok(diagnostics.includes(expected));
  }
  summaries.push({ target, diagnostics });
}
const syntaxOnly = await runQa(createConfig("无效 }"), {
  checkIds: ["vue-i18n/source-syntax", "vue-i18n/target-syntax"],
});
assert.deepEqual(
  syntaxOnly.diagnostics.map(({ checkId }) => checkId),
  ["vue-i18n/target-syntax"],
);
await assert.rejects(
  runQa(createConfig("无效 }")),
  /vue-i18n\/variable-correspondence.*message.*zh-CN/u,
);
// 使用安装后的正式 SDK 验证无关消息编辑不会撤销术语豁免。
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
const before = await runQa(
  createConfig(target, { terms, otherText: "消息 B" }),
  { candidates },
);
const suppressions = before.checks
  .filter((check) => check.checkId.startsWith("terminology/"))
  .flatMap((check) =>
    check.executions.map((execution) =>
      createQaSuppression({
        id: execution.checkId,
        reason: "接受消息 A",
        execution,
      }),
    ),
  );
assert.equal(suppressions.length, 2);
const after = await runQa(
  createConfig(target, { terms, otherText: "修改消息 B", suppressions }),
  { candidates },
);
assert.deepEqual(
  after.diagnostics
    .filter((item) => item.checkId.startsWith("terminology/"))
    .map((item) => item.handling.status),
  ["suppressed", "suppressed"],
);
const changed = await runQa(
  createConfig(target, {
    terms: { concepts: [] },
    otherText: "修改消息 B",
    suppressions,
  }),
  { candidates },
);
assert.deepEqual(
  changed.diagnostics.filter((item) => item.checkId.startsWith("terminology/")),
  [],
);
process.stdout.write(JSON.stringify(summaries));
