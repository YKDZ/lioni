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
