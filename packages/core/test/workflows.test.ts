import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  analyzeQuality,
  createQualityException,
  defineConfig,
  StandardSchemaContractError,
  writeTranslationRequests,
  type QualityCheckInput,
  type JsonValue,
  type QualityExceptionStore,
  type TranslationWriteRequest,
} from "../src/index.ts";
import { defineTestQualityCheck } from "./quality-check-fixture.ts";
import {
  jsonValueSchema,
  schemaFromExamples,
  sourceSchemaFromExamples,
  fixtureTranslationIdentity,
} from "./source-schema.ts";

type Unit = {
  readonly id: string;
  readonly source: string;
};

type Translation = {
  readonly id: string;
  readonly text: string;
  readonly targetKey?: string;
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
      identityOf: fixtureTranslationIdentity,
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
      loadDependencies: () => ({ requestVersion }),
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
        identityOf: fixtureTranslationIdentity,
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
      quality: {
        checks: [
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
      },
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
        identityOf: fixtureTranslationIdentity,
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
                        value: {
                          id: "conflict",
                          targetKey: "conflict.one",
                          text: "x",
                        },
                        bodyAvailability: "available" as const,
                      },
                      {
                        value: {
                          id: "conflict",
                          targetKey: "conflict.two",
                          text: "y",
                        },
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
      quality: {
        checks: [
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
      },
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
        identityOf: fixtureTranslationIdentity,
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
      quality: {
        checks: [
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
      },
    });

    const result = await analyzeQuality(config);

    assert.deepEqual(result.candidates, [
      { sourceKey: "save", language: "fr", content: "Enregistrer" },
    ]);
    assert.equal(result.status, "complete");
    assert.deepEqual(
      result.checks.map(({ checkId }) => checkId),
      ["translation-present"],
    );
    assert.deepEqual(observed?.configuration, { enabled: true });
    assert.equal(observed?.facts.associations[0]?.status, "matched");
  });

  void it("builds external candidates and rejects malformed check configuration", async () => {
    let observedCandidates: readonly {
      sourceKey: string;
      language: string;
      content: string;
    }[] = [];
    let candidateBuilds = 0;
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
        identityOf: fixtureTranslationIdentity,
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
      quality: {
        buildCandidates: ({ defaultCandidates, dependencies, facts }) => {
          candidateBuilds += 1;
          assert.deepEqual(defaultCandidates, []);
          assert.deepEqual(facts.source.units, []);
          assert.deepEqual(dependencies, { glossaryVersion: "v1" });
          observedCandidates = [
            { sourceKey: "external", language: "ja", content: "外部" },
          ];
          return observedCandidates;
        },
        loadDependencies: () => ({ glossaryVersion: "v1" }),
      },
    });

    const result = await analyzeQuality(config);

    assert.deepEqual(result.candidates, [
      { sourceKey: "external", language: "ja", content: "外部" },
    ]);
    assert.equal(candidateBuilds, 1);
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
      quality: {
        checks: "invalid" as unknown as readonly [],
      },
    });
    await assert.rejects(analyzeQuality(invalidConfig), {
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
      quality: { loadDependencies: "invalid" as never },
    });
    await assert.rejects(
      analyzeQuality(invalidRequestConfig),
      (error: unknown) =>
        error instanceof StandardSchemaContractError &&
        error.kind === "schema-mismatch" &&
        error.message ===
          "defineConfig 的 quality.loadDependencies 必须是函数。",
    );
  });

  void it("lets the caller compose a QA decision with independent writing", async () => {
    const { candidate, config, translation } = diagnosedEditScenario();
    const quality = await analyzeQuality(config, { candidates: [candidate] });
    assert.equal(quality.diagnostics.length, 1);
    const request: TranslationWriteRequest<JsonValue, Unit> = {
      operation: "write",
      target: {
        identity: { language: "fr", namespace: "fixture", key: "save" },
      },
      content: candidate.content,
      expectedTarget: {
        status: "present",
        identity: { language: "fr", namespace: "fixture", key: "save" },
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

  void it("applies the single configured exception source after checking", async () => {
    const { candidate, config } = diagnosedEditScenario();
    const candidates = [candidate, { ...candidate, content: "Sauvegarder" }];
    const report = await analyzeQuality(config, { candidates });
    assert.deepEqual(report.exceptions, []);
    assert.deepEqual(report.exceptionApplicability, []);
    const execution = report.checks[0]?.executions[0];
    assert.ok(execution);
    const exception = createQualityException({
      id: "save-needs-review",
      reason: "该候选的表达已由维护者确认。",
      execution,
    });
    let loadCount = 0;
    const store: QualityExceptionStore = {
      async load() {
        loadCount += 1;
        return [exception];
      },
      async upsert() {},
    };
    const configured = defineConfig({
      ...config,
      quality: { ...config.quality, exceptionStore: store },
    });

    const result = await analyzeQuality(configured, {
      candidates,
    });

    assert.equal(loadCount, 1);
    assert.deepEqual(result.exceptions, [exception]);
    assert.deepEqual(
      result.diagnostics.map(({ checkId, handling }) => ({
        checkId,
        handling,
      })),
      [
        {
          checkId: "needs-review",
          handling: {
            status: "excepted",
            exceptionId: "save-needs-review",
            reason: "该候选的表达已由维护者确认。",
          },
        },
        {
          checkId: "needs-review",
          handling: { status: "active" },
        },
      ],
    );
    assert.deepEqual(result.exceptionApplicability, [
      {
        exceptionId: "save-needs-review",
        checkId: "needs-review",
        sourceKey: "save",
        language: "fr",
        executionId: 0,
        candidateIndex: 0,
        status: "applicable",
      },
      {
        exceptionId: "save-needs-review",
        checkId: "needs-review",
        sourceKey: "save",
        language: "fr",
        executionId: 1,
        candidateIndex: 1,
        status: "basis-changed",
        reasons: ["business-input"],
      },
    ]);
  });
});
