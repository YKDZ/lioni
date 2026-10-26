import {
  quantityLexicon,
  technicalDataUnits,
  technicalTimeUnits,
} from "./common.ts";
import type { QuantityProfile } from "./common.ts";
const timeUnits = {
  ...technicalTimeUnits,
  millisecond: 0.001,
  milliseconds: 0.001,
  second: 1,
  seconds: 1,
  sec: 1,
  secs: 1,
  minute: 60,
  minutes: 60,
  min: 60,
  mins: 60,
  hour: 3600,
  hours: 3600,
  hr: 3600,
  hrs: 3600,
  day: 86400,
  days: 86400,
};
export const englishQuantities: QuantityProfile = {
  id: "en",
  supports: (language) => /^en(?:-|$)/iu.test(language),
  ...quantityLexicon({
    timeUnits,
    dataUnits: { ...technicalDataUnits, byte: 1, bytes: 1 },
    normalize(text, facts) {
      return text
        .replace(/\b(\d+)(?:st|nd|rd|th)\b/giu, (_all, value: string) => {
          facts.add(`序数:${Number(value)}`);
          return " ";
        })
        .replace(
          /\bper\s+(second|minute|hour|day)\b/giu,
          (_all, unit: string) => {
            facts.add(
              `频率基准秒:${timeUnits[unit.toLowerCase() as keyof typeof timeUnits]}`,
            );
            return " ";
          },
        );
    },
  }),
};
