import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  applySemanticEdits,
  defineConfig,
  prepareQualityConditionedSemanticEdit,
  prepareSemanticEdit,
  readFacts,
  resolveSemanticDeleteInput,
  resolveSemanticEditInput,
  StandardSchemaContractError,
  type FrameworkConfig,
  type FrameworkFacts,
  type JsonValue,
  type SemanticEditCandidate,
  type StandardSchemaV1,
  type TranslationUnitInput,
} from "../src/index.ts";
import {
  jsonValueSchema,
  schemaFromExamples,
  sourceSchemaFromExamples,
} from "./source-schema.ts";

function textContent(content: unknown): string {
  if (typeof content !== "string")
    throw new TypeError("测试适配器只接受字符串内容。");
  return content;
}

async function resolveAndPrepareSemanticEdit<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  facts: FrameworkFacts<TUnit, TTranslation, TBody, TUnavailable>,
  candidate: SemanticEditCandidate<TBody>,
  config: FrameworkConfig<TUnit, TTranslation, TBody, TUnavailable>,
) {
  const resolved = await resolveSemanticEditInput(
    facts,
    { sourceKey: candidate.sourceKey, language: candidate.language },
    config,
  );
  if (resolved.status !== "resolved") return resolved;
  return prepareSemanticEdit(resolved.input, candidate, config);
}

