import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { discoverTerms, TermContractError } from "../src/index.ts";

void describe("受限单语候选发现", () => {
  void it("频次、条目覆盖和原文上下文来自完整输入，输出预算不改统计", async () => {
    const corpus = {
      language: "en",
      entries: [
        { ref: "a", fragments: [{ ref: "title", text: "red fox red fox" }] },
        { ref: "b", fragments: [{ ref: "title", text: "red fox" }] },
      ],
    };
    const full = await discoverTerms(corpus, { maxWords: 2, maxExamples: 2 });
    const phrase = full.candidates.find(
      (candidate) => candidate.text === "red fox",
    )!;
    assert.equal(phrase.occurrences, 3);
    assert.equal(phrase.entryCount, 2);
    assert.equal(phrase.examplesTruncated, true);
    assert.equal(phrase.ranking.score, 6);
    assert.deepEqual(phrase.examples[0]!.range, { start: 0, end: 7 });
    assert.equal(phrase.examples[0]!.context, "red fox red fox");
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
});
