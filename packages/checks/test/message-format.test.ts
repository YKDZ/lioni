import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  defineConfig,
  readFacts,
  runQualityChecks,
  type QualityCheckRequest,
  type TranslationUnitInput,
} from "@l10n/core";

import { createMessagePlaceholderChecker } from "../src/index.ts";

type Unit = { readonly source: string; readonly key: string };
type Translation = { readonly text: string; readonly key: string };

async function checkMessages(
  source: string,
  translation: string | undefined,
  candidate: string | undefined = translation,
) {
  const facts = await readFacts(
    defineConfig<Unit, Translation>({
      source: {
        read: () => ({
          scopes: [
            {
              range: "src/messages.ts",
              enumeration: "complete",
              records: [
                {
                  value: { source, key: "save" },
                  bodyAvailability: "available",
                },
              ],
            },
          ],
        }),
      },
      keyOf: (unit) => unit.key,
      translations: {
        languages: ["fr"],
        read: (_language, sourceUnits) => ({
          scopes: [
            {
              range: "locales/fr.json",
              covers: sourceUnits.map(({ key }) => key),
              enumeration: "complete",
              records:
                translation === undefined
                  ? []
                  : [
                      {
                        value: { text: translation, key: "save" },
                        bodyAvailability: "available",
                      },
                    ],
            },
          ],
        }),
        matches: (unit, actual) => unit.key === actual.key,
        contentOf: ({ text }) => text,
      },
    }),
  );
  const checker = createMessagePlaceholderChecker<Unit, Translation>({
    sourceText: (unit) => unit.source,
    translationText: (content) => content,
    configuration: { grammar: "simple-placeholders-v1" },
  });
  const result = await runQualityChecks(
    facts,
    {
      candidates:
        candidate === undefined
          ? []
          : [{ sourceKey: "save", language: "fr", content: candidate }],
      dependencies: { resourceVersion: facts.version },
    },
    [checker],
  );
  return { facts, result };
}

