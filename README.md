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

也可以用 CLI 读取同一份配置：

```sh
l10n facts ./l10n.config.ts
l10n facts ./l10n.config.ts --output-format text
```

默认输出结构化结果；文本模式展示同一事实版本、来源、实际译文、读取状态和关联状态。

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

然后在宿主目录安装 CLI 和 core：

```sh
pnpm add /tmp/l10n-packages/l10n-core-0.0.0.tgz /tmp/l10n-packages/l10n-cli-0.0.0.tgz
```

每次 core 制品变化后，重新打包 core、checks 和 CLI，并在干净宿主目录重新安装同一包集。仓库中的 `pnpm verify:independent-consumer` 会自动完成该流程并检查已安装类型、API 和 CLI。`facts` 入口读取原文；配置 `translations` 后，也会读取显式目标语言的实际译文并生成匹配及覆盖事实。`@l10n/checks` 的具体检查器随对应能力交付，由宿主配置显式选择。
