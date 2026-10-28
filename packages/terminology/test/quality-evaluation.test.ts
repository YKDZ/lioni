import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const qualityEntry = path.join(packageRoot, "scripts/evaluation/quality.ts");

type QualityReport = {
  readonly schemaVersion: 1;
  readonly task: "discovery";
  readonly dataset: {
    readonly id: string;
    readonly version: string;
    readonly reviewStatus: string;
  };
  readonly input: {
    readonly sha256: string;
    readonly language: string;
    readonly entryCount: number;
    readonly complete: boolean;
  };
  readonly parameters: {
    readonly maxWords: number;
    readonly maxCharacters: number;
    readonly minOccurrences: number;
    readonly limit: number;
  };
  readonly output: {
    readonly status: "complete" | "incomplete";
    readonly statistics: {
      readonly distinctCandidates: number;
      readonly eligibleCandidates: number;
      readonly discoveryCandidates: number;
      readonly normalizedDuplicates: number;
      readonly returnedCandidates: number;
      readonly omittedCandidates: number;
    };
    readonly truncated: boolean;
    readonly candidates: readonly { readonly text: string }[];
    readonly issues: readonly { readonly code: string }[];
  };
  readonly references: readonly {
    readonly id: string;
    readonly rawTermCount: number;
    readonly normalizedTermCount: number;
    readonly hits: number;
    readonly falsePositives: number;
    readonly falseNegatives: number;
    readonly precision: number;
    readonly recall: number;
    readonly f1: number;
    readonly pAt: Readonly<
      Record<
        "50" | "100" | "500",
        {
          readonly hits: number;
          readonly precision: number;
          readonly outputCount: number;
        }
      >
    >;
  }[];
};

type DiscoveryDataset = {
  readonly schemaVersion: 1;
  readonly dataset: {
    readonly id: string;
    readonly version: string;
    readonly reviewStatus: "pending";
  };
  readonly task: "discovery";
  readonly input: {
    readonly language: string;
    readonly entries: readonly {
      readonly ref: string;
      readonly fragments: readonly {
        readonly ref: string;
        readonly text: string;
      }[];
    }[];
    readonly complete?: boolean;
  };
  readonly options?: {
    readonly maxWords?: number;
    readonly maxCharacters?: number;
    readonly minOccurrences?: number;
    readonly limit?: number;
  };
  readonly references: readonly {
    readonly id: string;
    readonly terms: readonly string[];
  }[];
};

function runQuality(args: readonly string[]) {
  return spawnSync(
    process.execPath,
    ["--conditions=source", qualityEntry, ...args],
    { cwd: packageRoot, encoding: "utf8", timeout: 30_000 },
  );
}

async function writeDataset(
  directory: string,
  dataset: DiscoveryDataset,
  filename = "input.json",
) {
  const inputPath = path.join(directory, filename);
  await writeFile(inputPath, `${JSON.stringify(dataset, null, 2)}\n`, "utf8");
  return inputPath;
}

async function readReport(filename: string): Promise<QualityReport> {
  return JSON.parse(await readFile(filename, "utf8")) as QualityReport;
}

