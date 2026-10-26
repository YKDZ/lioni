import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  defineConfig,
  evaluateCompletion,
  readCompletion,
  readFacts,
} from "../src/index.ts";
import {
  jsonValueSchema,
  schemaFromExamples,
  sourceSchemaFromExamples,
  fixtureTranslationIdentity,
} from "./source-schema.ts";

void describe("completion", () => {
  void it("counts every known source and selected language, including a resource-free language", async () => {
    const units = [
      { source: "Save", context: { file: "messages.ts", line: 18 } },
      { source: "Submit", context: { file: "messages.ts", line: 19 } },
    ];
    const result = await readCompletion(
      defineConfig({
        source: {
          schema: sourceSchemaFromExamples(...units),
          read: () => ({
            scopes: [
              {
                range: "messages.ts",
                enumeration: "complete",
                records: units.map((value) => ({
                  value,
                  bodyAvailability: "available",
                })),
              },
            ],
          }),
        },
        keyOf: (unit) => `${unit.context.file}:${unit.context.line}`,
        translations: {
          languages: ["fr", "de"],
          identityOf: fixtureTranslationIdentity,
          schema: schemaFromExamples({
            id: "example-save",
            text: "Save",
            context: { sourceLine: 18 },
          }),
          contentSchema: jsonValueSchema,
          read(language, sourceUnits) {
            return {
              scopes: [
                {
                  range: `catalogue.${language}`,
                  covers: sourceUnits.map(({ key }) => key),
                  enumeration: "complete",
                  records:
                    language === "fr"
                      ? [
                          {
                            value: {
                              id: "save-fr",
                              text: "Save",
                              context: { sourceLine: 18 },
                            },
                            bodyAvailability: "available",
                          },
                          {
                            value: {
                              id: "legacy-notice-fr",
                              text: "Legacy notice",
                              context: { sourceLine: 999 },
                            },
                            bodyAvailability: "available",
                          },
                        ]
                      : [],
                },
              ],
            };
          },
          matches(unit, translation) {
            return translation.context.sourceLine === unit.context.line;
          },
          contentOf: () => null,
        },
        completion: {
          criterion: "存在实际译文记录",
          resolveCompletion({ translations }) {
            return translations.length > 0;
          },
        },
      }),
    );

    assert.equal(result.completion.factsVersion, result.version);
    assert.equal(result.completion.criterion, "存在实际译文记录");
    assert.equal(result.completion.status, "incomplete");
    assert.deepStrictEqual(result.completion.scope, {
      sourceReadStatus: "complete",
      sourceUnitCount: 2,
      knownSourceUnitCount: 2,
      targetLanguages: ["fr", "de"],
      obligationCount: 4,
      knownObligationCount: 4,
    });
    assert.equal(result.completion.confirmedCompleteCount, 1);
    assert.equal(result.completion.confirmedIncompleteCount, 3);
    assert.equal(result.completion.unknownCount, 0);
    assert.equal(result.completion.completionRate, 0.25);
    assert.deepStrictEqual(
      result.completion.obligations.map(
        ({ sourceKey, language, status, translationIndexes }) => ({
          sourceKey,
          language,
          status,
          translationIndexes,
        }),
      ),
      [
        {
          sourceKey: "messages.ts:18",
          language: "fr",
          status: "complete",
          translationIndexes: [0],
        },
        {
          sourceKey: "messages.ts:19",
          language: "fr",
          status: "incomplete",
          translationIndexes: [],
        },
        {
          sourceKey: "messages.ts:18",
          language: "de",
          status: "incomplete",
          translationIndexes: [],
        },
        {
          sourceKey: "messages.ts:19",
          language: "de",
          status: "incomplete",
          translationIndexes: [],
        },
      ],
    );
    assert.equal(result.translations.records.length, 2);
  });

  void it("keeps known local decisions and reports an unknown total when sources are incomplete", async () => {
    const unit = {
      source: "Save",
      context: { file: "messages.ts", line: 18 },
    };
    const result = await readCompletion(
      defineConfig({
        source: {
          schema: sourceSchemaFromExamples(unit),
          read: () => ({
            scopes: [
              {
                range: "messages.ts",
                enumeration: "partial",
                records: [{ value: unit, bodyAvailability: "available" }],
              },
            ],
          }),
        },
        keyOf: (value) => `${value.context.file}:${value.context.line}`,
        translations: {
          languages: ["fr", "de"],
          identityOf: fixtureTranslationIdentity,
          schema: schemaFromExamples({
            id: "example-save",
            text: "Enregistrer",
            context: { sourceLine: 18 },
          }),
          contentSchema: jsonValueSchema,
          read(language, sourceUnits) {
            if (language === "de") throw new Error("catalogue unavailable");
            return {
              scopes: [
                {
                  range: "catalogue.fr",
                  covers: sourceUnits.map(({ key }) => key),
                  enumeration: "complete",
                  records: [
                    {
                      value: {
                        id: "save-fr",
                        text: "Enregistrer",
                        context: { sourceLine: 18 },
                      },
                      bodyAvailability: "available",
                    },
                  ],
                },
              ],
            };
          },
          matches(sourceUnit, translation) {
            return sourceUnit.context.line === translation.context.sourceLine;
          },
          contentOf: () => null,
        },
        completion: {
          criterion: "记录被标记为完成",
          resolveCompletion: () => true,
        },
      }),
    );

    assert.equal(result.source.totalUnitCount, null);
    assert.equal(result.completion.scope.sourceReadStatus, "incomplete");
    assert.equal(result.completion.scope.sourceUnitCount, null);
    assert.equal(
      result.completion.scope.unknownTotalReason,
      "原文范围未完整枚举，原文总数未知。",
    );
    assert.equal(result.completion.scope.knownSourceUnitCount, 1);
    assert.equal(result.completion.scope.obligationCount, null);
    assert.equal(result.completion.scope.knownObligationCount, 2);
    assert.equal(result.completion.confirmedCompleteCount, 1);
    assert.equal(result.completion.confirmedIncompleteCount, 0);
    assert.equal(result.completion.unknownCount, 1);
    assert.equal(result.completion.completionRate, null);
    assert.equal(result.completion.status, "unknown");
    assert.deepStrictEqual(
      result.completion.obligations.map(({ language, status, reason }) => ({
        language,
        status,
        reason,
      })),
      [
        { language: "fr", status: "complete", reason: undefined },
        {
          language: "de",
          status: "unknown",
          reason: "相关目标语言范围读取失败。",
        },
      ],
    );
  });

  void it("lets the host replace its rule for an identical translation", async () => {
    const facts = await readFacts(
      defineConfig({
        source: {
          schema: sourceSchemaFromExamples({
            source: "Save",
            context: { file: "messages.ts", line: 18 },
          }),
          read: () => ({
            scopes: [
              {
                range: "messages.ts",
                enumeration: "complete",
                records: [
                  {
                    value: {
                      source: "Save",
                      context: { file: "messages.ts", line: 18 },
                    },
                    bodyAvailability: "available",
                  },
                ],
              },
            ],
          }),
        },
        keyOf: (unit) => `${unit.context.file}:${unit.context.line}`,
        translations: {
          languages: ["fr"],
          identityOf: fixtureTranslationIdentity,
          schema: schemaFromExamples({
            id: "example-save",
            text: "Save",
            context: { sourceLine: 18 },
          }),
          contentSchema: jsonValueSchema,
          read(_language, sourceUnits) {
            return {
              scopes: [
                {
                  range: "catalogue.fr",
                  covers: sourceUnits.map(({ key }) => key),
                  enumeration: "complete",
                  records: [
                    {
                      value: {
                        id: "save-fr",
                        text: "Save",
                        context: { sourceLine: 18 },
                      },
                      bodyAvailability: "available",
                    },
                  ],
                },
              ],
            };
          },
          matches(unit, translation) {
            return unit.context.line === translation.context.sourceLine;
          },
          contentOf: () => null,
        },
      }),
    );

    const rejectIdentical = await evaluateCompletion(facts, {
      criterion: "译文必须与原文不同",
      resolveCompletion({ sourceUnit, translations }) {
        return translations[0]?.translation.text !== sourceUnit.unit.source;
      },
    });
    const allowIdentical = await evaluateCompletion(facts, {
      criterion: "存在非空译文",
      resolveCompletion({ translations }) {
        const content = translations[0]?.translation.text;
        return typeof content === "string" && content.trim().length > 0;
      },
    });

    assert.equal(rejectIdentical.obligations[0]?.status, "incomplete");
    assert.equal(rejectIdentical.completionRate, 0);
    assert.equal(allowIdentical.obligations[0]?.status, "complete");
    assert.equal(allowIdentical.completionRate, 1);
  });

  void it("keeps an unavailable translation distinct from a confirmed absence", async () => {
    const result = await readCompletion(
      defineConfig({
        source: {
          schema: sourceSchemaFromExamples({
            source: "Save",
            context: { line: 18 },
          }),
          read: () => ({
            scopes: [
              {
                range: "messages.ts",
                enumeration: "complete",
                records: [
                  {
                    value: { source: "Save", context: { line: 18 } },
                    bodyAvailability: "available",
                  },
                  {
                    value: { source: "Submit", context: { line: 19 } },
                    bodyAvailability: "available",
                  },
                ],
              },
            ],
          }),
        },
        keyOf: (unit) => String(unit.context.line),
        translations: {
          languages: ["fr"],
          identityOf: fixtureTranslationIdentity,
          schema: schemaFromExamples({
            text: "Save",
            context: { line: 18 },
          }),
          unavailableSchema: schemaFromExamples({
            id: "unavailable",
            context: { line: 18 },
          }),
          contentSchema: jsonValueSchema,
          read(_language, sourceUnits) {
            return {
              scopes: [
                {
                  range: "catalogue.fr",
                  covers: sourceUnits.map(({ key }) => key),
                  enumeration: "complete",
                  records: [
                    {
                      value: { id: "unavailable", context: { line: 18 } },
                      bodyAvailability: "unavailable",
                    },
                  ],
                },
              ],
            };
          },
          matches: (unit, translation) =>
            unit.context.line === translation.context.line,
          contentOf: () => null,
        },
        completion: {
          criterion: "要求译文正文可用",
          resolveCompletion({ association, translations }) {
            const translation = translations[0];
            if (translation?.bodyAvailability === "unavailable")
              return {
                status: "unknown",
                reason: "译文记录已发现，但正文不可用。",
              };
            return (
              translation?.bodyAvailability === "available" &&
              typeof translation.content === "string" &&
              association.status === "matched"
            );
          },
        },
      }),
    );

    assert.deepStrictEqual(
      result.completion.obligations.map(
        ({ associationStatus, status, translationIndexes, reason }) => ({
          associationStatus,
          status,
          translationIndexes,
          reason,
        }),
      ),
      [
        {
          associationStatus: "unavailable",
          status: "unknown",
          translationIndexes: [0],
          reason: "译文记录已发现，但正文不可用。",
        },
        {
          associationStatus: "missing",
          status: "incomplete",
          translationIndexes: [],
          reason: undefined,
        },
      ],
    );
    assert.equal(result.completion.confirmedIncompleteCount, 1);
    assert.equal(result.completion.unknownCount, 1);
    assert.equal(result.completion.completionRate, null);
  });
});
