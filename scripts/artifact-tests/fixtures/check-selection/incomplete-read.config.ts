import baseConfig from "./lioni.config.ts";

const translations = baseConfig.translations;
if (translations === undefined)
  throw new Error("check-selection 配置缺少 translations。");

export default {
  ...baseConfig,
  translations: {
    ...translations,
    read: (
      _language: string,
      sourceUnits: readonly { readonly key: string }[],
    ) => ({
      scopes: [
        {
          range: "partial-fr.json",
          enumeration: "partial" as const,
          covers: sourceUnits.map(({ key }) => key),
          records: [],
        },
      ],
    }),
  },
  quality: {
    checks: baseConfig.quality?.checks ?? [],
  },
};
