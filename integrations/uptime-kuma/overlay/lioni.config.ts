import {
  createKumaConfig,
  loadKumaCatalog,
} from "lioni-uptime-kuma-host/config";

export const files = {
  root: new URL(".", import.meta.url),
  catalog: await loadKumaCatalog(
    new URL("./src/lang/lioni/catalog.json", import.meta.url),
  ),
};
export default createKumaConfig(files);
