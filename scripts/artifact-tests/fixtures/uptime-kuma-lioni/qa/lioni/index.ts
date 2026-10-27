// 原样导出同一份依赖，根配置与运行器共享 Lioni 的配置身份。
export { defineConfig } from "@lioni/core";
export {
  loadKumaCatalog,
  loadKumaQaProject,
  createKumaAdapter,
  createKumaQualityRequest,
} from "./adapter.ts";
export type { KumaCatalog, KumaFacts, KumaFiles } from "./adapter.ts";
export { createKumaAnalysis } from "./analysis.ts";
export { createLazyKumaQualityChecks } from "./lazy-quality.ts";
export { createKumaQualityChecks } from "./checks/index.ts";
export {
  createResourceContractCheck,
  createSourceSyntaxCheck,
  createTargetSyntaxCheck,
  createVariableCorrespondenceCheck,
  createCallArgumentCheck,
  createLinkTargetCheck,
  createLinkCycleCheck,
  createProtectedLiteralsCheck,
  createQuantityCheck,
  createTerminologyChecks,
  createFamilyCheck,
} from "./checks/index.ts";
