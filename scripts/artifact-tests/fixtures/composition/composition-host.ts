import assert from "node:assert/strict";

import {
  advanceProcessingBaseline,
  createUpdatePlan,
  evaluateCompletion,
  readFacts,
  runQualityChecks,
  type CompletionObligationFact,
  type FrameworkFacts,
  type ProcessingBaselineEntry,
  type QualityObject,
  type QualityRunResult,
  type SourceUnitFact,
  type UpdatePlan,
  type UpdatePlanItem,
} from "@lioni/core";
import {
  createFileProcessingBaselineStore,
  createFileUpdatePlanStore,
} from "@lioni/core/node";

import aggregateConfig, {
  catalogConfig,
  guideConfig,
} from "./composition.config.ts";
import type {
  Domain,
  Translation,
  TranslationContent,
  Unit,
} from "./composition.config.ts";

const mode = process.argv[2];
const baselineStore = createFileProcessingBaselineStore(
  "composition-state/aggregate-baseline.json",
);
const localBaselineStore = createFileProcessingBaselineStore(
  "composition-state/catalog-baseline.json",
);
const localGuideBaselineStore = createFileProcessingBaselineStore(
  "composition-state/guide-baseline.json",
);
const guideComparisonStore = createFileProcessingBaselineStore(
  "composition-state/guide-aggregate-baseline.json",
);
const planStore = createFileUpdatePlanStore("composition-state/plan.json");

function keyDomain(key: string): string {
  return key.split(":", 1)[0] ?? "";
}

type CompositionPlan = UpdatePlan<Unit, Translation, TranslationContent>;
type CompositionPlanItem = UpdatePlanItem<
  Unit["source"],
  Translation,
  TranslationContent,
  never,
  Unit
>;

function requiredValue<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`缺少预期的 ${label}。`);
  return value;
}

function planItem(plan: CompositionPlan, key: string): CompositionPlanItem {
  const item = plan.items.find((entry) => entry.sourceKey === key);
  assert.ok(item, "计划应包含所选范围");
  return item;
}

function baselineEntryProjection(entry: ProcessingBaselineEntry) {
  return {
    sourceKey: entry.sourceKey,
    language: entry.language,
    processed: entry.processed,
    source: entry.source,
    association: {
      status: entry.association.status,
      coverageStatus: entry.association.coverageStatus,
      scopes: entry.association.scopes,
      translations: entry.association.translations,
    },
  };
}

function planItemProjection(item: CompositionPlanItem) {
  return {
    sourceKey: item.sourceKey,
    language: item.language,
    change: item.change,
    processed: item.processed,
    ...(item.previous === undefined
      ? {}
      : { previous: baselineEntryProjection(item.previous) }),
    ...(item.current === undefined
      ? {}
      : { current: baselineEntryProjection(item.current) }),
    ...(item.expectedInput === undefined
      ? {}
      : { expectedInput: item.expectedInput }),
    decision: item.decision,
    status: item.status,
    ...(item.blocker === undefined ? {} : { blocker: item.blocker }),
    ...(item.edit === undefined ? {} : { edit: item.edit }),
  };
}

function completionObligationProjection(
  obligation: CompletionObligationFact | undefined,
) {
  assert.ok(obligation);
  return {
    sourceKey: obligation.sourceKey,
    language: obligation.language,
    status: obligation.status,
    associationStatus: obligation.associationStatus,
    coverageStatus: obligation.coverageStatus,
    sourceBodyAvailability: obligation.sourceBodyAvailability,
    ...(obligation.reason === undefined ? {} : { reason: obligation.reason }),
  };
}

