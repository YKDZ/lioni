import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

type CommandResult = {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
};

function run(
  executable: string,
  args: readonly string[],
  cwd: string,
): CommandResult {
  const result = spawnSync(executable, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    shell: process.platform === "win32",
  });
  if (result.error !== undefined)
    throw new Error(`无法运行 ${executable} ${args.join(" ")}`, {
      cause: result.error,
    });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function runChecked(
  executable: string,
  args: readonly string[],
  cwd: string,
): CommandResult {
  const result = run(executable, args, cwd);
  if (result.status !== 0)
    throw new Error(
      `${executable} ${args.join(" ")} 失败（退出码 ${result.status}）\n${result.stdout}${result.stderr}`,
    );
  return result;
}

const compositionConfigSource = `import { readFileSync } from "node:fs";
import {
  defineConfig,
  defineQualityCheck,
  type CompletionResolution,
  type CompletionResolverInput,
  type FrameworkConfig,
  type FrameworkFacts,
  type JsonValue,
  type QualityCheckDefinition,
  type QualityCheckInput,
  type QualityCheckRequest,
  type QualityException,
  type UpdatePolicyInput,
  type UpdateDecision,
  type StandardSchemaV1,
} from "@lioni/core";
import {
  createNumberChecker,
} from "@lioni/checks";

type CatalogUnit = {
  readonly source: { readonly label: string };
  readonly context: {
    readonly domain: "catalog";
    readonly nativeKey: string;
    readonly file: string;
    readonly line: number;
    readonly screenshot: string;
  };
};
type GuideUnit = {
  readonly source: { readonly body: string };
  readonly context: {
    readonly domain: "guide";
    readonly nativeKey: string;
    readonly resource: string;
    readonly row: number;
  };
};
type Unit = CatalogUnit | GuideUnit;
type CatalogTranslation = {
  readonly domain: "catalog";
  readonly nativeKey: string;
  readonly text: string;
  readonly approved: boolean;
  readonly resourceKey: string;
};
type GuideTranslation = {
  readonly domain: "guide";
  readonly nativeKey: string;
  readonly content: { readonly message: string; readonly reviewed: boolean };
  readonly resourceKey: string;
};
type Translation = CatalogTranslation | GuideTranslation;
type Domain = "catalog" | "guide";
const qualityConfigurationSchema: StandardSchemaV1<JsonValue, JsonValue> = {
  "~standard": {
    version: 1,
    vendor: "independent-composition",
    validate(value) {
      return { value: value as JsonValue };
    },
  },
};
type TargetResource = {
  readonly enumeration: "complete" | "partial" | "failed";
  readonly records: readonly Translation[];
};
type EntryModule = {
  readonly domain: Domain;
  readonly sourceRange: string;
  readonly translationRange: string;
  readonly readUnits: () => readonly Unit[];
  readonly readTargets: (language: string) => TargetResource;
  readonly exception?: QualityException;
  readonly checkConfiguration: JsonValue;
  readonly resolveCompletion: (
    input: CompletionResolverInput<Unit, Translation>,
  ) => CompletionResolution;
  readonly updatePolicy: (
    input: UpdatePolicyInput<Unit, Translation>,
  ) => UpdateDecision;
};

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8")) as unknown;
}

function readCatalogUnits(): readonly CatalogUnit[] {
  const source = readJson("composition/catalog-source.json") as {
    readonly items: readonly {
      readonly nativeKey: string;
      readonly label: string;
      readonly file: string;
      readonly line: number;
      readonly screenshot: string;
    }[];
  };
  return source.items.map((item) => ({
    source: { label: item.label },
    context: {
      domain: "catalog",
      nativeKey: item.nativeKey,
      file: item.file,
      line: item.line,
      screenshot: item.screenshot,
    },
  }));
}

function readGuideUnits(): readonly GuideUnit[] {
  const source = readJson("composition/guide-source.json") as {
    readonly pages: readonly {
      readonly id: string;
      readonly body: string;
      readonly resource: string;
      readonly row: number;
    }[];
  };
  return source.pages.map((page) => ({
    source: { body: page.body },
    context: {
      domain: "guide",
      nativeKey: page.id,
      resource: page.resource,
      row: page.row,
    },
  }));
}

function readCatalogTargets(): TargetResource {
  const resource = readJson("composition/catalog-fr.json") as {
    readonly enumeration: TargetResource["enumeration"];
    readonly entries: readonly {
      readonly nativeKey: string;
      readonly text: string;
      readonly approved: boolean;
      readonly resourceKey: string;
    }[];
  };
  return {
    enumeration: resource.enumeration,
    records: resource.entries.map((entry) => ({
      domain: "catalog",
      nativeKey: entry.nativeKey,
      text: entry.text,
      approved: entry.approved,
      resourceKey: entry.resourceKey,
    })),
  };
}

function readGuideTargets(): TargetResource {
  const resource = readJson("composition/guide-fr.json") as {
    readonly enumeration: TargetResource["enumeration"];
    readonly messages: readonly {
      readonly id: string;
      readonly content: string;
      readonly reviewed: boolean;
      readonly resourceKey: string;
    }[];
  };
  return {
    enumeration: resource.enumeration,
    records: resource.messages.map((message) => ({
      domain: "guide",
      nativeKey: message.id,
      content: { message: message.content, reviewed: message.reviewed },
      resourceKey: message.resourceKey,
    })),
  };
}

const catalogException: QualityException = {
  id: "catalog-approved-numbers",
  ruleId: "catalog-numbers",
  scope: {
    object: { kind: "translation-unit", key: "catalog:save", language: "fr" },
  },
  reason: "目录中的数字差异由维护者单独确认。",
};

const catalogModule: EntryModule = {
  domain: "catalog",
  sourceRange: "composition/catalog-source.json",
  translationRange: "composition/catalog-fr.json",
  readUnits: readCatalogUnits,
  readTargets: () => readCatalogTargets(),
  exception: catalogException,
  checkConfiguration: { domain: "catalog" },
  resolveCompletion: ({ translations }) => {
    const target = translations[0]?.translation;
    return (
      target?.domain === "catalog" &&
      target.approved &&
      target.text.trim().length > 0
    );
  },
  updatePolicy: ({ processed }) =>
    processed
      ? { action: "none", reason: "目录范围已单独处理。" }
      : { action: "retain", reason: "保留目录中的现有译法。" },
};

const guideModule: EntryModule = {
  domain: "guide",
  sourceRange: "composition/guide-source.json",
  translationRange: "composition/guide-fr.json",
  readUnits: readGuideUnits,
  readTargets: () => readGuideTargets(),
  checkConfiguration: { domain: "guide" },
  resolveCompletion: ({ translations }) => {
    const target = translations[0]?.translation;
    return (
      target?.domain === "guide" &&
      target.content.reviewed &&
      target.content.message.trim().length > 0
    );
  },
  updatePolicy: ({ processed }) =>
    processed
      ? { action: "none", reason: "指南范围已单独处理。" }
      : { action: "review", reason: "指南内容需要维护者复核。" },
};

function unitText(unit: Unit): string {
  if (unit.context.domain === "catalog")
    return (unit as CatalogUnit).source.label;
  return (unit as GuideUnit).source.body;
}

function translationText(content: unknown): string | undefined {
  return typeof content === "string" ? content : undefined;
}

function createDomainChecker(
  module: EntryModule,
): QualityCheckDefinition<Unit, Translation> {
  const checker = createNumberChecker<Unit, Translation>({
    sourceText: unitText,
    translationText,
  });
  return defineQualityCheck<
    Unit,
    Translation,
    typeof qualityConfigurationSchema
  >({
    id: module.domain + "-numbers",
    configurationSchema: qualityConfigurationSchema,
    configuration: {
      options: module.checkConfiguration,
      numbers: checker.configuration,
    },
    check: (input: QualityCheckInput<Unit, Translation, JsonValue>) => {
      if (
        input.sourceUnit !== null &&
        input.sourceUnit.unit.context.domain !== module.domain
      )
        return {
          status: "not-applicable",
          diagnostics: [],
          issues: [],
          coverage: {
            selected: 0,
            evaluated: 0,
            notApplicable: 0,
            incomplete: 0,
            failed: 0,
          },
        };
      return checker.check({
        ...input,
        configuration: checker.configuration,
      });
    },
  });
}

function requestForDomain(
  facts: FrameworkFacts<Unit, Translation>,
  domain: Domain,
): QualityCheckRequest {
  const candidates = facts.associations.flatMap((association) => {
    if (
      !association.sourceKey.startsWith(domain + ":") ||
      association.status !== "matched"
    )
      return [];
    const record = facts.translations.records[
      association.translationIndexes[0] as number
    ];
    return record === undefined
      ? []
      : [
          {
            sourceKey: association.sourceKey,
            language: association.language,
            content: record.content,
          },
        ];
  });
  return {
    candidates,
    relationships: [],
    exceptions: domain === "catalog" ? [catalogException] : [],
    dependencies: { domain },
  };
}

function mergeQualityRequests(
  requests: readonly QualityCheckRequest[],
): QualityCheckRequest {
  return {
    candidates: requests.flatMap(({ candidates }) => candidates),
    relationships: requests.flatMap(({ relationships }) =>
      relationships ?? [],
    ),
    exceptions: requests.flatMap(({ exceptions }) => exceptions ?? []),
    dependencies: {
      inputs: requests.map(({ dependencies }) => dependencies),
    },
  };
}

function createInputConfig(
  modules: readonly EntryModule[],
): FrameworkConfig<Unit, Translation> {
  const qualityChecks = [
    ...modules.map(createDomainChecker),
  ];
  return defineConfig<Unit, Translation>({
    source: {
      read: () => ({
        scopes: modules.map((module) => ({
          range: module.sourceRange,
          enumeration: "complete" as const,
          records: module.readUnits().map((value) => ({
            value,
            bodyAvailability: "available" as const,
          })),
        })),
      }),
    },
    keyOf: (unit) => unit.context.domain + ":" + unit.context.nativeKey,
    translations: {
      languages: ["fr"],
      contentOf: (translation) =>
        translation.domain === "catalog"
          ? translation.text
          : translation.content.message,
      read: (language, sourceUnits) => ({
        scopes: modules.flatMap((module) => {
          const selected = sourceUnits.filter(
            ({ unit }) => unit.context.domain === module.domain,
          );
          if (selected.length === 0) return [];
          const targets = module.readTargets(language);
          return [
            {
              range: module.translationRange,
              covers: selected.map(({ key }) => key),
              enumeration: targets.enumeration,
              records: targets.records.map((value) => ({
                value,
                bodyAvailability: "available" as const,
              })),
            },
          ];
        }),
      }),
      matches: (unit, translation) =>
        unit.context.domain === translation.domain &&
        unit.context.nativeKey === translation.nativeKey,
    },
    completion: {
      criterion: "input-specific-content-and-status-v1",
      resolveCompletion(input) {
        const module = modules.find(
          ({ domain }) => domain === input.sourceUnit.unit.context.domain,
        );
        return module === undefined
          ? { status: "unknown", reason: "没有对应的局部判据。" }
          : module.resolveCompletion(input);
      },
    },
    qualityChecks,
    createQualityRequest: (facts) =>
      mergeQualityRequests(
        modules.map(({ domain }) => requestForDomain(facts, domain)),
      ),
    updatePolicy(input) {
      const module = modules.find(({ domain }) =>
        input.sourceKey.startsWith(domain + ":"),
      );
      return module === undefined
        ? { action: "review", reason: "没有对应的局部更新策略。" }
        : module.updatePolicy(input);
    },
  });
}

export const catalogConfig = createInputConfig([catalogModule]);
export const guideConfig = createInputConfig([guideModule]);
export default createInputConfig([catalogModule, guideModule]);
`;

