import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { readComparisonSnapshot, replaceComparisonBaseline } from "@lioni/core";
import { loadConfig } from "@lioni/core/node";

import type { CliJourney } from "../journey.ts";

function configSource(
  sources: readonly { readonly id: string; readonly source: string }[],
  translations: readonly {
    readonly targetId: string;
    readonly sourceId: string;
    readonly text: string;
  }[],
): string {
  return `import { defineConfig } from "@lioni/core";

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
      records: ${JSON.stringify(sources)}.map((value) => ({ value, bodyAvailability: "available" }))
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
      records: ${JSON.stringify(translations)}.map((value) => ({ value, bodyAvailability: "available" }))
    }] })
  }
});
`;
}

const journey: CliJourney = {
  name: "update-preview",
  modes: ["source", "distribution"],
  async setup({ workDir }) {
    await writeFile(
      path.join(workDir, "lioni.config.ts"),
      configSource([{ id: "welcome", source: "Welcome" }], []),
    );

    const removedDir = path.join(workDir, "removed");
    await mkdir(removedDir);
    const previousConfigPath = path.join(removedDir, "previous.config.ts");
    await writeFile(
      previousConfigPath,
      configSource(
        [{ id: "welcome", source: "Welcome" }],
        [
          {
            targetId: "target-welcome",
            sourceId: "welcome",
            text: "Bienvenue",
          },
        ],
      ),
    );
    await writeFile(
      path.join(removedDir, "lioni.config.ts"),
      configSource([], []),
    );
    const previousConfig = await loadConfig(previousConfigPath);
    const snapshot = await previousConfig.use((config) =>
      readComparisonSnapshot(config),
    );
    const baseline = replaceComparisonBaseline({ current: snapshot });
    await writeFile(
      path.join(removedDir, "lioni.baseline.json"),
      `${JSON.stringify(baseline)}\n`,
    );

    const emptyDir = path.join(workDir, "empty");
    await mkdir(emptyDir);
    await writeFile(
      path.join(emptyDir, "lioni.config.ts"),
      configSource([], []),
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
      {
        name: "show comparison changes without decisions",
        args: [
          "update",
          "removed/lioni.config.ts",
          "--dry-run",
          "--output-format",
          "text",
        ],
      },
      {
        name: "describe an actually empty preview",
        args: [
          "update",
          "empty/lioni.config.ts",
          "--dry-run",
          "--output-format",
          "text",
        ],
      },
    ];
  },
  async assertions({ context, results }) {
    const structured = results[0];
    const readable = results[1];
    const withoutFlag = results[2];
    const detachedChanges = results[3];
    const empty = results[4];
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
    assert.equal(detachedChanges?.exitCode, 0, detachedChanges?.stderr);
    assert.equal(detachedChanges?.stderr, "");
    assert.ok(detachedChanges?.stdout.includes("移除"));
    assert.ok(detachedChanges?.stdout.includes("Welcome"));
    assert.ok(detachedChanges?.stdout.includes("Bienvenue"));
    assert.ok(detachedChanges?.stdout.includes("未形成更新决定"));
    assert.equal(empty?.exitCode, 0, empty?.stderr);
    assert.equal(empty?.stdout.trim(), "没有变化，也没有需要处理的更新决定。");
    assert.equal(
      await readFile(baselinePath, "utf8").catch(() => undefined),
      undefined,
    );
  },
};

export default journey;
