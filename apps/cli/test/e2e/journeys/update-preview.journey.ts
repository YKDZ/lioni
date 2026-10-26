import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { readComparisonSnapshot, replaceComparisonBaseline } from "@lioni/core";
import { loadConfig } from "@lioni/core/node";

import type { CliJourney } from "../journey.ts";

function configSource(
  sources: readonly { readonly id: string; readonly source: string }[],
  _translations: readonly {
    readonly targetId: string;
    readonly sourceId: string;
    readonly text: string;
  }[],
  options: { readonly noDecisions?: boolean } = {},
): string {
  return `import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@lioni/core";

const translationsPath = fileURLToPath(new URL("./lioni.translations.json", import.meta.url));

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
  ${options.noDecisions === true ? "updatePolicy: () => []," : ""}
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
      records: JSON.parse(readFileSync(translationsPath, "utf8")).map((value) => ({ value, bodyAvailability: "available" }))
    }] })
  },
  translationWriteback: {
    locateExistingTarget: ({ translation }) => ({ status: "located", locator: translation.translation.targetId }),
    locateNewTarget: ({ sourceKey }) => ({ status: "located", locator: sourceKey }),
    write: ({ request, target }) => {
      if (request.operation !== "write") throw new Error("仅支持译文写入。");
      const records = JSON.parse(readFileSync(translationsPath, "utf8"));
      const id = String(target.locator);
      const existing = records.find((record) => record.targetId === id);
      if (existing === undefined) {
        const sourceId = "sourceKey" in request.target ? request.target.sourceKey : request.target.identity.key;
        records.push({ targetId: id, sourceId, text: request.content });
      } else existing.text = request.content;
      writeFileSync(translationsPath, JSON.stringify(records) + "\\n");
    }
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
    await writeFile(path.join(workDir, "lioni.translations.json"), "[]\n");

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
    await writeFile(
      path.join(removedDir, "lioni.translations.json"),
      `${JSON.stringify([
        {
          targetId: "target-welcome",
          sourceId: "welcome",
          text: "Bienvenue",
        },
      ])}\n`,
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
    const unchangedConfigPath = path.join(emptyDir, "previous.config.ts");
    const unchangedSources = [{ id: "welcome", source: "Welcome" }];
    const unchangedTranslations = [
      {
        targetId: "target-welcome",
        sourceId: "welcome",
        text: "Bienvenue",
      },
    ];
    await writeFile(
      unchangedConfigPath,
      configSource(unchangedSources, unchangedTranslations),
    );
    await writeFile(
      path.join(emptyDir, "lioni.config.ts"),
      configSource(unchangedSources, unchangedTranslations, {
        noDecisions: true,
      }),
    );
    await writeFile(
      path.join(emptyDir, "lioni.translations.json"),
      `${JSON.stringify(unchangedTranslations)}\n`,
    );
    const unchangedConfig = await loadConfig(unchangedConfigPath);
    const unchangedSnapshot = await unchangedConfig.use((config) =>
      readComparisonSnapshot(config),
    );
    await writeFile(
      path.join(emptyDir, "lioni.baseline.json"),
      `${JSON.stringify(replaceComparisonBaseline({ current: unchangedSnapshot }))}\n`,
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
        name: "execute the planned write through the host adapter",
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
        name: "describe a preview with no changes or decisions",
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
    const applied = results[2];
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
    assert.equal(applied?.exitCode, 0, applied?.stderr);
    assert.equal(applied?.stderr, "");
    const execution = JSON.parse(applied?.stdout ?? "unknown");
    assert.equal(execution.variant, "applied");
    assert.equal(execution.data.status, "completed");
    assert.equal(execution.data.results[0]?.status, "written");
    assert.deepStrictEqual(
      JSON.parse(
        await readFile(
          path.join(context.workDir, "lioni.translations.json"),
          "utf8",
        ),
      ),
      [{ targetId: "welcome", sourceId: "welcome", text: "待译：Welcome" }],
    );
    assert.equal(detachedChanges?.exitCode, 0, detachedChanges?.stderr);
    assert.equal(detachedChanges?.stderr, "");
    assert.ok(detachedChanges?.stdout.includes("移除"));
    assert.ok(detachedChanges?.stdout.includes("Welcome"));
    assert.ok(detachedChanges?.stdout.includes("Bienvenue"));
    assert.ok(detachedChanges?.stdout.includes("未形成更新决定"));
    assert.ok(
      detachedChanges?.stdout.includes(
        "原因：原文已从完整范围移除，当前没有对应记录可供处理。",
      ),
    );
    assert.ok(
      detachedChanges?.stdout.includes(
        "原因：译文已从完整范围移除，当前没有对应记录可供处理。",
      ),
    );
    assert.equal(empty?.exitCode, 0, empty?.stderr);
    assert.equal(empty?.stdout.trim(), "没有变化，也没有需要处理的更新决定。");
    assert.equal(
      await readFile(baselinePath, "utf8").catch(() => undefined),
      undefined,
    );
  },
};

export default journey;
