import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assembleTermbaseYaml,
  parseTermbaseYaml,
  type TermbaseYamlFiles,
} from "./yaml.ts";

/** 读取默认术语目录：concepts.yaml 和任意数量的 <language>.yaml 文件。 */
export async function readTermbaseYamlFiles(
  directory: string | URL,
): Promise<TermbaseYamlFiles> {
  const directoryPath =
    directory instanceof URL
      ? fileURLToPath(directory)
      : path.resolve(directory);
  const names = await readdir(directoryPath);
  const yamlNames = names.filter((name) => name.endsWith(".yaml"));
  if (!yamlNames.includes("concepts.yaml"))
    throw new TypeError(`术语目录缺少 concepts.yaml：${directoryPath}`);

  const concepts = await readFile(
    path.join(directoryPath, "concepts.yaml"),
    "utf8",
  );
  const languages: Record<string, string> = Object.create(null);
  for (const name of yamlNames) {
    if (name === "concepts.yaml") continue;
    const language = name.slice(0, -".yaml".length);
    if (!language) throw new TypeError(`术语语言文件名无效：${name}`);
    languages[language] = await readFile(
      path.join(directoryPath, name),
      "utf8",
    );
  }
  return { concepts, languages };
}

/** 读取完整术语目录并返回经过原生模型校验的术语库。 */
export async function loadTermbaseYaml(directory: string | URL) {
  const files = await readTermbaseYamlFiles(directory);
  return assembleTermbaseYaml(parseTermbaseYaml(files));
}
