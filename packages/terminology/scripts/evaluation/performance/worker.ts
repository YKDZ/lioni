import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { createMemoScope, type MemoScope } from "@lioni/memo";
import {
  compileTerms,
  createTermbase,
  discoverTerms,
  evaluateTerms,
} from "@lioni/terminology";
import { z } from "zod";

import { canonicalJson, sha256 } from "../support/json.ts";
import type { PerformanceWorkerResult } from "./types.ts";
import {
  performanceDiscoveryPolicy,
  performanceInputSchema,
  performanceMemoModeSchema,
  type PerformancePreparedInput,
} from "./workload.ts";
import type { PerformanceMemoMode } from "./workload.ts";

function fingerprint(value: unknown): string {
  return sha256(canonicalJson(value));
}

async function runPublicCalls(
  input: PerformancePreparedInput,
  terms: ReturnType<typeof compileTerms>,
  memo?: MemoScope,
) {
  const discoveryStarted = performance.now();
  const discovery = await discoverTerms(input.discovery, {
    ...performanceDiscoveryPolicy,
    ...(memo === undefined ? {} : { memo }),
  });
  const discoveryMs = performance.now() - discoveryStarted;

  const evaluationStarted = performance.now();
  const evaluation = await evaluateTerms(
    terms,
    input.comparison,
    memo === undefined ? {} : { memo },
  );
  const evaluationMs = performance.now() - evaluationStarted;

  return { discovery, evaluation, discoveryMs, evaluationMs };
}

function publicEntry(): string {
  const filename = fileURLToPath(import.meta.resolve("@lioni/terminology"));
  if (!filename.replaceAll("\\", "/").endsWith("/dist/index.js"))
    throw new Error(`性能样本必须加载正式构建入口，实际解析到 ${filename}。`);
  return filename;
}

function lifecycleMaxRssBytes(): number {
  if (process.platform === "win32")
    throw new Error("Node.js resourceUsage.maxRSS 在 Windows 不受支持。");
  return process.resourceUsage().maxRSS * 1024;
}

async function runSample(
  inputPath: string,
  expectedInputSha256: string,
  memoMode: PerformanceMemoMode,
  sample: number,
): Promise<PerformanceWorkerResult> {
  const value: unknown = JSON.parse(await readFile(inputPath, "utf8"));
  if (sha256(canonicalJson(value)) !== expectedInputSha256)
    throw new Error("性能输入文件与固定种子报告不一致。");
  performanceInputSchema.parse(value);
  // 保持 JSON.parse 的输入形态；正式入口各自负责资料快照，准备阶段不预先复制冻结。
  const input = value as PerformancePreparedInput;
  const termbase = createTermbase(input.termbase);
  const terms = compileTerms(termbase);
  const entry = publicEntry();
  const memo = memoMode === "no-memo" ? undefined : createMemoScope();

  try {
    let reusedScopeWarmup: PerformanceWorkerResult["reusedScopeWarmup"] = null;
    if (memoMode === "reused-scope") {
      const warmup = await runPublicCalls(input, terms, memo);
      reusedScopeWarmup = Object.freeze({
        timingsMs: Object.freeze({
          discoverTerms: warmup.discoveryMs,
          evaluateTerms: warmup.evaluationMs,
        }),
        results: Object.freeze({
          discoverySha256: fingerprint(warmup.discovery),
          evaluationSha256: fingerprint(warmup.evaluation),
        }),
      });
    }

    const measured = await runPublicCalls(input, terms, memo);
    const discoverySha256 = fingerprint(measured.discovery);
    const evaluationSha256 = fingerprint(measured.evaluation);
    if (reusedScopeWarmup !== null) {
      assert.ok(
        discoverySha256 === reusedScopeWarmup.results.discoverySha256,
        "复用 scope 预热和计量的候选发现输出必须一致。",
      );
      assert.ok(
        evaluationSha256 === reusedScopeWarmup.results.evaluationSha256,
        "复用 scope 预热和计量的术语检查输出必须一致。",
      );
    }

    return Object.freeze({
      comparisonGroups: input.facts.comparisonGroups,
      concepts: input.facts.concepts,
      memoMode,
      sample,
      timingsMs: Object.freeze({
        discoverTerms: measured.discoveryMs,
        evaluateTerms: measured.evaluationMs,
      }),
      results: Object.freeze({
        discovery: Object.freeze({
          status: measured.discovery.status,
          candidates: measured.discovery.candidates.length,
          issues: measured.discovery.issues.length,
          sha256: discoverySha256,
        }),
        evaluation: Object.freeze({
          status: measured.evaluation.status,
          problems: measured.evaluation.problems.length,
          issues: measured.evaluation.issues.length,
          sha256: evaluationSha256,
        }),
      }),
      reusedScopeWarmup,
      lifecycleMaxRssBytes: lifecycleMaxRssBytes(),
      publicEntry: entry,
      inputFacts: input.facts,
    });
  } finally {
    memo?.dispose();
  }
}

async function main(): Promise<void> {
  const [inputPath, mode, sample, inputSha256] = z
    .tuple([
      z.string().min(1),
      performanceMemoModeSchema,
      z.coerce.number().int().positive(),
      z.string().min(1),
    ])
    .parse(process.argv.slice(2));
  const result = await runSample(inputPath, inputSha256, mode, sample);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
