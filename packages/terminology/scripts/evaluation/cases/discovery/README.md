# 自有候选发现评测

审阅状态：human-reviewed（2026-10-28）。输入与参考答案按用户已确认版本保留。

以下是三段软件英文正文：

1. Open project workspace settings to review the project snapshot.
2. The project workspace stores a snapshot. Review the snapshot before changing workspace settings.
3. Review the project snapshot before saving a workspace.

两套独立参考答案：

| 草案 | 候选词                                                                                                |
| ---- | ----------------------------------------------------------------------------------------------------- |
| A    | `project workspace`（项目工作区）、`project snapshot`（项目快照）、`workspace settings`（工作区设置） |
| B    | `project snapshot`（项目快照）、`workspace settings`（工作区设置）、`snapshot`（快照）                |

用户已认可 A、B 两组候选答案。

## 运行

从仓库根目录运行：

```bash
pnpm --filter @lioni/terminology evaluation:quality --input scripts/evaluation/cases/discovery/inputs --output scripts/evaluation/cases/discovery/reports/current
```

`inputs/` 与本说明由 Git 跟踪，`reports/` 整体忽略。本评测无外部语料或 `.scratch` 依赖，也不被通用入口或单元测试隐式选用；删除当前目录即可移除本评测。
