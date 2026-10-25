import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createMemoScope } from "@lioni/memo";
import {
  createTextAnalysis,
  normalizeText,
  segmentWords,
} from "@lioni/text-analysis";

import {
  analyzeTermUse,
  assessTermUse,
  compileTerms,
  createTermbase,
  discoverTerms,
  evaluateTerms,
  findTerms,
  rejectForbiddenTranslation,
  requireAllowedTranslation,
  selectTerms,
  termComparisonInputSchema,
  TermContractError,
  type TermbaseData,
  type TermComparisonInput,
  type TermConceptData,
  type TermExpressionData,
} from "../src/index.ts";

function expression(
  id: string,
  text: string,
  usage: TermExpressionData["usage"] = "allowed",
): TermExpressionData {
  return { id, text, usage };
}

function concept(
  id: string,
  en: readonly TermExpressionData[],
  zh: readonly TermExpressionData[] = [],
): TermConceptData {
  return {
    id,
    languages: [
      { language: "en", expressions: en },
      ...(zh.length ? [{ language: "zh", expressions: zh }] : []),
    ],
  };
}

function comparison(source: string, target: string): TermComparisonInput {
  return {
    groups: [
      {
        source: {
          language: "en",
          fragments: [{ ref: "source", text: source }],
        },
        target: {
          language: "zh",
          fragments: [{ ref: "candidate", text: target }],
        },
      },
    ],
  };
}

const workspace = concept(
  "workspace",
  [expression("en", "workspace", "preferred")],
  [
    expression("zh", "工作区", "preferred"),
    expression("zh-alt", "工作空间"),
    expression("zh-old", "作业区", "forbidden"),
  ],
);

void describe("术语资料快照与分阶段校验", () => {
  void it("保留三层来源并与调用方修改隔离，允许多首选与缺语言", () => {
    const data = {
      concepts: [
        {
          id: "workspace",
          languages: [
            {
              language: "en",
              definition: { text: "area", sourceRefs: ["definition"] },
              expressions: [
                { id: "one", text: "workspace", usage: "preferred" },
                {
                  id: "two",
                  text: "work space",
                  usage: "preferred",
                  termType: "variant",
                },
              ],
            },
          ],
        },
      ],
      metadata: { source: "fixture" },
    };
    const base = createTermbase(data);
    data.concepts[0]!.languages[0]!.expressions[0]!.text = "changed";
    data.metadata.source = "changed";
    assert.equal(
      base.getExpression("workspace", "one")!.expression.text,
      "workspace",
    );
    assert.deepEqual(base.data.metadata, { source: "fixture" });
    assert.deepEqual(
      base.getConcept("workspace")!.languages[0]!.definition!.sourceRefs,
      ["definition"],
    );
    assert.throws(
      () =>
        Object.assign(base.getExpression("workspace", "one")!.expression, {
          text: "mutated",
        }),
      TypeError,
    );
    assert.equal(compileTerms(base).termbase.expressions.length, 2);
    assert.equal(createTermbase({ concepts: [] }).expressions.length, 0);
  });

  void it("拒绝有损 JSON、空表达、重复身份和重复语言", () => {
    for (const metadata of [undefined, NaN, -0, new Date(), /x/u, () => 1])
      assert.throws(
        () => createTermbase({ concepts: [], metadata }),
        TermContractError,
      );
    assert.throws(
      () => createTermbase({ concepts: [workspace, workspace] }),
      (error) =>
        error instanceof TermContractError &&
        error.stage === "create" &&
        error.issues.some((issue) => issue.code === "duplicate-concept-id"),
    );
    assert.throws(
      () =>
        createTermbase({ concepts: [concept("x", [expression("a", " ")])] }),
      TermContractError,
    );
    assert.throws(
      () =>
        createTermbase({
          concepts: [
            concept("x", [expression("a", "one")], [expression("a", "一")]),
          ],
        }),
      TermContractError,
    );
    assert.throws(
      () =>
        createTermbase({
          concepts: [
            {
              id: "x",
              languages: [workspace.languages[0], workspace.languages[0]],
            },
          ],
        }),
      TermContractError,
    );
  });

  void it("先选择再验证使用地位，同形不同概念不合并", () => {
    const base = createTermbase({
      concepts: [
        concept("one", [
          expression("a", "bank"),
          expression("b", "bank", "forbidden"),
        ]),
        concept("two", [expression("c", "bank")]),
      ],
    });
    assert.equal(base.concepts.length, 2);
    assert.throws(
      () => selectTerms(base),
      (error) => error instanceof TermContractError && error.stage === "select",
    );
    const selected = selectTerms(base, {
      expression: (entry) => entry.expressionId !== "b",
    });
    assert.equal(selected.concepts.length, 2);
    assert.equal(compileTerms(selected).termbase.expressions.length, 2);
  });

  void it("编译检查 NFC 和显式大小写策略造成的新冲突", () => {
    const base = createTermbase({
      concepts: [
        concept("case", [
          expression("upper", "US"),
          expression("lower", "us", "forbidden"),
        ]),
      ],
    });
    compileTerms(base);
    assert.throws(
      () =>
        compileTerms(base, {
          policy: {
            id: "ascii-lower",
            boundary: "word",
            normalize: (text) => ({
              ...normalizeText(text),
              text: text.toLowerCase(),
            }),
          },
        }),
      (error) =>
        error instanceof TermContractError && error.stage === "compile",
    );
    const canonical = createTermbase({
      concepts: [
        concept("coffee", [
          expression("a", "café"),
          expression("b", "cafe\u0301", "forbidden"),
        ]),
      ],
    });
    assert.throws(
      () => compileTerms(canonical),
      (error) =>
        error instanceof TermContractError && error.stage === "compile",
    );
  });
});

