import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  analyzeTermUse,
  assessTermUse,
  compileTerms,
  createTermbase,
  discoverTerms,
  type JsonValue,
  type TermAssessment,
  type TermAssessmentIssue,
  type TermMatch,
  type TermProblem,
  type TermRange,
  type TermRuleId,
  type TermMatches,
  type TermUseAnalysis,
  type TermDiscovery,
} from "@lioni/terminology";
import { z } from "zod";

import { termRuleIdSchema } from "#/assessment";
import { jsonValueSchema, nonemptyTextSchema } from "#/data";
import { discoveryParametersSchema, discoverySnapshot } from "#/discovery";
import { comparisonSnapshot, termRangeSchema } from "#/input";

import { canonicalJson, resolvePath, sha256 } from "./support/json.ts";

const precisionAtValues = [50, 100, 500] as const;
const discoveryParameterNames = [
  "maxWords",
  "maxCharacters",
  "minOccurrences",
  "limit",
] as const;

const discoveryOptionsSchema = discoveryParametersSchema
  .pick({
    maxWords: true,
    maxCharacters: true,
    minOccurrences: true,
    limit: true,
  })
  .partial();
type DiscoveryParameters = z.input<typeof discoveryOptionsSchema>;
const datasetMetadataSchema = z
  .object({
    id: nonemptyTextSchema,
    version: nonemptyTextSchema,
    reviewStatus: nonemptyTextSchema,
  })
  .readonly();
const discoveryReferenceSchema = z
  .object({
    id: nonemptyTextSchema,
    terms: z.array(nonemptyTextSchema).readonly(),
  })
  .readonly();
const discoveryDatasetSchema = z
  .object({
    schemaVersion: z.literal(1),
    dataset: datasetMetadataSchema,
    task: z.literal("discovery"),
    input: z.transform(discoverySnapshot),
    options: discoveryOptionsSchema.default({}),
    references: z
      .array(discoveryReferenceSchema)
      .min(1)
      .refine(
        (items) => new Set(items.map(({ id }) => id)).size === items.length,
        "参考答案身份不得重复。",
      )
      .readonly(),
  })
  .readonly();
type DiscoveryReference = z.infer<typeof discoveryReferenceSchema>;
type DiscoveryDataset = z.infer<typeof discoveryDatasetSchema>;
const qaMatchSchema = z
  .object({
    id: nonemptyTextSchema,
    groupIndex: z.int().nonnegative(),
    side: z.enum(["source", "target"]),
    certainty: z.enum(["certain", "ambiguous", "suppressed"]),
    conceptId: nonemptyTextSchema,
    expressionId: nonemptyTextSchema,
    language: nonemptyTextSchema,
    usage: z.enum(["preferred", "allowed", "forbidden"]),
    fragmentIndex: z.int().nonnegative(),
    ref: jsonValueSchema,
    range: termRangeSchema.refine(
      (range) => range.end > range.start,
      "区间必须非空。",
    ),
    text: nonemptyTextSchema,
    expressionText: nonemptyTextSchema,
    form: nonemptyTextSchema,
    policyId: nonemptyTextSchema,
  })
  .readonly();
type QaExpectedMatch = z.infer<typeof qaMatchSchema>;
type QaMatchSide = QaExpectedMatch["side"];
type QaMatchCertainty = QaExpectedMatch["certainty"];
const referenceIdsSchema = z
  .array(nonemptyTextSchema)
  .refine((ids) => new Set(ids).size === ids.length, "不得重复引用同一命中。")
  .readonly();
const qaProblemSchema = z
  .object({
    groupIndex: z.int().nonnegative(),
    conceptId: nonemptyTextSchema,
    ruleId: termRuleIdSchema,
    code: z.enum(["missing-allowed-translation", "forbidden-translation"]),
    sourceMatches: referenceIdsSchema,
    targetMatches: referenceIdsSchema,
  })
  .refine(
    (problem) =>
      problem.code ===
      (problem.ruleId === "require-allowed-translation"
        ? "missing-allowed-translation"
        : "forbidden-translation"),
    { message: "问题码与规则身份不匹配。", path: ["code"] },
  )
  .readonly();
const qaIssueSchema = z
  .object({
    groupIndex: z.int().nonnegative(),
    code: nonemptyTextSchema,
    conceptId: nonemptyTextSchema.exactOptional(),
    ruleId: termRuleIdSchema.exactOptional(),
  })
  .readonly();
type QaExpectedIssue = z.infer<typeof qaIssueSchema>;
const qaReferenceSchema = z
  .object({
    id: nonemptyTextSchema,
    matches: z.array(qaMatchSchema).readonly(),
    problems: z.array(qaProblemSchema).readonly(),
    issues: z.array(qaIssueSchema).readonly(),
  })
  .readonly();
