import assert from "node:assert/strict";
import { test } from "node:test";

import { createMemoScope } from "@lioni/memo";

import {
  compileTerms,
  createTermbase,
  findTerms,
  type TermTextInput,
} from "../src/index.ts";

void test("识别缓存复用等价输入并随文本、范围、语言和概念失效", async () => {
  let boundaryCalls = 0;
  const terms = compileTerms(
    createTermbase({
      concepts: [
        {
          id: "first",
          languages: [
            {
              language: "en",
              expressions: [
                { id: "first-en", text: "alpha", usage: "preferred" },
              ],
            },
            {
              language: "zh",
              expressions: [{ id: "first-zh", text: "甲", usage: "allowed" }],
            },
          ],
        },
        {
          id: "second",
          languages: [
            {
              language: "en",
              expressions: [
                { id: "second-en", text: "beta", usage: "preferred" },
              ],
            },
            {
              language: "zh",
              expressions: [{ id: "second-zh", text: "乙", usage: "allowed" }],
            },
          ],
        },
      ],
    }),
    {
      policy: {
        id: "count-boundary",
        boundary: () => {
          boundaryCalls += 1;
          return true;
        },
      },
    },
  );
  const memo = createMemoScope();
  const search = (
    text: string,
    options: {
      readonly language?: string;
      readonly ref?: string;
      readonly complete?: boolean;
      readonly protectedRanges?: readonly {
        readonly start: number;
        readonly end: number;
      }[];
      readonly conceptIds?: readonly string[];
    } = {},
  ) => {
    const input: TermTextInput = {
      language: options.language ?? "en",
      fragments: [
        {
          ref: options.ref ?? "line-1",
          text,
          ...(options.protectedRanges === undefined
            ? {}
            : { protectedRanges: options.protectedRanges }),
        },
      ],
      ...(options.complete === undefined ? {} : { complete: options.complete }),
    };
    return findTerms(terms, input, {
      memo,
      ...(options.conceptIds === undefined
        ? {}
        : { conceptIds: options.conceptIds }),
    });
  };

  const first = await search("alpha");
  const equivalent = await search("alpha");
  assert.equal(first.certain[0]!.conceptId, "first");
  assert.equal(equivalent.certain[0]!.conceptId, "first");
  assert.equal(boundaryCalls, 1);

  assert.equal((await search("beta")).certain[0]!.conceptId, "second");
  assert.equal(boundaryCalls, 2);

  const changedRef = await search("alpha", { ref: "line-2" });
  assert.equal(changedRef.certain[0]!.ref, "line-2");
  assert.equal(boundaryCalls, 3);

  const changedLanguage = await search("甲", { language: "zh" });
  assert.equal(changedLanguage.certain[0]!.conceptId, "first");
  assert.equal(boundaryCalls, 4);

  const protectedResult = await search("甲", {
    language: "zh",
    protectedRanges: [{ start: 0, end: 1 }],
  });
  assert.equal(protectedResult.matches.length, 0);

  const incomplete = await search("甲", { language: "zh", complete: false });
  assert.equal(incomplete.status, "incomplete");
  assert.equal(incomplete.issues[0]!.code, "incomplete-scope");
  assert.equal(boundaryCalls, 5);

  const outsideScope = await search("甲", {
    language: "zh",
    conceptIds: ["second"],
  });
  assert.equal(outsideScope.matches.length, 0);
  const insideScope = await search("甲", {
    language: "zh",
    conceptIds: ["first"],
  });
  assert.equal(insideScope.certain[0]!.conceptId, "first");
  assert.equal(boundaryCalls, 6);

  memo.dispose();
});
