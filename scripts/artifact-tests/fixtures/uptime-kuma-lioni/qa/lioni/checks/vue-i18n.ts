import {
  createVueI18nSourceSyntaxChecker,
  createVueI18nTargetSyntaxChecker,
  createVueI18nVariableCorrespondenceChecker,
} from "@lioni/checks";
import type { QualityCheckInput, QualityLocation } from "@lioni/core";

import { kumaCandidateStatus } from "../candidate-status.ts";
import type { Policy, Project, Translation, Unit, Body } from "../model.ts";

const policiesByLanguage = (project: Project) =>
  new Map(project.policies.map((policy) => [policy.targetLanguage, policy]));

type Input = QualityCheckInput<Unit, Translation, unknown, Body, never>;

function unsupported(input: Input, policies: ReadonlyMap<string, Policy>) {
  const policy = policies.get(input.candidate.language);
  if (policy === undefined || kumaCandidateStatus(input) === "missing")
    return { status: "not-applicable" } as const;
  if (kumaCandidateStatus(input) === "unavailable")
    return {
      status: "incomplete",
      issue: {
        code: "candidateBodyUnavailable",
        message: "目标消息正文不可用，Vue I18n 检查未执行。",
      },
    } as const;
  return undefined;
}

function sourceLocation(
  policy: Policy,
  key: string,
  span: QualityLocation["span"],
) {
  return {
    language: null,
    range: policy.sourceRange,
    span,
    key,
  };
}

function targetLocation(
  policy: Policy,
  key: string,
  span: QualityLocation["span"],
) {
  return {
    language: policy.targetLanguage,
    range: policy.targetRange,
    span,
    key,
  };
}

export function createSourceSyntaxCheck(project: Project) {
  const policies = policiesByLanguage(project);
  return createVueI18nSourceSyntaxChecker<Unit, Translation, Unit, Body, never>(
    {
      hostVersion: "kuma-source-syntax-v1",
      select: (input) => {
        const skipped = unsupported(input, policies);
        if (skipped !== undefined) return skipped;
        if (input.sourceUnit === null) return { status: "not-applicable" };
        return {
          status: "selected",
          subject: {
            sourceUnit: input.sourceUnit,
            sourceKey: input.candidate.sourceKey,
            language: input.candidate.language,
          },
        };
      },
      sourceText: (unit) => unit.source.text,
      sourceLocation: (_unit, subject, range) =>
        sourceLocation(policies.get(subject.language)!, subject.key, range),
    },
  );
}

export function createTargetSyntaxCheck(project: Project) {
  const policies = policiesByLanguage(project);
  return createVueI18nTargetSyntaxChecker<Unit, Translation, Body, Body, never>(
    {
      hostVersion: "kuma-target-syntax-v1",
      select: (input) => {
        const skipped = unsupported(input, policies);
        if (skipped !== undefined) return skipped;
        return {
          status: "selected",
          subject: {
            sourceKey: input.candidate.sourceKey,
            language: input.candidate.language,
            content: input.candidate.content,
          },
        };
      },
      targetText: (content) => content.text,
      targetLocation: (_translation, subject, range) =>
        targetLocation(policies.get(subject.language)!, subject.key, range),
    },
  );
}

export function createVariableCorrespondenceCheck(project: Project) {
  const policies = policiesByLanguage(project);
  return createVueI18nVariableCorrespondenceChecker<
    Unit,
    Translation,
    Unit,
    Body,
    Body,
    never
  >({
    hostVersion: "kuma-variable-correspondence-v1",
    select: (input) => {
      const skipped = unsupported(input, policies);
      if (skipped !== undefined) return skipped;
      if (input.sourceUnit === null) return { status: "not-applicable" };
      return {
        status: "selected",
        subject: {
          sourceUnit: input.sourceUnit,
          sourceKey: input.candidate.sourceKey,
          language: input.candidate.language,
          content: input.candidate.content,
        },
      };
    },
    sourceText: (unit) => unit.source.text,
    targetText: (content) => content.text,
    sourceLocation: (_unit, subject, range) =>
      sourceLocation(policies.get(subject.language)!, subject.key, range),
    targetLocation: (_translation, subject, range) =>
      targetLocation(policies.get(subject.language)!, subject.key, range),
  });
}
