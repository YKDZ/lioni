import { readFile, writeFile } from "node:fs/promises";

import type { CfpaPreparedInput } from "./corpora/convert.ts";
import { runControlledScenario } from "./scenarios/controlled.ts";
import { runCfpaScenario } from "./scenarios/external.ts";
import type { ScenarioReport } from "./support/types.ts";

async function main(): Promise<void> {
  const [name, inputPath, outputPath, inputSha256, generatedCount] =
    process.argv.slice(2);
  if (!outputPath || (name !== "controlled" && !inputPath))
    throw new Error("worker 用法：<controlled|cfpa> [输入 JSON] <输出 JSON>");

  let result: ScenarioReport;
  if (name === "controlled")
    result = await runControlledScenario(
      generatedCount === undefined ? undefined : Number(generatedCount),
    );
  else {
    const input = JSON.parse(await readFile(inputPath!, "utf8")) as unknown;
    if (name === "cfpa")
      result = await runCfpaScenario(input as CfpaPreparedInput, inputSha256!);
    else throw new Error(`未知评估场景：${name}`);
  }
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
}

main().catch((error: unknown) => {
  process.stderr.write(
    `评估场景失败：${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
