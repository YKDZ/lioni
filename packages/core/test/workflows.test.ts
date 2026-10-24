import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  applySemanticEdits,
  analyzeQuality,
  defineConfig,
  prepareQualityConditionedSemanticEdit,
  StandardSchemaContractError,
  type QualityCheckInput,
  type JsonValue,
} from "../src/index.ts";
import { defineTestQualityCheck } from "./quality-check-fixture.ts";
import {
  jsonValueSchema,
  schemaFromExamples,
  sourceSchemaFromExamples,
} from "./source-schema.ts";

type Unit = {
  readonly id: string;
  readonly source: string;
};

type Translation = {
  readonly id: string;
  readonly text: string;
};

function diagnosedEditScenario() {
  const translation = { id: "save", text: "Enregistrer" };
  let requestVersion = "v1";
  const config = defineConfig({
    source: {
      schema: sourceSchemaFromExamples<Unit>({ id: "save", source: "Save" }),
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
      schema: schemaFromExamples<Translation>(translation),
      contentSchema: jsonValueSchema,
      read: (_language, sourceUnits) => ({
        scopes: [
          {
            range: "fr.json",
            covers: sourceUnits.map(({ key }) => key),
            enumeration: "complete",
            records: [{ value: translation, bodyAvailability: "available" }],
          },
        ],
      }),
      matches: (unit, translated) => unit.id === translated.id,
      contentOf: ({ text }) => text,
    },
    translationWriteback: {
      locateExistingTarget: () => ({
        status: "located",
        locator: { file: "fr.json", key: "save" },
      }),
      locateNewTarget: () => ({
        status: "notWritable",
        reason: "本场景修改已有译文。",
      }),
      write: ({ edit }) => {
        if (typeof edit.content === "string") translation.text = edit.content;
      },
    },
    qualityChecks: [
      defineTestQualityCheck({
        id: "needs-review",
        configuration: {},
        check: ({ candidate }) => ({
          status: "complete",
          diagnostics: [
            {
              severity: "error",
              object: {
                kind: "translation-unit",
                key: candidate.sourceKey,
                language: candidate.language,
              },
              location: {
                language: candidate.language,
                range: "fr.json",
                key: candidate.sourceKey,
              },
              message: "需要人工复核。",
              evidence: [],
            },
          ],
          issues: [],
          coverage: {
            selected: 1,
            evaluated: 1,
            notApplicable: 0,
            incomplete: 0,
            failed: 0,
          },
        }),
      }),
    ],
    createQualityRequest: () => ({
      candidates: [],
      dependencies: { requestVersion },
    }),
  });
  const candidate = {
    sourceKey: "save",
    language: "fr",
    content: "Sauver",
  } as const;
  return {
    candidate,
    config,
    setRequestVersion: (value: string) => {
      requestVersion = value;
    },
    translation,
  };
}

