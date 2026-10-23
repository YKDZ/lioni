# 本地化框架

框架把原文单元作为独立事实读取。宿主决定原文来源、上下文和单元身份；读取原文不需要先读取译文，也不要求项目实体、原生 key 或单元内的目标语言。

## 宿主配置

在宿主仓库安装 `@l10n/core` 和 `@l10n/cli` 后，创建 `l10n.config.ts`：

```ts
import { defineConfig } from "@l10n/core";

export default defineConfig({
  source: {
    async readUnits() {
      return [
        {
          source: "Save",
          context: {
            file: "src/messages.ts",
            line: 18,
            screenshot: "shots/save-button.png",
          },
        },
      ];
    },
  },
  keyOf(unit) {
    return `${unit.context.file}:${unit.context.line}`;
  },
});
```

`keyOf` 收到适配器返回的原始单元，宿主可选择原文、位置或其他上下文计算身份。不同单元身份重复时，`readSourceFacts` 会抛出 `DuplicateTranslationUnitKeyError`；CLI 会返回失败状态和冲突身份。

配置装配不会读取资源。需要在代码中读取原文事实时，调用公开函数：

```ts
import config from "./l10n.config.ts";
import { readSourceFacts } from "@l10n/core";

const facts = await readSourceFacts(config);
```

`facts` 包含由实际原文输入计算的版本，以及身份与原始单元。配置中的上下文会随原始单元保留；上下文需能序列化为 JSON，以便生成版本和 CLI 输出。

也可以用 CLI 读取同一份配置：

```sh
l10n facts ./l10n.config.ts
l10n facts ./l10n.config.ts --output-format text
```

默认输出结构化结果，文本模式展示相同的版本、身份、原文和上下文。

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

每次 core 制品变化后，重新打包 core、checks 和 CLI，并在干净宿主目录重新安装同一包集。仓库中的 `pnpm verify:independent-consumer` 会自动完成该流程并检查已安装类型、API 和 CLI。当前 `facts` 入口仅读取原文事实；`@l10n/checks` 的具体检查器随对应能力交付，由宿主配置显式选择。
