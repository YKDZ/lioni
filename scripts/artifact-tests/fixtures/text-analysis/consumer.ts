import assert from "node:assert/strict";

import { createMemoScope } from "@lioni/memo";
import {
  asciiNumbers,
  createTextAnalysis,
  normalizeText,
} from "@lioni/text-analysis";
import type { RecognitionResult, TextRecognizer } from "@lioni/text-analysis";

let recognitions = 0;
const numbers = asciiNumbers();
const recognizer: TextRecognizer = (input) => {
  recognitions += 1;
  return numbers(input);
};
const analysis = createTextAnalysis({ recognizers: [recognizer] });
const memo = createMemoScope();
const input = { text: "Error 004", language: "en" };
const [first, repeated] = await Promise.all([
  analysis.structures(input, { memo }),
  analysis.structures({ ...input }, { memo }),
]);
assert.equal(first, repeated);
assert.equal(recognitions, 1);
assert.deepEqual(first.tokens, [
  { kind: "number", start: 6, end: 9, value: "004" },
]);

const protectedResult = await analysis.structures(
  { ...input, protectedRanges: [{ start: 6, end: 9 }] },
  { memo },
);
assert.deepEqual(protectedResult.tokens, []);
assert.equal(recognitions, 2);

const partial: RecognitionResult = {
  tokens: [{ kind: "number", start: 6, end: 9, value: "004" }],
  complete: false,
  issues: [{ code: "limited", message: "部分数值语法仍未知。" }],
};
const partialStructure = await createTextAnalysis({
  recognizers: [() => partial],
}).structures(input);
assert.equal(partialStructure.complete, false);
assert.equal(partialStructure.tokens.length, 1);
assert.equal(partialStructure.issues[0]?.code, "limited");

const signature = await analysis.signature(input, {
  abstract: () => ({ kind: "number", identity: "count" }),
});
assert.deepEqual(signature.slots, [
  {
    start: 6,
    end: 9,
    kind: "number",
    identity: "count",
    raw: "004",
    value: "004",
  },
]);

const normalized = normalizeText("Cafe\u0301");
assert.equal(normalized.text, "Café");
assert.deepEqual(normalized.mapRange({ start: 3, end: 4 }), {
  start: 3,
  end: 5,
});
memo.dispose();
