import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { isDeepStrictEqual } from "node:util";

import {
  createDefaultDirectoryQualityCheckResultCache,
  createDirectoryQualityCheckResultCache,
  resolveDefaultQualityCheckResultCacheDirectory,
} from "../src/node/quality-cache.ts";
import type { CacheableQualityCheckOutcome } from "../src/quality/quality-cache.ts";

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

async function entryPathForKey(
  directory: string,
  key: string,
): Promise<string> {
  for (const filename of await readdir(directory)) {
    const entryPath = path.join(directory, filename);
    const entry = JSON.parse(await readFile(entryPath, "utf8")) as {
      readonly key: string;
    };
    if (entry.key === key) return entryPath;
  }
  assert.fail(`缓存目录中没有键 ${key} 的条目。`);
}

void describe("QA 结果缓存", () => {
  void it("将各键写为独立条目，并支持独立实例读取", async () => {
    await withDirectory(async (root) => {
      const cacheDirectory = path.join(root, "quality-results");
      const first = createDirectoryQualityCheckResultCache(cacheDirectory);
      const second = createDirectoryQualityCheckResultCache(cacheDirectory);

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

      await second.set(
        "check:save:fr:candidate:1:fingerprint:a",
        notApplicable,
      );
      assert.equal((await readdir(cacheDirectory)).length, 2);
    });
  });

  void it("只替换同键条目，保留其他键的记录", async () => {
    await withDirectory(async (directory) => {
      const cache = createDirectoryQualityCheckResultCache(directory);
      const replacement: CacheableQualityCheckOutcome = {
        ...completeOutcome,
        diagnostics: completeOutcome.diagnostics.map((diagnostic) => ({
          ...diagnostic,
          message: "已替换的诊断。",
        })),
      };
      await cache.set("first", completeOutcome);
      await cache.set("second", notApplicable);
      const unrelatedEntryPath = await entryPathForKey(directory, "second");
      const unrelatedEntry = await readFile(unrelatedEntryPath);

      await cache.set("first", replacement);

      assert.deepEqual(await cache.get("first"), replacement);
      assert.deepEqual(await cache.get("second"), notApplicable);
      assert.deepEqual(await readFile(unrelatedEntryPath), unrelatedEntry);
      assert.equal((await readdir(directory)).length, 2);
    });
  });

  void it("不同字符串键即使 UTF-8 替换后相同仍保持隔离", async () => {
    await withDirectory(async (directory) => {
      const cache = createDirectoryQualityCheckResultCache(directory);
      const loneSurrogateKey = "\ud800";
      const replacementCharacterKey = "\ufffd";

      await cache.set(loneSurrogateKey, completeOutcome);
      await cache.set(replacementCharacterKey, notApplicable);

      assert.deepEqual(await cache.get(loneSurrogateKey), completeOutcome);
      assert.deepEqual(await cache.get(replacementCharacterKey), notApplicable);
      assert.equal((await readdir(directory)).length, 2);
    });
  });

  void it("允许缓存可复用的完整结果及 not-applicable 结果", async () => {
    await withDirectory(async (directory) => {
      const cache = createDirectoryQualityCheckResultCache(directory);

      await cache.set("complete-with-error", completeOutcome);
      await cache.set("not-applicable", notApplicable);

      assert.deepEqual(await cache.get("complete-with-error"), completeOutcome);
      assert.deepEqual(await cache.get("not-applicable"), notApplicable);
    });
  });

  void it("不保存 incomplete 或 failed 结果", async () => {
    await withDirectory(async (directory) => {
      const cache = createDirectoryQualityCheckResultCache(directory);
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
      assert.deepEqual(await readdir(directory), []);
    });
  });

  void it("拒绝损坏、错位或旧格式条目且保留无关有效记录", async () => {
    await withDirectory(async (directory) => {
      const cache = createDirectoryQualityCheckResultCache(directory);
      await cache.set("damaged", completeOutcome);
      await cache.set("deleted", notApplicable);
      await cache.set("healthy", completeOutcome);

      const damagedEntryPath = await entryPathForKey(directory, "damaged");
      const deletedEntryPath = await entryPathForKey(directory, "deleted");
      const validEntry = JSON.parse(
        await readFile(damagedEntryPath, "utf8"),
      ) as {
        readonly format: string;
        readonly key: string;
        readonly outcome: Record<string, unknown>;
        readonly contentDigest: string;
      };
      const incompatibleEntries = [
        { ...validEntry, format: "lioni.qa-cache/v2" },
        { ...validEntry, key: "a-different-key" },
        {
          ...validEntry,
          outcome: { ...validEntry.outcome, diagnostics: [{}] },
        },
        { ...validEntry, contentDigest: `sha256:${"0".repeat(64)}` },
      ];
      for (const entry of incompatibleEntries) {
        await writeFile(damagedEntryPath, JSON.stringify(entry), "utf8");
        assert.equal(await cache.get("damaged"), undefined);
      }
      await writeFile(damagedEntryPath, "{not json", "utf8");
      await rm(deletedEntryPath);

      assert.equal(await cache.get("damaged"), undefined);
      assert.equal(await cache.get("deleted"), undefined);
      assert.deepEqual(await cache.get("healthy"), completeOutcome);

      await cache.set("damaged", notApplicable);
      assert.deepEqual(await cache.get("damaged"), notApplicable);
    });
  });

  void it("不读取或改写旧单文件缓存", async () => {
    await withDirectory(async (directory) => {
      const legacyFile = path.join(directory, "quality-cache.json");
      const legacyContents = JSON.stringify({
        format: "lioni.qa-cache/v2",
        entries: [{ key: "key", outcome: completeOutcome }],
      });
      await writeFile(legacyFile, legacyContents, "utf8");
      const cache = createDirectoryQualityCheckResultCache(legacyFile);

      assert.equal(await cache.get("key"), undefined);
      await cache.set("key", completeOutcome);
      assert.equal(await readFile(legacyFile, "utf8"), legacyContents);
    });
  });

  void it("同键并发替换始终保留完整结果", async () => {
    await withDirectory(async (directory) => {
      const cache = createDirectoryQualityCheckResultCache(directory);
      const alternatives = [
        completeOutcome,
        {
          ...completeOutcome,
          diagnostics: completeOutcome.diagnostics.map((diagnostic) => ({
            ...diagnostic,
            message: "并发写入的诊断。",
          })),
        },
      ] as const;
      const writes = Array.from({ length: 8 }, (_, index) =>
        cache.set("same-key", alternatives[index % alternatives.length]!),
      );
      const reads = Array.from({ length: 8 }, () => cache.get("same-key"));
      const observed = await Promise.all([...writes, ...reads]);

      for (const result of observed.slice(writes.length))
        assert.ok(
          result === undefined ||
            alternatives.some((outcome) => isDeepStrictEqual(result, outcome)),
        );
      const final = await cache.get("same-key");
      assert.ok(
        alternatives.some((outcome) => isDeepStrictEqual(final, outcome)),
      );
      assert.equal((await readdir(directory)).length, 1);
    });
  });

  void it("目录不可用时不让缓存 I/O 改变检查结果", async () => {
    await withDirectory(async (directory) => {
      const blockedParent = path.join(directory, "not-a-directory");
      await writeFile(blockedParent, "file", "utf8");
      const cache = createDirectoryQualityCheckResultCache(
        path.join(blockedParent, "quality-results"),
      );

      assert.equal(await cache.get("key"), undefined);
      await assert.doesNotReject(cache.set("key", completeOutcome));
      assert.equal(await cache.get("key"), undefined);
    });
  });

  void it("默认缓存目录位于配置文件同目录的 .lioni/cache 下", async () => {
    await withDirectory(async (directory) => {
      const configPath = path.join(directory, "config", "lioni.config.ts");

      assert.equal(
        resolveDefaultQualityCheckResultCacheDirectory(configPath),
        path.join(directory, "config", ".lioni", "cache", "quality-results"),
      );
      assert.equal(
        resolveDefaultQualityCheckResultCacheDirectory(
          "configs/lioni.config.ts",
        ),
        path.resolve("configs/.lioni/cache/quality-results"),
      );

      const cache = createDefaultDirectoryQualityCheckResultCache(configPath);
      await cache.set("default", completeOutcome);
      assert.deepEqual(await cache.get("default"), completeOutcome);
    });
  });
});
