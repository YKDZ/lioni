import type { QualityCheckStatus } from "./qa.ts";

/**
 * 框架阶段、检查项准备及候选处理子阶段；同名阶段按所在层级解释。
 * facts 包含资源读取与关联；checks 包含公共准备、检查计算和例外汇总。
 * prepareInput 包含选择、投影、验证及依据回调；fingerprint 仅为摘要与缓存键计算。
 * snapshot 为检查结果快照，results 为候选诊断及执行记录整理。
 */
export type QualityProfileStage =
  | "configuration"
  | "exceptions"
  | "facts"
  | "load"
  | "candidates"
  | "checks"
  | "cleanup"
  | "configurationPreparation"
  | "configurationFingerprint"
  | "prepareInput"
  | "fingerprint"
  | "cacheRead"
  | "execute"
  | "snapshot"
  | "cacheWrite"
  | "results";
/** 候选中断独立于规则返回状态；not-run 只沿用质量检查状态词汇。 */
export type QualityProfileCandidateStatus = QualityCheckStatus | "interrupted";
type CacheReads = Record<"hit" | "miss" | "invalid" | "error", number>;
type CacheWrites = Record<"completed" | "error", number>;
/** 缓存接口可见证据；适配器内部吞掉的错误不计入 error。 */
export type QualityProfileCache = {
  readonly enabled: boolean;
  /** miss 仅表示 get 返回 undefined，不能证明底层存储不存在。 */
  readonly reads: Readonly<CacheReads>;
  /** completed 仅表示 set 正常返回，不保证已落盘。 */
  readonly writes: Readonly<CacheWrites>;
};

/** 性能证据只描述毫秒经过时间，包含异步等待；父阶段包含子阶段，不可跨层相加。 */
export type QualityProfileTiming = {
  readonly stage: QualityProfileStage;
  readonly durationMs: number;
  readonly calls: number;
};
export type QualityProfileCandidate = {
  readonly candidateIndex: number;
  readonly sourceKey: string;
  readonly language: string;
  readonly status: QualityProfileCandidateStatus;
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
  /** candidates 汇总包含准备、指纹、缓存、执行及结果整理；其子项不可重复相加。 */
  readonly timings: readonly QualityProfileTiming[];
  /** 已进入处理的候选结果计数；缺少的状态表示 0，含中断候选。 */
  readonly outcomes: Readonly<
    Partial<Record<QualityProfileCandidateStatus, number>>
  >;
  readonly cache: QualityProfileCache;
  readonly slowestCandidates: readonly QualityProfileCandidate[];
};
export type QualityProfileReport = {
  readonly schemaVersion: 1;
  /** completed 表示调用正常返回（包括 QA 失败）；interrupted 表示调用抛错。 */
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
  QualityProfileStage,
  { stage: QualityProfileStage; durationMs: number; calls: number }
>;
type MutableCheck = {
  checkId: string;
  durationMs: number;
  candidateCount: number;
  executedRules: number;
  outcomes: Partial<Record<QualityProfileCandidateStatus, number>>;
  timings: Timings;
  cache: {
    enabled: boolean;
    reads: CacheReads;
    writes: CacheWrites;
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
        outcomes: {},
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
  function span(
    target: Timings,
    stage: QualityProfileStage,
    total?: MutableCheck,
  ) {
    const start = performance.now();
    let closed = false;
    let duration = 0;
    const end = () => {
      if (closed) return duration;
      closed = true;
      open.delete(end);
      checkSpans.delete(end);
      duration = performance.now() - start;
      const timing = target.get(stage) ?? { stage, durationMs: 0, calls: 0 };
      timing.durationMs += duration;
      timing.calls++;
      target.set(stage, timing);
      if (total !== undefined) total.durationMs += duration;
      return duration;
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
    stage: (stage: QualityProfileStage) => span(stages, stage),
    checkStage(id: string, stage: QualityProfileStage) {
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
      const timings: Timings = new Map();
      const endTotal = span(entry.timings, "candidates", entry);
      let closed = false;
      const finish = (
        status: QualityProfileCandidateStatus,
        completed: boolean,
      ) => {
        if (closed) return;
        closed = true;
        candidates.delete(interrupt);
        entry.outcomes[status] = (entry.outcomes[status] ?? 0) + 1;
        const durationMs = endTotal();
        if (state.limit === 0) return;
        const record = {
          ...identity,
          status,
          completed,
          durationMs,
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
        stage(stage: QualityProfileStage) {
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
        finish: (status: QualityProfileCandidateStatus) => finish(status, true),
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