type QaReference = z.infer<typeof qaReferenceSchema>;
const qaDatasetSchema = z
  .object({
    schemaVersion: z.literal(1),
    dataset: datasetMetadataSchema,
    task: z.literal("qa"),
    termbase: z.transform((value) => createTermbase(value).data),
    input: z.transform(comparisonSnapshot),
    options: z
      .object({
        rules: z
          .array(termRuleIdSchema)
          .transform((rules) => [...new Set(rules)])
          .readonly()
          .exactOptional(),
      })
      .default({}),
    references: z
      .array(qaReferenceSchema)
      .min(1)
      .refine(
        (items) => new Set(items.map(({ id }) => id)).size === items.length,
        "参考答案身份不得重复。",
      )
      .readonly(),
  })
  .readonly();
type QaDataset = z.infer<typeof qaDatasetSchema>;
type QualityDataset = DiscoveryDataset | QaDataset;

type QaMatch = Omit<QaExpectedMatch, "id">;

type QaMetric = {
  readonly predictedCount: number;
  readonly expectedCount: number;
  readonly hits: number;
  readonly falsePositives: number;
  readonly falseNegatives: number;
  readonly precision: number;
  readonly recall: number;
  readonly f1: number;
};

type QaQualityReport = {
  readonly schemaVersion: 1;
  readonly task: "qa";
  readonly dataset: QaDataset["dataset"];
  readonly input: {
    readonly sha256: string;
    readonly groupCount: number;
    readonly sourceFragmentCount: number;
    readonly targetFragmentCount: number;
  };
  readonly rules: readonly TermRuleId[];
  readonly scoring: {
    readonly matches: {
      readonly identity: readonly string[];
      readonly evidence: readonly string[];
    };
    readonly problems: {
      readonly identity: readonly string[];
      readonly evidence: readonly string[];
    };
    readonly issues: { readonly identity: readonly string[] };
    readonly emptySets: string;
    readonly sampleExactRate: string;
  };
  readonly output: {
    readonly status: TermAssessment["status"];
    readonly matches: readonly QaMatch[];
    readonly problems: readonly {
      readonly groupIndex: number;
      readonly conceptId: string;
      readonly ruleId: TermRuleId;
      readonly code: TermProblem["code"];
      readonly message: string;
      readonly sourceMatches: readonly QaMatch[];
      readonly targetMatches: readonly QaMatch[];
    }[];
    readonly issues: readonly TermAssessmentIssue[];
  };
  readonly references: readonly {
    readonly id: string;
    readonly matches: QaMetric & {
      readonly evidenceMismatches: number;
      readonly exactHits: number;
    };
    readonly problems: QaMetric & {
      readonly evidenceMismatches: number;
      readonly exactHits: number;
    };
    readonly issues: QaMetric;
    readonly sampleExactCount: number;
    readonly sampleCount: number;
    readonly sampleExactRate: number;
  }[];
};

type QualityCliOptions = {
  readonly inputPath?: string;
  readonly outputPath?: string;
  readonly parameters: Partial<DiscoveryParameters>;
};

/** 调用方必须且只能提供 dataset 对象或 inputPath 文件路径之一。 */
export type QualityEvaluationOptions =
  | {
      readonly dataset: unknown;
      readonly inputPath?: never;
      readonly outputPath?: string;
      readonly parameters?: Partial<DiscoveryParameters>;
    }
  | {
      readonly dataset?: never;
      readonly inputPath: string;
      readonly outputPath?: string;
      readonly parameters?: Partial<DiscoveryParameters>;
    };

function parseQaReferences(
  value: readonly QaReference[],
  groupCount: number,
): readonly QaReference[] {
  return Object.freeze(
    value.map((item) => {
      const { id, matches, problems, issues } = item;
      const matchIds = new Map<string, QaExpectedMatch>();
      const matchIdentities = new Set<string>();
      for (const match of matches) {
        if (match.groupIndex >= groupCount)
          throw new Error(
            `预期命中 ${match.id} 的 groupIndex 超出 input.groups。`,
          );
        if (matchIds.has(match.id))
          throw new Error(`参考答案命中身份重复：${match.id}`);
        const identity = qaMatchIdentity(match);
        if (matchIdentities.has(identity))
          throw new Error(`参考答案重复列出同一术语命中：${match.id}`);
        matchIdentities.add(identity);
        matchIds.set(match.id, match);
      }

      const problemIdentities = new Set<string>();
      for (const problem of problems) {
        if (problem.groupIndex >= groupCount)
          throw new Error("预期问题的 groupIndex 超出 input.groups。");
        const identity = qaProblemIdentity(problem);
        if (problemIdentities.has(identity))
          throw new Error("参考答案重复列出同一 QA 问题。");
        problemIdentities.add(identity);
        for (const matchId of problem.sourceMatches) {
          const match = matchIds.get(matchId);
          if (
            !match ||
            match.groupIndex !== problem.groupIndex ||
            match.side !== "source"
          )
            throw new Error(`${matchId} 不是此问题对应的原文命中。`);
        }
        for (const matchId of problem.targetMatches) {
          const match = matchIds.get(matchId);
          if (
            !match ||
            match.groupIndex !== problem.groupIndex ||
            match.side !== "target"
          )
            throw new Error(`${matchId} 不是此问题对应的译文命中。`);
        }
      }

      const issueIdentities = issues.map(qaIssueIdentity);
      if (new Set(issueIdentities).size !== issueIdentities.length)
        throw new Error("参考答案重复列出同一未完成原因。");
      if (issues.some((issue) => issue.groupIndex >= groupCount))
        throw new Error("预期未完成原因的 groupIndex 超出 input.groups。");

      return Object.freeze({
        id,
        matches: Object.freeze(matches),
        problems: Object.freeze(problems),
        issues: Object.freeze(issues),
      });
    }),
  );
}

