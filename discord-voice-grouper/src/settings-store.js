import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { GuildSettings } from "./models/guild-settings.js";
import mongoose from "mongoose";

const settingsPath = resolve(process.cwd(), "data", "settings.json");
let legacyCache;

export async function getGuildSettings(guildId) {
  if (mongoose.connection.readyState !== 1) {
    throw new Error("MongoDB is unavailable; guild settings cannot be read.");
  }
  let document = await GuildSettings.findOne({ guildId }).lean();
  if (!document) {
    const legacy = (await readLegacySettings())[guildId];
    if (legacy) {
      document = await GuildSettings.findOneAndUpdate(
        { guildId },
        { $setOnInsert: { ...removeUndefined(legacy), guildId } },
        { upsert: true, new: true, setDefaultsOnInsert: true, lean: true },
      );
    } else {
      return getEnvironmentSettings(guildId);
    }
  }
  const { _id, __v, guildId: ignoredGuildId, createdAt, updatedAt, ...settings } = document;
  return { ...settings, guildId, createdAt, updatedAt };
}

/** Atomically updates only the supplied fields. `undefined` is ignored. */
export async function patchGuildSettings(guildId, patch) {
  const cleanPatch = removeUndefined(patch);
  if (mongoose.connection.readyState !== 1) {
    throw new Error("MongoDB is unavailable; guild settings cannot be saved.");
  }
  const legacy = (await readLegacySettings())[guildId] ?? {};
  const saved = await GuildSettings.findOneAndUpdate(
    { guildId },
    { $set: cleanPatch, $setOnInsert: { ...removeUndefined(legacy), guildId } },
    { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true, lean: true },
  );
  const { _id, __v, guildId: ignoredGuildId, ...settings } = saved;
  return { ...settings, guildId };
}

export async function saveGuildSettings(guildId, patch) {
  return patchGuildSettings(guildId, patch);
}

export async function updateCallWaitPromptMember({ guildId, messageId, userId, operation }) {
  if (mongoose.connection.readyState !== 1) throw new Error("MongoDB is unavailable; participant state cannot be updated.");
  const update = operation === "add"
    ? { $addToSet: { "callWaitPrompt.memberIds": userId } }
    : { $pull: { "callWaitPrompt.memberIds": userId } };
  return GuildSettings.findOneAndUpdate(
    { guildId, "callWaitPrompt.messageId": messageId, "callWaitPrompt.targetAt": { $gt: new Date() } },
    update,
    { new: true, lean: true },
  );
}

export async function updateNestedArrayItem({ guildId, path, item, operation, filter = {} }) {
  if (mongoose.connection.readyState !== 1) throw new Error("MongoDB is unavailable; participant state cannot be updated.");
  const operator = operation === "add" ? "$addToSet" : "$pull";
  return GuildSettings.findOneAndUpdate({ guildId, ...filter }, { [operator]: { [path]: item } }, { new: true, lean: true });
}

export async function updateOteboRecruitmentParticipant({ guildId, recruitmentId, messageId, userId, operation, pendingConfirmation }) {
  if (mongoose.connection.readyState !== 1) throw new Error("MongoDB is unavailable; recruitment state cannot be updated.");
  const basePath = `oteboRecruitments.${recruitmentId}`;
  const memberPath = `${basePath}.memberIds`;
  const pendingPath = `${basePath}.pendingConfirmations.${userId}`;
  const filter = {
    guildId,
    [`${basePath}.messageId`]: messageId,
    [`${basePath}.status`]: "active",
    [`${basePath}.targetAt`]: { $gt: new Date() },
  };
  const update = operation === "add"
    ? { $addToSet: { [memberPath]: userId }, ...(pendingConfirmation ? { $set: { [pendingPath]: pendingConfirmation } } : {}) }
    : { $pull: { [memberPath]: userId }, $unset: { [pendingPath]: 1 } };
  return GuildSettings.findOneAndUpdate(filter, update, { new: true, lean: true });
}

export async function replaceNestedObject({ guildId, path, value }) {
  if (mongoose.connection.readyState !== 1) throw new Error("MongoDB is unavailable; nested state cannot be saved.");
  return GuildSettings.findOneAndUpdate(
    { guildId },
    { $set: { [path]: value }, $setOnInsert: { guildId } },
    { upsert: true, new: true, lean: true },
  );
}

export async function unsetNestedObject({ guildId, path }) {
  if (mongoose.connection.readyState !== 1) throw new Error("MongoDB is unavailable; nested state cannot be deleted.");
  return GuildSettings.findOneAndUpdate(
    { guildId },
    { $unset: { [path]: 1 } },
    { new: true, lean: true },
  );
}

