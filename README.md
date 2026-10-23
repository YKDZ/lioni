# 本地化框架

框架将原文单元和实际译文分别作为事实读取。宿主决定资源来源、上下文、原文身份、目标语言和源译匹配关系；框架不要求项目实体或译文业务 key，也不会根据同文、位置或同名 key 猜测关系。

## 宿主配置

在宿主仓库安装 `@l10n/core` 和 `@l10n/cli` 后，创建 `l10n.config.ts`：

```ts
import { defineConfig } from "@l10n/core";

export default defineConfig({
  source: {
    async read() {
      return {
        scopes: [
          {
            range: "src/messages.ts",
            enumeration: "complete",
            records: [
              {
                value: {
                  source: "Save",
                  context: {
                    file: "src/messages.ts",
                    line: 18,
                    screenshot: "shots/save-button.png",
                  },
                },
                bodyAvailability: "available",
              },
            ],
          },
        ],
      };
    },
  },
  keyOf(unit) {
    return `${unit.context.file}:${unit.context.line}`;
  },
  translations: {
    languages: ["fr"],
    async read(language, sourceUnits) {
      return {
        scopes: [
          {
            range: `locales/${language}.json`,
            covers: sourceUnits.map(({ key }) => key),
            enumeration: "complete",
            records: [
              {
                value: {
                  text: "Enregistrer",
                  context: { sourceFile: "src/messages.ts", sourceLine: 18 },
                },
                bodyAvailability: "available",
              },
            ],
          },
        ],
      };
    },
    matches(unit, translation) {
      return (
        unit.context.file === translation.context.sourceFile &&
        unit.context.line === translation.context.sourceLine
      );
    },
  },
});
```

`read()` 返回宿主解释的范围及该范围内发现的记录。`enumeration` 说明范围是否完整、部分完成或读取失败；每条记录用 `bodyAvailability` 表示正文可用性。即使正文不可用，记录仍会保留为已发现对象。`keyOf` 收到原始原文单元及其上下文；身份重复时，`readSourceFacts` 和 `readFacts` 会抛出 `DuplicateTranslationUnitKeyError`，CLI 会返回冲突身份。

范围内没有记录时，也要返回一个 `enumeration: "complete"` 且 `records: []` 的范围，表示已确认其为空。空的 `scopes` 表示没有读取该范围，不能据此声称资源总数为零或原文缺译。

`translations.languages` 明确选择目标语言。目标适配器为每种语言返回实际译文，并用 `matches(unit, translation)` 建立关系。译文可以没有业务 key，也可以被多个原文共享；没有关联原文的目标记录仍保留在事实结果中。

每个目标读取范围的 `covers` 列出该范围可能包含哪些原文的译文，使用 `keyOf` 生成的身份。应列出所有可能相关的范围，包括部分读取或失败的范围。只有该原文所有相关范围都完整枚举且没有匹配记录，结果才会是可靠缺译；部分读取中发现一条匹配不能证明它是唯一匹配，两条已发现匹配则会保留为冲突。若没有声明覆盖该原文的范围，结果为未知。

关联中的 `translationIndexes` 指向 `facts.translations.records` 中的实际译文记录。同一索引可以被多个原文引用；索引只在当前事实结果中有意义，不是译文业务 key。

配置装配不会读取资源。`readSourceFacts` 可独立读取原文；`readFacts` 在同一份输入上读取显式目标语言并计算一次源译关联：

```ts
import config from "./l10n.config.ts";
import { readFacts, readSourceFacts } from "@l10n/core";

const sourceFacts = await readSourceFacts(config);
const facts = await readFacts(config);
```

来源总数仅在全部来源范围完整枚举时提供，否则为 `null`。组合事实保留来源和译文读取范围、原始记录、正文可用性、目标语言及关联索引。关联状态可为 `matched`、`missing`、`unavailable`、`unknown` 或 `conflict`；`coverageStatus` 单独说明覆盖是否完整、失败或尚未读取。事实版本随实际输入和关联结果变化。原始上下文和范围需能序列化为 JSON。

