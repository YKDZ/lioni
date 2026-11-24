import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { testArtifactConsumer } from "../support/consumer.ts";

testArtifactConsumer(
  {
    name: "文件计划跨进程写回、冲突与失败恢复",
    fixtures: new URL("../fixtures/workflows/", import.meta.url),
  },
  async ({ root, runNode, typecheck }) => {
    await typecheck();
    const json = async (file: string, value: unknown) =>
      writeFile(path.join(root, file), JSON.stringify(value));
    const read = (file: string) => readFile(path.join(root, file), "utf8");
    const run = async (...args: string[]): Promise<unknown> =>
      JSON.parse((await runNode("consumer.ts", args)).stdout);
    const sources = (suffix: string) =>
      ["A", "B"].map((id) => ({ id, source: `原文 ${id} ${suffix}` }));
    const blocked = path.join(root, "blocked");
    await mkdir(path.join(root, "fr"));
    await mkdir(blocked);
    await json("source.json", sources("旧"));
    await json("fr/A.json", { id: "A", text: "译文 A" });
    await json("fr/B.json", { id: "B", text: "译文 B", writePath: blocked });
    await json("fr/unrelated.json", { id: "unrelated", text: "其他资源" });
    assert.partialDeepStrictEqual(await run("baseline"), { outcome: "saved" });
    const baseline = await read("baseline.json");
    const unrelated = await read("fr/unrelated.json");

    await json("source.json", sources("新版"));
    assert.deepEqual(await run("plan"), [
      ["A", "write"],
      ["B", "write"],
    ]);
    // 保存后改变原文；新进程必须拒绝旧计划，不能悄悄重新规划。
    await json("source.json", sources("外部改动"));
    assert.partialDeepStrictEqual(await run("apply"), {
      status: "failed",
      results: [{ status: "conflict" }, { status: "conflict" }],
    });
    assert.partialDeepStrictEqual(JSON.parse(await read("fr/A.json")), {
      text: "译文 A",
    });
    await json("source.json", sources("新版"));
    const partial = await run("apply");
    assert.partialDeepStrictEqual(partial, {
      results: [{ status: "written" }, { status: "writeFailed" }],
    });
    assert.match(JSON.stringify(partial), /EISDIR/u);
    assert.partialDeepStrictEqual(JSON.parse(await read("fr/A.json")), {
      text: "更新译文 A",
    });
    assert.partialDeepStrictEqual(JSON.parse(await read("fr/B.json")), {
      text: "译文 B",
    });
    await json("fr/B.json", { id: "B", text: "译文 B" });
    assert.deepEqual(await run("plan"), [
      ["A", "retain"],
      ["B", "write"],
    ]);
    assert.partialDeepStrictEqual(await run("apply"), {
      status: "completed",
      results: [{ status: "retained" }, { status: "written" }],
    });
    assert.partialDeepStrictEqual(JSON.parse(await read("fr/B.json")), {
      text: "更新译文 B",
    });

    // 独立的语义写入请求同样跨进程保存、校验，并保护外部修改。
    await run("save-edit");
    const target = await read("fr/A.json");
    await json("fr/A.json", { id: "A", text: "外部修订 A" });
    assert.partialDeepStrictEqual(await run("edit"), {
      results: [{ status: "conflict" }],
    });
    assert.partialDeepStrictEqual(JSON.parse(await read("fr/A.json")), {
      text: "外部修订 A",
    });
    await writeFile(path.join(root, "fr/A.json"), target);
    assert.partialDeepStrictEqual(await run("edit"), {
      results: [{ status: "written" }],
    });
    assert.partialDeepStrictEqual(JSON.parse(await read("fr/A.json")), {
      text: "人工修订 A",
    });

    const sharedFile = path.join(root, "fr/shared.json");
    await rm(path.join(root, "fr/A.json"));
    await rm(path.join(root, "fr/B.json"));
    await writeFile(
      sharedFile,
      JSON.stringify([
        { id: "A", text: "旧译文 A", writePath: sharedFile },
        { id: "B", text: "旧译文 B", writePath: sharedFile },
      ]),
    );
    assert.partialDeepStrictEqual(await run("batch-edit"), {
      results: [{ status: "written" }, { status: "written" }],
    });
    assert.deepEqual(JSON.parse(await read("fr/shared.json")), [
      { id: "A", text: "批量译文 A", writePath: sharedFile },
      { id: "B", text: "批量译文 B", writePath: sharedFile },
    ]);
    await rm(sharedFile);
    await json("fr/A.json", { id: "A", text: "人工修订 A" });
    await json("fr/B.json", { id: "B", text: "更新译文 B" });

    await json(
      "source.json",
      sources("新版").filter(({ id }) => id !== "A"),
    );
    assert.deepEqual(await run("plan"), [["B", "retain"]]);
    // 默认策略保护基线之后的人工修改；删除阶段使用未修改的历史译文。
    await json("fr/A.json", { id: "A", text: "译文 A" });
    assert.deepEqual(await run("plan"), [
      ["A", "delete"],
      ["B", "retain"],
    ]);
    assert.partialDeepStrictEqual(await run("apply", "reject"), {
      results: [{ status: "conflict" }, { status: "retained" }],
    });
    assert.partialDeepStrictEqual(JSON.parse(await read("fr/A.json")), {
      text: "译文 A",
    });
    assert.partialDeepStrictEqual(await run("apply"), {
      status: "completed",
      results: [{ status: "written" }, { status: "retained" }],
    });
    await assert.rejects(read("fr/A.json"), { code: "ENOENT" });
    assert.equal(await read("fr/unrelated.json"), unrelated);
    assert.equal(await read("baseline.json"), baseline);

    // 升级前保存的 v2 比较基线与 v2 更新计划文件在当前制品中仍可兼容读回并检测冲突。
    await rm(path.join(root, "baseline.json"));
    await rm(path.join(root, "plan.json"));
    await json("source.json", sources("v2-旧"));
    await json("fr/A.json", { id: "A", text: "译文 A" });
    await json("fr/B.json", { id: "B", text: "译文 B" });
    assert.partialDeepStrictEqual(await run("baseline"), { outcome: "saved" });
    const legacyBaseline = toLegacyV2Baseline(
      JSON.parse(await read("baseline.json")),
    );
    const legacyBaselineText = JSON.stringify(legacyBaseline);
    await writeFile(
      path.join(root, "baseline.json"),
      legacyBaselineText,
      "utf8",
    );

    assert.partialDeepStrictEqual(await run("baseline"), {
      outcome: "unchanged",
    });
    assert.equal(await read("baseline.json"), legacyBaselineText);

    await json("source.json", sources("v2-新版"));
    assert.deepEqual(await run("plan"), [
      ["A", "write"],
      ["B", "write"],
    ]);
    const legacyPlan = toLegacyV2Plan(JSON.parse(await read("plan.json")));
    await writeFile(
      path.join(root, "plan.json"),
      JSON.stringify(legacyPlan),
      "utf8",
    );

    await json("source.json", sources("v2-外部原文改动"));
    assert.partialDeepStrictEqual(await run("apply"), {
      status: "failed",
      results: [{ status: "conflict" }, { status: "conflict" }],
    });

    await json("source.json", sources("v2-新版"));
    await json("fr/A.json", { id: "A", text: "译文 A", extra: "changed" });
    assert.partialDeepStrictEqual(await run("apply"), {
      status: "failed",
      results: [{ status: "conflict" }, { status: "written" }],
    });
    assert.partialDeepStrictEqual(JSON.parse(await read("fr/A.json")), {
      text: "译文 A",
      extra: "changed",
    });

    await json("fr/A.json", { id: "A", text: "译文 A" });
    await json("fr/B.json", { id: "B", text: "译文 B" });
    assert.partialDeepStrictEqual(await run("apply"), {
      status: "completed",
      results: [{ status: "written" }, { status: "written" }],
    });
    assert.partialDeepStrictEqual(JSON.parse(await read("fr/A.json")), {
      text: "更新译文 A",
    });
    assert.partialDeepStrictEqual(JSON.parse(await read("fr/B.json")), {
      text: "更新译文 B",
    });
  },
);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toLegacyTranslationRecord(value: unknown): unknown {
  if (!isPlainObject(value) || !Object.hasOwn(value, "record")) return value;
  const { record, ...rest } = value;
  return { ...rest, translation: record };
}

