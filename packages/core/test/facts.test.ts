import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  defineConfig,
  DuplicateTranslationUnitKeyError,
  readFacts,
  readSourceFacts,
} from "../src/index.ts";

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
    const config = defineConfig({
      source: {
        read: () =>
          completeSource(
            { source: "Save", context: { file: "src/messages.ts", line: 18 } },
            {
              source: "Submit",
              context: { file: "src/messages.ts", line: 18 },
            },
          ),
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
        source: { read: () => completeSource(...units) },
        keyOf: (unit) => `${unit.context.file}:${unit.context.line}`,
        translations: {
          languages: ["fr"],
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
                        text: "Enregistrer",
                        context: { sourceLine: 18 },
                      },
                      bodyAvailability: "available",
                    },
                    {
                      value: { text: "Avis", context: { sourceLine: 999 } },
                      bodyAvailability: "available",
                    },
                  ],
                },
              ],
            };
          },
          matches(unit, translation) {
            return translation.context.sourceLine === unit.context.line;
          },
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
      translation: {
        text: "Enregistrer",
        context: { sourceLine: 18 },
      },
      bodyAvailability: "available",
    });
    assert.match(facts.version, /^sha256:[a-f0-9]{64}$/u);
  });

  void it("keeps partial matching unknown while retaining observed conflicts and independent facts", async () => {
    const units = [
      { source: "Save", context: { line: 18 } },
      { source: "Submit", context: { line: 19 } },
      { source: "Cancel", context: { line: 20 } },
    ];
    const facts = await readFacts(
      defineConfig({
        source: { read: () => completeSource(...units) },
        keyOf: (unit) => `message:${unit.context.line}`,
        translations: {
          languages: ["fr"],
          read(_language, sourceUnits) {
            return {
              scopes: [
                {
                  range: "partial-catalogue",
                  covers: sourceUnits.slice(0, 2).map(({ key }) => key),
                  enumeration: "partial",
                  records: [
                    {
                      value: { text: "Enregistrer", context: { line: 18 } },
                      bodyAvailability: "available",
                    },
                    {
                      value: { text: "Envoyer A", context: { line: 19 } },
                      bodyAvailability: "available",
                    },
                    {
                      value: { text: "Envoyer B", context: { line: 19 } },
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
                      value: { text: "Annuler", context: { line: 20 } },
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
    const facts = await readFacts(
      defineConfig({
        source: { read: () => completeSource(...units) },
        keyOf: (unit) => `message:${unit.context.line}`,
        translations: {
          languages: ["fr", "de"],
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
                        text: "Enregistrer",
                        context: { sourceLines: [18, 19] },
                      },
                      bodyAvailability: "available",
                    },
                    {
                      value: {
                        text: "unreadable",
                        context: { sourceLines: [20] },
                      },
                      bodyAvailability: "unavailable",
                    },
                    {
                      value: { text: "Orphan", context: { sourceLines: [] } },
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
    assert.deepStrictEqual(facts.translations.records[2]?.translation, {
      text: "Orphan",
      context: { sourceLines: [] },
    });
  });

  void it("records a source read failure without publishing a precise total", async () => {
    const facts = await readSourceFacts(
      defineConfig({
        source: {
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

  void it("keeps a target language unknown when its resources were not read", async () => {
    const facts = await readFacts(
      defineConfig({
        source: {
          read: () => completeSource({ source: "Save", context: { line: 18 } }),
        },
        keyOf: (unit) => `message:${unit.context.line}`,
        translations: {
          languages: ["fr"],
          read: () => ({ scopes: [] }),
          matches: () => false,
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
});
