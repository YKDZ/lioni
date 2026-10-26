import type { QuantityProfile } from "./common.ts";
import { englishQuantities } from "./en.ts";
import { japaneseQuantities } from "./ja.ts";
import { simplifiedChineseQuantities } from "./zh-CN.ts";
export type { QuantityProfile, QuantityOptions } from "./common.ts";
const profiles: readonly QuantityProfile[] = [
  englishQuantities,
  simplifiedChineseQuantities,
  japaneseQuantities,
];
/** 显式选择能力；不会把未知语言悄悄交给另一种语言的词法。 */
export function quantityProfile(
  id: string | undefined,
  language: string,
): QuantityProfile | undefined {
  return profiles.find(
    (profile) => profile.id === id && profile.supports(language),
  );
}