const compositionHostSource = `import assert from "node:assert/strict";
import {
  advanceProcessingBaseline,
  createUpdatePlan,
  evaluateCompletion,
  readFacts,
  runQualityChecks,
} from "@lioni/core";
import {
  createFileProcessingBaselineStore,
  createFileUpdatePlanStore,
} from "@lioni/core/node";
import aggregateConfig, {
  catalogConfig,
  guideConfig,
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

function keyDomain(key) {
  return key.split(":", 1)[0];
}

function planItem(plan, key) {
  const item = plan.items.find((entry) => entry.sourceKey === key);
  assert.ok(item, "计划应包含所选范围");
  return item;
}

function baselineEntryProjection(entry) {
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

function planItemProjection(item) {
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
    ...(item.blocker === undefined
      ? {}
      : { blocker: item.blocker }),
    ...(item.edit === undefined ? {} : { edit: item.edit }),
  };
}

function completionObligationProjection(obligation) {
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

  const sourceProjection = (value) =>
    value.source.units.map(({ key, unit, bodyAvailability }) => ({
      key,
      unit,
      bodyAvailability,
    }));
  const targetProjection = (value, domain) =>
    value.translations.records
      .filter(({ translation }) => translation.domain === domain)
      .map(({ language, range, translation, bodyAvailability }) => ({
        language,
        range,
        translation,
        bodyAvailability,
      }));
  const associationProjection = (value, domain) =>
    value.associations
      .filter(({ sourceKey }) => keyDomain(sourceKey) === domain)
      .map(({ sourceKey, language, status, coverageStatus }) => ({
        sourceKey,
        language,
        status,
        coverageStatus,
      }));
  assert.deepEqual(sourceProjection(catalogFacts), sourceProjection({
    source: { units: facts.source.units.filter(({ unit }) => unit.context.domain === "catalog") },
  }));
  assert.deepEqual(sourceProjection(guideFacts), sourceProjection({
    source: { units: facts.source.units.filter(({ unit }) => unit.context.domain === "guide") },
  }));
  assert.deepEqual(targetProjection(catalogFacts, "catalog"), targetProjection(facts, "catalog"));
  assert.deepEqual(associationProjection(catalogFacts, "catalog"), associationProjection(facts, "catalog"));
  assert.deepEqual(targetProjection(guideFacts, "guide"), targetProjection(facts, "guide"));
  assert.deepEqual(associationProjection(guideFacts, "guide"), associationProjection(facts, "guide"));

  const aggregateRequest = await aggregateConfig.createQualityRequest(facts);
  assert.deepEqual(aggregateRequest.relationships, []);
  const aggregateChecks = aggregateConfig.qualityChecks ?? [];
  const aggregateQa = await runQualityChecks(facts, aggregateRequest, aggregateChecks);
  const catalogRequest = await catalogConfig.createQualityRequest(catalogFacts);
  const catalogQa = await runQualityChecks(
    catalogFacts,
    catalogRequest,
    catalogConfig.qualityChecks ?? [],
  );
  const guideRequest = await guideConfig.createQualityRequest(guideFacts);
  const guideQa = await runQualityChecks(
    guideFacts,
    guideRequest,
    guideConfig.qualityChecks ?? [],
  );
  const catalogCheck = aggregateQa.checks.find(({ id }) => id === "catalog-numbers");
  assert.ok(catalogCheck);
  const localCatalogCheck = catalogQa.checks.find(
    ({ id }) => id === "catalog-numbers",
  );
  assert.ok(localCatalogCheck);
  assert.deepEqual(
    localCatalogCheck,
    catalogCheck,
  );
  assert.deepEqual(
    catalogQa.diagnostics,
    aggregateQa.diagnostics.filter(({ ruleId }) => ruleId === "catalog-numbers"),
  );
  const guideCheck = aggregateQa.checks.find(({ id }) => id === "guide-numbers");
  const localGuideCheck = guideQa.checks.find(({ id }) => id === "guide-numbers");
  assert.ok(guideCheck);
  assert.ok(localGuideCheck);
  assert.deepEqual(localGuideCheck, guideCheck);
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
    aggregateQa.diagnostics.find(({ ruleId }) => ruleId === "catalog-numbers")?.handling.status,
    "excepted",
  );
  assert.equal(
    aggregateQa.diagnostics.find(({ ruleId }) => ruleId === "guide-numbers")?.handling.status,
    "active",
  );
  const selectedRequest = {
    ...aggregateRequest,
    candidates: catalogRequest.candidates,
  };
  const selectedQa = await runQualityChecks(facts, selectedRequest, aggregateChecks);
  const completion = await evaluateCompletion(facts, aggregateConfig.completion);
  assert.equal(selectedQa.candidates.length, 1);
  assert.equal(completion.scope.obligationCount, 2);
  const catalogCompletion = await evaluateCompletion(
    catalogFacts,
    catalogConfig.completion,
  );
  const guideCompletion = await evaluateCompletion(
    guideFacts,
    guideConfig.completion,
  );
  assert.deepEqual(
    completionObligationProjection(catalogCompletion.obligations[0]),
    completionObligationProjection(
      completion.obligations.find(({ sourceKey }) => sourceKey === "catalog:save"),
    ),
  );
  assert.deepEqual(
    completionObligationProjection(guideCompletion.obligations[0]),
    completionObligationProjection(
      completion.obligations.find(({ sourceKey }) => sourceKey === "guide:save"),
    ),
  );
  assert.equal(
    completion.obligations.find(({ sourceKey }) => sourceKey === "catalog:save")?.status,
    "complete",
  );
  assert.equal(
    completion.obligations.find(({ sourceKey }) => sourceKey === "guide:save")?.status,
    "incomplete",
  );

  const completionAfterQa = (qaResult) =>
    evaluateCompletion(facts, {
      criterion: "explicit-prior-qa-and-domain-policy-v1",
      resolveCompletion(input) {
        const domainResult = aggregateConfig.completion.resolveCompletion(input);
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
  assert.deepEqual(afterConfiguredQa.obligations, afterUnexceptedQa.obligations);

  const baselineResult = await advanceProcessingBaseline(
    baselineStore,
    facts,
    [{ sourceKey: "catalog:save", language: "fr" }],
    { matches: aggregateConfig.translations.matches },
  );
  assert.equal(baselineResult.outcome, "saved");
  const baseline = await baselineStore.load();
  assert.ok(baseline);
  const catalogBaseline = baseline.entries.find(({ sourceKey }) => sourceKey === "catalog:save");
  const guideBaseline = baseline.entries.find(({ sourceKey }) => sourceKey === "guide:save");
  assert.equal(catalogBaseline?.processed, true);
  assert.equal(guideBaseline?.processed, false);
  const baselineBeforeQa = structuredClone(baseline);
  await runQualityChecks(facts, aggregateRequest, aggregateChecks);
  await runQualityChecks(facts, { ...aggregateRequest, exceptions: [] }, aggregateChecks);
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
    { matches: catalogConfig.translations.matches },
  );
  assert.equal(localBaselineResult.outcome, "saved");
  const localBaseline = await localBaselineStore.load();
  assert.ok(localBaseline);
  assert.deepEqual(
    baselineEntryProjection(localBaseline.entries[0]),
    baselineEntryProjection(catalogBaseline),
  );
  const localPlan = await createUpdatePlan(
    catalogFacts,
    localBaseline,
    catalogConfig,
  );
  assert.deepEqual(
    planItemProjection(localPlan.items[0]),
    planItemProjection(catalogItem),
  );

  const guideComparison = await advanceProcessingBaseline(
    guideComparisonStore,
    facts,
    [{ sourceKey: "guide:save", language: "fr" }],
    { matches: aggregateConfig.translations.matches },
  );
  assert.equal(guideComparison.outcome, "saved");
  const guideAggregateBaseline = await guideComparisonStore.load();
  assert.ok(guideAggregateBaseline);
  const localGuideAdvance = await advanceProcessingBaseline(
    localGuideBaselineStore,
    guideFacts,
    [{ sourceKey: "guide:save", language: "fr" }],
    { matches: guideConfig.translations.matches },
  );
  assert.equal(localGuideAdvance.outcome, "saved");
  const localGuideBaseline = await localGuideBaselineStore.load();
  assert.ok(localGuideBaseline);
  const aggregateGuideBaselineEntry = guideAggregateBaseline.entries.find(
    ({ sourceKey }) => sourceKey === "guide:save",
  );
  assert.deepEqual(
    baselineEntryProjection(localGuideBaseline.entries[0]),
    baselineEntryProjection(aggregateGuideBaselineEntry),
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
    planItemProjection(localGuidePlan.items[0]),
    planItemProjection(planItem(aggregateGuidePlan, "guide:save")),
  );
  await planStore.save(plan);
  assert.deepEqual(await planStore.load(), plan);

  process.stdout.write(
    JSON.stringify({ status: "prepared", version: facts.version, candidateCount: aggregateQa.candidates.length }) + "\\n",
  );
}

async function observe() {
  const previousPlan = await planStore.load();
  assert.ok(previousPlan);
  const previousGuide = planItem(previousPlan, "guide:save");
  assert.equal(previousGuide.expectedInput?.association.translations[0]?.translation.content.message, "Aide");
  const facts = await readFacts(aggregateConfig);
  const baseline = await baselineStore.load();
  assert.ok(baseline);
  const currentPlan = await createUpdatePlan(facts, baseline, aggregateConfig);
  const currentGuide = planItem(currentPlan, "guide:save");
  assert.equal(currentGuide.change, "changed");
  assert.equal(currentGuide.processed, false);
  assert.equal(currentGuide.decision.action, "review");
  assert.equal(currentGuide.status, "review");
  assert.equal(currentGuide.expectedInput?.association.translations[0]?.translation.content.message, "Sauver");
  const currentCatalog = planItem(currentPlan, "catalog:save");
  assert.equal(currentCatalog.processed, true);
  await planStore.save(currentPlan);
  assert.deepEqual(await planStore.load(), currentPlan);
  process.stdout.write(
    JSON.stringify({ status: "observed", version: facts.version, guideChange: currentGuide.change }) + "\\n",
  );
}

if (mode === "prepare") await prepare();
else if (mode === "observe") await observe();
else throw new Error("请指定 prepare 或 observe。");
`;

