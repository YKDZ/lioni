import { createTermChecker } from "@lioni/checks";
import {
  compileTerms,
  createTermbase,
  requireAllowedTranslation,
  rejectForbiddenTranslation,
} from "@lioni/terminology";

import type { createKumaAnalysis } from "../analysis.ts";
import type { Unit, Translation, Pair, Body, Project } from "../model.ts";

export function createTerminologyChecks(
  project: Project,
  { analysis }: ReturnType<typeof createKumaAnalysis>,
) {
  const terms = compileTerms(createTermbase(project.terms), { analysis });
  const policies = new Map(
    project.policies.map((policy) => [policy.targetLanguage, policy]),
  );
  return [requireAllowedTranslation(), rejectForbiddenTranslation()].map(
    (rule) =>
      createTermChecker<Unit, Translation, Pair, Body>({
        terms,
        rule,
        select: (input) =>
          !policies.has(input.candidate.language) ||
          input.sourceUnit === null ||
          !input.candidate.content.text.trim()
            ? { status: "not-applicable" }
            : {
                status: "selected",
                subject: {
                  key: input.candidate.sourceKey,
                  source: input.sourceUnit.unit.source.text,
                  target: input.candidate.content.text,
                  language: input.candidate.language,
                },
              },
        project: (input) => {
          const policy = policies.get(input.subject.language)!;
          return {
            status: "ready",
            value: {
              groups: [
                {
                  ref: input.subject.key,
                  source: {
                    language: policy.sourceLanguage,
                    fragments: [
                      { ref: input.subject.key, text: input.subject.source },
                    ],
                  },
                  target: {
                    language: policy.targetLanguage,
                    fragments: [
                      { ref: input.subject.key, text: input.subject.target },
                    ],
                  },
                },
              ],
            },
          };
        },
        location: ({ language, sourceKey, side }) => ({
          language,
          key: sourceKey,
          range:
            side === "source"
              ? (project.policies.find(
                  (policy) => policy.sourceLanguage === language,
                )?.sourceRange ?? null)
              : (policies.get(language)?.targetRange ?? null),
        }),
      }),
  );
}
