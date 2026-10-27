import {
  kanjiNumber,
  quantityLexicon,
  technicalDataUnits,
  technicalTimeUnits,
} from "./common.ts";
import type { QuantityProfile } from "./common.ts";
const timeUnits = {
  ...technicalTimeUnits,
  ミリ秒: 0.001,
  秒: 1,
  秒間: 1,
  分: 60,
  分間: 60,
  時間: 3600,
  時: 3600,
  日: 86400,
  日間: 86400,
};
export const japaneseQuantities: QuantityProfile = {
  id: "ja",
  supports: (language) => /^ja(?:-|$)/iu.test(language),
  ...quantityLexicon({
    timeUnits,
    dataUnits: { ...technicalDataUnits, バイト: 1 },
    normalize(text, facts) {
      return text
        .normalize("NFKC")
        .replace(
          /((?:毎\s*[零〇一二三四五六七八九十百千万0-9.\s]*(?:ミリ秒|秒|分|時間|日)|[零〇一二三四五六七八九十百千万0-9.\s]*(?:ミリ秒|秒|分|時間|日)(?:ごと|毎))[^。；;]{0,20})(?:1|一)回/gu,
          "$1",
        )
        .replace(
          /第([零〇一二三四五六七八九十百千万]+|\d+)|([零〇一二三四五六七八九十百千万]+|\d+)番目/gu,
          (_all, prefix: string | undefined, suffix: string | undefined) => {
            const value = prefix ?? suffix!;
            facts.add(
              `序数:${/^[0-9]/u.test(value) ? Number(value) : kanjiNumber(value)}`,
            );
            return " ";
          },
        )
        .replace(
          /(?:[零〇一二三四五六七八九][零〇一二三四五六七八九十百千万]*|十[一二三四五六七八九]?)(?=\s*(?:ミリ秒|秒|分|時間|日|バイト|回|段|件|個))/gu,
          (value) => String(kanjiNumber(value)),
        )
        .replace(
          /(?<![\d.])(?:1\s*)?(ミリ秒|秒|分|時間|日)(?:あたり|当たり)/gu,
          (_all, unit: string) => {
            facts.add(
              `频率基准秒:${timeUnits[unit as keyof typeof timeUnits]}`,
            );
            return " ";
          },
        )
        .replace(/毎(ミリ秒|秒|分|時|日)/gu, (_all, unit: string) => {
          facts.add(`频率基准秒:${timeUnits[unit as keyof typeof timeUnits]}`);
          return " ";
        });
    },
  }),
};