export async function writeCompositionConsumerFiles(
  consumerRoot: string,
): Promise<void> {
  await mkdir(path.join(consumerRoot, "composition"), { recursive: true });
  await mkdir(path.join(consumerRoot, "composition-state"), {
    recursive: true,
  });
  await Promise.all([
    writeFile(
      path.join(consumerRoot, "composition.config.ts"),
      compositionConfigSource,
    ),
    writeFile(
      path.join(consumerRoot, "composition-host.mjs"),
      compositionHostSource,
    ),
    writeFile(
      path.join(consumerRoot, "composition", "catalog-source.json"),
      JSON.stringify({
        items: [
          {
            nativeKey: "save",
            label: "Save 12",
            file: "catalog/messages.ts",
            line: 12,
            screenshot: "catalog/shots/save.png",
          },
        ],
      }),
    ),
    writeFile(
      path.join(consumerRoot, "composition", "guide-source.json"),
      JSON.stringify({
        pages: [
          {
            id: "save",
            body: "Guide 34",
            resource: "guide/menu.md",
            row: 4,
          },
        ],
      }),
    ),
    writeFile(
      path.join(consumerRoot, "composition", "catalog-fr.json"),
      JSON.stringify({
        enumeration: "complete",
        entries: [
          {
            nativeKey: "save",
            text: "Sauver",
            approved: true,
            resourceKey: "catalog-save-label",
          },
        ],
      }),
    ),
    writeFile(
      path.join(consumerRoot, "composition", "guide-fr.json"),
      JSON.stringify({
        enumeration: "complete",
        messages: [
          {
            id: "save",
            content: "Aide",
            reviewed: false,
            resourceKey: "guide-save-message",
          },
        ],
      }),
    ),
  ]);
}

