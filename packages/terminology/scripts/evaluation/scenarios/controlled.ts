import assert from "node:assert/strict";

import {
  analyzeTermUse,
  assessTermUse,
  compileTerms,
  createTermbase,
  discoverTerms,
  type TermComparisonInput,
  type TermDiscoveryCorpus,
  type TermbaseData,
} from "@lioni/terminology";

import { canonicalJson, sha256 } from "../support/json.ts";
import type { ScenarioReport } from "../support/types.ts";

const termbaseData: TermbaseData = Object.freeze({
  concepts: Object.freeze([
    Object.freeze({
      id: "workspace",
      languages: Object.freeze([
        Object.freeze({
          language: "en",
          expressions: Object.freeze([
            {
              id: "workspace-en",
              text: "workspace",
              usage: "preferred" as const,
            },
          ]),
        }),
        Object.freeze({
          language: "zh-CN",
          expressions: Object.freeze([
            { id: "workspace-zh", text: "工作区", usage: "allowed" as const },
            {
              id: "workspace-zh-alt",
              text: "工作空间",
              usage: "allowed" as const,
            },
            {
              id: "workspace-zh-forbidden",
              text: "作业区",
              usage: "forbidden" as const,
            },
          ]),
        }),
      ]),
    }),
    Object.freeze({
      id: "log",
      languages: Object.freeze([
        Object.freeze({
          language: "en",
          expressions: Object.freeze([
            { id: "log-en", text: "log", usage: "preferred" as const },
          ]),
        }),
        Object.freeze({
          language: "zh-CN",
          expressions: Object.freeze([
            { id: "log-zh", text: "日志", usage: "allowed" as const },
            { id: "log-record", text: "记录", usage: "forbidden" as const },
          ]),
        }),
      ]),
    }),
    Object.freeze({
      id: "record",
      languages: Object.freeze([
        Object.freeze({
          language: "en",
          expressions: Object.freeze([
            { id: "record-en", text: "record", usage: "preferred" as const },
          ]),
        }),
        Object.freeze({
          language: "zh-CN",
          expressions: Object.freeze([
            { id: "record-zh", text: "记录", usage: "allowed" as const },
          ]),
        }),
      ]),
    }),
    Object.freeze({
      id: "retention-policy",
      languages: Object.freeze([
        Object.freeze({
          language: "en",
          expressions: Object.freeze([
            {
              id: "retention-policy-en",
              text: "data retention policy",
              usage: "preferred" as const,
            },
          ]),
        }),
        Object.freeze({
          language: "zh-CN",
          expressions: Object.freeze([
            {
              id: "retention-policy-zh",
              text: "数据保留政策",
              usage: "allowed" as const,
            },
          ]),
        }),
      ]),
    }),
  ]),
});

const comparison: TermComparisonInput = Object.freeze({
  groups: Object.freeze([
    {
      ref: "ui-allowed",
      source: {
        language: "en",
        fragments: [{ ref: "button", text: "Open workspace" }],
      },
      target: {
        language: "zh-CN",
        fragments: [{ ref: "button", text: "打开工作空间" }],
      },
    },
    {
      ref: "ui-forbidden",
      source: {
        language: "en",
        fragments: [{ ref: "button", text: "Open workspace" }],
      },
      target: {
        language: "zh-CN",
        fragments: [{ ref: "button", text: "打开作业区" }],
      },
    },
    {
      ref: "paragraph-long",
      source: {
        language: "en",
        fragments: [
          {
            ref: "body",
            text: "A data retention policy should be documented.",
          },
        ],
      },
      target: {
        language: "zh-CN",
        fragments: [{ ref: "body", text: "应记录数据保留政策。" }],
      },
    },
    {
      ref: "ui-unicode-short",
      source: {
        language: "en",
        fragments: [{ ref: "label", text: "😀 workspace" }],
      },
      target: {
        language: "zh-CN",
        fragments: [{ ref: "label", text: "😀工作区" }],
      },
    },
    {
      ref: "paragraph-ambiguous",
      source: {
        language: "en",
        fragments: [{ ref: "body", text: "log record" }],
      },
      target: {
        language: "zh-CN",
        fragments: [{ ref: "body", text: "日志与记录" }],
      },
    },
  ]),
});

