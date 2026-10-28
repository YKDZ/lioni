/** Node.js 文件适配器与资源读取入口。 */
export {
  createDefaultQualityCheckResultCache,
  createDefaultQualityExceptionStore,
  createFileComparisonBaselineStore,
  createFileQualityCheckResultCache,
  createFileQualityExceptionStore,
  createFileUpdatePlanStore,
  loadConfig,
  resolveDefaultQualityCheckResultCachePath,
  resolveDefaultQualityExceptionFilePath,
} from "@lioni/core/node";
export { loadTermbaseYaml } from "@lioni/terminology/node";
export type { UpdatePlanStore } from "@lioni/core/node";
