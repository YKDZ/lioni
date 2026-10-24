import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  advanceProcessingBaseline,
  applyUpdatePlan,
  createUpdatePlan,
  defineConfig,
  readFacts,
  type FrameworkConfig,
  type ProcessingBaseline,
  type ProcessingBaselineStore,
  type UpdatePolicy,
} from "../src/index.ts";
import { createFileUpdatePlanStore } from "../src/node.ts";

type Unit = { readonly id: string; readonly source: string };
type Translation = { readonly id: string; text: string };

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

function makeConfig(
  units: readonly Unit[],
  translations: readonly Translation[],
  options: {
    readonly updatePolicy?: UpdatePolicy<Unit, Translation>;
    readonly failWriteFor?: string;
    readonly ignoreWriteFor?: string;
    readonly withWriteback?: boolean;
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
    ...(options.withWriteback
      ? {
          translationWriteback: {
            targetContent: (translation) => translation.text,
            locateExistingTarget: ({ translation }) => ({
              status: "located" as const,
              locator: { id: translation.translation.id },
            }),
            locateNewTarget: ({ sourceUnit }) => ({
              status: "located" as const,
              locator: { id: sourceUnit.key },
            }),
            write({ edit, currentTranslation }) {
              if (
                currentTranslation === undefined ||
                typeof edit.content !== "string"
              )
                throw new TypeError("需要现有译文和字符串候选。");
              if (edit.sourceKey === options.failWriteFor)
                throw new Error("目标资源不可写。");
              if (edit.sourceKey === options.ignoreWriteFor) return;
              currentTranslation.translation.text = edit.content;
            },
          },
        }
      : {}),
  });
}

function candidatePolicy(
  contentFor: (sourceKey: string, unit: Unit | undefined) => string,
): UpdatePolicy<Unit, Translation> {
  return ({ sourceKey, language, sourceUnit }) => ({
    action: "candidate",
    candidate: {
      sourceKey,
      language,
      content: contentFor(sourceKey, sourceUnit),
    },
  });
}

async function establishBaseline(
  config: FrameworkConfig<Unit, Translation>,
  sourceKeys: readonly string[],
): Promise<MemoryBaselineStore> {
  const store = new MemoryBaselineStore();
  const facts = await readFacts(config);
  const matches = config.translations?.matches;
  assert.ok(matches);
  const result = await advanceProcessingBaseline(
    store,
    facts,
    sourceKeys.map((sourceKey) => ({ sourceKey, language: "fr" })),
    { matches },
  );
  assert.equal(result.outcome, "saved");
  return store;
}

