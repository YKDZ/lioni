import assert from "node:assert/strict";

import {
  createMissingTranslationChecker,
  createSameTextChecker,
  decideQualityReport,
  defineChecker,
  defineConfig,
  runQa,
  type JsonValue,
  type QualityFinding,
} from "@lioni/lioni";
import { loadConfig } from "@lioni/lioni/node";
import * as z from "zod";

const mode = process.argv[2];
const config = await loadConfig(
  mode === "zero" ? "no-checks.config.ts" : "lioni.config.ts",
);
if (mode === "draft") {
  const report = await runQa(config, {
    candidates: [{ sourceKey: "button", language: "fr", content: "Ouvrir" }],
  });
  assert.equal(report.progress, undefined);
  assert.equal(report.diagnostics.length, 0);

  // 可读空字符串满足缺译存在性要求；同文草稿则转为同文诊断。
  const emptyDraft = await runQa(config, {
    candidates: [{ sourceKey: "button", language: "fr", content: "" }],
  });
  assert.equal(emptyDraft.progress, undefined);
  assert.deepEqual(emptyDraft.diagnostics, []);

  const sameTextDraft = await runQa(config, {
    candidates: [{ sourceKey: "button", language: "fr", content: "Open" }],
  });
  assert.deepEqual(
    sameTextDraft.diagnostics.map(({ checkId, object }) => [
      checkId,
      object.key,
    ]),
    [["same-text", "button"]],
  );

  // 两项内置规则可独立启用或关闭。
  const onlyMissing = await runQa({
    ...config,
    quality: { checks: [createMissingTranslationChecker()] },
  });
  assert.deepEqual(
    onlyMissing.diagnostics.map(({ checkId, object }) => [checkId, object.key]),
    [["missing-translation", "button"]],
  );

  const onlySameText = await runQa({
    ...config,
    quality: { checks: [createSameTextChecker()] },
  });
  assert.deepEqual(
    onlySameText.diagnostics.map(({ checkId, object }) => [
      checkId,
      object.key,
    ]),
    [["same-text", "brand"]],
  );

  // 已有记录但正文不可读，或正文不是字符串时，均直接抛错拒绝。
  const textUnitSchema = z.object({ key: z.string(), source: z.string() });
  const textTranslationSchema = z.object({ key: z.string(), text: z.string() });
  const unavailableTranslationSchema = z.object({
    key: z.string(),
    reason: z.string(),
  });
  const readUnavailableTranslations = (
    _language: string,
    units: readonly { readonly key: string }[],
  ) => ({
    scopes: [
      {
        range: "fr.json",
        enumeration: "complete" as const,
        covers: units.map(({ key }) => key),
        records: [
          {
            value: { key: "button", reason: "unreadable" },
            bodyAvailability: "unavailable" as const,
          },
        ],
      },
    ],
  });
  for (const [check, pattern] of [
    [createMissingTranslationChecker(), /缺少可靠的译文读取依据/u],
    [createSameTextChecker(), /无法读取候选正文以检查同文/u],
  ] as const) {
    await assert.rejects(
      runQa(
        defineConfig({
          source: {
            schema: textUnitSchema,
            read: () => ({
              scopes: [
                {
                  range: "source.json",
                  enumeration: "complete",
                  records: [
                    {
                      value: { key: "button", source: "Open" },
                      bodyAvailability: "available",
                    },
                  ],
                },
              ],
            }),
          },
          keyOf: ({ key }) => key,
          translations: {
            languages: ["fr"],
            schema: textTranslationSchema,
            unavailableSchema: unavailableTranslationSchema,
            contentSchema: z.string(),
            keyOf: ({ key }) => key,
            contentOf: ({ text }) => text,
            read: readUnavailableTranslations,
          },
          quality: { checks: [check] },
        }),
      ),
      pattern,
    );
  }

  const jsonSchema: z.ZodType<JsonValue, JsonValue> = z.json();
  await assert.rejects(
    runQa(
      defineConfig({
        source: {
          schema: z.object({ key: z.string(), source: jsonSchema }),
          read: () => ({
            scopes: [
              {
                range: "source.json",
                enumeration: "complete",
                records: [
                  {
                    value: { key: "greeting", source: { text: "Hello" } },
                    bodyAvailability: "available",
                  },
                ],
              },
            ],
          }),
        },
        keyOf: ({ key }) => key,
        translations: {
          languages: ["fr"],
          schema: z.object({ key: z.string(), text: jsonSchema }),
          contentSchema: jsonSchema,
          keyOf: ({ key }) => key,
          contentOf: ({ text }) => text,
          read: (_language, units) => ({
            scopes: [
              {
                range: "fr.json",
                enumeration: "complete",
                covers: units.map(({ key }) => key),
                records: [
                  {
                    value: { key: "greeting", text: { text: "Hello" } },
                    bodyAvailability: "available",
                  },
                ],
              },
            ],
          }),
        },
        quality: { checks: [createSameTextChecker()] },
      }),
    ),
    /字符串正文/u,
  );
} else if (mode === "zero") {
  const report = await runQa(config);
  assert.equal(report.checkScope.configuredCount, 0);
  assert.deepEqual(report.progress, [
    { language: "fr", completed: 10, total: 10, percentage: 100 },
  ]);
  assert.equal(decideQualityReport(report).status, "no-checks");
  process.stdout.write(JSON.stringify(report));
} else if (mode === "severity") {
  // 同一项有两条诊断仍只扣一项，提示和警告都影响进度。
  const report = await runQa({
    ...config,
    quality: {
      checks: [
        defineChecker({
          id: "tone",
          version: "1",
          inputSchema: z.object({ key: z.string(), language: z.string() }),
          prepare: ({ association }) => ({
            key: association.sourceKey,
            language: association.language,
          }),
          check: (subject): readonly QualityFinding[] =>
            subject.key === "brand"
              ? []
              : (subject.key === "button"
                  ? (["info", "warning"] as const)
                  : (["info"] as const)
                ).map((severity) => ({
                  severity,
                  object: { kind: "translation-unit", ...subject },
                  location: { ...subject, range: null },
                  message: "待复核。",
                  evidence: [],
                })),
        }),
      ],
    },
  });
  assert.equal(report.diagnostics.length, 3);
  assert.equal(report.progress?.[0]?.completed, 1);
} else {
  process.stdout.write(JSON.stringify(await runQa(config)));
}
