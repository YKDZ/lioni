/** Node.js 文件适配器与资源读取入口。 */
export {
  createDefaultDirectoryQualityCheckResultCache,
  createDefaultQaSuppressionStore,
  createFileComparisonBaselineStore,
  createDirectoryQualityCheckResultCache,
  createFileQaSuppressionStore,
  createFileUpdatePlanStore,
  loadConfig,
  resolveDefaultQualityCheckResultCacheDirectory,
  resolveDefaultQaSuppressionFilePath,
} from "@lioni/core/node";
export { loadTermbaseYaml } from "@lioni/terminology/node";
export type { UpdatePlanStore } from "@lioni/core/node";
