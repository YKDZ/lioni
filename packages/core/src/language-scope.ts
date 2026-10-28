/** 本次执行的目标语言范围；不会修改配置中声明的语言集合。 */
export type LanguageSelectionOptions = {
  /**
   * 省略时处理全部已声明语言。显式选择必须非空且全部已声明；
   * 重复语言只处理一次，执行顺序沿用配置顺序。未选语言不会被读取。
   */
  readonly languages?: readonly string[];
};

export function resolveLanguageSelection(
  configuredLanguages: readonly string[],
  options: LanguageSelectionOptions,
): readonly string[] {
  const requested = options.languages;
  if (requested === undefined) return configuredLanguages;
  if (
    !Array.isArray(requested) ||
    requested.length === 0 ||
    requested.some((language) => typeof language !== "string")
  )
    throw new TypeError("本次执行的 languages 必须是非空语言列表。");

  for (const language of requested) {
    if (!configuredLanguages.includes(language))
      throw new TypeError(
        `目标语言 ${JSON.stringify(language)} 未在配置中声明。`,
      );
  }
  const selected = new Set(requested);
  return [...new Set(configuredLanguages)].filter((language) =>
    selected.has(language),
  );
}
