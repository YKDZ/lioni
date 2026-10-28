# 自有术语检查评测

审阅状态：human-reviewed（2026-10-28）。输入与参考答案按用户已确认版本保留。

当前约定：`workspace` 在简体中文中使用“工作区”；“工作间”为禁用译法。

| 原文                          | 译文                         | 判断                                                           |
| ----------------------------- | ---------------------------- | -------------------------------------------------------------- |
| Open the workspace settings.  | 打开工作区设置。             | 使用允许译法，没有问题。                                       |
| Restore the workspace.        | 恢复工作区，旧术语为工作间。 | “工作间”是禁用译法，应提示问题；“工作区”可以使用。             |
| Save the workspace.           | 保存当前项目。               | 没有使用允许译法“工作区”，应提示缺少该译法。                   |
| The workspaceX mode is ready. | 模式已就绪。                 | `workspaceX` 是一个整体，不应把其中的 `workspace` 当作该术语。 |

用户已认可当前术语约定和四行判断。

## 运行

从仓库根目录运行：

```bash
pnpm --filter @lioni/terminology evaluation:quality --input scripts/evaluation/cases/qa/inputs --output scripts/evaluation/cases/qa/reports/current
```

`inputs/` 与本说明由 Git 跟踪，`reports/` 整体忽略。本评测无外部语料或 `.scratch` 依赖，也不被通用入口或单元测试隐式选用；删除当前目录即可移除本评测。