function qaMatchIdentity(match: {
  readonly groupIndex: number;
  readonly side: QaMatchSide;
  readonly conceptId: string;
  readonly expressionId: string;
  readonly fragmentIndex: number;
  readonly ref: JsonValue;
  readonly range: TermRange;
}): string {
  // 身份决定是否找到同一命中；词面与政策证据另计，避免把证据偏差混成漏报。
  return canonicalJson([
    match.groupIndex,
    match.side,
    match.conceptId,
    match.expressionId,
    match.fragmentIndex,
    match.ref,
    match.range,
  ]);
}

function qaMatchEvidence(match: QaMatch | QaExpectedMatch): string {
  return canonicalJson([
    match.certainty,
    match.language,
    match.usage,
    match.text,
    match.expressionText,
    match.form,
    match.policyId,
  ]);
}

function qaProblemIdentity(problem: {
  readonly groupIndex: number;
  readonly conceptId: string;
  readonly ruleId: TermRuleId;
  readonly code: TermProblem["code"];
}): string {
  return canonicalJson([
    problem.groupIndex,
    problem.conceptId,
    problem.ruleId,
    problem.code,
  ]);
}

function qaIssueIdentity(issue: QaExpectedIssue | TermAssessmentIssue): string {
  return canonicalJson([
    issue.groupIndex,
    issue.conceptId ?? null,
    issue.ruleId ?? null,
    issue.code,
  ]);
}

function parseDataset(value: unknown): QualityDataset {
  const dataset = z
    .discriminatedUnion("task", [discoveryDatasetSchema, qaDatasetSchema])
    .parse(value);
  return dataset.task === "qa"
    ? {
        ...dataset,
        references: parseQaReferences(
          dataset.references,
          dataset.input.groups.length,
        ),
      }
    : dataset;
}

function parseArguments(args: readonly string[]): QualityCliOptions {
  let inputPath: string | undefined;
  let outputPath: string | undefined;
  const parameters: Partial<DiscoveryParameters> = {};
  const cliNames = new Map<string, (typeof discoveryParameterNames)[number]>([
    ["--max-words", "maxWords"],
    ["--max-characters", "maxCharacters"],
    ["--min-occurrences", "minOccurrences"],
    ["--limit", "limit"],
  ]);

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--input" || argument === "--output") {
      const value = nonemptyTextSchema.parse(args[++index]);
      if (argument === "--input") inputPath = value;
      else outputPath = value;
      continue;
    }
    const parameterName = cliNames.get(String(argument));
    if (parameterName !== undefined) {
      const value = z.coerce.number().int().parse(args[++index]);
      Object.assign(parameters, { [parameterName]: value });
      continue;
    }
    if (argument === "--help") {
      process.stdout.write(
        "用法：evaluation:quality --input <数据.json 或目录> [--output <报告.json 或目录>] [--max-words N] [--max-characters N] [--min-occurrences N] [--limit N]\n",
      );
      process.exitCode = 0;
      return Object.freeze({ parameters: Object.freeze({}) });
    }
    throw new Error(`未知质量评测参数：${String(argument)}`);
  }

  return Object.freeze({
    ...(inputPath === undefined ? {} : { inputPath }),
    ...(outputPath === undefined ? {} : { outputPath }),
    parameters: Object.freeze(parameters),
  });
}

function normalizeTerm(value: string): string {
  return value.normalize("NFC").replace(/\s+/gu, " ").trim().toLowerCase();
}

function uniqueTerms(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values.map(normalizeTerm))]);
}

function rankPredictions(candidates: TermDiscovery["candidates"]) {
  const unique = new Map<
    string,
    { readonly term: string; readonly candidate: (typeof candidates)[number] }
  >();
  for (const candidate of candidates) {
    const term = normalizeTerm(candidate.text);
    if (!unique.has(term)) unique.set(term, Object.freeze({ term, candidate }));
  }
  return Object.freeze([...unique.values()]);
}