async function prepare() {
  const catalogFacts = await readFacts(catalogConfig);
  const guideFacts = await readFacts(guideConfig);
  const facts = await readFacts(aggregateConfig);
  assert.equal(catalogFacts.source.units[0]?.key, "catalog:save");
  assert.equal(guideFacts.source.units[0]?.key, "guide:save");
  assert.notEqual(
    catalogFacts.source.units[0]?.key,
    guideFacts.source.units[0]?.key,
  );

  const sourceProjection = (value: {
    readonly source: {
      readonly units: readonly SourceUnitFact<Unit>[];
    };
  }) =>
    value.source.units.map(({ key, unit, bodyAvailability }) => ({
      key,
      unit,
      bodyAvailability,
    }));
  const targetProjection = (
    value: FrameworkFacts<Unit, Translation, TranslationContent>,
    domain: Domain,
  ) =>
    value.translations.records
      .filter(({ translation }) => translation.domain === domain)
      .map(({ language, range, translation, bodyAvailability }) => ({
        language,
        range,
        translation,
        bodyAvailability,
      }));
  const associationProjection = (
    value: FrameworkFacts<Unit, Translation, TranslationContent>,
    domain: Domain,
  ) =>
    value.associations
      .filter(({ sourceKey }) => keyDomain(sourceKey) === domain)
      .map(({ sourceKey, language, status, coverageStatus }) => ({
        sourceKey,
        language,
        status,
        coverageStatus,
      }));
  assert.deepEqual(
    sourceProjection(catalogFacts),
    sourceProjection({
      source: {
        units: facts.source.units.filter(
          ({ unit }) => unit.context.domain === "catalog",
        ),
      },
    }),
  );
  assert.deepEqual(
    sourceProjection(guideFacts),
    sourceProjection({
      source: {
        units: facts.source.units.filter(
          ({ unit }) => unit.context.domain === "guide",
        ),
      },
    }),
  );
  assert.deepEqual(
    targetProjection(catalogFacts, "catalog"),
    targetProjection(facts, "catalog"),
  );
  assert.deepEqual(
    associationProjection(catalogFacts, "catalog"),
    associationProjection(facts, "catalog"),
  );
  assert.deepEqual(
    targetProjection(guideFacts, "guide"),
    targetProjection(facts, "guide"),
  );
  assert.deepEqual(
    associationProjection(guideFacts, "guide"),
    associationProjection(facts, "guide"),
  );

  const createAggregateRequest = aggregateConfig.createQualityRequest;
  const createCatalogRequest = catalogConfig.createQualityRequest;
  const createGuideRequest = guideConfig.createQualityRequest;
  assert.ok(createAggregateRequest);
  assert.ok(createCatalogRequest);
  assert.ok(createGuideRequest);
  const aggregateRequest = await createAggregateRequest(facts);
  assert.deepEqual(aggregateRequest.relationships, []);
  const aggregateChecks = aggregateConfig.qualityChecks ?? [];
  const aggregateQa = await runQualityChecks(
    facts,
    aggregateRequest,
    aggregateChecks,
  );
  const catalogRequest = await createCatalogRequest(catalogFacts);
  const catalogQa = await runQualityChecks(
    catalogFacts,
    catalogRequest,
    catalogConfig.qualityChecks ?? [],
  );
  const guideRequest = await createGuideRequest(guideFacts);
  const guideQa = await runQualityChecks(
    guideFacts,
    guideRequest,
    guideConfig.qualityChecks ?? [],
  );
  const catalogCheck = aggregateQa.checks.find(
    ({ id }) => id === "catalog-numbers",
  );
  assert.ok(catalogCheck);
  const localCatalogCheck = catalogQa.checks.find(
    ({ id }) => id === "catalog-numbers",
  );
  assert.ok(localCatalogCheck);
  assert.deepEqual(
    { ...localCatalogCheck, coverage: undefined },
    { ...catalogCheck, coverage: undefined },
  );
  assert.deepEqual(localCatalogCheck.coverage, {
    selected: 1,
    evaluated: 1,
    notApplicable: 0,
    incomplete: 0,
    failed: 0,
  });
  assert.deepEqual(catalogCheck.coverage, {
    selected: 2,
    evaluated: 1,
    notApplicable: 1,
    incomplete: 0,
    failed: 0,
  });
  assert.deepEqual(
    catalogQa.diagnostics,
    aggregateQa.diagnostics.filter(
      ({ ruleId }) => ruleId === "catalog-numbers",
    ),
  );
  const guideCheck = aggregateQa.checks.find(
    ({ id }) => id === "guide-numbers",
  );
  const localGuideCheck = guideQa.checks.find(
    ({ id }) => id === "guide-numbers",
  );
  assert.ok(guideCheck);
  assert.ok(localGuideCheck);
  assert.deepEqual(
    { ...localGuideCheck, coverage: undefined },
    { ...guideCheck, coverage: undefined },
  );
  assert.deepEqual(localGuideCheck.coverage, {
    selected: 1,
    evaluated: 1,
    notApplicable: 0,
    incomplete: 0,
    failed: 0,
  });
  assert.deepEqual(guideCheck.coverage, {
    selected: 2,
    evaluated: 1,
    notApplicable: 1,
    incomplete: 0,
    failed: 0,
  });
  assert.deepEqual(
    guideQa.diagnostics,
    aggregateQa.diagnostics.filter(({ ruleId }) => ruleId === "guide-numbers"),
  );
  assert.equal(aggregateQa.status, "complete");
  assert.equal(catalogQa.status, "complete");
  assert.equal(guideQa.status, "complete");
  assert.equal(aggregateQa.candidates.length, 2);
  assert.deepEqual(
    aggregateQa.candidates.map(({ sourceKey }) => sourceKey),
    ["catalog:save", "guide:save"],
  );
  assert.equal(
    aggregateQa.diagnostics.find(({ ruleId }) => ruleId === "catalog-numbers")
      ?.handling.status,
    "excepted",
  );
  assert.equal(
    aggregateQa.diagnostics.find(({ ruleId }) => ruleId === "guide-numbers")
      ?.handling.status,
    "active",
  );
  const selectedRequest = {
    ...aggregateRequest,
    candidates: catalogRequest.candidates,
  };
  const selectedQa = await runQualityChecks(
    facts,
    selectedRequest,
    aggregateChecks,
  );
  const aggregateCompletionPolicy = aggregateConfig.completion;
  const catalogCompletionPolicy = catalogConfig.completion;
  const guideCompletionPolicy = guideConfig.completion;
  assert.ok(aggregateCompletionPolicy);
  assert.ok(catalogCompletionPolicy);
  assert.ok(guideCompletionPolicy);
  const completion = await evaluateCompletion(facts, aggregateCompletionPolicy);
  assert.equal(selectedQa.candidates.length, 1);
  assert.equal(completion.scope.obligationCount, 2);
  const catalogCompletion = await evaluateCompletion(
    catalogFacts,
    catalogCompletionPolicy,
  );
  const guideCompletion = await evaluateCompletion(
    guideFacts,
    guideCompletionPolicy,
  );
  assert.deepEqual(
    completionObligationProjection(catalogCompletion.obligations[0]),
    completionObligationProjection(
      completion.obligations.find(
        ({ sourceKey }) => sourceKey === "catalog:save",
      ),
    ),
  );
  assert.deepEqual(
    completionObligationProjection(guideCompletion.obligations[0]),
    completionObligationProjection(
      completion.obligations.find(
        ({ sourceKey }) => sourceKey === "guide:save",
      ),
    ),
  );
  assert.equal(
    completion.obligations.find(({ sourceKey }) => sourceKey === "catalog:save")
      ?.status,
    "complete",
  );
  assert.equal(
    completion.obligations.find(({ sourceKey }) => sourceKey === "guide:save")
      ?.status,
    "incomplete",
  );

  const completionAfterQa = (
    qaResult: QualityRunResult<QualityObject, TranslationContent>,
  ) =>
    evaluateCompletion(facts, {
      criterion: "explicit-prior-qa-and-domain-policy-v1",
      resolveCompletion(input) {
        const domainResult = aggregateCompletionPolicy.resolveCompletion(input);
        if (typeof domainResult !== "boolean") return domainResult;
        const hasError = qaResult.diagnostics.some(
          (diagnostic) =>
            diagnostic.object.key === input.obligation.sourceKey &&
            diagnostic.object.language === input.obligation.language &&
            diagnostic.severity === "error",
        );
        return domainResult && !hasError;
      },
    });
  const withoutExceptions = await runQualityChecks(
    facts,
    { ...aggregateRequest, exceptions: [] },
    aggregateChecks,
  );
  const afterConfiguredQa = await completionAfterQa(aggregateQa);
  const afterUnexceptedQa = await completionAfterQa(withoutExceptions);
  assert.deepEqual(
    afterConfiguredQa.obligations,
    afterUnexceptedQa.obligations,
  );

  const baselineResult = await advanceProcessingBaseline(
    baselineStore,
    facts,
    [{ sourceKey: "catalog:save", language: "fr" }],
    aggregateConfig,
  );
  assert.equal(baselineResult.outcome, "saved");
  const baseline = await baselineStore.load();
  assert.ok(baseline);
  const catalogBaseline = baseline.entries.find(
    ({ sourceKey }) => sourceKey === "catalog:save",
  );
  const guideBaseline = baseline.entries.find(
    ({ sourceKey }) => sourceKey === "guide:save",
  );
  assert.equal(catalogBaseline?.processed, true);
  assert.equal(guideBaseline?.processed, false);
  const baselineBeforeQa = structuredClone(baseline);
  await runQualityChecks(facts, aggregateRequest, aggregateChecks);
  await runQualityChecks(
    facts,
    { ...aggregateRequest, exceptions: [] },
    aggregateChecks,
  );
  assert.deepEqual(await baselineStore.load(), baselineBeforeQa);

  const plan = await createUpdatePlan(facts, baseline, aggregateConfig);
  const catalogItem = planItem(plan, "catalog:save");
  const guideItem = planItem(plan, "guide:save");
  assert.equal(catalogItem.processed, true);
  assert.equal(catalogItem.decision.action, "none");
  assert.equal(catalogItem.status, "notProcessed");
  assert.equal(guideItem.processed, false);
  assert.equal(guideItem.decision.action, "review");
  assert.equal(guideItem.status, "review");

  const localBaselineResult = await advanceProcessingBaseline(
    localBaselineStore,
    catalogFacts,
    [{ sourceKey: "catalog:save", language: "fr" }],
    catalogConfig,
  );
  assert.equal(localBaselineResult.outcome, "saved");
  const localBaseline = await localBaselineStore.load();
  assert.ok(localBaseline);
  const localCatalogEntry = requiredValue(
    localBaseline.entries[0],
    "本地目录基线条目",
  );
  const aggregateCatalogEntry = requiredValue(
    catalogBaseline,
    "聚合目录基线条目",
  );
  assert.deepEqual(
    baselineEntryProjection(localCatalogEntry),
    baselineEntryProjection(aggregateCatalogEntry),
  );
  const localPlan = await createUpdatePlan(
    catalogFacts,
    localBaseline,
    catalogConfig,
  );
  assert.deepEqual(
    planItemProjection(requiredValue(localPlan.items[0], "本地目录计划条目")),
    planItemProjection(catalogItem),
  );

  const guideComparison = await advanceProcessingBaseline(
    guideComparisonStore,
    facts,
    [{ sourceKey: "guide:save", language: "fr" }],
    aggregateConfig,
  );
  assert.equal(guideComparison.outcome, "saved");
  const guideAggregateBaseline = await guideComparisonStore.load();
  assert.ok(guideAggregateBaseline);
  const localGuideAdvance = await advanceProcessingBaseline(
    localGuideBaselineStore,
    guideFacts,
    [{ sourceKey: "guide:save", language: "fr" }],
    guideConfig,
  );
  assert.equal(localGuideAdvance.outcome, "saved");
  const localGuideBaseline = await localGuideBaselineStore.load();
  assert.ok(localGuideBaseline);
  const aggregateGuideBaselineEntry = guideAggregateBaseline.entries.find(
    ({ sourceKey }) => sourceKey === "guide:save",
  );
  const localGuideEntry = requiredValue(
    localGuideBaseline.entries[0],
    "本地指南基线条目",
  );
  const aggregateGuideEntry = requiredValue(
    aggregateGuideBaselineEntry,
    "聚合指南基线条目",
  );
  assert.deepEqual(
    baselineEntryProjection(localGuideEntry),
    baselineEntryProjection(aggregateGuideEntry),
  );
  const aggregateGuidePlan = await createUpdatePlan(
    facts,
    guideAggregateBaseline,
    aggregateConfig,
  );
  const localGuidePlan = await createUpdatePlan(
    guideFacts,
    localGuideBaseline,
    guideConfig,
  );
  assert.deepEqual(
    planItemProjection(
      requiredValue(localGuidePlan.items[0], "本地指南计划条目"),
    ),
    planItemProjection(planItem(aggregateGuidePlan, "guide:save")),
  );
  await planStore.save(plan);
  assert.deepEqual(await planStore.load(), plan);

  process.stdout.write(
    JSON.stringify({
      status: "prepared",
      version: facts.version,
      candidateCount: aggregateQa.candidates.length,
    }) + "\n",
  );
}

