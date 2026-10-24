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
                selected: input.subjects.length,
                evaluated: input.subjects.length,
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

    assert.deepEqual(result.subjects, [{ key: "save", language: "fr" }]);
    assert.deepEqual(result.evidenceScope, [
      { kind: "translation-unit", key: "save", language: "fr" },
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
    let observedSubjects: readonly { key: string; language: string }[] = [];
    const config = defineConfig<Unit, Translation>({
      source: {
        read: () => ({ scopes: [] }),
      },
      keyOf: ({ id }) => id,
      qualityChecks: [],
      createQualityRequest: () => {
        observedSubjects = [{ key: "external", language: "ja" }];
        return {
          subjects: observedSubjects,
          evidenceScope: [{ kind: "shared", key: "terms" }],
          dependencies: { glossaryVersion: "v1" },
        };
      },
    });

    const result = await analyzeQuality(config);

    assert.deepEqual(result.subjects, [{ key: "external", language: "ja" }]);
    assert.deepEqual(result.evidenceScope, [{ kind: "shared", key: "terms" }]);
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
