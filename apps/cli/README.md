# lioni

lioni 提供 `lioni` 命令行、TypeScript SDK 和 Node.js 文件适配器。Node.js 24.21 及以上版本可安装单一产品包：

```sh
pnpm add lioni
```

`lioni` 命令从配置文件读取宿主适配器，`lioni qa lioni.config.ts` 默认输出简洁中文报告；追加 `--output-format structured` 可取得完整结构化结果。SDK 的纯函数与类型从 `lioni` 导入，文件配置、Node 存储和术语目录读取从 `lioni/node` 导入：

```ts
import { analyzeQuality, defineConfig, parseTermbaseYaml } from "lioni";
import { loadConfig, loadTermbaseYaml } from "lioni/node";

const config = await loadConfig("lioni.config.ts");
const result = await analyzeQuality(config);
const inMemoryTerms = parseTermbaseYaml({ concepts, languages });
const directoryTerms = await loadTermbaseYaml(
  new URL("./terms/", import.meta.url),
);
```

`parseTermbaseYaml` 在内存中完成解析、组装和领域校验，直接返回 `Termbase`。`loadTermbaseYaml` 对目录执行相同处理；`loadConfig` 直接返回已验证的配置。

SDK 保留自定义正文与适配器、检查器、存储，以及独立的预览与应用流程。以下示例说明检查输入指纹、质量例外和结果缓存的使用方式。

## 质量检查输入指纹

自定义检查通过 `defineQualityCheck` 创建，再放入 `quality.checks`。每项检查都要提供稳定的 `id` 和显式 `version`。版本表示检查算法与宿主组合逻辑；算法、宿主选择、位置映射及策略发生语义变化时，应更新对应版本。`QualityCheckInput`、`QualityFinding`、`QualityIssue` 和 `QualityCoverage` 可用于标注宿主自己的检查函数。

每条候选检查执行都会在 `checks[].executions[]` 中报告 `checkId`、原文键、目标语言、状态和可比较的 `inputFingerprint`。摘要分别给出带指纹格式的检查版本（`lioni.check-input/v1:<checkVersion>`）、最终配置摘要和业务输入摘要；`checks[].version` 仍是检查器显式提供的版本。诊断带有 `checkId` 与 `executionId`，可关联到产生它的候选执行。同键同语言的多个候选会分别保留记录。

使用 `lioni` 提供的检查器工厂时，另提供 `hostVersion` 描述宿主的选择、投影和组合逻辑。工厂会将它与固定的内置算法版本合并。

质量设置集中在 `defineConfig` 的 `quality` 对象中。检查器直接放入 `quality.checks`，其配置 schema 由 SDK 在每次运行时校验。需要动态规则资料时，用 `quality.loadDependencies({ facts, memo })` 按本次已读取事实加载一次；返回值会提供给每条检查器，并进入默认输入指纹。

框架按匹配的可用译文生成默认候选。需要增加或改造候选集合时，可用 `quality.buildCandidates({ facts, defaultCandidates, dependencies, memo })` 一次构造；`analyzeQuality` 的 `candidates` 选项可直接提供外部候选源，并覆盖配置中的构造器。可另传 `selectCandidates(candidates)` 完成过滤、排序或截取；空数组保持为空。候选筛选只限制实际检查范围，完整读取事实与关系上下文仍提供给检查器。结果缓存与例外存储分别配置为 `quality.resultCache` 和 `quality.exceptionStore`。

## 默认输入依据

默认依据包含完整框架事实、当前候选、对应原文单元、检查依赖和关联关系。对象属性顺序不影响摘要，数组顺序保留。输入必须是普通 JSON；函数、`memo`、例外和存储实例不属于默认依据。框架始终把检查身份、实现版本及经过 schema 转换的最终配置加入指纹。完整框架事实可能包含与某条诊断无关的条目；这些条目改变时指纹也可能变化，使现有例外不再匹配，这是保守范围带来的代价。

闭包依赖不会自动纳入指纹。通过 `quality.loadDependencies` 返回的宿主资料、外部策略和其他会影响诊断内容、位置或证据的数据会纳入默认指纹；检查作者也可在自定义依据中组合默认构造能力：

```ts
import { createDefaultQualityInputBasis, defineQualityCheck } from "lioni";
import type { JsonValue } from "lioni";

const glossarySnapshot: JsonValue = { version: "2026-10", terms: [] };

const check = defineQualityCheck({
  id: "catalog-term-policy",
  version: "catalog-term-policy-v1",
  configurationSchema,
  configuration: { strict: true },
  fingerprintInput(input) {
    return {
      framework: createDefaultQualityInputBasis(input),
      glossarySnapshot,
    };
  },
  check(input) {
    // 根据 input 生成原始检查结果。
  },
});
```

`fingerprintInput` 与 `check` 接收同一次候选检查的事实、候选、依赖和已校验配置。它可以将 `createDefaultQualityInputBasis(input)` 与宿主额外资料组合；框架会把检查身份、版本和配置纳入指纹。检查不依赖其他检查的执行顺序。

## 自定义正文、适配器与检查器

`config.source.read()` 读取宿主定义的原文记录，`source.schema` 校验记录结构。框架保留完整原文单元；`sourceUnit.unit.source` 的业务含义由宿主定义，框架不会从任意 JSON 字段猜测正文。原文与译文正文可使用字符串、对象或宿主的其他类型，由 schema 和适配器定义。

