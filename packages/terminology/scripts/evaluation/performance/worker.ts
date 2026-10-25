import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { createMemoScope, type MemoScope } from "@lioni/memo";
import {
  analyzeTermUse,
  assessTermUse,
  compileTerms,
  createTermbase,
  defaultTermMatchingPolicy,
  discoverTerms,
  evaluateTerms,
  type TermAssessment,
  type TermMatches,
  type TermUseAnalysis,
} from "@lioni/terminology";

import { canonicalJson, sha256 } from "../support/json.ts";
import {
  performanceDiscoveryPolicy,
  type PerformancePreparedInput,
} from "./workload.ts";
import type { PerformanceMemoMode } from "./workload.ts";

export type PerformancePhase = {
  readonly durationMs: number;
  readonly memory: {
    readonly gcBeforeRequested: boolean;
    readonly before: NodeJS.MemoryUsage;
    readonly after: NodeJS.MemoryUsage;
  };
  readonly output: Readonly<Record<string, unknown>>;
  readonly memo: {
    readonly mode: PerformanceMemoMode | "not-used";
    readonly prewarmDurationMs: number | null;
    readonly prewarmOutputSha256: string | null;
  };
};

export type PerformanceWorkerResult = {
  readonly schemaVersion: 1;
  readonly scenario: string;
  readonly sampleIndex: number;
  readonly memoMode: PerformanceMemoMode;
  readonly publicEntries: Readonly<Record<string, string>>;
  readonly runtimeWarmup: {
    readonly memoMode: "no-memo";
    readonly groups: number;
    readonly discoveryEntries: number;
    readonly phases: readonly string[];
  };
  readonly facts: PerformancePreparedInput["facts"];
  readonly phases: Readonly<{
    readonly termbaseCreate: PerformancePhase;
    readonly compileTerms: PerformancePhase;
    readonly analyzeTermUse: PerformancePhase;
    readonly assessTermUse: PerformancePhase;
    readonly discoverTerms: PerformancePhase;
    readonly evaluateTerms: PerformancePhase;
  }>;
  readonly output: Readonly<{
    readonly status: "complete" | "incomplete";
    readonly groupCount: number;
    readonly conceptCount: number;
    readonly expressionCount: number;
    readonly sourceMatches: number;
    readonly targetMatches: number;
    readonly problems: number;
    readonly assessmentIssues: number;
    readonly candidateCount: number;
    readonly discoveryIssues: number;
    readonly fingerprints: Readonly<Record<string, string>>;
  }>;
  readonly memory: {
    readonly processPeakMaxRssBytes: number;
    readonly postRelease: NodeJS.MemoryUsage;
    readonly postReleaseGcRequested: boolean;
    readonly peakSource: "process.resourceUsage().maxRSS";
    readonly stageObservationSource: "process.memoryUsage() before and after each public operation";
  };
};

type Measured<T> = {
  readonly value: T;
  readonly phase: PerformancePhase;
};

type MemoMeasured<T> = Measured<T> & {
  readonly memo: PerformancePhase["memo"];
};

function memorySnapshot(): NodeJS.MemoryUsage {
  return Object.freeze({ ...process.memoryUsage() });
}

function requestGarbageCollection(): boolean {
  const collect = Reflect.get(globalThis, "gc");
  if (typeof collect !== "function") return false;
  Reflect.apply(collect, globalThis, []);
  return true;
}

function digest(value: unknown): string {
  return sha256(canonicalJson(value));
}

function matchFact(match: TermMatches["matches"][number]) {
  return {
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
  };
}

function matchesFact(matches: TermMatches) {
  return {
    status: matches.status,
    matches: matches.matches.map(matchFact),
    active: matches.active.map(matchFact),
    certain: matches.certain.map(matchFact),
    suppressed: matches.suppressed.map(({ match, by }) => ({
      match: matchFact(match),
      by: by.map(matchFact),
    })),
    ambiguities: matches.ambiguities.map(({ reason, matches: ambiguous }) => ({
      reason,
      matches: ambiguous.map(matchFact),
    })),
    issues: matches.issues.map(
      ({ code, fragmentIndex, conceptId, expressionId }) => ({
        code,
        fragmentIndex,
        conceptId,
        expressionId,
      }),
    ),
  };
}

