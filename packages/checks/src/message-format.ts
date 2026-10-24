import type { TranslationUnitInput } from "@l10n/core";
import type {
  QualityCheckDefinition,
  QualityCheckInput,
  QualityEvidence,
  QualityFinding,
  QualityIssue,
  QualityLocation,
  QualityObject,
  QualitySubject,
  JsonValue,
} from "@l10n/core";

export type MessagePlaceholderCheckerOptions<
  TUnit extends TranslationUnitInput,
  TTranslation,
> = {
  readonly sourceText: (unit: TUnit) => unknown;
  readonly translationText: (content: JsonValue) => unknown;
  readonly sourceLocation?: (
    unit: TUnit,
    subject: QualitySubject,
    defaultLocation: QualityLocation,
  ) => QualityLocation;
  readonly translationLocation?: (
    translation: TTranslation | undefined,
    subject: QualitySubject,
    defaultLocation: QualityLocation,
  ) => QualityLocation;
  readonly configuration?: unknown;
};

type ParsedMessage =
  | { readonly status: "supported"; readonly branches: readonly string[] }
  | { readonly status: "unsupported"; readonly reason: string }
  | { readonly status: "malformed"; readonly reason: string };

type SubjectResult = {
  readonly findings: readonly QualityFinding[];
  readonly issues: readonly QualityIssue[];
  readonly status: "complete" | "not-applicable" | "incomplete" | "failed";
};

export function createMessagePlaceholderChecker<
  TUnit extends TranslationUnitInput,
  TTranslation,
>(
  options: MessagePlaceholderCheckerOptions<TUnit, TTranslation>,
): QualityCheckDefinition<TUnit, TTranslation> {
  return {
    id: "message-placeholders",
    configuration: options.configuration ?? {},
    check(input) {
      const result = checkCandidate(input, options);
      const counts = {
        selected: 1,
        evaluated: result.status === "complete" ? 1 : 0,
        notApplicable: result.status === "not-applicable" ? 1 : 0,
        incomplete: result.status === "incomplete" ? 1 : 0,
        failed: result.status === "failed" ? 1 : 0,
      };
      const status =
        counts.failed > 0
          ? "failed"
          : counts.incomplete > 0
            ? "incomplete"
            : counts.evaluated > 0
              ? "complete"
              : "not-applicable";

      return {
        status,
        diagnostics: result.findings,
        issues: result.issues,
        coverage: counts,
      };
    },
  };
}

function checkCandidate<TUnit extends TranslationUnitInput, TTranslation>(
  input: QualityCheckInput<TUnit, TTranslation>,
  options: MessagePlaceholderCheckerOptions<TUnit, TTranslation>,
): SubjectResult {
  const subject: QualitySubject = {
    key: input.candidate.sourceKey,
    language: input.candidate.language,
  };
  const sourceUnit = input.sourceUnit ?? undefined;
  if (sourceUnit === undefined)
    return incomplete(
      "sourceUnavailable",
      "原文事实中没有该检查对象。",
      subject,
    );

  const targetObject = translationObject(subject);
  const sourceObject: QualityObject = {
    kind: "translation-unit",
    key: subject.key,
  };
  const association = input.facts.associations.find(
    ({ sourceKey, language }) =>
      sourceKey === subject.key && language === subject.language,
  );
  const record =
    association?.status === "matched" &&
    association.translationIndexes.length === 1
      ? input.facts.translations.records.find(
          ({ index }) => index === association.translationIndexes[0],
        )
      : undefined;
  if (sourceUnit.bodyAvailability !== "available")
    return incomplete("sourceUnavailable", "原文正文不可用。", subject);

  const sourceValue = options.sourceText(sourceUnit.unit);
  const targetValue = options.translationText(input.candidate.content);
  if (typeof sourceValue !== "string")
    return incomplete(
      "sourceMessageUnavailable",
      "无法从原文事实取得消息文本。",
      subject,
    );
  if (typeof targetValue !== "string")
    return incomplete(
      "targetMessageUnavailable",
      "无法从译文事实取得消息文本。",
      subject,
    );

  const defaultSourceLocation: QualityLocation = {
    language: null,
    range: input.facts.source.read.scopes[sourceUnit.scopeIndex]?.range,
  };
  const defaultTargetLocation: QualityLocation = {
    language: subject.language,
    range: record?.range ?? null,
    key: subject.key,
  };
  const sourceLocation =
    options.sourceLocation?.(sourceUnit.unit, subject, defaultSourceLocation) ??
    defaultSourceLocation;
  const targetLocation =
    options.translationLocation?.(
      record?.translation,
      subject,
      defaultTargetLocation,
    ) ?? defaultTargetLocation;
  const sourceEvidence: QualityEvidence = {
    role: "source",
    object: sourceObject,
    location: sourceLocation,
    value: sourceValue,
  };
  const targetEvidence: QualityEvidence = {
    role: "target",
    object: targetObject,
    location: targetLocation,
    value: input.candidate.content,
  };

  const parsedSource = parseMessage(sourceValue);
  const parsedTarget = parseMessage(targetValue);
  if (
    parsedSource.status === "malformed" ||
    parsedTarget.status === "malformed"
  ) {
    const malformed = [parsedSource, parsedTarget]
      .filter((parsed) => parsed.status === "malformed")
      .map(({ reason }) => reason)
      .join("；");
    return {
      status: "failed",
      findings: [],
      issues: [
        issue(
          "malformedMessage",
          `消息格式损坏：${malformed}`,
          subject,
          targetLocation,
          [sourceEvidence, targetEvidence],
        ),
      ],
    };
  }
  if (
    parsedSource.status === "unsupported" ||
    parsedTarget.status === "unsupported"
  ) {
    const unsupported = [parsedSource, parsedTarget]
      .filter((parsed) => parsed.status === "unsupported")
      .map(({ reason }) => reason)
      .join("；");
    return {
      status: "incomplete",
      findings: [],
      issues: [
        issue(
          "unsupportedMessageSyntax",
          `消息包含尚不支持的语法：${unsupported}`,
          subject,
          targetLocation,
          [sourceEvidence, targetEvidence],
        ),
      ],
    };
  }

  const missing = missingPlaceholders(
    parsedSource.branches,
    parsedTarget.branches,
  );
  return {
    status: "complete",
    findings: missing.map((placeholder) => ({
      severity: "error",
      object: targetObject,
      location: targetLocation,
      message: `译文可能缺少占位符 {${placeholder}}。`,
      evidence: [sourceEvidence, targetEvidence],
    })),
    issues: [],
  };
}

