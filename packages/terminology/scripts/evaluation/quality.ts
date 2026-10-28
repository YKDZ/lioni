import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  discoverTerms,
  type DiscoverTermsOptions,
  type TermDiscovery,
  type TermDiscoveryCorpus,
} from "@lioni/terminology";

import { canonicalJson, resolvePath, sha256 } from "./support/json.ts";

const defaultInputPath = fileURLToPath(
  new URL("./fixtures/discovery-sample.v1.json", import.meta.url),
);
const precisionAtValues = [50, 100, 500] as const;
const discoveryParameterNames = [
  "maxWords",
  "maxCharacters",
  "minOccurrences",
  "limit",
] as const;

type DiscoveryParameters = Pick<
  DiscoverTermsOptions,
  (typeof discoveryParameterNames)[number]
>;

type DiscoveryReference = {
  readonly id: string;
  readonly terms: readonly string[];
};

type DiscoveryDataset = {
  readonly schemaVersion: 1;
  readonly dataset: {
    readonly id: string;
    readonly version: string;
    readonly reviewStatus: string;
  };
  readonly task: "discovery";
  readonly input: TermDiscoveryCorpus;
  readonly options: DiscoveryParameters;
  readonly references: readonly DiscoveryReference[];
};

type QualityCliOptions = {
  readonly inputPath?: string;
  readonly outputPath?: string;
  readonly parameters: Partial<DiscoveryParameters>;
};

/** 质量评测可直接接收已整理对象，也可读取同一数据契约的 JSON 文件。 */
export type QualityEvaluationOptions = {
  readonly dataset?: unknown;
  readonly inputPath?: string;
  readonly outputPath?: string;
  readonly parameters?: Partial<DiscoveryParameters>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "")
    throw new Error(`${field} 必须是非空字符串。`);
  return value;
}

function parseDiscoveryOptions(value: unknown): DiscoveryParameters {
  if (value === undefined) return Object.freeze({});
  if (!isRecord(value)) throw new Error("options 必须是对象。");
  const options: Partial<DiscoveryParameters> = {};
  for (const name of discoveryParameterNames) {
    const parameter = value[name];
    if (parameter !== undefined) {
      if (typeof parameter !== "number" || !Number.isSafeInteger(parameter))
        throw new Error(`options.${name} 必须是安全整数。`);
      Object.assign(options, { [name]: parameter });
    }
  }
  return Object.freeze(options);
}

function parseReferences(value: unknown): readonly DiscoveryReference[] {
  if (!Array.isArray(value) || value.length === 0)
    throw new Error("references 必须至少包含一套独立答案。");
  const ids = new Set<string>();
  return Object.freeze(
    value.map((item, index) => {
      if (!isRecord(item)) throw new Error(`references[${index}] 必须是对象。`);
      const id = requiredString(item.id, `references[${index}].id`);
      if (ids.has(id)) throw new Error(`参考答案身份重复：${id}`);
      ids.add(id);
      if (!Array.isArray(item.terms))
        throw new Error(`references[${index}].terms 必须是数组。`);
      const terms = item.terms.map((term, termIndex) => {
        if (typeof term !== "string" || normalizeTerm(term) === "")
          throw new Error(
            `references[${index}].terms[${termIndex}] 必须是非空字符串。`,
          );
        return term;
      });
      return Object.freeze({ id, terms: Object.freeze(terms) });
    }),
  );
}

function parseDataset(value: unknown): DiscoveryDataset {
  if (!isRecord(value)) throw new Error("评测输入必须是 JSON 对象。");
  if (value.schemaVersion !== 1)
    throw new Error("评测输入 schemaVersion 必须为 1。");
  if (!isRecord(value.dataset)) throw new Error("dataset 必须是对象。");
  if (value.task !== "discovery")
    throw new Error("本入口只接受 task: discovery 的数据。");
  if (!isRecord(value.input)) throw new Error("input 必须是对象。");

  return Object.freeze({
    schemaVersion: 1,
    dataset: Object.freeze({
      id: requiredString(value.dataset.id, "dataset.id"),
      version: requiredString(value.dataset.version, "dataset.version"),
      reviewStatus: requiredString(
        value.dataset.reviewStatus,
        "dataset.reviewStatus",
      ),
    }),
    task: "discovery",
    input: value.input as unknown as TermDiscoveryCorpus,
    options: parseDiscoveryOptions(value.options),
    references: parseReferences(value.references),
  });
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
      const value = args[++index];
      if (value === undefined || value.trim() === "")
        throw new Error(`${argument} 需要路径。`);
      if (argument === "--input") inputPath = value;
      else outputPath = value;
      continue;
    }
    const parameterName = cliNames.get(String(argument));
    if (parameterName !== undefined) {
      const value = Number(args[++index]);
      if (!Number.isSafeInteger(value))
        throw new Error(`${argument} 需要安全整数。`);
      Object.assign(parameters, { [parameterName]: value });
      continue;
    }
    if (argument === "--help") {
      process.stdout.write(
        "用法：evaluation:quality [--input 数据.json] [--output 报告.json] [--max-words N] [--max-characters N] [--min-occurrences N] [--limit N]\n",
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

type QualityReport = ReturnType<typeof createQualityReport>;

function qualitySummary(report: QualityReport): string {
  const referenceLines = report.references.map(
    ({ id, precision, recall, f1, pAt }) =>
      `- ${id}：P ${formatScore(precision)} / R ${formatScore(recall)} / F1 ${formatScore(f1)}；P@50 ${formatScore(pAt["50"]!.precision)}，P@100 ${formatScore(pAt["100"]!.precision)}，P@500 ${formatScore(pAt["500"]!.precision)}`,
  );
  const issueLines = report.output.issues.map(
    ({ code, message }) => `- 未完成原因 ${code}：${message}`,
  );
  return [
    `术语候选发现评测：${report.dataset.id}@${report.dataset.version}（${report.output.status}）`,
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

export async function runQualityEvaluation(
  options: QualityEvaluationOptions = {},
): Promise<QualityReport> {
  if (options.dataset !== undefined && options.inputPath !== undefined)
    throw new Error("dataset 与 inputPath 只能指定其中一项。");
  const loaded =
    options.dataset === undefined
      ? await loadDataset(
          resolvePath(process.cwd(), options.inputPath ?? defaultInputPath),
        )
      : Object.freeze({
          dataset: parseDataset(options.dataset),
          inputSha256: sha256(canonicalJson(options.dataset)),
        });
  const { dataset, inputSha256 } = loaded;
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
  const report = await runQualityEvaluation(options);
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
