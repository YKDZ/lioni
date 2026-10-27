import {
  parseVueI18nMessage,
  VUE_I18N_MESSAGE_COMPILER_VERSION,
} from "@lioni/checks";
import { bindQualityCheck } from "@lioni/core";
import type {
  QualityCheckInput,
  QualityCheckOutcome,
  QualityEvidence,
  QualityIssue,
  QualityLocation,
  QualityObject,
  StandardSchemaV1,
} from "@lioni/core";

import { kumaCandidateStatus } from "../candidate-status.ts";
import type {
  Body,
  Pair,
  Policy,
  Project,
  Translation,
  Unit,
} from "../model.ts";
import { snapshotKumaProject } from "../project-snapshot.ts";

type MessageSubject = Pair;
type Evaluation = (pair: Pair, policy: Policy) => QualityCheckOutcome;
type Applicability = (pair: Pair, policy: Policy) => boolean;

const configurationSchema: StandardSchemaV1<
  { readonly version: 1 },
  { readonly version: 1 }
> = {
  "~standard": {
    version: 1,
    vendor: "kuma-vue-message-checks",
    validate(value) {
      return isRecord(value) && value.version === 1
        ? { value: { version: 1 } }
        : { issues: [{ message: "Kuma 消息检查配置无效。" }] };
    },
  },
};

const inputSchema: StandardSchemaV1<Pair, Pair> = {
  "~standard": {
    version: 1,
    vendor: "kuma-vue-message-checks",
    validate(value) {
      return isRecord(value) &&
        typeof value.key === "string" &&
        typeof value.source === "string" &&
        typeof value.target === "string" &&
        typeof value.language === "string"
        ? { value: value as Pair }
        : { issues: [{ message: "Kuma 消息检查输入无效。" }] };
    },
  },
};

const configuration = { version: 1 } as const;

function createMessageCheck(
  id: string,
  version: string,
  project: Project,
  evaluate: Evaluation,
  appliesTo?: Applicability,
) {
  const snapshot = snapshotKumaProject(project);
  const policies = new Map(
    snapshot.policies.map((policy) => [policy.targetLanguage, policy]),
  );
  return bindQualityCheck<
    Unit,
    Translation,
    typeof configurationSchema,
    typeof inputSchema,
    MessageSubject,
    QualityObject,
    Body,
    never
  >({
    id,
    version,
    configurationSchema,
    configuration,
    inputSchema,
    select: (
      input: QualityCheckInput<Unit, Translation, unknown, Body, never>,
    ) => {
      const policy = policies.get(input.candidate.language);
      if (policy === undefined) return { status: "not-applicable" };
      const candidateStatus = kumaCandidateStatus(input);
      if (candidateStatus === "missing") return { status: "not-applicable" };
      if (candidateStatus === "unavailable")
        return {
          status: "incomplete",
          issue: {
            code: "candidateBodyUnavailable",
            message: "目标消息正文不可用，检查未执行。",
          },
        };
      const subject: Pair = {
        key: input.candidate.sourceKey,
        source:
          input.sourceUnit?.bodyAvailability === "available"
            ? input.sourceUnit.unit.source.text
            : "",
        target: input.candidate.content.text,
        language: input.candidate.language,
      };
      return appliesTo !== undefined && !appliesTo(subject, policy)
        ? { status: "not-applicable" }
        : { status: "selected", subject };
    },
    project: (input) => ({ status: "ready", value: input.subject }),
    check: (input) =>
      evaluate(input.projected, policies.get(input.projected.language)!),
  });
}

