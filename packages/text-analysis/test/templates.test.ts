import assert from "node:assert/strict";
import test from "node:test";

import {
  asciiNumbers,
  braceVariables,
  createSignatureEquivalence,
  createTemplateSignature,
  createTextAnalysis,
  signatureKey,
} from "@lioni/text-analysis";
import type { TemplateOptions } from "@lioni/text-analysis";

const numericPolicy: TemplateOptions = {
  abstract: (token) =>
    token.kind === "number"
      ? { kind: "code", identity: "error-code" }
      : undefined,
};

await test("显式数字槽位忽略值而保留次数、顺序及固定表达", async () => {
  const analysis = createTextAnalysis({ recognizers: [asciiNumbers()] });
  const first = await analysis.signature(
    { text: "Error Code 004", language: "en" },
    numericPolicy,
  );
  const second = await analysis.signature(
    { text: "Error Code 504", language: "en" },
    numericPolicy,
  );
  const different = await analysis.signature(
    { text: "Error 504", language: "en" },
    numericPolicy,
  );
  const repeated = await analysis.signature(
    { text: "Error Code 504 404", language: "en" },
    numericPolicy,
  );
  assert.equal(signatureKey(first), signatureKey(second));
  assert.notEqual(signatureKey(first), signatureKey(different));
  assert.notEqual(signatureKey(first), signatureKey(repeated));
  assert.equal(first.slots[0]?.raw, "004");
  assert.equal(first.slots[0]?.value, "004");
  const literalFirst = await analysis.signature(
    { text: "Error Code 004", language: "en" },
    { abstract: () => undefined },
  );
  const literalSecond = await analysis.signature(
    { text: "Error Code 504", language: "en" },
    { abstract: () => undefined },
  );
  assert.notEqual(signatureKey(literalFirst), signatureKey(literalSecond));
});

await test("命名槽位身份与本语言内换序保持可见，不要求源目标语序相同", async () => {
  const analysis = createTextAnalysis({ recognizers: [braceVariables()] });
  const policy: TemplateOptions = {
    abstract: (token) => ({
      kind: token.kind,
      identity: token.identity as string,
    }),
  };
  const a = await analysis.signature(
    { text: "{sender} 给 {receiver}", language: "zh" },
    policy,
  );
  const b = await analysis.signature(
    { text: "{receiver} 给 {sender}", language: "zh" },
    policy,
  );
  assert.notEqual(signatureKey(a), signatureKey(b));
  const source = await analysis.signature(
    { text: "{user} sent {count} messages", language: "en" },
    policy,
  );
  const target = await analysis.signature(
    { text: "{count} 条消息由 {user} 发送", language: "zh" },
    policy,
  );
  assert.deepEqual(
    source.slots.map((slot) => slot.identity),
    ["user", "count"],
  );
  assert.deepEqual(
    target.slots.map((slot) => slot.identity),
    ["count", "user"],
  );
});

await test("显式等价签名组支持多种表达，未列入表达保留自身类别", async () => {
  const analysis = createTextAnalysis({ recognizers: [asciiNumbers()] });
  const a = await analysis.signature(
    { text: "错误码 404", language: "zh" },
    numericPolicy,
  );
  const b = await analysis.signature(
    { text: "错误代码 504", language: "zh" },
    numericPolicy,
  );
  const c = await analysis.signature(
    { text: "错误 504", language: "zh" },
    numericPolicy,
  );
  const equivalent = createSignatureEquivalence([[a, b]]);
  assert.equal(equivalent(a), equivalent(b));
  assert.equal(equivalent(c), signatureKey(c));
  assert.notEqual(equivalent(a), equivalent(c));
  const transitive = createSignatureEquivalence([
    [a, b],
    [b, c],
  ]);
  assert.equal(transitive(a), transitive(c));
  const structure = await analysis.structures({
    text: "错误码 004",
    language: "zh",
  });
  assert.equal(
    signatureKey(createTemplateSignature(structure, numericPolicy)),
    signatureKey(a),
  );
});

await test("外部抽象策略的非法槽位身份明确拒绝", async () => {
  const structure = await createTextAnalysis({
    recognizers: [asciiNumbers()],
  }).structures({ text: "404", language: "en" });
  for (const value of [
    null,
    "code",
    { kind: 1, identity: "code" },
    { kind: "code", identity: [] },
    { kind: "code", identity: "" },
  ]) {
    const options = { abstract: () => value } as unknown as TemplateOptions;
    assert.throws(() => createTemplateSignature(structure, options), {
      code: "invalid-slot",
    });
  }
});