function analysisFact(analysis: TermUseAnalysis) {
  const groups = analysis.groups.map((group) => ({
    source: matchesFact(group.source),
    target: matchesFact(group.target),
    applicableConceptIds: group.applicableConcepts.map(({ id }) => id),
  }));
  return Object.freeze({
    status: groups.some(
      ({ source, target }) =>
        source.status === "incomplete" || target.status === "incomplete",
    )
      ? "incomplete"
      : "complete",
    groups: groups.length,
    sourceMatches: groups.reduce(
      (sum, { source }) => sum + source.matches.length,
      0,
    ),
    targetMatches: groups.reduce(
      (sum, { target }) => sum + target.matches.length,
      0,
    ),
    sourceCertain: groups.reduce(
      (sum, { source }) => sum + source.certain.length,
      0,
    ),
    targetCertain: groups.reduce(
      (sum, { target }) => sum + target.certain.length,
      0,
    ),
    sourceAmbiguities: groups.reduce(
      (sum, { source }) => sum + source.ambiguities.length,
      0,
    ),
    targetAmbiguities: groups.reduce(
      (sum, { target }) => sum + target.ambiguities.length,
      0,
    ),
    sourceIssues: groups.reduce(
      (sum, { source }) => sum + source.issues.length,
      0,
    ),
    targetIssues: groups.reduce(
      (sum, { target }) => sum + target.issues.length,
      0,
    ),
    fingerprint: digest(groups),
  });
}

function assessmentFact(result: TermAssessment) {
  const issues = result.issues.map(
    ({ code, groupIndex, conceptId, ruleId }) => ({
      code,
      groupIndex,
      conceptId,
      ruleId,
    }),
  );
  const problems = result.problems.map((problem) => ({
    code: problem.code,
    ruleId: problem.ruleId,
    groupIndex: problem.groupIndex,
    conceptId: problem.conceptId,
    sourceMatches: problem.sourceMatches.map(matchFact),
    targetMatches: problem.targetMatches.map(matchFact),
  }));
  const codeCounts: Record<string, number> = {};
  for (const { code } of issues) codeCounts[code] = (codeCounts[code] ?? 0) + 1;
  for (const { code } of problems)
    codeCounts[code] = (codeCounts[code] ?? 0) + 1;
  return Object.freeze({
    status: result.status,
    problems: problems.length,
    issues: issues.length,
    codeCounts: Object.freeze(codeCounts),
    fingerprint: digest({ problems, issues }),
  });
}

function discoveryFact(result: Awaited<ReturnType<typeof discoverTerms>>) {
  const hash = createHash("sha256");
  const issueCounts: Record<string, number> = {};
  for (const issue of result.issues) {
    issueCounts[issue.code] = (issueCounts[issue.code] ?? 0) + 1;
  }
  for (const candidate of result.candidates) {
    hash.update(
      canonicalJson({
        text: candidate.text,
        language: candidate.language,
        occurrences: candidate.occurrences,
        entryCount: candidate.entryCount,
        examples: candidate.examples,
        examplesTruncated: candidate.examplesTruncated,
        ranking: candidate.ranking,
      }),
    );
    hash.update("\n");
  }
  return Object.freeze({
    status: result.status,
    entries: result.statistics.entries,
    distinctCandidates: result.statistics.distinctCandidates,
    eligibleCandidates: result.statistics.eligibleCandidates,
    omittedCandidates: result.statistics.omittedCandidates,
    candidateCount: result.candidates.length,
    issues: result.issues.length,
    issueCounts: Object.freeze(issueCounts),
    fingerprint: hash.digest("hex"),
  });
}

async function measure<T>(
  operation: () => T | PromiseLike<T>,
  summarize: (value: T) => Readonly<Record<string, unknown>>,
  memo: PerformancePhase["memo"],
): Promise<Measured<T>> {
  const gcBeforeRequested = requestGarbageCollection();
  const before = memorySnapshot();
  const started = performance.now();
  const value = await operation();
  const durationMs = performance.now() - started;
  const after = memorySnapshot();
  return Object.freeze({
    value,
    phase: Object.freeze({
      durationMs,
      memory: Object.freeze({ gcBeforeRequested, before, after }),
      output: summarize(value),
      memo,
    }),
  });
}

