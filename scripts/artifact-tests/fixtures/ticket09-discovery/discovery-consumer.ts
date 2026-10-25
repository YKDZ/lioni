import assert from "node:assert/strict";

import { createMemoScope } from "@lioni/memo";
import {
  discoverTerms,
  type TermCandidateGenerator,
  type TermCandidateRanker,
  type TermDiscoveryCorpus,
} from "@lioni/terminology";
import { createTextAnalysis, segmentWords } from "@lioni/text-analysis";

const corpus: TermDiscoveryCorpus = {
  language: "en",
  entries: [
    {
      ref: "ui-open",
      fragments: [{ ref: "button", text: "Open workspace" }],
    },
    {
      ref: "ui-save",
      fragments: [{ ref: "label", text: "Save workspace" }],
    },
    {
      ref: "help-page",
      fragments: [
        { ref: "paragraph", text: "Open the workspace to continue." },
      ],
    },
  ],
};

let segmenterCalls = 0;
const analysis = createTextAnalysis({
  segmenter(input) {
    segmenterCalls += 1;
    return segmentWords(input);
  },
});
const memo = createMemoScope();
const discovered = await discoverTerms(corpus, {
  analysis,
  memo,
  maxWords: 2,
  maxExamples: 2,
});
const workspace = discovered.candidates.find(
  (candidate) => candidate.text === "workspace",
);
assert.ok(workspace);
assert.equal(workspace.occurrences, 3);
assert.equal(workspace.entryCount, 3);
assert.equal(workspace.examples.length, 2);
assert.equal(workspace.examplesTruncated, true);
assert.deepEqual(workspace.examples[0]?.range, { start: 5, end: 14 });
assert.equal(workspace.examples[0]?.context, "Open workspace");
assert.equal(discovered.status, "complete");

await discoverTerms(corpus, { analysis, memo, maxWords: 2, maxExamples: 2 });
assert.equal(segmenterCalls, 3);

const candidateGenerator: TermCandidateGenerator = ({ words }) =>
  words
    .filter(({ text }) => text.toLowerCase().startsWith("open"))
    .map(({ start, end }) => ({ start, end }));
const candidateRanker: TermCandidateRanker = (candidate) => ({
  method: "entry-coverage",
  score: candidate.entryCount,
});
const customized = await discoverTerms(corpus, {
  analysis,
  memo,
  maxWords: 1,
  candidateGenerator,
  candidateRanker,
});
assert.ok(
  customized.candidates.every(({ text }) => text.toLowerCase() === "open"),
);
assert.ok(
  customized.candidates.every(
    ({ ranking }) => ranking.method === "entry-coverage",
  ),
);
assert.equal(segmenterCalls, 3);

const partial = await discoverTerms({ ...corpus, complete: false });
assert.equal(partial.status, "incomplete");
assert.equal(partial.issues[0]?.code, "incomplete-corpus");

memo.dispose();
