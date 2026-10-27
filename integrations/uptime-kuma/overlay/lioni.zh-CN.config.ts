import {
  createKumaConfig,
  loadKumaCatalog,
} from "lioni-uptime-kuma-host/config";

import { files } from "./lioni.config.ts";

const catalog = await loadKumaCatalog(
  new URL("./src/lang/lioni/catalog.zh-CN.json", import.meta.url),
);

export default createKumaConfig({ ...files, catalog });
