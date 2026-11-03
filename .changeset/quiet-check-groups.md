---
"@lioni/lioni": minor
---

SDK 和 CLI 现可按检查项 ID 或项目分组运行 QA。CLI 的 `--check` 和 `--group` 都可重复指定，且不能同时使用；报告会列出配置项总数和本次选中的检查项。

迁移现有接入时，请删除 `quality.loadDependencies`，将每项所需资料的读取放入该检查自己的 `loadDependencies` 回调。候选构造器在 `buildCandidates` 中读取自身资料；多个消费者要共享同次读取时，可调用传入的 `qualityData.read(reader, ...args)`。结果不再提供全局顶层 `dependencies`，资料归属各项 `checks[].dependencies`；运行结果的 `checkScope` 现为必填。

显式指定业务泛型时，请用 `defineQualityCheck.withTypes<...>()({...})`、`defineConfig.withTypes<...>()({...})` 或 `createTermChecker.withTypes<...>()({...})` 分阶段传入类型和声明，以保留检查项 ID 与分组名的字面量推断。
