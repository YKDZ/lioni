import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  defineConfig,
  DuplicateTranslationUnitKeyError,
  readFacts,
  readComparisonSnapshot,
  readSourceFacts,
  StandardSchemaContractError,
  TranslationIdentityContractError,
} from "../src/index.ts";
import type { FrameworkConfig, StandardSchemaV1 } from "../src/index.ts";
import {
  emptySourceSchema,
  jsonValueSchema,
  schemaFromExamples,
  sourceSchemaFromExamples,
  fixtureTranslationIdentity,
} from "./source-schema.ts";

type StructuredSource = string | readonly string[] | { readonly text: string };

type ManualUnit = {
  readonly source: StructuredSource;
  readonly context: { readonly file: string; readonly line: number };
};

const manualSourceSchema: StandardSchemaV1<ManualUnit, ManualUnit> = {
  "~standard": {
    version: 1,
    vendor: "lioni-test",
    validate(value) {
      return isManualUnit(value)
        ? { value }
        : { issues: [{ message: "原文单元结构不匹配。" }] };
    },
  },
};

const asyncManualSourceSchema: StandardSchemaV1<ManualUnit, ManualUnit> = {
  "~standard": {
    version: 1,
    vendor: "lioni-test",
    async validate(value) {
      return isManualUnit(value)
        ? { value }
        : { issues: [{ message: "原文单元结构不匹配。" }] };
    },
  },
};

function isManualUnit(value: unknown): value is ManualUnit {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const unit = value as Record<string, unknown>;
  if (typeof unit.context !== "object" || unit.context === null) return false;
  const context = unit.context as Record<string, unknown>;
  if (
    typeof context.file !== "string" ||
    typeof context.line !== "number" ||
    !Number.isFinite(context.line)
  )
    return false;
  if (typeof unit.source === "string") return true;
  if (Array.isArray(unit.source))
    return unit.source.every((entry) => typeof entry === "string");
  return (
    typeof unit.source === "object" &&
    unit.source !== null &&
    !Array.isArray(unit.source) &&
    typeof (unit.source as Record<string, unknown>).text === "string"
  );
}

function completeSource<T>(...values: readonly T[]) {
  return {
    scopes: [
      {
        range: "source",
        enumeration: "complete" as const,
        records: values.map((value) => ({
          value,
          bodyAvailability: "available" as const,
        })),
      },
    ],
  };
}

