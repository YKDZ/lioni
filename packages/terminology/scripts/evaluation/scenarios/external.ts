import { createMemoScope } from "@lioni/memo";
import {
  compileTerms,
  createTermbase,
  discoverTerms,
  analyzeTermUse,
  assessTermUse,
  type TermCandidate,
  type TermCorpusEntry,
  type TermComparisonInput,
  type TermDiscovery,
  type TermDiscoveryCorpus,
  type TermUseAnalysis,
} from "@lioni/terminology";

import type { CfpaPreparedInput, TextFacts } from "../corpora/convert.ts";
import { contentTypeSelection } from "../corpora/manifest.ts";
import type { ScenarioReport } from "../support/types.ts";

type DiscoverySummary = {
  readonly status: "complete" | "incomplete";
  readonly statistics: TermDiscovery["statistics"];
  readonly issueCount: number;
  readonly issues: TermDiscovery["issues"];
  readonly topCandidates: readonly TermCandidate[];
};

type TextGroupSummary = {
  readonly facts: TextFacts;
  readonly status: "complete" | "incomplete";
  readonly statistics: TermDiscovery["statistics"];
  readonly issueCount: number;
  readonly issues: TermDiscovery["issues"];
  readonly topCandidates: readonly TermCandidate[];
  readonly selectedKeys?: readonly string[];
  readonly missingKeys?: readonly string[];
  readonly referenceOverlap?: ReturnType<typeof referenceOverlap>;
};

const candidatePolicy = Object.freeze({
  maxWords: 3,
  maxCharacters: 80,
  minOccurrences: 2,
  limit: 100_000,
  maxExamples: 2,
});
const sampleCandidatePolicy = Object.freeze({
  ...candidatePolicy,
  minOccurrences: 1,
  limit: 1_000,
  maxExamples: 1,
});
const cfpaLanguagePair = Object.freeze({
  sourceLanguage: "en",
  targetLanguage: "zh-CN",
});

function candidatesFacts(entries: readonly TermCorpusEntry[]): TextFacts {
  const texts = entries.map(({ fragments }) => fragments[0]?.text ?? "");
  const nonEmpty = texts.filter((text) => text.trim() !== "");
  return Object.freeze({
    entries: entries.length,
    nonEmptyEntries: nonEmpty.length,
    distinctNonEmptyValues: new Set(nonEmpty).size,
    codepoints: texts.reduce((sum, text) => sum + Array.from(text).length, 0),
    utf16Units: texts.reduce((sum, text) => sum + text.length, 0),
  });
}

function summarizeDiscovery(result: TermDiscovery): DiscoverySummary {
  return Object.freeze({
    status: result.status,
    statistics: result.statistics,
    issueCount: result.issues.length,
    issues: Object.freeze(result.issues.slice(0, 20)),
    topCandidates: Object.freeze(result.candidates.slice(0, 20)),
  });
}

function entriesForKeys(
  corpus: TermDiscoveryCorpus,
  keys: readonly string[],
): {
  readonly entries: readonly TermCorpusEntry[];
  readonly missing: readonly string[];
} {
  const selected = new Set(keys);
  const entries = corpus.entries.filter(
    ({ ref }) => typeof ref === "string" && selected.has(ref),
  );
  const found = new Set(
    entries.flatMap(({ ref }) => (typeof ref === "string" ? [ref] : [])),
  );
  return Object.freeze({
    entries: Object.freeze(entries),
    missing: Object.freeze(keys.filter((key) => !found.has(key))),
  });
}

async function analyzeContentType(
  corpus: TermDiscoveryCorpus,
  keys: readonly string[],
  memo: ReturnType<typeof createMemoScope>,
  references?: readonly string[],
): Promise<TextGroupSummary> {
  const { entries, missing } = entriesForKeys(corpus, keys);
  const subset: TermDiscoveryCorpus = Object.freeze({
    language: corpus.language,
    entries,
  });
  const result = await discoverTerms(subset, {
    ...sampleCandidatePolicy,
    memo,
  });
  return Object.freeze({
    facts: candidatesFacts(entries),
    status: result.status,
    statistics: result.statistics,
    issueCount: result.issues.length,
    issues: Object.freeze(result.issues.slice(0, 20)),
    topCandidates: Object.freeze(result.candidates.slice(0, 20)),
    selectedKeys: Object.freeze([...keys]),
    missingKeys: missing,
    ...(references === undefined
      ? {}
      : {
          referenceOverlap: referenceOverlap(
            result.candidates,
            references,
            result.statistics,
          ),
        }),
  });
}