void describe("configured analysis workflow", () => {
  void it("checks an explicit candidate against the complete adapter context", async () => {
    const observed: unknown[] = [];
    const config = defineConfig({
      source: {
        schema: sourceSchemaFromExamples<Unit>(
          { id: "save", source: "Save" },
          { id: "cancel", source: "Cancel" },
        ),
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
        schema: schemaFromExamples({ id: "save", text: "Enregistrer" }),
        contentSchema: jsonValueSchema,
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
        defineTestQualityCheck({
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
        }),
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
    const config = defineConfig({
      source: {
        schema: sourceSchemaFromExamples<Unit>(
          { id: "missing", source: "missing" },
          { id: "unavailable", source: "unavailable" },
          { id: "conflict", source: "conflict" },
          { id: "unknown", source: "unknown" },
        ),
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
        schema: schemaFromExamples<Translation>({
          id: "example",
          text: "example",
        }),
        unavailableSchema: schemaFromExamples({ id: "unavailable" }),
        contentSchema: jsonValueSchema,
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
                        value: { id: "unavailable" },
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
        defineTestQualityCheck<
          Unit,
          Translation,
          JsonValue,
          { readonly id: string }
        >({
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
        }),
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
    const config = defineConfig({
      source: {
        schema: sourceSchemaFromExamples<Unit>({ id: "save", source: "Save" }),
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
        schema: schemaFromExamples<Translation>({
          id: "save",
          text: "Enregistrer",
        }),
        contentSchema: jsonValueSchema,
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
        defineTestQualityCheck<Unit, Translation>({
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
        }),
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
    const config = defineConfig({
      source: {
        schema: sourceSchemaFromExamples<Unit>({
          id: "unused",
          source: "unused",
        }),
        read: () => ({ scopes: [] }),
      },
      keyOf: ({ id }) => id,
      translations: {
        languages: ["fr"],
        schema: schemaFromExamples<Translation>({
          id: "external",
          text: "外部",
        }),
        contentSchema: jsonValueSchema,
        contentOf: ({ text }) => text,
        read: (_language, sourceUnits) => ({
          scopes: [
            {
              range: "fr.json",
              covers: sourceUnits.map(({ key }) => key),
              enumeration: "complete" as const,
              records: [],
            },
          ],
        }),
        matches: (unit, translation) => unit.id === translation.id,
      },
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

    const invalidConfig = defineConfig({
      source: {
        schema: sourceSchemaFromExamples<Unit>({
          id: "unused",
          source: "unused",
        }),
        read: () => ({ scopes: [] }),
      },
      keyOf: ({ id }) => id,
      qualityChecks: "invalid" as unknown as readonly [],
    });
    await assert.rejects(analyzeQuality(invalidConfig), {
      name: "TypeError",
      message: "defineConfig 的 qualityChecks 必须是检查器数组。",
    });

    const invalidSourceConfig = defineConfig({
      source: {
        schema: sourceSchemaFromExamples<Unit>({
          id: "unused",
          source: "unused",
        }),
        read: "invalid" as never,
      },
      keyOf: ({ id }) => id,
    });
    await assert.rejects(
      analyzeQuality(invalidSourceConfig),
      (error: unknown) =>
        error instanceof StandardSchemaContractError &&
        error.kind === "schema-mismatch" &&
        error.message === "defineConfig 的 source.read 必须是函数。",
    );

    const invalidRequestConfig = defineConfig({
      source: {
        schema: sourceSchemaFromExamples<Unit>({
          id: "unused",
          source: "unused",
        }),
        read: () => ({ scopes: [] }),
      },
      keyOf: ({ id }) => id,
      createQualityRequest: "invalid" as never,
    });
    await assert.rejects(analyzeQuality(invalidRequestConfig), {
      name: "TypeError",
      message: "defineConfig 的 createQualityRequest 必须是函数。",
    });
  });

  void it("prepares and writes a diagnosed candidate by default", async () => {
    const { candidate, config, translation } = diagnosedEditScenario();

    const quality = await analyzeQuality(config, { candidates: [candidate] });
    assert.equal(quality.diagnostics.length, 1);
    const result = await prepareQualityConditionedSemanticEdit(config, {
      candidate,
    });

    assert.equal(result.status, "not-required");
    assert.equal(result.preparation?.status, "prepared");
    if (result.preparation?.status !== "prepared") return;
    const applied = await applySemanticEdits([result.preparation.edit], config);
    assert.equal(applied.results[0]?.status, "written");
    assert.equal(translation.text, "Sauver");
  });

  void it("lets the host condition decide whether a diagnosed candidate is prepared", async () => {
    const { candidate, config } = diagnosedEditScenario();
    let acceptedQuality: unknown;
    const passed = await prepareQualityConditionedSemanticEdit(config, {
      candidate,
      condition: (quality) => {
        acceptedQuality = quality;
        return (
          quality.status === "complete" && quality.diagnostics.length === 1
        );
      },
    });

    assert.equal(passed.status, "passed");
    assert.equal(passed.preparation?.status, "prepared");
    assert.equal(
      (acceptedQuality as { readonly candidates: readonly unknown[] })
        .candidates.length,
      1,
    );

    const rejected = await prepareQualityConditionedSemanticEdit(config, {
      candidate: { ...candidate, content: "À refuser" },
      condition: (quality) => quality.diagnostics.length === 0,
    });
    assert.equal(rejected.status, "rejected");
    assert.equal("preparation" in rejected, false);
    if (rejected.status === "rejected")
      assert.equal(rejected.quality.diagnostics.length, 1);
  });

  void it("keeps candidate content bound while an asynchronous condition waits", async () => {
    const { candidate: baseCandidate, config } = diagnosedEditScenario();
    const candidate = { ...baseCandidate, content: "Checked text" };
    let releaseCondition: () => void = () => {};
    const conditionGate = new Promise<void>((resolve) => {
      releaseCondition = resolve;
    });
    let enterCondition: () => void = () => {};
    const conditionEntered = new Promise<void>((resolve) => {
      enterCondition = resolve;
    });
    let checkedContent: unknown;

    const pending = prepareQualityConditionedSemanticEdit(config, {
      candidate,
      condition: async (quality) => {
        checkedContent = quality.candidates[0]?.content;
        enterCondition();
        await conditionGate;
        return true;
      },
    });
    await conditionEntered;
    candidate.content = "Unchecked changed text";
    releaseCondition();
    const result = await pending;

    assert.equal(checkedContent, "Checked text");
    assert.equal(result.status, "passed");
    if (result.status !== "passed") return;
    assert.equal(result.preparation.status, "prepared");
    if (result.preparation.status === "prepared")
      assert.equal(result.preparation.edit.content, "Checked text");
  });

  void it("rejects an old quality result when its candidate or inputs differ", async () => {
    const { candidate, config, setRequestVersion } = diagnosedEditScenario();
    const quality = await analyzeQuality(config, { candidates: [candidate] });
    let conditionCalled = false;
    const cachedMatch = await prepareQualityConditionedSemanticEdit(config, {
      candidate,
      quality,
      condition: () => {
        conditionCalled = true;
        return true;
      },
    });
    assert.equal(cachedMatch.status, "passed");
    assert.equal(conditionCalled, true);
    if (cachedMatch.status === "passed") {
      assert.equal(cachedMatch.preparation.status, "prepared");
      if (cachedMatch.preparation.status === "prepared")
        assert.equal(cachedMatch.preparation.edit.content, candidate.content);
    }

    conditionCalled = false;
    const candidateMismatch = await prepareQualityConditionedSemanticEdit(
      config,
      {
        candidate: { ...candidate, content: "Changed after checking" },
        quality,
        condition: () => {
          conditionCalled = true;
          return true;
        },
      },
    );

    assert.equal(candidateMismatch.status, "input-mismatch");
    assert.equal(conditionCalled, false);
    assert.equal("preparation" in candidateMismatch, false);

    setRequestVersion("v2");
    const explicitInputMismatch = await prepareQualityConditionedSemanticEdit(
      config,
      {
        candidate,
        quality,
        condition: () => {
          conditionCalled = true;
          return true;
        },
      },
    );
    assert.equal(explicitInputMismatch.status, "input-mismatch");
    assert.equal(conditionCalled, false);
  });

  void it("rejects non-JSON cached quality before calling the host condition", async () => {
    const { candidate, config } = diagnosedEditScenario();
    const quality = await analyzeQuality(config, { candidates: [candidate] });
    const malformedQuality = Object.assign({}, quality, {
      dependencies: new Map([["lost", "evidence"]]),
    });
    let conditionCalled = false;

    await assert.rejects(
      () =>
        prepareQualityConditionedSemanticEdit(config, {
          candidate,
          quality: malformedQuality,
          condition: () => {
            conditionCalled = true;
            return true;
          },
        }),
      (error: unknown) =>
        error instanceof StandardSchemaContractError &&
        error.kind === "invalid-json",
    );
    assert.equal(conditionCalled, false);
  });
});
