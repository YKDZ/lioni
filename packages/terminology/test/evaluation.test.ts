import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { loadExternalInputCache } from "../scripts/evaluation/corpora/cache.ts";
import type { CfpaPreparedInput } from "../scripts/evaluation/corpora/convert.ts";
import {
  cfpaSelections,
  cfpaSource,
  contentTypeSelection,
} from "../scripts/evaluation/corpora/manifest.ts";
import { assertFileHash } from "../scripts/evaluation/corpora/source.ts";
import { runCfpaScenario } from "../scripts/evaluation/scenarios/external.ts";
import { canonicalJson, sha256 } from "../scripts/evaluation/support/json.ts";

const packageRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const qualityCli = path.join(packageRoot, "scripts/evaluation/cli.ts");

function runCli(command: string, args: readonly string[]) {
  return spawnSync(
    process.execPath,
    ["--conditions=source", qualityCli, command, ...args],
    { cwd: packageRoot, encoding: "utf8", timeout: 30_000 },
  );
}

function runQuality(args: readonly string[]) {
  return runCli("quality", args);
}

function cfpaScenarioInput(): CfpaPreparedInput {
  const corpusEntry = (ref: string, text: string) => ({
    ref,
    fragments: [{ ref, text }],
  });
  const facts = {
    entries: 3,
    nonEmptyEntries: 3,
    distinctNonEmptyValues: 3,
    codepoints: 35,
    utf16Units: 35,
  };
  return {
    schemaVersion: 1,
    id: "cfpa",
    source: {
      id: "cfpa",
      root: "/fixture/cfpa",
      repository: cfpaSource.repository,
      commit: cfpaSource.commit,
      converterVersion: cfpaSource.converterVersion,
      files: cfpaSource.files,
      license: cfpaSource.license,
    },
    corpora: {
      en: {
        language: "en",
        entries: [
          corpusEntry("gui.done", "Save"),
          corpusEntry("mco.account.privacyinfo", "data retention policy"),
          corpusEntry("outside-content-types", "workspace"),
        ],
      },
      "zh-CN": {
        language: "zh-CN",
        entries: [
          corpusEntry("gui.done", "保存"),
          corpusEntry("mco.account.privacyinfo", "未知"),
          corpusEntry("outside-content-types", "工作区工作空间"),
        ],
      },
      ja: {
        language: "ja",
        entries: [
          corpusEntry("gui.done", "保存"),
          corpusEntry("mco.account.privacyinfo", "情報"),
          corpusEntry("outside-content-types", "作業空間"),
        ],
      },
    },
    comparison: {
      groups: [
        {
          ref: "gui.done",
          source: {
            language: "en",
            fragments: [{ ref: "gui.done", text: "Save" }],
          },
          target: {
            language: "zh-CN",
            fragments: [{ ref: "gui.done", text: "保存" }],
          },
        },
        {
          ref: "mco.account.privacyinfo",
          source: {
            language: "en",
            fragments: [
              { ref: "mco.account.privacyinfo", text: "data retention policy" },
            ],
          },
          target: {
            language: "zh-CN",
            fragments: [{ ref: "mco.account.privacyinfo", text: "未知" }],
          },
        },
        {
          ref: "outside-content-types",
          source: {
            language: "en",
            fragments: [{ ref: "outside-content-types", text: "workspace" }],
          },
          target: {
            language: "zh-CN",
            fragments: [
              { ref: "outside-content-types", text: "工作区工作空间" },
            ],
          },
        },
      ],
    },
    referenceTermbase: {
      concepts: [
        {
          id: "save",
          languages: [
            {
              language: "en",
              expressions: [
                { id: "save-en", text: "Save", usage: "preferred" },
              ],
            },
            {
              language: "zh-CN",
              expressions: [{ id: "save-zh", text: "保存", usage: "allowed" }],
            },
          ],
        },
        {
          id: "retention-policy",
          languages: [
            {
              language: "en",
              expressions: [
                {
                  id: "retention-policy-en",
                  text: "data retention policy",
                  usage: "preferred",
                },
              ],
            },
            {
              language: "zh-CN",
              expressions: [
                {
                  id: "retention-policy-zh",
                  text: "数据保留政策",
                  usage: "allowed",
                },
              ],
            },
          ],
        },
        {
          id: "workspace",
          languages: [
            {
              language: "en",
              expressions: [
                { id: "workspace-en", text: "workspace", usage: "preferred" },
              ],
            },
            {
              language: "zh-CN",
              expressions: [
                { id: "workspace-zh", text: "工作区", usage: "allowed" },
                {
                  id: "workspace-forbidden",
                  text: "工作空间",
                  usage: "forbidden",
                },
              ],
            },
          ],
        },
      ],
    },
    facts: {
      textByLanguage: { en: facts, "zh-CN": facts, ja: facts },
      termTableRows: 3,
      convertedExpressionRecords: 6,
      semanticConceptCount: "not-evaluated",
      nonEmptyEnglishChineseGroups: 3,
      missingChineseTargets: 0,
    },
    selections: cfpaSelections,
    contentTypes: contentTypeSelection.cfpa,
  };
}

