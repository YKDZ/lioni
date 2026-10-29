import type { QualityIssue, TranslationUnitInput } from "@lioni/core";
import type { MemoScope } from "@lioni/memo";

import { memoizedVueI18nMessage } from "../message-memo.ts";
import type {
  VueI18nCheckIdentity,
  VueI18nMessageProjection,
  VueI18nPolicy,
  VueI18nProjector,
} from "../quality-types.ts";
import { VUE_I18N_MESSAGE_COMPILER_VERSION } from "../vue-i18n-messages.ts";
import {
  completeOutcome,
  createVueI18nMessageCheck,
  finding,
  incompleteOutcome,
  issue,
  messageLocation,
  translationObject,
} from "./common.ts";

export function createLinkTargetExistsCheck<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable = never,
>(options: {
  readonly identity: VueI18nCheckIdentity;
  readonly project: VueI18nProjector<TUnit, TTranslation, TBody, TUnavailable>;
}) {
  return createVueI18nMessageCheck({
    id: options.identity.id,
    version: version("link-target-exists", options.identity),
    project: options.project,
    requiresSource: false,
    requiresTarget: true,
    prepare: (projection, policy, memo) => {
      if (projection.target.status !== "available") return [];
      const message = memoizedVueI18nMessage(projection.target.text, memo);
      return message.linkFacts.flatMap((link) =>
        link.kind === "static"
          ? [
              {
                key: link.key,
                exists:
                  hasOwn(policy.resources.source.messages, link.key) ||
                  hasOwn(policy.resources.target.messages, link.key),
              },
            ]
          : [],
      );
    },
    check: (input, _policy, targets) => {
      const projection = input.projected;
      if (projection.target.status !== "available")
        return incompleteOutcome([
          issue("targetUnavailable", "目标消息正文不可用。", projection),
        ]);
      const targetText = projection.target.text;
      const message = memoizedVueI18nMessage(targetText, input.memo);
      if (message.errors.length > 0)
        return incompleteOutcome([
          issue(
            "targetMessageSyntaxInvalid",
            "译文语法无效，关联目标检查未执行。",
            projection,
          ),
        ]);
      const diagnostics = message.linkFacts.flatMap((link) =>
        link.kind === "static" &&
        !targets.some((target) => target.key === link.key && target.exists)
          ? [
              finding(
                projection,
                "missing-linked-message",
                `译文关联的消息键 ${link.key} 不存在。`,
                link.range,
                [
                  {
                    role: "target-message",
                    object: translationObject(projection),
                    location: messageLocation(projection, link.range),
                    value: targetText,
                  },
                  {
                    role: "linked-key",
                    object: translationObject(projection),
                    location: messageLocation(projection, link.range),
                    value: link.key,
                  },
                ],
              ),
            ]
          : [],
      );
      return completeOutcome(diagnostics);
    },
  });
}

export function createLinkCycleCheck<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable = never,
>(options: {
  readonly identity: VueI18nCheckIdentity;
  readonly project: VueI18nProjector<TUnit, TTranslation, TBody, TUnavailable>;
}) {
  return createVueI18nMessageCheck({
    id: options.identity.id,
    version: version("link-cycle", options.identity),
    project: options.project,
    requiresSource: false,
    requiresTarget: true,
    prepare: reachableMessages,
    check: (input, _policy, messages) => {
      if (input.projected.target.status !== "available")
        return incompleteOutcome([
          issue("targetUnavailable", "目标消息正文不可用。", input.projected),
        ]);
      const search = findCycle(input.projected, messages, input.memo);
      const targetText = input.projected.target.text;
      const fallbackRange = fullRange(input.projected.target.text);
      const diagnostics =
        search.path === undefined
          ? []
          : [
              finding(
                input.projected,
                "linked-message-cycle",
                `关联消息形成循环：${search.path.join(" → ")}。`,
                search.range ?? fallbackRange,
                [
                  {
                    role: "target-message",
                    object: translationObject(input.projected),
                    location: messageLocation(
                      input.projected,
                      search.range ?? fallbackRange,
                    ),
                    value: targetText,
                  },
                  {
                    role: "link-cycle",
                    object: translationObject(input.projected),
                    location: messageLocation(
                      input.projected,
                      search.range ?? fallbackRange,
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
  });
}

type ReachableMessage = {
  readonly key: string;
  readonly origin: "candidate" | "target" | "source" | "missing";
  readonly text: string | null;
};

/** 先准备完整可达闭包，包括缺失键，避免首次发现循环后漏掉后续依赖。 */
function reachableMessages(
  projection: VueI18nMessageProjection,
  policy: VueI18nPolicy,
  memo: MemoScope,
): readonly ReachableMessage[] {
  const messages = new Map<string, ReachableMessage>();
  function visit(key: string) {
    if (messages.has(key)) return;
    const origin =
      key === projection.key
        ? "candidate"
        : hasOwn(policy.resources.target.messages, key)
          ? "target"
          : hasOwn(policy.resources.source.messages, key)
            ? "source"
            : "missing";
    const text =
      origin === "candidate"
        ? projection.target.status === "available"
          ? projection.target.text
          : null
        : origin === "missing"
          ? null
          : policy.resources[origin].messages[key]!;
    messages.set(key, { key, origin, text });
    if (text === null) return;
    const message = memoizedVueI18nMessage(text, memo);
    if (message.errors.length > 0) return;
    for (const link of message.linkFacts)
      if (link.kind === "static") visit(link.key);
  }
  visit(projection.key);
  return [...messages.values()];
}

type CycleSearch = {
  readonly path?: readonly string[];
  readonly range?: { readonly start: number; readonly end: number };
  readonly issues: readonly QualityIssue[];
};

function findCycle(
  projection: VueI18nMessageProjection,
  messages: readonly ReachableMessage[],
  memo: MemoScope,
): CycleSearch {
  const byKey = new Map(messages.map((message) => [message.key, message.text]));
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
    const text = byKey.get(key) ?? undefined;
    if (text !== undefined) {
      const message = memoizedVueI18nMessage(text, memo);
      if (message.errors.length > 0) {
        issues.push(
          issue(
            "linkedMessageSyntaxInvalid",
            `关联消息 ${key} 语法无效，无法完整判断循环。`,
            projection,
          ),
        );
      } else {
        for (const link of message.linkFacts) {
          if (link.kind !== "static") continue;
          if (visit(link.key)) {
            if (key === projection.key) range = link.range;
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

  visit(projection.key);
  return {
    ...(path === undefined ? {} : { path }),
    ...(range === undefined ? {} : { range }),
    issues,
  };
}

function version(kind: string, identity: VueI18nCheckIdentity): string {
  const base = `vue-i18n-suite/${kind}/v2+@intlify/message-compiler@${VUE_I18N_MESSAGE_COMPILER_VERSION}`;
  return identity.hostVersion ? `${base}+${identity.hostVersion}` : base;
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
