/** 性能证据只描述毫秒经过时间，包含异步等待；父阶段包含子阶段，不可跨层相加。 */
export type QualityProfileTiming = {
  readonly stage: string;
  readonly durationMs: number;
  readonly calls: number;
};
export type QualityProfileCandidate = {
  readonly candidateIndex: number;
  readonly sourceKey: string;
  readonly language: string;
  readonly status: string;
  readonly completed: boolean;
  readonly durationMs: number;
  readonly timings: readonly QualityProfileTiming[];
};
export type QualityProfileCheck = {
  readonly checkId: string;
  /** 只累计本检查项自身片段；共享计算成本归于首次实际使用的位置。 */
  readonly durationMs: number;
  readonly candidateCount: number;
  readonly executedRules: number;
  readonly timings: readonly QualityProfileTiming[];
  /** 仅表示缓存接口可见结果；正常返回不保证持久化成功。 */
  readonly cache: {
    readonly enabled: boolean;
    readonly reads: Readonly<
      Record<"hit" | "miss" | "invalid" | "error", number>
    >;
    readonly writes: Readonly<Record<"completed" | "error", number>>;
  };
  readonly slowestCandidates: readonly QualityProfileCandidate[];
};
export type QualityProfileReport = {
  readonly schemaVersion: 1;
  readonly status: "completed" | "interrupted";
  readonly totalMs: number;
  readonly stages: readonly QualityProfileTiming[];
  readonly checks: readonly QualityProfileCheck[];
};
export type QualityProfilerOptions = {
  /** 每项检查保留的慢候选上限，默认为 10；0 只保留汇总。 */
  readonly slowestCandidates?: number;
};
export type QualityProfiler = {
  /** 仅在绑定的调用结束后读取；返回独立 JSON 数据，不输出解释或建议。 */
  readonly report: () => QualityProfileReport;
};
type Timings = Map<
  string,
  { stage: string; durationMs: number; calls: number }
>;
type MutableCheck = {
  checkId: string;
  durationMs: number;
  candidateCount: number;
  executedRules: number;
  timings: Timings;
  cache: {
    enabled: boolean;
    reads: Record<"hit" | "miss" | "invalid" | "error", number>;
    writes: Record<"completed" | "error", number>;
  };
  slowestCandidates: QualityProfileCandidate[];
};
const sessions = new WeakMap<
  QualityProfiler,
  { used: boolean; report?: QualityProfileReport; limit: number }
>();

/** 创建单次检查运行专用的采集器；不得重置、复用或在运行中读取。 */
export function createQualityProfiler(
  options: QualityProfilerOptions = {},
): QualityProfiler {
  const limit = options.slowestCandidates ?? 10;
  if (!Number.isSafeInteger(limit) || limit < 0)
    throw new TypeError("slowestCandidates 必须为非负安全整数。");
  const state: { used: boolean; report?: QualityProfileReport; limit: number } =
    { used: false, limit };
  const profiler: QualityProfiler = Object.freeze({
    report() {
      if (state.report === undefined) throw new TypeError("性能采集尚未结束。");
      return structuredClone(state.report);
    },
  });
  sessions.set(profiler, state);
  return profiler;
}

/** 内部正式运行接缝，不作为产品 SDK 导出。 */
export function beginQualityProfile(profiler: QualityProfiler) {
  const state = sessions.get(profiler);
  if (state === undefined || state.used)
    throw new TypeError("性能采集器必须由工厂创建且只能使用一次。");
  state.used = true;
  const started = performance.now();
  const stages: Timings = new Map();
  const checks = new Map<string, MutableCheck>();
  const open = new Set<() => void>();
  const candidates = new Set<() => void>();
  const checkSpans = new Set<() => void>();
  function check(id: string) {
    let entry = checks.get(id);
    if (entry === undefined) {
      entry = {
        checkId: id,
        durationMs: 0,
        candidateCount: 0,
        executedRules: 0,
        timings: new Map(),
        cache: {
          enabled: false,
          reads: { hit: 0, miss: 0, invalid: 0, error: 0 },
          writes: { completed: 0, error: 0 },
        },
        slowestCandidates: [],
      };
      checks.set(id, entry);
    }
    return entry;
  }
  function span(target: Timings, stage: string, total?: MutableCheck) {
    const start = performance.now();
    let closed = false;
    const end = () => {
      if (closed) return;
      closed = true;
      open.delete(end);
      checkSpans.delete(end);
      const duration = performance.now() - start;
      const timing = target.get(stage) ?? { stage, durationMs: 0, calls: 0 };
      timing.durationMs += duration;
      timing.calls++;
      target.set(stage, timing);
      if (total !== undefined) total.durationMs += duration;
    };
    open.add(end);
    if (target !== stages) checkSpans.add(end);
    return end;
  }
  function endChecks() {
    for (const end of [...checkSpans].reverse()) end();
    for (const interrupt of candidates) interrupt();
  }
  return {
    endChecks,
    configure(id: string, enabled: boolean) {
      check(id).cache.enabled = enabled;
    },
    stage: (stage: string) => span(stages, stage),
    checkStage(id: string, stage: string) {
      const entry = check(id);
      return span(entry.timings, stage, entry);
    },
    candidate(
      id: string,
      identity: { candidateIndex: number; sourceKey: string; language: string },
      enabled: boolean,
    ) {
      const entry = check(id);
      entry.candidateCount++;
      entry.cache.enabled = enabled;
      const start = performance.now();
      const timings: Timings = new Map();
      const endTotal = span(entry.timings, "candidates", entry);
      let closed = false;
      const finish = (status: string, completed: boolean) => {
        if (closed) return;
        closed = true;
        candidates.delete(interrupt);
        endTotal();
        if (state.limit === 0) return;
        const record = {
          ...identity,
          status,
          completed,
          durationMs: performance.now() - start,
          timings: [...timings.values()],
        };
        entry.slowestCandidates.push(record);
        entry.slowestCandidates.sort(
          (a, b) =>
            b.durationMs - a.durationMs || a.candidateIndex - b.candidateIndex,
        );
        if (entry.slowestCandidates.length > state.limit)
          entry.slowestCandidates.pop();
      };
      const interrupt = () => finish("interrupted", false);
      candidates.add(interrupt);
      return {
        stage(stage: string) {
          const local = span(timings, stage);
          const aggregate = span(entry.timings, stage);
          return () => {
            local();
            aggregate();
          };
        },
        executed() {
          entry.executedRules++;
        },
        read(result: "hit" | "miss" | "invalid" | "error") {
          entry.cache.reads[result]++;
        },
        write(result: "completed" | "error") {
          entry.cache.writes[result]++;
        },
        finish: (status: string) => finish(status, true),
      };
    },
    finish(status: "completed" | "interrupted") {
      endChecks();
      for (const end of [...open].reverse()) end();
      state.report = {
        schemaVersion: 1,
        status,
        totalMs: performance.now() - started,
        stages: [...stages.values()],
        checks: [...checks.values()].map((entry) => ({
          ...entry,
          timings: [...entry.timings.values()],
        })),
      };
    },
  };
}
export type QualityProfileSession = ReturnType<typeof beginQualityProfile>;
export type QualityProfileCandidateSession = ReturnType<
  QualityProfileSession["candidate"]
>;