function scoreReference(
  reference: DiscoveryReference,
  predictions: ReturnType<typeof rankPredictions>,
) {
  const predicted = Object.freeze(predictions.map(({ term }) => term));
  const expected = uniqueTerms(reference.terms);
  const expectedSet = new Set(expected);
  const hits = predicted.filter((term) => expectedSet.has(term)).length;
  const falsePositives = predicted.length - hits;
  const falseNegatives = expected.length - hits;
  const bothEmpty = predicted.length === 0 && expected.length === 0;
  const precision =
    predicted.length === 0 ? Number(bothEmpty) : hits / predicted.length;
  const recall =
    expected.length === 0 ? Number(bothEmpty) : hits / expected.length;
  const f1 =
    precision + recall === 0
      ? 0
      : (2 * precision * recall) / (precision + recall);
  const pAt = Object.fromEntries(
    precisionAtValues.map((k) => {
      const ranked = predicted.slice(0, k);
      const rankedHits = ranked.filter((term) => expectedSet.has(term)).length;
      return [
        String(k),
        Object.freeze({
          hits: rankedHits,
          precision: rankedHits / k,
          outputCount: ranked.length,
          denominator: k,
        }),
      ];
    }),
  );

  return Object.freeze({
    id: reference.id,
    rawTermCount: reference.terms.length,
    normalizedTermCount: expected.length,
    predictedTermCount: predicted.length,
    hits,
    falsePositives,
    falseNegatives,
    precision,
    recall,
    f1,
    pAt: Object.freeze(pAt),
  });
}

function formatScore(value: number): string {
  return value.toFixed(4);
}

type QualityReport = ReturnType<typeof createQualityReport> | QaQualityReport;

function qualitySummary(report: QualityReport): string {
  if (report.task === "qa") {
    const referenceLines = report.references.map(
      ({ id, matches, problems, issues, sampleExactRate }) =>
        `- ${id}：命中 P ${formatScore(matches.precision)} / R ${formatScore(matches.recall)} / F1 ${formatScore(matches.f1)}；QA 问题 P ${formatScore(problems.precision)} / R ${formatScore(problems.recall)} / F1 ${formatScore(problems.f1)}；未完成原因 P ${formatScore(issues.precision)} / R ${formatScore(issues.recall)} / F1 ${formatScore(issues.f1)}；样例精确率 ${formatScore(sampleExactRate)}`,
    );
    return [
      `术语 QA 评测：${report.dataset.id}@${report.dataset.version}（审阅状态 ${report.dataset.reviewStatus}；评测 ${report.output.status}）`,
      `输入：${report.input.groupCount} 组，原文 ${report.input.sourceFragmentCount} 个片段，译文 ${report.input.targetFragmentCount} 个片段；术语命中 ${report.output.matches.length} 条，QA 问题 ${report.output.problems.length} 条，未完成原因 ${report.output.issues.length} 条。`,
      "独立参考答案：",
      ...referenceLines,
    ].join("\n");
  }
  const referenceLines = report.references.map(
    ({ id, precision, recall, f1, pAt }) =>
      `- ${id}：P ${formatScore(precision)} / R ${formatScore(recall)} / F1 ${formatScore(f1)}；P@50 ${formatScore(pAt["50"]!.precision)}，P@100 ${formatScore(pAt["100"]!.precision)}，P@500 ${formatScore(pAt["500"]!.precision)}`,
  );
  const issueLines = report.output.issues.map(
    ({ code, message }) => `- 未完成原因 ${code}：${message}`,
  );
  return [
    `术语候选发现评测：${report.dataset.id}@${report.dataset.version}（审阅状态 ${report.dataset.reviewStatus}；评测 ${report.output.status}）`,
    `输入：${report.input.entryCount} 条，${report.input.fragmentCount} 个片段；计分候选 ${report.output.statistics.returnedCandidates} 条，正式接口输出 ${report.output.statistics.discoveryCandidates}/${report.output.statistics.eligibleCandidates}（规范化重复 ${report.output.statistics.normalizedDuplicates}）${report.output.truncated ? "（已截断）" : ""}`,
    "独立参考答案：",
    ...referenceLines,
    ...(issueLines.length === 0 ? [] : ["未完成原因：", ...issueLines]),
  ].join("\n");
}