function toLegacySnapshot(value: unknown): unknown {
  if (!isPlainObject(value) || !isPlainObject(value.translations)) return value;
  const records = value.translations.records;
  if (!Array.isArray(records)) return value;
  return {
    ...value,
    translations: {
      ...value.translations,
      records: records.map(toLegacyTranslationRecord),
    },
  };
}

function toLegacyTranslationChange(value: unknown): unknown {
  if (!isPlainObject(value)) return value;
  return {
    ...value,
    ...(value.previous === undefined
      ? {}
      : { previous: toLegacyTranslationRecord(value.previous) }),
    ...(value.current === undefined
      ? {}
      : { current: toLegacyTranslationRecord(value.current) }),
  };
}

function toLegacyV2Baseline(value: unknown): Record<string, unknown> {
  assert.ok(isPlainObject(value));
  return {
    ...value,
    snapshot: toLegacySnapshot(value.snapshot),
  };
}

function toLegacyV2Plan(value: unknown): Record<string, unknown> {
  assert.ok(isPlainObject(value));
  assert.ok(isPlainObject(value.comparisons));
  assert.ok(Array.isArray(value.items));
  return {
    ...value,
    ...(value.previous === undefined
      ? {}
      : { previous: toLegacySnapshot(value.previous) }),
    current: toLegacySnapshot(value.current),
    comparisons: {
      ...value.comparisons,
      translationChanges: Array.isArray(value.comparisons.translationChanges)
        ? value.comparisons.translationChanges.map(toLegacyTranslationChange)
        : [],
    },
    items: value.items.map((item) => {
      if (!isPlainObject(item) || !isPlainObject(item.changes)) return item;
      return {
        ...item,
        changes: {
          ...item.changes,
          translations: Array.isArray(item.changes.translations)
            ? item.changes.translations.map(toLegacyTranslationChange)
            : [],
        },
      };
    }),
  };
}