function countCodes(
  values: readonly { readonly code: string }[],
): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const { code } of values) counts[code] = (counts[code] ?? 0) + 1;
  return Object.freeze(counts);
}

function referenceExpressions(
  input: CfpaPreparedInput,
  language: string,
): readonly string[] | undefined {
  if (language !== "en" && language !== "zh-CN") return undefined;
  return Object.freeze(
    input.referenceTermbase.concepts.flatMap((concept) =>
      concept.languages
        .filter(
          ({ language: candidateLanguage }) => candidateLanguage === language,
        )
        .flatMap(({ expressions }) =>
          expressions.map(({ text }) => text.normalize("NFC")),
        ),
    ),
  );
}

function referenceTableFacts(input: CfpaPreparedInput) {
  const english = new Set<string>();
  const chineseSlots: string[] = [];
  for (const concept of input.referenceTermbase.concepts) {
    for (const language of concept.languages) {
      if (language.language === "en")
        for (const expression of language.expressions)
          english.add(expression.text);
      else if (language.language === "zh-CN")
        chineseSlots.push(...language.expressions.map(({ text }) => text));
    }
  }
  return Object.freeze({
    tableRows: input.facts.termTableRows,
    uniqueEnglishReferenceStrings: english.size,
    chineseExpressionSlots: chineseSlots.length,
    uniqueChineseReferenceStrings: new Set(chineseSlots).size,
    semanticConceptCount: "not-evaluated" as const,
  });
}

function referenceOverlap(
  allCandidates: readonly TermCandidate[],
  references: readonly string[] | undefined,
  candidatePool?: TermDiscovery["statistics"],
): {
  readonly status: "evaluated" | "not-evaluated";
  readonly basis: string;
  readonly value?: {
    readonly uniqueReferenceExpressions: number;
    readonly candidatePool?: {
      readonly distinctCandidates: number;
      readonly eligibleCandidates: number;
      readonly returnedCandidates: number;
      readonly omittedCandidates: number;
    };
    readonly matchedCandidateTexts: number;
    readonly topTwentyMatches: readonly string[];
  };
} {
  if (references === undefined)
    return Object.freeze({
      status: "not-evaluated",
      basis: "没有该语言的固定参考词表。",
    });
  const referenceSet = new Set(references.map((text) => text.normalize("NFC")));
  const matched = allCandidates
    .map(({ text }) => ({ text, normalized: text.normalize("NFC") }))
    .filter(({ normalized }) => referenceSet.has(normalized));
  return Object.freeze({
    status: "evaluated",
    basis:
      "与 CFPA 开集术语表做 NFC 后精确文字重合；非精确率、召回率或正确性标签。",
    value: Object.freeze({
      uniqueReferenceExpressions: referenceSet.size,
      ...(candidatePool === undefined
        ? {}
        : {
            candidatePool: Object.freeze({
              distinctCandidates: candidatePool.distinctCandidates,
              eligibleCandidates: candidatePool.eligibleCandidates,
              returnedCandidates: allCandidates.length,
              omittedCandidates: candidatePool.omittedCandidates,
            }),
          }),
      matchedCandidateTexts: new Set(matched.map(({ text }) => text)).size,
      topTwentyMatches: Object.freeze(
        matched.slice(0, 20).map(({ text }) => text),
      ),
    }),
  });
}

