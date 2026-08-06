import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("composition root loads without starting Discord or MongoDB", () => {
  const projectRoot = fileURLToPath(new URL("..", import.meta.url));
  const result = spawnSync(
    process.execPath,
    ["-e", "import('./src/bot.js').then(() => console.log('composition-root-ok'))"],
    {
      cwd: projectRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        DISCORD_TOKEN: "smoke-test-token",
        DISCORD_BOT_SKIP_START: "true",
        KEEP_ALIVE_PORT: "",
        PORT: "",
      },
      timeout: 15_000,
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /composition-root-ok/);
});
