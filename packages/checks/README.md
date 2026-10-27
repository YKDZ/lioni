# `@lioni/checks`

`@lioni/checks` 提供可组合的 QA 检查器。宿主负责选择候选和明确投影正文；检查器不会猜测 JSON 字段。

## Vue I18n 语法

原文与译文语法有独立检查身份：`vue-i18n/source-syntax` 和 `vue-i18n/target-syntax`。宿主分别选择所需检查器，并通过 `sourceText`、`targetText` 指定正文投影。译文检查只依赖候选投影，所以目标独有键也能检查；显式空字符串会作为正文检查。

```ts
import {
  createVueI18nSourceSyntaxChecker,
  createVueI18nTargetSyntaxChecker,
} from "@lioni/checks";

const sourceSyntax = createVueI18nSourceSyntaxChecker({
  select: ({ sourceUnit, candidate }) => {
    if (sourceUnit === null)
      return {
        status: "incomplete",
        issue: { code: "sourceUnavailable", message: "找不到原文。" },
      };
    return {
      status: "selected",
      subject: {
        sourceUnit,
        sourceKey: candidate.sourceKey,
        language: candidate.language,
      },
    };
  },
  sourceText: (unit) => unit.catalog.message.body,
  sourceLocation: (_unit, subject, range) => ({
    language: null,
    range: { file: "source.json", key: subject.key, span: range },
    key: subject.key,
  }),
});

const targetSyntax = createVueI18nTargetSyntaxChecker({
  select: ({ candidate }) => ({
    status: "selected",
    subject: {
      sourceKey: candidate.sourceKey,
      language: candidate.language,
      content: candidate.content,
    },
  }),
  targetText: (content) => content.catalog.message.body,
});
```

原文语法按每个已选择的目标语言候选分别执行。编译器报出的原文偏移通过 `sourceLocation` 映射回宿主资源；译文检查也可用 `targetLocation` 做对应映射。语法诊断是 error，但语法本身完成解析时检查执行状态仍为 complete。

### 解析事实

`parseVueI18nMessage(text)` 使用官方 `@intlify/message-compiler`，固定兼容基准为 11.2.8。结果保留语法错误的 code、类别、说明和 UTF-16 半开范围；每个分支包含正文、范围及按原始顺序记录的变量身份。重复变量不会去重，位置变量使用 `list:<index>`、命名变量使用 `named:<name>`。`tokens` 保留对应范围；`links` 和 `linkFacts` 暴露静态关联键及动态关联键变量。

升级编译器可能改变可接受语法或解析事实，必须有意更新依赖版本和相应检查实现版本，再通过正式制品消费验收。共享解析器返回的语法错误不会被例外处理或其他检查的执行顺序改写。

## Vue I18n 变量对应

`createVueI18nVariableCorrespondenceChecker` 使用同样的显式选择和正文投影方式，检查身份为 `vue-i18n/variable-correspondence`。它在每个原始分支内分别统计命名变量和位置变量的身份及次数，然后比较两侧去重后的计数模式集合。变量顺序和分支顺序不参与比较；相同模式的分支可以合并或重复，空变量模式也参与比较。`n` 与 `count` 是不同身份，Literal 不计变量，动态关联键中的直接变量计入，静态关联目标的正文不会展开。

这是静态正文契约检查，不判断运行时会选中哪个复数分支，也不推断函数调用传参或实际渲染行为。原文或译文存在语法错误时，变量检查返回 incomplete，不重复生成语法诊断；请同时装配 source/target syntax 检查器来报告对应语法问题。

```ts
import { createVueI18nVariableCorrespondenceChecker } from "@lioni/checks";

const variableCorrespondence = createVueI18nVariableCorrespondenceChecker({
  select: ({ sourceUnit, candidate }) => {
    if (sourceUnit === null)
      return {
        status: "incomplete",
        issue: { code: "sourceUnavailable", message: "找不到原文。" },
      };
    return {
      status: "selected",
      subject: {
        sourceUnit,
        sourceKey: candidate.sourceKey,
        language: candidate.language,
        content: candidate.content,
      },
    };
  },
  sourceText: (unit) => unit.catalog.message.body,
  targetText: (content) => content.catalog.message.body,
});
```

检查只处理 QA 正式选择的候选。缺译不会隐式成为空字符串候选；宿主显式提供的空字符串候选会正常比较。