async function observe() {
  const previousPlan = await planStore.load();
  assert.ok(previousPlan);
  const previousGuide = planItem(
    previousPlan as unknown as CompositionPlan,
    "guide:save",
  );
  const previousGuideTranslation =
    previousGuide.expectedInput?.association.translations[0];
  assert.ok(previousGuideTranslation);
  assert.equal(previousGuideTranslation.bodyAvailability, "available");
  assert.ok("content" in previousGuideTranslation.translation);
  assert.equal(previousGuideTranslation.translation.content.message, "Aide");
  const facts = await readFacts(aggregateConfig);
  const baseline = await baselineStore.load();
  assert.ok(baseline);
  const currentPlan = await createUpdatePlan(facts, baseline, aggregateConfig);
  const currentGuide = planItem(currentPlan, "guide:save");
  assert.equal(currentGuide.change, "changed");
  assert.equal(currentGuide.processed, false);
  assert.equal(currentGuide.decision.action, "review");
  assert.equal(currentGuide.status, "review");
  const currentGuideTranslation =
    currentGuide.expectedInput?.association.translations[0];
  assert.ok(currentGuideTranslation);
  assert.equal(currentGuideTranslation.bodyAvailability, "available");
  assert.ok("content" in currentGuideTranslation.translation);
  assert.equal(currentGuideTranslation.translation.content.message, "Sauver");
  const currentCatalog = planItem(currentPlan, "catalog:save");
  assert.equal(currentCatalog.processed, true);
  await planStore.save(currentPlan);
  assert.deepEqual(await planStore.load(), currentPlan);
  process.stdout.write(
    JSON.stringify({
      status: "observed",
      version: facts.version,
      guideChange: currentGuide.change,
    }) + "\n",
  );
}

if (mode === "prepare") await prepare();
else if (mode === "observe") await observe();
else throw new Error("请指定 prepare 或 observe。");