void describe("候选发现质量评测入口", () => {
  void it("正式发现输出分别对照多套答案并报告可手算的集合与排名分数", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "lioni-discovery-evaluation-"),
    );
    const inputPath = await writeDataset(directory, {
      schemaVersion: 1,
      dataset: {
        id: "hand-calculated-discovery",
        version: "1.0.0",
        reviewStatus: "pending",
      },
      task: "discovery",
      input: {
        language: "en",
        entries: [
          { ref: "doc-a", fragments: [{ ref: "body", text: "cache cache" }] },
          { ref: "doc-b", fragments: [{ ref: "body", text: "CACHE repair" }] },
        ],
      },
      options: { maxWords: 1, minOccurrences: 1, limit: 3 },
      references: [
        { id: "reviewer-a", terms: ["CACHE", "cache ", "missing"] },
        { id: "reviewer-b", terms: ["repair"] },
        { id: "empty-answer", terms: [] },
      ],
    });
    const outputPath = path.join(directory, "report.json");

    try {
      const result = runQuality(["--input", inputPath, "--output", outputPath]);
      assert.equal(result.error, undefined, result.stderr);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.match(result.stdout, /reviewer-a/u);

      const report = await readReport(outputPath);
      assert.equal(report.schemaVersion, 1);
      assert.equal(report.task, "discovery");
      assert.deepEqual(report.dataset, {
        id: "hand-calculated-discovery",
        version: "1.0.0",
        reviewStatus: "pending",
      });
      assert.equal(report.input.entryCount, 2);
      assert.equal(report.input.language, "en");
      assert.deepEqual(report.parameters, {
        maxWords: 1,
        maxCharacters: 80,
        minOccurrences: 1,
        limit: 3,
        normalization: "Unicode NFC；折叠空白；英文小写",
      });
      assert.deepEqual(
        report.output.candidates.map(({ text }) => text),
        ["cache", "repair"],
      );
      assert.equal(report.output.statistics.discoveryCandidates, 3);
      assert.equal(report.output.statistics.normalizedDuplicates, 1);
      assert.equal(report.output.statistics.returnedCandidates, 2);
      assert.equal(report.output.statistics.omittedCandidates, 0);
      assert.equal(report.output.truncated, false);

      const [reviewerA, reviewerB, emptyAnswer] = report.references;
      assert.equal(reviewerA?.rawTermCount, 3);
      assert.equal(reviewerA?.normalizedTermCount, 2);
      assert.deepEqual(
        [
          reviewerA?.hits,
          reviewerA?.falsePositives,
          reviewerA?.falseNegatives,
          reviewerA?.precision,
          reviewerA?.recall,
          reviewerA?.f1,
        ],
        [1, 1, 1, 0.5, 0.5, 0.5],
      );
      assert.equal(reviewerA?.pAt["50"].hits, 1);
      assert.equal(reviewerA?.pAt["50"].outputCount, 2);
      assert.equal(reviewerA?.pAt["50"].precision, 1 / 50);
      assert.equal(reviewerA?.pAt["100"].precision, 1 / 100);
      assert.equal(reviewerA?.pAt["500"].precision, 1 / 500);
      assert.deepEqual(
        [
          reviewerB?.hits,
          reviewerB?.falsePositives,
          reviewerB?.falseNegatives,
          reviewerB?.precision,
          reviewerB?.recall,
          reviewerB?.f1,
        ],
        [1, 1, 0, 0.5, 1, 2 / 3],
      );
      assert.deepEqual(
        [
          emptyAnswer?.hits,
          emptyAnswer?.precision,
          emptyAnswer?.recall,
          emptyAnswer?.f1,
        ],
        [0, 0, 0, 0],
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  void it("明确记录双空集合、截断与未完成语料", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "lioni-discovery-empty-"),
    );
    const emptyInput = await writeDataset(
      directory,
      {
        schemaVersion: 1,
        dataset: {
          id: "empty-discovery",
          version: "1.0.0",
          reviewStatus: "pending",
        },
        task: "discovery",
        input: { language: "en", entries: [] },
        references: [{ id: "empty-answer", terms: [] }],
      },
      "empty-input.json",
    );
    const emptyOutput = path.join(directory, "empty-report.json");
    const limitedInput = await writeDataset(
      directory,
      {
        schemaVersion: 1,
        dataset: {
          id: "limited-discovery",
          version: "1.0.0",
          reviewStatus: "pending",
        },
        task: "discovery",
        input: {
          language: "en",
          complete: false,
          entries: [
            { ref: "doc", fragments: [{ ref: "body", text: "cache" }] },
          ],
        },
        options: { maxWords: 1, limit: 0 },
        references: [{ id: "reviewer", terms: ["cache"] }],
      },
      "limited-input.json",
    );
    const limitedOutput = path.join(directory, "limited-report.json");

    try {
      const emptyResult = runQuality([
        "--input",
        emptyInput,
        "--output",
        emptyOutput,
      ]);
      assert.equal(emptyResult.error, undefined, emptyResult.stderr);
      assert.equal(
        emptyResult.status,
        0,
        `${emptyResult.stdout}\n${emptyResult.stderr}`,
      );
      const emptyReport = await readReport(emptyOutput);
      assert.deepEqual(
        [
          emptyReport.references[0]?.precision,
          emptyReport.references[0]?.recall,
          emptyReport.references[0]?.f1,
        ],
        [1, 1, 1],
      );
      assert.equal(emptyReport.references[0]?.pAt["50"].precision, 0);
      assert.equal(emptyReport.references[0]?.pAt["50"].outputCount, 0);

      const limitedResult = runQuality([
        "--input",
        limitedInput,
        "--output",
        limitedOutput,
      ]);
      assert.equal(limitedResult.error, undefined, limitedResult.stderr);
      assert.equal(
        limitedResult.status,
        1,
        `${limitedResult.stdout}\n${limitedResult.stderr}`,
      );
      const limitedReport = await readReport(limitedOutput);
      assert.equal(limitedReport.output.status, "incomplete");
      assert.equal(limitedReport.output.truncated, true);
      assert.equal(limitedReport.output.statistics.eligibleCandidates, 1);
      assert.equal(limitedReport.output.statistics.returnedCandidates, 0);
      assert.equal(limitedReport.output.statistics.omittedCandidates, 1);
      assert.deepEqual(
        limitedReport.output.issues.map(({ code }) => code),
        ["incomplete-corpus"],
      );
      assert.deepEqual(
        [
          limitedReport.references[0]?.precision,
          limitedReport.references[0]?.recall,
          limitedReport.references[0]?.f1,
        ],
        [0, 0, 0],
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  void it("显式指定缺失输入时失败，不生成空报告", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "lioni-discovery-missing-"),
    );
    const outputPath = path.join(directory, "report.json");

    try {
      const result = runQuality([
        "--input",
        path.join(directory, "missing.json"),
        "--output",
        outputPath,
      ]);
      assert.equal(result.error, undefined, result.stderr);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /无法读取评测输入/u);
      await assert.rejects(access(outputPath), /ENOENT/u);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
