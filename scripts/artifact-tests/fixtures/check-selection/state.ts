import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export type CandidateMode = "default" | "empty" | "throw";
export type TermsLoaderMode =
  | "none"
  | "failure"
  | "contract-error"
  | "reader-contract-error";

let sharedRevision = "v1";
let candidateMode: CandidateMode = "default";
let builderReadsShared = true;
let sharedReadFails = false;
let termsLoaderMode: TermsLoaderMode = "none";

const eventsPath = () =>
  path.join(process.cwd(), ".check-selection-events.jsonl");

export function recordEvent(event: string): void {
  appendFileSync(eventsPath(), `${event}\n`, "utf8");
}

export function resetEvents(): void {
  writeFileSync(eventsPath(), "", "utf8");
}

export function readEvents(): string[] {
  try {
    return readFileSync(eventsPath(), "utf8")
      .split("\n")
      .filter((event) => event.length > 0);
  } catch {
    return [];
  }
}

export function setSharedRevision(value: string): void {
  sharedRevision = value;
}

export function setCandidateMode(value: CandidateMode): void {
  candidateMode = value;
}

export function getCandidateMode(): CandidateMode {
  return candidateMode;
}

export function setBuilderReadsShared(value: boolean): void {
  builderReadsShared = value;
}

export function shouldBuilderReadShared(): boolean {
  return builderReadsShared;
}

export function setSharedReadFails(value: boolean): void {
  sharedReadFails = value;
}

export function setTermsLoaderMode(value: TermsLoaderMode): void {
  termsLoaderMode = value;
}

export function getTermsLoaderMode(): TermsLoaderMode {
  return termsLoaderMode;
}

export type QualityData = {
  readonly key: string;
  readonly revision: string;
  readonly origin: "shared" | "independent";
};

export async function readSharedData(key: string): Promise<QualityData> {
  recordEvent("shared:read");
  if (sharedReadFails) throw new Error("共享检查资料读取失败。");
  return { key, revision: sharedRevision, origin: "shared" };
}

export async function readIndependentData(key: string): Promise<QualityData> {
  recordEvent("independent:read");
  return { key, revision: sharedRevision, origin: "independent" };
}

export function compileQualityData(data: QualityData): {
  readonly key: string;
  readonly revision: string;
} {
  recordEvent(`compile:${data.origin}:${data.revision}`);
  return { key: data.key, revision: `normalized-${data.revision}` };
}
