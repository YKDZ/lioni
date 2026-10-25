import { createNumberChecker } from "@lioni/checks";
import {
  applySemanticEdits,
  advanceProcessingBaseline,
  analyzeQuality,
  applyUpdatePlan,
  compareProcessingBaseline,
  createUpdatePlan,
  evaluateCompletion,
  prepareSemanticEdit,
  prepareQualityConditionedSemanticEdit,
  readCompletion,
  readFacts,
  readSourceFacts,
  resolveSemanticEditInput,
} from "@lioni/core";
import {
  createFileProcessingBaselineStore,
  createFileUpdatePlanStore,
} from "@lioni/core/node";

import completionConfig from "./completion.config.ts";
import deletionConfig from "./deletion.config.ts";
import editConfig from "./edits.config.ts";
import config from "./lioni.config.ts";
import planConfig from "./plan.config.ts";
import qaConfig from "./qa.config.ts";

type NumberUnit = { readonly source: string };
type NumberTranslation = { readonly text: string };

void readSourceFacts(config);
void readFacts(config);
void readFacts(qaConfig);
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
void compareProcessingBaseline;
void advanceProcessingBaseline;
void readFacts(deletionConfig);
void createFileProcessingBaselineStore(".lioni/processing-baseline.json");
void readFacts(planConfig).then(async (facts) => {
  const baselineStore = createFileProcessingBaselineStore(
    ".lioni/plan-baseline.json",
  );
  const plan = await createUpdatePlan(
    facts,
    await baselineStore.load(),
    planConfig,
  );
  return applyUpdatePlan(plan, planConfig, baselineStore);
});
void createFileUpdatePlanStore(".lioni/update-plan.json");
void readFacts(editConfig).then(async (facts) => {
  const sourceUnit = facts.source.units[0];
  if (sourceUnit === undefined) return undefined;
  const candidate = {
    sourceKey: sourceUnit.key,
    language: "fr",
    content: "Edited translation",
  };
  const resolved = await resolveSemanticEditInput(
    facts,
    { sourceKey: candidate.sourceKey, language: candidate.language },
    editConfig,
  );
  if (resolved.status !== "resolved") return undefined;
  const prepared = await prepareSemanticEdit(
    resolved.input,
    candidate,
    editConfig,
  );
  if (prepared.status === "prepared")
    return applySemanticEdits([prepared.edit], editConfig);
  return undefined;
});
const editCandidate = {
  sourceKey: "source:18",
  language: "fr",
  content: "Candidate",
};
void analyzeQuality(editConfig, { candidates: [editCandidate] }).then(
  (quality) =>
    prepareQualityConditionedSemanticEdit(editConfig, {
      candidate: editCandidate,
      quality,
      condition: (result) => result.diagnostics.length === 0,
    }),
);