const discoveryCorpus: TermDiscoveryCorpus = Object.freeze({
  language: "en",
  entries: Object.freeze([
    {
      ref: "ui-one",
      fragments: [{ ref: "button", text: "Open workspace" }],
    },
    {
      ref: "ui-two",
      fragments: [{ ref: "label", text: "Open workspace settings" }],
    },
  ]),
});
const paragraphDiscoveryRefs = Object.freeze([
  "paragraph-long",
  "paragraph-ambiguous",
]);
const paragraphDiscoveryCorpus: TermDiscoveryCorpus = Object.freeze({
  language: "en",
  entries: Object.freeze(
    comparison.groups.flatMap(({ ref, source }) =>
      typeof ref === "string" && paragraphDiscoveryRefs.includes(ref)
        ? [Object.freeze({ ref, fragments: source.fragments })]
        : [],
    ),
  ),
});

export type ControlledGeneration = {
  readonly seed: number;
  readonly count: number;
};

export function generateControlledCorpus(
  generation: ControlledGeneration,
): TermDiscoveryCorpus {
  if (
    !Number.isSafeInteger(generation.seed) ||
    generation.seed < 0 ||
    !Number.isSafeInteger(generation.count) ||
    generation.count < 0
  )
    throw new RangeError("受控生成输入需要非负整数种子和数量。");
  let state = generation.seed >>> 0;
  const next = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
  const vocabulary = [
    "cache",
    "boundary",
    "retry",
    "message",
    "scope",
    "unicode",
    "candidate",
    "policy",
  ];
  const entries = Array.from({ length: generation.count }, (_, index) => {
    const first = vocabulary[next() % vocabulary.length]!;
    const second = vocabulary[next() % vocabulary.length]!;
    return Object.freeze({
      ref: `generated-${index}`,
      fragments: Object.freeze([
        Object.freeze({
          ref: "generated-text",
          text: `${first} ${second} ${index}`,
        }),
      ]),
    });
  });
  return Object.freeze({ language: "en", entries: Object.freeze(entries) });
}

const generation = Object.freeze({ seed: 2_026_1025, count: 64 });

function buildControlledInput(generatedEntryCount: number) {
  const selectedGeneration = Object.freeze({
    ...generation,
    count: generatedEntryCount,
  });
  const generatedCorpus = generateControlledCorpus(selectedGeneration);
  const value = Object.freeze({
    termbase: termbaseData,
    comparison,
    discoveryCorpus,
    policies: {
      assessmentRules: Object.freeze([
        "require-allowed-translation",
        "reject-forbidden-translation",
      ]),
      matching: "public default language policies",
      discovery: Object.freeze({ maxWords: 1, minOccurrences: 2 }),
      generatedDiscovery: Object.freeze({
        maxWords: 2,
        maxCharacters: 40,
        minOccurrences: 1,
        limit: 1_000,
      }),
    },
    generation: selectedGeneration,
    generatedCorpus,
    expected: {
      allowedGroupProblems: 0,
      forbiddenGroupCode: "forbidden-translation",
      uncertainGroupCode: "ambiguous-target",
      discoveredCandidate: "workspace",
      occurrences: 2,
      entryCount: 2,
      unicodeRange: { start: 3, end: 12 },
      longExpressionRange: { start: 2, end: 23 },
    },
  });
  return Object.freeze({
    selectedGeneration,
    generatedCorpus,
    inputSha256: sha256(canonicalJson(value)),
  });
}

export function controlledInputIdentity(generatedEntryCount: number) {
  const input = buildControlledInput(generatedEntryCount);
  return Object.freeze({
    inputSha256: input.inputSha256,
    generation: input.selectedGeneration,
    generatedCorpusSha256: sha256(canonicalJson(input.generatedCorpus)),
  });
}