void describe("message placeholder checker", () => {
  void it("supports plain text and named or positional placeholders", async () => {
    for (const [source, target] of [
      ["Save changes", "Enregistrer les changements"],
      ["Hello {name}", "Bonjour {name}"],
      ["{0} files", "{0} fichiers"],
    ] as const) {
      const { result } = await checkMessages(source, target);
      assert.equal(result.status, "complete");
      assert.deepEqual(result.diagnostics, []);
    }
  });

  void it("allows different plural branch counts when placeholders remain valid", async () => {
    const { result } = await checkMessages(
      "No monitors | {n} monitors",
      "Aucun moniteur | {n} moniteur | {n} moniteurs",
    );

    assert.equal(result.status, "complete");
    assert.deepEqual(result.diagnostics, []);
  });

  void it("reports missing named and positional placeholders across branches", async () => {
    const named = await checkMessages(
      "{n} Monitor | {n} Monitors",
      "{n} élément | éléments",
    );
    const positional = await checkMessages(
      "No monitors | {0} monitors",
      "Aucun moniteur | moniteurs",
    );

    assert.equal(named.result.status, "complete");
    assert.equal(
      named.result.diagnostics[0]?.message,
      "译文可能缺少占位符 {n}。",
    );
    assert.deepEqual(
      named.result.diagnostics[0]?.evidence.map(({ role }) => role),
      ["source", "target"],
    );
    assert.deepEqual(named.result.diagnostics[0]?.location, {
      language: "fr",
      range: "locales/fr.json",
      key: "save",
    });
    assert.deepEqual(
      named.result.diagnostics[0]?.evidence.map(({ location }) => location),
      [
        { language: null, range: "src/messages.ts" },
        { language: "fr", range: "locales/fr.json", key: "save" },
      ],
    );
    assert.equal(
      positional.result.diagnostics[0]?.message,
      "译文可能缺少占位符 {0}。",
    );
    assert.equal(
      positional.result.diagnostics[0]?.ruleId,
      "message-placeholders",
    );
  });

  void it("reports ICU and linked messages as incomplete unsupported syntax", async () => {
    for (const source of [
      "{count, plural, one {# item} other {# items}}",
      "@:messages.saveLabel",
    ]) {
      const { result } = await checkMessages(source, "消息");
      assert.equal(result.status, "incomplete");
      assert.equal(
        result.checks[0]?.issues[0]?.code,
        "unsupportedMessageSyntax",
      );
      assert.equal(result.checks[0]?.issues[0]?.evidence?.length, 2);
    }
  });

  void it("reports malformed braces as a failed check", async () => {
    const { result } = await checkMessages("Hello {name}", "Bonjour {name");

    assert.equal(result.status, "failed");
    assert.equal(result.checks[0]?.issues[0]?.code, "malformedMessage");
  });

  void it("does not call candidate checks for missing translations and reports the fact", async () => {
    const { result } = await checkMessages("Hello {name}", undefined);

    assert.equal(result.status, "not-run");
    assert.equal(result.checks[0]?.status, "not-run");
    assert.equal(result.factCoverage.associations[0]?.status, "missing");
  });

  void it("checks an unsaved candidate without a matching record", async () => {
    const { result } = await checkMessages(
      "Hello {name}",
      undefined,
      "Bonjour {name}",
    );

    assert.equal(result.status, "complete");
    assert.deepEqual(result.diagnostics, []);
    assert.equal(result.factCoverage.associations[0]?.status, "missing");
    assert.equal(result.factCoverage.associations[0]?.candidateSelected, true);

    const resourceCandidate = await checkMessages(
      "Hello {name}",
      "Bonjour {name}",
    );
    assert.deepEqual(result.diagnostics, resourceCandidate.result.diagnostics);
  });

  void it("checks an explicitly supplied empty string candidate", async () => {
    const { result } = await checkMessages("Hello {name}", undefined, "");

    assert.equal(result.status, "complete");
    assert.equal(result.candidates.length, 1);
    assert.equal(result.diagnostics[0]?.message, "译文可能缺少占位符 {name}。");
  });

  void it("keeps hashed identity separate from host source and translation locations", async () => {
    type LocatedUnit = TranslationUnitInput & {
      readonly identity: string;
      readonly source: string;
      readonly location: { readonly file: string; readonly line: number };
    };
    type NativeTranslation = {
      readonly sourceIdentity: string;
      readonly key: string;
      readonly text: string;
      readonly location: { readonly file: string; readonly line: number };
    };
    const facts = await readFacts(
      defineConfig<LocatedUnit, NativeTranslation>({
        source: {
          read: () => ({
            scopes: [
              {
                range: "src/messages.ts",
                enumeration: "complete",
                records: [
                  {
                    value: {
                      identity: "source:save",
                      source: "Hello {name}",
                      location: { file: "src/messages.ts", line: 18 },
                    },
                    bodyAvailability: "available",
                  },
                ],
              },
            ],
          }),
        },
        keyOf: () => "sha256:4c24e086c2c84554",
        translations: {
          languages: ["fr"],
          read: (_language, sourceUnits) => ({
            scopes: [
              {
                range: "locales/fr.json",
                covers: sourceUnits.map(({ key }) => key),
                enumeration: "complete",
                records: [
                  {
                    value: {
                      sourceIdentity: "source:save",
                      key: "save_label",
                      text: "Bonjour",
                      location: { file: "locales/fr.json", line: 42 },
                    },
                    bodyAvailability: "available",
                  },
                ],
              },
            ],
          }),
          matches: (unit, translation) =>
            unit.identity === translation.sourceIdentity,
          contentOf: ({ text }) => text,
        },
      }),
    );
    const request: QualityCheckRequest = {
      candidates: [
        {
          sourceKey: "sha256:4c24e086c2c84554",
          language: "fr",
          content: "Bonjour",
        },
      ],
      dependencies: {},
    };
    const checker = createMessagePlaceholderChecker<
      LocatedUnit,
      NativeTranslation
    >({
      sourceText: (unit) => unit.source,
      translationText: (content) => content,
      sourceLocation: (unit, _subject, range) => ({
        ...range,
        range: unit.location.file,
        key: String(unit.location.line),
      }),
      translationLocation: (translation, _subject, range) =>
        translation === undefined
          ? range
          : {
              ...range,
              range: translation.location.file,
              key: translation.key,
            },
    });

    const result = await runQualityChecks(facts, request, [checker]);

    assert.equal(result.diagnostics[0]?.object.key, "sha256:4c24e086c2c84554");
    assert.deepEqual(result.diagnostics[0]?.location, {
      language: "fr",
      range: "locales/fr.json",
      key: "save_label",
    });
    assert.deepEqual(
      result.diagnostics[0]?.evidence.map(({ location }) => location),
      [
        {
          language: null,
          range: "src/messages.ts",
          key: "18",
        },
        {
          language: "fr",
          range: "locales/fr.json",
          key: "save_label",
        },
      ],
    );
  });
});
