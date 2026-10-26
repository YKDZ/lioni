export type QuantityOptions = {
  readonly aliases?: Readonly<Record<string, string>>;
  readonly defaultUnit?: string;
  readonly ignoredLiterals?: readonly string[];
};

export type QuantityProfile = {
  readonly id: string;
  readonly supports: (language: string) => boolean;
  readonly facts: (text: string, options: QuantityOptions) => Set<string>;
  readonly unitAfter: (
    text: string,
    options: QuantityOptions,
  ) => string | undefined;
};

export const technicalTimeUnits: Readonly<Record<string, number>> = {
  ms: 0.001,
  s: 1,
};
export const technicalDataUnits: Readonly<Record<string, number>> = {
  b: 1,
  byte: 1,
  bytes: 1,
  kb: 1000,
  kib: 1024,
  mb: 1e6,
  mib: 1024 ** 2,
  gb: 1e9,
  gib: 1024 ** 3,
  tb: 1e12,
  tib: 1024 ** 4,
};

/** 只在选定语言的词表中识别单位；别名来自对应资源的声明。 */
export function quantityLexicon(settings: {
  timeUnits: Readonly<Record<string, number>>;
  dataUnits: Readonly<Record<string, number>>;
  normalize: (text: string, facts: Set<string>) => string;
}) {
  const escape = (value: string) =>
    value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const normalizeUnit = (unit: string, options: QuantityOptions) =>
    (options.aliases?.[unit] ?? unit).toLowerCase();
  const unitPattern = (options: QuantityOptions) =>
    [
      ...new Set([
        ...Object.keys(settings.timeUnits),
        ...Object.keys(settings.dataUnits),
        ...Object.keys(options.aliases ?? {}),
      ]),
    ]
      .sort((a, b) => b.length - a.length)
      .map(escape)
      .join("|");
  function unitFact(
    unit: string,
    options: QuantityOptions,
  ): string | undefined {
    const canonical = normalizeUnit(unit, options);
    if (canonical in settings.timeUnits)
      return `时间秒:${settings.timeUnits[canonical]}`;
    if (canonical in settings.dataUnits)
      return `数据字节:${settings.dataUnits[canonical]}`;
    return undefined;
  }
  return {
    facts(text: string, options: QuantityOptions): Set<string> {
      const result = new Set<string>();
      let normalized = text;
      for (const literal of options.ignoredLiterals ?? [])
        if (literal) normalized = normalized.replaceAll(literal, " ");
      normalized = settings.normalize(normalized, result);
      // 当前三个语言算法均使用逗号作千分位；空格分隔的号码不合并。
      normalized = normalized.replace(
        /(?<![A-Za-z_\d,])[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?(?![\d,])/gu,
        (value) => value.replaceAll(",", ""),
      );
      normalized = normalized.replace(
        new RegExp(
          `(?<![A-Za-z_\\d.])([+-]?\\d+(?:\\.\\d+)?)\\s*(${unitPattern(options)})(?![A-Za-z])`,
          "giu",
        ),
        (all, value: string, unit: string) => {
          const canonical = normalizeUnit(unit, options);
          if (canonical in settings.timeUnits) {
            result.add(
              `时间秒:${Number((Number(value) * settings.timeUnits[canonical]!).toPrecision(12))}`,
            );
          } else if (canonical in settings.dataUnits) {
            result.add(
              `数据字节:${Number(value) * settings.dataUnits[canonical]!}`,
            );
          } else return all;
          return " ";
        },
      );
      const defaultUnit =
        options.defaultUnit === undefined
          ? undefined
          : normalizeUnit(options.defaultUnit, options);
      for (const match of normalized.matchAll(
        /(?<![A-Za-z_\d.])[+-]?\d+(?:\.\d+)?(?![A-Za-z_\d]|\.\d)/gu,
      )) {
        const value = Number(match[0]);
        if (defaultUnit && defaultUnit in settings.timeUnits)
          result.add(
            `时间秒:${Number((value * settings.timeUnits[defaultUnit]!).toPrecision(12))}`,
          );
        else if (defaultUnit && defaultUnit in settings.dataUnits)
          result.add(`数据字节:${value * settings.dataUnits[defaultUnit]!}`);
        else result.add(`数值:${value}`);
      }
      return result;
    },
    unitAfter(text: string, options: QuantityOptions): string | undefined {
      const match = text.match(
        new RegExp(`^\\s*(${unitPattern(options)})(?![A-Za-z])`, "iu"),
      );
      return match ? unitFact(match[1]!, options) : undefined;
    },
  };
}

/** 中日文共用的汉字位值转换；支持到万位，不推断约数。 */
export function kanjiNumber(text: string): number {
  const digits: Record<string, number> = {
    零: 0,
    〇: 0,
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  };
  if (!/[十百千万]/u.test(text))
    return Number(
      text
        .split("")
        .map((char) => digits[char])
        .join(""),
    );
  let total = 0,
    section = 0,
    current = 0;
  for (const char of text) {
    if (char in digits) {
      current = digits[char]!;
      continue;
    }
    if (char === "万") {
      total += (section + current) * 10000;
      section = 0;
      current = 0;
    } else {
      section +=
        (current || 1) *
        ({ 十: 10, 百: 100, 千: 1000 } as Record<string, number>)[char]!;
      current = 0;
    }
  }
  return total + section + current;
}
