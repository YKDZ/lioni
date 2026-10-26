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
  StandardSchemaContractError,
  type FrameworkConfig,
  type ProcessingBaseline,
  type ProcessingBaselineStore,
  type StandardSchemaV1,
  type UpdatePolicy,
} from "../src/index.ts";
import { createFileUpdatePlanStore } from "../src/node.ts";
import {
  jsonValueSchema,
  schemaFromExamples,
  sourceSchemaFromExamples,
  fixtureTranslationIdentity,
} from "./source-schema.ts";

type Unit = {
  readonly id: string;
  readonly source: string;
  readonly context: { readonly line: number; readonly screenshot?: string };
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
    readonly updatePolicy?: UpdatePolicy<Unit, Translation>;
    readonly withWriteback?: boolean;
    readonly onMatch?: () => void;
    readonly onLocateExisting?: () => void;
  } = {},
) {
  return defineConfig<
    Unit,
    StandardSchemaV1<Unit, Unit>,
    StandardSchemaV1<Translation, Translation>,
    never,
    typeof jsonValueSchema
  >({
    source: {
      schema: sourceSchemaFromExamples<Unit>(
        { id: "example", source: "example", context: { line: 0 } },
        ...units,
      ),
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
    keyOf: (unit) => unit.id,
    translations: {
      languages: ["fr"],
      identityOf: fixtureTranslationIdentity,
      schema: schemaFromExamples<Translation>({
        id: "example",
        text: "example",
      }),
      contentSchema: jsonValueSchema,
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
      matches: (unit, translation) => {
        options.onMatch?.();
        return unit.id === translation.id;
      },
      contentOf: (translation) => translation.text,
    },
    ...(options.updatePolicy === undefined
      ? {}
      : { updatePolicy: options.updatePolicy }),
    ...(options.withWriteback
      ? {
          translationWriteback: {
            locateExistingTarget: ({ translation }) => {
              options.onLocateExisting?.();
              return {
                status: "located" as const,
                locator: { id: translation.translation.id },
              };
            },
            locateNewTarget: ({ sourceUnit }) => ({
              status: "located" as const,
              locator: { id: sourceUnit.key },
            }),
          },
        }
      : {}),
  });
}

class MemoryBaselineStore implements ProcessingBaselineStore {
  baseline: ProcessingBaseline | undefined;

  async load(): Promise<ProcessingBaseline | undefined> {
    return structuredClone(this.baseline);
  }

  async save(baseline: ProcessingBaseline): Promise<void> {
    this.baseline = structuredClone(baseline);
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
    config,
  );
  assert.equal(result.outcome, "saved");
  return store;
}

function candidatePolicy(
  sourceKey = "save-button",
  language = "fr",
  content: string | Record<string, string> = "Sauvegarder",
): UpdatePolicy<Unit, Translation> {
  return () => ({
    action: "candidate",
    candidate: { sourceKey, language, content },
  });
}

void describe("update plans", () => {
  void it("validates removed history before policy and deletion-location callbacks", async () => {
    const initial = makeConfig(
      [
        {
          id: "save-button",
          source: "Save",
          context: { line: 18 },
        },
      ],
      [{ id: "save-button", text: "Enregistrer" }],
    );
    const baselineStore = await establishBaseline(initial, ["save-button"]);
    const saved = baselineStore.baseline;
    assert.ok(saved);
    let matchCalls = 0;
    let policyCalls = 0;
    let locateCalls = 0;
    const config = makeConfig(
      [],
      [{ id: "save-button", text: "Enregistrer" }],
      {
        withWriteback: true,
        onMatch: () => {
          matchCalls += 1;
        },
        onLocateExisting: () => {
          locateCalls += 1;
        },
        updatePolicy: () => {
          policyCalls += 1;
          return { action: "delete" };
        },
      },
    );
    const facts = await readFacts(config);
    const invalidSource: ProcessingBaseline = {
      ...saved,
      entries: saved.entries.map((entry) =>
        entry.sourceKey === "save-button"
          ? {
              ...entry,
              source: {
                ...entry.source,
                unit: {
                  id: "save-button",
                  source: 7,
                  context: { line: 18 },
                },
              },
            }
          : entry,
      ),
    };
    const invalidTranslation: ProcessingBaseline = {
      ...saved,
      entries: saved.entries.map((entry) =>
        entry.sourceKey === "save-button"
          ? {
              ...entry,
              association: {
                ...entry.association,
                translations: entry.association.translations.map(
                  (translation) =>
                    translation.bodyAvailability === "available"
                      ? {
                          ...translation,
                          translation: { id: "save-button", text: 7 },
                        }
                      : translation,
                ),
              },
            }
          : entry,
      ),
    };

    for (const invalidBaseline of [invalidSource, invalidTranslation]) {
      await assert.rejects(
        () => createUpdatePlan(facts, invalidBaseline, config),
        StandardSchemaContractError,
      );
    }
    assert.equal(matchCalls, 0);
    assert.equal(policyCalls, 0);
    assert.equal(locateCalls, 0);
  });

  void it("keeps insufficient history as a review decision with structured status", async () => {
    const config = makeConfig(
      [{ id: "save-button", source: "Save", context: { line: 18 } }],
      [{ id: "save-button", text: "Enregistrer" }],
    );
    const facts = await readFacts(config);
    const factsBefore = structuredClone(facts);

    const plan = await createUpdatePlan(facts, undefined, config);

    assert.deepStrictEqual(facts, factsBefore);
    assert.equal(plan.items.length, 1);
    assert.equal(plan.items[0]?.change, "history-insufficient");
    assert.equal(plan.items[0]?.decision.action, "review");
    assert.equal(plan.items[0]?.status, "review");
    assert.equal(plan.items[0]?.blocker, undefined);
    assert.equal(plan.items[0]?.expectedInput?.source.value, "Save");
  });

  void it("prepares and persists the exact candidate selected by policy", async () => {
    const initial = makeConfig(
      [{ id: "save-button", source: "Save", context: { line: 18 } }],
      [{ id: "save-button", text: "Enregistrer" }],
    );
    const baseline = await establishBaseline(initial, ["save-button"]);
    const config = makeConfig(
      [{ id: "save-button", source: "Save now", context: { line: 18 } }],
      [{ id: "save-button", text: "Enregistrer" }],
      {
        withWriteback: true,
        updatePolicy: candidatePolicy("save-button", "fr", {
          text: "Sauvegarder",
          status: "draft",
        }),
      },
    );

    const plan = await createUpdatePlan(
      await readFacts(config),
      baseline.baseline,
      config,
    );
    const item = plan.items[0];
    assert.equal(item?.change, "changed");
    assert.equal(item?.decision.action, "candidate");
    assert.equal(item?.status, "candidate");
    assert.deepStrictEqual(item?.edit?.content, {
      text: "Sauvegarder",
      status: "draft",
    });
    assert.equal(item?.edit?.expected.target.status, "present");

    const directory = await mkdtemp(path.join(os.tmpdir(), "lioni-plan-"));
    const store = createFileUpdatePlanStore(
      path.join(directory, "update-plan.json"),
    );
    try {
      await store.save(plan);
      assert.deepStrictEqual(await store.load(), plan);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  void it("does not interpret optional policy text as an execution state", async () => {
    const initial = makeConfig(
      [{ id: "save-button", source: "Save", context: { line: 18 } }],
      [{ id: "save-button", text: "Enregistrer" }],
    );
    const baseline = await establishBaseline(initial, ["save-button"]);
    const config = makeConfig(
      [{ id: "save-button", source: "Save now", context: { line: 18 } }],
      [{ id: "save-button", text: "Enregistrer" }],
      {
        updatePolicy: () => ({
          action: "retain",
          reason: "请复核，这段说明不改变结构化决定。",
        }),
      },
    );

    const plan = await createUpdatePlan(
      await readFacts(config),
      baseline.baseline,
      config,
    );

    assert.equal(plan.items[0]?.status, "retain");
    assert.equal(plan.items[0]?.decision.action, "retain");
    assert.equal(plan.items[0]?.blocker, undefined);
  });

  void it("blocks a candidate structurally when history is insufficient", async () => {
    const config = makeConfig(
      [{ id: "save-button", source: "Save", context: { line: 18 } }],
      [{ id: "save-button", text: "Enregistrer" }],
      {
        withWriteback: true,
        updatePolicy: candidatePolicy(),
      },
    );

    const plan = await createUpdatePlan(
      await readFacts(config),
      undefined,
      config,
    );

    assert.equal(plan.items[0]?.decision.action, "candidate");
    assert.equal(plan.items[0]?.status, "blocked");
    assert.equal(plan.items[0]?.blocker?.code, "historyInsufficient");
  });

  void it("prepares an explicit deletion edit for a removed source", async () => {
    const initial = makeConfig(
      [{ id: "save-button", source: "Save", context: { line: 18 } }],
      [{ id: "save-button", text: "Enregistrer" }],
    );
    const baseline = await establishBaseline(initial, ["save-button"]);
    const config = makeConfig(
      [],
      [{ id: "save-button", text: "Enregistrer" }],
      {
        withWriteback: true,
        updatePolicy: () => ({ action: "delete" }),
      },
    );

    const plan = await createUpdatePlan(
      await readFacts(config),
      baseline.baseline,
      config,
    );

    assert.equal(plan.items[0]?.decision.action, "delete");
    assert.equal(plan.items[0]?.change, "source-removed");
    assert.equal(plan.items[0]?.expectedInput?.source.presence, "removed");
    assert.equal(plan.items[0]?.status, "delete");
    assert.equal(plan.items[0]?.blocker, undefined);
    assert.equal(plan.items[0]?.edit?.operation, "delete");
    assert.equal("content" in (plan.items[0]?.edit ?? {}), false);
  });

  void it("retains a removed source translation under the default policy", async () => {
    const initial = makeConfig(
      [{ id: "save-button", source: "Save", context: { line: 18 } }],
      [{ id: "save-button", text: "Enregistrer" }],
    );
    const baseline = await establishBaseline(initial, ["save-button"]);
    const config = makeConfig([], [{ id: "save-button", text: "Enregistrer" }]);

    const plan = await createUpdatePlan(
      await readFacts(config),
      baseline.baseline,
      config,
    );

    assert.equal(plan.items[0]?.change, "source-removed");
    assert.equal(plan.items[0]?.decision.action, "retain");
    assert.equal(plan.items[0]?.status, "retain");
    assert.equal(plan.items[0]?.edit, undefined);
  });

  void it("keeps plan observations stable when resources mutate after preparation", async () => {
    const initial = makeConfig(
      [{ id: "save-button", source: "Save", context: { line: 18 } }],
      [{ id: "save-button", text: "Enregistrer" }],
    );
    const baseline = await establishBaseline(initial, ["save-button"]);
    const unit = {
      id: "save-button",
      source: "Save now",
      context: { line: 18, screenshot: "shots/at-plan.png" },
    };
    const translation = {
      id: "save-button",
      text: "Enregistrer",
      context: { resource: "locales/fr.json#save" },
    };
    const config = makeConfig([unit], [translation]);

    const plan = await createUpdatePlan(
      await readFacts(config),
      baseline.baseline,
      config,
    );
    unit.context.screenshot = "shots/after-plan.png";
    translation.context.resource = "locales/fr.json#renamed";
    translation.text = "Sauvegarder";
    const preparedUnit = plan.items[0]?.current?.source.unit as
      | Unit
      | undefined;

    assert.equal(preparedUnit?.context.screenshot, "shots/at-plan.png");
    assert.equal(
      plan.items[0]?.expectedInput?.association.translations[0]?.translation
        .text,
      "Enregistrer",
    );
  });
});
