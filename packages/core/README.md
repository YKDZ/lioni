# 质量检查输入指纹

质量检查通过 `defineQualityCheck`、`bindQualityCheck` 和 `analyzeQuality` 接入。每项检查都要提供稳定的 `id` 和显式 `version`。版本表示检查算法与宿主组合逻辑；算法或宿主选择、投影、位置映射及策略发生语义变化时，应更新对应版本。

每条候选检查执行都会在 `checks[].executions[]` 中报告 `checkId`、原文键、目标语言、状态和可比较的 `inputFingerprint`。摘要分别给出检查版本、最终配置摘要和业务输入摘要。诊断带有 `checkId` 与 `executionId`，可关联到产生它的候选执行。同键同语言的多个候选会分别保留记录。

使用 `@lioni/checks` 的内置工厂时，另提供 `hostVersion` 描述宿主的选择、投影和组合逻辑。工厂会将它与固定的内置算法版本合并。

## 默认输入依据

默认依据包含完整框架事实、当前候选、对应原文单元、检查依赖和关联关系。对象属性顺序不影响摘要，数组顺序保留。输入必须是普通 JSON；函数、`memo`、例外和存储实例不属于默认依据。框架始终把检查身份、实现版本及经过 schema 转换的最终配置加入指纹。

闭包依赖不会自动纳入指纹。宿主资料、外部策略和会影响诊断内容、位置或证据的数据，应通过检查依赖或自定义指纹依据显式提供。检查作者可在自定义依据中组合默认构造能力：

```ts
import {
  createDefaultQualityInputBasis,
  defineQualityCheck,
} from "@lioni/core";
import type { JsonValue } from "@lioni/core";

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

绑定检查的 `fingerprintInput` 在适用范围选择完成、投影结果通过 `inputSchema` 校验后调用，可使用同次执行的 `subject` 和 `projected`。如果选择结果不适用，或选择/投影无法完成，框架不会生成可比较指纹。检查不依赖其他检查的执行顺序。

## 原文、译文与文本投影

`config.source.read()` 读取宿主定义的原文记录，`source.schema` 校验记录结构。框架保留完整原文单元；`sourceUnit.unit.source` 的业务含义由宿主定义，框架不会从任意 JSON 字段猜测正文。

译文适配器的 `translations.contentOf()` 明确地从译文记录取出正文。候选的 `content` 使用该正文类型，也可以是宿主提供的结构化内容。检查作者通过 `select` 决定候选范围，再通过 `project` 映射检查实际需要的文本或结构；投影结果经 `inputSchema` 校验后交给检查函数。原文适配器、译文正文与检查投影因此分别负责读取、内容提取和检查输入。

## QA 例外

例外由检查报告中的执行记录创建，绑定检查项、原文键、目标语言和完整输入指纹，并覆盖该次候选检查的全部诊断：

```ts
import { createQualityException } from "@lioni/core";

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
      version: "catalog-term-policy-v1"
      configurationFingerprint: sha256:复制报告中的配置摘要
      inputFingerprint: sha256:复制报告中的业务输入摘要
```

直接向 `analyzeQuality(config)` 传入纯配置对象时，框架不会猜测当前目录；没有配置存储就不使用例外。自定义 `qualityExceptionStore` 会替换 Node 默认 YAML 来源。低层 `runQualityChecks` 仍可接收宿主已读取的例外列表。QA 报告分别给出诊断处理和 `exceptionApplicability`：输入、最终配置或检查版本改变时显示原因，局部未执行时标记为本次未验证；依据恢复后，旧例外会重新适用。即使本次没有诊断，也会报告适用性。

例外批准与结果缓存有不同用途。Node QA 默认读取人工维护的例外 YAML；缓存须显式装配，只影响计算成本。普通 QA 不会写入或刷新例外，也不会改写比较基线。调用方可直接组合报告数组：

```ts
const activeErrors = report.diagnostics.filter(
  ({ severity, handling }) =>
    severity === "error" && handling.status === "active",
);
```

将例外作为诊断豁免的首选方式，并为可独立接受的问题划分不同检查项。单位解释等影响检查输入的业务配置应进入配置或指纹依据；例外只表示对特定检查结果的批准。
