import { readFile, writeFile } from "node:fs/promises";

import { applySemanticEdits } from "@lioni/core";

import config from "./edits.config.ts";

const editPath = process.argv[2];
if (editPath === undefined) throw new Error("缺少语义编辑文件路径。");
const edits = JSON.parse(await readFile(editPath, "utf8"));
const result = await applySemanticEdits(edits, config);
await writeFile(editPath + ".result.json", JSON.stringify(result), "utf8");