function summarizeIntervalRecognition(termUse: TermUseAnalysis) {
  const intervalGroups = termUse.groups.map((group, groupIndex) => {
    const inputGroup = termUse.input.groups[groupIndex];
    return {
      groupIndex,
      ...(inputGroup?.ref === undefined ? {} : { ref: inputGroup.ref }),
      sourceStatus: group.source.status,
      sourceMatches: group.source.certain.map((match) => ({
        conceptId: match.conceptId,
        expressionId: match.expressionId,
        fragmentIndex: match.fragmentIndex,
        ref: match.ref,
        range: match.range,
        text: match.text,
      })),
      sourceAmbiguityCount: group.source.ambiguities.length,
      targetStatus: group.target.status,
      targetMatches: group.target.certain.map((match) => ({
        conceptId: match.conceptId,
        expressionId: match.expressionId,
        fragmentIndex: match.fragmentIndex,
        ref: match.ref,
        range: match.range,
        text: match.text,
      })),
      targetAmbiguityCount: group.target.ambiguities.length,
    };
  });
  const sourceMatches = intervalGroups.flatMap(
    ({ sourceMatches: matches }) => matches,
  );
  const targetMatches = intervalGroups.flatMap(
    ({ targetMatches: matches }) => matches,
  );
  const sourceAmbiguities = intervalGroups.reduce(
    (sum, group) => sum + group.sourceAmbiguityCount,
    0,
  );
  const targetAmbiguities = intervalGroups.reduce(
    (sum, group) => sum + group.targetAmbiguityCount,
    0,
  );
  const noMatchExample = intervalGroups.find(
    (group) =>
      group.sourceMatches.length === 0 &&
      group.targetMatches.length === 0 &&
      group.sourceAmbiguityCount === 0 &&
      group.targetAmbiguityCount === 0,
  );
  const observedExamples = intervalGroups
    .filter(
      (group) =>
        group.sourceMatches.length > 0 ||
        group.targetMatches.length > 0 ||
        group.sourceAmbiguityCount > 0 ||
        group.targetAmbiguityCount > 0,
    )
    .slice(0, noMatchExample === undefined ? 20 : 19);
  return Object.freeze({
    languagePair: cfpaLanguagePair,
    status: termUse.groups.every(
      ({ source, target }) =>
        source.status === "complete" && target.status === "complete",
    )
      ? "complete"
      : "incomplete",
    comparisonGroups: termUse.groups.length,
    sourceCertainMatchCount: sourceMatches.length,
    targetCertainMatchCount: targetMatches.length,
    sourceAmbiguityCount: sourceAmbiguities,
    targetAmbiguityCount: targetAmbiguities,
    sourceIssueCount: termUse.groups.reduce(
      (sum, group) => sum + group.source.issues.length,
      0,
    ),
    targetIssueCount: termUse.groups.reduce(
      (sum, group) => sum + group.target.issues.length,
      0,
    ),
    sample: Object.freeze([
      ...(noMatchExample === undefined ? [] : [noMatchExample]),
      ...observedExamples,
    ]),
  });
}

function summarizeTermAssessment(
  comparison: TermComparisonInput,
  assessment: ReturnType<typeof assessTermUse>,
) {
  const topProblems = assessment.problems.slice(0, 20).map((problem) => ({
    code: problem.code,
    groupIndex: problem.groupIndex,
    groupRef: comparison.groups[problem.groupIndex]?.ref,
    conceptId: problem.conceptId,
    sourceMatches: problem.sourceMatches.map(
      ({ text, range, expressionText }) => ({ text, range, expressionText }),
    ),
    targetMatches: problem.targetMatches.map(
      ({ text, range, expressionText }) => ({ text, range, expressionText }),
    ),
  }));
  return Object.freeze({
    languagePair: cfpaLanguagePair,
    status: assessment.status,
    comparisonGroups: comparison.groups.length,
    problemCount: assessment.problems.length,
    problemCodes: countCodes(assessment.problems),
    issueCount: assessment.issues.length,
    issueCodes: countCodes(assessment.issues),
    topProblems: Object.freeze(topProblems),
    metrics: Object.freeze({
      accuracy: "not-evaluated",
      reason:
        "每个表行映射为一个临时参考记录，原始翻译不作正确性标签；没有适用范围和人工复核。",
    }),
  });
}

async function analyzeCfpaContentType(
  name: "ui" | "paragraph",
  selectedKeys: readonly string[],
  terms: ReturnType<typeof compileTerms>,
  comparison: TermComparisonInput,
  memo: ReturnType<typeof createMemoScope>,
) {
  const selectedKeySet = new Set(selectedKeys);
  const groups = comparison.groups.filter(
    ({ ref }) => typeof ref === "string" && selectedKeySet.has(ref),
  );
  const matchedKeys = new Set(groups.map(({ ref }) => ref as string));
  const selectedComparison = Object.freeze({ groups: Object.freeze(groups) });
  const termUse = await analyzeTermUse(terms, selectedComparison, { memo });
  const assessment = assessTermUse(selectedComparison, termUse);
  return Object.freeze({
    selection: Object.freeze({
      name,
      selectedKeys,
      requestedKeyCount: selectedKeys.length,
      matchedComparisonGroups: groups.length,
      missingKeys: Object.freeze(
        selectedKeys.filter((key) => !matchedKeys.has(key)),
      ),
    }),
    assessment: summarizeTermAssessment(selectedComparison, assessment),
    intervalRecognition: summarizeIntervalRecognition(termUse),
  });
}