## 完成统计

只有请求完成统计时才需要宿主配置完成判据。`resolveCompletion` 是普通函数，接收当前原文、源译关联和匹配到的实际译文；宿主可以按正文、状态或项目规则判定，也可以对证据不足返回未知：

```ts
completion: {
  criterion: "译文正文可读且非空",
  resolveCompletion({ association, translations }) {
    if (association.status === "unavailable") {
      return { status: "unknown", reason: "译文正文不可用。" };
    }
    return translations.some(
      ({ translation }) =>
        typeof translation.text === "string" && translation.text.trim() !== "",
    );
  },
},
```

`readCompletion(config)` 在同一份源译事实上计算判据，并返回事实及 `completion` 报告。义务按本次全部原文与显式目标语言组合；缺译和无资源语言仍计入分母，目标独有译文不增加分母。部分或失败的读取、正文不可用及匹配冲突保留为未知依据，不会自动记作未完成或缺译。原文范围不完整时保留已知条目的局部结果，总义务数和完成率为 `null`，并说明总数未知原因。

也可以复用一份事实快照比较不同宿主判据，不需要重新读取或重新匹配：

```ts
import config from "./l10n.config.ts";
import { evaluateCompletion, readFacts } from "@l10n/core";

const facts = await readFacts(config);
const report = await evaluateCompletion(facts, {
  criterion: "项目自己的判据",
  resolveCompletion: ({ translations }) => translations.length > 0,
});
```

也可以用 CLI 读取同一份配置：

```sh
l10n facts ./l10n.config.ts
l10n facts ./l10n.config.ts --output-format text
l10n completion ./l10n.config.ts
l10n completion ./l10n.config.ts --output-format text
```

默认输出结构化结果；文本模式展示同一事实版本、来源、实际译文、读取状态和关联状态。完成命令展示判据、统计范围、逐项义务和未知原因。

## 当前质量检查

`@l10n/checks` 提供可选的消息占位符检查器。宿主配置显式导出检查器，CLI 才会执行它；CLI 本身不导入 `@l10n/checks`：

```ts
import { createMessagePlaceholderChecker } from "@l10n/checks";

export const qualityChecks = [
  createMessagePlaceholderChecker({
    sourceText: (unit) => unit.source,
    translationText: (translation) => translation.text,
    configuration: { grammar: "simple-placeholders-v1" },
  }),
];
```

检查器适配器由宿主提供，用来从原始单元和实际译文中取出消息文本。CLI 默认检查事实中的所有源译组合；也可以导出 `qualityRequest(facts)`，显式返回 `subjects`、`evidenceScope` 和 `dependencies` 来缩小检查范围或声明规则所需输入。未导出 `qualityChecks` 时，`qa` 会返回 `not-run`。

诊断对象中的 `key` 使用 `keyOf` 生成的逻辑身份。位置默认只使用宿主读取时提供的资源范围，不会把逻辑身份当成资源内键。需要精确定位时，`createMessagePlaceholderChecker` 可配置 `sourceLocation(unit, subject, defaultLocation)` 和 `translationLocation(translation, subject, defaultLocation)`；两个回调都能读取原始对象，并返回宿主可解释的位置。关系检查器也可用 `translationLocation` 为成员译文提供资源内定位。

```sh
l10n qa ./l10n.config.ts
l10n qa ./l10n.config.ts --output-format text
```

程序化调用可自行指定对象、证据范围、依赖及检查器：

```ts
import { readFacts, runQualityChecks } from "@l10n/core";

const facts = await readFacts(config);
const result = await runQualityChecks(
  facts,
  {
    subjects: [{ key: "src/messages.ts:18", language: "fr" }],
    evidenceScope: [
      { kind: "translation-unit", key: "src/messages.ts:18", language: "fr" },
    ],
    dependencies: { policyRevision: "2026-10" },
    relationships: [
      {
        kind: "same-target-text",
        key: "shared-save",
        members: [
          { key: "src/messages.ts:18", language: "fr" },
          { key: "src/messages.ts:19", language: "fr" },
        ],
      },
    ],
    exceptions: [
      {
        id: "allow-existing-wording",
        ruleId: "same-target-text",
        scope: { object: { kind: "relationship", key: "shared-save" } },
        reason: "保留宿主现有译法。",
      },
    ],
  },
  qualityChecks,
);
```

