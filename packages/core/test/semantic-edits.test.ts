import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  applySemanticEdits,
  defineConfig,
  prepareSemanticEdit,
  readFacts,
  resolveSemanticEditInput,
  type FrameworkConfig,
  type FrameworkFacts,
  type SemanticEditCandidate,
  type TranslationUnitInput,
} from "../src/index.ts";

function textContent(content: unknown): string {
  if (typeof content !== "string")
    throw new TypeError("测试适配器只接受字符串内容。");
  return content;
}

async function resolveAndPrepareSemanticEdit<
  TUnit extends TranslationUnitInput,
  TTranslation,
>(
  facts: FrameworkFacts<TUnit, TTranslation>,
  candidate: SemanticEditCandidate,
  config: FrameworkConfig<TUnit, TTranslation>,
) {
  const resolved = await resolveSemanticEditInput(
    facts,
    { sourceKey: candidate.sourceKey, language: candidate.language },
    config,
  );
  if (resolved.status !== "resolved") return resolved;
  return prepareSemanticEdit(resolved.input, candidate);
}

void describe("semantic edits", () => {
  void it("prepares a structured edit without a writer, QA, or baseline", async () => {
    const source = { source: "Save", context: { key: "toolbar.save" } };
    const translation = { text: "Enregistrer", state: "reviewed" };
    const config = defineConfig({
      source: {
        read: () => ({
          scopes: [
            {
              range: "messages.json",
              enumeration: "complete",
              records: [{ value: source, bodyAvailability: "available" }],
            },
          ],
        }),
      },
      keyOf: ({ context }) => context.key,
      translations: {
        languages: ["fr"],
        read(_language, sourceUnits) {
          return {
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
          };
        },
        matches: (unit, actualTranslation) =>
          unit.context.key === "toolbar.save" &&
          actualTranslation.text === "Enregistrer",
        contentOf: (actualTranslation) => ({
          text: actualTranslation.text,
          state: actualTranslation.state,
        }),
      },
      translationWriteback: {
        locateExistingTarget: ({ sourceUnit }) => ({
          status: "located",
          locator: {
            file: "locales/fr.json",
            key: sourceUnit.unit.context.key,
          },
        }),
        locateNewTarget: () => ({
          status: "notWritable",
          reason: "本场景修改已有译文。",
        }),
      },
    });
    const facts = await readFacts(config);
    const candidate = {
      sourceKey: "toolbar.save",
      language: "fr",
      content: { text: "Sauvegarder", state: "draft" },
    } as const;

    const resolved = await resolveSemanticEditInput(
      facts,
      { sourceKey: candidate.sourceKey, language: candidate.language },
      config,
    );

    assert.equal(resolved.status, "resolved");
    if (resolved.status !== "resolved") return;
    const prepared = prepareSemanticEdit(resolved.input, candidate);

    assert.equal(prepared.status, "prepared");
    if (prepared.status !== "prepared") return;
    assert.deepStrictEqual(prepared.edit.content, {
      text: "Sauvegarder",
      state: "draft",
    });
    assert.deepStrictEqual(translation, {
      text: "Enregistrer",
      state: "reviewed",
    });
  });

  void it("stores the host's actual target location and selected expectations", async () => {
    const config = defineConfig({
      source: {
        read: () => ({
          scopes: [
            {
              range: "src/messages.ts",
              enumeration: "complete",
              records: [
                {
                  value: {
                    source: "Save",
                    context: {
                      file: "src/messages.ts",
                      line: 18,
                      screenshot: "shots/save.png",
                    },
                  },
                  bodyAvailability: "available",
                },
              ],
            },
          ],
        }),
      },
      keyOf: (unit) => `${unit.context.file}:${unit.context.line}`,
      translations: {
        languages: ["fr"],
        read(_language, sourceUnits) {
          return {
            scopes: [
              {
                range: "locales/fr.json",
                covers: sourceUnits.map(({ key }) => key),
                enumeration: "complete",
                records: [
                  {
                    value: {
                      text: "Enregistrer",
                      context: {
                        file: "locales/fr.json",
                        resourceKey: "messages.save",
                        sourceLine: 18,
                      },
                    },
                    bodyAvailability: "available",
                  },
                ],
              },
            ],
          };
        },
        matches: (unit, translation) =>
          unit.context.line === translation.context.sourceLine,
        contentOf: (translation) => translation.text,
      },
      translationWriteback: {
        locateExistingTarget({ translation }) {
          return {
            status: "located",
            locator: {
              file: translation.translation.context.file,
              key: translation.translation.context.resourceKey,
            },
          };
        },
        locateNewTarget({ sourceUnit, language }) {
          return {
            status: "located",
            locator: {
              file: `locales/${language}.json`,
              key: `line-${sourceUnit.unit.context.line}`,
            },
          };
        },
        dependencies: ({ sourceUnit }) => ({
          screenshot: sourceUnit.unit.context.screenshot,
        }),
        write: () => undefined,
      },
    });
    const facts = await readFacts(config);

    const prepared = await resolveAndPrepareSemanticEdit(
      facts,
      {
        sourceKey: "src/messages.ts:18",
        language: "fr",
        content: "Enregistrer le formulaire",
      },
      config,
    );

    assert.equal(prepared.status, "prepared");
    if (prepared.status !== "prepared") return;
    assert.deepStrictEqual(JSON.parse(JSON.stringify(prepared.edit)), {
      formatVersion: "l10n.semantic-edit/v1",
      createdFromFactsVersion: facts.version,
      sourceKey: "src/messages.ts:18",
      language: "fr",
      target: {
        kind: "existing",
        locator: { file: "locales/fr.json", key: "messages.save" },
      },
      content: "Enregistrer le formulaire",
      expected: {
        source: "Save",
        target: { status: "present", content: "Enregistrer" },
        dependencies: { screenshot: "shots/save.png" },
      },
    });
  });

  void it("keeps write observations stable while the host mutates its raw resource", async () => {
    for (const failAfterWrite of [false, true]) {
      const source = { id: "source:A", source: "Save" };
      const translation = {
        id: "target:A",
        text: "Old translation",
      };
      const locations = new WeakMap([
        [translation, { file: "memory.fr", key: "actual-target" }],
      ]);
      const config = defineConfig({
        source: {
          read: () => ({
            scopes: [
              {
                range: "memory-source",
                enumeration: "complete",
                records: [{ value: source, bodyAvailability: "available" }],
              },
            ],
          }),
        },
        keyOf(unit) {
          assert.strictEqual(unit, source);
          return unit.id;
        },
        translations: {
          languages: ["fr"],
          read(_language, sourceUnits) {
            return {
              scopes: [
                {
                  range: "memory-target",
                  covers: sourceUnits.map(({ key }) => key),
                  enumeration: "complete",
                  records: [
                    { value: translation, bodyAvailability: "available" },
                  ],
                },
              ],
            };
          },
          matches(unit, actualTranslation) {
            assert.strictEqual(unit, source);
            assert.strictEqual(actualTranslation, translation);
            return (
              unit.id === "source:A" && actualTranslation.id === "target:A"
            );
          },
          contentOf: (actualTranslation) => actualTranslation.text,
        },
        translationWriteback: {
          locateExistingTarget({ sourceUnit, translation: actualTranslation }) {
            assert.strictEqual(sourceUnit.unit, source);
            assert.strictEqual(actualTranslation.translation, translation);
            const locator = locations.get(actualTranslation.translation);
            assert.ok(locator);
            return { status: "located", locator };
          },
          locateNewTarget: () => ({
            status: "notWritable",
            reason: "本场景修改已有目标。",
          }),
          write({ edit, currentTranslation }) {
            assert.strictEqual(currentTranslation?.translation, translation);
            translation.text = textContent(edit.content);
            if (failAfterWrite)
              throw new Error("资源已修改，但存储随后报告失败。");
          },
        },
      });
      const facts = await readFacts(config);
      const prepared = await resolveAndPrepareSemanticEdit(
        facts,
        { sourceKey: "source:A", language: "fr", content: "New translation" },
        config,
      );
      assert.equal(prepared.status, "prepared");
      if (prepared.status !== "prepared") continue;

      const savedEdit = JSON.parse(
        JSON.stringify(prepared.edit),
      ) as typeof prepared.edit;
      const result = await applySemanticEdits([savedEdit], config);
      const editResult = result.results[0];

      assert.equal(
        editResult?.status,
        failAfterWrite ? "writeFailed" : "written",
      );
      assert.equal(translation.text, "New translation");
      assert.equal(
        editResult?.before?.translations[0]?.translation.text,
        "Old translation",
      );
      assert.equal(
        editResult?.after?.translations[0]?.translation.text,
        "New translation",
      );
      assert.equal(editResult?.before?.factsVersion, facts.version);
      assert.notEqual(
        editResult?.before?.factsVersion,
        editResult?.after?.factsVersion,
      );
      assert.equal(savedEdit.expected.target.status, "present");
      if (savedEdit.expected.target.status === "present")
        assert.equal(savedEdit.expected.target.content, "Old translation");
      translation.text = "Later external change";
      assert.equal(
        editResult?.after?.translations[0]?.translation.text,
        "New translation",
      );
    }
  });

  void it("applies a saved edit after unrelated source and target metadata changes", async () => {
    const state = {
      sourceText: "Save",
      screenshot: "shots/save-before.png",
      translationText: "Enregistrer",
      annotation: "reviewed",
    };
    const config = defineConfig({
      source: {
        read: () => ({
          scopes: [
            {
              range: "src/messages.ts",
              enumeration: "complete",
              records: [
                {
                  value: {
                    source: state.sourceText,
                    context: {
                      file: "src/messages.ts",
                      line: 18,
                      screenshot: state.screenshot,
                    },
                  },
                  bodyAvailability: "available",
                },
              ],
            },
          ],
        }),
      },
      keyOf: (unit) => `${unit.context.file}:${unit.context.line}`,
      translations: {
        languages: ["fr"],
        read(_language, sourceUnits) {
          return {
            scopes: [
              {
                range: "locales/fr.json",
                covers: sourceUnits.map(({ key }) => key),
                enumeration: "complete",
                records: [
                  {
                    value: {
                      text: state.translationText,
                      context: {
                        file: "locales/fr.json",
                        resourceKey: "messages.save",
                        sourceLine: 18,
                        annotation: state.annotation,
                      },
                    },
                    bodyAvailability: "available",
                  },
                ],
              },
            ],
          };
        },
        matches: (unit, translation) =>
          unit.context.line === translation.context.sourceLine,
        contentOf: (translation) => translation.text,
      },
      translationWriteback: {
        locateExistingTarget: ({ translation }) => ({
          status: "located",
          locator: {
            file: translation.translation.context.file,
            key: translation.translation.context.resourceKey,
          },
        }),
        locateNewTarget: ({ sourceUnit, language }) => ({
          status: "located",
          locator: {
            file: `locales/${language}.json`,
            key: `line-${sourceUnit.unit.context.line}`,
          },
        }),
        write({ edit }) {
          state.translationText = textContent(edit.content);
        },
      },
    });
    const facts = await readFacts(config);
    const prepared = await resolveAndPrepareSemanticEdit(
      facts,
      {
        sourceKey: "src/messages.ts:18",
        language: "fr",
        content: "Sauvegarder",
      },
      config,
    );
    assert.equal(prepared.status, "prepared");
    if (prepared.status !== "prepared") return;
    const savedEdit = JSON.parse(
      JSON.stringify(prepared.edit),
    ) as typeof prepared.edit;

    state.screenshot = "shots/save-after.png";
    state.annotation = "revised outside the editor";

    const result = await applySemanticEdits([savedEdit], config);

    assert.equal(result.results[0]?.status, "written");
    assert.equal(state.translationText, "Sauvegarder");
    assert.notEqual(result.results[0]?.before?.factsVersion, facts.version);
    assert.equal(result.results[0]?.after?.association?.status, "matched");
    assert.equal(
      result.results[0]?.after?.translations[0]?.translation.text,
      "Sauvegarder",
    );

    state.translationText = "Modification externe";
    const staleResult = await applySemanticEdits([savedEdit], config);

    assert.equal(staleResult.results[0]?.status, "conflict");
    assert.equal(state.translationText, "Modification externe");
  });

  void it("creates a missing translation at the host location resolved from the raw source", async () => {
    const state: { translationText?: string } = {};
    const config = defineConfig({
      source: {
        read: () => ({
          scopes: [
            {
              range: "src/messages.ts",
              enumeration: "complete",
              records: [
                {
                  value: {
                    source: "Save",
                    context: {
                      file: "src/messages.ts",
                      line: 18,
                      resourceKey: "toolbar.save",
                    },
                  },
                  bodyAvailability: "available",
                },
              ],
            },
          ],
        }),
      },
      keyOf: (unit) => `${unit.context.file}:${unit.context.line}`,
      translations: {
        languages: ["fr"],
        read(_language, sourceUnits) {
          return {
            scopes: [
              {
                range: "locales/fr.json",
                covers: sourceUnits.map(({ key }) => key),
                enumeration: "complete",
                records:
                  state.translationText === undefined
                    ? []
                    : [
                        {
                          value: {
                            text: state.translationText,
                            context: {
                              file: "locales/fr.json",
                              resourceKey: "toolbar.save",
                              sourceLine: 18,
                            },
                          },
                          bodyAvailability: "available",
                        },
                      ],
              },
            ],
          };
        },
        matches: (unit, translation) =>
          unit.context.line === translation.context.sourceLine,
        contentOf: (translation) => translation.text,
      },
      translationWriteback: {
        locateExistingTarget: ({ translation }) => ({
          status: "located",
          locator: {
            file: translation.translation.context.file,
            key: translation.translation.context.resourceKey,
          },
        }),
        locateNewTarget: ({ sourceUnit, language }) => ({
          status: "located",
          locator: {
            file: `locales/${language}.json`,
            key: sourceUnit.unit.context.resourceKey,
          },
        }),
        write({ edit }) {
          state.translationText = textContent(edit.content);
        },
      },
    });
    const facts = await readFacts(config);
    const prepared = await resolveAndPrepareSemanticEdit(
      facts,
      {
        sourceKey: "src/messages.ts:18",
        language: "fr",
        content: "Sauvegarder",
      },
      config,
    );

    assert.equal(prepared.status, "prepared");
    if (prepared.status !== "prepared") return;
    assert.deepStrictEqual(prepared.edit.target, {
      kind: "create",
      locator: { file: "locales/fr.json", key: "toolbar.save" },
    });
    assert.deepStrictEqual(prepared.edit.expected.target, {
      status: "missing",
    });
    const savedEdit = JSON.parse(
      JSON.stringify(prepared.edit),
    ) as typeof prepared.edit;
    const result = await applySemanticEdits([savedEdit], config);

    assert.equal(result.results[0]?.status, "written");
    assert.equal(state.translationText, "Sauvegarder");
    assert.equal(
      result.results[0]?.after?.translations[0]?.translation.text,
      "Sauvegarder",
    );
  });

  void it("rechecks a shared target before each edit and reports incompatible input", async () => {
    const state = { translationText: "Shared original" };
    const config = defineConfig({
      source: {
        read: () => ({
          scopes: [
            {
              range: "src/messages.ts",
              enumeration: "complete",
              records: [
                {
                  value: { source: "Save", context: { line: 18 } },
                  bodyAvailability: "available",
                },
                {
                  value: { source: "Submit", context: { line: 19 } },
                  bodyAvailability: "available",
                },
              ],
            },
          ],
        }),
      },
      keyOf: (unit) => `message:${unit.context.line}`,
      translations: {
        languages: ["fr"],
        read(_language, sourceUnits) {
          return {
            scopes: [
              {
                range: "locales/fr.json",
                covers: sourceUnits.map(({ key }) => key),
                enumeration: "complete",
                records: [
                  {
                    value: {
                      text: state.translationText,
                      context: { file: "locales/fr.json", key: "shared" },
                    },
                    bodyAvailability: "available",
                  },
                ],
              },
            ],
          };
        },
        matches: () => true,
        contentOf: (translation) => translation.text,
      },
      translationWriteback: {
        locateExistingTarget: ({ translation }) => ({
          status: "located",
          locator: {
            file: translation.translation.context.file,
            key: translation.translation.context.key,
          },
        }),
        locateNewTarget: () => ({
          status: "located",
          locator: { file: "locales/fr.json", key: "new" },
        }),
        write({ edit }) {
          state.translationText = textContent(edit.content);
        },
      },
    });
    const facts = await readFacts(config);
    const first = await resolveAndPrepareSemanticEdit(
      facts,
      { sourceKey: "message:18", language: "fr", content: "First proposal" },
      config,
    );
    const second = await resolveAndPrepareSemanticEdit(
      facts,
      { sourceKey: "message:19", language: "fr", content: "Second proposal" },
      config,
    );
    assert.equal(first.status, "prepared");
    assert.equal(second.status, "prepared");
    if (first.status !== "prepared" || second.status !== "prepared") return;

    const result = await applySemanticEdits(
      [
        JSON.parse(JSON.stringify(first.edit)) as typeof first.edit,
        JSON.parse(JSON.stringify(second.edit)) as typeof second.edit,
      ],
      config,
    );

    assert.deepStrictEqual(
      result.results.map(({ status }) => status),
      ["written", "conflict"],
    );
    assert.equal(state.translationText, "First proposal");
    assert.equal(
      result.results[1]?.before?.translations[0]?.translation.text,
      "First proposal",
    );
  });
});