export async function runCfpaScenario(
  input: CfpaPreparedInput,
  inputSha256: string,
): Promise<ScenarioReport> {
  const memo = createMemoScope();
  try {
    const languages: Record<string, unknown> = {};
    let incomplete = false;
    for (const language of ["en", "zh-CN", "ja"]) {
      const corpus = input.corpora[language]!;
      const fullResult = await discoverTerms(corpus, {
        ...candidatePolicy,
        memo,
      });
      const references = referenceExpressions(input, language);
      const ui = await analyzeContentType(
        corpus,
        contentTypeSelection.cfpa.ui,
        memo,
        references,
      );
      const paragraph = await analyzeContentType(
        corpus,
        contentTypeSelection.cfpa.paragraph,
        memo,
        references,
      );
      incomplete ||=
        fullResult.status === "incomplete" ||
        ui.status === "incomplete" ||
        paragraph.status === "incomplete";
      languages[language] = Object.freeze({
        facts: input.facts.textByLanguage[language],
        full: summarizeDiscovery(fullResult),
        contentTypes: Object.freeze({ ui, paragraph }),
        referenceOverlap: referenceOverlap(
          fullResult.candidates,
          references,
          fullResult.statistics,
        ),
        metrics: Object.freeze({
          candidateQuality: Object.freeze({
            status: "not-evaluated",
            basis: "自然语料没有独立人工候选标签；未将开集词表外项目当作假阳。",
          }),
          precision: Object.freeze({
            status: "not-evaluated",
            basis: "缺少独立人工真值标签。",
          }),
          recall: Object.freeze({
            status: "not-evaluated",
            basis: "开集参考词表不完整，且没有逐项人工正例标注。",
          }),
        }),
      });
    }

    const terms = compileTerms(createTermbase(input.referenceTermbase));
    const termUse = await analyzeTermUse(terms, input.comparison, { memo });
    const assessment = assessTermUse(input.comparison, termUse);
    const contentTypeAnalysis = Object.freeze({
      languagePair: cfpaLanguagePair,
      ui: await analyzeCfpaContentType(
        "ui",
        contentTypeSelection.cfpa.ui,
        terms,
        input.comparison,
        memo,
      ),
      paragraph: await analyzeCfpaContentType(
        "paragraph",
        contentTypeSelection.cfpa.paragraph,
        terms,
        input.comparison,
        memo,
      ),
    });
    incomplete ||=
      assessment.status === "incomplete" ||
      contentTypeAnalysis.ui.assessment.status === "incomplete" ||
      contentTypeAnalysis.paragraph.assessment.status === "incomplete" ||
      contentTypeAnalysis.ui.intervalRecognition.status === "incomplete" ||
      contentTypeAnalysis.paragraph.intervalRecognition.status === "incomplete";
    return Object.freeze({
      execution: Object.freeze({ status: "passed" }),
      domain: Object.freeze({ status: incomplete ? "incomplete" : "complete" }),
      inputSha256,
      metrics: Object.freeze({
        candidatePrecision: Object.freeze({
          status: "not-evaluated",
          basis: "CFPA 文本缺少 Lioni 的候选人工标注。",
        }),
        diagnosticAccuracy: Object.freeze({
          status: "not-evaluated",
          basis: "原始译文与转换后的开集术语表均不是诊断金标。",
        }),
        referenceOverlap: Object.freeze({
          status: "evaluated",
          basis: "仅报告各语言 exact/NFC 文字重合，不声称语义正确。",
          value: Object.freeze({
            en: languages.en,
            "zh-CN": languages["zh-CN"],
            ja: languages.ja,
          }),
        }),
      }),
      evidence: Object.freeze({
        source: input.source,
        converterVersion: input.source.converterVersion,
        inputSha256,
        selections: input.selections,
        policies: Object.freeze({
          candidateDiscovery: candidatePolicy,
          selectedContentTypeDiscovery: sampleCandidatePolicy,
          referenceMatching:
            "NFC then exact text equality; overlap only, not quality labels",
          termReference:
            "each upstream table row becomes a separate exploratory record",
          assessmentRules: Object.freeze([
            "require-allowed-translation",
            "reject-forbidden-translation",
          ]),
          termMatching: "public default per-language matching policies",
          termReferenceLanguagePair: cfpaLanguagePair,
          termReferenceScope:
            "English source compared with simplified Chinese; does not infer Japanese term quality",
        }),
        workload: Object.freeze({
          textByLanguage: input.facts.textByLanguage,
          comparisonGroups: input.comparison.groups.length,
          referenceTableRows: input.facts.termTableRows,
          referenceTerms: referenceTableFacts(input),
          convertedExpressionRecords: input.facts.convertedExpressionRecords,
          semanticConceptCount: "not-evaluated",
          missingChineseTargets: input.facts.missingChineseTargets,
        }),
        termReferenceRun: summarizeTermAssessment(input.comparison, assessment),
        intervalRecognition: summarizeIntervalRecognition(termUse),
        contentTypeAnalysis,
        languages: Object.freeze(languages),
      }),
    });
  } finally {
    memo.dispose();
  }
}
