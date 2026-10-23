import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  defineConfig,
  readFacts,
  runQualityChecks,
  type QualityCheckRequest,
} from "../src/index.ts";

void describe("quality checks", () => {
  void it("runs selected checks against one facts snapshot and retains findings", async () => {
    const unit = { source: "Hello {name}" };
    const translation = { text: "Bonjour" };
    const facts = await readFacts(
      defineConfig({
        source: {
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
        },
      }),
    );
    const dependencies = { policy: { strict: true } };
    const configuration = { missingPlaceholders: "error" };
    const subjects = [{ key: "message:save", language: "fr" }];
    const evidenceScope = [
      { kind: "translation-unit" as const, key: "message:save" },
    ];
    let observedVersion: string | undefined;
    let observedDependencies: unknown;
    let observedConfiguration: unknown;

    const result = await runQualityChecks(
      facts,
      { subjects, evidenceScope, dependencies },
      [
        {
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
        },
      ],
    );

    assert.equal(observedVersion, facts.version);
    assert.deepEqual(observedDependencies, dependencies);
    assert.deepEqual(observedConfiguration, configuration);
    assert.equal(result.version, facts.version);
    assert.equal(result.status, "complete");
    assert.deepEqual(result.subjects, subjects);
    assert.deepEqual(result.evidenceScope, evidenceScope);
    assert.deepEqual(result.diagnostics, [
      {
        ruleId: "placeholders",
        severity: "error",
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
          read: () => ({ scopes: [] }),
        },
        keyOf: () => "unused",
      }),
    );
    const request: QualityCheckRequest = {
      subjects: [],
      evidenceScope: [],
      dependencies: { policyVersion: 1 },
    };

    const notRun = await runQualityChecks(facts, request, []);
    const notApplicable = await runQualityChecks(facts, request, [
      {
        id: "placeholders",
        configuration: {},
        check: () => ({
          status: "not-applicable",
          diagnostics: [],
          issues: [],
          coverage: {
            selected: 0,
            evaluated: 0,
            notApplicable: 0,
            incomplete: 0,
            failed: 0,
          },
        }),
      },
    ]);

    assert.equal(notRun.status, "not-run");
    assert.equal(notApplicable.status, "not-applicable");
    assert.deepEqual(notRun.dependencies, request.dependencies);
    assert.deepEqual(notApplicable.subjects, request.subjects);
  });

  void it("marks a thrown checker failed without losing the run binding", async () => {
    const facts = await readFacts(
      defineConfig({
        source: { read: () => ({ scopes: [] }) },
        keyOf: () => "unused",
      }),
    );
    const dependencies = { sourceRevision: "revision-2" };
    const result = await runQualityChecks(
      facts,
      { subjects: [], evidenceScope: [], dependencies },
      [
        {
          id: "broken",
          configuration: { enabled: true },
          check: () => {
            throw new Error("checker crashed");
          },
        },
      ],
    );

    assert.equal(result.status, "failed");
    assert.equal(result.version, facts.version);
    assert.deepEqual(result.dependencies, dependencies);
    assert.equal(result.checks[0]?.issues[0]?.message, "checker crashed");
  });
});
