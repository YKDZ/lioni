# 发布维护说明

产品版本由维护者更新在 `apps/cli/package.json`，唯一发布说明维护在产品目录 `apps/cli/CHANGELOG.md`。每个版本使用与完整包版本完全相同的二级标题，例如 `## 0.1.0`；Changesets Action 会按包目录与版本读取对应段落作为 GitHub Release 说明。Changesets 负责打包和发布，不要求逐项 changeset、自动版本 PR 或日志生成。

## 首次本机发布

首次发布前，确认经审阅的版本和说明已提交到公开仓库 `YKDZ/lioni` 的 `main`，且该版本尚未出现在 npm。发布前检查通过不代表已经发布。

1. 检出 `main` 并确认工作区干净，安装锁定依赖：

   ```sh
   git switch main
   git pull --ff-only origin main
   pnpm install --frozen-lockfile
   ```

2. 运行发布工作流使用的检查，并通过正式路径构建和打包：

   ```sh
   pnpm run check
   pnpm run check:heavy
   pnpm run publication:pack
   ```

3. 审阅 `.changeset/packed` 中唯一的 `lioni` 制品。确认其名称和版本为 `lioni@0.1.0`，manifest 声明 MIT、公开发布和 `YKDZ/lioni`，README、LICENSE 与实际文件一致，制品没有内部包或源码测试文件。保留这次已审阅的打包结果，不要在上传前重新构建。

4. 由维护者在本机完成 npm 登录，确认账号后使用同一打包目录上传：

   ```sh
   npm login
   npm whoami
   pnpm run publication:publish
   ```

   本机认证和上传由维护者完成。不要把凭据写入仓库或 CI；不要用试发包来初始化产品。

5. 发布后分别核对 npm 版本、默认 dist-tag 和 Changesets 生成的 Git 标签：

   ```sh
   npm view lioni@0.1.0 version license repository dist.tarball --json
   npm view lioni dist-tags --json
   git tag --list 'lioni@0.1.0'
   ```

   本机上传不会自动创建 GitHub Release。确认该标签指向 `main` 上的发布提交后，维护者将标签推送到 `YKDZ/lioni`，并创建对应的 GitHub Release；发布标题与内容使用 `apps/cli/CHANGELOG.md` 的 `0.1.0` 段落。记录 npm 上传、Git 标签和 GitHub Release 的实际结果，不把其中一步当作另外两步已完成。

## 后续 GitHub OIDC 发布

`.github/workflows/release.yml` 仅支持手动触发；打包和发布作业都要求运行在仓库默认分支。打包作业执行常规及重型检查、构建并生成 Changesets 制品，发布作业接收同一制品，并使用 `npm` GitHub Environment 与 OIDC 权限。

待下一个真实版本准备好后，维护者在 npm 为 `lioni` 配置可信发布者：

- GitHub 仓库：`YKDZ/lioni`
- 工作流文件名：`release.yml`（文件位于 `.github/workflows/release.yml`）
- GitHub Environment：`npm`
- 发布权限：允许工作流直接发布

不要配置长期 npm token。npm 新建的可信发布者设置需在 48 小时内首次成功使用；因此应与真实的新版本发布同步设置，并在期限内从 `main` 手动运行工作流、确认成功上传了该版本。没有新的真实版本时，暂不登记信任；不要重跑已发布的 `0.1.0`、空跑工作流或制造版本来证明 OIDC。分别记录可信发布设置和首次 OIDC 发布的真实结果。

详细字段说明见 [npm 可信发布者文档](https://docs.npmjs.com/trusted-publishers/)。
