import {
  kanjiNumber,
  quantityLexicon,
  technicalDataUnits,
  technicalTimeUnits,
} from "./common.ts";
import type { QuantityProfile } from "./common.ts";
const timeUnits = {
  ...technicalTimeUnits,
  毫秒: 0.001,
  秒: 1,
  秒钟: 1,
  分钟: 60,
  小时: 3600,
  天: 86400,
  日: 86400,
};
export const simplifiedChineseQuantities: QuantityProfile = {
  id: "zh-CN",
  supports: (language) => language === "zh-CN" || language === "zh-Hans",
  ...quantityLexicon({
    timeUnits,
    dataUnits: { ...technicalDataUnits, 字节: 1 },
    normalize(text, facts) {
      return text
        .replace(
          /(每(?:隔)?\s*[零〇一二两三四五六七八九十百千万0-9.\s]*(?:毫秒|秒|分钟|小时)[^，。；;]{0,20})一次/gu,
          "$1",
        )
        .replace(
          /第([零〇一二两三四五六七八九十百千万]+|\d+)/gu,
          (_all, value: string) => {
            facts.add(
              `序数:${/^[0-9]/u.test(value) ? Number(value) : kanjiNumber(value)}`,
            );
            return " ";
          },
        )
        .replace(
          /(?:[零〇一二两三四五六七八九][零〇一二两三四五六七八九十百千万]*|十[一二三四五六七八九]?)(?=\s*(?:毫秒|秒|分钟|小时|天|日|字节|次|段|个))/gu,
          (value) => String(kanjiNumber(value)),
        )
        .replace(/每(毫秒|秒|分钟|小时|天)/gu, (_all, unit: string) => {
          facts.add(`频率基准秒:${timeUnits[unit as keyof typeof timeUnits]}`);
          return " ";
        });
    },
  }),
};