export async function verifyCompositionConsumer(
  consumerRoot: string,
): Promise<void> {
  const host = runChecked(
    process.execPath,
    ["composition-host.mjs", "prepare"],
    consumerRoot,
  );
  const prepared = JSON.parse(host.stdout) as {
    readonly status: string;
    readonly version: string;
    readonly candidateCount: number;
  };
  assert.equal(prepared.status, "prepared");
  assert.equal(prepared.candidateCount, 2);

  const executable = path.join(
    consumerRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "lioni.cmd" : "lioni",
  );
  const initialQa = runChecked(
    executable,
    ["qa", "composition.config.ts"],
    consumerRoot,
  );
  const initialResult = JSON.parse(initialQa.stdout).data as {
    readonly status: string;
    readonly version: string;
    readonly candidates: readonly unknown[];
    readonly diagnostics: readonly {
      readonly ruleId: string;
      readonly handling: { readonly status: string };
    }[];
  };
  assert.equal(initialResult.status, "complete");
  assert.equal(initialResult.version, prepared.version);
  assert.equal(initialResult.candidates.length, 2);
  assert.equal(
    initialResult.diagnostics.find(({ ruleId }) => ruleId === "catalog-numbers")
      ?.handling.status,
    "excepted",
  );
  assert.equal(
    initialResult.diagnostics.find(({ ruleId }) => ruleId === "guide-numbers")
      ?.handling.status,
    "active",
  );

  const guidePath = path.join(consumerRoot, "composition", "guide-fr.json");
  const guideResource = JSON.parse(await readFile(guidePath, "utf8")) as {
    enumeration: string;
    messages: Array<{ content: string }>;
  };
  const guideTarget = guideResource.messages[0];
  assert.ok(guideTarget);
  guideTarget.content = "Sauver";
  await writeFile(guidePath, JSON.stringify(guideResource), "utf8");

  const updatedQa = runChecked(
    executable,
    ["qa", "composition.config.ts"],
    consumerRoot,
  );
  const updatedResult = JSON.parse(updatedQa.stdout).data as {
    readonly status: string;
    readonly version: string;
    readonly diagnostics: readonly {
      readonly ruleId: string;
      readonly handling: { readonly status: string };
    }[];
  };
  assert.equal(updatedResult.status, "complete");
  assert.notEqual(updatedResult.version, initialResult.version);
  assert.equal(
    updatedResult.diagnostics.find(({ ruleId }) => ruleId === "guide-numbers")
      ?.handling.status,
    "active",
  );

  const observed = runChecked(
    process.execPath,
    ["composition-host.mjs", "observe"],
    consumerRoot,
  );
  const planObservation = JSON.parse(observed.stdout) as {
    readonly status: string;
    readonly version: string;
    readonly guideChange: string;
  };
  assert.equal(planObservation.status, "observed");
  assert.equal(planObservation.version, updatedResult.version);
  assert.equal(planObservation.guideChange, "changed");
  process.stdout.write(
    "独立打包宿主：异构输入组合、局部数字 QA/完成/更新策略和外部修改后的 CLI/保存计划观察通过。\n",
  );
}
