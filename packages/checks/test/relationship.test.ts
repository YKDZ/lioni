import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  defineConfig,
  readFacts,
  runQualityChecks,
  type QualityCheckRequest,
  type TranslationUnitInput,
} from "@l10n/core";

import {
  createMessagePlaceholderChecker,
  createRelationshipChecker,
} from "../src/index.ts";

type Unit = TranslationUnitInput & {
  readonly id: string;
  readonly text: string;
};
type Translation = { readonly id: string; readonly text: string };

void describe("relationship quality checks", () => {
  void it("checks selected members with allowed evidence and refreshes unselected evidence", async () => {
    let translations: readonly {
      readonly value: Translation;
      readonly bodyAvailability: "available" | "unavailable";
    }[] = [
      { value: { id: "A", text: "Save" }, bodyAvailability: "available" },
      {
        value: { id: "B", text: "Enregistrer" },
        bodyAvailability: "available",
      },
    ];
    const config = defineConfig<Unit, Translation>({
      source: {
        read: () => ({
          scopes: [
            {
              range: "src/messages.ts",
              enumeration: "complete",
              records: [
                {
                  value: { id: "A", text: "Save", source: "Save" },
                  bodyAvailability: "available",
                },
                {
                  value: {
                    id: "B",
                    text: "Save action",
                    source: "Save action",
                  },
                  bodyAvailability: "available",
                },
              ],
            },
          ],
        }),
      },
      keyOf: (unit) => `sha256:${unit.id}`,
      translations: {
        languages: ["fr"],
        read: (_language, sourceUnits) => ({
          scopes: [
            {
              range: "locales/fr.json",
              covers: sourceUnits.map(({ key }) => key),
              enumeration: "complete",
              records: translations,
            },
          ],
        }),
        matches: (unit, translation) => unit.id === translation.id,
      },
    });
    const relationship = {
      kind: "same-target-text",
      key: "shared-save",
      members: [
        { key: "sha256:B", language: "fr" },
        { key: "sha256:A", language: "fr" },
      ],
    };
    const checker = createRelationshipChecker<
      Unit,
      Translation,
      {
        readonly constraint: string;
      }
    >({
      id: "same-target-text",
      relationshipKind: "same-target-text",
      configuration: { constraint: "target text is equal" },
      translationLocation: (translation, _subject, range) => ({
        ...range,
        key: translation.id,
      }),
      evaluate: ({ members }) => {
        return new Set(members.map(({ translation }) => translation.text))
          .size > 1
          ? {
              severity: "error",
              message: "关系成员应使用相同译文。",
            }
          : undefined;
      },
    });
    const request: QualityCheckRequest = {
      subjects: [{ key: "sha256:A", language: "fr" }],
      evidenceScope: [
        { kind: "translation-unit", key: "sha256:A", language: "fr" },
        { kind: "translation-unit", key: "sha256:B", language: "fr" },
      ],
      relationships: [relationship],
      dependencies: {},
    };
    const firstFacts = await readFacts(config);
    const first = await runQualityChecks(firstFacts, request, [checker]);

    assert.equal(first.status, "complete");
    assert.deepEqual(first.checks[0]?.coverage, {
      selected: 1,
      evaluated: 1,
      notApplicable: 0,
      incomplete: 0,
      failed: 0,
    });
    assert.deepEqual(
      first.diagnostics.map(({ object, location, evidence }) => ({
        object,
        location,
        evidence,
      })),
      [
        {
          object: {
            kind: "relationship",
            key: "shared-save",
            relationshipKind: "same-target-text",
            members: [
              { key: "sha256:B", language: "fr" },
              { key: "sha256:A", language: "fr" },
            ],
          },
          location: {
            language: "fr",
            range: "locales/fr.json",
            key: "B",
          },
          evidence: [
            {
              role: "target",
              object: {
                kind: "translation-unit",
                key: "sha256:B",
                language: "fr",
              },
              location: {
                language: "fr",
                range: "locales/fr.json",
                key: "B",
              },
              value: { id: "B", text: "Enregistrer" },
            },
            {
              role: "related",
              object: {
                kind: "translation-unit",
                key: "sha256:A",
                language: "fr",
              },
              location: {
                language: "fr",
                range: "locales/fr.json",
                key: "A",
              },
              value: { id: "A", text: "Save" },
            },
          ],
        },
      ],
    );
    assert.deepEqual(first.subjects, [{ key: "sha256:A", language: "fr" }]);
    assert.deepEqual(first.relationships, [relationship]);

    const restricted = await runQualityChecks(
      firstFacts,
      {
        ...request,
        evidenceScope: [
          { kind: "translation-unit", key: "sha256:A", language: "fr" },
        ],
      },
      [checker],
    );
    assert.equal(restricted.status, "incomplete");
    assert.deepEqual(restricted.diagnostics, []);
    assert.equal(
      restricted.checks[0]?.issues[0]?.code,
      "relationshipEvidenceOutOfScope",
    );
    assert.deepEqual(restricted.checks[0]?.coverage, {
      selected: 1,
      evaluated: 0,
      notApplicable: 0,
      incomplete: 1,
      failed: 0,
    });

    translations = [
      { value: { id: "A", text: "Save" }, bodyAvailability: "available" },
      {
        value: { id: "B", text: "Enregistrer" },
        bodyAvailability: "unavailable",
      },
    ];
    const unavailableFacts = await readFacts(config);
    const unavailable = await runQualityChecks(unavailableFacts, request, [
      checker,
    ]);
    assert.equal(unavailable.status, "incomplete");
    assert.deepEqual(unavailable.diagnostics, []);
    assert.equal(
      unavailable.checks[0]?.issues[0]?.code,
      "relationshipTranslationUnavailable",
    );

    translations = [
      { value: { id: "A", text: "Save" }, bodyAvailability: "available" },
    ];
    const missingFacts = await readFacts(config);
    const missing = await runQualityChecks(missingFacts, request, [checker]);
    assert.equal(missing.status, "not-applicable");
    assert.deepEqual(missing.diagnostics, []);
    assert.equal(
      missing.checks[0]?.issues[0]?.code,
      "relationshipTranslationMissing",
    );

    translations = [
      {
        value: { id: "A", text: "Enregistrer" },
        bodyAvailability: "available",
      },
      {
        value: { id: "B", text: "Enregistrer" },
        bodyAvailability: "available",
      },
    ];
    const updatedFacts = await readFacts(config);
    const updated = await runQualityChecks(updatedFacts, request, [checker]);

    assert.notEqual(updated.version, first.version);
    assert.equal(updated.status, "complete");
    assert.deepEqual(updated.diagnostics, []);
  });

  void it("keeps relation exceptions local while running message checks in the same QA run", async () => {
    const units: readonly Unit[] = [
      { id: "A", source: "Hello {name}", text: "Hello {name}" },
      { id: "B", source: "Save", text: "Save" },
      { id: "C", source: "Save", text: "Save" },
    ];
    const translations: readonly Translation[] = [
      { id: "A", text: "Bonjour" },
      { id: "B", text: "Enregistrer" },
      { id: "C", text: "Sauvegarder" },
    ];
    const config = defineConfig<Unit, Translation>({
      source: {
        read: () => ({
          scopes: [
            {
              range: "src/messages.ts",
              enumeration: "complete",
              records: units.map((value) => ({
                value,
                bodyAvailability: "available",
              })),
            },
          ],
        }),
      },
      keyOf: (unit) => unit.id,
      translations: {
        languages: ["fr"],
        read: (_language, sourceUnits) => ({
          scopes: [
            {
              range: "locales/fr.json",
              covers: sourceUnits.map(({ key }) => key),
              enumeration: "complete",
              records: translations.map((value) => ({
                value,
                bodyAvailability: "available",
              })),
            },
          ],
        }),
        matches: (unit, translation) => unit.id === translation.id,
      },
    });
    const facts = await readFacts(config);
    const originalFacts = structuredClone(facts);
    const request: QualityCheckRequest = {
      subjects: [{ key: "A", language: "fr" }],
      evidenceScope: ["A", "B", "C"].map((key) => ({
        kind: "translation-unit",
        key,
        language: "fr",
      })),
      relationships: [
        {
          kind: "same-target-text",
          key: "allow-save-variation",
          members: [
            { key: "B", language: "fr" },
            { key: "A", language: "fr" },
          ],
        },
        {
          kind: "same-target-text",
          key: "other-save-variation",
          members: [
            { key: "C", language: "fr" },
            { key: "A", language: "fr" },
          ],
        },
      ],
      exceptions: [
        {
          id: "approved-file-location",
          ruleId: "same-target-text",
          scope: {
            location: {
              language: "fr",
              range: "locales/fr.json",
              key: "B",
            },
          },
          reason: "该文件位置允许保留宿主现有译法。",
        },
      ],
      dependencies: {},
    };
    const messageChecker = createMessagePlaceholderChecker<Unit, Translation>({
      sourceText: (unit) => unit.source,
      translationText: (translation) => translation.text,
    });
    const relationshipChecker = createRelationshipChecker<
      Unit,
      Translation,
      { readonly constraint: string }
    >({
      id: "same-target-text",
      relationshipKind: "same-target-text",
      configuration: { constraint: "target text is equal" },
      translationLocation: (translation, _subject, range) => ({
        ...range,
        key: translation.id,
      }),
      evaluate: ({ members }) =>
        new Set(members.map(({ translation }) => translation.text)).size > 1
          ? { severity: "error", message: "关系成员应使用相同译文。" }
          : undefined,
    });

    const result = await runQualityChecks(facts, request, [
      messageChecker,
      relationshipChecker,
    ]);

    assert.equal(result.status, "complete");
    assert.deepEqual(
      result.diagnostics.map(({ ruleId, object, handling }) => ({
        ruleId,
        key: object.key,
        handling,
      })),
      [
        {
          ruleId: "message-placeholders",
          key: "A",
          handling: { status: "active" },
        },
        {
          ruleId: "same-target-text",
          key: "allow-save-variation",
          handling: {
            status: "excepted",
            exceptionId: "approved-file-location",
            reason: "该文件位置允许保留宿主现有译法。",
          },
        },
        {
          ruleId: "same-target-text",
          key: "other-save-variation",
          handling: { status: "active" },
        },
      ],
    );
    assert.deepEqual(result.exceptions, request.exceptions);
    assert.deepEqual(facts, originalFacts);
  });
});
