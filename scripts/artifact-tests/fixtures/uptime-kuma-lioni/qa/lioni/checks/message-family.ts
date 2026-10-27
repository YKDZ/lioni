import { createMessageFamilyChecker } from "@lioni/checks";
import type { TextAnalysis, TemplateOptions } from "@lioni/text-analysis";

import type { createKumaAnalysis } from "../analysis.ts";
import type { Unit, Translation, Body, Project } from "../model.ts";
import {
  createScopeResolver,
  createTargetSignatureEquivalence,
} from "./scope.ts";

export function createFamilyCheck(
  project: Project,
  { analysis, message }: ReturnType<typeof createKumaAnalysis>,
) {
  const policies = new Map(
    project.policies.map((policy) => [policy.targetLanguage, policy]),
  );
  const scopes = new Map(
    project.policies.map((policy) => [
      policy.targetLanguage,
      createScopeResolver(policy),
    ]),
  );
  const equivalences = new Map(
    project.policies.map((policy) => [
      policy.targetLanguage,
      createTargetSignatureEquivalence(policy.targetEquivalences),
    ]),
  );
  const sourceTemplate: TemplateOptions = {
    abstract: (token) =>
      token.kind === "variable" && token.identity
        ? { kind: token.kind, identity: token.identity }
        : undefined,
  };
  const targetTemplate: TemplateOptions = { ...sourceTemplate };
  const familyAnalysis: TextAnalysis = {
    ...analysis,
    async signature(input, options, runtime) {
      const signature = await analysis.signature(input, options, runtime);
      return options === targetTemplate
        ? (equivalences.get(input.language)?.(signature) ?? signature)
        : signature;
    },
  };
  return createMessageFamilyChecker<Unit, Translation, Unit, Body>({
    hostVersion: "kuma-message-family/v2+@intlify/message-compiler@11.2.8",
    analysis: familyAnalysis,
    select: (input) =>
      !policies.has(input.candidate.language) ||
      input.sourceUnit === null ||
      !input.candidate.content.text.trim() ||
      message(input.sourceUnit.unit.source.text).errors.length > 0 ||
      message(input.candidate.content.text).errors.length > 0
        ? { status: "not-applicable" }
        : {
            status: "selected",
            subject: {
              sourceUnit: input.sourceUnit,
              sourceKey: input.candidate.sourceKey,
              language: input.candidate.language,
              content: input.candidate.content,
            },
          },
    project: (input) => {
      const language =
        input.kind === "candidate" ? input.subject.language : input.language;
      const policy = policies.get(language);
      if (!policy)
        return {
          complete: false,
          groups: [],
          issues: [
            {
              code: "missing-language-policy",
              message: `未声明 ${language} 的消息族策略。`,
              language,
            },
          ],
        };
      const key =
        input.kind === "candidate" ? input.subject.sourceKey : input.sourceKey;
      const unit =
        input.kind === "candidate"
          ? input.subject.sourceUnit
          : input.sourceUnit;
      const content =
        input.kind === "candidate"
          ? input.subject.content
          : input.translation.bodyAvailability === "available"
            ? input.translation.content
            : null;
      if (!content)
        return {
          complete: false,
          groups: [],
          issues: [{ code: "unavailable", message: "保存译文不可用。" }],
        };
      if (
        message(unit.unit.source.text).errors.length ||
        message(content.text).errors.length
      )
        return { groups: [] };
      return {
        groups: [
          {
            ref: key,
            scope: scopes.get(language)!(key),
            source: {
              language: policy.sourceLanguage,
              fragments: [{ ref: key, text: unit.unit.source.text }],
            },
            target: {
              language: policy.targetLanguage,
              fragments: [{ ref: key, text: content.text }],
            },
          },
        ],
      };
    },
    sourceTemplate,
    targetTemplate,
  });
}
