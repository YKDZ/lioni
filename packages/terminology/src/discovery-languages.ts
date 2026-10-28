/** 功能词仅用于默认发现的短语边缘；不用于匹配已有术语或跨语言推断。 */
const functionWords: Readonly<Record<string, ReadonlySet<string>>> = {
  en: new Set(
    "a an the this that these those i me my we us our you your he him his she her it its they them their who which what whose am is are was were be been being do does did have has had and or but if then than as at by for from in into of on onto to with without not".split(
      " ",
    ),
  ),
  zh: new Set(
    "的 地 得 了 着 过 和 与 及 或 而 但 在 从 对 把 被 向 于 是 为 我 你 他 她 它 我们 你们 他们 这 那 这些 那些".split(
      " ",
    ),
  ),
  ja: new Set(
    "の は が を に へ と で や も から まで より です ます する した して いる ある これ それ あれ この その あの".split(
      " ",
    ),
  ),
};
const emptyWords: ReadonlySet<string> = new Set();

/** 未配置的语言保留全部词，由调用方的分词及候选生成政策提供语言能力。 */
export function discoveryFunctionWords(language: string): ReadonlySet<string> {
  try {
    return functionWords[new Intl.Locale(language).language] ?? emptyWords;
  } catch {
    return emptyWords;
  }
}