export async function runControlledScenario(
  generatedEntryCount: number = generation.count,
): Promise<ScenarioReport> {
  const { selectedGeneration, generatedCorpus, inputSha256 } =
    buildControlledInput(generatedEntryCount);
  const terms = compileTerms(createTermbase(termbaseData));
  const analysis = await analyzeTermUse(terms, comparison);
  const assessment = assessTermUse(comparison, analysis);
  const discovery = await discoverTerms(discoveryCorpus, {
    maxWords: 1,
    minOccurrences: 2,
  });
  const paragraphDiscovery = await discoverTerms(paragraphDiscoveryCorpus, {
    maxWords: 3,
    maxCharacters: 80,
    minOccurrences: 1,
    limit: 1_000,
  });
  const generatedDiscovery = await discoverTerms(generatedCorpus, {
    maxWords: 2,
    maxCharacters: 40,
    minOccurrences: 1,
    limit: 1_000,
  });
  const generatedAgain = generateControlledCorpus(selectedGeneration);
  const allowedProblems = assessment.problems.filter(
    ({ groupIndex }) => groupIndex === 0,
  );
  const forbiddenProblems = assessment.problems.filter(
    ({ groupIndex }) => groupIndex === 1,
  );
  const candidate = discovery.candidates.find(
    ({ text }) => text === "workspace",
  );
  const paragraphCandidate = paragraphDiscovery.candidates.find(
    ({ text }) => text === "data retention policy",
  );
  const excludedUiCandidate = paragraphDiscovery.candidates.find(
    ({ text }) => text === "workspace",
  );
  const unicodeMatch = analysis.groups[3]!.source.certain.find(
    ({ conceptId }) => conceptId === "workspace",
  );
  const longMatch = analysis.groups[2]!.source.certain.find(
    ({ conceptId }) => conceptId === "retention-policy",
  );
  const ambiguity = analysis.groups[4]!.target.ambiguities;
  const assessmentStatus = assessment.status;

  assert.equal(assessment.status, "incomplete");
  assert.equal(analysis.groups[0]!.source.status, "complete");
  assert.equal(analysis.groups[0]!.target.certain.length, 1);
  assert.equal(analysis.groups[1]!.source.status, "complete");
  assert.equal(allowedProblems.length, 0);
  assert.ok(
    forbiddenProblems.some(({ code }) => code === "forbidden-translation"),
  );
  assert.ok(
    assessment.issues.some(
      ({ groupIndex, code }) => groupIndex === 4 && code === "ambiguous-target",
    ),
  );
  assert.ok(candidate);
  assert.equal(candidate.occurrences, 2);
  assert.equal(candidate.entryCount, 2);
  assert.deepEqual(candidate.examples[0]!.range, { start: 5, end: 14 });
  assert.equal(paragraphDiscovery.status, "complete");
  assert.equal(paragraphDiscovery.statistics.entries, 2);
  assert.ok(paragraphCandidate);
  assert.equal(paragraphCandidate.occurrences, 1);
  assert.deepEqual(paragraphCandidate.examples[0]!.range, {
    start: 2,
    end: 23,
  });
  assert.equal(excludedUiCandidate, undefined);
  assert.ok(unicodeMatch);
  assert.deepEqual(unicodeMatch.range, { start: 3, end: 12 });
  assert.ok(longMatch);
  assert.deepEqual(longMatch.range, { start: 2, end: 23 });
  assert.ok(ambiguity.length > 0);
  assert.deepEqual(generatedCorpus, generatedAgain);
  assert.equal(generatedDiscovery.status, "complete");
  assert.equal(generatedDiscovery.statistics.entries, selectedGeneration.count);

  return Object.freeze({
    execution: Object.freeze({ status: "passed" }),
    domain: Object.freeze({
      status: assessmentStatus,
    }),
    inputSha256,
    metrics: Object.freeze({
      contractAssertions: Object.freeze({
        status: "evaluated",
        basis:
          "离线公开 API 受控正反项；UI 与段落分开，覆盖 Unicode UTF-16 区间和局部目标歧义。",
        value: Object.freeze({
          comparisonGroups: comparison.groups.length,
          completeGroups: analysis.groups.filter(
            ({ source, target }) =>
              source.status === "complete" && target.status === "complete",
          ).length,
          ambiguousGroups: analysis.groups.filter(
            ({ target }) => target.ambiguities.length > 0,
          ).length,
          diagnosticProblems: assessment.problems.length,
        }),
      }),
      diagnosticAccuracy: Object.freeze({
        status: "not-evaluated",
        basis: "受控契约断言不是自然语料人工诊断标注。",
      }),
      candidateQuality: Object.freeze({
        status: "not-evaluated",
        basis: "受控候选用于契约断言，不构成采纳或精确率标签。",
      }),
    }),
    evidence: Object.freeze({
      source: "self-authored deterministic cases; no external data",
      languagePair: Object.freeze({
        sourceLanguage: "en",
        targetLanguage: "zh-CN",
      }),
      policies: Object.freeze({
        assessmentRules: Object.freeze([
          "require-allowed-translation",
          "reject-forbidden-translation",
        ]),
        matching: "public default language policies",
        discovery: Object.freeze({ maxWords: 1, minOccurrences: 2 }),
        paragraphDiscovery: Object.freeze({
          maxWords: 3,
          maxCharacters: 80,
          minOccurrences: 1,
          limit: 1_000,
        }),
        generatedDiscovery: Object.freeze({
          maxWords: 2,
          maxCharacters: 40,
          minOccurrences: 1,
          limit: 1_000,
        }),
      }),
      uiSamples: Object.freeze({
        refs: Object.freeze(["ui-allowed", "ui-forbidden", "ui-unicode-short"]),
        candidate: Object.freeze({
          text: candidate.text,
          occurrences: candidate.occurrences,
          entryCount: candidate.entryCount,
          examples: candidate.examples,
        }),
      }),
      paragraphSamples: Object.freeze({
        refs: Object.freeze(["paragraph-long", "paragraph-ambiguous"]),
        longExpressionRange: longMatch.range,
        ambiguityCount: ambiguity.length,
        discovery: Object.freeze({
          language: paragraphDiscoveryCorpus.language,
          status: paragraphDiscovery.status,
          statistics: paragraphDiscovery.statistics,
          selectedRefs: paragraphDiscoveryCorpus.entries.map(({ ref }) => ref),
          expectedCandidate: Object.freeze({
            text: paragraphCandidate.text,
            occurrences: paragraphCandidate.occurrences,
            range: paragraphCandidate.examples[0]!.range,
          }),
          excludedUiCandidate: Object.freeze({
            text: "workspace",
            present: excludedUiCandidate !== undefined,
          }),
        }),
      }),
      assessment: Object.freeze({
        status: assessment.status,
        problemCount: assessment.problems.length,
        problems: assessment.problems.map(
          ({ code, groupIndex, conceptId }) => ({
            code,
            groupIndex,
            conceptId,
          }),
        ),
        issueCount: assessment.issues.length,
        issues: assessment.issues.map(({ code, groupIndex, conceptId }) => ({
          code,
          groupIndex,
          conceptId,
        })),
      }),
      intervalRecognition: Object.freeze({
        completeGroups: analysis.groups.filter(
          ({ source, target }) =>
            source.status === "complete" && target.status === "complete",
        ).length,
        incompleteGroups: analysis.groups.filter(
          ({ source, target }) =>
            source.status !== "complete" || target.status !== "complete",
        ).length,
        unicodeSourceMatch: Object.freeze({
          text: unicodeMatch.text,
          range: unicodeMatch.range,
          expressionText: unicodeMatch.expressionText,
        }),
        longSourceMatch: Object.freeze({
          text: longMatch.text,
          range: longMatch.range,
          expressionText: longMatch.expressionText,
        }),
      }),
      discovery: Object.freeze({
        status: discovery.status,
        statistics: discovery.statistics,
        candidate,
      }),
      generated: Object.freeze({
        parameters: selectedGeneration,
        inputSha256: sha256(canonicalJson(generatedCorpus)),
        statistics: generatedDiscovery.statistics,
        topCandidates: Object.freeze(
          generatedDiscovery.candidates.slice(0, 10),
        ),
      }),
    }),
  });
}

export const emptyScenario = Object.freeze({
  execution: Object.freeze({ status: "not-executed" as const }),
  domain: Object.freeze({ status: "not-run" as const }),
  metrics: Object.freeze({}),
});
