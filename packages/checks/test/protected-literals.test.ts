import assert from "node:assert/strict";
import test from "node:test";

import { compareProtectedLiterals } from "@lioni/checks";

await test("受保护字面值必须原样保留，且正则元字符按普通字符处理", () => {
  assert.deepEqual(
    compareProtectedLiterals({
      source: "Use monitor_id, X-Forwarded-* and example.com",
      target: "使用 monitor_id、X-Forwarded-* 和 example.com",
      literals: ["monitor_id", "X-Forwarded-*", "example.com"],
    }),
    [],
  );
  assert.deepEqual(
    compareProtectedLiterals({
      source: "Use monitor_id, X-Forwarded-* and example.com",
      target: "使用 old_monitor_id、X-Forwarded- 和 exampleXcom",
      literals: ["monitor_id", "X-Forwarded-*", "example.com"],
    }),
    [
      { literal: "monitor_id" },
      { literal: "X-Forwarded-*" },
      { literal: "example.com" },
    ],
  );
});

await test("只有原文实际出现的受保护字面值才参与比较", () => {
  assert.deepEqual(
    compareProtectedLiterals({
      source: "A translated sentence",
      target: "一句译文",
      literals: ["not-present"],
    }),
    [],
  );
});