function createQualityReport(
  dataset: DiscoveryDataset,
  inputSha256: string,
  parameters: DiscoveryParameters,
  discovery: TermDiscovery,
) {
  const predictions = rankPredictions(discovery.candidates);
  const references = dataset.references.map((reference) =>
    scoreReference(reference, predictions),
  );
  const fragmentCount = dataset.input.entries.reduce(
    (count, entry) => count + entry.fragments.length,
    0,
  );
  return Object.freeze({
    schemaVersion: 1,
    task: "discovery",
    dataset: dataset.dataset,
    input: Object.freeze({
      sha256: inputSha256,
      language: dataset.input.language,
      entryCount: dataset.input.entries.length,
      fragmentCount,
      complete: dataset.input.complete !== false,
    }),
    parameters: Object.freeze({
      ...parameters,
      normalization: "Unicode NFC；折叠空白；英文小写",
    }),
    scoring: Object.freeze({
      emptySets: "仅当预测集与参考集都为空时 P、R、F1 记 1；其余零分母记 0。",
      rankingDenominator:
        "排名分母固定为 K；候选不足 K 时 outputCount 报告实际可用数量。",
      predictionDeduplication: "规范化词面去重，保留首次发现排名",
      referenceDeduplication: "每套参考答案内的规范化词面只计一次",
    }),
    output: Object.freeze({
      status: discovery.status,
      truncated: discovery.statistics.omittedCandidates > 0,
      statistics: Object.freeze({
        ...discovery.statistics,
        discoveryCandidates: discovery.candidates.length,
        normalizedDuplicates: discovery.candidates.length - predictions.length,
        returnedCandidates: predictions.length,
      }),
      candidates: Object.freeze(
        predictions.map(({ term, candidate }, index) =>
          Object.freeze({
            rank: index + 1,
            text: candidate.text,
            normalizedTerm: term,
            occurrences: candidate.occurrences,
            entryCount: candidate.entryCount,
            ranking: candidate.ranking,
          }),
        ),
      ),
      issues: discovery.issues,
    }),
    references: Object.freeze(references),
  });
}

function projectQaMatch(
  groupIndex: number,
  side: QaMatchSide,
  match: TermMatch,
  matches: TermMatches,
): QaMatch {
  const certainty: QaMatchCertainty = matches.suppressed.some(
    ({ match: suppressed }) => suppressed === match,
  )
    ? "suppressed"
    : matches.certain.includes(match)
      ? "certain"
      : "ambiguous";
  return Object.freeze({
    groupIndex,
    side,
    certainty,
    conceptId: match.conceptId,
    expressionId: match.expressionId,
    language: match.language,
    usage: match.usage,
    fragmentIndex: match.fragmentIndex,
    ref: match.ref,
    range: match.range,
    text: match.text,
    expressionText: match.expressionText,
    form: match.form,
    policyId: match.policyId,
  });
}

function qaPredictions(analysis: TermUseAnalysis) {
  const matches = analysis.groups.flatMap((group, groupIndex) => [
    ...group.source.matches.map((match) =>
      projectQaMatch(groupIndex, "source", match, group.source),
    ),
    ...group.target.matches.map((match) =>
      projectQaMatch(groupIndex, "target", match, group.target),
    ),
  ]);
  const matchByIdentity = new Map(
    matches.map((match) => [qaMatchIdentity(match), match]),
  );
  return Object.freeze({ matches: Object.freeze(matches), matchByIdentity });
}

function predictionForProblemEvidence(
  groupIndex: number,
  side: QaMatchSide,
  match: TermMatch,
  analysis: TermUseAnalysis,
  matchByIdentity: ReadonlyMap<string, QaMatch>,
): QaMatch {
  const group = analysis.groups[groupIndex]!;
  const result = side === "source" ? group.source : group.target;
  const projected = projectQaMatch(groupIndex, side, match, result);
  return matchByIdentity.get(qaMatchIdentity(projected)) ?? projected;
}

function qaPredictionProblems(
  assessment: TermAssessment,
  analysis: TermUseAnalysis,
  matchByIdentity: ReadonlyMap<string, QaMatch>,
) {
  return Object.freeze(
    assessment.problems.map((problem) =>
      Object.freeze({
        groupIndex: problem.groupIndex,
        conceptId: problem.conceptId,
        ruleId: problem.ruleId,
        code: problem.code,
        message: problem.message,
        sourceMatches: Object.freeze(
          problem.sourceMatches.map((match) =>
            predictionForProblemEvidence(
              problem.groupIndex,
              "source",
              match,
              analysis,
              matchByIdentity,
            ),
          ),
        ),
        targetMatches: Object.freeze(
          problem.targetMatches.map((match) =>
            predictionForProblemEvidence(
              problem.groupIndex,
              "target",
              match,
              analysis,
              matchByIdentity,
            ),
          ),
        ),
      }),
    ),
  );
}