宿主通过 `createRelationshipChecker` 以普通函数定义关系约束：`relationshipKind` 选择宿主声明的关系，`evaluate` 接收全部允许范围内且内容可用的成员，并返回可选诊断。核心只传递关系，不枚举同译等约束。选中一个成员时，检查器仍可读取证据范围内的其他成员；诊断对象保留完整关系，展示位置默认取关系首个成员，即使该成员未被选中也会保留诊断。

关系约束只需提供宿主函数；例如将成员译文投影成文本后比较：

```ts
import { createRelationshipChecker } from "@l10n/checks";

const sameTargetText = createRelationshipChecker<
  Unit,
  Translation,
  { readonly relation: string }
>({
  id: "same-target-text",
  relationshipKind: "same-target-text",
  configuration: { relation: "same-target-text" },
  translationLocation: (translation, _subject, location) => ({
    ...location,
    key: translation.nativeKey,
  }),
  evaluate({ members }) {
    const texts = members.map(({ translation }) => translation.text);
    return new Set(texts).size === 1
      ? undefined
      : { severity: "error", message: "关系成员应使用相同译文。" };
  },
});
```

将 `sameTargetText` 与其他检查器一起放入 `qualityChecks`。`qualityRequest(facts)` 中的关系成员使用逻辑身份，`evidenceScope` 独立列出允许作为证据的成员。

例外按规则和对象或位置范围命中；同时提供对象与位置时，两者都要匹配。`location` 范围按语言、资源范围及可选的资源内定位键匹配。命中后只在诊断上增加 `handling: { status: "excepted", exceptionId, reason }`，保留原诊断和证据，不改变检查执行状态或基础事实。

执行状态 `complete` 只表示所选检查已完成；即使存在 error 诊断也可能是 `complete`。未支持的 ICU 或链接消息会使检查 `incomplete` 并附带原因，损坏的占位符会使检查 `failed`。内置解析范围覆盖普通文本、`{name}`／`{0}` 占位符及以 `|` 分隔的分支；不同目标语言可以使用不同分支数。

## 处理基线

处理基线按原文身份和目标语言分别保存变化已处理的依据。读取事实和比较不会写入基线；首次缺少历史时，比较结果会报告 `history-insufficient`。显式推进某些范围后，其他观察到的范围仍标记为未处理，后续比较可以区分旧工作和新增内容。关联冲突或未知范围不会推进。

Node 宿主可直接使用默认文件存储，也可实现相同的 `ProcessingBaselineStore` 接口替换存储：

```ts
import {
  advanceProcessingBaseline,
  compareProcessingBaseline,
  readFacts,
} from "@l10n/core";
import { createFileProcessingBaselineStore } from "@l10n/core/node";
import config from "./l10n.config.ts";

const store = createFileProcessingBaselineStore(
  ".l10n/processing-baseline.json",
);
const facts = await readFacts(config);
const comparison = compareProcessingBaseline(facts, await store.load());

// 只将本次明确处理的原文身份和语言推进为已处理。
const result = await advanceProcessingBaseline(store, facts, [
  { sourceKey: "src/messages.ts:18", language: "fr" },
]);
```

文件存储在同目录写入新文件后原子替换基线；读取损坏或不支持的文件会报告错误，保存失败会返回原有基线。为确认原文或译文范围的删除，宿主应在不同进程中持续使用相同的 JSON 范围值；比较只接受历史与当前对应范围都完整枚举的证据，其他范围的成功读取不能替代。

已消失的原文仍保留历史单元和相关译文范围。若宿主明确处理这项删除，可在推进时传入原有 `matches` 函数；它会重新检查历史相关范围，保留仍存在的目标事实，并只推进该原文身份和语言。

