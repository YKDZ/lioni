import assert from "node:assert/strict";

import { analyzeQuality, type TermbaseData } from "@lioni/lioni";

import {
  createConfig,
  getDataReadCounts,
  resetDataReadCounts,
} from "./lioni.config.ts";

const terms: TermbaseData = {
  concepts: [
    {
      id: "hello",
      languages: [
        {
          language: "en",
          expressions: [{ id: "en", text: "Hello", usage: "preferred" }],
        },
        {
          language: "zh-CN",
          expressions: [
            { id: "zh", text: "你好", usage: "allowed" },
            { id: "old", text: "旧称", usage: "forbidden" },
          ],
        },
      ],
    },
  ],
};

resetDataReadCounts();
const syntaxOnly = await analyzeQuality(
  createConfig("你好 {name}", { terms }),
  {
    checkIds: ["vue-i18n/target-syntax"],
  },
);
assert.deepEqual(syntaxOnly.checkScope.selectedIds, ["vue-i18n/target-syntax"]);
assert.equal(syntaxOnly.checks[0]?.executions.length, 1);
assert.deepEqual(getDataReadCounts(), {
  languages: 1,
  policies: 0,
  terms: 0,
});

resetDataReadCounts();
const terminology = await analyzeQuality(
  createConfig("旧称 {name}", { terms }),
  {
    checkIds: [
      "terminology/require-allowed-translation",
      "terminology/reject-forbidden-translation",
    ],
  },
);
assert.deepEqual(terminology.checkScope.selectedIds, [
  "terminology/require-allowed-translation",
  "terminology/reject-forbidden-translation",
]);
assert.ok(
  terminology.checks.every(({ executions }) => executions.length === 1),
);
assert.deepEqual(getDataReadCounts(), {
  languages: 1,
  policies: 0,
  terms: 1,
});