function scoreQaKeys(
  predicted: readonly string[],
  expected: readonly string[],
): QaMetric {
  const predictedSet = new Set(predicted);
  const expectedSet = new Set(expected);
  const hits = [...predictedSet].filter((key) => expectedSet.has(key)).length;
  const falsePositives = predictedSet.size - hits;
  const falseNegatives = expectedSet.size - hits;
  const bothEmpty = predictedSet.size === 0 && expectedSet.size === 0;
  const precision =
    predictedSet.size === 0 ? Number(bothEmpty) : hits / predictedSet.size;
  const recall =
    expectedSet.size === 0 ? Number(bothEmpty) : hits / expectedSet.size;
  const f1 =
    precision + recall === 0
      ? 0
      : (2 * precision * recall) / (precision + recall);
  return Object.freeze({
    predictedCount: predictedSet.size,
    expectedCount: expectedSet.size,
    hits,
    falsePositives,
    falseNegatives,
    precision,
    recall,
    f1,
  });
}

function sameKeySet(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((key, index) => key === sortedRight[index]);
}

function problemEvidence(problem: {
  readonly sourceMatches: readonly QaMatch[];
  readonly targetMatches: readonly QaMatch[];
}): string {
  return canonicalJson([
    problem.sourceMatches.map(qaMatchIdentity).sort(),
    problem.targetMatches.map(qaMatchIdentity).sort(),
  ]);
}

function scoreQaReference(
  reference: QaReference,
  predictedMatches: readonly QaMatch[],
  predictedProblems: QaQualityReport["output"]["problems"],
  predictedIssues: readonly TermAssessmentIssue[],
  groupCount: number,
) {
  const predictedMatchByIdentity = new Map(
    predictedMatches.map((match) => [qaMatchIdentity(match), match]),
  );
  const expectedMatchByIdentity = new Map(
    reference.matches.map((match) => [qaMatchIdentity(match), match]),
  );
  const matchMetric = scoreQaKeys(
    [...predictedMatchByIdentity.keys()],
    [...expectedMatchByIdentity.keys()],
  );
  const matchEvidenceMismatches = [...expectedMatchByIdentity.keys()].filter(
    (identity) => {
      const actual = predictedMatchByIdentity.get(identity);
      const expected = expectedMatchByIdentity.get(identity);
      return (
        actual !== undefined &&
        expected !== undefined &&
        qaMatchEvidence(actual) !== qaMatchEvidence(expected)
      );
    },
  ).length;

  const expectedMatchIdToIdentity = new Map(
    reference.matches.map((match) => [match.id, qaMatchIdentity(match)]),
  );
  const expectedProblems = reference.problems.map((problem) => ({
    groupIndex: problem.groupIndex,
    identity: qaProblemIdentity(problem),
    evidence: canonicalJson([
      problem.sourceMatches
        .map((id) => expectedMatchIdToIdentity.get(id)!)
        .sort(),
      problem.targetMatches
        .map((id) => expectedMatchIdToIdentity.get(id)!)
        .sort(),
    ]),
  }));
  const actualProblems = predictedProblems.map((problem) => ({
    groupIndex: problem.groupIndex,
    identity: qaProblemIdentity(problem),
    evidence: problemEvidence(problem),
  }));
  const problemMetric = scoreQaKeys(
    actualProblems.map(({ identity }) => identity),
    expectedProblems.map(({ identity }) => identity),
  );
  const actualProblemByIdentity = new Map(
    actualProblems.map((problem) => [problem.identity, problem]),
  );
  const expectedProblemByIdentity = new Map(
    expectedProblems.map((problem) => [problem.identity, problem]),
  );
  const problemEvidenceMismatches = [
    ...expectedProblemByIdentity.keys(),
  ].filter((identity) => {
    const actual = actualProblemByIdentity.get(identity);
    const expected = expectedProblemByIdentity.get(identity);
    return (
      actual !== undefined &&
      expected !== undefined &&
      actual.evidence !== expected.evidence
    );
  }).length;
  const issueMetric = scoreQaKeys(
    predictedIssues.map(qaIssueIdentity),
    reference.issues.map(qaIssueIdentity),
  );

  let sampleExactCount = 0;
  for (let groupIndex = 0; groupIndex < groupCount; groupIndex += 1) {
    const expectedGroupMatches = reference.matches
      .filter((match) => match.groupIndex === groupIndex)
      .map((match) =>
        canonicalJson([qaMatchIdentity(match), qaMatchEvidence(match)]),
      );
    const actualGroupMatches = predictedMatches
      .filter((match) => match.groupIndex === groupIndex)
      .map((match) =>
        canonicalJson([qaMatchIdentity(match), qaMatchEvidence(match)]),
      );
    const expectedGroupProblems = expectedProblems
      .filter((problem) => problem.groupIndex === groupIndex)
      .map(({ identity, evidence }) => canonicalJson([identity, evidence]));
    const actualGroupProblems = actualProblems
      .filter((problem) => problem.groupIndex === groupIndex)
      .map(({ identity, evidence }) => canonicalJson([identity, evidence]));
    const expectedGroupIssues = reference.issues
      .filter((issue) => issue.groupIndex === groupIndex)
      .map(qaIssueIdentity);
    const actualGroupIssues = predictedIssues
      .filter((issue) => issue.groupIndex === groupIndex)
      .map(qaIssueIdentity);
    if (
      sameKeySet(expectedGroupMatches, actualGroupMatches) &&
      sameKeySet(expectedGroupProblems, actualGroupProblems) &&
      sameKeySet(expectedGroupIssues, actualGroupIssues)
    )
      sampleExactCount += 1;
  }

  return Object.freeze({
    id: reference.id,
    matches: Object.freeze({
      ...matchMetric,
      evidenceMismatches: matchEvidenceMismatches,
      exactHits: matchMetric.hits - matchEvidenceMismatches,
    }),
    problems: Object.freeze({
      ...problemMetric,
      evidenceMismatches: problemEvidenceMismatches,
      exactHits: problemMetric.hits - problemEvidenceMismatches,
    }),
    issues: issueMetric,
    sampleExactCount,
    sampleCount: groupCount,
    sampleExactRate: groupCount === 0 ? 1 : sampleExactCount / groupCount,
  });
}