## 语义编辑

宿主可把候选保存为可 JSON 序列化的语义编辑。已有译文的位置由实际译文定位；新增位置由宿主根据原始原文单元、语言和自身配置确定。身份 key 不作为资源物理位置。宿主还可以声明候选依赖的上下文，例如截图；未声明的元数据变化不会自动阻止局部写入：

```ts
import { prepareSemanticEdit, readFacts } from "@l10n/core";
import config from "./l10n.config.ts";

const facts = await readFacts(config);
const prepared = await prepareSemanticEdit(
  facts,
  { sourceKey: "src/messages.ts:18", language: "fr", content: "Enregistrer" },
  config,
);

if (prepared.status === "prepared") {
  // 将 JSON 保存到宿主自己的候选文件，可在后续进程中读取。
  await saveEdit(JSON.stringify(prepared.edit));
}
```

`edits` 配置提供实际目标内容读取、现有目标定位、新目标定位和宿主写入函数。定位函数必须使用宿主的真实资源来源；无法定位或资源只读时返回 `notWritable`。写入函数应只改候选目标并保留同一资源中的无关内容：

```ts
edits: {
  targetContent: (translation) => translation.text,
  locateExistingTarget({ translation }) {
    return {
      status: "located",
      locator: {
        file: translation.translation.context.file,
        key: translation.translation.context.resourceKey,
      },
    };
  },
  locateNewTarget({ sourceUnit, language }) {
    return {
      status: "located",
      locator: {
        file: `locales/${language}.json`,
        key: sourceUnit.unit.context.resourceKey,
      },
    };
  },
  dependencies: ({ sourceUnit }) => ({
    screenshot: sourceUnit.unit.context.screenshot,
  }),
  async write({ edit, target }) {
    await hostResources.update(target.locator, edit.content);
  },
},
```

新进程读取候选后，`applySemanticEdits` 会重新读取事实，核对原文、目标正文、已声明依赖和宿主解析出的实际位置，再调用写入函数；写入后会再次读取并报告观察到的资源结果：

```ts
import { applySemanticEdits, type SemanticEdit } from "@l10n/core";

const edit = JSON.parse(await readSavedEdit()) as SemanticEdit;
const result = await applySemanticEdits([edit], config);
```

每项结果会区分 `written`、`writeUnconfirmed`、`conflict`、`notWritable`、`writeFailed` 和 `unprocessed`，并在可读取时带上写入前后的事实。多匹配和已变化的相关输入不会写入。语义编辑只改实际资源，不运行 QA、判定完成状态或推进处理基线。

## 本地制品

在框架仓库根目录打包后，可在宿主目录安装生成的 tarball：

```sh
mkdir -p /tmp/l10n-packages
pnpm --filter @l10n/core pack --pack-destination /tmp/l10n-packages
pnpm --filter @l10n/checks pack --pack-destination /tmp/l10n-packages
pnpm --filter @l10n/cli pack --pack-destination /tmp/l10n-packages
```

若这些私有 tarball 尚未发布，宿主的 `pnpm-workspace.yaml` 需把 CLI 的内部 semver 依赖指向同一包集中的 core 制品：

```yaml
overrides:
  "@l10n/core@0.0.0": "file:/tmp/l10n-packages/l10n-core-0.0.0.tgz"
```

此路径对应上面的 `/tmp/l10n-packages` 示例；按宿主实际 tarball 路径调整。

然后在宿主目录安装所需制品：

```sh
pnpm add /tmp/l10n-packages/l10n-core-0.0.0.tgz /tmp/l10n-packages/l10n-cli-0.0.0.tgz
```

每次 core 制品变化后，重新打包 core、checks 和 CLI，并在干净宿主目录重新安装同一包集。仓库中的 `pnpm verify:independent-consumer` 会自动完成该流程并检查已安装类型、API 和 CLI。`facts` 入口读取源译事实；`completion` 在其上按宿主判据生成义务与统计。`@l10n/checks` 的具体检查器随对应能力交付，由宿主配置显式选择。
