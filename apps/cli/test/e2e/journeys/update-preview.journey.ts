import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { readComparisonSnapshot, replaceComparisonBaseline } from "@lioni/core";
import { loadConfig } from "@lioni/core/node";

import type { CliJourney } from "../journey.ts";

const expectedModifiedBaselineByWorkDir = new Map<string, string>();

function configSource(
  sources: readonly { readonly id: string; readonly source: string }[],
  _translations: readonly {
    readonly targetId: string;
    readonly sourceId: string;
    readonly text: string;
  }[],
  options: {
    readonly noDecisions?: boolean;
    readonly writeUnconfirmed?: boolean;
  } = {},
): string {
  return `import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@lioni/core";

const translationsPath = fileURLToPath(new URL("./lioni.translations.json", import.meta.url));
const writeLogPath = fileURLToPath(new URL("./lioni.writes.log", import.meta.url));

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
  createPlaceholderContent: (source) => "待译：" + source,
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
      if (${options.writeUnconfirmed === true}) return;
      const records = JSON.parse(readFileSync(translationsPath, "utf8"));
      const id = String(target.locator);
      const existing = records.find((record) => record.targetId === id);
      if (existing === undefined) {
        const sourceId = "sourceKey" in request.target ? request.target.sourceKey : request.target.identity.key;
        records.push({ targetId: id, sourceId, text: request.content });
      } else existing.text = request.content;
      writeFileSync(translationsPath, JSON.stringify(records) + "\\n");
      appendFileSync(writeLogPath, "write\\n");
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
    const snapshot = await readComparisonSnapshot(previousConfig);
    const baseline = replaceComparisonBaseline({ current: snapshot });
    await writeFile(
      path.join(removedDir, "lioni.baseline.json"),
      `${JSON.stringify(baseline)}\n`,
    );
    await writeFile(path.join(removedDir, "lioni.translations.json"), "[]\n");

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
    const unchangedSnapshot = await readComparisonSnapshot(unchangedConfig);
    await writeFile(
      path.join(emptyDir, "lioni.baseline.json"),
      `${JSON.stringify(replaceComparisonBaseline({ current: unchangedSnapshot }))}\n`,
    );

    const modifiedDir = path.join(workDir, "modified");
    await mkdir(modifiedDir);
    const oldTranslations = [
      {
        targetId: "target-welcome",
        sourceId: "welcome",
        text: "人工译文",
      },
    ];
    await writeFile(
      path.join(modifiedDir, "lioni.translations.json"),
      `${JSON.stringify(oldTranslations)}\n`,
    );
    const oldConfigPath = path.join(modifiedDir, "previous.config.ts");
    await writeFile(
      oldConfigPath,
      configSource([{ id: "welcome", source: "Welcome" }], oldTranslations),
    );
    await writeFile(
      path.join(modifiedDir, "lioni.config.ts"),
      configSource(
        [{ id: "welcome", source: "Welcome back" }],
        oldTranslations,
      ),
    );
    const oldConfig = await loadConfig(oldConfigPath);
    const oldSnapshot = await readComparisonSnapshot(oldConfig);
    const modifiedBaseline = replaceComparisonBaseline({
      current: oldSnapshot,
    });
    const modifiedBaselineText = `${JSON.stringify(modifiedBaseline)}\n`;
    await writeFile(
      path.join(modifiedDir, "lioni.baseline.json"),
      modifiedBaselineText,
    );
    expectedModifiedBaselineByWorkDir.set(workDir, modifiedBaselineText);

    const unconfirmedDir = path.join(workDir, "unconfirmed");
    await mkdir(unconfirmedDir);
    await writeFile(
      path.join(unconfirmedDir, "lioni.config.ts"),
      configSource([{ id: "welcome", source: "Welcome" }], [], {
        writeUnconfirmed: true,
      }),
    );
    await writeFile(
      path.join(unconfirmedDir, "lioni.translations.json"),
      "[]\n",
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
      {
        name: "render retained execution results as text",
        args: ["update", "lioni.config.ts", "--output-format", "text"],
      },
      {
        name: "render an unconfirmed write as text",
        args: [
          "update",
          "unconfirmed/lioni.config.ts",
          "--output-format",
          "text",
        ],
      },
      {
        name: "keep machine status in structured execution results",
        args: ["update", "unconfirmed/lioni.config.ts"],
      },
      {
        name: "preview a modified source reset",
        args: [
          "update",
          "modified/lioni.config.ts",
          "--dry-run",
          "--output-format",
          "text",
        ],
      },
      {
        name: "execute the modified source reset through the host adapter",
        args: ["update", "modified/lioni.config.ts"],
      },
    ];
  },
  async assertions({ context, results }) {
    const structured = results[0];
    const readable = results[1];
    const applied = results[2];
    const detachedChanges = results[3];
    const empty = results[4];
    const retained = results[5];
    const unconfirmedText = results[6];
    const unconfirmedStructured = results[7];
    const modifiedPreview = results[8];
    const modifiedApplied = results[9];
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
    assert.ok(
      detachedChanges?.stdout.includes("0 项决定，2 项变化未形成决定。"),
    );
    assert.ok(
      detachedChanges?.stdout.includes('原文 welcome（移除）："Welcome" → 无'),
    );
    assert.ok(
      detachedChanges?.stdout.includes(
        '译文 target-welcome（移除）："Bienvenue" → 无',
      ),
    );
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
    assert.equal(retained?.exitCode, 0, retained?.stderr);
    assert.ok(retained?.stdout.includes("已保留"));
    assert.equal(retained?.stdout.includes("retained"), false);
    assert.equal(retained?.stdout.includes("retain"), false);
    assert.equal(unconfirmedText?.exitCode, 1);
    assert.equal(unconfirmedText?.stdout, "");
    assert.ok(unconfirmedText?.stderr.includes("写入"));
    assert.ok(unconfirmedText?.stderr.includes("未确认"));
    assert.equal(unconfirmedText?.stderr.includes("writeUnconfirmed"), false);
    assert.equal(unconfirmedStructured?.exitCode, 1);
    const structuredFailure = JSON.parse(
      unconfirmedStructured?.stdout ||
        unconfirmedStructured?.stderr ||
        "unknown",
    );
    assert.equal(structuredFailure.variant, "applyFailed");
    assert.equal(structuredFailure.data.status, "failed");
    assert.equal(structuredFailure.data.results[0]?.status, "writeUnconfirmed");

    assert.equal(modifiedPreview?.exitCode, 0, modifiedPreview?.stderr);
    assert.equal(modifiedPreview?.stderr, "");
    assert.ok(modifiedPreview?.stdout.includes("重置待译占位"));
    assert.ok(modifiedPreview?.stdout.includes("人工译文"));
    assert.ok(modifiedPreview?.stdout.includes("待译：Welcome back"));
    assert.ok(
      modifiedPreview?.stdout.includes(
        "原文已变化；使用当前原文生成待译占位并重置现有译文。",
      ),
    );
    assert.equal(modifiedApplied?.exitCode, 0, modifiedApplied?.stderr);
    assert.equal(modifiedApplied?.stderr, "");
    const modifiedExecution = JSON.parse(modifiedApplied?.stdout ?? "unknown");
    assert.equal(modifiedExecution.variant, "applied");
    assert.equal(modifiedExecution.data.status, "completed");
    assert.equal(modifiedExecution.data.results[0]?.status, "written");
    assert.deepStrictEqual(
      JSON.parse(
        await readFile(
          path.join(context.workDir, "modified/lioni.translations.json"),
          "utf8",
        ),
      ),
      [
        {
          targetId: "target-welcome",
          sourceId: "welcome",
          text: "待译：Welcome back",
        },
      ],
    );
    assert.equal(
      await readFile(
        path.join(context.workDir, "modified/lioni.writes.log"),
        "utf8",
      ),
      "write\n",
    );
    assert.equal(
      await readFile(
        path.join(context.workDir, "modified/lioni.baseline.json"),
        "utf8",
      ),
      expectedModifiedBaselineByWorkDir.get(context.workDir),
    );
  },
};

export default journey;