void describe("术语识别与局部歧义", () => {
  void it("注入的分析实例与宿主、候选发现共享同次分词", async () => {
    let calls = 0;
    const analysis = createTextAnalysis({
      segmenter: (input) => {
        calls += 1;
        return segmentWords(input);
      },
    });
    const terms = compileTerms(createTermbase({ concepts: [workspace] }), {
      analysis,
    });
    assert.equal(calls, 0);
    const memo = createMemoScope();
    const input = { text: "workspace", language: "en" };
    await Promise.all([
      findTerms(
        terms,
        { language: "en", fragments: [{ ref: 0, text: input.text }] },
        { memo },
      ),
      analysis.words(input, { memo }),
      discoverTerms(
        {
          language: "en",
          entries: [{ ref: 0, fragments: [{ ref: 0, text: input.text }] }],
        },
        { analysis, memo },
      ),
    ]);
    assert.equal(calls, 1);
    memo.dispose();
    const protectedAnalysis = createTextAnalysis({
      recognizers: [
        () => [{ start: 0, end: 3, kind: "host-markup", protect: true }],
      ],
    });
    const protectedTerms = compileTerms(
      createTermbase({ concepts: [workspace] }),
      { analysis: protectedAnalysis },
    );
    const result = await findTerms(protectedTerms, {
      language: "zh",
      fragments: [{ ref: 0, text: "工作区" }],
    });
    assert.equal(result.matches.length, 0);
  });

  void it("不同自定义政策在运行时重合时保留使用地位冲突", async () => {
    const base = createTermbase({
      concepts: [
        concept("work", [
          expression("allowed", "work"),
          expression("forbidden", "WORK", "forbidden"),
        ]),
      ],
    });
    const terms = compileTerms(base, {
      policyFor: (entry) =>
        entry.expressionId === "allowed"
          ? {
              id: "lower",
              boundary: "word",
              normalize: (text) => ({
                ...normalizeText(text),
                text: text.toLowerCase(),
              }),
            }
          : undefined,
    });
    const result = await findTerms(terms, {
      language: "en",
      fragments: [{ ref: 0, text: "WORK" }],
    });
    assert.equal(result.ambiguities[0]!.reason, "conflicting-usage");
    assert.equal(result.certain.length, 0);
    const assessed = await evaluateTerms(terms, {
      groups: [
        {
          source: { language: "en", fragments: [{ ref: 0, text: "work" }] },
          target: { language: "en", fragments: [{ ref: 0, text: "WORK" }] },
        },
      ],
    });
    assert.equal(assessed.status, "incomplete");
    assert.equal(assessed.problems.length, 0);
  });

  void it("英文检查词界、多词术语仍命中，中日文按字面匹配", async () => {
    const data: TermbaseData = {
      concepts: [
        concept("art", [expression("art", "art")]),
        concept("support", [expression("support", "customer support")]),
        workspace,
        {
          id: "japanese",
          languages: [
            { language: "ja", expressions: [expression("ja", "情報処理学会")] },
          ],
        },
      ],
    };
    const terms = compileTerms(createTermbase(data));
    const en = await findTerms(terms, {
      language: "en",
      fragments: [{ ref: 0, text: "cart; art; customer support; Workspace" }],
    });
    assert.deepEqual(
      en.certain.map((match) => match.text),
      ["art", "customer support"],
    );
    const zh = await findTerms(terms, {
      language: "zh",
      fragments: [{ ref: 0, text: "新建工作区" }],
    });
    assert.equal(zh.certain[0]!.text, "工作区");
    const ja = await findTerms(terms, {
      language: "ja",
      fragments: [{ ref: 0, text: "日本情報処理学会" }],
    });
    assert.equal(ja.certain[0]!.text, "情報処理学会");
  });

  void it("NFC 命中回映 UTF-16 原文位置且保留识别形式", async () => {
    const terms = compileTerms(
      createTermbase({
        concepts: [concept("coffee", [expression("cafe", "café")]), workspace],
      }),
      {
        policyFor: (entry) =>
          entry.conceptId === "workspace" && entry.language === "en"
            ? {
                id: "explicit-plural",
                boundary: "word",
                forms: () => ["workspaces"],
              }
            : undefined,
      },
    );
    const result = await findTerms(terms, {
      language: "en",
      fragments: [{ ref: "line", text: "😀 cafe\u0301 workspaces" }],
    });
    assert.deepEqual(result.certain[0]!.range, { start: 3, end: 8 });
    assert.equal(result.certain[0]!.text, "cafe\u0301");
    assert.equal(result.certain[1]!.form, "workspaces");
    assert.equal(result.certain[1]!.expressionText, "workspace");
    assert.equal(
      terms.termbase.getExpression("workspace", "en")!.expression.text,
      "workspace",
    );
  });

  void it("自定义区间回映不能切开 UTF-16 代理对", async () => {
    const terms = compileTerms(
      createTermbase({
        concepts: [
          {
            id: "emoji",
            languages: [
              { language: "ja", expressions: [expression("emoji", "😀")] },
            ],
          },
        ],
      }),
      {
        policy: {
          id: "invalid-surrogate-range",
          boundary: "literal",
          normalize: (text) => ({
            ...normalizeText(text),
            mapRange: () => ({ start: 0, end: 1 }),
          }),
        },
      },
    );

    await assert.rejects(
      findTerms(terms, {
        language: "ja",
        fragments: [{ ref: "emoji", text: "😀" }],
      }),
      (error) =>
        error instanceof TermContractError &&
        error.issues.some((issue) => issue.code === "split-surrogate-range"),
    );
  });

  void it("自定义词界政策必须返回布尔值", async () => {
    const terms = compileTerms(createTermbase({ concepts: [workspace] }), {
      policy: {
        id: "invalid-boundary-result",
        boundary: (() => "false") as unknown as () => boolean,
      },
    });

    await assert.rejects(
      findTerms(terms, {
        language: "en",
        fragments: [{ ref: "source", text: "workspace" }],
      }),
      (error) =>
        error instanceof TermContractError &&
        error.issues.some((issue) => issue.code === "invalid-boundary-result"),
    );
  });

  void it("术语保护区间不能切开 UTF-16 代理对", () => {
    const parsed = termComparisonInputSchema["~standard"].validate({
      groups: [
        {
          source: {
            language: "ja",
            fragments: [
              {
                ref: "emoji",
                text: "😀",
                protectedRanges: [{ start: 1, end: 2 }],
              },
            ],
          },
          target: { language: "ja", fragments: [] },
        },
      ],
    });

    assert.ok("issues" in parsed);
  });

  void it("不完整的分词仍保留有已知有效边界的肯定命中", async () => {
    const analysis = createTextAnalysis({
      recognizers: [
        () => ({
          tokens: [{ start: 10, end: 14, kind: "placeholder", protect: true }],
          complete: false,
          issues: [
            { code: "partial-recognition", message: "结构扫描有缺口。" },
          ],
        }),
      ],
      segmenter: () => ({
        words: [{ start: 0, end: 9, text: "workspace" }],
        boundaries: [0, 9],
        complete: true,
        issues: [],
      }),
    });
    const terms = compileTerms(createTermbase({ concepts: [workspace] }), {
      analysis,
    });

    const result = await findTerms(terms, {
      language: "en",
      fragments: [{ ref: "source", text: "workspace ${x}" }],
    });

    assert.equal(result.status, "incomplete");
    assert.equal(result.certain.length, 1);
    assert.equal(result.certain[0]!.text, "workspace");
    assert.deepEqual(result.certain[0]!.range, { start: 0, end: 9 });
    assert.ok(
      result.issues.some((issue) => issue.code === "partial-recognition"),
    );
  });

  void it("独立片段和保护区间不制造跨段或跨区间命中", async () => {
    const terms = compileTerms(createTermbase({ concepts: [workspace] }));
    const result = await findTerms(terms, {
      language: "en",
      fragments: [
        { ref: 0, text: "work" },
        { ref: 1, text: "space" },
        { ref: 2, text: "workspace", protectedRanges: [{ start: 0, end: 9 }] },
        {
          ref: 3,
          text: "work{name}space",
          protectedRanges: [{ start: 4, end: 10 }],
        },
      ],
    });
    assert.equal(result.matches.length, 0);
  });

  void it("有效长表达覆盖仅此处短表达，无效长表达不压掉有效短表达", async () => {
    const base = createTermbase({
      concepts: [
        concept("short", [expression("short", "art")]),
        concept("long", [expression("long", "art gallery")]),
      ],
    });
    const input = {
      language: "en",
      fragments: [{ ref: 0, text: "art gallery; art" }],
    };
    const valid = await findTerms(compileTerms(base), input);
    assert.deepEqual(
      valid.certain.map((match) => match.text),
      ["art gallery", "art"],
    );
    assert.equal(valid.suppressed.length, 1);
    const rejected = await findTerms(
      compileTerms(base, {
        policyFor: (entry) =>
          entry.conceptId === "long"
            ? { id: "reject", boundary: () => false }
            : undefined,
      }),
      input,
    );
    assert.deepEqual(
      rejected.certain.map((match) => match.text),
      ["art", "art"],
    );
  });

  void it("同位置多概念和交叉重叠不任意消歧，独立命中保留", async () => {
    const base = createTermbase({
      concepts: [
        concept("finance", [expression("a", "bank")]),
        concept("river", [expression("b", "bank")]),
        workspace,
        {
          id: "left",
          languages: [
            { language: "zh", expressions: [expression("l", "甲乙")] },
          ],
        },
        {
          id: "right",
          languages: [
            { language: "zh", expressions: [expression("r", "乙丙")] },
          ],
        },
      ],
    });
    const terms = compileTerms(base);
    const en = await findTerms(terms, {
      language: "en",
      fragments: [{ ref: 0, text: "bank workspace" }],
    });
    assert.equal(en.ambiguities.length, 1);
    assert.deepEqual(
      en.certain.map((match) => match.conceptId),
      ["workspace"],
    );
    const zh = await findTerms(terms, {
      language: "zh",
      fragments: [{ ref: 0, text: "甲乙丙" }],
    });
    assert.equal(zh.ambiguities[0]!.reason, "crossing-overlap");
    assert.equal(zh.certain.length, 0);
  });

  void it("能力不足和自定义策略失败不伪装无命中", async () => {
    const terms = compileTerms(
      createTermbase({
        concepts: [
          {
            id: "fr",
            languages: [
              { language: "fr", expressions: [expression("fr", "espace")] },
            ],
          },
        ],
      }),
    );
    const result = await findTerms(terms, {
      language: "fr",
      fragments: [{ ref: 0, text: "espace" }],
    });
    assert.equal(result.status, "incomplete");
    const emptyRange = await findTerms(
      compileTerms(createTermbase({ concepts: [] })),
      { language: "en", fragments: [], complete: false },
    );
    assert.equal(emptyRange.status, "incomplete");
    assert.equal(emptyRange.issues[0]!.code, "incomplete-scope");
    const failure = new Error("fixture failure");
    const failing = compileTerms(createTermbase({ concepts: [workspace] }), {
      policy: {
        id: "fails",
        boundary: async () => {
          throw failure;
        },
      },
    });
    await assert.rejects(
      findTerms(failing, {
        language: "en",
        fragments: [{ ref: 0, text: "workspace" }],
      }),
      (error) => error === failure,
    );
  });
});