export async function deleteOteboRecruitmentIfOnlyMember({ guildId, recruitmentId, messageId, userId }) {
  if (mongoose.connection.readyState !== 1) throw new Error("MongoDB is unavailable; recruitment state cannot be deleted.");
  const basePath = `oteboRecruitments.${recruitmentId}`;
  return GuildSettings.findOneAndUpdate(
    {
      guildId,
      [`${basePath}.messageId`]: messageId,
      [`${basePath}.status`]: "active",
      [`${basePath}.targetAt`]: { $gt: new Date() },
      [`${basePath}.memberIds`]: [userId],
    },
    { $unset: { [basePath]: 1 } },
    { new: true, lean: true },
  );
}

function removeUndefined(value) {
  if (Array.isArray(value)) return value.map((item) => removeUndefined(item));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, removeUndefined(item)]),
  );
}

async function readLegacySettings() {
  if (legacyCache) return legacyCache;
  try {
    legacyCache = JSON.parse(await readFile(settingsPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    legacyCache = {};
  }
  return legacyCache;
}

function getEnvironmentSettings(guildId) {
  if (process.env.DISCORD_GUILD_ID && process.env.DISCORD_GUILD_ID !== guildId) return null;
  const value = (name) => process.env[name];
  const bool = (name) => parseOptionalBoolean(value(name));
  const integer = (name) => parseOptionalInteger(value(name));
  const settings = {
    tempRoleId: value("PB_PARTICIPANT_ROLE_ID") ?? value("PB_TEMP_ROLE_ID"),
    parentChannelId: value("PB_PARENT_CHANNEL_ID"), childCategoryId: value("PB_CHILD_CATEGORY_ID"),
    kokuchiOverviewChannelId: value("PB_KOKUCHI_OVERVIEW_CHANNEL_ID"),
    waitingVcCategoryId: value("PB_WAITING_VC_CATEGORY_ID") ?? value("PB_WAITING_CHANNEL_ID"),
    waitingVcName: value("PB_WAITING_VC_NAME"), bosyuChannelId: value("PB_BOSYU_CHANNEL_ID"),
    bosyuMentionRoleId: value("PB_BOSYU_MENTION_ROLE_ID"), voiceParticipantRoleId: value("PB_VOICE_PARTICIPANT_ROLE_ID"),
    voiceReminderChannelId: value("PB_VOICE_REMINDER_CHANNEL_ID"), voiceTopicChannelId: value("PB_VOICE_TOPIC_CHANNEL_ID"),
    voiceReminderParentChannelId: value("PB_VOICE_REMINDER_PARENT_CHANNEL_ID"), voiceReminderChildCategoryId: value("PB_VOICE_REMINDER_CHILD_CATEGORY_ID"),
    voiceReminderEnabled: bool("PB_VOICE_REMINDER_ENABLED"), wadaiChannelId: value("PB_WADAI_CHANNEL_ID"),
    postSplitWadaiChannelId: value("PB_POST_SPLIT_WADAI_CHANNEL_ID"), splitStartChannelId: value("PB_SPLIT_START_CHANNEL_ID"),
    gatheringVoiceChannelId: value("PB_GATHERING_VOICE_CHANNEL_ID"), splitFeedbackChannelId: value("PB_SPLIT_FEEDBACK_CHANNEL_ID"),
    logChannelId: value("PB_LOG_CHANNEL_ID"), formChannelId: value("PB_FORM_CHANNEL_ID"), formSendChannelId: value("PB_FORM_SEND_CHANNEL_ID"),
    formModeratorRoleId: value("PB_FORM_MODERATOR_ROLE_ID"), finishMessage: value("PB_FINISH_MESSAGE"),
    transferWaitSeconds: integer("PB_TRANSFER_WAIT_SECONDS"), noticeWaitMinutes: integer("PB_NOTICE_WAIT_MINUTES"), roleRemoveWaitMinutes: integer("PB_ROLE_REMOVE_WAIT_MINUTES"),
    callWaitEnabled: bool("PB_CALL_WAIT_ENABLED"), callWaitRoleId: value("PB_CALL_WAIT_ROLE_ID"), callWaitChannelId: value("PB_CALL_WAIT_CHANNEL_ID"),
    callWaitPromptChannelId: value("PB_CALL_WAIT_PROMPT_CHANNEL_ID"), callWaitNoticeChannelId: value("PB_CALL_WAIT_NOTICE_CHANNEL_ID"),
    oteboPreviewChannelId: value("PB_OTEBO_PREVIEW_CHANNEL_ID"), callWaitVoiceCategoryId: value("PB_CALL_WAIT_VOICE_CATEGORY_ID"),
    callWaitMode: value("PB_CALL_WAIT_MODE"), callWaitBosyuNoticeEnabled: bool("PB_CALL_WAIT_BOSYU_NOTICE_ENABLED"),
    oteboQuickConfirmSeconds: integer("PB_OTEBO_QUICK_CONFIRM_SECONDS"), updatedAt: "environment",
  };
  return Object.values(settings).some((item) => item !== undefined && item !== "environment") ? settings : null;
}

function parseOptionalBoolean(value) {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  return undefined;
}

function parseOptionalInteger(value) {
  if (value === undefined) return undefined;
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : undefined;
}