async function createQaQualityReport(
  dataset: QaDataset,
  inputSha256: string,
): Promise<QaQualityReport> {
  const terms = compileTerms(createTermbase(dataset.termbase));
  const analysis = await analyzeTermUse(terms, dataset.input);
  const rules = Object.freeze([
    ...(dataset.options.rules ?? [
      "require-allowed-translation" as const,
      "reject-forbidden-translation" as const,
    ]),
  ]);
  const assessment = assessTermUse(dataset.input, analysis, {
    rules: rules.map((id) => ({ id })),
  });
  const predictions = qaPredictions(analysis);
  const problems = qaPredictionProblems(
    assessment,
    analysis,
    predictions.matchByIdentity,
  );
  const references = dataset.references.map((reference) =>
    scoreQaReference(
      reference,
      predictions.matches,
      problems,
      assessment.issues,
      analysis.input.groups.length,
    ),
  );
  const sourceFragmentCount = analysis.input.groups.reduce(
    (count, group) => count + group.source.fragments.length,
    0,
  );
  const targetFragmentCount = analysis.input.groups.reduce(
    (count, group) => count + group.target.fragments.length,
    0,
  );
  return Object.freeze({
    schemaVersion: 1,
    task: "qa",
    dataset: dataset.dataset,
    input: Object.freeze({
      sha256: inputSha256,
      groupCount: analysis.input.groups.length,
      sourceFragmentCount,
      targetFragmentCount,
    }),
    rules,
    scoring: Object.freeze({
      matches: Object.freeze({
        identity: Object.freeze([
          "groupIndex",
          "side",
          "conceptId",
          "expressionId",
          "fragmentIndex",
          "ref",
          "range",
        ]),
        evidence: Object.freeze([
          "certainty",
          "language",
          "usage",
          "text",
          "expressionText",
          "form",
          "policyId",
        ]),
      }),
      problems: Object.freeze({
        identity: Object.freeze(["groupIndex", "conceptId", "ruleId", "code"]),
        evidence: Object.freeze(["sourceMatches", "targetMatches"]),
      }),
      issues: Object.freeze({
        identity: Object.freeze(["groupIndex", "conceptId", "ruleId", "code"]),
      }),
      emptySets:
        "仅当预测集与参考集都为空时，精确率、召回率和 F1 记 1；其余零分母记 0。",
      sampleExactRate:
        "同一组的命中身份与证据、QA 问题身份与证据及未完成原因全部一致的组数除以输入组数。",
    }),
    output: Object.freeze({
      status: assessment.status,
      matches: predictions.matches,
      problems,
      issues: assessment.issues,
    }),
    references: Object.freeze(references),
  });
}

async function loadDataset(filename: string) {
  let raw: Buffer;
  try {
    raw = await readFile(filename);
  } catch (error) {
    throw new Error(`无法读取评测输入：${filename}`, { cause: error });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8")) as unknown;
  } catch (error) {
    throw new Error(`评测输入不是有效 JSON：${filename}`, { cause: error });
  }
  return Object.freeze({
    dataset: parseDataset(parsed),
    inputSha256: sha256(raw),
  });
}

async function writeReport(filename: string, report: unknown): Promise<void> {
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

async function collectJsonInputs(
  directory: string,
): Promise<readonly string[]> {
  const filenames: string[] = [];
  const visit = async (currentDirectory: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(currentDirectory, { withFileTypes: true });
    } catch (error) {
      throw new Error(`无法读取评测输入目录：${currentDirectory}`, {
        cause: error,
      });
    }
    for (const entry of entries) {
      const filename = path.join(currentDirectory, entry.name);
      if (entry.isDirectory()) await visit(filename);
      else if (entry.isFile() && path.extname(entry.name) === ".json")
        filenames.push(filename);
    }
  };

  await visit(directory);
  filenames.sort((left, right) => {
    const leftRelative = path.relative(directory, left);
    const rightRelative = path.relative(directory, right);
    return leftRelative < rightRelative
      ? -1
      : leftRelative > rightRelative
        ? 1
        : 0;
  });
  if (filenames.length === 0)
    throw new Error(`评测输入目录中没有 JSON 文件：${directory}`);
  return Object.freeze(filenames);
}

