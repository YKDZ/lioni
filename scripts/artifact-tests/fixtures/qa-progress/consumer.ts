import assert from "node:assert/strict";

import { decideQualityReport, defineChecker, runQa, type QualityFinding } from "@lioni/lioni";
import { loadConfig } from "@lioni/lioni/node";
import * as z from "zod";

const mode = process.argv[2];
const config = await loadConfig(mode === "zero" ? "no-checks.config.ts" : "lioni.config.ts");
if (mode === "draft") {
  const report = await runQa(config, {
    candidates: [{ sourceKey: "button", language: "fr", content: "Ouvrir" }],
  });
  assert.equal(report.progress, undefined);
  assert.equal(report.diagnostics.length, 0);
} else if (mode === "zero") {
  const report = await runQa(config);
  assert.equal(report.checkScope.configuredCount, 0);
  assert.deepEqual(report.progress, [
    { language: "fr", completed: 10, total: 10, percentage: 100 },
  ]);
  assert.equal(decideQualityReport(report).status, "no-checks");
  process.stdout.write(JSON.stringify(report));
} else if (mode === "severity") {
  // 同一项有两条诊断仍只扣一项，提示和警告都影响进度。
  const report = await runQa({
    ...config,
    quality: {
      checks: [
        defineChecker({
          id: "tone",
          version: "1",
          inputSchema: z.object({ key: z.string(), language: z.string() }),
          prepare: ({ association }) => ({
            key: association.sourceKey,
            language: association.language,
          }),
          check: (subject): readonly QualityFinding[] =>
            subject.key === "brand"
              ? []
              : (subject.key === "button"
                  ? (["info", "warning"] as const)
                  : (["info"] as const)
                ).map((severity) => ({
                  severity,
                  object: { kind: "translation-unit", ...subject },
                  location: { ...subject, range: null },
                  message: "待复核。",
                  evidence: [],
                })),
        }),
      ],
    },
  });
  assert.equal(report.diagnostics.length, 3);
  assert.equal(report.progress?.[0]?.completed, 1);
} else {
  process.stdout.write(JSON.stringify(await runQa(config)));
}
