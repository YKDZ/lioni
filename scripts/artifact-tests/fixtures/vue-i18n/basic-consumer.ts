import assert from "node:assert/strict";

import { runQa, defineConfig } from "@boringparts/lioni";
import { createVueI18nTargetSyntaxChecker } from "@boringparts/lioni";
import { z } from "zod";

{
  const config = defineConfig({
    source: {
      schema: z.object({ key: z.string(), source: z.string() }),
      read: () => ({
        scopes: [
          {
            range: "en.json",
            enumeration: "complete" as const,
            records: [
              {
                value: { key: "greeting", source: "Hello" },
                bodyAvailability: "available" as const,
              },
            ],
          },
        ],
      }),
    },
    keyOf: (unit) => unit.key,
    translations: {
      languages: ["fr"],
      schema: z.object({ key: z.string(), text: z.string() }),
      contentSchema: z.string(),
      contentOf: (item) => item.text,
      keyOf: (item) => item.key,
      read: () => ({
        scopes: [
          {
            range: "fr.json",
            covers: ["greeting"],
            enumeration: "complete" as const,
            records: [
              {
                value: { key: "greeting", text: "Salut" },
                bodyAvailability: "available" as const,
              },
            ],
          },
        ],
      }),
    },
    quality: { checks: [createVueI18nTargetSyntaxChecker()] },
  });
  const report = await runQa(config, {
    candidates: [{ sourceKey: "greeting", language: "fr", content: "bad }" }],
  });
  assert.equal(report.diagnostics.length, 1);
  assert.equal(report.diagnostics[0]?.location.range, "fr.json");
  assert.deepEqual(report.diagnostics[0]?.location.span, { start: 4, end: 4 });
}

{
  const create = (
    prepare?: import("@boringparts/lioni").VueI18nPreparer<
      { key: string; source: { text: string } },
      { key: string; text: string },
      { text: string }
    >,
  ) =>
    defineConfig({
      source: {
        schema: z.object({
          key: z.string(),
          source: z.object({ text: z.string() }),
        }),
        read: () => ({
          scopes: [
            {
              range: "source",
              enumeration: "complete" as const,
              records: [
                {
                  value: { key: "a", source: { text: "Hello" } },
                  bodyAvailability: "available" as const,
                },
              ],
            },
          ],
        }),
      },
      keyOf: (unit) => unit.key,
      translations: {
        languages: ["fr"],
        schema: z.object({ key: z.string(), text: z.string() }),
        contentSchema: z.object({ text: z.string() }),
        keyOf: (item) => item.key,
        contentOf: (item) => ({ text: item.text }),
        read: () => ({ scopes: [] }),
      },
      quality: {
        checks: [
          createVueI18nTargetSyntaxChecker({
            id: "syntax",
            ...(prepare ? { prepare } : {}),
          }),
        ],
      },
    });
  const candidate = {
    sourceKey: "a",
    language: "fr",
    content: { text: "bad }" },
  };
  await assert.rejects(
    runQa(create(), { candidates: [candidate] }),
    /syntax.*a.*fr/u,
  );
  const ready = await runQa(
    create(({ candidate, sourceUnit, translation }) =>
      candidate === null
        ? null
        : {
            key: sourceUnit.key,
            language: candidate.language,
            source: { status: "available", text: sourceUnit.unit.source.text },
            target: { status: "available", text: candidate.content.text },
            locations: {
              source: { language: null, range: null },
              target: {
                language: candidate.language,
                range: translation?.range ?? "new-message",
              },
            },
          },
    ),
    { candidates: [candidate] },
  );
  assert.equal(ready.diagnostics[0]?.location.range, "new-message");
  assert.deepEqual(ready.diagnostics[0]?.location.span, { start: 4, end: 4 });
  const skipped = await runQa(
    create(() => null),
    { candidates: [candidate] },
  );
  assert.deepEqual(skipped.diagnostics, []);
  assert.deepEqual(skipped.checks[0]?.coverage, { selected: 1, evaluated: 1 });
}
