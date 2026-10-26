import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  applyUpdatePlan,
  defaultCompare,
  defaultUpdatePolicy,
  defineConfig,
  previewUpdate,
  recordComparisonBaseline,
  update,
  type ComparisonBaseline,
  type ComparisonBaselineStore,
  type JsonValue,
  type TranslationWriteRequest,
} from "../src/index.ts";
import {
  jsonValueSchema,
  schemaFromExamples,
  sourceSchemaFromExamples,
} from "./source-schema.ts";

type Unit = { id: string; source: string };
type Translation = { id: string; text: JsonValue; sourceId?: string };

function createScenario(
  options: {
    readonly sources?: readonly Unit[];
    readonly translations?: readonly Translation[];
    readonly additionalTranslationExamples?: readonly Translation[];
    readonly withWriter?: boolean;
    readonly sourceToContent?: (source: string) => JsonValue;
  } = {},
) {
  const state = {
    sources: [...(options.sources ?? [])],
    translations: [...(options.translations ?? [])],
  };
  const counts = {
    sourceRead: 0,
    translationRead: 0,
    comparisons: 0,
    policies: 0,
    writes: 0,
    baselineLoads: 0,
    baselineSaves: 0,
  };
  const faults: { writeKey?: string } = {};
  let storedBaseline:
    | ComparisonBaseline<Unit, Translation, JsonValue, never>
    | undefined;
  const baselineStore: ComparisonBaselineStore<
    Unit,
    Translation,
    JsonValue,
    never
  > = {
    async load() {
      counts.baselineLoads += 1;
      return storedBaseline;
    },
    async save(baseline) {
      counts.baselineSaves += 1;
      storedBaseline = baseline;
    },
  };

  const sourceSchema = sourceSchemaFromExamples<Unit>({
    id: "example",
    source: "Example",
  });
  const translationSchema = schemaFromExamples<Translation>(
    { id: "example", text: "Example" },
    ...(options.additionalTranslationExamples ?? []),
  );
  const config = defineConfig<
    Unit,
    typeof sourceSchema,
    typeof translationSchema,
    never,
    typeof jsonValueSchema
  >({
    source: {
      schema: sourceSchema,
      read: () => {
        counts.sourceRead += 1;
        return {
          scopes: [
            {
              range: "source.json",
              enumeration: "complete",
              records: state.sources.map((value) => ({
                value,
                bodyAvailability: "available" as const,
              })),
            },
          ],
        };
      },
    },
    keyOf: ({ id }) => id,
    sourceToContent: options.sourceToContent ?? ((source) => source),
    compare: (input) => {
      counts.comparisons += 1;
      return defaultCompare(input);
    },
    updatePolicy: (input) => {
      counts.policies += 1;
      return defaultUpdatePolicy(input);
    },
    translations: {
      languages: ["fr"],
      identityOf: ({ id }) => ({ namespace: "messages", key: id }),
      schema: translationSchema,
      contentSchema: jsonValueSchema,
      contentOf: ({ text }) => text,
      matches: (unit, translation) => unit.id === translation.id,
      read: (_language, sourceUnits) => {
        counts.translationRead += 1;
        return {
          scopes: [
            {
              range: "fr.json",
              covers: sourceUnits.map(({ key }) => key),
              enumeration: "complete",
              records: state.translations.map((value) => ({
                value,
                bodyAvailability: "available" as const,
              })),
            },
          ],
        };
      },
    },
    ...(options.withWriter === false
      ? {}
      : {
          translationWriteback: {
            locateExistingTarget: ({ identity }) => ({
              status: "located" as const,
              locator: { range: "fr.json", key: identity.key },
            }),
            locateNewTarget: ({ sourceKey, language }) => ({
              status: "located" as const,
              locator: { range: `${language}.json`, key: sourceKey },
            }),
            write: ({
              request,
            }: {
              readonly request: TranslationWriteRequest<JsonValue, Unit>;
            }) => {
              counts.writes += 1;
              const key =
                "identity" in request.target
                  ? request.target.identity.key
                  : request.target.sourceKey;
              if (key === faults.writeKey)
                throw new Error("EISDIR: item-level I/O failure");
              if (request.operation === "delete") {
                state.translations = state.translations.filter(
                  (translation) => translation.id !== key,
                );
                return;
              }
              const existing = state.translations.find(
                (translation) => translation.id === key,
              );
              if (existing === undefined)
                state.translations.push({ id: key, text: request.content });
              else existing.text = request.content;
            },
          },
        }),
  });

  return {
    config,
    state,
    counts,
    faults,
    baselineStore,
    currentBaseline: () => storedBaseline,
  };
}

function sampleSource(id = "A"): Unit {
  return { id, source: `Source ${id}` };
}

function sampleTranslation(id = "A"): Translation {
  return { id, text: `Text ${id}`, sourceId: id };
}

