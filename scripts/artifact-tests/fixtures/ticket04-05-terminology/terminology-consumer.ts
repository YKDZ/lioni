import assert from "node:assert/strict";

import {
  compileTerms,
  createTermbase,
  evaluateTerms,
  findTerms,
  selectTerms,
  type TermbaseData,
  type TermComparisonInput,
} from "@lioni/terminology";

const data: TermbaseData = {
  concepts: [
    {
      id: "workspace",
      languages: [
        {
          language: "en",
          expressions: [
            { id: "workspace-en", text: "workspace", usage: "preferred" },
          ],
        },
        {
          language: "zh",
          definition: {
            text: "可共同编辑项目资料的工作区域。",
            sourceRefs: ["host:docs"],
          },
          expressions: [
            { id: "workspace-zh", text: "工作区", usage: "allowed" },
            { id: "workspace-old", text: "作业区", usage: "forbidden" },
          ],
        },
      ],
    },
  ],
};

const termbase = createTermbase(data);
const selected = selectTerms(termbase, {
  concept: ({ id }) => id === "workspace",
  expression: ({ language, expression }) =>
    language !== "zh" || expression.id !== "workspace-old",
});
const compiled = compileTerms(selected);
const english = await findTerms(compiled, {
  language: "en",
  fragments: [{ ref: "line-1", text: "cart; workspace" }],
});
assert.deepEqual(
  english.certain.map(({ text }) => text),
  ["workspace"],
);

const comparison: TermComparisonInput = {
  groups: [
    {
      ref: "workspace",
      source: {
        language: "en",
        fragments: [{ ref: "source", text: "workspace" }],
      },
      target: {
        language: "zh",
        fragments: [{ ref: "candidate", text: "工作区" }],
      },
    },
  ],
};
assert.deepEqual((await evaluateTerms(compiled, comparison)).problems, []);

const forbiddenTerms = compileTerms(createTermbase(data));
const forbidden = await evaluateTerms(forbiddenTerms, {
  groups: [
    {
      ref: "workspace",
      source: {
        language: "en",
        fragments: [{ ref: "source", text: "workspace" }],
      },
      target: {
        language: "zh",
        fragments: [{ ref: "candidate", text: "作业区" }],
      },
    },
  ],
});
assert.deepEqual(
  forbidden.problems.map(({ code }) => code),
  ["missing-allowed-translation", "forbidden-translation"],
);
