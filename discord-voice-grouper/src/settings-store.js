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

  const tempRoleId =
    process.env.PB_PARTICIPANT_ROLE_ID ?? process.env.PB_TEMP_ROLE_ID;
  const parentChannelId = process.env.PB_PARENT_CHANNEL_ID;
  const childCategoryId = process.env.PB_CHILD_CATEGORY_ID;
  const waitingVcCategoryId =
    process.env.PB_WAITING_VC_CATEGORY_ID ?? process.env.PB_WAITING_CHANNEL_ID;
  const waitingVcName = process.env.PB_WAITING_VC_NAME;
  const voiceReminderChannelId = process.env.PB_VOICE_REMINDER_CHANNEL_ID;
  const voiceTopicChannelId = process.env.PB_VOICE_TOPIC_CHANNEL_ID;
  const voiceReminderParentChannelId = process.env.PB_VOICE_REMINDER_PARENT_CHANNEL_ID;
  const voiceReminderChildCategoryId = process.env.PB_VOICE_REMINDER_CHILD_CATEGORY_ID;
  const voiceReminderEnabled = parseOptionalBoolean(process.env.PB_VOICE_REMINDER_ENABLED);
  const transferWaitSeconds = process.env.PB_TRANSFER_WAIT_SECONDS;
  const noticeWaitMinutes = process.env.PB_NOTICE_WAIT_MINUTES;
  const roleRemoveWaitMinutes = process.env.PB_ROLE_REMOVE_WAIT_MINUTES;

  if (
    !tempRoleId &&
    !parentChannelId &&
    !childCategoryId &&
    !waitingVcCategoryId &&
    !waitingVcName &&
    !voiceReminderChannelId &&
    !voiceTopicChannelId &&
    !voiceReminderParentChannelId &&
    !voiceReminderChildCategoryId &&
    voiceReminderEnabled === undefined &&
    !transferWaitSeconds &&
    !noticeWaitMinutes &&
    !roleRemoveWaitMinutes
  ) {
    return null;
  }

  return {
    tempRoleId,
    parentChannelId,
    childCategoryId,
    waitingVcCategoryId,
    waitingVcName,
    voiceReminderChannelId,
    voiceTopicChannelId,
    voiceReminderParentChannelId,
    voiceReminderChildCategoryId,
    voiceReminderEnabled,
    transferWaitSeconds: parseOptionalInteger(transferWaitSeconds),
    noticeWaitMinutes: parseOptionalInteger(noticeWaitMinutes),
    roleRemoveWaitMinutes: parseOptionalInteger(roleRemoveWaitMinutes),
    updatedAt: "environment",
  };
}

function parseOptionalBoolean(value) {
  if (value === undefined) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on") {
    return true;
  }

  if (normalized === "false" || normalized === "0" || normalized === "no" || normalized === "off") {
    return false;
  }

  return undefined;
}

function parseOptionalInteger(value) {
  if (value === undefined) {
    return undefined;
  }

  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : undefined;
}