export function createCallArgumentCheck(project: Project) {
  const hasUsageEvidence = (pair: Pair, policy: Policy) =>
    policy.usages.entries.some((usage) => usage.key === pair.key) ||
    policy.usages.unresolved.length > 0 ||
    policy.usages.errors.length > 0;

  return createMessageCheck(
    "kuma/vue-message-call-arguments",
    `kuma/vue-message-call-arguments/v1+@intlify/message-compiler@${VUE_I18N_MESSAGE_COMPILER_VERSION}+usage-scan-v1`,
    project,
    (pair, policy) => {
      const message = parseVueI18nMessage(pair.target);
      if (message.errors.length > 0)
        return incompleteOutcome([
          issue(
            "targetMessageSyntaxInvalid",
            "译文语法无效，调用参数检查未执行。",
          ),
        ]);

      const diagnostics = [];
      const issues: QualityIssue[] = [];
      const usages = policy.usages.entries.filter(
        (usage) => usage.key === pair.key,
      );
      for (const usage of usages) {
        if (!usage.parametersKnown) {
          issues.push(
            issue(
              "callParametersUnknown",
              `调用点 ${usage.file} 的参数无法完整静态确定。`,
            ),
          );
          continue;
        }
        for (const branch of message.branches) {
          const variables = new Set(branch.variables);
          for (const variable of variables) {
            if (usage.supplied.includes(variable)) continue;
            const token = message.tokens.find(
              (candidate) =>
                candidate.kind === "variable" &&
                candidate.identity === variable &&
                candidate.start >= branch.range.start &&
                candidate.end <= branch.range.end,
            );
            const range =
              token === undefined
                ? branch.range
                : { start: token.start, end: token.end };
            diagnostics.push(
              finding(
                pair,
                policy,
                "call-argument-missing",
                `调用点 ${usage.file} 未提供译文使用的变量 ${variable}。`,
                range,
                [
                  {
                    role: "target-variable",
                    object: translationObject(pair),
                    location: messageLocation(pair, policy, range),
                    value: variable,
                  },
                  {
                    role: "call-site",
                    object: translationObject(pair),
                    location: {
                      language: null,
                      range: usage.file,
                      key: pair.key,
                    },
                    value: usage,
                  },
                ],
              ),
            );
          }
        }
      }

      if (
        policy.usages.unresolved.length > 0 ||
        policy.usages.errors.length > 0
      ) {
        const count =
          policy.usages.unresolved.length + policy.usages.errors.length;
        issues.push(
          issue(
            "callUsageIndexIncomplete",
            `有 ${count} 个调用点无法静态关联到消息键，调用参数覆盖不完整。`,
          ),
        );
      }
      return issues.length === 0
        ? completeOutcome(diagnostics)
        : incompleteOutcome(issues, diagnostics);
    },
    hasUsageEvidence,
  );
}

export function createLinkTargetCheck(project: Project) {
  return createMessageCheck(
    "kuma/vue-message-link-target-exists",
    `kuma/vue-message-link-target-exists/v1+@intlify/message-compiler@${VUE_I18N_MESSAGE_COMPILER_VERSION}`,
    project,
    (pair, policy) => {
      const message = parseVueI18nMessage(pair.target);
      if (message.errors.length > 0)
        return incompleteOutcome([
          issue(
            "targetMessageSyntaxInvalid",
            "译文语法无效，关联目标检查未执行。",
          ),
        ]);

      const diagnostics = message.linkFacts.flatMap((link) =>
        link.kind === "static" &&
        !hasOwn(policy.source, link.key) &&
        !hasOwn(policy.target, link.key)
          ? [
              finding(
                pair,
                policy,
                "missing-linked-message",
                `译文关联的消息键 ${link.key} 不存在。`,
                link.range,
                [
                  {
                    role: "target-message",
                    object: translationObject(pair),
                    location: messageLocation(pair, policy, link.range),
                    value: pair.target,
                  },
                  {
                    role: "linked-key",
                    object: translationObject(pair),
                    location: messageLocation(pair, policy, link.range),
                    value: link.key,
                  },
                ],
              ),
            ]
          : [],
      );
      return completeOutcome(diagnostics);
    },
  );
}

