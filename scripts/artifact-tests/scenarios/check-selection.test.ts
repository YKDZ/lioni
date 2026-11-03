import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { QualityRunResult } from "@lioni/lioni";

import { testArtifactConsumer } from "../support/consumer.ts";

type CapturedRun = {
  readonly result?: QualityRunResult;
  readonly report?: string;
  readonly error?: string;
  readonly events: readonly string[];
};

type SdkEvidence = {
  readonly full: CapturedRun;
  readonly direct: CapturedRun;
  readonly duplicateIds: CapturedRun;
  readonly groupUnion: CapturedRun;
  readonly termsOnly: CapturedRun;
  readonly invalidSelections: Readonly<Record<string, CapturedRun>>;
  readonly candidates: Readonly<Record<string, CapturedRun>>;
  readonly changedDependency: CapturedRun;
  readonly isolatedLoaderFailure: CapturedRun;
  readonly sharedLoaderFailure: CapturedRun;
  readonly loaderContractError: CapturedRun;
  readonly readerContractError: CapturedRun;
  readonly candidateBuilderFailure: CapturedRun;
};

function checkIds(run: CapturedRun): readonly string[] {
  assert.ok(run.result, run.error);
  return run.result.checkScope.selectedIds;
}

function eventCount(run: CapturedRun, event: string): number {
  return run.events.filter((item) => item === event).length;
}

async function clearEvents(root: string): Promise<void> {
  await writeFile(path.join(root, ".check-selection-events.jsonl"), "", "utf8");
}

async function eventsIn(root: string): Promise<string[]> {
  try {
    return (
      await readFile(path.join(root, ".check-selection-events.jsonl"), "utf8")
    )
      .split("\n")
      .filter((event) => event.length > 0);
  } catch {
    return [];
  }
}

