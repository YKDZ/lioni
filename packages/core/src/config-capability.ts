import type { FrameworkConfig, TranslationUnitInput } from "./index.ts";

type FrameworkConfigConsumer<TResult> = <
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  config: FrameworkConfig<TUnit, TTranslation, TBody, TUnavailable>,
) => TResult;

export type FrameworkConfigRunner = <TResult>(
  consumer: FrameworkConfigConsumer<TResult>,
) => TResult;

const runners = new WeakMap<object, FrameworkConfigRunner>();

export function bindFrameworkConfig<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  config: FrameworkConfig<TUnit, TTranslation, TBody, TUnavailable>,
): FrameworkConfig<TUnit, TTranslation, TBody, TUnavailable> {
  runners.set(config, (consumer) => consumer(config));
  return config;
}

export function frameworkConfigRunner(
  value: unknown,
): FrameworkConfigRunner | undefined {
  return typeof value === "object" && value !== null
    ? runners.get(value)
    : undefined;
}
