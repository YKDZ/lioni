import { analyzeQuality } from "@lioni/lioni";

import config from "./lioni.config.ts";

const selectedById = analyzeQuality(config, { checkIds: ["syntax"] });
const selectedByGroups = analyzeQuality(config, {
  groups: ["daily", "syntaxOnly"],
});
void selectedById;
void selectedByGroups;

// @ts-expect-error 发行声明应拒绝未配置的检查项 ID。
analyzeQuality(config, { checkIds: ["missing"] });
// @ts-expect-error 发行声明应拒绝未配置的组名。
analyzeQuality(config, { groups: ["all"] });
// @ts-expect-error ID 与分组选择不能同时提供。
analyzeQuality(config, { checkIds: ["syntax"], groups: ["daily"] });