testArtifactConsumer(
  {
    name: "正式制品中的 SDK 与 CLI 检查项选择",
    fixtures: new URL("../fixtures/check-selection/", import.meta.url),
  },
  async ({ root, runNode, runProcess, typecheck }) => {
    await typecheck();
    const sdk = JSON.parse(
      (await runNode("consumer.ts")).stdout,
    ) as SdkEvidence;

    assert.deepEqual(checkIds(sdk.full), ["syntax", "terms", "unlisted"]);
    assert.deepEqual(sdk.full.result?.checkScope, {
      configuredCount: 3,
      selectedIds: ["syntax", "terms", "unlisted"],
    });
    assert.equal(eventCount(sdk.full, "shared:read"), 1);
    assert.equal(eventCount(sdk.full, "compile:shared:v1"), 1);
    assert.ok(sdk.full.events.includes("loader:syntax"));
    assert.ok(sdk.full.events.includes("loader:terms"));
    assert.ok(sdk.full.events.includes("loader:unlisted"));
    assert.ok(sdk.full.events.includes("rule:syntax:normalized-v1"));
    assert.match(
      sdk.full.report ?? "",
      /检查项范围：配置 3 项，本次全量 3 项（syntax、terms、unlisted）/u,
    );
    assert.match(sdk.full.report ?? "", /候选范围：已选候选 1 条/u);

    assert.deepEqual(checkIds(sdk.direct), ["syntax"]);
    assert.ok(!sdk.direct.events.includes("configuration:terms"));
    assert.ok(!sdk.direct.events.includes("loader:terms"));
    assert.ok(!sdk.direct.events.includes("rule:terms:normalized-v1"));
    assert.equal(eventCount(sdk.direct, "shared:read"), 1);
    assert.equal(eventCount(sdk.direct, "compile:shared:v1"), 1);
    assert.equal(
      sdk.full.result?.checks.find(({ checkId }) => checkId === "syntax")
        ?.executions[0]?.inputFingerprint,
      sdk.direct.result?.checks[0]?.executions[0]?.inputFingerprint,
    );
    assert.equal(
      sdk.direct.result?.diagnostics[0]?.handling.status,
      "excepted",
    );
    assert.equal(
      sdk.direct.result?.exceptionApplicability.find(
        ({ checkId }) => checkId === "syntax",
      )?.status,
      "applicable",
    );
    assert.ok(!sdk.direct.events.includes("rule:syntax:normalized-v1"));
    assert.match(
      sdk.direct.report ?? "",
      /检查项范围：配置 3 项，本次子集 1 项（syntax）/u,
    );

    assert.deepEqual(checkIds(sdk.duplicateIds), ["syntax", "terms"]);
    assert.deepEqual(checkIds(sdk.groupUnion), ["syntax", "terms"]);
    assert.equal(eventCount(sdk.groupUnion, "compile:shared:v1"), 1);
    assert.ok(!sdk.groupUnion.events.includes("configuration:unlisted"));
    assert.ok(!sdk.groupUnion.events.includes("loader:unlisted"));
    assert.ok(!sdk.groupUnion.events.includes("rule:unlisted:normalized-v1"));
    assert.ok(!sdk.groupUnion.events.includes("rule:syntax:normalized-v1"));
    assert.ok(!sdk.groupUnion.events.includes("rule:terms:normalized-v1"));
    assert.equal(
      sdk.groupUnion.result?.checks.find(({ checkId }) => checkId === "syntax")
        ?.executions[0]?.inputFingerprint,
      sdk.direct.result?.checks[0]?.executions[0]?.inputFingerprint,
    );
    assert.equal(
      sdk.groupUnion.result?.diagnostics[0]?.handling.status,
      "excepted",
    );

    assert.deepEqual(checkIds(sdk.termsOnly), ["terms"]);
    assert.equal(
      sdk.termsOnly.result?.exceptionApplicability.find(
        ({ checkId }) => checkId === "syntax",
      )?.status,
      "not-verified",
    );
    assert.equal(
      sdk.termsOnly.result?.exceptionApplicability.find(
        ({ checkId }) => checkId === "syntax",
      )?.reason,
      "not-run",
    );

    for (const invalid of Object.values(sdk.invalidSelections)) {
      assert.ok(invalid.error);
      assert.equal(invalid.events.length, 0);
    }

    const { noBuiltCandidates, noProvidedCandidates, explicitCandidates } =
      sdk.candidates;
    assert.ok(noBuiltCandidates.result);
    assert.equal(noBuiltCandidates.result.candidates.length, 0);
    assert.equal(noBuiltCandidates.result.status, "not-run");
    assert.ok(
      !noBuiltCandidates.events.some((event) => event.startsWith("loader:")),
    );
    assert.ok(
      !noBuiltCandidates.events.some((event) => event.startsWith("rule:")),
    );
    assert.ok(!noProvidedCandidates.events.includes("candidate:build"));
    assert.ok(
      !noProvidedCandidates.events.some((event) => event.startsWith("loader:")),
    );
    assert.ok(
      !noProvidedCandidates.events.some((event) => event.startsWith("rule:")),
    );
    assert.ok(explicitCandidates.result);
    assert.equal(explicitCandidates.result.candidates.length, 1);
    assert.ok(!explicitCandidates.events.includes("candidate:build"));
    assert.equal(eventCount(explicitCandidates, "shared:read"), 1);
    assert.equal(eventCount(explicitCandidates, "compile:shared:v1"), 0);
    assert.ok(
      !explicitCandidates.events.some((event) => event.startsWith("rule:")),
    );

    assert.ok(sdk.changedDependency.result);
    assert.notEqual(
      sdk.changedDependency.result.checks[0]?.executions[0]?.inputFingerprint,
      sdk.direct.result?.checks[0]?.executions[0]?.inputFingerprint,
    );
    assert.ok(
      sdk.changedDependency.events.includes("rule:syntax:normalized-v2"),
    );
    assert.equal(eventCount(sdk.changedDependency, "compile:shared:v2"), 1);
    assert.equal(
      sdk.changedDependency.result.exceptionApplicability.find(
        ({ checkId }) => checkId === "syntax",
      )?.status,
      "basis-changed",
    );

    assert.ok(sdk.isolatedLoaderFailure.result);
    assert.deepEqual(
      sdk.isolatedLoaderFailure.result.checks.map(({ checkId, status }) => ({
        checkId,
        status,
      })),
      [
        { checkId: "syntax", status: "complete" },
        { checkId: "terms", status: "failed" },
        { checkId: "unlisted", status: "complete" },
      ],
    );
    assert.ok(
      sdk.isolatedLoaderFailure.events.includes("rule:syntax:normalized-v3"),
    );
    assert.ok(
      sdk.isolatedLoaderFailure.events.includes("rule:unlisted:normalized-v3"),
    );

    assert.ok(sdk.sharedLoaderFailure.result);
    assert.equal(eventCount(sdk.sharedLoaderFailure, "shared:read"), 1);
    assert.deepEqual(
      sdk.sharedLoaderFailure.result.checks.map(({ checkId, status }) => ({
        checkId,
        status,
      })),
      [
        { checkId: "syntax", status: "failed" },
        { checkId: "terms", status: "failed" },
        { checkId: "unlisted", status: "complete" },
      ],
    );
    assert.ok(
      sdk.sharedLoaderFailure.events.includes("rule:unlisted:normalized-v4"),
    );
    assert.ok(
      !sdk.sharedLoaderFailure.events.some((event) =>
        event.startsWith("rule:syntax:"),
      ),
    );
    assert.ok(
      !sdk.sharedLoaderFailure.events.some((event) =>
        event.startsWith("rule:terms:"),
      ),
    );

    assert.ok(sdk.loaderContractError.error);
    assert.ok(
      !sdk.loaderContractError.events.some((event) =>
        event.startsWith("rule:"),
      ),
    );
    assert.ok(sdk.readerContractError.error);
    assert.ok(
      !sdk.readerContractError.events.some((event) =>
        event.startsWith("rule:"),
      ),
    );
    assert.ok(sdk.candidateBuilderFailure.error);
    assert.ok(
      !sdk.candidateBuilderFailure.events.some((event) =>
        event.startsWith("loader:"),
      ),
    );
    assert.ok(
      !sdk.candidateBuilderFailure.events.some((event) =>
        event.startsWith("rule:"),
      ),
    );

    const executable = path.join(
      root,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "lioni.cmd" : "lioni",
    );
    const cli = (...args: string[]) =>
      runProcess(executable, ["qa", "lioni.config.ts", ...args]);

    await clearEvents(root);
    const fullText = await cli();
    assert.equal(fullText.status, 0);
    assert.match(
      fullText.stdout,
      /检查项范围：配置 3 项，本次全量 3 项（syntax、terms、unlisted）/u,
    );
    assert.match(fullText.stdout, /候选范围：已选候选 1 条/u);

    await clearEvents(root);
    const oneCheck = await cli("--check", "terms");
    assert.equal(oneCheck.status, 0);
    assert.match(
      oneCheck.stdout,
      /检查项范围：配置 3 项，本次子集 1 项（terms）/u,
    );
    const oneCheckEvents = await eventsIn(root);
    assert.ok(!oneCheckEvents.includes("configuration:syntax"));
    assert.ok(!oneCheckEvents.includes("loader:syntax"));
    assert.ok(
      !oneCheckEvents.some((event) => event.startsWith("rule:syntax:")),
    );

    await clearEvents(root);
    const grouped = await cli(
      "--group",
      "daily",
      "--group",
      "syntaxOnly",
      "--output-format",
      "structured",
    );
    assert.equal(grouped.status, 0);
    const groupedResult = (
      JSON.parse(grouped.stdout) as { readonly data: QualityRunResult }
    ).data;
    assert.deepEqual(groupedResult.checkScope, {
      configuredCount: 3,
      selectedIds: ["syntax", "terms"],
    });
    assert.ok(
      !groupedResult.checks.some(({ checkId }) => checkId === "unlisted"),
    );

    await rm(path.join(root, "lioni.exceptions.yaml"), { force: true });
    await clearEvents(root);
    const failingSubset = await cli("--check", "syntax");
    assert.equal(failingSubset.status, 1);
    assert.match(
      failingSubset.stdout,
      /检查项范围：配置 3 项，本次子集 1 项（syntax）/u,
    );

    for (const invalidArgs of [
      ["--check", "missing"],
      ["--group", "all"],
      ["--check", "syntax", "--group", "daily"],
    ]) {
      await clearEvents(root);
      const invalid = await cli(...invalidArgs);
      assert.notEqual(invalid.status, 0);
      assert.deepEqual(await eventsIn(root), []);
    }
  },
);
