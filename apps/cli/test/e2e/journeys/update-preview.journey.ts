import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { CliJourney } from "../journey.ts";

const journey: CliJourney = {
  name: "update-preview",
  modes: ["source", "distribution"],
  async setup({ workDir }) {
    await writeFile(
      path.join(workDir, "lioni.config.ts"),
      `import { defineConfig } from "@lioni/core";

export default defineConfig({
  source: {
    schema: { "~standard": { version: 1, vendor: "update-preview-journey", validate(value) {
      return typeof value === "object" && value !== null && typeof value.id === "string" && typeof value.source === "string"
        ? { value }
        : { issues: [{ message: "原文单元结构不匹配。" }] };
    } } },
    read: () => ({ scopes: [{
      range: "src/messages.json",
      enumeration: "complete",
      records: [{ value: { id: "welcome", source: "Welcome" }, bodyAvailability: "available" }]
    }] })
  },
  keyOf: (unit) => unit.id,
  sourceToContent: (source) => "待译：" + source,
  translations: {
    languages: ["fr"],
    schema: { "~standard": { version: 1, vendor: "update-preview-translation", validate(value) {
      return typeof value === "object" && value !== null && typeof value.targetId === "string" && typeof value.sourceId === "string" && typeof value.text === "string"
        ? { value }
        : { issues: [{ message: "译文记录结构不匹配。" }] };
    } } },
    contentSchema: { "~standard": { version: 1, vendor: "update-preview-content", validate(value) {
      return typeof value === "string" ? { value } : { issues: [{ message: "译文正文必须是字符串。" }] };
    } } },
    identityOf: (translation) => ({ namespace: "messages", key: translation.targetId }),
    contentOf: (translation) => translation.text,
    matches: (unit, translation) => unit.id === translation.sourceId,
    read: (_language, sourceUnits) => ({ scopes: [{
      range: "locales/fr.json",
      covers: sourceUnits.map(({ key }) => key),
      enumeration: "complete",
      records: []
    }] })
  }
});
`,
    );
  },
  commands() {
    return [
      {
        name: "preview missing translation as a placeholder",
        args: ["update", "lioni.config.ts", "--dry-run"],
      },
      {
        name: "render preview decisions as text",
        args: [
          "update",
          "lioni.config.ts",
          "--dry-run",
          "--output-format",
          "text",
        ],
      },
      {
        name: "require the explicit preview flag in this stage",
        args: ["update", "lioni.config.ts"],
      },
    ];
  },
  async assertions({ context, results }) {
    const structured = results[0];
    const readable = results[1];
    const withoutFlag = results[2];
    const baselinePath = path.join(context.workDir, "lioni.baseline.json");

    assert.equal(structured?.exitCode, 0, structured?.stderr);
    assert.equal(structured?.stderr, "");
    const output = JSON.parse(structured?.stdout ?? "unknown");
    assert.equal(output.kind, "data");
    assert.equal(output.variant, "previewed");
    const write = output.data.items.find(
      (item: { action: string }) => item.action === "write",
    );
    assert.deepStrictEqual(write.request, {
      operation: "write",
      target: { sourceKey: "welcome", language: "fr" },
      content: "待译：Welcome",
      expectedSource: {
        presence: "present",
        key: "welcome",
        unit: { id: "welcome", source: "Welcome" },
        content: "Welcome",
        range: "src/messages.json",
      },
      expectedTarget: { status: "missing" },
    });
    assert.equal(readable?.exitCode, 0, readable?.stderr);
    assert.equal(readable?.stderr, "");
    assert.ok(readable?.stdout.includes("更新预览"));
    assert.ok(readable?.stdout.includes("补入待译占位"));
    assert.ok(readable?.stdout.includes("待译：Welcome"));
    assert.equal(withoutFlag?.exitCode, 1);
    assert.equal(withoutFlag?.stdout, "");
    assert.match(withoutFlag?.stderr ?? "", /previewFailed/);
    assert.equal(
      await readFile(baselinePath, "utf8").catch(() => undefined),
      undefined,
    );
  },
};

export default journey;