async function measureWithMemo<T>(
  mode: PerformanceMemoMode,
  operation: (memo?: MemoScope) => T | PromiseLike<T>,
  summarize: (value: T) => Readonly<Record<string, unknown>>,
): Promise<MemoMeasured<T>> {
  if (mode === "no-memo") {
    const measured = await measure(
      () => operation(),
      summarize,
      Object.freeze({
        mode,
        prewarmDurationMs: null,
        prewarmOutputSha256: null,
      }),
    );
    return Object.freeze({ ...measured, memo: measured.phase.memo });
  }

  const memo = createMemoScope();
  try {
    let prewarmDurationMs: number | null = null;
    let prewarmOutputSha256: string | null = null;
    if (mode === "reused-scope") {
      const started = performance.now();
      const warmed = await operation(memo);
      prewarmDurationMs = performance.now() - started;
      prewarmOutputSha256 = digest(summarize(warmed));
    }
    const measured = await measure(
      () => operation(memo),
      summarize,
      Object.freeze({ mode, prewarmDurationMs, prewarmOutputSha256 }),
    );
    if (prewarmOutputSha256 !== null)
      assert.equal(
        digest(measured.phase.output),
        prewarmOutputSha256,
        "复用范围预热与计量输出必须一致。",
      );
    return Object.freeze({ ...measured, memo: measured.phase.memo });
  } finally {
    memo.dispose();
  }
}

function countMatches(
  analysis: TermUseAnalysis,
  side: "source" | "target",
): number {
  return analysis.groups.reduce(
    (sum, group) => sum + group[side].matches.length,
    0,
  );
}

function packageEntry(name: string): string {
  const target = import.meta.resolve(name);
  const filename = fileURLToPath(target);
  if (!filename.replaceAll("\\", "/").endsWith("/dist/index.js"))
    throw new Error(`${name} 必须从正式构建入口载入，实际解析到 ${filename}。`);
  return filename;
}