void describe("semantic edits", () => {
  void it("rejects an invalid saved source observation before current matching or writeback", async () => {
    const source = { id: "A", source: "Save" };
    const translation = { id: "A", text: "Enregistrer" };
    let matchesCalls = 0;
    let writeCalls = 0;
    let malformedSourceRead = false;
    const config = defineConfig({
      source: {
        schema: sourceSchemaFromExamples(source),
        read: () =>
          malformedSourceRead
            ? ({
                scopes: [
                  {
                    range: "messages.json",
                    enumeration: "complete",
                    records: "wrong",
                  },
                ],
              } as never)
            : {
                scopes: [
                  {
                    range: "messages.json",
                    enumeration: "complete",
                    records: [{ value: source, bodyAvailability: "available" }],
                  },
                ],
              },
      },
      keyOf: (unit) => unit.id,
      translations: {
        languages: ["fr"],
        schema: schemaFromExamples(translation),
        contentSchema: jsonValueSchema,
        contentOf: (value) => value.text,
        read: (_language, units) => ({
          scopes: [
            {
              range: "fr.json",
              covers: units.map(({ key }) => key),
              enumeration: "complete",
              records: [{ value: translation, bodyAvailability: "available" }],
            },
          ],
        }),
        matches: () => {
          matchesCalls += 1;
          return true;
        },
      },
      translationWriteback: {
        locateExistingTarget: () => ({ status: "located", locator: "A" }),
        locateNewTarget: () => ({
          status: "notWritable",
          reason: "此场景不会新建译文。",
        }),
        write: () => {
          writeCalls += 1;
        },
      },
    });
    const facts = await readFacts(config);
    const resolved = await resolveSemanticEditInput(
      facts,
      { sourceKey: "A", language: "fr" },
      config,
    );
    assert.equal(resolved.status, "resolved");
    if (resolved.status !== "resolved") return;
    const prepared = await prepareSemanticEdit(
      resolved.input,
      { sourceKey: "A", language: "fr", content: "Updated" },
      config,
    );
    assert.equal(prepared.status, "prepared");
    if (prepared.status !== "prepared" || prepared.edit.operation !== "write")
      return;

    matchesCalls = 0;
    malformedSourceRead = true;
    await assert.rejects(
      () => applySemanticEdits([prepared.edit], config),
      StandardSchemaContractError,
    );
    malformedSourceRead = false;
    const invalidConfig = {
      ...config,
      translations: { ...config.translations, schema: undefined },
    } as unknown as typeof config;
    await assert.rejects(
      () => applySemanticEdits([prepared.edit], invalidConfig),
      (error: unknown) =>
        error instanceof StandardSchemaContractError &&
        error.kind === "schema-mismatch",
    );
    const invalidEdit = {
      ...prepared.edit,
      expected: {
        ...prepared.edit.expected,
        source: { ...prepared.edit.expected.source, content: 7 },
      },
    };
    await assert.rejects(() => applySemanticEdits([invalidEdit], config), {
      name: "StandardSchemaContractError",
    });
    const invalidHistoricalUnit = {
      ...prepared.edit,
      expected: {
        ...prepared.edit.expected,
        source: {
          ...prepared.edit.expected.source,
          unit: { id: "A", source: 7 },
          content: 7,
        },
      },
    };
    await assert.rejects(
      () => applySemanticEdits([invalidHistoricalUnit], config),
      { name: "StandardSchemaContractError" },
    );
    assert.equal(matchesCalls, 0);
    assert.equal(writeCalls, 0);
  });

  void it("validates a directly supplied delete history before matching or locating", async () => {
    type Unit = { readonly id: string; readonly source: string };
    type Translation = { readonly id: string; readonly text: string };
    const unit: Unit = { id: "removed", source: "" };
    const translation: Translation = {
      id: "removed",
      text: "Cible",
    };
    let matchesCalls = 0;
    let locateCalls = 0;
    const sourceSchema: StandardSchemaV1<Unit, Unit> = {
      "~standard": {
        version: 1,
        vendor: "lioni-test-delete-history",
        validate(value) {
          if (
            typeof value === "object" &&
            value !== null &&
            !Array.isArray(value) &&
            typeof (value as Record<string, unknown>).id === "string" &&
            typeof (value as Record<string, unknown>).source === "string" &&
            (value as Record<string, unknown>).source !== ""
          )
            return { value: value as Unit };
          return { issues: [{ message: "原文单元必须包含非空正文。" }] };
        },
      },
    };
    const config = defineConfig({
      source: {
        schema: sourceSchema,
        read: () => ({
          scopes: [{ range: "src", enumeration: "complete", records: [] }],
        }),
      },
      keyOf: ({ id }) => id,
      translations: {
        languages: ["fr"],
        schema: schemaFromExamples(translation),
        contentSchema: jsonValueSchema,
        read: () => ({
          scopes: [
            {
              range: "fr",
              covers: [],
              enumeration: "complete",
              records: [{ value: translation, bodyAvailability: "available" }],
            },
          ],
        }),
        matches: (historicalUnit, actualTranslation) => {
          matchesCalls += 1;
          return historicalUnit.id === actualTranslation.id;
        },
        contentOf: (actualTranslation) => actualTranslation.text,
      },
      translationWriteback: {
        locateExistingTarget: () => {
          locateCalls += 1;
          return { status: "located", locator: "removed" };
        },
        locateNewTarget: () => ({
          status: "notWritable",
          reason: "此场景不会新建译文。",
        }),
      },
    });
    const facts = await readFacts(config);

    await assert.rejects(
      resolveSemanticDeleteInput(
        facts,
        { sourceKey: "removed", language: "fr" },
        unit,
        "src",
        ["fr"],
        config,
      ),
      (error: unknown) =>
        error instanceof StandardSchemaContractError &&
        error.kind === "schema-mismatch",
    );
    assert.equal(matchesCalls, 0);
    assert.equal(locateCalls, 0);

    const result = await resolveSemanticDeleteInput(
      facts,
      { sourceKey: "removed", language: "fr" },
      { ...unit, source: "Removed" },
      "src",
      ["fr"],
      config,
    );
    assert.equal(result.status, "resolved");
    assert.equal(matchesCalls, 1);
    assert.equal(locateCalls, 1);
  });

  void it("prepares a structured edit without a writer, QA, or baseline", async () => {
    const source = { source: "Save", context: { key: "toolbar.save" } };
    const translation = { text: "Enregistrer", state: "reviewed" };
    const config = defineConfig({
      source: {
        schema: sourceSchemaFromExamples(source),
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
        schema: schemaFromExamples(translation),
        contentSchema: jsonValueSchema,
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
    const prepared = await prepareSemanticEdit(
      resolved.input,
      candidate,
      config,
    );

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

  void it("validates an independent async string body before direct write and reread", async () => {
    const source = {
      source: ["Open", "Save"],
      context: { key: "toolbar.save" },
    };
    const state = { text: "Enregistrer", writes: 0, validations: 0 };
    const translation = { key: "toolbar.save", text: "Enregistrer" };
    const contentSchema: StandardSchemaV1<string, string> = {
      "~standard": {
        version: 1,
        vendor: "lioni-test-async-body",
        async validate(value) {
          state.validations += 1;
          await Promise.resolve();
          return typeof value === "string"
            ? { value }
            : { issues: [{ message: "译文正文必须是字符串。" }] };
        },
      },
    };
    const config = defineConfig({
      source: {
        schema: sourceSchemaFromExamples(source),
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
      keyOf: (unit) => unit.context.key,
      translations: {
        languages: ["fr"],
        schema: schemaFromExamples(translation),
        contentSchema,
        read(_language, sourceUnits) {
          return {
            scopes: [
              {
                range: "locales/fr.json",
                covers: sourceUnits.map(({ key }) => key),
                enumeration: "complete",
                records: [
                  {
                    value: { key: translation.key, text: state.text },
                    bodyAvailability: "available",
                  },
                ],
              },
            ],
          };
        },
        matches: (unit, actualTranslation) =>
          unit.context.key === actualTranslation.key,
        contentOf: (actualTranslation) => actualTranslation.text,
      },
      translationWriteback: {
        locateExistingTarget: ({ translation: actualTranslation }) => ({
          status: "located",
          locator: actualTranslation.translation.key,
        }),
        locateNewTarget: () => ({
          status: "notWritable",
          reason: "本场景修改已有译文。",
        }),
        write({ edit }) {
          if (edit.operation !== "write")
            throw new Error("本场景只支持写入候选正文。");
          state.text = edit.content;
          state.writes += 1;
        },
      },
    });
    const candidate: SemanticEditCandidate<string> = {
      sourceKey: "toolbar.save",
      language: "fr",
      content: "Sauvegarder",
    };

    await assert.rejects(
      prepareQualityConditionedSemanticEdit(config, {
        candidate: {
          ...candidate,
          content: 42,
        } as unknown as SemanticEditCandidate<string>,
      }),
      (error: unknown) =>
        error instanceof StandardSchemaContractError &&
        error.kind === "schema-mismatch",
    );
    assert.equal(state.writes, 0);

    const preparation = await prepareQualityConditionedSemanticEdit(config, {
      candidate,
    });
    assert.equal(preparation.status, "not-required");
    if (preparation.status !== "not-required") return;
    assert.equal(preparation.preparation.status, "prepared");
    if (preparation.preparation.status !== "prepared") return;
    assert.equal(preparation.preparation.edit.content, "Sauvegarder");
    assert.equal(state.text, "Enregistrer");

    const savedEdit = JSON.parse(
      JSON.stringify(preparation.preparation.edit),
    ) as typeof preparation.preparation.edit;
    const applied = await applySemanticEdits([savedEdit], config);
    assert.equal(applied.results[0]?.status, "written");
    assert.equal(
      applied.results[0]?.after?.translations[0]?.content,
      "Sauvegarder",
    );
    assert.equal(state.text, "Sauvegarder");
    assert.ok(state.validations >= 4);
    assert.equal(state.writes, 1);
  });

  void it("stores the host's actual target location and selected expectations", async () => {
    const config = defineConfig({
      source: {
        schema: sourceSchemaFromExamples({
          source: "Save",
          context: {
            file: "src/messages.ts",
            line: 18,
            screenshot: "shots/save.png",
          },
        }),
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
        schema: schemaFromExamples({
          text: "Enregistrer",
          context: {
            file: "locales/fr.json",
            resourceKey: "messages.save",
            sourceLine: 18,
          },
        }),
        contentSchema: jsonValueSchema,
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
          screenshots: [sourceUnit.unit.context.screenshot],
          sourceLine: sourceUnit.unit.context.line,
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
      formatVersion: "lioni.semantic-edit/v2",
      operation: "write",
      createdFromFactsVersion: facts.version,
      sourceKey: "src/messages.ts:18",
      language: "fr",
      target: {
        kind: "existing",
        locator: { file: "locales/fr.json", key: "messages.save" },
      },
      content: "Enregistrer le formulaire",
      expected: {
        source: {
          presence: "present",
          range: "src/messages.ts",
          unit: {
            source: "Save",
            context: {
              file: "src/messages.ts",
              line: 18,
              screenshot: "shots/save.png",
            },
          },
          content: "Save",
        },
        target: {
          status: "present",
          content: "Enregistrer",
          range: "locales/fr.json",
          scopes: ["locales/fr.json"],
        },
        dependencies: {
          screenshots: ["shots/save.png"],
          sourceLine: 18,
        },
      },
    });
  });

  void it("rejects writeback dependencies that cannot be saved as JSON", async () => {
    const source = { source: "Save", context: { key: "toolbar.save" } };
    const translation = { text: "Enregistrer" };
    const config = defineConfig({
      source: {
        schema: sourceSchemaFromExamples(source),
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
        schema: schemaFromExamples(translation),
        contentSchema: jsonValueSchema,
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
        contentOf: (actualTranslation) => actualTranslation.text,
      },
      translationWriteback: {
        locateExistingTarget: () => ({
          status: "located",
          locator: { file: "locales/fr.json", key: "toolbar.save" },
        }),
        locateNewTarget: () => ({
          status: "notWritable",
          reason: "本场景修改已有译文。",
        }),
        dependencies: () =>
          new Map([["resource", "locales/fr.json"]]) as unknown as JsonValue,
      },
    });
    const facts = await readFacts(config);

    await assert.rejects(
      resolveSemanticEditInput(
        facts,
        { sourceKey: "toolbar.save", language: "fr" },
        config,
      ),
      (error: unknown) =>
        error instanceof StandardSchemaContractError &&
        error.kind === "invalid-json",
    );
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
          schema: sourceSchemaFromExamples(source),
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
          schema: schemaFromExamples(translation),
          contentSchema: jsonValueSchema,
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
        schema: sourceSchemaFromExamples({
          source: "Save",
          context: {
            file: "src/messages.ts",
            line: 18,
            screenshot: "shots/save-before.png",
          },
        }),
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
        schema: schemaFromExamples({
          text: "Enregistrer",
          context: {
            file: "locales/fr.json",
            resourceKey: "toolbar.save",
            sourceLine: 18,
          },
        }),
        contentSchema: jsonValueSchema,
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
        schema: sourceSchemaFromExamples({
          source: "Save",
          context: {
            file: "src/messages.ts",
            line: 18,
            resourceKey: "toolbar.save",
          },
        }),
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
        schema: schemaFromExamples({
          text: "Enregistrer",
          context: {
            file: "locales/fr.json",
            resourceKey: "toolbar.save",
            sourceLine: 18,
          },
        }),
        contentSchema: jsonValueSchema,
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
        schema: sourceSchemaFromExamples(
          { source: "Save", context: { line: 18 } },
          { source: "Submit", context: { line: 19 } },
        ),
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
        schema: schemaFromExamples({
          text: "Enregistrer",
          context: { file: "locales/fr.json", key: "shared" },
        }),
        contentSchema: jsonValueSchema,
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