function isSameOrInsideDirectory(
  directory: string,
  candidate: string,
): boolean {
  const relative = path.relative(directory, candidate);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`))
  );
}

/**
 * 通过显式数据对象或 JSON 文件评测候选发现、术语 QA 数据。
 * 提供 outputPath 时写入机器可读报告；调用方负责安排持久位置。
 */
export async function runQualityEvaluation(
  options: QualityEvaluationOptions,
): Promise<QualityReport> {
  if (options === undefined)
    throw new Error("必须显式提供 dataset 或 inputPath。");
  if (options.dataset === undefined && options.inputPath === undefined)
    throw new Error("必须显式提供 dataset 或 inputPath。");
  if (options.dataset !== undefined && options.inputPath !== undefined)
    throw new Error("dataset 与 inputPath 只能指定其中一项。");
  const loaded =
    options.dataset === undefined
      ? await loadDataset(resolvePath(process.cwd(), options.inputPath!))
      : Object.freeze({
          dataset: parseDataset(options.dataset),
          inputSha256: sha256(canonicalJson(options.dataset)),
        });
  const { dataset, inputSha256 } = loaded;
  if (dataset.task === "qa") {
    const report = await createQaQualityReport(dataset, inputSha256);
    if (options.outputPath !== undefined)
      await writeReport(resolvePath(process.cwd(), options.outputPath), report);
    return report;
  }
  const parameterOverrides = options.parameters ?? {};
  const parameters = Object.freeze({
    maxWords: parameterOverrides.maxWords ?? dataset.options.maxWords ?? 3,
    maxCharacters:
      parameterOverrides.maxCharacters ?? dataset.options.maxCharacters ?? 80,
    minOccurrences:
      parameterOverrides.minOccurrences ?? dataset.options.minOccurrences ?? 1,
    limit: parameterOverrides.limit ?? dataset.options.limit ?? 100,
  });
  const discovery = await discoverTerms(dataset.input, parameters);
  const report = createQualityReport(
    dataset,
    inputSha256,
    parameters,
    discovery,
  );
  if (options.outputPath !== undefined)
    await writeReport(resolvePath(process.cwd(), options.outputPath), report);
  return report;
}

async function runQuality(options: QualityCliOptions): Promise<void> {
  if (options.inputPath === undefined)
    throw new Error("必须通过 --input 显式指定评测数据文件或目录。");
  const inputPath = resolvePath(process.cwd(), options.inputPath);
  let inputInfo;
  try {
    inputInfo = await stat(inputPath);
  } catch (error) {
    throw new Error(`无法读取评测输入：${inputPath}`, { cause: error });
  }

  if (inputInfo.isDirectory()) {
    if (options.outputPath === undefined)
      throw new Error("--input 为目录时，必须通过 --output 显式指定报告目录。");
    const outputDirectory = resolvePath(process.cwd(), options.outputPath);
    if (
      isSameOrInsideDirectory(inputPath, outputDirectory) ||
      isSameOrInsideDirectory(outputDirectory, inputPath)
    )
      throw new Error("输入目录与报告目录不能相同或相互包含。");
    const inputFiles = await collectJsonInputs(inputPath);
    for (const filename of inputFiles) {
      const relativeInputPath = path.relative(inputPath, filename);
      const outputFile = path.join(outputDirectory, relativeInputPath);
      const report = await runQualityEvaluation({
        inputPath: filename,
        outputPath: outputFile,
        parameters: options.parameters,
      });
      process.stdout.write(
        `${qualitySummary(report)}\n报告 JSON：${outputFile}\n`,
      );
      if (report.output.status !== "complete") process.exitCode = 1;
    }
    return;
  }
  if (!inputInfo.isFile())
    throw new Error(`评测输入必须是 JSON 文件或目录：${inputPath}`);

  const report = await runQualityEvaluation({
    inputPath,
    ...(options.outputPath === undefined
      ? {}
      : { outputPath: options.outputPath }),
    parameters: options.parameters,
  });
  const summary = qualitySummary(report);
  if (options.outputPath === undefined) {
    process.stderr.write(`${summary}\n`);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    const outputPath = resolvePath(process.cwd(), options.outputPath);
    process.stdout.write(`${summary}\n报告 JSON：${outputPath}\n`);
  }
  if (report.output.status !== "complete") process.exitCode = 1;
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  if (process.exitCode === 0) return;
  await runQuality(options);
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `术语质量评测失败：${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
