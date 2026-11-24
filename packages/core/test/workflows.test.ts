import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  runQa,
  createQaSuppression,
  defineChecker,
  defineConfig,
  StandardSchemaContractError,
  writeTranslationRequests,
  type JsonValue,
  type QualityFinding,
  type QaSuppressionStore,
  type TranslationWriteRequest,
} from "../src/index.ts";
import { defineTestChecker } from "./quality-check-fixture.ts";
import {
  jsonValueSchema,
  schemaFromExamples,
  sourceSchemaFromExamples,
  fixtureTranslationKey,
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
      keyOf: fixtureTranslationKey,
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

      contentOf: ({ text }) => text,
    },
    translationWriteback: {
      locateExistingTarget: ({ identity }) => ({
        status: "located",
        locator: { file: "fr.json", key: identity.key },
      }),
      locateNewTarget: () => ({
        status: "notWritable",
        reason: "本场景修改已有译文。",
      }),
      write: ({ request }) => {
        if (
          request.operation === "write" &&
          typeof request.content === "string"
        )
          translation.text = request.content;
      },
    },
    quality: {
      checks: [
        defineChecker({
          id: "needs-review",
          version: "needs-review-v1",
          inputSchema: schemaFromExamples({ sourceKey: "", language: "" }),
          prepare: ({ association }) => ({
              sourceKey: association.sourceKey,
              language: association.language,
            }),
          check: ({ sourceKey, language }): readonly QualityFinding[] => ([
              {
                severity: "error",
                object: {
                  kind: "translation-unit",
                  key: sourceKey,
                  language,
                },
                location: {
                  language,
                  range: "fr.json",
                  key: sourceKey,
                },
                message: "需要人工复核。",
                evidence: [],
              },
            ]),
        }),
      ],
    },
  });
  const candidate = {
    sourceKey: "save",
    language: "fr",
    content: "Sauver",
  } as const;
  return {
    candidate,
    config,
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
        keyOf: fixtureTranslationKey,
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

        contentOf: ({ text }) => ({ text }),
      },
      quality: {
        checks: [
          defineChecker({
            id: "candidate-observer",
            version: "candidate-observer-v1",
            inputSchema: schemaFromExamples(null),
            prepare(input) {
              observed.push({
                candidate: input.candidate,
                context: input.snapshot.translations.records.map(
                  ({ content }) => content,
                ),
              });
              return null;
            },
            check() {
              return [];
            },
          }),
        ],
      },
    });

    const result = await runQa(config, {
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
      result.readCoverage.associations.map(
        ({ sourceKey, status, subjectSelected }) => ({
          sourceKey,
          status,
          subjectSelected,
        }),
      ),
      [
        { sourceKey: "save", status: "matched", subjectSelected: true },
        { sourceKey: "cancel", status: "matched", subjectSelected: false },
      ],
    );
  });

  void it("reports association snapshot without invoking checks when no candidates are selected", async () => {
    let invoked = false;
    let unavailableContentRead = false;
    const config = defineConfig({
      source: {
        schema: sourceSchemaFromExamples<Unit>(
          { id: "missing", source: "missing" },
          { id: "unavailable", source: "unavailable" },
          { id: "unknown", source: "unknown" },
        ),
        read: () => ({
          scopes: [
            {
              range: "messages.json",
              enumeration: "complete",
              records: ["missing", "unavailable", "unknown"].map((id) => ({
                value: { id, source: id },
                bodyAvailability: "available" as const,
              })),
            },
          ],
        }),
      },
      keyOf: ({ id }) => id,
      translations: {
        languages: ["fr", "ja"],
        keyOf: fixtureTranslationKey,
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

        contentOf: (translation) => {
          if (translation.id === "unavailable") unavailableContentRead = true;
          return translation.text;
        },
      },
      quality: {
        checks: [
          defineTestChecker<
            Unit,
            Translation,
            JsonValue,
            { readonly id: string }
          >({
            id: "must-not-run",
            check() {
              invoked = true;
              return [];
            },
          }),
        ],
      },
    });

    const result = await runQa(config, { candidates: [] });

    assert.equal(result.status, "not-run");
    assert.equal(invoked, false);
    assert.equal(unavailableContentRead, false);
    assert.deepEqual(
      result.readCoverage.associations.map(
        ({ sourceKey, language, status, subjectSelected }) => ({
          sourceKey,
          language,
          status,
          subjectSelected,
        }),
      ),
      [
        {
          sourceKey: "missing",
          language: "fr",
          status: "missing",
          subjectSelected: false,
        },
        {
          sourceKey: "unavailable",
          language: "fr",
          status: "unavailable",
          subjectSelected: false,
        },
        {
          sourceKey: "unknown",
          language: "fr",
          status: "missing",
          subjectSelected: false,
        },
        {
          sourceKey: "missing",
          language: "ja",
          status: "unknown",
          subjectSelected: false,
        },
        {
          sourceKey: "unavailable",
          language: "ja",
          status: "unknown",
          subjectSelected: false,
        },
        {
          sourceKey: "unknown",
          language: "ja",
          status: "unknown",
          subjectSelected: false,
        },
      ],
    );
    assert.deepEqual(
      result.readCoverage.translations.map(({ language, status }) => ({
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
    let observed:
      | {
          readonly enabled: boolean;
          readonly sourceKey: string;
          readonly associationStatus: string;
        }
      | undefined;
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
        keyOf: fixtureTranslationKey,
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

        contentOf: ({ text }) => text,
      },
      quality: {
        checks: [
          defineChecker.withTypes<Unit, Translation>()({
            id: "translation-present",
            version: "translation-present-v1",
            inputSchema: schemaFromExamples({
              enabled: true,
              sourceKey: "",
              associationStatus: "matched",
            }),
            prepare: ({ association }) => ({
                enabled: true,
                sourceKey: association.sourceKey,
                associationStatus: association.status,
              }),
            check: (input) => {
              observed = input;
              return [];
            },
          }),
        ],
      },
    });

    const result = await runQa(config);

    assert.deepEqual(result.candidates, [
      { sourceKey: "save", language: "fr", content: "Enregistrer" },
    ]);
    assert.equal(result.status, "complete");
    assert.deepEqual(
      result.checks.map(({ checkId }) => checkId),
      ["translation-present"],
    );
    assert.deepEqual(observed, {
      enabled: true,
      sourceKey: "save",
      associationStatus: "matched",
    });
  });

  void it("程序化调用在 QA 前构造候选并拒绝无效检查配置", async () => {
    const config = defineConfig({
      source: {
        schema: sourceSchemaFromExamples<Unit>({
          id: "unused",
          source: "unused",
        }),
        read: () => ({
          scopes: [
            {
              range: "messages.json",
              enumeration: "complete" as const,
              records: [
                {
                  value: { id: "external", source: "外部" },
                  bodyAvailability: "available" as const,
                },
              ],
            },
          ],
        }),
      },
      keyOf: ({ id }) => id,
      translations: {
        languages: ["fr"],
        keyOf: fixtureTranslationKey,
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
      },
      quality: {},
    });

    const candidate = {
      sourceKey: "external",
      language: "fr",
      content: "外部",
    };
    const result = await runQa(config, { candidates: [candidate] });

    assert.deepEqual(result.candidates, [
      { sourceKey: "external", language: "fr", content: "外部" },
    ]);
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
      quality: {
        checks: "invalid" as unknown as readonly [],
      },
    });
    await assert.rejects(runQa(invalidConfig), {
      name: "StandardSchemaContractError",
      message: "defineConfig 的 quality.checks 必须是检查器数组。",
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
      runQa(invalidSourceConfig),
      (error: unknown) =>
        error instanceof StandardSchemaContractError &&
        error.kind === "schema-mismatch" &&
        error.message === "defineConfig 的 source.read 必须是函数。",
    );
  });

  void it("lets the caller compose a QA decision with independent writing", async () => {
    const { candidate, config, translation } = diagnosedEditScenario();
    const quality = await runQa(config, { candidates: [candidate] });
    assert.equal(quality.diagnostics.length, 1);
    const request: TranslationWriteRequest<JsonValue, Unit> = {
      operation: "write",
      target: {
        identity: { language: "fr", key: "save" },
      },
      content: candidate.content,
      expectedTarget: {
        status: "present",
        identity: { language: "fr", key: "save" },
        content: "Enregistrer",
        range: "fr.json",
      },
    };

    const rejected = await writeTranslationRequests(
      [request],
      config,
      () => quality.diagnostics.length === 0,
    );
    assert.equal(rejected.results[0]?.status, "conflict");
    assert.equal(translation.text, "Enregistrer");

    const accepted = await writeTranslationRequests(
      [request],
      config,
      () => quality.status === "complete" && quality.diagnostics.length === 1,
    );
    assert.equal(accepted.results[0]?.status, "written");
    assert.equal(translation.text, "Sauver");
  });

  void it("applies the single configured suppression source after checking", async () => {
    const { candidate, config } = diagnosedEditScenario();
    const candidates = [candidate];
    const report = await runQa(config, { candidates });
    assert.deepEqual(report.suppressions, []);
    const execution = report.checks[0]?.executions[0];
    assert.ok(execution);
    const suppression = createQaSuppression({
      id: "save-needs-review",
      reason: "该候选的表达已由维护者确认。",
      execution,
    });
    let loadCount = 0;
    const store: QaSuppressionStore = {
      async load() {
        loadCount += 1;
        return [suppression];
      },
      async upsert() {},
    };
    const configured = defineConfig({
      ...config,
      quality: { ...config.quality, suppressionStore: store },
    });

    const result = await runQa(configured, {
      candidates,
    });

    assert.equal(loadCount, 1);
    assert.deepEqual(result.suppressions, [suppression]);
    assert.deepEqual(
      result.diagnostics.map(({ checkId, handling }) => ({
        checkId,
        handling,
      })),
      [
        {
          checkId: "needs-review",
          handling: {
            status: "suppressed",
            suppressionId: "save-needs-review",
            reason: "该候选的表达已由维护者确认。",
          },
        },
      ],
    );
  });
});
