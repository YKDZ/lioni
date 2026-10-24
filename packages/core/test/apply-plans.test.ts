import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  advanceProcessingBaseline,
  applyUpdatePlan,
  compareProcessingBaseline,
  createUpdatePlan,
  defineConfig,
  readFacts,
  type FrameworkConfig,
  type ProcessingBaseline,
  type ProcessingBaselineStore,
} from "../src/index.ts";

type Unit = {
  readonly id: string;
  readonly source: string;
  readonly context?: { readonly screenshot?: string; readonly note?: string };
};
type Translation = {
  readonly id: string;
  text: string;
  readonly members?: readonly string[];
  readonly context?: { readonly label?: string };
};

function makeConfig(
  units: readonly Unit[],
  translations: readonly Translation[],
  options: {
    readonly updatePolicy?: FrameworkConfig<Unit, Translation>["updatePolicy"];
    readonly translationWriteback?: FrameworkConfig<
      Unit,
      Translation
    >["translationWriteback"];
  } = {},
): FrameworkConfig<Unit, Translation> {
  return defineConfig({
    source: {
      read: () => ({
        scopes: [
          {
            range: "source/messages.json",
            enumeration: "complete",
            records: units.map((value) => ({
              value,
              bodyAvailability: "available" as const,
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
              bodyAvailability: "available" as const,
            })),
          },
        ],
      }),
      matches: (unit, translation) => unit.id === translation.id,
    },
    ...(options.updatePolicy === undefined
      ? {}
      : { updatePolicy: options.updatePolicy }),
    ...(options.translationWriteback === undefined
      ? {}
      : { translationWriteback: options.translationWriteback }),
  });
}

function makeEditableConfig(
  unit: Unit,
  translation: Translation,
  options: {
    readonly candidate: string | ((sourceUnit: Unit | undefined) => string);
    readonly screenshotDependency?: boolean;
  },
): FrameworkConfig<Unit, Translation> {
  return makeConfig([unit], [translation], {
    updatePolicy: ({ sourceUnit }) => ({
      action: "candidate",
      candidate:
        typeof options.candidate === "string"
          ? options.candidate
          : options.candidate(sourceUnit as Unit | undefined),
    }),
    translationWriteback: {
      targetContent: (actualTranslation) => actualTranslation.text,
      locateExistingTarget: ({ translation: actualTranslation }) => ({
        status: "located",
        locator: { id: actualTranslation.translation.id },
      }),
      locateNewTarget: ({ sourceUnit }) => ({
        status: "located",
        locator: { id: sourceUnit.key },
      }),
      ...(options.screenshotDependency
        ? {
            dependencies: ({ sourceUnit }) => ({
              screenshot: sourceUnit.unit.context?.screenshot ?? null,
            }),
          }
        : {}),
      write({ edit, currentTranslation }) {
        if (
          currentTranslation === undefined ||
          typeof edit.content !== "string"
        )
          throw new TypeError("测试候选必须更新已有译文文本。");
        currentTranslation.translation.text = edit.content;
      },
    },
  });
}

class MemoryBaselineStore implements ProcessingBaselineStore {
  baseline: ProcessingBaseline | undefined;
  failSaves = false;

  async load(): Promise<ProcessingBaseline | undefined> {
    return structuredClone(this.baseline);
  }

  async save(baseline: ProcessingBaseline): Promise<void> {
    if (this.failSaves) throw new Error("基线存储暂不可用。");
    this.baseline = structuredClone(baseline);
  }
}

