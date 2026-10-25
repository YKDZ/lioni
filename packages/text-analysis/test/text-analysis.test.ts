import assert from "node:assert/strict";
import test from "node:test";

import { createMemoScope } from "@lioni/memo";
import {
  asciiNumbers,
  braceVariables,
  createTextAnalysis,
  literalMarkers,
  regexTokens,
  segmentWords,
  TextAnalysisContractError,
} from "@lioni/text-analysis";
import type { TextRecognizer, WordSegmenter } from "@lioni/text-analysis";

await test("结构识别按显式优先级执行，保护区间保留原文且不拼接", async () => {
  const analysis = createTextAnalysis({
    recognizers: [
      braceVariables({ protect: true }),
      literalMarkers(["<br>", "<br><br>"], { protect: true }),
      asciiNumbers(),
    ],
  });
  const text = "编号 {item2} <br><br> +004.50";
  const result = await analysis.structures({ text, language: "zh-CN" });
  assert.deepEqual(
    result.tokens.map((token) => [
      token.kind,
      text.slice(token.start, token.end),
    ]),
    [
      ["variable", "{item2}"],
      ["marker", "<br><br>"],
      ["number", "+004.50"],
    ],
  );
  assert.equal(result.tokens[2]?.value, "+004.50");
  assert.deepEqual(
    result.protectedRanges.map((range) => text.slice(range.start, range.end)),
    ["{item2}", "<br><br>"],
  );

  const noJoinedMatch = await createTextAnalysis({
    recognizers: [regexTokens({ kind: "term", pattern: /workspace/gu })],
  }).structures({
    text: "work!space",
    language: "en",
    protectedRanges: [{ start: 4, end: 5 }],
  });
  assert.deepEqual(noJoinedMatch.tokens, []);
  assert.equal(noJoinedMatch.text, "work!space");
});

await test("没有默认占位符语法，token 也不会凭种类隐式受保护", async () => {
  const text = "{name} 404";
  const plain = await createTextAnalysis().structures({ text, language: "en" });
  assert.deepEqual(plain.tokens, []);
  const numeric = await createTextAnalysis({
    recognizers: [asciiNumbers()],
  }).words({
    text,
    language: "en",
  });
  assert.ok(numeric.words.some((word) => word.text === "404"));
  const explicit = await createTextAnalysis({
    recognizers: [braceVariables({ protect: true })],
  }).words({ text, language: "en" });
  assert.deepEqual(
    explicit.words.map((word) => word.text),
    ["404"],
  );
});

await test("正则独立扫描原文范围，保留 supplementary 字符后的 UTF-16 偏移", async () => {
  const pattern = /BUG-[0-9]+/gu;
  pattern.lastIndex = 100;
  const analysis = createTextAnalysis({
    recognizers: [regexTokens({ kind: "issue", pattern })],
  });
  const first = await analysis.structures({ text: "😀BUG-7", language: "en" });
  const second = await analysis.structures({ text: "😀BUG-7", language: "en" });
  assert.deepEqual(first.tokens, [{ kind: "issue", start: 2, end: 7 }]);
  assert.deepEqual(second, first);
  assert.equal(pattern.lastIndex, 100);
});

await test("非法识别区间、同层重叠和零长正则不能伪装为无命中", async () => {
  const invalidRecognizers: readonly TextRecognizer[] = [
    () => [{ kind: "bad", start: 0, end: 9 }],
    () => [{ kind: "bad", start: 0, end: 1 }],
    () => [
      { kind: "bad", start: 0, end: 2 },
      { kind: "bad", start: 0, end: 2 },
    ],
  ];
  for (const recognizer of invalidRecognizers)
    await assert.rejects(
      createTextAnalysis({ recognizers: [recognizer] }).structures({
        text: "😀",
        language: "en",
      }),
      TextAnalysisContractError,
    );
  await assert.rejects(
    createTextAnalysis({
      recognizers: [regexTokens({ kind: "empty", pattern: /(?=a)/gu })],
    }).structures({ text: "a", language: "en" }),
    { code: "empty-token" },
  );
  await assert.rejects(
    createTextAnalysis({
      recognizers: [() => [{ kind: "bad", start: 0, end: 3 }]],
    }).structures({
      text: "abc",
      language: "en",
      protectedRanges: [{ start: 1, end: 2 }],
    }),
    { code: "overlapping-token" },
  );
});