async function waitForReport(
  filename: string,
  predicate: (report: Record<string, unknown>) => boolean,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const report = JSON.parse(await readFile(filename, "utf8")) as Record<
        string,
        unknown
      >;
      if (predicate(report)) return;
    } catch {
      // 报告的首次原子写入可能尚未完成。
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`评估报告未在限时内进入预期状态：${filename}`);
}

async function runInterruptedCli(signal: NodeJS.Signals, outputRoot: string) {
  const child = spawn(
    process.execPath,
    [
      "--conditions=source",
      qualityCli,
      "quality",
      "--generated-count",
      "100000",
      "--output",
      outputRoot,
    ],
    {
      cwd: packageRoot,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => (stdout += chunk));
  child.stderr?.on("data", (chunk: string) => (stderr += chunk));
  await waitForReport(path.join(outputRoot, "report.json"), (report) => {
    const active = report.activeScenario as
      | { readonly name?: string }
      | undefined;
    return active?.name === "controlled";
  });
  if (process.platform === "win32") child.kill(signal);
  else process.kill(-child.pid!, signal);
  const result = await new Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, closedSignal) =>
      resolve({ code, signal: closedSignal }),
    );
  });
  return { ...result, stdout, stderr };
}

void describe("术语质量评估入口", () => {
  void it("离线受控评估可重建，且分别报告执行、完整性与未标注指标", async () => {
    const firstRoot = await mkdtemp(
      path.join(os.tmpdir(), "lioni-eval-first-"),
    );
    const secondRoot = await mkdtemp(
      path.join(os.tmpdir(), "lioni-eval-second-"),
    );

    try {
      const first = runQuality(["--output", firstRoot]);
      const second = runQuality(["--output", secondRoot]);
      assert.equal(first.error, undefined, first.stderr);
      assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
      assert.equal(second.error, undefined, second.stderr);
      assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);

      const firstReport = JSON.parse(
        await readFile(path.join(firstRoot, "report.json"), "utf8"),
      ) as {
        readonly status: string;
        readonly scenarios: Record<
          string,
          {
            readonly execution: { readonly status: string };
            readonly domain: { readonly status: string };
            readonly inputSha256?: string;
            readonly metrics: Record<string, { readonly status: string }>;
            readonly evidence: {
              readonly scenario: {
                readonly languagePair: {
                  readonly sourceLanguage: string;
                  readonly targetLanguage: string;
                };
                readonly paragraphSamples: {
                  readonly discovery: {
                    readonly language: string;
                    readonly status: string;
                    readonly statistics: { readonly entries: number };
                    readonly selectedRefs: readonly string[];
                    readonly expectedCandidate: {
                      readonly text: string;
                      readonly occurrences: number;
                      readonly range: {
                        readonly start: number;
                        readonly end: number;
                      };
                    };
                    readonly excludedUiCandidate: {
                      readonly text: string;
                      readonly present: boolean;
                    };
                  };
                };
              };
            };
          }
        >;
      };
      const secondReport = JSON.parse(
        await readFile(path.join(secondRoot, "report.json"), "utf8"),
      ) as typeof firstReport;

      assert.equal(firstReport.status, "passed");
      assert.equal(
        firstReport.scenarios.controlled?.execution.status,
        "passed",
      );
      assert.equal(
        firstReport.scenarios.controlled?.domain.status,
        "incomplete",
      );
      assert.equal(
        firstReport.scenarios.controlled?.metrics.diagnosticAccuracy?.status,
        "not-evaluated",
      );
      assert.deepEqual(
        firstReport.scenarios.controlled?.evidence.scenario.languagePair,
        { sourceLanguage: "en", targetLanguage: "zh-CN" },
      );
      const paragraphDiscovery =
        firstReport.scenarios.controlled?.evidence.scenario.paragraphSamples
          .discovery;
      assert.equal(paragraphDiscovery?.status, "complete");
      assert.equal(paragraphDiscovery?.language, "en");
      assert.equal(paragraphDiscovery?.statistics.entries, 2);
      assert.deepEqual(paragraphDiscovery?.selectedRefs, [
        "paragraph-long",
        "paragraph-ambiguous",
      ]);
      assert.equal(
        paragraphDiscovery?.expectedCandidate.text,
        "data retention policy",
      );
      assert.equal(paragraphDiscovery?.expectedCandidate.occurrences, 1);
      assert.deepEqual(paragraphDiscovery?.expectedCandidate.range, {
        start: 2,
        end: 23,
      });
      assert.deepEqual(paragraphDiscovery?.excludedUiCandidate, {
        text: "workspace",
        present: false,
      });
      assert.equal(
        firstReport.scenarios.cfpa?.execution.status,
        "not-executed",
      );
      assert.ok(firstReport.scenarios.controlled?.inputSha256);
      assert.equal(
        firstReport.scenarios.controlled?.inputSha256,
        secondReport.scenarios.controlled?.inputSha256,
      );
      assert.match(
        await readFile(path.join(firstRoot, "summary.md"), "utf8"),
        /未评估/u,
      );
    } finally {
      await Promise.all([
        rm(firstRoot, { recursive: true, force: true }),
        rm(secondRoot, { recursive: true, force: true }),
      ]);
    }
  });

  void it("CFPA 按 manifest 显式范围报告英语到简中的 UI 与段落", async () => {
    const report = await runCfpaScenario(cfpaScenarioInput(), "f".repeat(64));
    assert.equal(report.execution.status, "passed");
    const evidence = report.evidence as {
      readonly termReferenceRun: {
        readonly languagePair: {
          readonly sourceLanguage: string;
          readonly targetLanguage: string;
        };
        readonly comparisonGroups: number;
        readonly problemCount: number;
      };
      readonly intervalRecognition: {
        readonly languagePair: {
          readonly sourceLanguage: string;
          readonly targetLanguage: string;
        };
        readonly comparisonGroups: number;
      };
      readonly contentTypeAnalysis: {
        readonly languagePair: {
          readonly sourceLanguage: string;
          readonly targetLanguage: string;
        };
        readonly ui: {
          readonly selection: {
            readonly selectedKeys: readonly string[];
            readonly requestedKeyCount: number;
            readonly matchedComparisonGroups: number;
            readonly missingKeys: readonly string[];
          };
          readonly assessment: {
            readonly problemCount: number;
          };
          readonly intervalRecognition: {
            readonly comparisonGroups: number;
            readonly sourceCertainMatchCount: number;
            readonly targetCertainMatchCount: number;
          };
        };
        readonly paragraph: {
          readonly selection: {
            readonly selectedKeys: readonly string[];
            readonly requestedKeyCount: number;
            readonly matchedComparisonGroups: number;
            readonly missingKeys: readonly string[];
          };
          readonly assessment: {
            readonly problemCount: number;
            readonly problemCodes: Readonly<Record<string, number>>;
          };
          readonly intervalRecognition: {
            readonly comparisonGroups: number;
            readonly sourceCertainMatchCount: number;
            readonly targetCertainMatchCount: number;
          };
        };
      };
      readonly languages: Readonly<
        Record<
          string,
          { readonly referenceOverlap: { readonly status: string } }
        >
      >;
    };

    const languagePair = { sourceLanguage: "en", targetLanguage: "zh-CN" };
    assert.deepEqual(evidence.termReferenceRun.languagePair, languagePair);
    assert.deepEqual(evidence.intervalRecognition.languagePair, languagePair);
    assert.deepEqual(evidence.contentTypeAnalysis.languagePair, languagePair);
    assert.equal(evidence.termReferenceRun.comparisonGroups, 3);
    assert.equal(evidence.termReferenceRun.problemCount, 2);
    assert.equal(evidence.intervalRecognition.comparisonGroups, 3);

    assert.deepEqual(
      evidence.contentTypeAnalysis.ui.selection.selectedKeys,
      contentTypeSelection.cfpa.ui,
    );
    assert.equal(
      evidence.contentTypeAnalysis.ui.selection.requestedKeyCount,
      11,
    );
    assert.equal(
      evidence.contentTypeAnalysis.ui.selection.matchedComparisonGroups,
      1,
    );
    assert.equal(
      evidence.contentTypeAnalysis.ui.selection.missingKeys.length,
      10,
    );
    assert.equal(evidence.contentTypeAnalysis.ui.assessment.problemCount, 0);
    assert.equal(
      evidence.contentTypeAnalysis.ui.intervalRecognition.comparisonGroups,
      1,
    );
    assert.equal(
      evidence.contentTypeAnalysis.ui.intervalRecognition
        .sourceCertainMatchCount,
      1,
    );
    assert.equal(
      evidence.contentTypeAnalysis.ui.intervalRecognition
        .targetCertainMatchCount,
      1,
    );

    assert.deepEqual(
      evidence.contentTypeAnalysis.paragraph.selection.selectedKeys,
      contentTypeSelection.cfpa.paragraph,
    );
    assert.equal(
      evidence.contentTypeAnalysis.paragraph.selection.requestedKeyCount,
      5,
    );
    assert.equal(
      evidence.contentTypeAnalysis.paragraph.selection.matchedComparisonGroups,
      1,
    );
    assert.equal(
      evidence.contentTypeAnalysis.paragraph.selection.missingKeys.length,
      4,
    );
    assert.equal(
      evidence.contentTypeAnalysis.paragraph.assessment.problemCount,
      1,
    );
    assert.equal(
      evidence.contentTypeAnalysis.paragraph.assessment.problemCodes[
        "missing-allowed-translation"
      ],
      1,
    );
    assert.equal(
      evidence.contentTypeAnalysis.paragraph.intervalRecognition
        .comparisonGroups,
      1,
    );
    assert.equal(
      evidence.contentTypeAnalysis.paragraph.intervalRecognition
        .sourceCertainMatchCount,
      1,
    );
    assert.equal(
      evidence.contentTypeAnalysis.paragraph.intervalRecognition
        .targetCertainMatchCount,
      0,
    );
    assert.equal(
      evidence.languages.ja?.referenceOverlap.status,
      "not-evaluated",
    );
  });

  void it("显式启用但缺失的外部语料会失败并保留报告", async () => {
    const outputRoot = await mkdtemp(
      path.join(os.tmpdir(), "lioni-eval-missing-"),
    );
    const missingCorpus = path.join(outputRoot, "missing-cfpa");

    try {
      const result = runQuality([
        "--scenarios",
        "cfpa",
        "--external",
        "cfpa",
        "--cfpa-root",
        missingCorpus,
        "--retries",
        "1",
        "--output",
        outputRoot,
      ]);
      assert.equal(result.error, undefined, result.stderr);
      assert.notEqual(result.status, 0);

      const report = JSON.parse(
        await readFile(path.join(outputRoot, "report.json"), "utf8"),
      ) as {
        readonly status: string;
        readonly scenarios: Record<
          string,
          {
            readonly execution: {
              readonly status: string;
              readonly reason?: string;
            };
            readonly attempts?: readonly { readonly status: string }[];
          }
        >;
      };
      assert.equal(report.status, "failed");
      assert.equal(
        report.scenarios.controlled?.execution.status,
        "not-executed",
      );
      assert.equal(report.scenarios.cfpa?.execution.status, "failed");
      assert.match(report.scenarios.cfpa?.execution.reason ?? "", /语料/u);
      assert.deepEqual(
        report.scenarios.cfpa?.attempts?.map(({ status }) => status),
        ["failed", "failed"],
      );
      await writeFile(
        path.join(outputRoot, "keep.txt"),
        "keep evidence",
        "utf8",
      );
      const firstClean = runCli("clean", ["--output", outputRoot]);
      const secondClean = runCli("clean", ["--output", outputRoot]);
      assert.equal(firstClean.status, 0, firstClean.stderr);
      assert.equal(secondClean.status, 0, secondClean.stderr);
      assert.equal(
        JSON.parse(await readFile(path.join(outputRoot, "report.json"), "utf8"))
          .status,
        "failed",
      );
      assert.equal(
        await readFile(path.join(outputRoot, "keep.txt"), "utf8"),
        "keep evidence",
      );
      await assert.rejects(access(path.join(outputRoot, "prepared")));
    } finally {
      await rm(outputRoot, { recursive: true, force: true });
    }
  });

  void it("原始语料文件散列不符时拒绝输入", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "lioni-eval-hash-"));
    const filename = path.join(directory, "source.tsv");
    await writeFile(filename, "changed input", "utf8");

    try {
      await assert.rejects(
        assertFileHash(filename, "0".repeat(64), "Vanilla/latest.tsv"),
        /散列不符/u,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  void it("CLI 超时记录失败并留下当前场景报告", async () => {
    const outputRoot = await mkdtemp(
      path.join(os.tmpdir(), "lioni-eval-timeout-"),
    );
    try {
      const result = runQuality(["--timeout-ms", "1", "--output", outputRoot]);
      assert.notEqual(result.status, 0);
      const report = JSON.parse(
        await readFile(path.join(outputRoot, "report.json"), "utf8"),
      ) as {
        readonly status: string;
        readonly scenarios: Record<
          string,
          {
            readonly execution: { readonly status: string };
            readonly attempts?: readonly {
              readonly process?: { readonly status: string };
            }[];
          }
        >;
      };
      assert.equal(report.status, "failed");
      assert.equal(report.scenarios.controlled?.execution.status, "failed");
      assert.equal(
        report.scenarios.controlled?.attempts?.[0]?.process?.status,
        "timed-out",
      );
    } finally {
      await rm(outputRoot, { recursive: true, force: true });
    }
  });

  void it("CLI 收到 SIGINT 和 SIGTERM 时终止当前 worker 并保存失败证据", async () => {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      const outputRoot = await mkdtemp(
        path.join(os.tmpdir(), `lioni-eval-${signal.toLowerCase()}-`),
      );
      try {
        const result = await runInterruptedCli(signal, outputRoot);
        assert.equal(result.code, 1, `${result.stdout}\n${result.stderr}`);
        const report = JSON.parse(
          await readFile(path.join(outputRoot, "report.json"), "utf8"),
        ) as {
          readonly status: string;
          readonly finishedAt: string | null;
          readonly activeScenario?: unknown;
          readonly scenarios: Record<
            string,
            {
              readonly execution: { readonly status: string };
              readonly attempts?: readonly {
                readonly status: string;
                readonly process?: {
                  readonly status: string;
                  readonly signal: NodeJS.Signals | null;
                };
              }[];
            }
          >;
        };
        assert.equal(report.status, "failed");
        assert.ok(report.finishedAt);
        assert.equal(report.activeScenario, undefined);
        assert.equal(report.scenarios.controlled?.execution.status, "failed");
        assert.equal(
          report.scenarios.controlled?.attempts?.[0]?.process?.status,
          "interrupted",
        );
        assert.ok(report.scenarios.controlled?.attempts?.[0]?.process?.signal);
      } finally {
        await rm(outputRoot, { recursive: true, force: true });
      }
    }
  });

  void it("转换输入缓存校验命中，缺失重建，损坏需显式重建", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "lioni-eval-cache-"),
    );
    const value = { rows: ["alpha", "beta"], complete: true };
    const expectedSha256 = sha256(canonicalJson(value));
    let builds = 0;
    const options = {
      id: "controlled",
      sourceCommit: "fixed-source",
      converterVersion: "test-v1",
      expectedSha256,
      directory,
      build: async () => {
        builds += 1;
        return value;
      },
    };

    try {
      const built = await loadExternalInputCache(options);
      const reused = await loadExternalInputCache(options);
      assert.equal(built.cacheState, "built");
      assert.equal(reused.cacheState, "reused");
      assert.equal(builds, 1);

      await writeFile(built.cachePath, "corrupted cache", "utf8");
      await assert.rejects(loadExternalInputCache(options), /缓存无法读取/u);
      const rebuilt = await loadExternalInputCache({
        ...options,
        rebuild: true,
      });
      assert.equal(rebuilt.cacheState, "rebuilt");
      assert.equal(builds, 2);
      await assert.rejects(
        loadExternalInputCache({
          ...options,
          id: "unexpected-input",
          expectedSha256: "0".repeat(64),
        }),
        /转换输入散列不符/u,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
