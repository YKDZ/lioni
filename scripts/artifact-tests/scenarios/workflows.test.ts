import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
  },
);
