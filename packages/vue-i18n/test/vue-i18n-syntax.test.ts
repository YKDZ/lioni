import assert from "node:assert/strict";
import test from "node:test";

import {
  checkIds,
  createQualityFixture,
  policyFor,
} from "./quality-fixture.ts";

const candidate = (sourceKey: string, text: string) => ({
  sourceKey,
  language: "fr",
  content: { text },
});

void test("原文与候选语法分别报告，并使用宿主提供的位置", async () => {
  const policy = policyFor({
    sourceMessages: { message: "bad } source" },
    targetMessages: { message: "wrong } target" },
    targetLanguage: "fr",
    sourceRange: "source.json",
    targetRange: "fr.json",
  });
  const result = await createQualityFixture({ policies: [policy] }).run([
    candidate("message", "wrong } target"),
  ]);
  const source = result.diagnostics.find(
    (diagnostic) => diagnostic.checkId === checkIds.sourceSyntax,
  );
  const target = result.diagnostics.find(
    (diagnostic) => diagnostic.checkId === checkIds.targetSyntax,
  );

  assert.equal(source?.severity, "error");
  assert.equal(source?.object.kind, "source-unit");
  assert.equal(source?.location.language, null);
  assert.equal(source?.location.range, "source.json");
  assert.equal(source?.location.key, "message");
  assert.deepEqual(source?.location.span, { start: 4, end: 4 });
  assert.equal(target?.severity, "error");
  assert.equal(target?.object.kind, "translation-unit");
  assert.equal(target?.location.language, "fr");
  assert.equal(target?.location.range, "fr.json");
  assert.deepEqual(target?.location.span, { start: 6, end: 6 });
});

void test("目标独有消息照常解析，显式空候选是有效正文", async () => {
  const policy = policyFor({
    sourceMessages: {},
    targetMessages: { orphan: "bad } target" },
    targetLanguage: "fr",
  });
  const fixture = createQualityFixture({ policies: [policy] });
  const invalid = await fixture.run([candidate("orphan", "bad } target")]);
  const empty = await fixture.run([candidate("orphan", "")]);

  assert.equal(
    invalid.checks.find((item) => item.checkId === checkIds.sourceSyntax)
      ?.status,
    "not-applicable",
  );
  assert.equal(invalid.diagnostics.length, 1);
  assert.equal(invalid.diagnostics[0]?.checkId, checkIds.targetSyntax);
  assert.equal(empty.status, "complete");
  assert.deepEqual(empty.diagnostics, []);
});

void test("变量比较忽略重排但保留身份、重复数和分支形状", async () => {
  const policy = policyFor({
    sourceMessages: {
      reordered: "{name} {name} {0} {n} {'literal'}",
      mismatch: "{name} {name} {0} {n}",
      folded: "{count} item | {count} items",
      dynamic: "{name} @:{route} @:linked",
    },
    targetMessages: {
      reordered: "{n} {'literal'} {0} {name} {name}",
      mismatch: "{name} {0} {count} {extra}",
      folded: "{count} things",
      dynamic: "@:linked {route} {name}",
    },
    targetLanguage: "fr",
  });
  const fixture = createQualityFixture({ policies: [policy] });

  const reordered = await fixture.run([
    candidate("reordered", "{n} {'literal'} {0} {name} {name}"),
  ]);
  const mismatch = await fixture.run([
    candidate("mismatch", "{name} {0} {count} {extra}"),
  ]);
  const folded = await fixture.run([candidate("folded", "{count} things")]);
  const dynamic = await fixture.run([
    candidate("dynamic", "@:linked {route} {name}"),
  ]);
  const malformed = await fixture.run([candidate("reordered", "{name} } {0}")]);

  assert.deepEqual(
    reordered.diagnostics.filter(
      (diagnostic) => diagnostic.checkId === checkIds.variableCorrespondence,
    ),
    [],
  );
  assert.equal(
    mismatch.diagnostics.filter(
      (diagnostic) => diagnostic.checkId === checkIds.variableCorrespondence,
    ).length,
    1,
  );
  assert.deepEqual(
    folded.diagnostics.filter(
      (diagnostic) => diagnostic.checkId === checkIds.variableCorrespondence,
    ),
    [],
  );
  assert.deepEqual(
    dynamic.diagnostics.filter(
      (diagnostic) => diagnostic.checkId === checkIds.variableCorrespondence,
    ),
    [],
  );
  assert.equal(
    malformed.checks.find(
      (item) => item.checkId === checkIds.variableCorrespondence,
    )?.status,
    "incomplete",
  );
});
