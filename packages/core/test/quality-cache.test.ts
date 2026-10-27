import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  createFileQualityCheckResultCache,
  resolveDefaultQualityCheckResultCachePath,
} from "../src/node-quality-cache.ts";
import type { CacheableQualityCheckOutcome } from "../src/quality-cache.ts";

const completeOutcome: CacheableQualityCheckOutcome = {
  status: "complete",
  diagnostics: [
    {
      severity: "error",
      object: { kind: "translation", key: "save", language: "fr" },
      location: { language: "fr", range: [4, 8] },
      message: "变量数量不匹配。",
      evidence: [],
    },
  ],
  issues: [],
  coverage: {
    selected: 1,
    evaluated: 1,
    notApplicable: 0,
    incomplete: 0,
    failed: 0,
  },
};

async function withDirectory(
  run: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lioni-qa-cache-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

void describe("QA 结果缓存", () => {
  void it("新建的缓存实例可读取已保存的完整原始结果", async () => {
    await withDirectory(async (directory) => {
      const filePath = path.join(directory, "quality-cache.json");
      const first = createFileQualityCheckResultCache(filePath);
      const second = createFileQualityCheckResultCache(filePath);

      await first.set(
        "check:save:fr:candidate:0:fingerprint:a",
        completeOutcome,
      );

      assert.deepEqual(
        await second.get("check:save:fr:candidate:0:fingerprint:a"),
        completeOutcome,
      );
      assert.equal(
        await second.get("check:save:fr:candidate:1:fingerprint:a"),
        undefined,
      );
      assert.equal(
        await second.get("check:save:fr:candidate:0:fingerprint:b"),
        undefined,
      );
    });
  });

  void it("允许缓存含错误诊断的 complete 与 not-applicable 结果", async () => {
    await withDirectory(async (directory) => {
      const cache = createFileQualityCheckResultCache(
        path.join(directory, "quality-cache.json"),
      );
      const notApplicable: CacheableQualityCheckOutcome = {
        status: "not-applicable",
        diagnostics: [],
        issues: [],
        coverage: {
          selected: 1,
          evaluated: 0,
          notApplicable: 1,
          incomplete: 0,
          failed: 0,
        },
      };

      await cache.set("complete-with-error", completeOutcome);
      await cache.set("not-applicable", notApplicable);

      assert.deepEqual(await cache.get("complete-with-error"), completeOutcome);
      assert.deepEqual(await cache.get("not-applicable"), notApplicable);
    });
  });

  void it("不保存 incomplete 或 failed 结果", async () => {
    await withDirectory(async (directory) => {
      const filePath = path.join(directory, "quality-cache.json");
      const cache = createFileQualityCheckResultCache(filePath);
      const incomplete = {
        ...completeOutcome,
        status: "incomplete",
      } as unknown as CacheableQualityCheckOutcome;
      const failed = {
        ...completeOutcome,
        status: "failed",
      } as unknown as CacheableQualityCheckOutcome;

      await cache.set("incomplete", incomplete);
      await cache.set("failed", failed);

      assert.equal(await cache.get("incomplete"), undefined);
      assert.equal(await cache.get("failed"), undefined);
    });
  });

  void it("把损坏或不兼容文件当作未命中，并能重新写入结果", async () => {
    await withDirectory(async (directory) => {
      const filePath = path.join(directory, "quality-cache.json");
      const cache = createFileQualityCheckResultCache(filePath);
      await writeFile(filePath, "{not json", "utf8");

      assert.equal(await cache.get("key"), undefined);
      await cache.set("key", completeOutcome);
      assert.deepEqual(await cache.get("key"), completeOutcome);

      const incompatiblePath = path.join(directory, "old-cache.json");
      await writeFile(
        incompatiblePath,
        JSON.stringify({ format: "lioni.qa-cache/v0", entries: [] }),
        "utf8",
      );
      const incompatible = createFileQualityCheckResultCache(incompatiblePath);
      assert.equal(await incompatible.get("key"), undefined);

      const malformedPath = path.join(directory, "malformed-cache.json");
      await writeFile(
        malformedPath,
        JSON.stringify({
          format: "lioni.qa-cache/v1",
          entries: [
            {
              key: "key",
              outcome: { ...completeOutcome, diagnostics: [{}] },
            },
          ],
        }),
        "utf8",
      );
      const malformed = createFileQualityCheckResultCache(malformedPath);
      assert.equal(await malformed.get("key"), undefined);
    });
  });

  void it("存储目录不可用时不让缓存 I/O 改变检查结果", async () => {
    await withDirectory(async (directory) => {
      const blockedParent = path.join(directory, "not-a-directory");
      await writeFile(blockedParent, "file", "utf8");
      const cache = createFileQualityCheckResultCache(
        path.join(blockedParent, "quality-cache.json"),
      );

      assert.equal(await cache.get("key"), undefined);
      await assert.doesNotReject(cache.set("key", completeOutcome));
      assert.equal(await cache.get("key"), undefined);
    });
  });

  void it("默认缓存文件位于配置文件同目录的 .lioni/cache 下", async () => {
    await withDirectory(async (directory) => {
      const configPath = path.join(directory, "config", "lioni.config.ts");

      assert.equal(
        resolveDefaultQualityCheckResultCachePath(configPath),
        path.join(
          directory,
          "config",
          ".lioni",
          "cache",
          "quality-results.json",
        ),
      );
      assert.equal(
        resolveDefaultQualityCheckResultCachePath("configs/lioni.config.ts"),
        path.resolve("configs/.lioni/cache/quality-results.json"),
      );
    });
  });
});
