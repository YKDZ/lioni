import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createMemoScope } from "@lioni/memo";
import { createTextAnalysis, segmentWords } from "@lioni/text-analysis";
import type {
  StructureAnalysis,
  TextAnalysis,
  TextInput,
  WordAnalysis,
} from "@lioni/text-analysis";

import { discoverTerms, TermContractError } from "../src/index.ts";

void describe("受限单语候选发现", () => {
  void it("保留连接符内的完整候选，功能词只限制候选两端", async () => {
    const text =
      "The state-of-the-art parser uses a bag of words and drag & drop.";
    const result = await discoverTerms(
      { language: "en", entries: [{ ref: 0, fragments: [{ ref: 0, text }] }] },
      { maxWords: 5, limit: 200 },
    );
    for (const term of ["state-of-the-art", "bag of words", "drag & drop"]) {
      const candidate = result.candidates.find(
        ({ text: value }) => value === term,
      );
      assert.ok(candidate, term);
      const example = candidate.examples[0]!;
      assert.equal(text.slice(example.range.start, example.range.end), term);
    }
    for (const term of [
      "The",
      "a",
      "and",
      "The state",
      "of words",
      "words and",
    ])
      assert.ok(
        !result.candidates.some(({ text: value }) => value === term),
        term,
      );
  });

  void it("语言规则互不替代，自定义分词仍可接入其他语言", async () => {
    const analysis = createTextAnalysis({
      segmenter: (input) => ({
        words: [{ start: 0, end: input.text.length, text: input.text }],
        boundaries: [0, input.text.length],
        complete: true,
        issues: [],
      }),
    });
    const result = await discoverTerms(
      {
        language: "xx",
        entries: [{ ref: 0, fragments: [{ ref: 0, text: "the" }] }],
      },
      { analysis },
    );
    assert.equal(result.status, "complete");
    assert.deepEqual(
      result.candidates.map(({ text }) => text),
      ["the"],
    );
    const explicit = await discoverTerms(
      {
        language: "en",
        entries: [{ ref: 0, fragments: [{ ref: 0, text: "the" }] }],
      },
      {
        candidateGenerator: ({ words }) =>
          words.map(({ start, end }) => ({ start, end })),
      },
    );
    assert.deepEqual(
      explicit.candidates.map(({ text }) => text),
      ["the"],
    );
  });

  void it("紧连复合词中的功能词保留，纯功能词组合仍不成为候选", async () => {
    const result = await discoverTerms({
      language: "en",
      entries: [
        {
          ref: 0,
          fragments: [
            {
              ref: 0,
              text: "in-memory storage; built-in support; in-the parser; to/from",
            },
          ],
        },
      ],
    });
    for (const term of [
      "in-memory",
      "in-memory storage",
      "built-in",
      "built-in support",
    ])
      assert.ok(
        result.candidates.some(({ text }) => text === term),
        term,
      );
    for (const term of [
      "in",
      "to",
      "from",
      "in-the",
      "in-the parser",
      "to/from",
    ])
      assert.ok(!result.candidates.some(({ text }) => text === term), term);
  });

  void it("中文和日文在各自词界上过滤功能词，保留无空格术语", async () => {
    for (const [language, text, expected, excluded] of [
      [
        "zh",
        "这是文件系统和内存管理。",
        ["文件系统", "内存管理"],
        ["这", "是", "和", "和内存"],
      ],
      [
        "ja",
        "これは検索機能と保存機能です。",
        ["検索機能", "保存機能"],
        ["これ", "は", "と", "です", "と保存"],
      ],
    ] as const) {
      const result = await discoverTerms(
        { language, entries: [{ ref: 0, fragments: [{ ref: 0, text }] }] },
        { maxWords: 2 },
      );
      assert.equal(result.status, "complete");
      for (const term of expected)
        assert.ok(
          result.candidates.some(({ text }) => text === term),
          term,
        );
      for (const term of excluded)
        assert.ok(!result.candidates.some(({ text }) => text === term), term);
    }
  });

  void it("连接符不绕过词数、字符数或保护区间限制", async () => {
    const text = "𐐀-𐐁";
    const corpus = {
      language: "en",
      entries: [{ ref: 0, fragments: [{ ref: 0, text }] }],
    };
    const full = await discoverTerms(corpus, { maxCharacters: 3 });
    assert.ok(full.candidates.some(({ text: value }) => value === text));
    for (const options of [{ maxWords: 1 }, { maxCharacters: 2 }]) {
      const result = await discoverTerms(corpus, options);
      assert.ok(!result.candidates.some(({ text: value }) => value === text));
    }
    const protectedResult = await discoverTerms({
      ...corpus,
      entries: [
        {
          ref: 0,
          fragments: [
            { ref: 0, text, protectedRanges: [{ start: 2, end: 3 }] },
          ],
        },
      ],
    });
    assert.ok(
      !protectedResult.candidates.some(({ text: value }) => value === text),
    );
  });

  void it("频次、条目覆盖和原文上下文来自完整输入，输出预算不改统计", async () => {
    const corpus = {
      language: "en",
      entries: [
        {
          ref: "ui-short-a",
          fragments: [{ ref: "title", text: "red fox red fox" }],
        },
        {
          ref: "ui-short-b",
          fragments: [{ ref: "button", text: "red fox" }],
        },
        {
          ref: "description",
          fragments: [{ ref: "body", text: "red fox" }],
        },
      ],
    };
    const full = await discoverTerms(corpus, { maxWords: 2, maxExamples: 2 });
    const phrase = full.candidates.find(
      (candidate) => candidate.text === "red fox",
    )!;
    assert.equal(phrase.occurrences, 4);
    assert.equal(phrase.entryCount, 3);
    assert.equal(phrase.examplesTruncated, true);
    assert.equal(phrase.ranking.score, 8);
    assert.deepEqual(phrase.examples[0]!.range, { start: 0, end: 7 });
    assert.equal(phrase.examples[0]!.context, "red fox red fox");
    assert.equal(phrase.examples[0]!.entryRef, "ui-short-a");
    assert.equal(phrase.examples[1]!.entryRef, "ui-short-a");
    const limited = await discoverTerms(corpus, {
      maxWords: 2,
      maxExamples: 2,
      limit: 1,
    });
    assert.equal(
      limited.statistics.distinctCandidates,
      full.statistics.distinctCandidates,
    );
    assert.deepEqual(limited.candidates[0], full.candidates[0]);
  });

  void it("不跨片段、标点或保护区间造词组，未配置保护的内容仍可发现", async () => {
    const result = await discoverTerms({
      language: "en",
      entries: [
        {
          ref: 0,
          fragments: [
            { ref: 1, text: "red" },
            { ref: 2, text: "fox" },
            { ref: 3, text: "red, fox" },
            {
              ref: 4,
              text: "red fox",
              protectedRanges: [{ start: 4, end: 7 }],
            },
          ],
        },
      ],
    });
    assert.ok(
      !result.candidates.some((candidate) => candidate.text === "red fox"),
    );
    assert.equal(
      result.candidates.find((candidate) => candidate.text === "fox")!
        .occurrences,
      2,
    );
    assert.equal(
      result.candidates.find((candidate) => candidate.text === "red")!
        .entryCount,
      1,
    );

    const customProtected = await discoverTerms(
      {
        language: "en",
        entries: [
          {
            ref: "protected",
            fragments: [
              {
                ref: "body",
                text: "red fox",
                protectedRanges: [{ start: 4, end: 5 }],
              },
            ],
          },
        ],
      },
      {
        candidateGenerator: ({ text }) => [{ start: 0, end: text.length }],
      },
    );
    assert.equal(customProtected.candidates.length, 0);
  });

  void it("中文与日文单独运行，稀有词不被默认频次门槛删除", async () => {
    for (const [language, text] of [
      ["zh", "工作空间"],
      ["ja", "ワークスペース"],
    ]) {
      const result = await discoverTerms({
        language: language!,
        entries: [{ ref: 0, fragments: [{ ref: 0, text: text! }] }],
      });
      assert.equal(result.status, "complete");
      assert.ok(result.candidates.some((candidate) => candidate.text === text));
      assert.ok(
        result.candidates.every((candidate) => candidate.occurrences === 1),
      );
    }
  });

  void it("未知语言、部分语料与无效参数明确表达", async () => {
    const corpus = {
      language: "fr",
      entries: [{ ref: 0, fragments: [{ ref: 0, text: "espace" }] }],
    };
    assert.equal((await discoverTerms(corpus)).status, "incomplete");
    assert.equal(
      (await discoverTerms({ ...corpus, language: "en", complete: false }))
        .status,
      "incomplete",
    );
    await assert.rejects(
      discoverTerms(corpus, { maxWords: 1000 }),
      TermContractError,
    );
  });

  void it("结构扫描有缺口时保留已知候选和原始问题", async () => {
    const textAnalysis: TextAnalysis = {
      structures: async (input: TextInput): Promise<StructureAnalysis> => ({
        text: input.text,
        language: input.language,
        tokens: [],
        protectedRanges: input.protectedRanges ?? [],
        availableRanges: [{ start: 0, end: input.text.length }],
        complete: false,
        issues: [
          {
            code: "partial-structure",
            message: "结构识别有局部缺口。",
            range: { start: 0, end: 7 },
          },
        ],
      }),
      words: async (input: TextInput): Promise<WordAnalysis> => ({
        ...segmentWords(input),
        complete: true,
        issues: [],
      }),
      signature: async () => {
        throw new Error("本场景不创建模板签名。");
      },
    };

    const result = await discoverTerms(
      {
        language: "en",
        entries: [
          {
            ref: "monitor",
            fragments: [{ ref: "body", text: "monitor service" }],
          },
        ],
      },
      { analysis: textAnalysis, maxWords: 2 },
    );

    assert.equal(result.status, "incomplete");
    assert.ok(
      result.candidates.some((candidate) => candidate.text === "monitor"),
    );
    assert.ok(
      result.candidates.some(
        (candidate) => candidate.text === "monitor service",
      ),
    );
    assert.deepEqual(
      result.issues.map(({ code, entryIndex, fragmentIndex, range }) => [
        code,
        entryIndex,
        fragmentIndex,
        range,
      ]),
      [["partial-structure", 0, 0, { start: 0, end: 7 }]],
    );
  });

  void it("结构阶段的不完整不会被误报成分词阶段缺口", async () => {
    const textAnalysis: TextAnalysis = {
      structures: async (input) => ({
        text: input.text,
        language: input.language,
        tokens: [],
        protectedRanges: [],
        availableRanges: [{ start: 0, end: input.text.length }],
        complete: false,
        issues: [],
      }),
      words: async (input) => ({
        ...segmentWords(input),
        complete: false,
        issues: [],
      }),
      signature: async () => {
        throw new Error("本场景不创建模板签名。");
      },
    };

    const result = await discoverTerms(
      {
        language: "en",
        entries: [
          {
            ref: "partial-structure",
            fragments: [{ ref: "body", text: "monitor service" }],
          },
        ],
      },
      { analysis: textAnalysis },
    );

    assert.equal(result.status, "incomplete");
    assert.deepEqual(
      result.issues.map(({ code }) => code),
      ["incomplete-structure"],
    );
  });

  void it("完整的空文本语料返回空候选且保持完整", async () => {
    const result = await discoverTerms({
      language: "en",
      entries: [{ ref: "empty", fragments: [{ ref: "body", text: "" }] }],
    });

    assert.equal(result.status, "complete");
    assert.deepEqual(result.candidates, []);
    assert.deepEqual(result.issues, []);
    assert.equal(result.statistics.entries, 1);
  });

  void it("可替换有界候选生成与排序并报告实际排序依据", async () => {
    let generationCalls = 0;
    let rankingCalls = 0;
    const result = await discoverTerms(
      {
        language: "en",
        entries: [
          {
            ref: "error",
            fragments: [{ ref: "label", text: "ErrorCode 404" }],
          },
          {
            ref: "retry",
            fragments: [{ ref: "label", text: "RetryCode 503" }],
          },
        ],
      },
      {
        maxWords: 1,
        candidateGenerator: ({ words }) => {
          generationCalls += 1;
          return words
            .filter(({ text }) => text.endsWith("Code"))
            .map(({ start, end }) => ({ start, end }));
        },
        candidateRanker: (candidate) => {
          rankingCalls += 1;
          return {
            method: "prefer-retry-code",
            score: candidate.text === "RetryCode" ? 10 : 1,
          };
        },
      },
    );

    assert.deepEqual(
      result.candidates.map((candidate) => candidate.text),
      ["RetryCode", "ErrorCode"],
    );
    assert.equal(generationCalls, 2);
    assert.equal(rankingCalls, 2);
    assert.deepEqual(
      result.candidates.map(({ ranking }) => [ranking.method, ranking.score]),
      [
        ["prefer-retry-code", 10],
        ["prefer-retry-code", 1],
      ],
    );

    await assert.rejects(
      discoverTerms(
        {
          language: "en",
          entries: [
            {
              ref: "invalid-rank",
              fragments: [{ ref: "label", text: "ErrorCode" }],
            },
          ],
        },
        {
          candidateRanker: () => ({ method: "", score: Number.NaN }),
        },
      ),
      (error) =>
        error instanceof TermContractError &&
        error.issues.some(
          (issue) => issue.code === "invalid-candidate-ranking",
        ),
    );
  });

  void it("候选位置不切开补充平面字符，拒绝无效词界", async () => {
    const result = await discoverTerms({
      language: "en",
      entries: [
        { ref: "emoji", fragments: [{ ref: "body", text: "😀 monitor" }] },
      ],
    });
    const monitor = result.candidates.find(
      (candidate) => candidate.text === "monitor",
    )!;
    assert.deepEqual(monitor.examples[0]!.range, { start: 3, end: 10 });

    const invalidAnalysis: TextAnalysis = {
      structures: async (input) => ({
        text: input.text,
        language: input.language,
        tokens: [],
        protectedRanges: [],
        availableRanges: [{ start: 0, end: input.text.length }],
        complete: true,
        issues: [],
      }),
      words: async () => ({
        words: [{ start: 0, end: 1, text: "\ud83d" }],
        boundaries: [0, 1],
        complete: true,
        issues: [],
      }),
      signature: async () => {
        throw new Error("本场景不创建模板签名。");
      },
    };
    await assert.rejects(
      discoverTerms(
        {
          language: "ja",
          entries: [
            { ref: "invalid", fragments: [{ ref: "body", text: "😀" }] },
          ],
        },
        { analysis: invalidAnalysis },
      ),
      (error) =>
        error instanceof TermContractError &&
        error.issues.some((issue) => issue.code === "invalid-word-analysis"),
    );
  });

  void it("共享分析缓存只复用相同输入，生成与排名按调用重算", async () => {
    let segmenterCalls = 0;
    let generationCalls = 0;
    let rankingCalls = 0;
    const analysis = createTextAnalysis({
      segmenter(input) {
        segmenterCalls += 1;
        return segmentWords(input);
      },
    });
    const memo = createMemoScope();
    const corpus = {
      language: "en",
      entries: [
        { ref: "screen", fragments: [{ ref: "button", text: "red fox" }] },
      ],
    };
    const options = {
      analysis,
      memo,
      candidateGenerator: ({
        words,
      }: {
        readonly words: readonly {
          readonly start: number;
          readonly end: number;
          readonly text: string;
        }[];
      }) => {
        generationCalls += 1;
        return words.map(({ start, end }) => ({ start, end }));
      },
      candidateRanker: (candidate: { readonly text: string }) => {
        rankingCalls += 1;
        return { method: "test-order", score: candidate.text.length };
      },
    };

    const first = await discoverTerms(corpus, options);
    const equivalent = await discoverTerms(corpus, options);
    assert.deepEqual(first.candidates, equivalent.candidates);
    assert.equal(segmenterCalls, 1);
    assert.equal(generationCalls, 2);
    assert.equal(rankingCalls, 4);

    await discoverTerms(
      {
        ...corpus,
        entries: [
          { ref: "screen", fragments: [{ ref: "button", text: "blue fox" }] },
        ],
      },
      options,
    );
    await discoverTerms(
      {
        ...corpus,
        entries: [
          {
            ref: "screen",
            fragments: [
              {
                ref: "button",
                text: "red fox",
                protectedRanges: [{ start: 0, end: 3 }],
              },
            ],
          },
        ],
      },
      options,
    );
    await discoverTerms({ ...corpus, language: "ja" }, options);

    assert.equal(segmenterCalls, 4);
    memo.dispose();
  });
});
