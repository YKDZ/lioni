import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  analyzeQuality,
  defineConfig,
  type QualityCheckInput,
} from "../src/index.ts";

type Unit = {
  readonly id: string;
  readonly source: string;
};

type Translation = {
  readonly id: string;
  readonly text: string;
};

void describe("configured analysis workflow", () => {
  void it("checks an explicit candidate against the complete adapter context", async () => {
    const observed: unknown[] = [];
    const config = defineConfig<Unit, Translation>({
      source: {
        read: () => ({
          scopes: [
            {
              range: "messages.json",
              enumeration: "complete",
              records: [
                {
                  value: { id: "save", source: "Save" },
                  bodyAvailability: "available",
                },
                {
                  value: { id: "cancel", source: "Cancel" },
                  bodyAvailability: "available",
                },
              ],
            },
          ],
        }),
      },
      keyOf: ({ id }) => id,
      translations: {
        languages: ["fr"],
        read: (_language, sourceUnits) => ({
          scopes: [
            {
              range: "fr.json",
              covers: sourceUnits.map(({ key }) => key),
              enumeration: "complete",
              records: [
                {
                  value: { id: "save", text: "Enregistrer" },
                  bodyAvailability: "available",
                },
                {
                  value: { id: "cancel", text: "Annuler" },
                  bodyAvailability: "available",
                },
              ],
            },
          ],
        }),
        matches: (unit, translation) => unit.id === translation.id,
        contentOf: ({ text }) => ({ text }),
      },
      qualityChecks: [
        {
          id: "candidate-observer",
          configuration: {},
          check(input) {
            observed.push({
              candidate: input.candidate,
              context: input.facts.translations.records.map(
                ({ content }) => content,
              ),
            });
            return {
              status: "complete",
              diagnostics: [],
              issues: [],
              coverage: {
                selected: 1,
                evaluated: 1,
                notApplicable: 0,
                incomplete: 0,
                failed: 0,
              },
            };
          },
        },
      ],
    });

    const result = await analyzeQuality(config, {
      candidates: [
        {
          sourceKey: "save",
          language: "fr",
          content: { text: "Sauver", state: "draft" },
        },
      ],
    });

    assert.deepEqual(result.candidates, [
      {
        sourceKey: "save",
        language: "fr",
        content: { text: "Sauver", state: "draft" },
      },
    ]);
    assert.equal(result.status, "complete");
    assert.deepEqual(observed, [
      {
        candidate: {
          sourceKey: "save",
          language: "fr",
          content: { text: "Sauver", state: "draft" },
        },
        context: [{ text: "Enregistrer" }, { text: "Annuler" }],
      },
    ]);
    assert.deepEqual(
      result.factCoverage.associations.map(
        ({ sourceKey, status, candidateSelected }) => ({
          sourceKey,
          status,
          candidateSelected,
        }),
      ),
      [
        { sourceKey: "save", status: "matched", candidateSelected: true },
        { sourceKey: "cancel", status: "matched", candidateSelected: false },
      ],
    );
  });

  void it("reports association facts without invoking checks when no candidates are selected", async () => {
    let invoked = false;
    let unavailableContentRead = false;
    const config = defineConfig<Unit, Translation>({
      source: {
        read: () => ({
          scopes: [
            {
              range: "messages.json",
              enumeration: "complete",
              records: ["missing", "unavailable", "conflict", "unknown"].map(
                (id) => ({
                  value: { id, source: id },
                  bodyAvailability: "available" as const,
                }),
              ),
            },
          ],
        }),
      },
      keyOf: ({ id }) => id,
      translations: {
        languages: ["fr", "ja"],
        read: (language, sourceUnits) => ({
          scopes:
            language === "fr"
              ? [
                  {
                    range: "fr.json",
                    covers: sourceUnits.map(({ key }) => key),
                    enumeration: "complete" as const,
                    records: [
                      {
                        value: { id: "unavailable" } as Translation,
                        bodyAvailability: "unavailable" as const,
                      },
                      {
                        value: { id: "conflict", text: "x" },
                        bodyAvailability: "available" as const,
                      },
                      {
                        value: { id: "conflict", text: "y" },
                        bodyAvailability: "available" as const,
                      },
                    ],
                  },
                ]
              : [
                  {
                    range: "ja.json",
                    covers: sourceUnits.map(({ key }) => key),
                    enumeration: "partial" as const,
                    records: [],
                  },
                ],
        }),
        matches: (unit, translation) => unit.id === translation.id,
        contentOf: (translation) => {
          if (translation.id === "unavailable") unavailableContentRead = true;
          return translation.text;
        },
      },
      qualityChecks: [
        {
          id: "must-not-run",
          configuration: {},
          check() {
            invoked = true;
            return {
              status: "complete",
              diagnostics: [],
              issues: [],
              coverage: {
                selected: 1,
                evaluated: 1,
                notApplicable: 0,
                incomplete: 0,
                failed: 0,
              },
            };
          },
        },
      ],
    });

    const result = await analyzeQuality(config, { candidates: [] });

    assert.equal(result.status, "not-run");
    assert.equal(invoked, false);
    assert.equal(unavailableContentRead, false);
    assert.deepEqual(
      result.factCoverage.associations.map(
        ({ sourceKey, language, status, candidateSelected }) => ({
          sourceKey,
          language,
          status,
          candidateSelected,
        }),
      ),
      [
        {
          sourceKey: "missing",
          language: "fr",
          status: "missing",
          candidateSelected: false,
        },
        {
          sourceKey: "unavailable",
          language: "fr",
          status: "unavailable",
          candidateSelected: false,
        },
        {
          sourceKey: "conflict",
          language: "fr",
          status: "conflict",
          candidateSelected: false,
        },
        {
          sourceKey: "unknown",
          language: "fr",
          status: "missing",
          candidateSelected: false,
        },
        {
          sourceKey: "missing",
          language: "ja",
          status: "unknown",
          candidateSelected: false,
        },
        {
          sourceKey: "unavailable",
          language: "ja",
          status: "unknown",
          candidateSelected: false,
        },
        {
          sourceKey: "conflict",
          language: "ja",
          status: "unknown",
          candidateSelected: false,
        },
        {
          sourceKey: "unknown",
          language: "ja",
          status: "unknown",
          candidateSelected: false,
        },
      ],
    );
    assert.deepEqual(
      result.factCoverage.translations.map(({ language, status }) => ({
        language,
        status,
      })),
      [
        { language: "fr", status: "complete" },
        { language: "ja", status: "incomplete" },
      ],
    );
  });

  void it("runs configured checks with the default request through the public API", async () => {
    let observed: QualityCheckInput<Unit, Translation> | undefined;
    const config = defineConfig<Unit, Translation>({
      source: {
        read: () => ({
          scopes: [
            {
              range: "messages.json",
              enumeration: "complete",
              records: [
                {
                  value: { id: "save", source: "Save" },
                  bodyAvailability: "available",
                },
              ],
            },
          ],
        }),
      },
      keyOf: ({ id }) => id,
      translations: {
        languages: ["fr"],
        read: (_language, sourceUnits) => ({
          scopes: [
            {
              range: "fr.json",
              covers: sourceUnits.map(({ key }) => key),
              enumeration: "complete",
              records: [
                {
                  value: { id: "save", text: "Enregistrer" },
                  bodyAvailability: "available",
                },
              ],
            },
          ],
        }),
        matches: (unit, translation) => unit.id === translation.id,
        contentOf: ({ text }) => text,
      },
      qualityChecks: [
        {
          id: "translation-present",
          configuration: { enabled: true },
          check: (input) => {
            observed = input;
            return {
              status: "complete",
              diagnostics: [],
              issues: [],
              coverage: {
                selected: 1,
                evaluated: 1,
                notApplicable: 0,
                incomplete: 0,
                failed: 0,
              },
            };
          },
        },
      ],
    });

    const result = await analyzeQuality(config);

    assert.deepEqual(result.candidates, [
      { sourceKey: "save", language: "fr", content: "Enregistrer" },
    ]);
    assert.equal(result.status, "complete");
    assert.deepEqual(
      result.checks.map(({ id }) => id),
      ["translation-present"],
    );
    assert.deepEqual(observed?.configuration, { enabled: true });
    assert.equal(observed?.facts.associations[0]?.status, "matched");
  });

  void it("uses a configured request and rejects malformed check configuration", async () => {
    let observedCandidates: readonly {
      sourceKey: string;
      language: string;
      content: string;
    }[] = [];
    const config = defineConfig<Unit, Translation>({
      source: {
        read: () => ({ scopes: [] }),
      },
      keyOf: ({ id }) => id,
      qualityChecks: [],
      createQualityRequest: () => {
        observedCandidates = [
          { sourceKey: "external", language: "ja", content: "外部" },
        ];
        return {
          candidates: observedCandidates,
          dependencies: { glossaryVersion: "v1" },
        };
      },
    });

    const result = await analyzeQuality(config);

    assert.deepEqual(result.candidates, [
      { sourceKey: "external", language: "ja", content: "外部" },
    ]);
    assert.deepEqual(result.dependencies, { glossaryVersion: "v1" });
    assert.equal(result.status, "not-run");

    const invalidConfig = defineConfig<Unit, Translation>({
      source: { read: () => ({ scopes: [] }) },
      keyOf: ({ id }) => id,
      qualityChecks: "invalid" as unknown as readonly [],
    });
    await assert.rejects(analyzeQuality(invalidConfig), {
      name: "TypeError",
      message: "defineConfig 的 qualityChecks 必须是检查器数组。",
    });

    const invalidSourceConfig = defineConfig<Unit, Translation>({
      source: { read: "invalid" as never },
      keyOf: ({ id }) => id,
    });
    await assert.rejects(analyzeQuality(invalidSourceConfig), {
      name: "TypeError",
      message: "defineConfig 的 source.read 必须是函数。",
    });

    const invalidRequestConfig = defineConfig<Unit, Translation>({
      source: { read: () => ({ scopes: [] }) },
      keyOf: ({ id }) => id,
      createQualityRequest: "invalid" as never,
    });
    await assert.rejects(analyzeQuality(invalidRequestConfig), {
      name: "TypeError",
      message: "defineConfig 的 createQualityRequest 必须是函数。",
    });
  });
});
