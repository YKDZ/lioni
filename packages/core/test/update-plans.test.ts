import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  advanceProcessingBaseline,
  createUpdatePlan,
  defineConfig,
  readFacts,
  type FrameworkConfig,
  type ProcessingBaseline,
  type ProcessingBaselineStore,
} from "../src/index.ts";
import { createFileUpdatePlanStore } from "../src/node.ts";

type Unit = {
  readonly id: string;
  readonly source: string;
  readonly context: {
    readonly line: number;
    readonly screenshot?: string;
  };
};

type Translation = {
  readonly id: string;
  readonly text: string;
  readonly context?: { readonly resource: string };
};

function makeConfig(
  units: readonly Unit[],
  translations: readonly Translation[],
  options: {
    readonly sourceEnumeration?: "complete" | "partial" | "failed";
    readonly translationEnumeration?: "complete" | "partial" | "failed";
    readonly updatePolicy?: FrameworkConfig<Unit, Translation>["updatePolicy"];
  } = {},
): FrameworkConfig<Unit, Translation> {
  return defineConfig({
    source: {
      read: () => ({
        scopes: [
          {
            range: "source/messages.json",
            enumeration: options.sourceEnumeration ?? "complete",
            records: units.map((value) => ({
              value,
              bodyAvailability: "available" as const,
            })),
          },
        ],
      }),
    },
    keyOf: (unit: Unit) => unit.id,
    translations: {
      languages: ["fr"],
      read: (_language, sourceUnits) => ({
        scopes: [
          {
            range: "locales/fr.json",
            covers: sourceUnits.map(({ key }) => key),
            enumeration: options.translationEnumeration ?? "complete",
            records: translations.map((value) => ({
              value,
              bodyAvailability: "available" as const,
            })),
          },
        ],
      }),
      matches: (unit: Unit, translation: Translation) =>
        unit.id === translation.id,
    },
    ...(options.updatePolicy === undefined
      ? {}
      : { updatePolicy: options.updatePolicy }),
  });
}

class MemoryBaselineStore implements ProcessingBaselineStore {
  baseline: ProcessingBaseline | undefined;

  async load(): Promise<ProcessingBaseline | undefined> {
    return this.baseline;
  }

  async save(baseline: ProcessingBaseline): Promise<void> {
    this.baseline = baseline;
  }
}

async function establishBaseline(
  config: FrameworkConfig<Unit, Translation>,
  sourceKeys: readonly string[],
): Promise<MemoryBaselineStore> {
  const facts = await readFacts(config);
  const store = new MemoryBaselineStore();
  const result = await advanceProcessingBaseline(
    store,
    facts,
    sourceKeys.map((sourceKey) => ({ sourceKey, language: "fr" })),
  );
  assert.equal(result.outcome, "saved");
  return store;
}

