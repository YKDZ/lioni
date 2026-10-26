import { createNumberChecker } from "@lioni/checks";
import {
  analyzeQuality,
  applyUpdatePlan,
  createUpdatePlan,
  defaultUpdatePolicy,
  evaluateCompletion,
  previewUpdate,
  readCompletion,
  readFacts,
  readSourceFacts,
  update,
  validateUpdatePlan,
  writeTranslationRequests,
  type JsonValue,
  type TranslationWriteRequest,
  type TranslationUnitInput,
  type UpdatePlan,
  type UpdatePolicy,
} from "@lioni/core";
import {
  createFileComparisonBaselineStore,
  createFileUpdatePlanStore,
} from "@lioni/core/node";

import completionConfig from "./completion.config.ts";
import deletionConfig from "./deletion.config.ts";
import editConfig from "./edits.config.ts";
import config from "./lioni.config.ts";
import planConfig, {
  type Translation as PlanTranslation,
  type Unit as PlanUnit,
} from "./plan.config.ts";
import qaConfig from "./qa.config.ts";

type NumberUnit = { readonly source: string };
type NumberTranslation = { readonly text: string };

void readSourceFacts(config);
void readFacts(config);
void readFacts(qaConfig);
void readFacts(deletionConfig);
void readFacts(planConfig);
void qaConfig.qualityChecks;
void qaConfig.createQualityRequest;
void createNumberChecker<
  NumberUnit,
  NumberTranslation,
  NumberUnit,
  string,
  string,
  never
>({
  select: ({ sourceUnit, candidate }) => {
    if (sourceUnit === null || sourceUnit.bodyAvailability !== "available")
      return {
        status: "incomplete",
        issue: { code: "sourceUnavailable", message: "原文不可用。" },
      };
    if (typeof candidate.content !== "string")
      return {
        status: "incomplete",
        issue: { code: "textUnavailable", message: "候选不是文本。" },
      };
    return {
      status: "selected",
      subject: {
        sourceUnit,
        sourceKey: candidate.sourceKey,
        language: candidate.language,
        content: candidate.content,
      },
    };
  },
  sourceText: (unit) => unit.source,
  translationText: (content) => content,
});

void readCompletion(completionConfig);
void readFacts(completionConfig).then((facts) =>
  evaluateCompletion(facts, completionConfig.completion!),
);
void readFacts(editConfig).then((facts) =>
  analyzeQuality(editConfig, {
    candidates: facts.source.units.map(({ key }) => ({
      sourceKey: key,
      language: "fr",
      content: "External proposal",
    })),
  }),
);
void createUpdatePlan;
void defaultUpdatePolicy;
void createFileComparisonBaselineStore;
void createFileUpdatePlanStore;

const baselineStore = createFileComparisonBaselineStore<
  PlanUnit,
  PlanTranslation,
  string
>("comparison-baseline.json");
void previewUpdate(planConfig, baselineStore).then(async (plan) => {
  const stored: UpdatePlan = JSON.parse(JSON.stringify(plan)) as UpdatePlan;
  validateUpdatePlan(stored);
  await applyUpdatePlan(stored, planConfig);
});
void update(planConfig, baselineStore);
void writeTranslationRequests([], editConfig);

declare const request: TranslationWriteRequest<JsonValue, TranslationUnitInput>;
declare const policy: UpdatePolicy<TranslationUnitInput, unknown, JsonValue>;
declare const unknownPlan: unknown;
validateUpdatePlan(unknownPlan);
void policy;
void request;

type StringPlan = UpdatePlan<TranslationUnitInput, unknown, string>;
const planType: StringPlan | undefined = undefined;
void planType;
