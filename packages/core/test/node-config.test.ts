import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { readComparisonSnapshot, readSourceFacts } from "../src/index.ts";
import { StandardSchemaContractError } from "../src/index.ts";
import { loadConfig } from "../src/node.ts";

void describe("动态 Node 配置契约", () => {
  void it("接受独立 core 实例创建的配置，并按操作校验结构", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "lioni-node-config-"),
    );
    const configPath = path.join(directory, "host.config.mjs");
    const unboundPath = path.join(directory, "unbound.config.mjs");
    const invalidPath = path.join(directory, "invalid.config.mjs");
    const deferredPath = path.join(directory, "deferred.config.mjs");
    const coreUrl = pathToFileURL(
      fileURLToPath(new URL("../src/index.ts", import.meta.url)),
    ).href;
    const hostCoreUrl = `${coreUrl}?host-instance`;

    try {
      await writeFile(
        configPath,
        `import { defineConfig } from ${JSON.stringify(hostCoreUrl)};\nexport default defineConfig({\n  source: {\n    schema: { "~standard": { version: 1, vendor: "node-config-test", validate(value) {\n      return typeof value === "object" && value !== null && typeof value.source === "string" && typeof value.context?.line === "number"\n        ? { value }\n        : { issues: [{ message: "原文契约不匹配。" }] };\n    } } },\n    read: () => ({ scopes: [{ range: "messages.json", enumeration: "complete", records: [{ value: { source: "Save", context: { line: 18 } }, bodyAvailability: "available" }] }] })\n  },\n  keyOf: (unit) => String(unit.context.line)\n});\n`,
      );
      await writeFile(
        unboundPath,
        `export default { source: { schema: { "~standard": { version: 1, vendor: "unbound", validate: (value) => ({ value }) } }, read: () => ({ scopes: [] }) }, keyOf: () => "unused" };\n`,
      );
      await writeFile(invalidPath, `export default { source: {} };\n`);
      await writeFile(
        deferredPath,
        `export default { source: { schema: { "~standard": { version: 1, vendor: "deferred", validate: (value) => ({ value }) } }, read: () => ({ scopes: [] }) }, keyOf: () => "unused", translations: {} };\n`,
      );

      const loaded = await loadConfig(configPath);
      const observed = await loaded.use(async (config) => {
        const facts = await readSourceFacts(config);
        return {
          key: facts.units[0]?.key,
          source: facts.units[0]?.unit.source,
        };
      });

      assert.deepStrictEqual(observed, { key: "18", source: "Save" });
      const plain = await loadConfig(unboundPath);
      const plainFacts = await plain.use(readSourceFacts);
      assert.equal(plainFacts.units.length, 0);
      const deferred = await loadConfig(deferredPath);
      const deferredFacts = await deferred.use(readSourceFacts);
      assert.equal(deferredFacts.units.length, 0);
      await assert.rejects(
        deferred.use(readComparisonSnapshot),
        StandardSchemaContractError,
      );
      await assert.rejects(
        loadConfig(invalidPath),
        StandardSchemaContractError,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
