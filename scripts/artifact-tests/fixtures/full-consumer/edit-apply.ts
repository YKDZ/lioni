import { readFile, writeFile } from "node:fs/promises";

import {
  validateTranslationWriteRequest,
  writeTranslationRequests,
} from "@lioni/core";

import config from "./edits.config.ts";

const requestPath = process.argv[2];
if (requestPath === undefined) throw new Error("缺少译文写入请求文件路径。");
const rawRequests = JSON.parse(await readFile(requestPath, "utf8")) as unknown;
if (!Array.isArray(rawRequests)) throw new TypeError("写入请求必须是数组。");
const requests = await Promise.all(
  rawRequests.map((request: unknown) =>
    validateTranslationWriteRequest(request, config),
  ),
);
const result = await writeTranslationRequests(requests, config);
await writeFile(requestPath + ".result.json", JSON.stringify(result), "utf8");