export function createLinkCycleCheck(project: Project) {
  return createMessageCheck(
    "kuma/vue-message-link-cycle",
    `kuma/vue-message-link-cycle/v1+@intlify/message-compiler@${VUE_I18N_MESSAGE_COMPILER_VERSION}`,
    project,
    (pair, policy) => {
      const search = findCycle(pair, policy);
      const diagnostics =
        search.path === undefined
          ? []
          : [
              finding(
                pair,
                policy,
                "linked-message-cycle",
                `关联消息形成循环：${search.path.join(" → ")}。`,
                search.range ?? fullRange(pair.target),
                [
                  {
                    role: "target-message",
                    object: translationObject(pair),
                    location: messageLocation(
                      pair,
                      policy,
                      search.range ?? fullRange(pair.target),
                    ),
                    value: pair.target,
                  },
                  {
                    role: "link-cycle",
                    object: translationObject(pair),
                    location: messageLocation(
                      pair,
                      policy,
                      search.range ?? fullRange(pair.target),
                    ),
                    value: search.path,
                  },
                ],
              ),
            ];
      return search.issues.length === 0
        ? completeOutcome(diagnostics)
        : incompleteOutcome(search.issues, diagnostics);
    },
  );
}

function findCycle(
  pair: Pair,
  policy: Policy,
): {
  readonly path?: readonly string[];
  readonly range?: { readonly start: number; readonly end: number };
  readonly issues: readonly QualityIssue[];
} {
  const active = new Map<string, number>();
  const done = new Set<string>();
  const stack: string[] = [];
  const issues: QualityIssue[] = [];
  let path: readonly string[] | undefined;
  let range: { readonly start: number; readonly end: number } | undefined;

  function visit(key: string): boolean {
    const activeIndex = active.get(key);
    if (activeIndex !== undefined) {
      path = [...stack.slice(activeIndex), key];
      return true;
    }
    if (done.has(key)) return false;

    active.set(key, stack.length);
    stack.push(key);
    const text =
      key === pair.key
        ? pair.target
        : hasOwn(policy.target, key)
          ? policy.target[key]
          : hasOwn(policy.source, key)
            ? policy.source[key]
            : undefined;
    if (text !== undefined) {
      const message = parseVueI18nMessage(text);
      if (message.errors.length > 0) {
        issues.push(
          issue(
            "linkedMessageSyntaxInvalid",
            `关联消息 ${key} 语法无效，无法完整判断循环。`,
          ),
        );
      } else {
        for (const link of message.linkFacts) {
          if (link.kind !== "static") continue;
          if (visit(link.key)) {
            if (key === pair.key) range = link.range;
            return true;
          }
        }
      }
    }
    stack.pop();
    active.delete(key);
    done.add(key);
    return false;
  }

  visit(pair.key);
  return {
    ...(path === undefined ? {} : { path }),
    ...(range === undefined ? {} : { range }),
    issues,
  };
}

function finding(
  pair: Pair,
  policy: Policy,
  code: string,
  message: string,
  span: { readonly start: number; readonly end: number },
  evidence: readonly QualityEvidence[],
) {
  const location = messageLocation(pair, policy, span);
  return {
    severity: "error" as const,
    object: { ...translationObject(pair), code },
    location,
    message,
    evidence,
  };
}

function translationObject(pair: Pair): QualityObject {
  return { kind: "translation-unit", key: pair.key, language: pair.language };
}

function messageLocation(
  pair: Pair,
  policy: Policy,
  span: { readonly start: number; readonly end: number },
): QualityLocation {
  return {
    language: pair.language,
    range: policy.targetRange,
    span,
    key: pair.key,
  };
}

function completeOutcome(
  diagnostics: QualityCheckOutcome["diagnostics"],
): QualityCheckOutcome {
  return {
    status: "complete",
    diagnostics,
    issues: [],
    coverage: {
      selected: 1,
      evaluated: 1,
      notApplicable: 0,
      incomplete: 0,
      failed: 0,
    },
  };
}

function incompleteOutcome(
  issues: readonly QualityIssue[],
  diagnostics: QualityCheckOutcome["diagnostics"] = [],
): QualityCheckOutcome {
  return {
    status: "incomplete",
    diagnostics,
    issues,
    coverage: {
      selected: 1,
      evaluated: 0,
      notApplicable: 0,
      incomplete: 1,
      failed: 0,
    },
  };
}

function issue(code: string, message: string): QualityIssue {
  return { code, message };
}

function hasOwn(
  record: Readonly<Record<string, string>>,
  key: string,
): boolean {
  return Object.hasOwn(record, key);
}

function fullRange(text: string) {
  return { start: 0, end: text.length };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