await test("中日英内置词界保留原文，保护区间两侧不会连成新词", () => {
  for (const input of [
    { text: "customer support", language: "en-GB" },
    { text: "创建工作区", language: "zh-CN" },
    { text: "新しいワークスペース", language: "ja-JP" },
  ]) {
    const result = segmentWords(input);
    assert.equal(result.complete, true);
    assert.ok(result.words.length > 0);
    for (const word of result.words)
      assert.equal(input.text.slice(word.start, word.end), word.text);
  }
  const english = segmentWords({ text: "art cart", language: "en" });
  assert.ok(english.boundaries.includes(0));
  assert.ok(!english.boundaries.includes(5));
  const protectedWords = segmentWords({
    text: "work!space",
    language: "en",
    protectedRanges: [{ start: 4, end: 5 }],
  });
  assert.deepEqual(
    protectedWords.words.map((word) => word.text),
    ["work", "space"],
  );
});

await test("内置不支持德语，宿主分词器可显式扩展且提供精确区间", async () => {
  const input = { text: "😀 Arbeitsbereich", language: "de-DE" };
  const unsupported = await createTextAnalysis().words(input);
  assert.equal(unsupported.complete, false);
  assert.equal(unsupported.issues[0]?.code, "unsupported-language");
  const german: WordSegmenter = ({ text }) => ({
    words: [{ start: 3, end: text.length, text: text.slice(3) }],
    boundaries: [0, 2, 3, text.length],
    complete: true,
    issues: [],
  });
  const supported = await createTextAnalysis({ segmenter: german }).words(
    input,
  );
  assert.equal(supported.complete, true);
  assert.deepEqual(supported.words, [
    { start: 3, end: 17, text: "Arbeitsbereich" },
  ]);
  await assert.rejects(
    createTextAnalysis({
      segmenter: () => ({
        words: [{ start: 3, end: 17, text: "被改写的文本" }],
        boundaries: [3, 17],
        complete: true,
        issues: [],
      }),
    }).words(input),
    { code: "invalid-segmentation" },
  );
});

await test("结构、分词和签名的并发消费者复用同一底层计算，输入改变会重算", async () => {
  let calls = 0;
  const numbers = asciiNumbers();
  const analysis = createTextAnalysis({
    recognizers: [
      async (input) => {
        calls += 1;
        await Promise.resolve();
        return numbers(input);
      },
    ],
  });
  assert.equal(calls, 0);
  const memo = createMemoScope();
  const policy = { abstract: () => ({ kind: "code", identity: "error-code" }) };
  const [structure, words, signature] = await Promise.all([
    analysis.structures({ text: "Error 004", language: "en" }, { memo }),
    analysis.words({ text: "Error 004", language: "en" }, { memo }),
    analysis.signature({ text: "Error 004", language: "en" }, policy, { memo }),
  ]);
  assert.equal(calls, 1);
  assert.equal(signature.slots[0]?.raw, "004");
  assert.ok(words.words.length > 0);
  assert.equal(
    await analysis.structures({ text: "Error 004", language: "en" }, { memo }),
    structure,
  );
  assert.deepEqual(
    await analysis.structures({ text: "Error 004", language: "en" }),
    structure,
  );
  assert.equal(calls, 2);
  await analysis.structures({ text: "Error 005", language: "en" }, { memo });
  await analysis.structures({ text: "Error 004", language: "zh-CN" }, { memo });
  await analysis.structures(
    {
      text: "Error 004",
      language: "en",
      protectedRanges: [{ start: 6, end: 9 }],
    },
    { memo },
  );
  assert.equal(calls, 5);
  await analysis.words(
    {
      text: "Error 004",
      language: "en",
      protectedRanges: [{ start: 6, end: 9 }],
    },
    { memo },
  );
  assert.equal(calls, 5);
  memo.dispose();
});

await test("自定义分析失败按 scope 共享，独立新 scope 才重新尝试", async () => {
  const failure = new Error("语言分析失败");
  let attempts = 0;
  const analysis = createTextAnalysis({
    recognizers: [
      async () => {
        attempts += 1;
        if (attempts === 1) throw failure;
        return [];
      },
    ],
  });
  const memo = createMemoScope();
  for (let attempt = 0; attempt < 2; attempt += 1)
    await assert.rejects(
      analysis.structures({ text: "text", language: "en" }, { memo }),
      (error: unknown) => error === failure,
    );
  assert.equal(attempts, 1);
  const next = createMemoScope();
  assert.equal(
    (
      await analysis.structures(
        { text: "text", language: "en" },
        { memo: next },
      )
    ).complete,
    true,
  );
  assert.equal(attempts, 2);
  memo.dispose();
  next.dispose();
});