void describe("apply update plans", () => {
  void it("retains a selected item and leaves other source-language history unchanged", async () => {
    const baselineStore = new MemoryBaselineStore();
    const baselineConfig = makeConfig(
      [
        { id: "A", source: "Save" },
        { id: "B", source: "Cancel" },
      ],
      [
        { id: "A", text: "Enregistrer" },
        { id: "B", text: "Annuler" },
      ],
    );
    const baselineFacts = await readFacts(baselineConfig);
    const matches = baselineConfig.translations?.matches;
    assert.ok(matches);
    await advanceProcessingBaseline(
      baselineStore,
      baselineFacts,
      [
        { sourceKey: "A", language: "fr" },
        { sourceKey: "B", language: "fr" },
      ],
      { matches },
    );

    const currentConfig = makeConfig(
      [
        { id: "A", source: "Save now" },
        { id: "B", source: "Cancel" },
      ],
      [
        { id: "A", text: "Enregistrer" },
        { id: "B", text: "Annuler" },
      ],
    );
    const currentFacts = await readFacts(currentConfig);
    const plan = createUpdatePlan(
      currentFacts,
      baselineStore.baseline,
      currentConfig,
    );

    const result = await applyUpdatePlan(
      plan,
      [{ sourceKey: "A", language: "fr", choice: "retain" }],
      currentConfig,
      baselineStore,
    );

    assert.equal(
      result.contentResults.find(({ sourceKey }) => sourceKey === "A")?.status,
      "retained",
    );
    assert.equal(
      result.contentResults.find(({ sourceKey }) => sourceKey === "B")?.status,
      "notSelected",
    );
    assert.equal(
      result.baselineResults.find(({ sourceKey }) => sourceKey === "A")?.status,
      "advanced",
    );
    assert.equal(
      result.baselineResults.find(({ sourceKey }) => sourceKey === "B")?.status,
      "notSelected",
    );
    const advancedA = baselineStore.baseline?.entries.find(
      ({ sourceKey }) => sourceKey === "A",
    );
    assert.equal(
      (advancedA?.source.unit as Unit | undefined)?.source,
      "Save now",
    );
    assert.equal(
      (
        baselineStore.baseline?.entries.find(
          ({ sourceKey }) => sourceKey === "B",
        )?.source.unit as Unit | undefined
      )?.source,
      "Cancel",
    );
  });

  void it("rejects a retain decision when the saved target input has changed", async () => {
    const baselineStore = new MemoryBaselineStore();
    const baselineConfig = makeConfig(
      [{ id: "A", source: "Save" }],
      [{ id: "A", text: "Enregistrer" }],
    );
    const matches = baselineConfig.translations?.matches;
    assert.ok(matches);
    await advanceProcessingBaseline(
      baselineStore,
      await readFacts(baselineConfig),
      [{ sourceKey: "A", language: "fr" }],
      { matches },
    );

    const liveUnit = { id: "A", source: "Save now" };
    const liveTranslation = { id: "A", text: "Enregistrer" };
    const currentConfig = makeConfig([liveUnit], [liveTranslation]);
    const plan = createUpdatePlan(
      await readFacts(currentConfig),
      baselineStore.baseline,
      currentConfig,
    );
    const baselineBefore = structuredClone(baselineStore.baseline);
    liveTranslation.text = "Sauvegarder";

    const result = await applyUpdatePlan(
      plan,
      [{ sourceKey: "A", language: "fr", choice: "retain" }],
      currentConfig,
      baselineStore,
    );

    assert.equal(result.contentResults[0]?.status, "conflict");
    assert.equal(result.baselineResults[0]?.status, "notAttempted");
    assert.deepStrictEqual(baselineStore.baseline, baselineBefore);
  });

  void it("rejects a removed-source plan if the source has reappeared", async () => {
    const baselineStore = new MemoryBaselineStore();
    const initialConfig = makeConfig(
      [{ id: "A", source: "Save" }],
      [{ id: "A", text: "Enregistrer" }],
    );
    const matches = initialConfig.translations?.matches;
    assert.ok(matches);
    await advanceProcessingBaseline(
      baselineStore,
      await readFacts(initialConfig),
      [{ sourceKey: "A", language: "fr" }],
      { matches },
    );

    const removedConfig = makeConfig([], [{ id: "A", text: "Enregistrer" }]);
    const plan = createUpdatePlan(
      await readFacts(removedConfig),
      baselineStore.baseline,
      removedConfig,
    );
    assert.equal(plan.items[0]?.expectedInput?.source.presence, "removed");
    const baselineBefore = structuredClone(baselineStore.baseline);
    const reappearedConfig = makeConfig(
      [{ id: "A", source: "Save" }],
      [{ id: "A", text: "Enregistrer" }],
    );

    const result = await applyUpdatePlan(
      plan,
      [{ sourceKey: "A", language: "fr", choice: "retain" }],
      reappearedConfig,
      baselineStore,
    );

    assert.equal(result.contentResults[0]?.status, "conflict");
    assert.deepStrictEqual(baselineStore.baseline, baselineBefore);
  });

  void it("writes a selected candidate through semantic edits and advances from the confirmed read", async () => {
    const baselineStore = new MemoryBaselineStore();
    const initialConfig = makeEditableConfig(
      { id: "A", source: "Save" },
      { id: "A", text: "Enregistrer" },
      { candidate: "Sauvegarder" },
    );
    const matches = initialConfig.translations?.matches;
    assert.ok(matches);
    await advanceProcessingBaseline(
      baselineStore,
      await readFacts(initialConfig),
      [{ sourceKey: "A", language: "fr" }],
      { matches },
    );

    const currentConfig = makeEditableConfig(
      { id: "A", source: "Save now" },
      { id: "A", text: "Enregistrer" },
      { candidate: "Sauvegarder" },
    );
    const plan = createUpdatePlan(
      await readFacts(currentConfig),
      baselineStore.baseline,
      currentConfig,
    );

    const result = await applyUpdatePlan(
      plan,
      [{ sourceKey: "A", language: "fr", choice: "candidate" }],
      currentConfig,
      baselineStore,
    );

    assert.equal(result.contentResults[0]?.status, "written");
    assert.equal(result.baselineResults[0]?.status, "advanced");
    const savedTranslation = baselineStore.baseline?.entries[0]?.association
      .translations[0]?.translation as Translation | undefined;
    assert.equal(savedTranslation?.text, "Sauvegarder");
  });

  void it("compares declared edit dependencies with the saved plan context", async () => {
    const baselineStore = new MemoryBaselineStore();
    const initialConfig = makeEditableConfig(
      { id: "A", source: "Save", context: { screenshot: "shots/old.png" } },
      { id: "A", text: "Enregistrer" },
      { candidate: "Sauvegarder", screenshotDependency: true },
    );
    const matches = initialConfig.translations?.matches;
    assert.ok(matches);
    await advanceProcessingBaseline(
      baselineStore,
      await readFacts(initialConfig),
      [{ sourceKey: "A", language: "fr" }],
      { matches },
    );

    const liveUnit = {
      id: "A",
      source: "Save now",
      context: { screenshot: "shots/plan.png" },
    };
    const liveTranslation = { id: "A", text: "Enregistrer" };
    const currentConfig = makeEditableConfig(liveUnit, liveTranslation, {
      candidate: (sourceUnit) =>
        `Generated from ${sourceUnit?.context?.screenshot}`,
      screenshotDependency: true,
    });
    const plan = createUpdatePlan(
      await readFacts(currentConfig),
      baselineStore.baseline,
      currentConfig,
    );
    liveUnit.context.screenshot = "shots/after-plan.png";

    const result = await applyUpdatePlan(
      plan,
      [{ sourceKey: "A", language: "fr", choice: "candidate" }],
      currentConfig,
      baselineStore,
    );

    assert.equal(result.contentResults[0]?.status, "conflict");
    assert.equal(liveTranslation.text, "Enregistrer");
    assert.equal(result.baselineResults[0]?.status, "notAttempted");
  });

  void it("allows candidate application after undeclared metadata changes", async () => {
    const baselineStore = new MemoryBaselineStore();
    const initialConfig = makeEditableConfig(
      { id: "A", source: "Save" },
      { id: "A", text: "Enregistrer" },
      { candidate: "Sauvegarder" },
    );
    const matches = initialConfig.translations?.matches;
    assert.ok(matches);
    await advanceProcessingBaseline(
      baselineStore,
      await readFacts(initialConfig),
      [{ sourceKey: "A", language: "fr" }],
      { matches },
    );

    const liveUnit = {
      id: "A",
      source: "Save now",
      context: { screenshot: "shots/plan.png", note: "before" },
    };
    const liveTranslation = {
      id: "A",
      text: "Enregistrer",
      context: { label: "before" },
    };
    const currentConfig = makeEditableConfig(liveUnit, liveTranslation, {
      candidate: "Sauvegarder",
    });
    const plan = createUpdatePlan(
      await readFacts(currentConfig),
      baselineStore.baseline,
      currentConfig,
    );
    liveUnit.context.note = "after";
    liveTranslation.context.label = "after";

    const result = await applyUpdatePlan(
      plan,
      [{ sourceKey: "A", language: "fr", choice: "candidate" }],
      currentConfig,
      baselineStore,
    );

    assert.equal(result.contentResults[0]?.status, "written");
    assert.equal(result.baselineResults[0]?.status, "advanced");
    assert.equal(liveTranslation.text, "Sauvegarder");
  });

  void it("reports confirmed content separately when saving its baseline fails", async () => {
    const baselineStore = new MemoryBaselineStore();
    const initialConfig = makeEditableConfig(
      { id: "A", source: "Save" },
      { id: "A", text: "Enregistrer" },
      { candidate: "Sauvegarder" },
    );
    const matches = initialConfig.translations?.matches;
    assert.ok(matches);
    await advanceProcessingBaseline(
      baselineStore,
      await readFacts(initialConfig),
      [{ sourceKey: "A", language: "fr" }],
      { matches },
    );

    const liveTranslation = { id: "A", text: "Enregistrer" };
    const currentConfig = makeEditableConfig(
      { id: "A", source: "Save now" },
      liveTranslation,
      { candidate: "Sauvegarder" },
    );
    const plan = createUpdatePlan(
      await readFacts(currentConfig),
      baselineStore.baseline,
      currentConfig,
    );
    const baselineBefore = structuredClone(baselineStore.baseline);
    baselineStore.failSaves = true;

    const result = await applyUpdatePlan(
      plan,
      [{ sourceKey: "A", language: "fr", choice: "candidate" }],
      currentConfig,
      baselineStore,
    );

    assert.equal(result.contentResults[0]?.status, "written");
    assert.equal(result.baselineResults[0]?.status, "failed");
    assert.equal(liveTranslation.text, "Sauvegarder");
    assert.deepStrictEqual(baselineStore.baseline, baselineBefore);
  });

  void it("advances only the selected member of a shared target", async () => {
    const baselineStore = new MemoryBaselineStore();
    const sharedTranslation: Translation = {
      id: "shared",
      text: "Original",
      members: ["A", "B"],
    };
    const createSharedConfig = (
      units: readonly Unit[],
    ): FrameworkConfig<Unit, Translation> =>
      defineConfig({
        source: {
          read: () => ({
            scopes: [
              {
                range: "source/shared.json",
                enumeration: "complete",
                records: units.map((value) => ({
                  value,
                  bodyAvailability: "available" as const,
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
                range: "locales/shared.json",
                covers: sourceUnits.map(({ key }) => key),
                enumeration: "complete",
                records: [
                  { value: sharedTranslation, bodyAvailability: "available" },
                ],
              },
            ],
          }),
          matches: (unit, translation) =>
            translation.members?.includes(unit.id) ?? false,
        },
        updatePolicy: ({ sourceKey }) => ({
          action: "candidate",
          candidate: `Proposition ${sourceKey}`,
        }),
        translationWriteback: {
          targetContent: (translation) => translation.text,
          locateExistingTarget: () => ({
            status: "located",
            locator: { id: "shared" },
          }),
          locateNewTarget: () => ({
            status: "notWritable",
            reason: "共享目标已经存在。",
          }),
          write({ edit, currentTranslation }) {
            if (
              currentTranslation === undefined ||
              typeof edit.content !== "string"
            )
              throw new TypeError("测试候选必须更新已有译文文本。");
            currentTranslation.translation.text = edit.content;
          },
        },
      });

    const initialConfig = createSharedConfig([
      { id: "A", source: "Save" },
      { id: "B", source: "Save" },
    ]);
    const matches = initialConfig.translations?.matches;
    assert.ok(matches);
    await advanceProcessingBaseline(
      baselineStore,
      await readFacts(initialConfig),
      [
        { sourceKey: "A", language: "fr" },
        { sourceKey: "B", language: "fr" },
      ],
      { matches },
    );

    const currentConfig = createSharedConfig([
      { id: "A", source: "Save now" },
      { id: "B", source: "Save button" },
    ]);
    const plan = createUpdatePlan(
      await readFacts(currentConfig),
      baselineStore.baseline,
      currentConfig,
    );
    const result = await applyUpdatePlan(
      plan,
      [{ sourceKey: "A", language: "fr", choice: "candidate" }],
      currentConfig,
      baselineStore,
    );
    const currentFacts = await readFacts(currentConfig);
    const comparison = compareProcessingBaseline(
      currentFacts,
      baselineStore.baseline,
      { matches },
    );

    assert.equal(
      result.contentResults.find(({ sourceKey }) => sourceKey === "A")?.status,
      "written",
    );
    assert.equal(
      result.contentResults.find(({ sourceKey }) => sourceKey === "B")?.status,
      "notSelected",
    );
    assert.equal(
      result.baselineResults.find(({ sourceKey }) => sourceKey === "A")?.status,
      "advanced",
    );
    assert.equal(
      result.baselineResults.find(({ sourceKey }) => sourceKey === "B")?.status,
      "notSelected",
    );
    assert.equal(sharedTranslation.text, "Proposition A");
    assert.equal(
      comparison.changes.find(({ sourceKey }) => sourceKey === "B")?.status,
      "changed",
    );
    const baselineB = baselineStore.baseline?.entries.find(
      ({ sourceKey }) => sourceKey === "B",
    );
    assert.equal(
      (
        baselineB?.association.translations[0]?.translation as
          | Translation
          | undefined
      )?.text,
      "Original",
    );
  });
});
