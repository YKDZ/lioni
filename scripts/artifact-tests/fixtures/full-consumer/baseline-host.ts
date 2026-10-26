import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  advanceProcessingBaseline,
  compareProcessingBaseline,
  defineConfig,
  readFacts,
  type ProcessingBaseline,
} from "@lioni/core";
import { createFileProcessingBaselineStore } from "@lioni/core/node";

import { isRecord, standardSchema } from "./schemas.ts";

type Unit = { readonly id: string; readonly source: string };
type Translation = { readonly id: string; readonly text: string };
type SourceScope = { readonly range: string; readonly units: readonly Unit[] };
type TargetScope = {
  readonly range: string;
  readonly translations: readonly Translation[];
};

const scenario = process.argv[2] ?? "";
const baselinePath = path.join(process.cwd(), "processing-baseline.json");
const store = createFileProcessingBaselineStore(baselinePath);
const sourceByScenario: Readonly<Record<string, readonly SourceScope[]>> = {
  establish: [
    {
      range: "source-r1",
      units: [
        { id: "A", source: "Save" },
        { id: "B", source: "Cancel" },
      ],
    },
  ],
  modified: [
    {
      range: "source-r1",
      units: [
        { id: "A", source: "Save" },
        { id: "B", source: "Cancel" },
        { id: "C", source: "Help" },
      ],
    },
  ],
  "source-change": [
    {
      range: "source-r1",
      units: [
        { id: "A", source: "Save now" },
        { id: "B", source: "Cancel" },
      ],
    },
  ],
  "other-range": [
    { range: "source-r2", units: [{ id: "B", source: "Cancel" }] },
  ],
  "identity-change": [
    {
      range: "source-r1",
      units: [
        { id: "A-new", source: "Save" },
        { id: "B", source: "Cancel" },
      ],
    },
  ],
  removed: [{ range: "source-r1", units: [] }],
  "all-gone": [{ range: "source-r1", units: [] }],
  "corrupt-history": [{ range: "source-r1", units: [] }],
  "reject-history": [{ range: "source-r1", units: [] }],
};
const targetsByScenario: Readonly<Record<string, readonly TargetScope[]>> = {
  establish: [
    {
      range: "target-r1",
      translations: [
        { id: "A", text: "Enregistrer" },
        { id: "B", text: "Annuler" },
      ],
    },
  ],
  modified: [
    {
      range: "target-r1",
      translations: [
        { id: "A", text: "Sauvegarder" },
        { id: "B", text: "Annuler" },
        { id: "C", text: "Aide" },
      ],
    },
  ],
  "source-change": [
    {
      range: "target-r1",
      translations: [
        { id: "A", text: "Enregistrer" },
        { id: "B", text: "Annuler" },
      ],
    },
  ],
  "other-range": [
    { range: "target-r2", translations: [{ id: "B", text: "Annuler" }] },
  ],
  "identity-change": [
    {
      range: "target-r1",
      translations: [
        { id: "A-new", text: "Enregistrer" },
        { id: "B", text: "Annuler" },
      ],
    },
  ],
  removed: [
    { range: "target-r1", translations: [{ id: "orphan", text: "Orphan" }] },
  ],
  "all-gone": [{ range: "target-r1", translations: [] }],
  "corrupt-history": [{ range: "target-r1", translations: [] }],
  "reject-history": [{ range: "target-r1", translations: [] }],
};
const sourceScopes = sourceByScenario[scenario];
const targetScopes = targetsByScenario[scenario];
assert.ok(sourceScopes);
assert.ok(targetScopes);
const sourceSchema = standardSchema<Unit>(
  (value): value is Unit =>
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.source === "string",
);
const translationSchema = standardSchema<Translation>(
  (value): value is Translation =>
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.text === "string",
);
const contentSchema = standardSchema<string>(
  (value): value is string => typeof value === "string",
);
let matchCalls = 0;
const config = defineConfig<
  Unit,
  typeof sourceSchema,
  typeof translationSchema,
  never,
  typeof contentSchema
