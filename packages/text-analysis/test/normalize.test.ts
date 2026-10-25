import assert from "node:assert/strict";
import test from "node:test";

import { normalizeText, TextAnalysisContractError } from "@lioni/text-analysis";

await test("NFC 回映组合字符、Hangul 及 supplementary 字符后的原文区间", () => {
  const normalized = normalizeText("😀Cafe\u0301 和 \u1100\u1161");
  assert.equal(normalized.text, "😀Café 和 가");
  assert.deepEqual(normalized.mapRange({ start: 2, end: 6 }), {
    start: 2,
    end: 7,
  });
  assert.deepEqual(normalized.mapRange({ start: 9, end: 10 }), {
    start: 10,
    end: 12,
  });
  assert.deepEqual(normalized.mapRange({ start: 0, end: 2 }), {
    start: 0,
    end: 2,
  });
});

await test("组合顺序变化时只返回可精确连续表示的原文，不扩大命中", () => {
  const normalized = normalizeText("a\u0327\u0301");
  assert.equal(normalized.text, "á\u0327");
  assert.equal(normalized.mapRange({ start: 0, end: 1 }), null);
  assert.deepEqual(normalized.mapRange({ start: 1, end: 2 }), {
    start: 1,
    end: 2,
  });
  assert.deepEqual(normalized.mapRange({ start: 0, end: 2 }), {
    start: 0,
    end: 3,
  });
  const excludedComposition = normalizeText("\u0344");
  assert.equal(excludedComposition.text, "\u0308\u0301");
  assert.equal(excludedComposition.mapRange({ start: 0, end: 1 }), null);
  assert.deepEqual(excludedComposition.mapRange({ start: 0, end: 2 }), {
    start: 0,
    end: 1,
  });
});

await test("回映拒绝越界和切开代理对的区间，零长边界明确返回", () => {
  for (const text of ["😀a", "😀e\u0301"]) {
    const normalized = normalizeText(text);
    assert.throws(
      () => normalized.mapRange({ start: 1, end: 2 }),
      TextAnalysisContractError,
    );
    assert.throws(
      () => normalized.mapRange({ start: 0, end: 9 }),
      TextAnalysisContractError,
    );
    assert.deepEqual(normalized.mapRange({ start: 0, end: 0 }), {
      start: 0,
      end: 0,
    });
    assert.deepEqual(
      normalized.mapRange({
        start: normalized.text.length,
        end: normalized.text.length,
      }),
      { start: text.length, end: text.length },
    );
  }
});