void describe("纯术语评估", () => {
  void it("独立分析与判断和完整入口一致，规则分别启用", async () => {
    const terms = compileTerms(createTermbase({ concepts: [workspace] }));
    const input = comparison("workspace workspace", "作业区");
    const analysis = await analyzeTermUse(terms, input);
    const result = assessTermUse(input, analysis);
    assert.deepEqual(await evaluateTerms(terms, input), result);
    assert.deepEqual(
      result.problems.map((problem) => problem.code),
      ["missing-allowed-translation", "forbidden-translation"],
    );
    assert.equal(
      (
        await evaluateTerms(terms, input, {
          rules: [rejectForbiddenTranslation()],
        })
      ).problems.length,
      1,
    );
    assert.equal(
      (
        await evaluateTerms(
          terms,
          comparison("workspace workspace", "工作空间"),
        )
      ).problems.length,
      0,
    );
    assert.throws(
      () => assessTermUse(comparison("workspace", "工作区"), analysis),
      TermContractError,
    );
  });

  void it("源禁用表达仍触发概念，目标资料缺口不误报缺少译法", async () => {
    const terms = compileTerms(
      createTermbase({
        concepts: [
          concept(
            "old",
            [expression("en", "oldspace", "forbidden")],
            [expression("zh", "旧区", "forbidden")],
          ),
        ],
      }),
    );
    const result = await evaluateTerms(terms, comparison("oldspace", "旧区"));
    assert.equal(result.status, "incomplete");
    assert.deepEqual(
      result.problems.map((problem) => problem.code),
      ["forbidden-translation"],
    );
    assert.equal(result.issues[0]!.code, "missing-allowed-expressions");
  });

  void it("目标不完整时保留确定禁用问题，不凭缺失推断缺少允许表达", async () => {
    const terms = compileTerms(createTermbase({ concepts: [workspace] }));
    const original = comparison("workspace", "作业区");
    const input: TermComparisonInput = {
      groups: [
        {
          ...original.groups[0]!,
          target: { ...original.groups[0]!.target, complete: false },
        },
      ],
    };
    const result = await evaluateTerms(terms, input);
    assert.equal(result.status, "incomplete");
    assert.deepEqual(
      result.problems.map((problem) => problem.code),
      ["forbidden-translation"],
    );
    assert.ok(
      result.issues.some((issue) => issue.code === "incomplete-target-scope"),
    );
  });

  void it("局部目标歧义不按禁用优先裁决，其他确定问题不丢失", async () => {
    const terms = compileTerms(
      createTermbase({
        concepts: [
          concept(
            "log",
            [expression("en-log", "log")],
            [
              expression("zh-log", "日志"),
              expression("zh-record", "记录", "forbidden"),
            ],
          ),
          concept(
            "record",
            [expression("en-record", "record")],
            [expression("zh-record", "记录")],
          ),
          workspace,
        ],
      }),
    );
    const result = await evaluateTerms(
      terms,
      comparison("log record workspace", "日志与记录，作业区"),
    );
    assert.equal(result.status, "incomplete");
    assert.ok(
      result.problems.every((problem) => problem.conceptId === "workspace"),
    );
    assert.ok(result.issues.some((issue) => issue.code === "ambiguous-target"));
    const allowedOnly = await evaluateTerms(
      terms,
      comparison("log record", "日志与记录"),
      { rules: [requireAllowedTranslation()] },
    );
    assert.ok(
      allowedOnly.issues.every(
        (issue) => issue.ruleId !== "reject-forbidden-translation",
      ),
    );
  });

  void it("组间目标不互相抵消缺失，同组多片段合法", async () => {
    const terms = compileTerms(createTermbase({ concepts: [workspace] }));
    const first = comparison("workspace", "工作区").groups[0]!;
    const second = comparison("workspace", "其他").groups[0]!;
    const result = await evaluateTerms(terms, { groups: [first, second] });
    assert.deepEqual(
      result.problems.map((problem) => problem.groupIndex),
      [1],
    );
  });

  void it("关闭规则不执行语言策略，schema保留完整性与来源", async () => {
    let executions = 0;
    const terms = compileTerms(createTermbase({ concepts: [workspace] }), {
      policy: {
        id: "count",
        boundary: () => {
          executions += 1;
          return true;
        },
      },
    });
    const input = comparison("workspace", "工作区");
    const memo = createMemoScope();
    const result = await evaluateTerms(terms, input, { rules: [], memo });
    memo.dispose();
    assert.equal(result.status, "complete");
    assert.equal(executions, 0);
    const parsed = termComparisonInputSchema["~standard"].validate(input);
    assert.deepEqual("value" in parsed ? parsed.value : null, input);
    assert.equal(
      (await evaluateTerms(terms, comparison("nothing", "作业区"))).problems
        .length,
      0,
    );
  });
});