译文适配器的 `translations.contentOf()` 从译文记录取出正文，`identityOf()` 提供稳定目标身份。`analyzeQuality` 将本次事实、候选、动态依赖和复用范围提供给检查器；自定义逻辑可以在 `check(input)` 中按宿主规则解释正文，并返回诊断、问题与覆盖情况。`createVueI18nChecks`、`createNumberChecker`、`createTermChecker` 等工厂为常见规则提供可复用检查器。

自定义存储可实现 `QualityExceptionStore` 或 `QualityCheckResultCache`，也可实现比较基线和更新计划存储。Node 文件实现从 `lioni/node` 导入；纯 SDK 流程可将自定义存储直接放入配置或函数参数。

独立计划流程仍可单独使用：`previewUpdate(config, baselineStore)` 返回可保存的计划，之后由 `applyUpdatePlan(plan, config, confirm)` 校验计划并执行写入。两步可以运行在不同进程中，也可分别接入审批流程。

## QA 例外

例外由检查报告中的执行记录创建，绑定检查项、原文键、目标语言和完整输入指纹，并覆盖该次候选检查的全部诊断：

```ts
import { createQualityException } from "lioni";

const execution = report.checks
  .find(({ checkId }) => checkId === "catalog-term-policy")
  ?.executions.find(
    ({ sourceKey, language }) =>
      sourceKey === "toolbar.save" && language === "fr",
  );

if (execution === undefined) throw new Error("报告中没有对应执行记录。");
const exception = createQualityException({
  id: "save-term-choice",
  reason: "该术语选择已由维护者确认。",
  execution,
});
```

手工 YAML 使用同一结构。Node 的 `loadConfig(configPath)` 默认读取配置文件同目录的 `lioni.exceptions.yaml`；文件缺失表示没有例外，格式错误、身份重复或读取失败会使 QA 明确失败。手工维护时复制执行记录中的指纹和摘要，例如：

```yaml
format: lioni.qa-exceptions/v1
exceptions:
  - id: save-term-choice
    reason: 该术语选择已由维护者确认。
    checkId: catalog-term-policy
    sourceKey: toolbar.save
    language: fr
    inputFingerprint: sha256:复制报告中的完整指纹
    fingerprintSummary:
      version: "lioni.check-input/v1:catalog-term-policy-v1"
      configurationFingerprint: sha256:复制报告中的配置摘要
      inputFingerprint: sha256:复制报告中的业务输入摘要
```

直接向 `analyzeQuality(config)` 传入纯配置对象时，框架不会猜测当前目录；没有配置存储就不使用例外。自定义 `quality.exceptionStore` 会替换 Node 默认 YAML 来源。QA 报告分别给出诊断处理和 `exceptionApplicability`：输入、最终配置或检查版本改变时显示原因，局部未执行时标记为本次未验证；依据恢复后，旧例外会重新适用。即使本次没有诊断，也会报告适用性。

人工编辑 YAML 与命令维护具有同等地位，二者使用相同的例外记录契约。CLI 可以直接使用现有 SDK 报告或 `qa` 命令的 JSON 报告创建或刷新记录：

```sh
lioni exceptions upsert lioni.config.ts qa-report.json \
  --check-id catalog-term-policy \
  --execution-id 3 \
  --id save-term-choice \
  --reason '该术语选择已由维护者确认。'
```

`--execution-id` 用于从同组多个候选中选定一条执行记录。命令只消费给定报告中的指纹，不重新运行 QA 或读取当前资源；给出旧报告时，新记录仍绑定旧依据。配置未指定存储时使用配置文件同目录的 `lioni.exceptions.yaml`，显式设置 `quality.exceptionStore` 时则只使用该自定义存储。SDK 可调用公开的 `upsertQualityExceptionFromReport` 选择并保存同一类型的执行记录。例外只批准一个检查项对指定原文键和语言产生的全部诊断；可独立接受的问题应由不同检查项负责，避免一条批准扩大到其他职责。

例外批准与结果缓存有不同用途。Node QA 默认读取人工维护的例外 YAML；缓存须显式装配，只影响计算成本。普通 QA 不会写入或刷新例外，也不会改写比较基线。调用方可直接组合报告数组：

```ts
const activeErrors = report.diagnostics.filter(
  ({ severity, handling }) =>
    severity === "error" && handling.status === "active",
);
```

将例外作为诊断豁免的首选方式，并为可独立接受的问题划分不同检查项。单位解释等影响检查输入的业务配置应进入配置或指纹依据；例外只表示对特定检查结果的批准。

## QA 结果缓存

缓存通过配置中的 `quality.resultCache` 显式启用。Node 环境可选择官方文件实现；文件位于配置文件同目录的 `.lioni/cache/quality-results.json`。纯配置对象不会猜测当前工作目录，未配置缓存的 SDK 或 CLI 不会读写缓存：

```ts
import { fileURLToPath } from "node:url";

import { createDefaultQualityCheckResultCache } from "lioni/node";
import { defineConfig } from "lioni";

export default defineConfig({
  // 其余宿主配置……
  quality: {
    resultCache: createDefaultQualityCheckResultCache(
      fileURLToPath(import.meta.url),
    ),
  },
});
```

也可将 `quality.resultCache` 替换为实现 `get` 与 `set` 的自定义存储。缓存只保存 `complete` 和 `not-applicable` 的原始检查结果；失败、未完成、文件损坏或存储故障会重新计算。命中后仍会执行本次候选选择、投影与 schema 校验，并按当前报告关联诊断和应用例外，因此修改或删除 YAML 例外会立即反映在结果中。
