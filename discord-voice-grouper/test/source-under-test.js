import { readdir, readFile } from "node:fs/promises";

const sourceRoot = new URL("../src/", import.meta.url);

export async function readBotImplementationSource() {
  const featureNames = (await readdir(new URL("features/", sourceRoot)))
    .filter((name) => name.endsWith(".js"))
    .sort();
  const featureSources = await Promise.all(featureNames.map(
    (name) => readFile(new URL(`features/${name}`, sourceRoot), "utf8"),
  ));
  const compositionRoot = await readFile(new URL("bot.js", sourceRoot), "utf8");
  return [...featureSources, compositionRoot].join("\n");
}
