import {
  createKumaAdapter,
  createKumaAnalysis,
  createKumaQualityChecks,
  createKumaQualityRequest,
  createLazyKumaQualityChecks,
  defineConfig,
  loadKumaCatalog,
  loadKumaQaProject,
} from "./qa/lioni/index.ts";
import type { KumaFacts, KumaFiles } from "./qa/lioni/index.ts";

export const files: KumaFiles = {
  root: new URL(".", import.meta.url),
  catalog: await loadKumaCatalog(
    new URL("./src/lang/lioni/catalog.json", import.meta.url),
  ),
};
const analysis = createKumaAnalysis();
export function createKumaConfig(kumaFiles: KumaFiles) {
  const projects = new WeakMap<
    KumaFacts,
    ReturnType<typeof loadKumaQaProject>
  >();
  function projectForFacts(facts: KumaFacts) {
    let project = projects.get(facts);
    if (project === undefined) {
      project = loadKumaQaProject(kumaFiles, facts);
      projects.set(facts, project);
    }
    return project;
  }

  return defineConfig({
    ...createKumaAdapter(kumaFiles),
    sourceToContent: (source) => ({ text: source.text }),
    qualityChecks: createLazyKumaQualityChecks(projectForFacts, (project) =>
      createKumaQualityChecks(project, analysis),
    ),
    createQualityRequest: async (facts) => {
      const kumaFacts = facts as KumaFacts;
      return createKumaQualityRequest(
        await projectForFacts(kumaFacts),
        kumaFacts,
      );
    },
  });
}

export default createKumaConfig(files);
