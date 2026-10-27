import type { Project } from "./model.ts";

const snapshots = new WeakMap<Project, Project>();

/** 保留 QA 实际读取的项目资料，排除加载器的路径与原始文件记录。 */
export function snapshotKumaProject(project: Project): Project {
  const existing = snapshots.get(project);
  if (existing !== undefined) return existing;

  const snapshot = structuredClone({
    policies: project.policies,
    terms: project.terms,
    usages: project.usages,
  });
  snapshots.set(project, snapshot);
  snapshots.set(snapshot, snapshot);
  return snapshot;
}
