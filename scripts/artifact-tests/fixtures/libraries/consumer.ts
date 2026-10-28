import assert from "node:assert/strict";

import {
  asciiNumbers,
  compareProtectedLiterals,
  compareQuantityBranches,
  compileTerms,
  createMemoScope,
  createTextAnalysis,
  evaluateTerms,
} from "lioni";
import { loadTermbaseYaml } from "lioni/node";

const memo = createMemoScope();
try {
  let calls = 0;
  const count = memo.memo(() => ++calls);
  assert.equal(count(), count());
  assert.equal(calls, 1);

  const analysis = createTextAnalysis({ recognizers: [asciiNumbers()] });
  const result = await analysis.structures(
    { text: "Error 004", language: "en" },
    { memo },
  );
  assert.equal(result.complete, true);
  assert.deepEqual(
    result.tokens.map(({ value }) => value),
    ["004"],
  );

  // 从安装后的 /node 入口读取资源，覆盖仅靠源码测试发现不了的发布边界。
  const termbase = await loadTermbaseYaml(
    new URL("./termbase/", import.meta.url),
  );
  assert.equal(termbase.getExpression("service", "service-en")?.language, "en");
  const report = await evaluateTerms(
    compileTerms(termbase),
    {
      groups: [
        {
          ref: "label",
          source: {
            language: "en",
            fragments: [{ ref: "label", text: "service" }],
          },
          target: {
            language: "zh-CN",
            fragments: [{ ref: "label", text: "服务" }],
          },
        },
      ],
    },
    { memo },
  );
  assert.equal(report.status, "complete");
  assert.deepEqual(report.problems, []);

  assert.deepEqual(
    compareProtectedLiterals({
      source: "HTTP service",
      target: "HTTP 服务",
      literals: ["HTTP"],
    }),
    [],
  );
  assert.deepEqual(
    compareQuantityBranches({
      source: [{ values: ["1"] }],
      target: [{ values: ["2"] }],
    }),
    [{ targetBranchIndex: 0, missing: ["1"], extra: ["2"] }],
  );
} finally {
  memo.dispose();
}
