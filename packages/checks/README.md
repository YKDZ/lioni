# 检查模块

仓库内部的 `@lioni/checks` 模块提供可复用的语言无关质量判断，以及 Vue I18n 消息检查集合。产品使用说明与公开导入方式见 [`lioni` 使用文档](../../apps/cli/README.md)。

Vue 项目使用 `createVueI18nChecks(...)` 注册消息语法、变量对应、消息引用、术语、数量、受保护字面值和消息族一致性检查。宿主通过质量依赖加载器提供当次消息资料与术语库，通过投影回调映射候选和已保存译文。该集合解析消息资源，不扫描 Vue、JavaScript 或 TypeScript 应用源码。

数量与受保护字面值比较使用 JSON 事实输入，返回纯问题值，供上层映射为诊断、位置和证据。术语和消息族工厂复用 `@lioni/terminology` 与 `@lioni/text-analysis`，由宿主或专用能力提供候选投影和位置。
