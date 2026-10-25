import assert from "node:assert/strict";

import { createMemoScope } from "@lioni/memo";
import {
  createTermbase,
  compileTerms,
  analyzeTermUse,
  assessTermUse,
  evaluateTerms,
  discoverTerms,
  type TermComparisonInput,
} from "@lioni/terminology";
import { normalizeText } from "@lioni/text-analysis";

const base = createTermbase({
  concepts: [
    {
      id: "workspace",
      languages: [
        {
          language: "en",
          expressions: [
            { id: "en-workspace", text: "workspace", usage: "preferred" },
          ],
        },
        {
          language: "zh-CN",
          expressions: [
            { id: "zh-workspace", text: "工作区", usage: "preferred" },
            { id: "zh-allowed", text: "工作空间", usage: "allowed" },
            { id: "zh-forbidden", text: "作业区", usage: "forbidden" },
          ],
        },
      ],
    },
  ],
});
const terms = compileTerms(base);
const comparison: TermComparisonInput = {
  groups: [
    {
      ref: "save-workspace",
      source: {
        language: "en",
        fragments: [{ ref: ["labels", 0], text: "Save workspace" }],
      },
      target: {
        language: "zh-CN",
        fragments: [{ ref: { field: "label" }, text: "保存作业区" }],
      },
    },
  ],
};
const memo = createMemoScope();
try {
  const analysis = await analyzeTermUse(terms, comparison, { memo });
  const report = assessTermUse(comparison, analysis);
  assert.equal(report.status, "complete");
  assert.deepEqual(report.problems.map(({ code }) => code).sort(), [
    "forbidden-translation",
    "missing-allowed-translation",
  ]);
  assert.deepEqual(await evaluateTerms(terms, comparison, { memo }), report);
  assert.equal(analysis.groups[0]?.source.certain[0]?.text, "workspace");
  const corrected: TermComparisonInput = {
    groups: [
      {
        ...comparison.groups[0]!,
        target: {
          language: "zh-CN",
          fragments: [{ ref: "label", text: "保存工作空间" }],
        },
      },
    ],
  };
  assert.equal(
    (await evaluateTerms(terms, corrected, { memo })).problems.length,
    0,
  );
  const partial: TermComparisonInput = {
    groups: [
      {
        ...comparison.groups[0]!,
        target: { language: "zh-CN", fragments: [], complete: false },
      },
    ],
  };
  const incomplete = await evaluateTerms(terms, partial, { memo });
  assert.equal(incomplete.status, "incomplete");
  assert.equal(incomplete.problems.length, 0);

  const normalized = normalizeText("e\u0301");
  assert.equal(normalized.text, "é");
  assert.deepEqual(normalized.mapRange({ start: 0, end: 1 }), {
    start: 0,
    end: 2,
  });
  const discovered = await discoverTerms(
    {
      language: "en",
      entries: [
        { ref: "a", fragments: [{ ref: "a", text: "workspace access" }] },
        { ref: "b", fragments: [{ ref: "b", text: "workspace policy" }] },
      ],
    },
    { memo, minOccurrences: 2 },
  );
  const candidate = discovered.candidates.find(
    ({ text }) => text === "workspace",
  );
  assert.equal(candidate?.occurrences, 2);
  assert.equal(candidate.entryCount, 2);
} finally {
  memo.dispose();
}
console.log(
  "独立术语消费者：无 core/checks 依赖，公开声明、分离分析与判断、允许/禁用规则、覆盖缺口和候选统计通过。",
);
