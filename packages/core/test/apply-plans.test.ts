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
  type JsonValue,
  type ProcessingBaseline,
  type ProcessingBaselineStore,
  type UpdatePolicy,
} from "../src/index.ts";
import { createFileUpdatePlanStore } from "../src/node.ts";
import { sourceSchemaFromExamples } from "./source-schema.ts";

type Unit = { readonly id: string; readonly source: string };
type Translation = { id: string; text: string; readonly slot?: string };
type MutableReadState = {
  sourceEnumeration?: "complete" | "partial" | "failed";
  translationEnumeration?: "complete" | "partial" | "failed";
  sourceRange?: string;
  translationRange?: string;
  location?: string;
  unlocatableTranslationId?: string;
  dependencies?: JsonValue;
};

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
    readonly detachWriteFor?: string;
    readonly partialReadAfterWriteFor?: string;
    readonly withWriteback?: boolean;
    readonly readState?: MutableReadState;
  } = {},
): FrameworkConfig<Unit, Translation> {
  return defineConfig({
    source: {
      schema: sourceSchemaFromExamples<Unit>(
        { id: "example", source: "example" },
        ...units,
      ),
      read: () => ({
        scopes: [
          {
            range: options.readState?.sourceRange ?? "source/messages.json",
            enumeration: options.readState?.sourceEnumeration ?? "complete",
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
            range: options.readState?.translationRange ?? "locales/fr.json",
            covers: sourceUnits.map(({ key }) => key),
            enumeration:
              options.readState?.translationEnumeration ?? "complete",
            records: translations.map((value) => ({
              value,
              bodyAvailability: "available" as const,
            })),
          },
        ],
      }),
      matches: (unit, translation) => unit.id === translation.id,
      contentOf: (translation) => translation.text,
    },
    ...(options.updatePolicy === undefined
      ? {}
      : { updatePolicy: options.updatePolicy }),
    ...(options.withWriteback
      ? {
          translationWriteback: {
            locateExistingTarget: ({ translation }) =>
              translation.translation.id ===
              options.readState?.unlocatableTranslationId
                ? {
                    status: "notWritable" as const,
                    reason: "该记录暂时无法解析宿主位置。",
                  }
                : {
                    status: "located" as const,
                    locator: {
                      id:
                        translation.translation.slot ??
                        translation.translation.id,
                      location:
                        options.readState?.location ?? "locales/fr.json",
                    },
                  },
            locateNewTarget: ({ sourceUnit }) => ({
              status: "located" as const,
              locator: { id: sourceUnit.key },
            }),
            dependencies: () => options.readState?.dependencies,
            write({ edit, currentTranslation }) {
              if (edit.operation === "delete") {
                if (currentTranslation === undefined)
                  throw new TypeError("需要现有译文删除目标。");
                if (edit.sourceKey === options.ignoreWriteFor) return;
                if (edit.sourceKey === options.detachWriteFor) {
                  currentTranslation.translation.id = "B";
                  return;
                }
                if (edit.sourceKey === options.failWriteFor)
                  throw new Error("目标资源不可写。");
                const index = translations.indexOf(
                  currentTranslation.translation,
                );
                if (index < 0) throw new Error("删除目标已不存在。");
                (translations as Translation[]).splice(index, 1);
                if (edit.sourceKey === options.partialReadAfterWriteFor) {
                  if (options.readState !== undefined)
                    options.readState.translationEnumeration = "partial";
                }
                return;
              }
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
  void it("deletes a removed source target and advances its confirmed result", async () => {
    const units: Unit[] = [{ id: "A", source: "Save" }];
    const translations: Translation[] = [
      { id: "A", text: "Enregistrer" },
      { id: "unrelated", text: "Annuler" },
    ];
    const initial = makeConfig(units, translations);
    const baselineStore = await establishBaseline(initial, ["A"]);
    units.splice(0, units.length);
    const config = makeConfig(units, translations, {
      withWriteback: true,
      updatePolicy: () => ({ action: "delete" }),
    });
    const plan = await createUpdatePlan(
      await readFacts(config),
      baselineStore.baseline,
      config,
    );
    assert.equal(plan.items[0]?.status, "delete");

    const directory = await mkdtemp(
      path.join(os.tmpdir(), "lioni-delete-plan-"),
    );
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
      assert.deepStrictEqual(translations, [
        { id: "unrelated", text: "Annuler" },
      ]);
      assert.equal(
        baselineStore.baseline?.entries[0]?.source.presence,
        "removed",
      );
      assert.equal(
        baselineStore.baseline?.entries[0]?.association.status,
        "missing",
      );
      assert.equal(baselineStore.baseline?.entries[0]?.processed, true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  void it("confirms the saved target range despite unrelated unreadable records elsewhere", async () => {
    type ScopedTranslation = Translation & {
      readonly scope: "main" | "other";
    };
    const units: Unit[] = [{ id: "A", source: "Save" }];
    const translations: ScopedTranslation[] = [
      { id: "A", text: "Enregistrer", scope: "main", slot: "one" },
      { id: "other", text: "Annuler", scope: "other", slot: "other" },
    ];
    const config = defineConfig<Unit, ScopedTranslation>({
      source: {
        schema: sourceSchemaFromExamples<Unit>(
          { id: "example", source: "example" },
          ...units,
        ),
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
        contentOf: (translation) => translation.text,
        read: (_language, sourceUnits) => ({
          scopes: (["main", "other"] as const).map((scope) => ({
            range: scope,
            covers: sourceUnits.map(({ key }) => key),
            enumeration: "complete" as const,
            records: translations
              .filter((translation) => translation.scope === scope)
              .map((value) => ({
                value,
                bodyAvailability: "available" as const,
              })),
          })),
        }),
        matches: (unit, translation) => unit.id === translation.id,
      },
      updatePolicy: () => ({ action: "delete" }),
      translationWriteback: {
        locateExistingTarget: ({ translation }) =>
          translation.translation.scope === "other"
            ? {
                status: "notWritable",
                reason: "另一个 scope 中的记录不可定位。",
              }
            : {
                status: "located",
                locator: { slot: translation.translation.slot ?? "one" },
              },
        locateNewTarget: () => ({
          status: "notWritable",
          reason: "删除不创建目标。",
        }),
        write: ({ currentTranslation }) => {
          if (currentTranslation === undefined)
            throw new TypeError("删除需要现存目标。");
          const index = translations.indexOf(currentTranslation.translation);
          if (index < 0) throw new Error("已保存的目标已不存在。");
          translations.splice(index, 1);
        },
      },
    });
    const baselineStore = new MemoryBaselineStore();
    const matches = config.translations?.matches;
    assert.ok(matches);
    const baselineResult = await advanceProcessingBaseline(
      baselineStore,
      await readFacts(config),
      [{ sourceKey: "A", language: "fr" }],
      { matches },
    );
    assert.equal(baselineResult.outcome, "saved");
    units.splice(0, units.length);
    const plan = await createUpdatePlan(
      await readFacts(config),
      baselineStore.baseline,
      config,
    );
    const edit = plan.items[0]?.edit;
    assert.ok(edit);
    if (edit.expected.target.status !== "present")
      throw new TypeError("删除计划应保存存在的物理目标。");
    assert.equal(edit.expected.target.range, "main");
    assert.deepStrictEqual(edit.expected.target.scopes, ["main", "other"]);

    const result = await applyUpdatePlan(plan, config, baselineStore);

    assert.equal(result.contentResults[0]?.status, "written");
    assert.equal(result.baselineResults[0]?.status, "advanced");
    assert.deepStrictEqual(
      translations.map(({ scope, slot }) => ({ scope, slot })),
      [{ scope: "other", slot: "other" }],
    );
  });

  void it("rejects stale deletion source, target, location, dependency, and read inputs", async () => {
    const scenarios: readonly [
      string,
      (input: {
        units: Unit[];
        translations: Translation[];
        readState: MutableReadState;
      }) => void,
    ][] = [
      [
        "source reappears",
        ({ units }) => units.push({ id: "A", source: "Save" }),
      ],
      [
        "target content changes",
        ({ translations }) => {
          const target = translations[0];
          if (target !== undefined) target.text = "External translation";
        },
      ],
      ["target disappears", ({ translations }) => translations.splice(0, 1)],
      [
        "target scope changes",
        ({ readState }) => {
          readState.translationRange = "locales/fr/renamed.json";
        },
      ],
      [
        "declared dependency changes",
        ({ readState }) => {
          readState.dependencies = { revision: 2 };
        },
      ],
      [
        "host target location changes",
        ({ readState }) => {
          readState.location = "locales/fr/renamed.json";
        },
      ],
      [
        "target coverage becomes partial",
        ({ readState }) => {
          readState.translationEnumeration = "partial";
        },
      ],
    ];

    for (const [scenario, mutate] of scenarios) {
      const units: Unit[] = [{ id: "A", source: "Save" }];
      const translations: Translation[] = [{ id: "A", text: "Enregistrer" }];
      const baselineStore = await establishBaseline(
        makeConfig(units, translations),
        ["A"],
      );
      units.splice(0, units.length);
      const readState: MutableReadState = {
        dependencies: { revision: 1 },
      };
      const config = makeConfig(units, translations, {
        readState,
        withWriteback: true,
        updatePolicy: () => ({ action: "delete" }),
      });
      const plan = await createUpdatePlan(
        await readFacts(config),
        baselineStore.baseline,
        config,
      );
      const baselineBefore = structuredClone(baselineStore.baseline);
      mutate({ units, translations, readState });

      const result = await applyUpdatePlan(plan, config, baselineStore);

      assert.equal(
        result.contentResults[0]?.status,
        "conflict",
        `${scenario} must reject the saved deletion`,
      );
      assert.equal(result.baselineResults[0]?.status, "notAttempted");
      assert.deepStrictEqual(baselineStore.baseline, baselineBefore);
    }
  });

  void it("does not treat a successful writer return as a confirmed deletion", async () => {
    const units: Unit[] = [{ id: "A", source: "Save" }];
    const translations: Translation[] = [{ id: "A", text: "Enregistrer" }];
    const baselineStore = await establishBaseline(
      makeConfig(units, translations),
      ["A"],
    );
    units.splice(0, units.length);
    const baselineBefore = structuredClone(baselineStore.baseline);
    const config = makeConfig(units, translations, {
      ignoreWriteFor: "A",
      withWriteback: true,
      updatePolicy: () => ({ action: "delete" }),
    });
    const plan = await createUpdatePlan(
      await readFacts(config),
      baselineStore.baseline,
      config,
    );

    const result = await applyUpdatePlan(plan, config, baselineStore);

    assert.equal(result.contentResults[0]?.status, "writeUnconfirmed");
    assert.equal(result.baselineResults[0]?.status, "notAttempted");
    assert.deepStrictEqual(translations, [{ id: "A", text: "Enregistrer" }]);
    assert.deepStrictEqual(baselineStore.baseline, baselineBefore);
  });

  void it("does not confirm deletion when the saved physical target remains", async () => {
    const units: Unit[] = [{ id: "A", source: "Save" }];
    const translations: Translation[] = [
      { id: "A", slot: "physical-one", text: "Enregistrer" },
    ];
    const baselineStore = await establishBaseline(
      makeConfig(units, translations),
      ["A"],
    );
    units.splice(0, units.length);
    const baselineBefore = structuredClone(baselineStore.baseline);
    const config = makeConfig(units, translations, {
      detachWriteFor: "A",
      withWriteback: true,
      updatePolicy: () => ({ action: "delete" }),
    });
    const plan = await createUpdatePlan(
      await readFacts(config),
      baselineStore.baseline,
      config,
    );

    const result = await applyUpdatePlan(plan, config, baselineStore);

    assert.equal(result.contentResults[0]?.status, "writeUnconfirmed");
    assert.equal(result.baselineResults[0]?.status, "notAttempted");
    assert.deepStrictEqual(translations, [
      { id: "B", slot: "physical-one", text: "Enregistrer" },
    ]);
    assert.deepStrictEqual(baselineStore.baseline, baselineBefore);
  });

  void it("does not confirm deletion when the saved scope cannot be resolved", async () => {
    const scenarios = ["locator", "partial-read"] as const;
    for (const scenario of scenarios) {
      const units: Unit[] = [{ id: "A", source: "Save" }];
      const translations: Translation[] = [
        { id: "A", text: "Enregistrer" },
        { id: "unrelated", text: "Annuler" },
      ];
      const baselineStore = await establishBaseline(
        makeConfig(units, translations),
        ["A"],
      );
      units.splice(0, units.length);
      const readState: MutableReadState = {
        dependencies: { revision: 1 },
      };
      const config = makeConfig(units, translations, {
        readState,
        ...(scenario === "partial-read"
          ? { partialReadAfterWriteFor: "A" }
          : {}),
        withWriteback: true,
        updatePolicy: () => ({ action: "delete" }),
      });
      const plan = await createUpdatePlan(
        await readFacts(config),
        baselineStore.baseline,
        config,
      );
      const baselineBefore = structuredClone(baselineStore.baseline);
      if (scenario === "locator")
        readState.unlocatableTranslationId = "unrelated";

      const result = await applyUpdatePlan(plan, config, baselineStore);

      assert.equal(
        result.contentResults[0]?.status,
        "writeUnconfirmed",
        `${scenario} must not confirm deletion`,
      );
      assert.equal(result.baselineResults[0]?.status, "notAttempted");
      assert.deepStrictEqual(baselineStore.baseline, baselineBefore);
      assert.deepStrictEqual(translations, [
        { id: "unrelated", text: "Annuler" },
      ]);
    }
  });

  void it("continues after one deletion write fails and advances only the confirmed target", async () => {
    const units: Unit[] = [
      { id: "A", source: "Save" },
      { id: "B", source: "Cancel" },
    ];
    const translations: Translation[] = [
      { id: "A", text: "Enregistrer" },
      { id: "B", text: "Annuler" },
    ];
    const baselineStore = await establishBaseline(
      makeConfig(units, translations),
      ["A", "B"],
    );
    units.splice(0, units.length);
    const config = makeConfig(units, translations, {
      failWriteFor: "A",
      withWriteback: true,
      updatePolicy: () => ({ action: "delete" }),
    });
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
    assert.deepStrictEqual(translations, [{ id: "A", text: "Enregistrer" }]);
    assert.equal(
      baselineStore.baseline?.entries.find(({ sourceKey }) => sourceKey === "A")
        ?.processed,
      true,
    );
    assert.equal(
      baselineStore.baseline?.entries.find(({ sourceKey }) => sourceKey === "B")
        ?.association.status,
      "missing",
    );
  });

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

    const directory = await mkdtemp(
      path.join(os.tmpdir(), "lioni-saved-plan-"),
    );
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
