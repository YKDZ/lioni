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
  void it("checks one candidate against full adapter context and refreshes it after reads", async () => {
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
        contentOf: ({ text }) => ({ text }),
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
      translationLocation: (translation, _subject, range) =>
        translation === undefined ? range : { ...range, key: translation.id },
      evaluate: ({ members }) => {
        return new Set(
          members.map(({ content }) => (content as { text: string }).text),
        ).size > 1
          ? {
              severity: "error",
              message: "关系成员应使用相同译文。",
            }
          : undefined;
      },
    });
    const request: QualityCheckRequest = {
      candidates: [
        {
          sourceKey: "sha256:A",
          language: "fr",
          content: { text: "Save" },
        },
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
              value: { text: "Enregistrer" },
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
              value: { text: "Save" },
            },
          ],
        },
      ],
    );
    assert.deepEqual(first.candidates, request.candidates);
    assert.deepEqual(first.relationships, [relationship]);

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
    const updated = await runQualityChecks(
      updatedFacts,
      {
        ...request,
        candidates: [
          {
            ...request.candidates[0]!,
            content: { text: "Enregistrer" },
          },
        ],
      },
      [checker],
    );

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
        contentOf: ({ text }) => text,
      },
    });
    const facts = await readFacts(config);
    const originalFacts = structuredClone(facts);
    const request: QualityCheckRequest = {
      candidates: [{ sourceKey: "A", language: "fr", content: "Bonjour" }],
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
      translationText: (content) => content,
    });
    const relationshipChecker = createRelationshipChecker<
      Unit,
      Translation,
      { readonly constraint: string }
    >({
      id: "same-target-text",
      relationshipKind: "same-target-text",
      configuration: { constraint: "target text is equal" },
      translationLocation: (translation, _subject, range) =>
        translation === undefined ? range : { ...range, key: translation.id },
      evaluate: ({ members }) =>
        new Set(members.map(({ content }) => content)).size > 1
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

  void it("keeps relationship evidence tied to the facts version after host edits", async () => {
    type LocatedTranslation = Omit<Translation, "text"> & {
      text: string;
      readonly sourceId: string;
      readonly nativeKey: string;
      readonly position: { line: number };
    };
    const targets: LocatedTranslation[] = [
      {
        id: "a",
        sourceId: "A",
        nativeKey: "save_label",
        text: "Old A",
        position: { line: 18 },
      },
      {
        id: "b",
        sourceId: "B",
        nativeKey: "save_button",
        text: "Other B",
        position: { line: 19 },
      },
    ];
    const hostMetadata = new WeakMap<LocatedTranslation, string>([
      [targets[0] as LocatedTranslation, "save_label"],
      [targets[1] as LocatedTranslation, "save_button"],
    ]);
    const config = defineConfig<Unit, LocatedTranslation>({
      source: {
        read: () => ({
          scopes: [
            {
              range: "src/messages.ts",
              enumeration: "complete",
              records: [
                {
                  value: { id: "A", source: "Save", text: "Save" },
                  bodyAvailability: "available",
                },
                {
                  value: {
                    id: "B",
                    source: "Save action",
                    text: "Save action",
                  },
                  bodyAvailability: "available",
                },
              ],
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
              records: targets.map((value) => ({
                value,
                bodyAvailability: "available",
              })),
            },
          ],
        }),
        matches: (unit, translation) => unit.id === translation.sourceId,
        contentOf: ({ text }) => text,
      },
    });
    const checker = createRelationshipChecker<
      Unit,
      LocatedTranslation,
      {
        readonly constraint: string;
        readonly observedTarget: LocatedTranslation;
      }
    >({
      id: "same-target-text",
      relationshipKind: "same-target-text",
      configuration: {
        constraint: "target text is equal",
        observedTarget: targets[0] as LocatedTranslation,
      },
      translationLocation: (translation, _subject, defaultLocation) =>
        translation === undefined
          ? defaultLocation
          : {
              ...defaultLocation,
              key: hostMetadata.get(translation) ?? "unlocated",
              position: translation.position,
            },
      evaluate: ({ members, configuration }) => {
        const first = members[0]?.translation;
        const second = members[1]?.translation;
        if (
          first === undefined ||
          second === undefined ||
          hostMetadata.get(first) !== "save_label" ||
          hostMetadata.get(second) !== "save_button" ||
          hostMetadata.get(configuration.observedTarget) !== "save_label"
        )
          return {
            severity: "error",
            message: "宿主关系上下文不可用。",
          };
        return first.text === second.text
          ? undefined
          : { severity: "error", message: "关系成员译文不同。" };
      },
    });
    const request: QualityCheckRequest = {
      candidates: [{ sourceKey: "A", language: "fr", content: "Old A" }],
      relationships: [
        {
          kind: "same-target-text",
          key: "shared-save",
          members: [
            { key: "A", language: "fr" },
            { key: "B", language: "fr" },
          ],
        },
      ],
      dependencies: { observedTarget: targets[0] },
    };

    const oldFacts = await readFacts(config);
    const oldRun = await runQualityChecks(oldFacts, request, [checker]);

    assert.equal(oldRun.status, "complete");
    assert.equal(oldRun.diagnostics[0]?.message, "关系成员译文不同。");
    assert.deepEqual(oldRun.checks[0]?.configuration, {
      constraint: "target text is equal",
      observedTarget: {
        id: "a",
        sourceId: "A",
        nativeKey: "save_label",
        text: "Old A",
        position: { line: 18 },
      },
    });
    assert.equal(oldRun.diagnostics[0]?.evidence[0]?.value, "Old A");
    assert.deepEqual(oldRun.diagnostics[0]?.location, {
      language: "fr",
      range: "locales/fr.json",
      key: "save_label",
      position: { line: 18 },
    });

    targets[0]!.text = "New A";
    targets[0]!.position.line = 42;

    assert.equal(oldRun.version, oldFacts.version);
    assert.deepEqual(
      {
        configuration: oldRun.checks[0]?.configuration,
        dependencies: oldRun.dependencies,
        value: oldRun.diagnostics[0]?.evidence[0]?.value,
        location: oldRun.diagnostics[0]?.location,
      },
      {
        configuration: {
          constraint: "target text is equal",
          observedTarget: {
            id: "a",
            sourceId: "A",
            nativeKey: "save_label",
            text: "Old A",
            position: { line: 18 },
          },
        },
        dependencies: {
          observedTarget: {
            id: "a",
            sourceId: "A",
            nativeKey: "save_label",
            text: "Old A",
            position: { line: 18 },
          },
        },
        value: "Old A",
        location: {
          language: "fr",
          range: "locales/fr.json",
          key: "save_label",
          position: { line: 18 },
        },
      },
    );

    const newFacts = await readFacts(config);
    const newRun = await runQualityChecks(
      newFacts,
      {
        ...request,
        candidates: [{ ...request.candidates[0]!, content: "New A" }],
      },
      [checker],
    );

    assert.notEqual(newRun.version, oldRun.version);
    assert.equal(
      (
        newRun.dependencies as {
          readonly observedTarget: LocatedTranslation;
        }
      ).observedTarget.text,
      "New A",
    );
    const updatedCheck = newRun.checks[0];
    assert.ok(updatedCheck);
    assert.equal(
      (
        updatedCheck.configuration as {
          readonly observedTarget: LocatedTranslation;
        }
      ).observedTarget.text,
      "New A",
    );
    const updatedDiagnostic = newRun.diagnostics[0];
    assert.ok(updatedDiagnostic);
    const updatedEvidence = updatedDiagnostic.evidence[0];
    assert.ok(updatedEvidence);
    assert.equal(updatedEvidence.value, "New A");
    assert.equal(
      (newRun.diagnostics[0]?.location.position as { line: number } | undefined)
        ?.line,
      42,
    );
  });
});
