type CandidateInput = {
  readonly candidate: {
    readonly sourceKey: string;
    readonly language: string;
    readonly content: { readonly resourceStatus?: unknown };
  };
};

export type KumaCandidateStatus = "available" | "missing" | "unavailable";

/** 区分真实空候选与宿主为盘点生成的缺译占位。 */
export function kumaCandidateStatus(
  input: CandidateInput,
): KumaCandidateStatus {
  const status = input.candidate.content.resourceStatus;
  return status === "missing" || status === "unavailable"
    ? status
    : "available";
}