>({
  source: {
    schema: sourceSchema,
    read: () => ({
      scopes: sourceScopes.map(({ range, units }) => ({
        range,
        enumeration: "complete",
        records: units.map((value) => ({
          value,
          bodyAvailability: "available",
        })),
      })),
    }),
  },
  keyOf: (unit) => unit.id,
  translations: {
    languages: ["fr"],
    identityOf: (translation) => ({
      namespace: "baseline",
      key: translation.id,
    }),
    schema: translationSchema,
    contentSchema,
    contentOf: (translation) => translation.text,
    read: (_language, units) => ({
      scopes: targetScopes.map(({ range, translations }) => ({
        range,
        covers: units.map(({ key }) => key),
        enumeration: "complete",
        records: translations.map((value) => ({
          value,
          bodyAvailability: "available",
        })),
      })),
    }),
    matches: (unit, translation) => {
      matchCalls += 1;
      return unit.id === translation.id;
    },
  },
});
const facts = await readFacts(config);

function requiredValue<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`缺少预期的 ${label}。`);
  return value;
}

function changeFor(
  changes: Awaited<ReturnType<typeof compareProcessingBaseline>>["changes"],
  sourceKey: string,
) {
  return requiredValue(
    changes.find((change) => change.sourceKey === sourceKey),
    `基线变化 ${sourceKey}`,
  );
}

if (scenario === "corrupt-history") {
  const baseline = JSON.parse(
    await readFile(baselinePath, "utf8"),
  ) as ProcessingBaseline<Unit, Translation, never>;
  const entry = baseline.entries.find(({ sourceKey }) => sourceKey === "A");
  assert.ok(entry);
  (entry.source.unit as { source: unknown }).source = 7;
  await writeFile(baselinePath, JSON.stringify(baseline, null, 2), "utf8");
} else if (scenario === "reject-history") {
  const before = await readFile(baselinePath, "utf8");
  const baseline = await store.load();
  await assert.rejects(
    () => compareProcessingBaseline(facts, baseline, config),
    { name: "StandardSchemaContractError" },
  );
  assert.equal(matchCalls, 0);
  assert.equal(await readFile(baselinePath, "utf8"), before);
} else if (scenario === "establish") {
  const result = await advanceProcessingBaseline(
    store,
    facts,
    [{ sourceKey: "A", language: "fr" }],
    config,
  );
  assert.equal(result.outcome, "saved");
  assert.ok(result.baseline);
  assert.deepEqual(
    result.baseline.entries.map(({ sourceKey, processed }) => [
      sourceKey,
      processed,
    ]),
    [
      ["A", true],
      ["B", false],
    ],
  );
} else {
  const before = await readFile(baselinePath, "utf8");
  const baseline = await store.load();
  const changes = (await compareProcessingBaseline(facts, baseline, config))
    .changes;
  const forA = changeFor(changes, "A");
  assert.equal(await readFile(baselinePath, "utf8"), before);
  if (scenario === "modified") {
    assert.equal(forA.status, "changed");
    assert.equal(changeFor(changes, "B").processed, false);
    assert.equal(changeFor(changes, "C").status, "added");
    const advanced = await advanceProcessingBaseline(
      store,
      facts,
      [{ sourceKey: "A", language: "fr" }],
      config,
    );
    assert.equal(advanced.outcome, "saved");
    assert.ok(advanced.baseline);
    const afterAdvance = (
      await compareProcessingBaseline(facts, advanced.baseline, config)
    ).changes;
    assert.equal(changeFor(afterAdvance, "C").status, "added");
    assert.equal(changeFor(afterAdvance, "B").processed, false);
  } else if (scenario === "other-range") {
    assert.equal(forA.status, "unknown");
  } else if (scenario === "source-change") {
    assert.equal(forA.status, "changed");
  } else if (scenario === "identity-change") {
    assert.equal(forA.status, "source-removed");
    assert.equal(changeFor(changes, "A-new").status, "added");
  } else if (scenario === "removed") {
    assert.equal(forA.status, "source-removed");
    assert.ok(
      facts.translations.records.some(
        ({ translation }) => translation.id === "orphan",
      ),
    );
    const advanced = await advanceProcessingBaseline(
      store,
      facts,
      [{ sourceKey: "A", language: "fr" }],
      config,
    );
    assert.equal(advanced.outcome, "saved");
    assert.ok(advanced.baseline);
    const removedEntry = requiredValue(
      advanced.baseline.entries.find(({ sourceKey }) => sourceKey === "A"),
      "已删除原文基线条目",
    );
    assert.equal(removedEntry.source.presence, "removed");
    assert.deepEqual(removedEntry.source.unit, { id: "A", source: "Save" });
  } else if (scenario === "all-gone") {
    assert.equal(forA.status, "unchanged");
    assert.ok(forA.previous);
    assert.equal(forA.previous.source.presence, "removed");
    assert.equal(forA.processed, true);
    assert.equal(facts.translations.records.length, 0);
  }
}
