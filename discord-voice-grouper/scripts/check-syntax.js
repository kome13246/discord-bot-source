import { readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

function listJavaScriptFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return listJavaScriptFiles(path);
    return entry.isFile() && entry.name.endsWith(".js") ? [path] : [];
  });
}

const sourceFiles = listJavaScriptFiles("src");

for (const file of sourceFiles) {
  const result = spawnSync(process.execPath, ["--check", file], {
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout);
    process.exit(result.status ?? 1);
  }
}

for (const file of sourceFiles.filter((path) => path.includes(join("src", "features")))) {
  const result = spawnSync(process.execPath, ["scripts/find-free-identifiers.js", file], {
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.status !== 0 || result.stdout.trim()) {
    process.stderr.write(
      result.stderr
      || `Unresolved feature dependencies in ${file}:\n${result.stdout}`,
    );
    process.exit(result.status || 1);
  }
}
