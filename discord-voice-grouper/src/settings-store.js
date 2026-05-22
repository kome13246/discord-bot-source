import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const settingsPath = resolve(process.cwd(), "data", "settings.json");

let cache;

export async function getGuildSettings(guildId) {
  const settings = await readSettings();
  return settings[guildId] ?? getEnvironmentSettings(guildId);
}

export async function saveGuildSettings(guildId, patch) {
  const settings = await readSettings();
  const current = settings[guildId] ?? {};

  settings[guildId] = {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
  };

  await writeSettings(settings);
  return settings[guildId];
}

async function readSettings() {
  if (cache) {
    return cache;
  }

  try {
    const raw = await readFile(settingsPath, "utf8");
    cache = JSON.parse(raw);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }

    cache = {};
  }

  return cache;
}

async function writeSettings(settings) {
  await mkdir(dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  cache = settings;
}

function getEnvironmentSettings(guildId) {
  if (process.env.DISCORD_GUILD_ID && process.env.DISCORD_GUILD_ID !== guildId) {
    return null;
  }

  const tempRoleId = process.env.PB_TEMP_ROLE_ID;
  const parentChannelId = process.env.PB_PARENT_CHANNEL_ID;
  const childCategoryId = process.env.PB_CHILD_CATEGORY_ID;
  const finishMessage = process.env.PB_FINISH_MESSAGE;

  if (!tempRoleId && !parentChannelId && !childCategoryId && !finishMessage) {
    return null;
  }

  return {
    tempRoleId,
    parentChannelId,
    childCategoryId,
    finishMessage,
    updatedAt: "environment",
  };
}
