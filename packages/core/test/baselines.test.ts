import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  advanceProcessingBaseline,
  compareProcessingBaseline,
  createUpdatePlan,
  defineConfig,
  readFacts,
  type ProcessingBaseline,
  type ProcessingBaselineStore,
} from "../src/index.ts";

type Unit = {
  readonly source: string;
  readonly id: string;
};

type Translation = {
  readonly text: string;
  readonly id: string;
};

function makeFacts(
  units: readonly Unit[],
  translations: readonly Translation[],
) {
  return makeScopedFacts(
    [{ range: "messages", units }],
    [
      {
        range: "catalogue.fr",
        covers: units.map(({ id }) => id),
        translations,
      },
    ],
  );
}

function makeScopedFacts(
  sourceScopes: readonly {
    readonly range: string;
    readonly units: readonly Unit[];
    readonly enumeration?: "complete" | "partial" | "failed";
  }[],
  translationScopes: readonly {
    readonly range: string;
    readonly covers: readonly string[];
    readonly translations: readonly Translation[];
    readonly enumeration?: "complete" | "partial" | "failed";
  }[],
  translationReadError?: string,
) {
  return readFacts(
    defineConfig({
      source: {
        read: () => ({
          scopes: sourceScopes.map(({ range, units, enumeration }) => ({
            range,
            enumeration: enumeration ?? ("complete" as const),
            records: units.map((value) => ({
              value,
              bodyAvailability: "available" as const,
            })),
          })),
        }),
      },
      keyOf: (unit) => unit.id,
      translations: {
        languages: ["fr"],
        read: () => {
          if (translationReadError !== undefined)
            throw new Error(translationReadError);
          return {
            scopes: translationScopes.map(
              ({
                range,
                covers,
                translations: scopeTranslations,
                enumeration,
              }) => ({
                range,
                covers,
                enumeration: enumeration ?? ("complete" as const),
                records: scopeTranslations.map((value) => ({
                  value,
                  bodyAvailability: "available" as const,
                })),
              }),
            ),
          };
        },
        matches: (unit, translation) => unit.id === translation.id,
      },
    }),
  );
}

class MemoryBaselineStore implements ProcessingBaselineStore {
  baseline: ProcessingBaseline | undefined;
  loads = 0;
  saves = 0;

  async load(): Promise<ProcessingBaseline | undefined> {
    this.loads += 1;
    return this.baseline;
  }

  async save(baseline: ProcessingBaseline): Promise<void> {
    this.saves += 1;
    this.baseline = baseline;
  }
}

