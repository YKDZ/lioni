import type { QualityCheckDefinition, QualityObject } from "@lioni/core";

import type { createKumaAnalysis } from "../analysis.ts";
import type { Body, Project, Translation, Unit } from "../model.ts";
import { snapshotKumaProject } from "../project-snapshot.ts";
import { createFamilyCheck } from "./message-family.ts";
import { createProtectedLiteralsCheck } from "./protected-literals.ts";
import { createQuantityCheck } from "./quantities.ts";
import { createResourceContractCheck } from "./resource-contract.ts";
import { createTerminologyChecks } from "./terminology.ts";
import {
  createSourceSyntaxCheck,
  createTargetSyntaxCheck,
  createVariableCorrespondenceCheck,
} from "./vue-i18n.ts";
import {
  createCallArgumentCheck,
  createLinkCycleCheck,
  createLinkTargetCheck,
} from "./vue-message-host.ts";

export { createResourceContractCheck } from "./resource-contract.ts";
export { createProtectedLiteralsCheck } from "./protected-literals.ts";
export { createQuantityCheck } from "./quantities.ts";
export { createTerminologyChecks } from "./terminology.ts";
export { createFamilyCheck } from "./message-family.ts";
export {
  createSourceSyntaxCheck,
  createTargetSyntaxCheck,
  createVariableCorrespondenceCheck,
} from "./vue-i18n.ts";
export {
  createCallArgumentCheck,
  createLinkCycleCheck,
  createLinkTargetCheck,
} from "./vue-message-host.ts";

type KumaCheck = QualityCheckDefinition<
  Unit,
  Translation,
  QualityObject,
  Body,
  never
>;

export function createKumaQualityChecks(
  project: Project,
  analysis: ReturnType<typeof createKumaAnalysis>,
) {
  const snapshot = snapshotKumaProject(project);
  const checks: KumaCheck[] = [
    createResourceContractCheck(snapshot),
    createSourceSyntaxCheck(snapshot),
    createTargetSyntaxCheck(snapshot),
    createVariableCorrespondenceCheck(snapshot),
    createCallArgumentCheck(snapshot),
    createLinkTargetCheck(snapshot),
    createLinkCycleCheck(snapshot),
    createProtectedLiteralsCheck(snapshot),
    createQuantityCheck(snapshot),
    ...createTerminologyChecks(snapshot, analysis),
    createFamilyCheck(snapshot, analysis),
  ];
  return checks;
}
