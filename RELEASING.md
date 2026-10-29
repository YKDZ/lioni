# 发布维护说明

维护者在 `apps/cli/package.json` 更新版本号，并在 `apps/cli/CHANGELOG.md` 编写该版本唯一的发布说明。标题使用完整包版本，例如 `## 0.1.1`。Changesets 会以此说明创建 GitHub Release；不使用逐项 changeset、自动版本 PR 或推送即发布。

## GitHub Actions OIDC 发布

发布工作流 `.github/workflows/release.yml` 只允许人工启动，打包和发布作业都要求运行在仓库默认分支。将版本号和说明合入默认分支后，在 GitHub Actions 页面选择该工作流并手动运行。

打包作业执行常规和重型门禁，再通过 `pnpm run publication:pack` 构建并生成 Changesets 发布计划和 tarball。随后，`scripts/run-artifact-tests.ts` 按该计划验收实际 tarball。只有验收成功后，工作流才上传 `.changeset/packed`；发布作业使用该上传制品发布，不会重新打包。Changesets 发布步骤使用 GitHub OIDC 上传 npm 包，并推送版本标签、按变更说明创建 GitHub Release。

首次使用或修改可信发布配置时，核对以下字段与本仓库工作流一致：

- npm 包：`@lioni/lioni`
- GitHub 用户或组织：`YKDZ`
- 仓库：`lioni`
- 工作流文件名：`release.yml`（不要填写目录路径）
- GitHub Environment：`npm`
- 允许该可信发布者直接发布 npm 包

GitHub Environment `npm` 必须存在。发布作业只授予 OIDC 所需的 `id-token: write` 与创建标签和 GitHub Release 所需的 `contents: write`；工作流不读取长期 npm 发布令牌。npm 包的 `repository.url` 必须与 GitHub 仓库地址匹配。可信发布的配置字段和权限要求见 [npm 可信发布者文档](https://docs.npmjs.com/trusted-publishers/)。

工作流成功后，分别核对 npm 版本、Git 版本标签及 GitHub Release，确认三者对应同一版本。失败或被跳过的步骤不代表发布已完成。
