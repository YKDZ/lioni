import type { createKumaAnalysis } from "../analysis.ts";
import type { Project } from "../model.ts";
import { createCriticalCopyReviewCheck } from "./critical-copy-review.ts";
import { createFamilyCheck } from "./message-family.ts";
import { createProtectedLiteralsCheck } from "./protected-literals.ts";
import { createQuantityCheck } from "./quantities.ts";
import { createResourceContractCheck } from "./resource-contract.ts";
import { createTerminologyChecks } from "./terminology.ts";
import { createMessageContractCheck } from "./vue-message-contract.ts";

export { createResourceContractCheck } from "./resource-contract.ts";
export { createMessageContractCheck } from "./vue-message-contract.ts";
export { createProtectedLiteralsCheck } from "./protected-literals.ts";
export { createQuantityCheck } from "./quantities.ts";
export { createCriticalCopyReviewCheck } from "./critical-copy-review.ts";
export { createTerminologyChecks } from "./terminology.ts";
export { createFamilyCheck } from "./message-family.ts";

export function createKumaQualityChecks(
  project: Project,
  analysis: ReturnType<typeof createKumaAnalysis>,
) {
  return [
    createResourceContractCheck(project),
    createMessageContractCheck(project),
    createProtectedLiteralsCheck(project),
    createQuantityCheck(project),
    createCriticalCopyReviewCheck(project),
    ...createTerminologyChecks(project, analysis),
    createFamilyCheck(project, analysis),
  ];
}