void describe("framework facts", () => {
  void it("validates synchronous and asynchronous source schemas without changing structure", async () => {
    const units: ManualUnit[] = [
      {
        source: "Save",
        context: { file: "messages.ts", line: 1 },
      },
      {
        source: ["first", "second"],
        context: { file: "messages.ts", line: 2 },
      },
      {
        source: { text: "Submit" },
        context: { file: "messages.ts", line: 3 },
      },
      {
        source: "first",
        context: { file: "messages.ts", line: 4 },
      },
      {
        source: "second",
        context: { file: "messages.ts", line: 5 },
      },
    ];
    const facts = await readSourceFacts(
      defineConfig({
        source: {
          schema: manualSourceSchema,
          read: () => completeSource(...units),
        },
        keyOf: (unit) => `${unit.context.file}:${unit.context.line}`,
      }),
    );
    const asyncFacts = await readSourceFacts(
      defineConfig({
        source: {
          schema: asyncManualSourceSchema,
          read: () => completeSource(...units),
        },
        keyOf: (unit) => `${unit.context.file}:${unit.context.line}`,
      }),
    );

    assert.deepStrictEqual(
      facts.units.map(({ unit }) => unit),
      units,
    );
    assert.deepStrictEqual(
      asyncFacts.units.map(({ unit }) => unit),
      units,
    );
  });

  void it("rejects schema mismatches and values that cannot be stored as JSON", async () => {
    const invalidUnit = {
      source: "Save",
      context: { file: "messages.ts", line: 18 },
      hostObject: new Date(0),
    };
    const invalidJsonConfig = defineConfig({
      source: {
        schema: manualSourceSchema,
        read: () => completeSource(invalidUnit),
      },
      keyOf: (unit) => `${unit.context.file}:${unit.context.line}`,
    });
    await assert.rejects(
      readSourceFacts(invalidJsonConfig),
      (error: unknown) =>
        error instanceof StandardSchemaContractError &&
        error.kind === "invalid-json" &&
        /JSON/u.test(error.message),
    );

    const invalidShapeUnit = {
      source: 42,
      context: { file: "messages.ts", line: 18 },
    };
    const schemaMismatchConfig = defineConfig({
      source: {
        schema: manualSourceSchema,
        read: () => completeSource(invalidShapeUnit as unknown as ManualUnit),
      },
      keyOf: (unit) => `${unit.context.file}:${unit.context.line}`,
    });
    await assert.rejects(
      readSourceFacts(schemaMismatchConfig),
      (error: unknown) =>
        error instanceof StandardSchemaContractError &&
        error.kind === "schema-mismatch" &&
        /原文单元 1/u.test(error.message),
    );
  });

  void it("rejects schema output changes and in-place changes to the original unit", async () => {
    const changedOutputSchema: StandardSchemaV1<ManualUnit, ManualUnit> = {
      "~standard": {
        version: 1,
        vendor: "lioni-test",
        validate(value) {
          if (!isManualUnit(value))
            return { issues: [{ message: "原文单元结构不匹配。" }] };
          return {
            value: {
              ...value,
              source:
                typeof value.source === "string"
                  ? `${value.source}!`
                  : value.source,
            },
          };
        },
      },
    };
    const original = {
      source: "Save",
      context: { file: "messages.ts", line: 18 },
    };
    const changedConfig = defineConfig({
      source: {
        schema: changedOutputSchema,
        read: () => completeSource(original),
      },
      keyOf: (unit) => `${unit.context.file}:${unit.context.line}`,
    });
    await assert.rejects(readSourceFacts(changedConfig), {
      name: "StandardSchemaContractError",
      kind: "output-changed",
    });

    const deletedFieldSchema: StandardSchemaV1<ManualUnit, ManualUnit> = {
      "~standard": {
        version: 1,
        vendor: "lioni-test",
        validate(value) {
          if (!isManualUnit(value))
            return { issues: [{ message: "原文单元结构不匹配。" }] };
          return {
            value: {
              source: value.source,
              context: { file: value.context.file },
            } as unknown as ManualUnit,
          };
        },
      },
    };
    const deletedFieldConfig = defineConfig({
      source: {
        schema: deletedFieldSchema,
        read: () => completeSource(original),
      },
      keyOf: (unit) => `${unit.context.file}:${unit.context.line}`,
    });
    await assert.rejects(readSourceFacts(deletedFieldConfig), {
      name: "StandardSchemaContractError",
      kind: "output-changed",
    });

    const inPlaceSchema: StandardSchemaV1<ManualUnit, ManualUnit> = {
      "~standard": {
        version: 1,
        vendor: "lioni-test",
        validate(value) {
          if (!isManualUnit(value))
            return { issues: [{ message: "原文单元结构不匹配。" }] };
          const unchangedResult = structuredClone(value);
          Reflect.deleteProperty(value.context, "line");
          return { value: unchangedResult };
        },
      },
    };
    const inPlaceConfig = defineConfig({
      source: {
        schema: inPlaceSchema,
        read: () => completeSource(original),
      },
      keyOf: (unit) => `${unit.context.file}:${unit.context.line}`,
    });
    await assert.rejects(readSourceFacts(inPlaceConfig), {
      name: "StandardSchemaContractError",
      kind: "input-mutated",
    });
  });

  void it("reads raw source units and derives identity without reading translations", async () => {
    const rawUnit = {
      source: "Save",
      context: {
        file: "src/messages.ts",
        line: 18,
        screenshot: "shots/save-button.png",
      },
    };
    let reads = 0;
    let identityInput: typeof rawUnit | undefined;
    const config = defineConfig({
      source: {
        schema: sourceSchemaFromExamples(rawUnit),
        read() {
          reads += 1;
          return completeSource(rawUnit);
        },
      },
      keyOf(unit) {
        identityInput = unit;
        return `${unit.context.file}:${unit.context.line}`;
      },
    });

    assert.equal(reads, 0);
    const facts = await readSourceFacts(config);

    assert.equal(reads, 1);
    assert.strictEqual(identityInput, rawUnit);
    assert.deepStrictEqual(facts.units, [
      {
        key: "src/messages.ts:18",
        unit: rawUnit,
        bodyAvailability: "available",
        scopeIndex: 0,
      },
    ]);
  });

  void it("reports duplicate identities instead of overwriting a source unit", async () => {
    const duplicateUnits = [
      { source: "Save", context: { file: "src/messages.ts", line: 18 } },
      { source: "Submit", context: { file: "src/messages.ts", line: 18 } },
    ];
    const config = defineConfig({
      source: {
        schema: sourceSchemaFromExamples(...duplicateUnits),
        read: () => completeSource(...duplicateUnits),
      },
      keyOf: (unit) => `${unit.context.file}:${unit.context.line}`,
    });

    await assert.rejects(
      readSourceFacts(config),
      (error: unknown) =>
        error instanceof DuplicateTranslationUnitKeyError &&
        error.key === "src/messages.ts:18" &&
        error.firstIndex === 0 &&
        error.duplicateIndex === 1,
    );
  });

  void it("changes the fact version when non-identity source context changes", async () => {
    const makeConfig = (screenshot: string) =>
      defineConfig({
        source: {
          schema: sourceSchemaFromExamples({
            source: "Save",
            context: {
              file: "src/messages.ts",
              line: 18,
              screenshot,
            },
          }),
          read: () =>
            completeSource({
              source: "Save",
              context: {
                file: "src/messages.ts",
                line: 18,
                screenshot,
              },
            }),
        },
        keyOf: (unit) => `${unit.context.file}:${unit.context.line}`,
      });

    const before = await readSourceFacts(makeConfig("shots/before.png"));
    const after = await readSourceFacts(makeConfig("shots/after.png"));

    assert.equal(before.units[0]?.key, after.units[0]?.key);
    assert.notEqual(before.version, after.version);
  });

  void it("uses changed source identity inputs to produce a new key", async () => {
    const makeConfig = (source: string, file: string) =>
      defineConfig({
        source: {
          schema: sourceSchemaFromExamples({
            source: "Save",
            context: { file: "src/a.ts", line: 18 },
          }),
          read: () => completeSource({ source, context: { file, line: 18 } }),
        },
        keyOf: (unit) =>
          `${unit.context.file}:${unit.context.line}:${unit.source}`,
      });

    const before = await readSourceFacts(makeConfig("Save", "src/a.ts"));
    const after = await readSourceFacts(makeConfig("Submit", "src/b.ts"));

    assert.notEqual(before.units[0]?.key, after.units[0]?.key);
  });

  void it("keeps known source records without claiming a total for a partial read", async () => {
    const knownUnit = {
      source: "Save",
      context: { file: "src/messages.ts", line: 18 },
    };
    const facts = await readSourceFacts(
      defineConfig({
        source: {
          schema: sourceSchemaFromExamples(knownUnit),
          read: () => ({
            scopes: [
              {
                range: "src/messages.ts",
                enumeration: "partial",
                records: [{ value: knownUnit, bodyAvailability: "available" }],
              },
            ],
          }),
        },
        keyOf: (unit) => `${unit.context.file}:${unit.context.line}`,
      }),
    );

    assert.deepStrictEqual(facts.units, [
      {
        key: "src/messages.ts:18",
        unit: knownUnit,
        bodyAvailability: "available",
        scopeIndex: 0,
      },
    ]);
    assert.equal(facts.totalUnitCount, null);
    assert.deepStrictEqual(facts.read.scopes, [
      {
        range: "src/messages.ts",
        enumeration: "partial",
        recordCount: 1,
      },
    ]);
  });

  void it("matches actual records in explicit target languages and keeps target-only records", async () => {
    const units = [
      { source: "Save", context: { file: "src/messages.ts", line: 18 } },
      { source: "Submit", context: { file: "src/messages.ts", line: 19 } },
    ];
    let reads = 0;
    const facts = await readFacts(
      defineConfig({
        source: {
          schema: sourceSchemaFromExamples(...units),
          read: () => completeSource(...units),
        },
        keyOf: (unit) => `${unit.context.file}:${unit.context.line}`,
        translations: {
          languages: ["fr"],
          keyOf: fixtureTranslationIdentity,
          read(language, sourceUnits) {
            reads += 1;
            assert.equal(language, "fr");
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
                    {
                      value: {
                        id: "legacy-notice-fr",
                        text: "Avis",
                        context: { sourceLine: 999 },
                      },
                      bodyAvailability: "available",
                    },
                  ],
                },
              ],
            };
          },
          schema: schemaFromExamples({
            id: "example-save",
            text: "Enregistrer",
            context: { sourceLine: 18 },
          }),
          contentSchema: jsonValueSchema,
          matches(unit, translation) {
            return translation.context.sourceLine === unit.context.line;
          },
          contentOf: () => null,
        },
      }),
    );

    assert.equal(reads, 1);
    assert.deepStrictEqual(
      facts.associations.map(
        ({
          sourceKey,
          language,
          status,
          coverageStatus,
          translationIndexes,
        }) => ({
          sourceKey,
          language,
          status,
          coverageStatus,
          translationIndexes,
        }),
      ),
      [
        {
          sourceKey: "src/messages.ts:18",
          language: "fr",
          status: "matched",
          coverageStatus: "complete",
          translationIndexes: [0],
        },
        {
          sourceKey: "src/messages.ts:19",
          language: "fr",
          status: "missing",
          coverageStatus: "complete",
          translationIndexes: [],
        },
      ],
    );
    assert.equal(facts.translations.records.length, 2);
    assert.deepStrictEqual(facts.translations.records[0], {
      index: 0,
      language: "fr",
      scopeIndex: 0,
      range: "catalogue.fr",
      identity: {
        language: "fr",
        namespace: "fixture",
        key: "save-fr",
      },
      translation: {
        id: "save-fr",
        text: "Enregistrer",
        context: { sourceLine: 18 },
      },
      content: null,
      bodyAvailability: "available",
    });
    assert.match(facts.version, /^sha256:[a-f0-9]{64}$/u);
  });

  void it("reads stable target identities and read evidence without association configuration", async () => {
    const units = [
      { source: "Save", context: { line: 18 } },
      { source: "Submit", context: { line: 19 } },
    ];
    const translations = [
      { id: "toolbar.save", text: "Enregistrer" },
      { id: "legacy.notice", text: "Avis" },
    ];
    const read = async (records: readonly (typeof translations)[number][]) =>
      readComparisonSnapshot(
        defineConfig({
          source: {
            schema: sourceSchemaFromExamples(...units),
            read: () => completeSource(...units),
          },
          keyOf: (unit) => `message:${unit.context.line}`,
          translations: {
            languages: ["fr"],
            schema: schemaFromExamples(translations[0]!),
            contentSchema: jsonValueSchema,
            keyOf: (translation) => ({
              namespace: "messages",
              key: translation.id,
            }),
            read: () => ({
              scopes: [
                {
                  range: "locales/fr.json",
                  covers: ["message:18", "message:19"],
                  enumeration: "complete",
                  records: records.map((value) => ({
                    value,
                    bodyAvailability: "available" as const,
                  })),
                },
              ],
            }),
            contentOf: (translation) => translation.text,
          },
        }),
      );

    const before = await read(translations);
    const after = await read([
      { id: "legacy.notice", text: "Avis corrigé" },
      { id: "toolbar.save", text: "Sauvegarder" },
    ]);

    assert.deepStrictEqual(
      before.translations.records.map(({ identity }) => identity),
      [
        { language: "fr", namespace: "messages", key: "toolbar.save" },
        { language: "fr", namespace: "messages", key: "legacy.notice" },
      ],
    );
    assert.deepStrictEqual(
      after.translations.records.map(({ identity }) => identity),
      [
        { language: "fr", namespace: "messages", key: "legacy.notice" },
        { language: "fr", namespace: "messages", key: "toolbar.save" },
      ],
    );
    assert.equal(after.translations.records[0]?.content, "Avis corrigé");
    assert.deepStrictEqual(after.translations.reads[0]?.scopes[0], {
      range: "locales/fr.json",
      covers: ["message:18", "message:19"],
      enumeration: "complete",
      translationIndexes: [0, 1],
    });
  });

  void it("does not validate an unused association callback while reading a snapshot", async () => {
    const unit = { source: "Save" };
    const translation = { id: "save", text: "Enregistrer" };
    const config = defineConfig({
      source: {
        schema: sourceSchemaFromExamples(unit),
        read: () => completeSource(unit),
      },
      keyOf: () => "save",
      translations: {
        languages: ["fr"],
        schema: schemaFromExamples(translation),
        contentSchema: jsonValueSchema,
        keyOf: (value) => ({ namespace: "messages", key: value.id }),
        read: () => ({
          scopes: [
            {
              range: "locales/fr.json",
              covers: ["save"],
              enumeration: "complete",
              records: [{ value: translation, bodyAvailability: "available" }],
            },
          ],
        }),
        matches: 42 as never,
        contentOf: (value) => value.text,
      },
    });

    const snapshot = await readComparisonSnapshot(config);

    assert.equal(snapshot.translations.records[0]?.identity.key, "save");
    await assert.rejects(readFacts(config), StandardSchemaContractError);
  });

  void it("rejects missing or duplicate target identities as adapter contract errors", async () => {
    const unit = { source: "Save" };
    const records = [
      { id: "save", text: "Enregistrer" },
      { id: "save", text: "Sauvegarder" },
    ];
    const configFor = (
      values: readonly (typeof records)[number][],
      keyOf: (translation: (typeof records)[number]) => unknown,
    ) =>
      defineConfig({
        source: {
          schema: sourceSchemaFromExamples(unit),
          read: () => completeSource(unit),
        },
        keyOf: () => "save",
        translations: {
          languages: ["fr"],
          schema: schemaFromExamples(records[0]!),
          contentSchema: jsonValueSchema,
          keyOf: (translation) => keyOf(translation) as never,
          read: () => ({
            scopes: [
              {
                range: "locales/fr.json",
                covers: ["save"],
                enumeration: "complete",
                records: values.map((value) => ({
                  value,
                  bodyAvailability: "available" as const,
                })),
              },
            ],
          }),
          contentOf: (translation) => translation.text,
        },
      });

    await assert.rejects(
      readComparisonSnapshot(configFor([records[0]!], () => undefined)),
      (error: unknown) =>
        error instanceof TranslationIdentityContractError &&
        error.reason === "missing",
    );
    await assert.rejects(
      readComparisonSnapshot(
        configFor(records, (translation) => ({
          namespace: "messages",
          key: translation.id,
        })),
      ),
      (error: unknown) =>
        error instanceof TranslationIdentityContractError &&
        error.reason === "duplicate" &&
        error.firstIndex === 0 &&
        error.duplicateIndex === 1,
    );
  });

  void it("distinguishes a complete empty target scope, an unread language, and unavailable content", async () => {
    const unit = { source: "Save" };
    const config = defineConfig({
      source: {
        schema: sourceSchemaFromExamples(unit),
        read: () => completeSource(unit),
      },
      keyOf: () => "save",
      translations: {
        languages: ["fr", "de", "zh"],
        schema: schemaFromExamples({ id: "save", text: "Enregistrer" }),
        unavailableSchema: schemaFromExamples({ id: "old" }),
        contentSchema: jsonValueSchema,
        keyOf: (translation) => ({
          namespace: "targets",
          key: translation.id,
        }),
        read(language) {
          if (language === "de") return { scopes: [] };
          if (language === "fr")
            return {
              scopes: [
                {
                  range: "locales/fr.json",
                  covers: ["save"],
                  enumeration: "complete",
                  records: [],
                },
              ],
            };
          return {
            scopes: [
              {
                range: "locales/zh.json",
                covers: ["save"],
                enumeration: "complete",
                records: [
                  {
                    value: { id: "old" },
                    bodyAvailability: "unavailable" as const,
                  },
                ],
              },
            ],
          };
        },
        contentOf: (translation) => translation.text,
      },
    });

    const snapshot = await readComparisonSnapshot(config);

    assert.deepStrictEqual(
      snapshot.translations.reads.map(({ language, status, scopes }) => ({
        language,
        status,
        scopes: scopes.map(({ range, enumeration, translationIndexes }) => ({
          range,
          enumeration,
          translationIndexes,
        })),
      })),
      [
        {
          language: "fr",
          status: "complete",
          scopes: [
            {
              range: "locales/fr.json",
              enumeration: "complete",
              translationIndexes: [],
            },
          ],
        },
        { language: "de", status: "notRead", scopes: [] },
        {
          language: "zh",
          status: "complete",
          scopes: [
            {
              range: "locales/zh.json",
              enumeration: "complete",
              translationIndexes: [0],
            },
          ],
        },
      ],
    );
    assert.deepStrictEqual(snapshot.translations.records[0], {
      index: 0,
      language: "zh",
      scopeIndex: 0,
      range: "locales/zh.json",
      translation: { id: "old" },
      identity: { language: "zh", namespace: "targets", key: "old" },
      bodyAvailability: "unavailable",
    });
  });

  void it("keeps partial matching unknown while retaining observed conflicts and independent facts", async () => {
    const units = [
      { source: "Save", context: { line: 18 } },
      { source: "Submit", context: { line: 19 } },
      { source: "Cancel", context: { line: 20 } },
    ];
    const facts = await readFacts(
      defineConfig({
        source: {
          schema: sourceSchemaFromExamples(...units),
          read: () => completeSource(...units),
        },
        keyOf: (unit) => `message:${unit.context.line}`,
        translations: {
          languages: ["fr"],
          keyOf: fixtureTranslationIdentity,
          schema: schemaFromExamples({
            text: "Enregistrer",
            context: { line: 18 },
          }),
          contentSchema: jsonValueSchema,
          read(_language, sourceUnits) {
            return {
              scopes: [
                {
                  range: "partial-catalogue",
                  covers: sourceUnits.slice(0, 2).map(({ key }) => key),
                  enumeration: "partial",
                  records: [
                    {
                      value: {
                        id: "save",
                        text: "Enregistrer",
                        context: { line: 18 },
                      },
                      bodyAvailability: "available",
                    },
                    {
                      value: {
                        id: "submit-a",
                        text: "Envoyer A",
                        context: { line: 19 },
                      },
                      bodyAvailability: "available",
                    },
                    {
                      value: {
                        id: "submit-b",
                        text: "Envoyer B",
                        context: { line: 19 },
                      },
                      bodyAvailability: "available",
                    },
                  ],
                },
                {
                  range: "complete-catalogue",
                  covers: sourceUnits.slice(2).map(({ key }) => key),
                  enumeration: "complete",
                  records: [
                    {
                      value: {
                        id: "cancel",
                        text: "Annuler",
                        context: { line: 20 },
                      },
                      bodyAvailability: "available",
                    },
                  ],
                },
              ],
            };
          },
          matches(unit, translation) {
            return unit.context.line === translation.context.line;
          },
          contentOf: () => null,
        },
      }),
    );

    assert.deepStrictEqual(
      facts.associations.map(
        ({ status, coverageStatus, scopeIndexes, translationIndexes }) => ({
          status,
          coverageStatus,
          scopeIndexes,
          translationIndexes,
        }),
      ),
      [
        {
          status: "unknown",
          coverageStatus: "incomplete",
          scopeIndexes: [0],
          translationIndexes: [0],
        },
        {
          status: "conflict",
          coverageStatus: "incomplete",
          scopeIndexes: [0],
          translationIndexes: [1, 2],
        },
        {
          status: "matched",
          coverageStatus: "complete",
          scopeIndexes: [1],
          translationIndexes: [3],
        },
      ],
    );
  });

  void it("shares one actual translation, preserves unavailable and target-only records, and reports read failures", async () => {
    const units = [
      { source: "Save", context: { line: 18 } },
      { source: "Submit", context: { line: 19 } },
      { source: "Cancel", context: { line: 20 } },
    ];
    type Translation = {
      readonly id: string;
      readonly text: string;
      readonly context: { readonly sourceLines: readonly number[] };
    };
    let contentCalls = 0;
    const facts = await readFacts(
      defineConfig({
        source: {
          schema: sourceSchemaFromExamples(...units),
          read: () => completeSource(...units),
        },
        keyOf: (unit) => `message:${unit.context.line}`,
        translations: {
          languages: ["fr", "de"],
          keyOf: fixtureTranslationIdentity,
          schema: schemaFromExamples<Translation>({
            id: "shared-fr",
            text: "Enregistrer",
            context: { sourceLines: [18, 19] },
          }),
          unavailableSchema: schemaFromExamples({
            id: "unavailable-fr",
            context: { sourceLines: [20] },
          }),
          contentSchema: jsonValueSchema,
          read(language, sourceUnits) {
            if (language === "de") throw new Error("catalogue is unavailable");
            return {
              scopes: [
                {
                  range: "catalogue.fr",
                  covers: sourceUnits.map(({ key }) => key),
                  enumeration: "complete",
                  records: [
                    {
                      value: {
                        id: "shared-fr",
                        text: "Enregistrer",
                        context: { sourceLines: [18, 19] },
                      },
                      bodyAvailability: "available",
                    },
                    {
                      value: {
                        id: "unavailable-fr",
                        context: { sourceLines: [20] },
                      },
                      bodyAvailability: "unavailable",
                    },
                    {
                      value: {
                        id: "orphan-fr",
                        text: "Orphan",
                        context: { sourceLines: [] },
                      },
                      bodyAvailability: "available",
                    },
                  ],
                },
              ],
            };
          },
          matches(unit, translation) {
            return translation.context.sourceLines.includes(unit.context.line);
          },
          contentOf(translation) {
            contentCalls += 1;
            return translation.text;
          },
        },
      }),
    );

    assert.deepStrictEqual(facts.translations.reads, [
      {
        language: "fr",
        status: "complete",
        scopes: [
          {
            range: "catalogue.fr",
            covers: ["message:18", "message:19", "message:20"],
            enumeration: "complete",
            translationIndexes: [0, 1, 2],
          },
        ],
      },
      {
        language: "de",
        status: "failed",
        scopes: [],
        error: "catalogue is unavailable",
      },
    ]);
    assert.deepStrictEqual(
      facts.associations.map(
        ({ language, status, coverageStatus, translationIndexes }) => ({
          language,
          status,
          coverageStatus,
          translationIndexes,
        }),
      ),
      [
        {
          language: "fr",
          status: "matched",
          coverageStatus: "complete",
          translationIndexes: [0],
        },
        {
          language: "fr",
          status: "matched",
          coverageStatus: "complete",
          translationIndexes: [0],
        },
        {
          language: "fr",
          status: "unavailable",
          coverageStatus: "complete",
          translationIndexes: [1],
        },
        {
          language: "de",
          status: "unknown",
          coverageStatus: "failed",
          translationIndexes: [],
        },
        {
          language: "de",
          status: "unknown",
          coverageStatus: "failed",
          translationIndexes: [],
        },
        {
          language: "de",
          status: "unknown",
          coverageStatus: "failed",
          translationIndexes: [],
        },
      ],
    );
    assert.equal(facts.translations.records.length, 3);
    assert.equal(contentCalls, 2);
    assert.equal(
      Object.hasOwn(facts.translations.records[1]!, "content"),
      false,
    );
    assert.equal(
      facts.translations.records[1]?.bodyAvailability,
      "unavailable",
    );
    assert.deepStrictEqual(facts.translations.records[1]?.translation, {
      id: "unavailable-fr",
      context: { sourceLines: [20] },
    });
    assert.deepStrictEqual(facts.translations.records[2]?.translation, {
      id: "orphan-fr",
      text: "Orphan",
      context: { sourceLines: [] },
    });
  });

  void it("records a source read failure without publishing a precise total", async () => {
    const facts = await readSourceFacts(
      defineConfig({
        source: {
          schema: emptySourceSchema,
          read() {
            throw new Error("source catalogue is unavailable");
          },
        },
        keyOf: () => "unused",
      }),
    );

    assert.equal(facts.read.status, "failed");
    assert.equal(facts.read.error, "source catalogue is unavailable");
    assert.equal(facts.totalUnitCount, null);
    assert.deepStrictEqual(facts.units, []);
  });

  void it("propagates schema contract errors through a nested source reader", async () => {
    type Unit = { readonly source: string };
    const schema = sourceSchemaFromExamples<Unit>({ source: "Save" });
    const nested = defineConfig({
      source: {
        schema,
        read: () => completeSource({ source: 42 } as unknown as Unit),
      },
      keyOf: () => "nested",
    });
    const outer = defineConfig({
      source: {
        schema,
        async read() {
          await readSourceFacts(nested);
          return { scopes: [] };
        },
      },
      keyOf: () => "outer",
    });

    await assert.rejects(readFacts(outer), StandardSchemaContractError);
  });

  void it("propagates schema contract errors through a nested translation reader", async () => {
    type Translation = { readonly id: string; readonly text: string };
    const unit = { source: "Save" };
    const sourceSchema = sourceSchemaFromExamples(unit);
    const translationSchema = schemaFromExamples<Translation>({
      id: "save",
      text: "Enregistrer",
    });
    const nested = defineConfig({
      source: {
        schema: sourceSchema,
        read: () => completeSource(unit),
      },
      keyOf: () => "save",
      translations: {
        languages: ["fr"],
        keyOf: fixtureTranslationIdentity,
        schema: translationSchema,
        contentSchema: jsonValueSchema,
        read: () => ({
          scopes: [
            {
              range: "fr.json",
              covers: ["save"],
              enumeration: "complete",
              records: [
                {
                  value: {
                    id: 7,
                    text: "Enregistrer",
                  } as unknown as Translation,
                  bodyAvailability: "available",
                },
              ],
            },
          ],
        }),
        matches: () => true,
        contentOf: (translation) => translation.text,
      },
    });
    const outer = defineConfig({
      source: {
        schema: sourceSchema,
        read: () => completeSource(unit),
      },
      keyOf: () => "save",
      translations: {
        languages: ["fr"],
        keyOf: fixtureTranslationIdentity,
        schema: translationSchema,
        contentSchema: jsonValueSchema,
        async read() {
          await readFacts(nested);
          return { scopes: [] };
        },
        matches: () => true,
        contentOf: (translation) => translation.text,
      },
    });

    await assert.rejects(readFacts(outer), StandardSchemaContractError);
  });

  void it("keeps ordinary adapter TypeErrors as failed reads", async () => {
    const unit = { source: "Save" };
    const schema = sourceSchemaFromExamples(unit);
    const sourceFacts = await readSourceFacts(
      defineConfig({
        source: {
          schema,
          read() {
            throw new TypeError("source adapter type error");
          },
        },
        keyOf: () => "save",
      }),
    );
    assert.equal(sourceFacts.read.status, "failed");
    assert.equal(sourceFacts.read.error, "source adapter type error");

    const translation: { readonly text: string } = { text: "Enregistrer" };
    const facts = await readFacts(
      defineConfig({
        source: { schema, read: () => completeSource(unit) },
        keyOf: () => "save",
        translations: {
          languages: ["fr"],
          keyOf: fixtureTranslationIdentity,
          schema: schemaFromExamples(translation),
          contentSchema: jsonValueSchema,
          read() {
            throw new TypeError("translation adapter type error");
          },
          matches: () => true,
          contentOf: (value) => value.text,
        },
      }),
    );
    assert.equal(facts.translations.reads[0]?.status, "failed");
    assert.equal(
      facts.translations.reads[0]?.error,
      "translation adapter type error",
    );
  });

  void it("keeps a target language unknown when its resources were not read", async () => {
    const facts = await readFacts(
      defineConfig({
        source: {
          schema: sourceSchemaFromExamples({
            source: "Save",
            context: { line: 18 },
          }),
          read: () => completeSource({ source: "Save", context: { line: 18 } }),
        },
        keyOf: (unit) => `message:${unit.context.line}`,
        translations: {
          languages: ["fr"],
          keyOf: fixtureTranslationIdentity,
          schema: schemaFromExamples({ text: "Example" }),
          contentSchema: jsonValueSchema,
          read: () => ({ scopes: [] }),
          matches: () => false,
          contentOf: () => null,
        },
      }),
    );

    assert.deepStrictEqual(facts.translations.reads, [
      { language: "fr", status: "notRead", scopes: [] },
    ]);
    assert.deepStrictEqual(facts.associations, [
      {
        sourceKey: "message:18",
        language: "fr",
        status: "unknown",
        coverageStatus: "notRead",
        scopeIndexes: [],
        translationIndexes: [],
      },
    ]);
  });

  void it("keeps list sources, available records, unavailable records, and string bodies distinct", async () => {
    type AvailableTranslation = {
      readonly id: string;
      readonly sourceLine: number;
      readonly text: string;
    };
    type UnavailableTranslation = {
      readonly id: string;
      readonly sourceLine: number;
    };
    const units = [
      {
        source: ["Save", "Submit"],
        context: { file: "messages.json", line: 18 },
      },
      {
        source: ["Cancel"],
        context: { file: "messages.json", line: 19 },
      },
    ];
    const available: AvailableTranslation = {
      id: "save",
      sourceLine: 18,
      text: "Enregistrer",
    };
    const unavailable: UnavailableTranslation = {
      id: "cancel",
      sourceLine: 19,
    };
    let contentReads = 0;
    const facts = await readFacts(
      defineConfig({
        source: {
          schema: sourceSchemaFromExamples(...units),
          read: () => completeSource(...units),
        },
        keyOf: (unit) => `${unit.context.file}:${unit.context.line}`,
        translations: {
          languages: ["fr"],
          keyOf: fixtureTranslationIdentity,
          schema: schemaFromExamples<AvailableTranslation>(available),
          unavailableSchema:
            schemaFromExamples<UnavailableTranslation>(unavailable),
          contentSchema: schemaFromExamples<string>("Enregistrer"),
          read: () => ({
            scopes: [
              {
                range: "messages.fr.json",
                covers: ["messages.json:18", "messages.json:19"],
                enumeration: "complete",
                records: [
                  { value: available, bodyAvailability: "available" },
                  { value: unavailable, bodyAvailability: "unavailable" },
                ],
              },
            ],
          }),
          matches: (unit, translation) =>
            unit.context.line === translation.sourceLine,
          contentOf(translation) {
            contentReads += 1;
            return translation.text;
          },
        },
      }),
    );

    assert.equal(contentReads, 1);
    assert.deepStrictEqual(
      facts.translations.records.map((record) =>
        record.bodyAvailability === "available"
          ? {
              bodyAvailability: record.bodyAvailability,
              translation: record.translation,
              content: record.content,
            }
          : {
              bodyAvailability: record.bodyAvailability,
              translation: record.translation,
              hasContent: Object.hasOwn(record, "content"),
            },
      ),
      [
        {
          bodyAvailability: "available",
          translation: available,
          content: "Enregistrer",
        },
        {
          bodyAvailability: "unavailable",
          translation: unavailable,
          hasContent: false,
        },
      ],
    );
    assert.deepStrictEqual(
      facts.associations.map(({ status }) => status),
      ["matched", "unavailable"],
    );
  });

  void it("rejects an available translation that fails its declared schema", async () => {
    type Translation = { readonly id: string; readonly text: string };
    const unit = { source: "Save", context: { line: 18 } };
    const validTranslation: Translation = { id: "save", text: "Save" };
    const invalidTranslation = { id: 7, text: "Save" };
    const config = defineConfig({
      source: {
        schema: sourceSchemaFromExamples(unit),
        read: () => completeSource(unit),
      },
      keyOf: (value) => `message:${value.context.line}`,
      translations: {
        languages: ["fr"],
        keyOf: fixtureTranslationIdentity,
        schema: schemaFromExamples<Translation>(validTranslation),
        contentSchema: schemaFromExamples<string>("Enregistrer"),
        read: () => ({
          scopes: [
            {
              range: "messages.fr.json",
              covers: ["message:18"],
              enumeration: "complete",
              records: [
                {
                  value: invalidTranslation as unknown as Translation,
                  bodyAvailability: "available",
                },
              ],
            },
          ],
        }),
        matches: () => true,
        contentOf: (translation) => translation.text,
      },
    });

    await assert.rejects(
      readFacts(config),
      (error: unknown) =>
        error instanceof StandardSchemaContractError &&
        error.kind === "schema-mismatch",
    );
  });

  void it("rejects non-JSON translation content before recording facts", async () => {
    type Translation = { readonly id: string; readonly text: string };
    const unit = { source: "Save", context: { line: 18 } };
    const translation: Translation = { id: "save", text: "Save" };
    const config = defineConfig({
      source: {
        schema: sourceSchemaFromExamples(unit),
        read: () => completeSource(unit),
      },
      keyOf: (value) => `message:${value.context.line}`,
      translations: {
        languages: ["fr"],
        keyOf: fixtureTranslationIdentity,
        schema: schemaFromExamples<Translation>(translation),
        contentSchema: schemaFromExamples<string>("Enregistrer"),
        read: () => ({
          scopes: [
            {
              range: "messages.fr.json",
              covers: ["message:18"],
              enumeration: "complete",
              records: [{ value: translation, bodyAvailability: "available" }],
            },
          ],
        }),
        matches: () => true,
        contentOf: () => new Date() as unknown as string,
      },
    });

    await assert.rejects(
      readFacts(config),
      (error: unknown) =>
        error instanceof StandardSchemaContractError &&
        error.kind === "invalid-json",
    );
  });

  void it("rejects changed translation schema output and undeclared unavailable records", async () => {
    type Translation = { readonly id: string; readonly text: string };
    const unit = { source: "Save", context: { line: 18 } };
    const translation: Translation = { id: "save", text: "Enregistrer" };
    const changedContentSchema: StandardSchemaV1<string, string> = {
      "~standard": {
        version: 1,
        vendor: "lioni-test-content",
        validate(value) {
          return typeof value === "string"
            ? { value: `${value}!` }
            : { issues: [{ message: "正文必须是字符串。" }] };
        },
      },
    };
    const changedConfig = defineConfig({
      source: {
        schema: sourceSchemaFromExamples(unit),
        read: () => completeSource(unit),
      },
      keyOf: (value) => `message:${value.context.line}`,
      translations: {
        languages: ["fr"],
        keyOf: fixtureTranslationIdentity,
        schema: schemaFromExamples<Translation>(translation),
        contentSchema: changedContentSchema,
        read: () => ({
          scopes: [
            {
              range: "messages.fr.json",
              covers: ["message:18"],
              enumeration: "complete",
              records: [{ value: translation, bodyAvailability: "available" }],
            },
          ],
        }),
        matches: () => true,
        contentOf: (value) => value.text,
      },
    });
    await assert.rejects(readFacts(changedConfig), {
      name: "StandardSchemaContractError",
      kind: "output-changed",
    });

    const undeclaredUnavailableConfig = {
      source: {
        schema: sourceSchemaFromExamples(unit),
        read: () => completeSource(unit),
      },
      keyOf: (value: typeof unit) => `message:${value.context.line}`,
      translations: {
        languages: ["fr"],
        keyOf: fixtureTranslationIdentity,
        schema: schemaFromExamples<Translation>(translation),
        contentSchema: schemaFromExamples<string>("Enregistrer"),
        read: () => ({
          scopes: [
            {
              range: "messages.fr.json",
              covers: ["message:18"],
              enumeration: "complete" as const,
              records: [
                {
                  value: { id: "save" },
                  bodyAvailability: "unavailable" as const,
                },
              ],
            },
          ],
        }),
        matches: () => true,
        contentOf: (value: Translation) => value.text,
      },
    } as unknown as FrameworkConfig<typeof unit, Translation>;
    await assert.rejects(readFacts(undeclaredUnavailableConfig), {
      name: "StandardSchemaContractError",
      kind: "schema-mismatch",
    });
  });
});
