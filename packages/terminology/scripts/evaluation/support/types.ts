export type ExecutionStatus = "passed" | "failed" | "not-executed";
export type DomainStatus = "complete" | "incomplete" | "not-run";
export type ScenarioAttempt = {
  readonly number: number;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly status: "passed" | "failed";
  readonly reason?: string;
  readonly process?: {
    readonly status: "passed" | "failed" | "timed-out" | "interrupted";
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
    readonly durationMs: number;
    readonly stdout: string;
    readonly stderr: string;
    readonly error?: string;
  };
};

export type EvaluationMetric = {
  readonly status: "evaluated" | "not-evaluated";
  readonly basis: string;
  readonly value?: unknown;
};

export type ScenarioReport = {
  readonly execution: {
    readonly status: ExecutionStatus;
    readonly reason?: string;
  };
  readonly domain: { readonly status: DomainStatus };
  readonly inputSha256?: string;
  readonly attempts?: readonly ScenarioAttempt[];
  readonly metrics: Readonly<Record<string, EvaluationMetric>>;
  readonly evidence?: unknown;
};

export type QualityReport = {
  readonly schemaVersion: 1;
  readonly kind: "quality";
  readonly runId: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly status: "running" | "passed" | "failed";
  readonly selected: readonly string[];
  readonly parameters: {
    readonly retries: number;
    readonly scenarioTimeoutMs: number;
    readonly generatedEntryCount: number;
    readonly sourceMode: "workspace-source";
    readonly rebuildExternalInputs: boolean;
  };
  readonly activeScenario?: {
    readonly name: string;
    readonly attempt: number;
  };
  readonly artifact: {
    readonly package: "@lioni/terminology";
    readonly version: string;
    readonly entry: "source";
  };
  readonly source: {
    readonly commit: string;
    readonly dirty: boolean;
    readonly changedFiles: readonly string[];
  };
  readonly environment: {
    readonly node: string;
    readonly icu: string | null;
    readonly unicode: string | null;
    readonly platform: string;
    readonly arch: string;
    readonly cpuModel: string | null;
    readonly cpuCount: number;
  };
  readonly scenarios: Readonly<Record<string, ScenarioReport>>;
};