void describe("apply update plans", () => {
  void it("applies a saved candidate without new choices or another policy call", async () => {
    const original = makeConfig(
      [{ id: "A", source: "Save" }],
      [{ id: "A", text: "Enregistrer" }],
    );
    const baselineStore = await establishBaseline(original, ["A"]);
    const translation = { id: "A", text: "Enregistrer" };
    let policyCalls = 0;
    const config = makeConfig(
      [{ id: "A", source: "Save now" }],
      [translation],
      {
        withWriteback: true,
        updatePolicy: (input) => {
          policyCalls += 1;
          return {
            action: "candidate",
            candidate: {
              sourceKey: input.sourceKey,
              language: input.language,
              content: "Sauvegarder",
            },
          };
        },
      },
    );
    const plan = await createUpdatePlan(
      await readFacts(config),
      baselineStore.baseline,
      config,
    );
    assert.equal(plan.items[0]?.status, "candidate");
    assert.equal(plan.items[0]?.edit?.content, "Sauvegarder");

    const directory = await mkdtemp(path.join(os.tmpdir(), "l10n-saved-plan-"));
    const planStore = createFileUpdatePlanStore(
      path.join(directory, "update-plan.json"),
    );
    try {
      await planStore.save(plan);
      const savedPlan = await planStore.load();
      assert.deepStrictEqual(savedPlan, plan);
      const result = await applyUpdatePlan(
        savedPlan as NonNullable<typeof savedPlan>,
        config,
        baselineStore,
      );

      assert.equal(result.contentResults[0]?.status, "written");
      assert.equal(result.baselineResults[0]?.status, "advanced");
      assert.equal(policyCalls, 1);
      assert.equal(translation.text, "Sauvegarder");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  void it("advances a valid retain decision without changing translation content", async () => {
    const original = makeConfig(
      [{ id: "A", source: "Save" }],
      [{ id: "A", text: "Enregistrer" }],
    );
    const baselineStore = await establishBaseline(original, ["A"]);
    const translation = { id: "A", text: "Enregistrer" };
    const config = makeConfig([{ id: "A", source: "Save now" }], [translation]);
    const plan = await createUpdatePlan(
      await readFacts(config),
      baselineStore.baseline,
      config,
    );

    const result = await applyUpdatePlan(plan, config, baselineStore);
    const savedUnit = baselineStore.baseline?.entries[0]?.source.unit as
      | Unit
      | undefined;

    assert.equal(plan.items[0]?.status, "retain");
    assert.equal(result.contentResults[0]?.status, "retained");
    assert.equal(result.baselineResults[0]?.status, "advanced");
    assert.equal(translation.text, "Enregistrer");
    assert.equal(savedUnit?.source, "Save now");
  });

  void it("keeps a planned addition valid when another key in its range advances", async () => {
    const original = makeConfig(
      [{ id: "A", source: "Save" }],
      [{ id: "A", text: "Enregistrer" }],
    );
    const baselineStore = await establishBaseline(original, ["A"]);
    const translations = [
      { id: "A", text: "Enregistrer" },
      { id: "B", text: "Annuler" },
      { id: "C", text: "Ouvrir" },
    ];
    const units = [
      { id: "A", source: "Save" },
      { id: "B", source: "Cancel" },
      { id: "C", source: "Open" },
    ];
    const config = makeConfig(units, translations, {
      withWriteback: true,
      updatePolicy: ({ sourceKey, language }) =>
        sourceKey === "B"
          ? {
              action: "candidate",
              candidate: { sourceKey, language, content: "Annuler maintenant" },
            }
          : { action: "none" },
    });
    const plan = await createUpdatePlan(
      await readFacts(config),
      baselineStore.baseline,
      config,
    );

    const matches = config.translations?.matches;
    assert.ok(matches);
    const otherKeyAdvance = await advanceProcessingBaseline(
      baselineStore,
      await readFacts(config),
      [{ sourceKey: "C", language: "fr" }],
      { matches },
    );
    assert.equal(otherKeyAdvance.outcome, "saved");
    assert.equal(
      baselineStore.baseline?.entries.some(
        ({ sourceKey }) => sourceKey === "B",
      ),
      false,
    );

    const result = await applyUpdatePlan(plan, config, baselineStore);

    assert.equal(
      result.contentResults.find(({ sourceKey }) => sourceKey === "B")?.status,
      "written",
    );
    assert.equal(
      result.baselineResults.find(({ sourceKey }) => sourceKey === "B")?.status,
      "advanced",
    );
    assert.equal(translations[1]?.text, "Annuler maintenant");
  });

  void it("rejects a stale saved candidate and does not advance its baseline", async () => {
    const original = makeConfig(
      [{ id: "A", source: "Save" }],
      [{ id: "A", text: "Enregistrer" }],
    );
    const baselineStore = await establishBaseline(original, ["A"]);
    const translation = { id: "A", text: "Enregistrer" };
    const config = makeConfig(
      [{ id: "A", source: "Save now" }],
      [translation],
      {
        withWriteback: true,
        updatePolicy: candidatePolicy(() => "Sauvegarder"),
      },
    );
    const plan = await createUpdatePlan(
      await readFacts(config),
      baselineStore.baseline,
      config,
    );
    translation.text = "Sauver";
    const baselineBefore = structuredClone(baselineStore.baseline);

    const result = await applyUpdatePlan(plan, config, baselineStore);

    assert.equal(result.contentResults[0]?.status, "conflict");
    assert.equal(result.baselineResults[0]?.status, "notAttempted");
    assert.equal(translation.text, "Sauver");
    assert.deepStrictEqual(baselineStore.baseline, baselineBefore);
  });

  void it("advances only confirmed items after a partial write failure", async () => {
    const initial = makeConfig(
      [
        { id: "A", source: "Save" },
        { id: "B", source: "Cancel" },
      ],
      [
        { id: "A", text: "Enregistrer" },
        { id: "B", text: "Annuler" },
      ],
    );
    const baselineStore = await establishBaseline(initial, ["A", "B"]);
    const translations = [
      { id: "A", text: "Enregistrer" },
      { id: "B", text: "Annuler" },
    ];
    const config = makeConfig(
      [
        { id: "A", source: "Save now" },
        { id: "B", source: "Cancel now" },
      ],
      translations,
      {
        withWriteback: true,
        failWriteFor: "A",
        updatePolicy: candidatePolicy((sourceKey) => `Updated ${sourceKey}`),
      },
    );
    const plan = await createUpdatePlan(
      await readFacts(config),
      baselineStore.baseline,
      config,
    );

    const result = await applyUpdatePlan(plan, config, baselineStore);

    assert.equal(
      result.contentResults.find(({ sourceKey }) => sourceKey === "A")?.status,
      "writeFailed",
    );
    assert.equal(
      result.contentResults.find(({ sourceKey }) => sourceKey === "B")?.status,
      "written",
    );
    assert.equal(
      result.baselineResults.find(({ sourceKey }) => sourceKey === "A")?.status,
      "notAttempted",
    );
    assert.equal(
      result.baselineResults.find(({ sourceKey }) => sourceKey === "B")?.status,
      "advanced",
    );
    assert.equal(translations[0]?.text, "Enregistrer");
    assert.equal(translations[1]?.text, "Updated B");
  });

  void it("does not advance when the writer returns without changing the target", async () => {
    const original = makeConfig(
      [{ id: "A", source: "Save" }],
      [{ id: "A", text: "Enregistrer" }],
    );
    const baselineStore = await establishBaseline(original, ["A"]);
    const translation = { id: "A", text: "Enregistrer" };
    const config = makeConfig(
      [{ id: "A", source: "Save now" }],
      [translation],
      {
        withWriteback: true,
        ignoreWriteFor: "A",
        updatePolicy: candidatePolicy(() => "Sauvegarder"),
      },
    );
    const plan = await createUpdatePlan(
      await readFacts(config),
      baselineStore.baseline,
      config,
    );
    const baselineBefore = structuredClone(baselineStore.baseline);

    const result = await applyUpdatePlan(plan, config, baselineStore);

    assert.equal(result.contentResults[0]?.status, "writeUnconfirmed");
    assert.equal(result.baselineResults[0]?.status, "notAttempted");
    assert.equal(translation.text, "Enregistrer");
    assert.deepStrictEqual(baselineStore.baseline, baselineBefore);
  });

  void it("reports confirmed content when its baseline cannot be saved", async () => {
    const original = makeConfig(
      [{ id: "A", source: "Save" }],
      [{ id: "A", text: "Enregistrer" }],
    );
    const baselineStore = await establishBaseline(original, ["A"]);
    const translation = { id: "A", text: "Enregistrer" };
    const config = makeConfig(
      [{ id: "A", source: "Save now" }],
      [translation],
      {
        withWriteback: true,
        updatePolicy: candidatePolicy(() => "Sauvegarder"),
      },
    );
    const plan = await createUpdatePlan(
      await readFacts(config),
      baselineStore.baseline,
      config,
    );
    const baselineBefore = structuredClone(baselineStore.baseline);
    baselineStore.failSaves = true;

    const result = await applyUpdatePlan(plan, config, baselineStore);

    assert.equal(result.contentResults[0]?.status, "written");
    assert.equal(result.baselineResults[0]?.status, "failed");
    assert.equal(translation.text, "Sauvegarder");
    assert.deepStrictEqual(baselineStore.baseline, baselineBefore);
  });

  void it("does not advance review, not processed, or blocked plan items", async () => {
    const config = makeConfig(
      [
        { id: "review", source: "Review" },
        { id: "none", source: "Skip" },
        { id: "blocked", source: "Blocked" },
      ],
      [
        { id: "review", text: "Relire" },
        { id: "none", text: "Ignorer" },
        { id: "blocked", text: "Bloqué" },
      ],
      {
        updatePolicy: ({ sourceKey, language }) =>
          sourceKey === "review"
            ? { action: "review", reason: "À vérifier." }
            : sourceKey === "none"
              ? { action: "none" }
              : {
                  action: "candidate",
                  candidate: { sourceKey, language, content: "Candidat" },
                },
      },
    );
    const baselineStore = new MemoryBaselineStore();
    const plan = await createUpdatePlan(
      await readFacts(config),
      undefined,
      config,
    );

    const result = await applyUpdatePlan(plan, config, baselineStore);

    assert.deepStrictEqual(
      plan.items.map(({ status }) => status),
      ["review", "notProcessed", "blocked"],
    );
    assert.ok(
      result.contentResults.every(({ status }) => status === "notAttempted"),
    );
    assert.ok(
      result.baselineResults.every(({ status }) => status === "notAttempted"),
    );
    assert.equal(baselineStore.baseline, undefined);
  });
});
