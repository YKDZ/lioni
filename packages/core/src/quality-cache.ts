import type { QualityObject } from "./qa.ts";
import type { QualityCheckOutcome } from "./qa.ts";

export type CacheableQualityCheckOutcome<
  TObject extends QualityObject = QualityObject,
> = Omit<QualityCheckOutcome<TObject>, "status"> & {
  readonly status: "complete" | "not-applicable";
};

/** 原始检查结果缓存；异常处理和本次执行关联由缓存消费者在读取后完成。 */
export type QualityCheckResultCache<
  TObject extends QualityObject = QualityObject,
> = {
  get(key: string): Promise<CacheableQualityCheckOutcome<TObject> | undefined>;
  set(
    key: string,
    outcome: CacheableQualityCheckOutcome<TObject>,
  ): Promise<void>;
};