void describe("update plans", () => {
  void it("reports insufficient history without making an item executable", async () => {
    const config = makeConfig(
      [{ id: "save-button", source: "Save", context: { line: 18 } }],
      [{ id: "save-button", text: "Enregistrer" }],
    );
    const facts = await readFacts(config);
    const factsBefore = structuredClone(facts);

    const plan = createUpdatePlan(facts, undefined, config);

    assert.deepStrictEqual(facts, factsBefore);
    assert.equal(plan.items.length, 1);
    assert.equal(plan.items[0]?.sourceKey, "save-button");
    assert.equal(plan.items[0]?.language, "fr");
    assert.equal(plan.items[0]?.change, "history-insufficient");
    assert.equal(plan.items[0]?.recommendation.action, "review");
    assert.equal(plan.items[0]?.executable, false);
    assert.ok(plan.items[0]?.blockedReason);
    assert.equal(plan.items[0]?.expectedInput?.source.value, "Save");
    assert.deepStrictEqual(
      plan.items[0]?.expectedInput?.association.translations.map(
        ({ translation }) => translation,
      ),
      [{ id: "save-button", text: "Enregistrer" }],
    );
  });

  void it("persists a plan only when explicitly requested", async () => {
    const config = makeConfig(
      [{ id: "save-button", source: "Save", context: { line: 18 } }],
      [{ id: "save-button", text: "Enregistrer" }],
    );
    const facts = await readFacts(config);
    const plan = createUpdatePlan(facts, undefined, config);
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "l10n-update-plan-test-"),
    );
    const store = createFileUpdatePlanStore(
      path.join(directory, "update-plan.json"),
    );

    try {
      assert.equal(await store.load(), undefined);
      await store.save(plan);
      assert.deepStrictEqual(await store.load(), plan);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  void it("does not treat an unrelated target record as an item to delete", async () => {
    const initialConfig = makeConfig(
      [{ id: "save-button", source: "Save", context: { line: 18 } }],
      [{ id: "save-button", text: "Enregistrer" }],
    );
    const initialFacts = await readFacts(initialConfig);
    const store = new MemoryBaselineStore();
    await advanceProcessingBaseline(store, initialFacts, [
      { sourceKey: "save-button", language: "fr" },
    ]);

    const currentConfig = makeConfig(
      [{ id: "save-button", source: "Save", context: { line: 18 } }],
      [{ id: "orphan", text: "Orphelin" }],
    );
    const facts = await readFacts(currentConfig);
    const plan = createUpdatePlan(facts, store.baseline, currentConfig);
    const item = plan.items[0];

    assert.equal(item?.change, "changed");
    assert.equal(item?.recommendation.action, "review");
    assert.equal(item?.executable, false);
    assert.ok(item?.blockedReason);
    assert.equal(
      plan.items.some(({ sourceKey }) => sourceKey === "orphan"),
      false,
    );
  });

  void it("blocks deletion suggestions without a matched target record", async () => {
    const initialConfig = makeConfig(
      [{ id: "save-button", source: "Save", context: { line: 18 } }],
      [{ id: "save-button", text: "Enregistrer" }],
    );
    const store = await establishBaseline(initialConfig, ["save-button"]);
    const currentConfig = makeConfig(
      [{ id: "save-button", source: "Save", context: { line: 18 } }],
      [{ id: "orphan", text: "Orphelin" }],
      {
        updatePolicy: () => ({ action: "delete" }),
      },
    );
    const facts = await readFacts(currentConfig);

    const plan = createUpdatePlan(facts, store.baseline, currentConfig);
    const item = plan.items[0];

    assert.equal(item?.recommendation.action, "delete");
    assert.equal(item?.expectedInput?.association.translations.length, 0);
    assert.equal(item?.executable, false);
    assert.ok(item?.blockedReason?.includes("没有可关联到该原文的目标条目"));
  });

  void it("does not claim the current edit contract can execute a deletion", async () => {
    const initialConfig = makeConfig(
      [{ id: "save-button", source: "Save", context: { line: 18 } }],
      [{ id: "save-button", text: "Enregistrer" }],
    );
    const store = await establishBaseline(initialConfig, ["save-button"]);
    const currentConfig = makeConfig(
      [{ id: "save-button", source: "Save", context: { line: 18 } }],
      [{ id: "save-button", text: "Enregistrer" }],
      { updatePolicy: () => ({ action: "delete" }) },
    );
    const facts = await readFacts(currentConfig);

    const plan = createUpdatePlan(facts, store.baseline, currentConfig);
    const item = plan.items[0];

    assert.equal(item?.recommendation.action, "delete");
    assert.equal(item?.expectedInput?.association.translations.length, 1);
    assert.equal(item?.executable, false);
    assert.ok(item?.blockedReason?.includes("不支持删除译文"));
  });

  void it("retains current translations and preserves only the relevant old and current inputs", async () => {
    const initialConfig = makeConfig(
      [{ id: "save-button", source: "Save", context: { line: 18 } }],
      [{ id: "save-button", text: "Enregistrer" }],
    );
    const store = await establishBaseline(initialConfig, ["save-button"]);
    const baselineBefore = structuredClone(store.baseline);
    const currentConfig = makeConfig(
      [{ id: "save-button", source: "Save now", context: { line: 42 } }],
      [{ id: "save-button", text: "Enregistrer" }],
    );
    const facts = await readFacts(currentConfig);

    const plan = createUpdatePlan(facts, store.baseline, currentConfig);
    const item = plan.items[0];

    assert.equal(item?.change, "changed");
    assert.equal(item?.recommendation.action, "retain");
    assert.ok(item?.recommendation.reason?.includes("若原文发生变化"));
    assert.equal(item?.executable, true);
    assert.equal(
      (item?.previous?.source.unit as Unit | undefined)?.source,
      "Save",
    );
    assert.equal(item?.expectedInput?.source.value, "Save now");
    assert.equal("context" in (item?.expectedInput?.source ?? {}), false);
    assert.deepStrictEqual(
      (item?.current?.source.unit as Unit | undefined)?.context,
      { line: 42 },
    );
    assert.deepStrictEqual(
      item?.expectedInput?.association.translations.map(
        ({ translation }) => translation,
      ),
      [{ id: "save-button", text: "Enregistrer" }],
    );
    assert.deepStrictEqual(store.baseline, baselineBefore);
  });

  void it("keeps the plan snapshot when the host later mutates its source and target objects", async () => {
    const initialConfig = makeConfig(
      [
        {
          id: "save-button",
          source: "Save",
          context: { line: 18, screenshot: "shots/before.png" },
        },
      ],
      [
        {
          id: "save-button",
          text: "Enregistrer",
          context: { resource: "locales/fr.json#save" },
        },
      ],
    );
    const store = await establishBaseline(initialConfig, ["save-button"]);
    const currentUnit = {
      id: "save-button",
      source: "Save now",
      context: { line: 18, screenshot: "shots/at-plan.png" },
    };
    const currentTranslation = {
      id: "save-button",
      text: "Enregistrer",
      context: { resource: "locales/fr.json#save" },
    };
    const currentConfig = makeConfig([currentUnit], [currentTranslation]);
    const facts = await readFacts(currentConfig);

    const plan = createUpdatePlan(facts, store.baseline, currentConfig);
    const item = plan.items[0];
    currentUnit.context.screenshot = "shots/after-plan.png";
    currentTranslation.context.resource = "locales/fr.json#renamed";
    currentTranslation.text = "Sauvegarder";

    assert.equal(
      (item?.previous?.source.unit as Unit | undefined)?.context.screenshot,
      "shots/before.png",
    );
    assert.equal(
      (item?.current?.source.unit as Unit | undefined)?.context.screenshot,
      "shots/at-plan.png",
    );
    assert.equal(
      item?.expectedInput?.association.translations[0]?.translation.text,
      "Enregistrer",
    );
    assert.deepStrictEqual(
      (
        item?.expectedInput?.association.translations[0]?.translation as
          | Translation
          | undefined
      )?.context,
      { resource: "locales/fr.json#save" },
    );
  });

  void it("allows a host policy to recommend a candidate through configuration", async () => {
    const initialConfig = makeConfig(
      [{ id: "save-button", source: "Save", context: { line: 18 } }],
      [{ id: "save-button", text: "Enregistrer" }],
    );
    const store = await establishBaseline(initialConfig, ["save-button"]);
    const currentConfig = makeConfig(
      [{ id: "save-button", source: "Save now", context: { line: 18 } }],
      [{ id: "save-button", text: "Enregistrer" }],
      {
        updatePolicy: ({ sourceUnit, translations }) => ({
          action: "candidate",
          candidate: {
            text: `Sauvegarder ${sourceUnit?.source}`,
            previous: translations[0]?.text,
          },
          reason: "宿主策略生成候选。",
        }),
      },
    );
    const facts = await readFacts(currentConfig);

    const plan = createUpdatePlan(facts, store.baseline, currentConfig);
    const item = plan.items[0];

    assert.equal(item?.change, "changed");
    assert.deepStrictEqual(item?.recommendation, {
      action: "candidate",
      candidate: { text: "Sauvegarder Save now", previous: "Enregistrer" },
      reason: "宿主策略生成候选。",
    });
    assert.equal(item?.executable, true);
  });

  void it("keeps host suggestions blocked when history is insufficient", async () => {
    const config = makeConfig(
      [{ id: "save-button", source: "Save", context: { line: 18 } }],
      [{ id: "save-button", text: "Enregistrer" }],
      {
        updatePolicy: () => ({
          action: "candidate",
          candidate: { text: "Sauvegarder" },
        }),
      },
    );
    const facts = await readFacts(config);

    const plan = createUpdatePlan(facts, undefined, config);
    const item = plan.items[0];

    assert.equal(item?.recommendation.action, "candidate");
    assert.equal(item?.change, "history-insufficient");
    assert.equal(item?.executable, false);
    assert.ok(item?.blockedReason);
  });

  void it("keeps additions tied to the complete historical source range", async () => {
    const initialConfig = makeConfig(
      [
        { id: "save-button", source: "Save", context: { line: 18 } },
        { id: "cancel-button", source: "Cancel", context: { line: 19 } },
      ],
      [
        { id: "save-button", text: "Enregistrer" },
        { id: "cancel-button", text: "Annuler" },
      ],
    );
    const store = await establishBaseline(initialConfig, [
      "save-button",
      "cancel-button",
    ]);
    const currentConfig = makeConfig(
      [
        { id: "save-button", source: "Save", context: { line: 18 } },
        { id: "cancel-button", source: "Cancel", context: { line: 19 } },
        { id: "help-button", source: "Help", context: { line: 20 } },
      ],
      [
        { id: "save-button", text: "Enregistrer" },
        { id: "cancel-button", text: "Annuler" },
        { id: "help-button", text: "Aide" },
      ],
    );
    const facts = await readFacts(currentConfig);

    const plan = createUpdatePlan(facts, store.baseline, currentConfig);
    const added = plan.items.find(
      ({ sourceKey }) => sourceKey === "help-button",
    );

    assert.equal(added?.change, "added");
    assert.equal(added?.recommendation.action, "retain");
    assert.equal(added?.executable, true);
    assert.equal(added?.previous, undefined);
    assert.deepStrictEqual(plan.sourceScopeEvidence, [
      {
        range: "source/messages.json",
        enumeration: "complete",
        sourceKeys: ["save-button", "cancel-button"],
      },
    ]);
  });

  void it("blocks a changed item when its previous source range was partial", async () => {
    const initialConfig = makeConfig(
      [{ id: "save-button", source: "Save", context: { line: 18 } }],
      [{ id: "save-button", text: "Enregistrer" }],
      { sourceEnumeration: "partial" },
    );
    const store = await establishBaseline(initialConfig, ["save-button"]);
    const currentConfig = makeConfig(
      [{ id: "save-button", source: "Save now", context: { line: 18 } }],
      [{ id: "save-button", text: "Enregistrer" }],
    );
    const facts = await readFacts(currentConfig);

    const plan = createUpdatePlan(facts, store.baseline, currentConfig);
    const item = plan.items[0];

    assert.equal(item?.change, "changed");
    assert.equal(item?.recommendation.action, "retain");
    assert.equal(item?.executable, false);
    assert.ok(item?.blockedReason?.includes("历史依据不足"));
  });

  void it("does not make an association conflict executable", async () => {
    const initialConfig = makeConfig(
      [{ id: "save-button", source: "Save", context: { line: 18 } }],
      [{ id: "save-button", text: "Enregistrer" }],
    );
    const store = await establishBaseline(initialConfig, ["save-button"]);
    const conflictConfig = makeConfig(
      [{ id: "save-button", source: "Save", context: { line: 18 } }],
      [
        { id: "save-button", text: "Enregistrer" },
        { id: "save-button", text: "Sauvegarder" },
      ],
    );
    const facts = await readFacts(conflictConfig);

    const plan = createUpdatePlan(facts, store.baseline, conflictConfig);
    const item = plan.items[0];

    assert.equal(item?.change, "conflict");
    assert.equal(item?.recommendation.action, "review");
    assert.equal(item?.executable, false);
    assert.equal(item?.expectedInput?.association.translations.length, 2);
  });
});
