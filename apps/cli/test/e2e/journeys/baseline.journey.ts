import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { CliJourney } from "../journey.ts";

const journey: CliJourney = {
  name: "baseline",
  modes: ["source", "distribution"],
  async setup({ workDir }) {
    await mkdir(path.join(workDir, "project"));
    await writeFile(
      path.join(workDir, "project", "lioni.config.ts"),
      `import { defineConfig } from "@lioni/core";

export default defineConfig({
  source: {
    schema: { "~standard": { version: 1, vendor: "baseline-journey", validate(value) {
      return typeof value === "object" && value !== null && typeof value.source === "string"
        ? { value }
        : { issues: [{ message: "原文单元结构不匹配。" }] };
    } } },
    read: () => ({ scopes: [{ range: "src/messages.json", enumeration: "complete", records: [] }] })
  },
  keyOf: (unit) => unit.source,
  translations: {
    languages: ["fr"],
    schema: { "~standard": { version: 1, vendor: "baseline-journey-translation", validate(value) {
      return typeof value === "object" && value !== null && typeof value.id === "string" && typeof value.text === "string"
        ? { value }
        : { issues: [{ message: "译文记录结构不匹配。" }] };
    } } },
    contentSchema: { "~standard": { version: 1, vendor: "baseline-journey-content", validate(value) {
      return typeof value === "string" ? { value } : { issues: [{ message: "译文正文必须是字符串。" }] };
    } } },
    read: () => ({ scopes: [{ range: "locales/fr.json", covers: [], enumeration: "complete", records: [] }] }),
    identityOf: (translation) => ({ namespace: "messages", key: translation.id }),
    contentOf: (translation) => translation.text
  }
});
`,
    );
    await writeFile(
      path.join(workDir, "project", "incomplete.config.ts"),
      `import { defineConfig } from "@lioni/core";

export default defineConfig({
  source: {
    schema: { "~standard": { version: 1, vendor: "baseline-journey", validate(value) {
      return typeof value === "object" && value !== null && typeof value.source === "string"
        ? { value }
        : { issues: [{ message: "原文单元结构不匹配。" }] };
    } } },
    read: () => ({ scopes: [{ range: "src/messages.json", enumeration: "partial", records: [] }] })
  },
  keyOf: (unit) => unit.source
});
`,
    );
  },
  commands() {
    return [
      {
        name: "record baseline beside explicit config",
        args: ["baseline", "project/lioni.config.ts"],
      },
      {
        name: "repeat unchanged baseline",
        args: ["baseline", "project/lioni.config.ts"],
      },
      {
        name: "readable baseline result",
        args: [
          "baseline",
          "project/lioni.config.ts",
          "--output-format",
          "text",
        ],
      },
      {
        name: "reject incomplete read without replacing baseline",
        args: ["baseline", "project/incomplete.config.ts"],
      },
    ];
  },
  async assertions({ context, results }) {
    const recorded = results[0];
    const unchanged = results[1];
    const readable = results[2];
    const incomplete = results[3];
    const baselinePath = path.join(
      context.workDir,
      "project",
      "lioni.baseline.json",
    );

    assert.equal(recorded?.exitCode, 0, recorded?.stderr);
    assert.equal(recorded?.stderr, "");
    assert.partialDeepStrictEqual(JSON.parse(recorded?.stdout ?? ""), {
      schemaVersion: "2",
      kind: "data",
      variant: "recorded",
      data: { outcome: "saved", path: baselinePath },
    });
    const savedContents = await readFile(baselinePath, "utf8");

    assert.equal(unchanged?.exitCode, 0, unchanged?.stderr);
    assert.partialDeepStrictEqual(JSON.parse(unchanged?.stdout ?? ""), {
      kind: "data",
      variant: "recorded",
      data: { outcome: "unchanged", path: baselinePath },
    });
    assert.equal(readable?.exitCode, 0, readable?.stderr);
    assert.equal(readable?.stderr, "");
    assert.ok(readable?.stdout.includes(`比较基线没有变化：${baselinePath}`));
    assert.equal(incomplete?.exitCode, 1);
    assert.equal(incomplete?.stdout, "");
    assert.partialDeepStrictEqual(JSON.parse(incomplete?.stderr ?? ""), {
      kind: "failure",
      variant: "recordFailed",
    });
    assert.equal(await readFile(baselinePath, "utf8"), savedContents);
    assert.equal(
      await readFile(
        path.join(context.workDir, "lioni.baseline.json"),
        "utf8",
      ).catch(() => undefined),
      undefined,
    );
  },
};

export default journey;
