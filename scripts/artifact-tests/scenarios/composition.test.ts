import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { testArtifactConsumer } from "../support/consumer.ts";

const packages = [
  "@lioni/cli",
  "@lioni/checks",
  "@lioni/core",
  "@lioni/memo",
  "@lioni/terminology",
  "@lioni/text-analysis",
];

testArtifactConsumer(
  {
    name: "异构输入组合与配置 QA 正式制品消费者",
    packages,
    fixtures: new URL("../fixtures/composition/", import.meta.url),
  },
  async ({ root, runCommand, runNode, typecheck }) => {
    await typecheck();
    await mkdir(path.join(root, "composition-state"), { recursive: true });

    const preparedProcess = await runNode("composition-host.ts", ["prepare"]);
    const prepared = JSON.parse(preparedProcess.stdout) as {
      readonly status: string;
      readonly version: string;
      readonly candidateCount: number;
    };
    assert.equal(prepared.status, "prepared");
    assert.equal(prepared.candidateCount, 2);

    const executable = path.join(
      root,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "lioni.cmd" : "lioni",
    );
    const initialQa = await runCommand(executable, [
      "qa",
      "composition.config.ts",
    ]);
    const initialResult = JSON.parse(initialQa.stdout).data as {
      readonly status: string;
      readonly version: string;
      readonly candidates: readonly unknown[];
      readonly diagnostics: readonly {
        readonly checkId: string;
        readonly handling: { readonly status: string };
      }[];
      readonly checks: readonly {
        readonly checkId: string;
        readonly executions: readonly QaExecution[];
      }[];
    };
    assert.equal(initialResult.status, "complete");
    assert.equal(initialResult.version, prepared.version);
    assert.equal(initialResult.candidates.length, 2);
    assert.equal(
      initialResult.diagnostics.find(
        ({ checkId }) => checkId === "catalog-numbers",
      )?.handling.status,
      "active",
    );
    assert.equal(
      initialResult.diagnostics.find(
        ({ checkId }) => checkId === "guide-numbers",
      )?.handling.status,
      "active",
    );

    const catalogExecution = initialResult.checks
      .find(({ checkId }) => checkId === "catalog-numbers")
      ?.executions.find(
        ({ sourceKey, language }) =>
          sourceKey === "catalog:save" && language === "fr",
      );
    assert.ok(catalogExecution?.inputFingerprint);
    assert.ok(catalogExecution.fingerprintSummary);
    const exceptionPath = path.join(root, "lioni.exceptions.yaml");
    await writeFile(
      exceptionPath,
      exceptionsYaml([
        exceptionYaml(
          "catalog-approved-numbers",
          "目录中的数字差异由维护者单独确认。",
          catalogExecution,
        ),
      ]),
      "utf8",
    );

    const exceptedQa = await runCommand(executable, [
      "qa",
      "composition.config.ts",
    ]);
    const exceptedResult = JSON.parse(exceptedQa.stdout).data as {
      readonly diagnostics: readonly {
        readonly checkId: string;
        readonly handling: { readonly status: string };
      }[];
    };
    assert.equal(
      exceptedResult.diagnostics.find(
        ({ checkId }) => checkId === "catalog-numbers",
      )?.handling.status,
      "excepted",
    );
    assert.equal(
      exceptedResult.diagnostics.find(
        ({ checkId }) => checkId === "guide-numbers",
      )?.handling.status,
      "active",
    );

    const guidePath = path.join(root, "composition", "guide-fr.json");
    const guideResource = JSON.parse(await readFile(guidePath, "utf8")) as {
      enumeration: string;
      messages: Array<{ content: string }>;
    };
    const guideTarget = guideResource.messages[0];
    assert.ok(guideTarget);
    guideTarget.content = "Sauver";
    await writeFile(guidePath, JSON.stringify(guideResource), "utf8");

    const updatedQa = await runCommand(executable, [
      "qa",
      "composition.config.ts",
    ]);
    const updatedResult = JSON.parse(updatedQa.stdout).data as {
      readonly status: string;
      readonly version: string;
      readonly diagnostics: readonly {
        readonly checkId: string;
        readonly handling: { readonly status: string };
      }[];
      readonly exceptionApplicability: readonly {
        readonly exceptionId: string;
        readonly status: string;
      }[];
    };
    assert.equal(updatedResult.status, "complete");
    assert.notEqual(updatedResult.version, initialResult.version);
    assert.equal(
      updatedResult.diagnostics.find(
        ({ checkId }) => checkId === "guide-numbers",
      )?.handling.status,
      "active",
    );
    assert.equal(
      updatedResult.diagnostics.find(
        ({ checkId }) => checkId === "catalog-numbers",
      )?.handling.status,
      "active",
    );
    const catalogApplicability = updatedResult.exceptionApplicability.find(
      ({ exceptionId }) => exceptionId === "catalog-approved-numbers",
    );
    assert.equal(catalogApplicability?.status, "basis-changed");

    const observedProcess = await runNode("composition-host.ts", ["observe"]);
    const observation = JSON.parse(observedProcess.stdout) as {
      readonly status: string;
      readonly version: string;
      readonly guideChange: string;
    };
    assert.equal(observation.status, "observed");
    assert.equal(observation.version, updatedResult.version);
    assert.equal(observation.guideChange, "changed");
  },
);

type QaExecution = {
  readonly checkId: string;
  readonly sourceKey: string;
  readonly language: string;
  readonly inputFingerprint: string;
  readonly fingerprintSummary: {
    readonly version: string;
    readonly configurationFingerprint: string;
    readonly inputFingerprint: string;
  };
};

function exceptionYaml(
  id: string,
  reason: string,
  execution: QaExecution,
): string {
  return [
    `  - id: ${id}`,
    `    reason: ${JSON.stringify(reason)}`,
    `    checkId: ${execution.checkId}`,
    `    sourceKey: ${execution.sourceKey}`,
    `    language: ${execution.language}`,
    `    inputFingerprint: ${execution.inputFingerprint}`,
    "    fingerprintSummary:",
    `      version: ${JSON.stringify(execution.fingerprintSummary.version)}`,
    `      configurationFingerprint: ${execution.fingerprintSummary.configurationFingerprint}`,
    `      inputFingerprint: ${execution.fingerprintSummary.inputFingerprint}`,
  ].join("\n");
}

function exceptionsYaml(records: readonly string[]): string {
  return ["format: lioni.qa-exceptions/v1", "exceptions:", ...records, ""].join(
    "\n",
  );
}
