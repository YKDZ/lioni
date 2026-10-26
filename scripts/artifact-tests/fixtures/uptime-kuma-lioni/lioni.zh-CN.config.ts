import { createKumaConfig, files } from "./lioni.config.ts";
import { loadKumaCatalog } from "./qa/lioni/adapter.ts";

const catalog = await loadKumaCatalog(
  new URL("./src/lang/lioni/catalog.zh-CN.json", import.meta.url),
);

export default createKumaConfig({ ...files, catalog });