void describe("processing baselines", () => {
  void it("reports missing history until explicitly established and preserves unselected history", async () => {
    const facts = await makeFacts(
      [
        { id: "A", source: "Save" },
        { id: "B", source: "Cancel" },
      ],
      [
        { id: "A", text: "Enregistrer" },
        { id: "B", text: "Annuler" },
      ],
    );

    assert.deepStrictEqual(
      compareProcessingBaseline(facts).changes.map(
        ({ sourceKey, language, status }) => [sourceKey, language, status],
      ),
      [
        ["A", "fr", "history-insufficient"],
        ["B", "fr", "history-insufficient"],
      ],
    );

    const store = new MemoryBaselineStore();
    const advanced = await advanceProcessingBaseline(store, facts, [
      { sourceKey: "A", language: "fr" },
    ]);

    assert.equal(advanced.outcome, "saved");
    assert.equal(store.saves, 1);
    assert.deepStrictEqual(
      store.baseline?.entries.map(({ sourceKey, processed }) => [
        sourceKey,
        processed,
      ]),
      [
        ["A", true],
        ["B", false],
      ],
    );
    assert.deepStrictEqual(
      compareProcessingBaseline(facts, store.baseline).changes.map(
        ({ sourceKey, status, processed }) => [sourceKey, status, processed],
      ),
      [
        ["A", "unchanged", true],
        ["B", "unchanged", false],
      ],
    );
  });

  void it("keeps confirmed source removal visible when the target read fails", async () => {
    const initialFacts = await makeScopedFacts(
      [{ range: "source-r1", units: [{ id: "A", source: "Save" }] }],
      [
        {
          range: "target-r1",
          covers: ["A"],
          translations: [{ id: "A", text: "Enregistrer" }],
        },
      ],
    );
    const store = new MemoryBaselineStore();
    await advanceProcessingBaseline(store, initialFacts, [
      { sourceKey: "A", language: "fr" },
    ]);

    const targetUnavailable = await makeScopedFacts(
      [{ range: "source-r1", units: [] }],
      [],
      "target resource unavailable",
    );
    const comparison = compareProcessingBaseline(
      targetUnavailable,
      store.baseline,
      { matches: (unit, translation) => unit.id === translation.id },
    );
    const removal = comparison.changes.find(
      ({ sourceKey }) => sourceKey === "A",
    );
    assert.equal(removal?.status, "source-removed");
    assert.equal(removal?.current?.association.status, "unknown");
    assert.equal(removal?.current?.association.coverageStatus, "failed");

    const baselineBefore = store.baseline;
    const advanceAttempt = await advanceProcessingBaseline(
      store,
      targetUnavailable,
      [{ sourceKey: "A", language: "fr" }],
      { matches: (unit, translation) => unit.id === translation.id },
    );
    assert.equal(advanceAttempt.outcome, "unchanged");
    assert.equal(advanceAttempt.selections[0]?.outcome, "unknown");
    assert.strictEqual(store.baseline, baselineBefore);

    const plan = createUpdatePlan(targetUnavailable, store.baseline, {
      translations: {
        languages: ["fr"],
        read: () => ({ scopes: [] }),
        matches: (unit, translation) => unit.id === translation.id,
      },
    });
    const planItem = plan.items.find(({ sourceKey }) => sourceKey === "A");
    assert.equal(planItem?.change, "source-removed");
    assert.equal(planItem?.expectedInput?.association.status, "unknown");
    assert.equal(planItem?.expectedInput?.association.coverageStatus, "failed");
    assert.equal(planItem?.recommendation.action, "retain");
    assert.equal(planItem?.executable, false);
  });

  void it("keeps an unselected item old and distinguishes it from a later addition", async () => {
    const initialFacts = await makeFacts(
      [
        { id: "A", source: "Save" },
        { id: "B", source: "Cancel" },
      ],
      [
        { id: "A", text: "Enregistrer" },
        { id: "B", text: "Annuler" },
      ],
    );
    const store = new MemoryBaselineStore();
    await advanceProcessingBaseline(store, initialFacts, [
      { sourceKey: "A", language: "fr" },
    ]);

    const changedFacts = await makeFacts(
      [
        { id: "A", source: "Save" },
        { id: "B", source: "Cancel" },
        { id: "C", source: "Help" },
      ],
      [
        { id: "A", text: "Sauvegarder" },
        { id: "B", text: "Annuler" },
        { id: "C", text: "Aide" },
      ],
    );

    assert.deepStrictEqual(
      compareProcessingBaseline(changedFacts, store.baseline).changes.map(
        ({ sourceKey, status, processed }) => [sourceKey, status, processed],
      ),
      [
        ["A", "changed", true],
        ["B", "unchanged", false],
        ["C", "added", false],
      ],
    );

    await advanceProcessingBaseline(store, changedFacts, [
      { sourceKey: "A", language: "fr" },
    ]);
    assert.deepStrictEqual(
      compareProcessingBaseline(changedFacts, store.baseline).changes.map(
        ({ sourceKey, status, processed }) => [sourceKey, status, processed],
      ),
      [
        ["A", "unchanged", true],
        ["B", "unchanged", false],
        ["C", "added", false],
      ],
    );
  });

  void it("recognizes removal after advancing a new key in an existing source range", async () => {
    const initialFacts = await makeFacts(
      [{ id: "A", source: "Save" }],
      [{ id: "A", text: "Enregistrer" }],
    );
    const store = new MemoryBaselineStore();
    await advanceProcessingBaseline(store, initialFacts, [
      { sourceKey: "A", language: "fr" },
    ]);

    const addedFacts = await makeFacts(
      [
        { id: "A", source: "Save" },
        { id: "B", source: "Cancel" },
      ],
      [
        { id: "A", text: "Enregistrer" },
        { id: "B", text: "Annuler" },
      ],
    );
    assert.equal(
      compareProcessingBaseline(addedFacts, store.baseline).changes.find(
        ({ sourceKey }) => sourceKey === "B",
      )?.status,
      "added",
    );
    await advanceProcessingBaseline(store, addedFacts, [
      { sourceKey: "B", language: "fr" },
    ]);

    const removedFacts = await makeFacts(
      [{ id: "A", source: "Save" }],
      [
        { id: "A", text: "Enregistrer" },
        { id: "B", text: "Annuler" },
      ],
    );
    assert.equal(
      compareProcessingBaseline(removedFacts, store.baseline, {
        matches: (unit, translation) => unit.id === translation.id,
      }).changes.find(({ sourceKey }) => sourceKey === "B")?.status,
      "source-removed",
    );
  });

  void it("does not call an unobserved old item new after a partial scope is later completed", async () => {
    const initialFacts = await makeScopedFacts(
      [
        {
          range: "messages",
          units: [{ id: "A", source: "Save" }],
          enumeration: "partial",
        },
      ],
      [
        {
          range: "catalogue.fr",
          covers: ["A"],
          translations: [{ id: "A", text: "Enregistrer" }],
        },
      ],
    );
    const store = new MemoryBaselineStore();
    await advanceProcessingBaseline(store, initialFacts, [
      { sourceKey: "A", language: "fr" },
    ]);

    const completeFacts = await makeFacts(
      [
        { id: "A", source: "Save" },
        { id: "B", source: "Cancel" },
      ],
      [
        { id: "A", text: "Enregistrer" },
        { id: "B", text: "Annuler" },
      ],
    );
    assert.equal(
      compareProcessingBaseline(completeFacts, store.baseline).changes.find(
        ({ sourceKey }) => sourceKey === "B",
      )?.status,
      "history-insufficient",
    );

    await advanceProcessingBaseline(store, completeFacts, [
      { sourceKey: "A", language: "fr" },
    ]);
    assert.equal(
      compareProcessingBaseline(completeFacts, store.baseline).changes.find(
        ({ sourceKey }) => sourceKey === "B",
      )?.status,
      "history-insufficient",
    );
  });

  void it("confirms source removal from source evidence and reports target uncertainty separately", async () => {
    const initialFacts = await makeScopedFacts(
      [{ range: "source-r1", units: [{ id: "A", source: "Save" }] }],
      [
        {
          range: "target-r1",
          covers: ["A"],
          translations: [{ id: "A", text: "Enregistrer" }],
        },
      ],
    );
    const store = new MemoryBaselineStore();
    await advanceProcessingBaseline(store, initialFacts, [
      { sourceKey: "A", language: "fr" },
    ]);

    const onlyOtherRanges = await makeScopedFacts(
      [{ range: "source-r2", units: [{ id: "B", source: "Cancel" }] }],
      [
        {
          range: "target-r2",
          covers: ["B"],
          translations: [{ id: "B", text: "Annuler" }],
        },
      ],
    );
    assert.equal(
      compareProcessingBaseline(onlyOtherRanges, store.baseline).changes.find(
        ({ sourceKey }) => sourceKey === "A",
      )?.status,
      "unknown",
    );

    const oldSourcePartial = await makeScopedFacts(
      [
        { range: "source-r1", units: [], enumeration: "partial" },
        { range: "source-r2", units: [{ id: "B", source: "Cancel" }] },
      ],
      [
        {
          range: "target-r1",
          covers: [],
          translations: [],
        },
        {
          range: "target-r2",
          covers: ["B"],
          translations: [{ id: "B", text: "Annuler" }],
        },
      ],
    );
    assert.equal(
      compareProcessingBaseline(oldSourcePartial, store.baseline).changes.find(
        ({ sourceKey }) => sourceKey === "A",
      )?.status,
      "unknown",
    );

    const oldTargetPartial = await makeScopedFacts(
      [
        { range: "source-r1", units: [] },
        { range: "source-r2", units: [{ id: "B", source: "Cancel" }] },
      ],
      [
        {
          range: "target-r1",
          covers: [],
          translations: [],
          enumeration: "partial",
        },
        {
          range: "target-r2",
          covers: ["B"],
          translations: [{ id: "B", text: "Annuler" }],
        },
      ],
    );
    const partialTargetRemoval = compareProcessingBaseline(
      oldTargetPartial,
      store.baseline,
      { matches: (unit, translation) => unit.id === translation.id },
    ).changes.find(({ sourceKey }) => sourceKey === "A");
    assert.equal(partialTargetRemoval?.status, "source-removed");
    assert.equal(partialTargetRemoval?.current?.association.status, "unknown");
    assert.equal(
      partialTargetRemoval?.current?.association.coverageStatus,
      "incomplete",
    );

    const partialTargetPlan = createUpdatePlan(
      oldTargetPartial,
      store.baseline,
      {
        translations: {
          languages: ["fr"],
          read: () => ({ scopes: [] }),
          matches: (unit, translation) => unit.id === translation.id,
        },
      },
    );
    const partialTargetItem = partialTargetPlan.items.find(
      ({ sourceKey }) => sourceKey === "A",
    );
    assert.equal(partialTargetItem?.change, "source-removed");
    assert.equal(partialTargetItem?.executable, false);

    const partialHistory = await makeScopedFacts(
      [
        {
          range: "source-r1",
          units: [{ id: "A", source: "Save" }],
          enumeration: "partial",
        },
      ],
      [
        {
          range: "target-r1",
          covers: ["A"],
          translations: [{ id: "A", text: "Enregistrer" }],
        },
      ],
    );
    const partialHistoryStore = new MemoryBaselineStore();
    await advanceProcessingBaseline(partialHistoryStore, partialHistory, [
      { sourceKey: "A", language: "fr" },
    ]);
    const completeCurrentSource = await makeScopedFacts(
      [{ range: "source-r1", units: [] }],
      [{ range: "target-r1", covers: [], translations: [] }],
    );
    assert.equal(
      compareProcessingBaseline(
        completeCurrentSource,
        partialHistoryStore.baseline,
      ).changes.find(({ sourceKey }) => sourceKey === "A")?.status,
      "unknown",
    );

    const oldRangesComplete = await makeScopedFacts(
      [
        { range: "source-r1", units: [] },
        { range: "source-r2", units: [{ id: "B", source: "Cancel" }] },
      ],
      [
        {
          range: "target-r1",
          covers: [],
          translations: [{ id: "orphan", text: "Orphan" }],
        },
        {
          range: "target-r2",
          covers: ["B"],
          translations: [{ id: "B", text: "Annuler" }],
        },
      ],
    );
    const removal = compareProcessingBaseline(
      oldRangesComplete,
      store.baseline,
    ).changes.find(({ sourceKey }) => sourceKey === "A");
    assert.equal(removal?.status, "source-removed");
    assert.equal(oldRangesComplete.translations.records.length, 2);
    assert.ok(
      oldRangesComplete.translations.records.some(
        ({ translation }) => translation.id === "orphan",
      ),
    );
  });

  void it("advances a reliably removed item while retaining facts needed for later comparisons", async () => {
    const initialFacts = await makeScopedFacts(
      [{ range: "source-r1", units: [{ id: "A", source: "Save" }] }],
      [
        {
          range: "target-r1",
          covers: ["A"],
          translations: [{ id: "A", text: "Enregistrer" }],
        },
      ],
    );
    const store = new MemoryBaselineStore();
    await advanceProcessingBaseline(store, initialFacts, [
      { sourceKey: "A", language: "fr" },
    ]);

    const removedFacts = await makeScopedFacts(
      [{ range: "source-r1", units: [] }],
      [{ range: "target-r1", covers: [], translations: [] }],
    );
    const advanced = await advanceProcessingBaseline(
      store,
      removedFacts,
      [{ sourceKey: "A", language: "fr" }],
      { matches: (unit, translation) => unit.id === translation.id },
    );
    assert.equal(advanced.outcome, "saved");
    assert.equal(advanced.selections[0]?.outcome, "advanced");
    assert.equal(advanced.baseline?.entries[0]?.source.presence, "removed");
    assert.deepStrictEqual(advanced.baseline?.entries[0]?.source.unit, {
      id: "A",
      source: "Save",
    });

    const targetReturned = await makeScopedFacts(
      [{ range: "source-r1", units: [] }],
      [
        {
          range: "target-r1",
          covers: [],
          translations: [{ id: "A", text: "Sauvegarder" }],
        },
      ],
    );
    assert.equal(
      compareProcessingBaseline(targetReturned, advanced.baseline, {
        matches: (unit, translation) => unit.id === translation.id,
      }).changes.find(({ sourceKey }) => sourceKey === "A")?.status,
      "changed",
    );
  });

  void it("does not advance a conflicting relationship or replace history after a save failure", async () => {
    const initialFacts = await makeFacts(
      [{ id: "A", source: "Save" }],
      [{ id: "A", text: "Enregistrer" }],
    );
    const store = new MemoryBaselineStore();
    await advanceProcessingBaseline(store, initialFacts, [
      { sourceKey: "A", language: "fr" },
    ]);
    const previous = store.baseline;

    const conflictFacts = await makeFacts(
      [{ id: "A", source: "Save" }],
      [
        { id: "A", text: "Enregistrer A" },
        { id: "A", text: "Enregistrer B" },
      ],
    );
    const conflict = await advanceProcessingBaseline(store, conflictFacts, [
      { sourceKey: "A", language: "fr" },
    ]);
    assert.equal(conflict.outcome, "unchanged");
    assert.equal(conflict.selections[0]?.outcome, "conflict");
    assert.strictEqual(store.baseline, previous);

    const failingStore: ProcessingBaselineStore = {
      load: async () => previous,
      save: async () => {
        throw new Error("disk is read-only");
      },
    };
    const changedFacts = await makeFacts(
      [{ id: "A", source: "Save" }],
      [{ id: "A", text: "Sauvegarder" }],
    );
    const failed = await advanceProcessingBaseline(failingStore, changedFacts, [
      { sourceKey: "A", language: "fr" },
    ]);
    assert.equal(failed.outcome, "failed");
    assert.equal(failed.failure?.phase, "save");
    assert.equal(failed.failure?.message, "disk is read-only");
    assert.strictEqual(failed.baseline, previous);
  });
});