async function runSample(
  inputPath: string,
  expectedInputSha256: string,
  memoMode: PerformanceMemoMode,
  sampleIndex: number,
): Promise<PerformanceWorkerResult> {
  const inputValue: unknown = JSON.parse(await readFile(inputPath, "utf8"));
  if (sha256(canonicalJson(inputValue)) !== expectedInputSha256)
    throw new Error("性能场景输入散列与已准备的报告身份不符。");
  if (!isPerformancePreparedInput(inputValue))
    throw new Error("性能输入结构不完整。");
  const input = inputValue;
  const publicEntries = Object.freeze({
    terminology: packageEntry("@lioni/terminology"),
    memo: packageEntry("@lioni/memo"),
    textAnalysis: packageEntry("@lioni/text-analysis"),
  });
  const base = await measure(
    () => createTermbase(input.termbase),
    (termbase) => ({
      concepts: termbase.concepts.length,
      expressions: termbase.expressions.length,
    }),
    Object.freeze({
      mode: "not-used",
      prewarmDurationMs: null,
      prewarmOutputSha256: null,
    }),
  );
  const compiled = await measure(
    () => compileTerms(base.value),
    (terms) => ({
      languages: terms.languages,
      expressions: terms.termbase.expressions.length,
      policies: Object.freeze(
        Object.fromEntries(
          terms.languages.map((language) => [
            language,
            defaultTermMatchingPolicy(language)?.id ?? "unsupported",
          ]),
        ),
      ),
    }),
    Object.freeze({
      mode: "not-used",
      prewarmDurationMs: null,
      prewarmOutputSha256: null,
    }),
  );

  const warmupInput = Object.freeze({
    groups: Object.freeze(input.comparison.groups.slice(0, 2)),
  });
  const warmupCorpus = Object.freeze({
    ...input.discovery,
    entries: Object.freeze(input.discovery.entries.slice(0, 2)),
  });
  await analyzeTermUse(compiled.value, warmupInput);
  const warmupAnalysis = await analyzeTermUse(compiled.value, warmupInput);
  assessTermUse(warmupInput, warmupAnalysis);
  await evaluateTerms(compiled.value, warmupInput);
  await discoverTerms(warmupCorpus, performanceDiscoveryPolicy);

  const analysis = await measureWithMemo(
    memoMode,
    (memo) =>
      analyzeTermUse(compiled.value, input.comparison, memo ? { memo } : {}),
    analysisFact,
  );
  const assessment = await measure(
    () => assessTermUse(input.comparison, analysis.value),
    assessmentFact,
    Object.freeze({
      mode: "not-used",
      prewarmDurationMs: null,
      prewarmOutputSha256: null,
    }),
  );
  const discovery = await measureWithMemo(
    memoMode,
    (memo) =>
      discoverTerms(input.discovery, {
        ...performanceDiscoveryPolicy,
        ...(memo === undefined ? {} : { memo }),
      }),
    discoveryFact,
  );
  const full = await measureWithMemo(
    memoMode,
    (memo) =>
      evaluateTerms(
        compiled.value,
        input.comparison,
        memo === undefined ? {} : { memo },
      ),
    assessmentFact,
  );
  assert.equal(
    digest(full.phase.output),
    digest(assessment.phase.output),
    "分阶段分析/判断与完整公开入口的判断摘要必须一致。",
  );

  const sourceMatches = countMatches(analysis.value, "source");
  const targetMatches = countMatches(analysis.value, "target");
  const status =
    assessment.value.status === "complete" &&
    discovery.value.status === "complete" &&
    analysis.value.groups.every(
      ({ source, target }) =>
        source.status === "complete" && target.status === "complete",
    )
      ? "complete"
      : "incomplete";
  const phases = Object.freeze({
    termbaseCreate: base.phase,
    compileTerms: compiled.phase,
    analyzeTermUse: analysis.phase,
    assessTermUse: assessment.phase,
    discoverTerms: discovery.phase,
    evaluateTerms: full.phase,
  });
  return Object.freeze({
    schemaVersion: 1,
    scenario: input.id,
    sampleIndex,
    memoMode,
    publicEntries,
    runtimeWarmup: Object.freeze({
      memoMode: "no-memo",
      groups: warmupInput.groups.length,
      discoveryEntries: warmupCorpus.entries.length,
      phases: Object.freeze([
        "analyzeTermUse",
        "assessTermUse",
        "evaluateTerms",
        "discoverTerms",
      ]),
    }),
    facts: input.facts,
    phases,
    output: Object.freeze({
      status,
      groupCount: input.facts.comparisonGroups,
      conceptCount: input.facts.concepts,
      expressionCount: input.facts.expressions,
      sourceMatches,
      targetMatches,
      problems: assessment.value.problems.length,
      assessmentIssues: assessment.value.issues.length,
      candidateCount: discovery.value.candidates.length,
      discoveryIssues: discovery.value.issues.length,
      fingerprints: Object.freeze({
        analysis: String(analysis.phase.output.fingerprint),
        assessment: String(assessment.phase.output.fingerprint),
        discovery: String(discovery.phase.output.fingerprint),
        fullEvaluation: String(full.phase.output.fingerprint),
      }),
    }),
    memory: Object.freeze({
      processPeakMaxRssBytes: maxRssBytes(),
      postRelease: Object.freeze({ ...process.memoryUsage() }),
      postReleaseGcRequested: false,
      peakSource: "process.resourceUsage().maxRSS",
      stageObservationSource:
        "process.memoryUsage() before and after each public operation",
    }),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPerformancePreparedInput(
  value: unknown,
): value is PerformancePreparedInput {
  return (
    isRecord(value) &&
    value.schemaVersion === 1 &&
    (value.id === "controlled-scale" || value.id === "cfpa") &&
    isRecord(value.termbase) &&
    Array.isArray(value.termbase.concepts) &&
    isRecord(value.comparison) &&
    Array.isArray(value.comparison.groups) &&
    isRecord(value.discovery) &&
    Array.isArray(value.discovery.entries) &&
    isRecord(value.facts)
  );
}

function maxRssBytes(): number {
  const maxRss = process.resourceUsage().maxRSS;
  return process.platform === "win32" ? maxRss : maxRss * 1024;
}

async function main(): Promise<void> {
  const [inputPath, outputPath, modeValue, sampleValue, expectedInputSha256] =
    process.argv.slice(2);
  if (!inputPath || !outputPath)
    throw new Error(
      "性能 worker 用法：<input.json> <result.json> <memo-mode> <sample-index>。",
    );
  if (
    modeValue !== "no-memo" &&
    modeValue !== "empty-scope" &&
    modeValue !== "reused-scope"
  )
    throw new Error(`不支持的 memo 模式：${String(modeValue)}`);
  const sampleIndex = Number(sampleValue);
  if (!Number.isSafeInteger(sampleIndex) || sampleIndex < 1)
    throw new Error("样本编号必须是正整数。");
  if (!expectedInputSha256)
    throw new Error("性能 worker 需要已登记的输入 SHA-256。");
  const result = await runSample(
    inputPath,
    expectedInputSha256,
    modeValue,
    sampleIndex,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  const postReleaseGcRequested = requestGarbageCollection();
  const finished = Object.freeze({
    ...result,
    memory: Object.freeze({
      ...result.memory,
      postRelease: Object.freeze({ ...process.memoryUsage() }),
      postReleaseGcRequested,
    }),
  });
  await writeFile(outputPath, `${JSON.stringify(finished, null, 2)}\n`, "utf8");
}

main().catch((error: unknown) => {
  process.stderr.write(
    `性能样本失败：${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