function parseMessage(message: string): ParsedMessage {
  if (/@(?:\.|:)/u.test(message))
    return { status: "unsupported", reason: "链接消息" };

  const branches: string[] = [];
  let start = 0;
  let index = 0;
  while (index < message.length) {
    const character = message[index];
    if (character === "|") {
      branches.push(message.slice(start, index));
      start = index + 1;
      index += 1;
      continue;
    }
    if (character === "}")
      return { status: "malformed", reason: "出现没有对应开始符的 }" };
    if (character !== "{") {
      index += 1;
      continue;
    }

    const close = message.indexOf("}", index + 1);
    if (close === -1)
      return { status: "malformed", reason: "占位符缺少结束符 }" };
    const placeholder = message.slice(index + 1, close);
    if (!/^(?:[\p{L}_$][\p{L}\p{N}_$.-]*|\d+)$/u.test(placeholder))
      return {
        status: "unsupported",
        reason: `不支持 {${placeholder}} 形式的插值`,
      };
    index = close + 1;
  }
  branches.push(message.slice(start));
  return { status: "supported", branches };
}

function missingPlaceholders(
  sourceBranches: readonly string[],
  targetBranches: readonly string[],
): string[] {
  const source = placeholderCounts(sourceBranches);
  const target = placeholderCounts(targetBranches);
  return [...source.entries()]
    .filter(([name, sourceCounts]) => {
      const targetCounts = target.get(name) ?? [0];
      return (
        Math.min(...targetCounts) < Math.min(...sourceCounts) ||
        Math.max(...targetCounts) < Math.max(...sourceCounts)
      );
    })
    .map(([name]) => name)
    .sort();
}

function placeholderCounts(branches: readonly string[]): Map<string, number[]> {
  const branchCounts = branches.map((branch) => {
    const branchCounts = new Map<string, number>();
    for (const match of branch.matchAll(
      /\{([\p{L}_$][\p{L}\p{N}_$.-]*|\d+)\}/gu,
    )) {
      const placeholder = match[1];
      if (placeholder !== undefined)
        branchCounts.set(placeholder, (branchCounts.get(placeholder) ?? 0) + 1);
    }
    return branchCounts;
  });
  const names = new Set(branchCounts.flatMap((counts) => [...counts.keys()]));
  return new Map(
    [...names].map((name) => [
      name,
      branchCounts.map((counts) => counts.get(name) ?? 0),
    ]),
  );
}

function translationObject(subject: QualitySubject): QualityObject {
  return {
    kind: "translation-unit",
    key: subject.key,
    language: subject.language,
  };
}

function incomplete(
  code: string,
  message: string,
  subject: QualitySubject,
): SubjectResult {
  return {
    status: "incomplete",
    findings: [],
    issues: [issue(code, message, subject)],
  };
}

function issue(
  code: string,
  message: string,
  subject: QualitySubject,
  location?: {
    readonly language: string | null;
    readonly range: unknown;
    readonly key?: string;
  },
  evidence?: readonly QualityEvidence[],
): QualityIssue {
  return {
    code,
    message,
    object: translationObject(subject),
    ...(location === undefined ? {} : { location }),
    ...(evidence === undefined ? {} : { evidence }),
  };
}