void describe("apply update plan", () => {
  void it("保存并执行计划时保留合法 JSON 正文的自有原型保留键", async () => {
    const content = JSON.parse(
      '{"__proto__":"Hello","safe":"yes"}',
    ) as JsonValue;
    const scenario = createScenario({
      sources: [{ id: "A", source: JSON.stringify(content) }],
      additionalTranslationExamples: [{ id: "A", text: content }],
      sourceToContent: (source) => JSON.parse(source) as JsonValue,
    });

    const plan = await previewUpdate(scenario.config);
    const item = plan.items[0];
    assert.equal(item?.action, "write");
    if (item?.action !== "write") return;
    assert.deepEqual(item.after.content, content);
    assert.deepEqual(item.request.content, content);
    const restoredPlan = JSON.parse(JSON.stringify(plan)) as unknown;

    const result = await applyUpdatePlan(restoredPlan, scenario.config);

    assert.equal(result.status, "completed");
    assert.equal(result.results[0]?.status, "written");
    assert.deepEqual(scenario.state.translations, [{ id: "A", text: content }]);
  });

  void it("executes one direct plan without re-comparing, rerunning policy, or advancing baseline", async () => {
    const scenario = createScenario({ sources: [sampleSource()] });

    const result = await update(scenario.config, scenario.baselineStore);

    assert.equal(result.status, "completed");
    assert.equal(result.plan.items[0]?.action, "write");
    assert.equal(result.results[0]?.status, "written");
    assert.deepEqual(scenario.state.translations, [
      { id: "A", text: "Source A" },
    ]);
    assert.equal(scenario.counts.comparisons, 1);
    assert.equal(scenario.counts.policies, 1);
    assert.equal(scenario.counts.baselineLoads, 1);
    assert.equal(scenario.counts.baselineSaves, 0);
  });

  void it("rejects a restored delete plan when its expected source is present again", async () => {
    const source = sampleSource();
    const scenario = createScenario({
      sources: [source],
      translations: [sampleTranslation()],
    });
    await recordComparisonBaseline(scenario.config, scenario.baselineStore);
    scenario.state.sources = [];
    const plan = await previewUpdate(scenario.config, scenario.baselineStore);
    const deletion = plan.items.find(({ action }) => action === "delete");
    assert.ok(deletion);
    if (deletion === undefined || deletion.action !== "delete") return;
    assert.equal(deletion?.request?.expectedSource?.presence, "absent");
    assert.equal(deletion.request.expectedTarget.range, "fr.json");
    const restoredPlan = JSON.parse(JSON.stringify(plan)) as unknown;
    const compareCount = scenario.counts.comparisons;
    const policyCount = scenario.counts.policies;
    const baselineLoadCount = scenario.counts.baselineLoads;
    scenario.state.sources = [source];

    const result = await applyUpdatePlan(restoredPlan, scenario.config);

    assert.equal(result.status, "failed");
    assert.equal(result.results[0]?.status, "conflict");
    assert.deepEqual(scenario.state.translations, [sampleTranslation()]);
    assert.equal(scenario.counts.comparisons, compareCount);
    assert.equal(scenario.counts.policies, policyCount);
    assert.equal(scenario.counts.baselineLoads, baselineLoadCount);
  });

  void it("rejects a saved delete plan when its target record changes association", async () => {
    const scenario = createScenario({
      sources: [sampleSource()],
      translations: [sampleTranslation()],
    });
    await recordComparisonBaseline(scenario.config, scenario.baselineStore);
    scenario.state.sources = [];
    const plan = await previewUpdate(scenario.config, scenario.baselineStore);
    const deletion = plan.items.find(({ action }) => action === "delete");
    assert.ok(deletion);
    if (deletion === undefined || deletion.action !== "delete") return;
    assert.deepEqual(
      deletion.request.expectedTarget.record,
      sampleTranslation(),
    );
    const restoredPlan = JSON.parse(JSON.stringify(plan)) as unknown;
    scenario.state.translations[0]!.sourceId = "B";

    const result = await applyUpdatePlan(restoredPlan, scenario.config);

    assert.equal(result.status, "failed");
    assert.equal(result.results[0]?.status, "conflict");
    assert.deepEqual(scenario.state.translations, [
      { ...sampleTranslation(), sourceId: "B" },
    ]);
  });

  void it("keeps no-write decisions successful without requiring a writer or reading facts during apply", async () => {
    const scenario = createScenario({
      sources: [sampleSource()],
      translations: [sampleTranslation()],
      withWriter: false,
    });
    const plan = await previewUpdate(scenario.config);
    assert.equal(plan.items[0]?.action, "retain");
    const sourceReads = scenario.counts.sourceRead;
    const comparisonCount = scenario.counts.comparisons;
    const policyCount = scenario.counts.policies;

    const result = await applyUpdatePlan(
      JSON.parse(JSON.stringify(plan)),
      scenario.config,
    );

    assert.equal(result.status, "completed");
    assert.equal(result.results[0]?.status, "retained");
    assert.equal(scenario.counts.sourceRead, sourceReads);
    assert.equal(scenario.counts.comparisons, comparisonCount);
    assert.equal(scenario.counts.policies, policyCount);
  });

  void it("reports missing writers and continues after an item-level I/O failure", async () => {
    const missingWriter = createScenario({
      sources: [sampleSource()],
      withWriter: false,
    });
    const missingWriterPlan = await previewUpdate(missingWriter.config);
    const missingResult = await applyUpdatePlan(
      missingWriterPlan,
      missingWriter.config,
    );
    assert.equal(missingResult.status, "failed");
    assert.equal(missingResult.results[0]?.status, "notWritable");

    const partial = createScenario({
      sources: [sampleSource("A"), sampleSource("B")],
    });
    partial.faults.writeKey = "B";
    const partialResult = await update(partial.config, partial.baselineStore);

    assert.equal(partialResult.status, "failed");
    assert.deepEqual(
      partialResult.results.map(({ status }) => status),
      ["written", "writeFailed"],
    );
    assert.deepEqual(partial.state.translations, [
      { id: "A", text: "Source A" },
    ]);
  });
});
