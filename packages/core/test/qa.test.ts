import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  analyzeQuality,
  defineConfig,
  readFacts,
  runQualityChecks,
  StandardSchemaContractError,
  type QualityCheckRequest,
} from "../src/index.ts";
import { defineTestQualityCheck } from "./quality-check-fixture.ts";
import {
  emptySourceSchema,
  jsonValueSchema,
  schemaFromExamples,
  sourceSchemaFromExamples,
  fixtureTranslationIdentity,
} from "./source-schema.ts";

void describe("quality checks", () => {
  void it("rejects non-JSON dependencies before reporting a QA check failure", async () => {
    const unit = { source: "Hello" };
    const translation = { id: "message:hello", text: "Bonjour" };
    const candidate = {
      sourceKey: "message:hello",
      language: "fr",
      content: "Bonjour",
    };
    let observedDependencies: unknown;

    function configFor(dependencies: unknown) {
      return defineConfig({
        source: {
          schema: sourceSchemaFromExamples(unit),
          read: () => ({
            scopes: [
              {
                range: "messages.json",
                enumeration: "complete" as const,
                records: [
                  { value: unit, bodyAvailability: "available" as const },
                ],
              },
            ],
          }),
        },
        keyOf: () => "message:hello",
        translations: {
          languages: ["fr"],
          identityOf: fixtureTranslationIdentity,
          schema: schemaFromExamples(translation),
          contentSchema: jsonValueSchema,
          contentOf: ({ text }) => text,
          read: (_language, sourceUnits) => ({
            scopes: [
              {
                range: "fr.json",
                covers: sourceUnits.map(({ key }) => key),
                enumeration: "complete" as const,
                records: [
                  {
                    value: translation,
                    bodyAvailability: "available" as const,
                  },
                ],
              },
            ],
          }),
          matches: () => true,
        },
        createQualityRequest: () => ({
          candidates: [candidate],
          dependencies,
        }),
        qualityChecks: [
          defineTestQualityCheck({
            id: "dependency-observer",
            configuration: {},
            check(input) {
              observedDependencies = input.dependencies;
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
    }

    await assert.rejects(
      analyzeQuality(configFor(new Map([["policy", "strict"]]))),
      (error: unknown) => {
        assert.ok(error instanceof StandardSchemaContractError);
        assert.equal(error.kind, "invalid-json");
        assert.equal(error.valueDescription, "QA 输入与结果.dependencies");
        return true;
      },
    );
    assert.equal(observedDependencies, undefined);

    const dependencies = { policy: { strict: true }, modes: ["short", "full"] };
    const result = await analyzeQuality(configFor(dependencies));

    assert.equal(result.status, "complete");
    assert.deepEqual(result.dependencies, dependencies);
    assert.deepEqual(observedDependencies, dependencies);
    assert.equal(result.checks[0]?.issues.length, 0);
  });

  void it("runs selected checks against one facts snapshot and retains findings", async () => {
    const unit = { source: "Hello {name}" };
    const translation = { id: "message:hello", text: "Bonjour" };
    const facts = await readFacts(
      defineConfig({
        source: {
          schema: sourceSchemaFromExamples(unit),
          read: () => ({
            scopes: [
              {
                range: "src/messages.ts",
                enumeration: "complete",
                records: [{ value: unit, bodyAvailability: "available" }],
              },
            ],
          }),
        },
        keyOf: () => "message:save",
        translations: {
          languages: ["fr"],
          identityOf: fixtureTranslationIdentity,
          schema: schemaFromExamples(translation),
          contentSchema: jsonValueSchema,
          read: (_language, sourceUnits) => ({
            scopes: [
              {
                range: "locales/fr.json",
                covers: sourceUnits.map(({ key }) => key),
                enumeration: "complete",
                records: [
                  { value: translation, bodyAvailability: "available" },
                ],
              },
            ],
          }),
          matches: () => true,
          contentOf: ({ text }) => ({ text }),
        },
      }),
    );
    const dependencies = { policy: { strict: true } };
    const configuration = { missingPlaceholders: "error" };
    const candidates = [
      {
        sourceKey: "message:save",
        language: "fr",
        content: { text: "Bonjour" },
      },
    ];
    let observedVersion: string | undefined;
    let observedDependencies: unknown;
    let observedConfiguration: unknown;

    const result = await runQualityChecks(facts, { candidates, dependencies }, [
      defineTestQualityCheck({
        id: "placeholders",
        configuration,
        check(input) {
          observedVersion = input.facts.version;
          observedDependencies = input.dependencies;
          observedConfiguration = input.configuration;
          return {
            status: "complete" as const,
            diagnostics: [
              {
                severity: "error" as const,
                object: {
                  kind: "translation-unit" as const,
                  key: "message:save",
                },
                location: {
                  language: "fr",
                  range: "locales/fr.json",
                  key: "message:save",
                },
                message: "Target is missing {name}.",
                evidence: [
                  {
                    role: "source" as const,
                    object: {
                      kind: "translation-unit" as const,
                      key: "message:save",
                    },
                    location: {
                      language: null,
                      range: "src/messages.ts",
                      key: "message:save",
                    },
                    value: unit.source,
                  },
                  {
                    role: "target" as const,
                    object: {
                      kind: "translation-unit" as const,
                      key: "message:save",
                    },
                    location: {
                      language: "fr",
                      range: "locales/fr.json",
                      key: "message:save",
                    },
                    value: translation.text,
                  },
                ],
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
          };
        },
      }),
    ]);

    assert.equal(observedVersion, facts.version);
    assert.deepEqual(observedDependencies, dependencies);
    assert.deepEqual(observedConfiguration, configuration);
    assert.equal(result.version, facts.version);
    assert.equal(result.status, "complete");
    assert.deepEqual(result.candidates, candidates);
    assert.deepEqual(result.diagnostics, [
      {
        ruleId: "placeholders",
        severity: "error",
        handling: { status: "active" },
        object: { kind: "translation-unit", key: "message:save" },
        location: {
          language: "fr",
          range: "locales/fr.json",
          key: "message:save",
        },
        message: "Target is missing {name}.",
        evidence: [
          {
            role: "source",
            object: { kind: "translation-unit", key: "message:save" },
            location: {
              language: null,
              range: "src/messages.ts",
              key: "message:save",
            },
            value: "Hello {name}",
          },
          {
            role: "target",
            object: { kind: "translation-unit", key: "message:save" },
            location: {
              language: "fr",
              range: "locales/fr.json",
              key: "message:save",
            },
            value: "Bonjour",
          },
        ],
      },
    ]);
    assert.deepEqual(result.checks[0]?.coverage, {
      selected: 1,
      evaluated: 1,
      notApplicable: 0,
      incomplete: 0,
      failed: 0,
    });
  });

  void it("distinguishes no checks from an inapplicable check", async () => {
    const facts = await readFacts(
      defineConfig({
        source: {
          schema: emptySourceSchema,
          read: () => ({ scopes: [] }),
        },
        keyOf: () => "unused",
      }),
    );
    const request: QualityCheckRequest = {
      candidates: [],
      dependencies: { policyVersion: 1 },
    };

    const notRun = await runQualityChecks(facts, request, []);
    let called = false;
    const noCandidateRun = await runQualityChecks(facts, request, [
      defineTestQualityCheck({
        id: "placeholders",
        configuration: {},
        check: () => {
          called = true;
          return {
            status: "not-applicable",
            diagnostics: [],
            issues: [],
            coverage: {
              selected: 1,
              evaluated: 0,
              notApplicable: 1,
              incomplete: 0,
              failed: 0,
            },
          };
        },
      }),
    ]);
    const notApplicable = await runQualityChecks(
      facts,
      {
        ...request,
        candidates: [
          { sourceKey: "unused", language: "fr", content: "Bonjour" },
        ],
      },
      [
        defineTestQualityCheck({
          id: "placeholders",
          configuration: {},
          check: () => ({
            status: "not-applicable",
            diagnostics: [],
            issues: [],
            coverage: {
              selected: 1,
              evaluated: 0,
              notApplicable: 1,
              incomplete: 0,
              failed: 0,
            },
          }),
        }),
      ],
    );

    assert.equal(notRun.status, "not-run");
    assert.equal(noCandidateRun.status, "not-run");
    assert.equal(called, false);
    assert.equal(notApplicable.status, "not-applicable");
    assert.deepEqual(notRun.dependencies, request.dependencies);
    assert.deepEqual(noCandidateRun.candidates, request.candidates);
  });

  void it("calls each configured checker once for each candidate", async () => {
    const facts = await readFacts(
      defineConfig({
        source: { schema: emptySourceSchema, read: () => ({ scopes: [] }) },
        keyOf: () => "unused",
      }),
    );
    const observed: string[] = [];
    const result = await runQualityChecks(
      facts,
      {
        candidates: [
          { sourceKey: "A", language: "fr", content: "Premier" },
          { sourceKey: "B", language: "fr", content: "Second" },
        ],
        dependencies: {},
      },
      [
        defineTestQualityCheck({
          id: "candidate-order",
          configuration: {},
          check({ candidate }) {
            observed.push(candidate.sourceKey);
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
    );

    assert.deepEqual(observed, ["A", "B"]);
    assert.deepEqual(result.checks[0]?.coverage, {
      selected: 2,
      evaluated: 2,
      notApplicable: 0,
      incomplete: 0,
      failed: 0,
    });
  });

  void it("marks a thrown checker failed without losing the run binding", async () => {
    const facts = await readFacts(
      defineConfig({
        source: { schema: emptySourceSchema, read: () => ({ scopes: [] }) },
        keyOf: () => "unused",
      }),
    );
    const dependencies = { sourceRevision: "revision-2" };
    const result = await runQualityChecks(
      facts,
      {
        candidates: [
          { sourceKey: "external", language: "fr", content: "Bonjour" },
        ],
        dependencies,
      },
      [
        defineTestQualityCheck({
          id: "broken",
          configuration: { enabled: true },
          check: () => {
            throw new Error("checker crashed");
          },
        }),
      ],
    );

    assert.equal(result.status, "failed");
    assert.equal(result.version, facts.version);
    assert.deepEqual(result.dependencies, dependencies);
    assert.equal(result.checks[0]?.issues[0]?.message, "checker crashed");
  });

  void it("applies an exception only to its rule and object without hiding evidence", async () => {
    const facts = await readFacts(
      defineConfig({
        source: {
          schema: sourceSchemaFromExamples({ source: "A" }),
          read: () => ({
            scopes: [
              {
                range: "src/messages.ts",
                enumeration: "complete",
                records: [
                  { value: { source: "A" }, bodyAvailability: "available" },
                  { value: { source: "B" }, bodyAvailability: "available" },
                ],
              },
            ],
          }),
        },
        keyOf: (unit) => unit.source,
      }),
    );
    const makeFinding = (key: string) => ({
      severity: "error" as const,
      object: { kind: "translation-unit", key, language: "fr" },
      location: { language: "fr", range: "locales/fr.json", key },
      message: "Translation differs from its evidence.",
      evidence: [
        {
          role: "target",
          object: { kind: "translation-unit", key, language: "fr" },
          location: { language: "fr", range: "locales/fr.json", key },
          value: `value:${key}`,
        },
      ],
    });
    const request = {
      candidates: [{ sourceKey: "A", language: "fr", content: "value:A" }],
      dependencies: {},
      exceptions: [
        {
          id: "allow-a",
          ruleId: "example-rule",
          scope: {
            object: { kind: "translation-unit", key: "A", language: "fr" },
          },
          reason: "宿主允许此消息使用不同表达。",
        },
      ],
    } as QualityCheckRequest & {
      readonly exceptions: readonly {
        readonly id: string;
        readonly ruleId: string;
        readonly scope: {
          readonly object: {
            readonly kind: string;
            readonly key: string;
            readonly language: string;
          };
        };
        readonly reason: string;
      }[];
    };
    const outcome = {
      status: "complete" as const,
      diagnostics: [makeFinding("A"), makeFinding("B")],
      issues: [],
      coverage: {
        selected: 1,
        evaluated: 1,
        notApplicable: 0,
        incomplete: 0,
        failed: 0,
      },
    };

    const result = await runQualityChecks(facts, request, [
      defineTestQualityCheck({
        id: "example-rule",
        configuration: {},
        check: () => outcome,
      }),
      defineTestQualityCheck({
        id: "other-rule",
        configuration: {},
        check: () => ({ ...outcome, diagnostics: [makeFinding("A")] }),
      }),
    ]);

    assert.equal(result.status, "complete");
    assert.deepEqual(
      result.diagnostics.map(({ ruleId, object, handling }) => ({
        ruleId,
        object,
        handling,
      })),
      [
        {
          ruleId: "example-rule",
          object: { kind: "translation-unit", key: "A", language: "fr" },
          handling: {
            status: "excepted",
            exceptionId: "allow-a",
            reason: "宿主允许此消息使用不同表达。",
          },
        },
        {
          ruleId: "example-rule",
          object: { kind: "translation-unit", key: "B", language: "fr" },
          handling: { status: "active" },
        },
        {
          ruleId: "other-rule",
          object: { kind: "translation-unit", key: "A", language: "fr" },
          handling: { status: "active" },
        },
      ],
    );
    assert.equal(result.diagnostics[0]?.evidence[0]?.value, "value:A");
    assert.equal(result.checks[0]?.coverage.evaluated, 1);
    assert.equal(result.version, facts.version);
  });
});
