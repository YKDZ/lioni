/** 公开宿主接入资产的位置，供制品验收部署同一份 runtime 与资源。 */
export const uptimeKumaOverlay = {
  runtime: new URL("./src/", import.meta.url),
  tests: new URL("./test/", import.meta.url),
  tsconfig: new URL("./tsconfig.json", import.meta.url),
  rootConfig: new URL("./overlay/lioni.config.ts", import.meta.url),
  chineseConfig: new URL("./overlay/lioni.zh-CN.config.ts", import.meta.url),
  resources: new URL("./overlay/src/lang/lioni/", import.meta.url),
  packageManifest: new URL("./package.json", import.meta.url),
} as const;
