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
  const environmentSettings = getEnvironmentSettings(guildId);
  let document = await GuildSettings.findOne({ guildId }).lean();
  if (!document) {
    const legacy = (await readLegacySettings())[guildId];
    if (legacy) {
      document = await GuildSettings.findOneAndUpdate(
        { guildId },
        { $setOnInsert: { ...removeUndefined(legacy), guildId } },
        { upsert: true, returnDocument: "after", setDefaultsOnInsert: true, lean: true },
      );
    } else {
      return environmentSettings ? normalizeGuildSettings(environmentSettings) : null;
    }
  }
  const { _id, __v, guildId: ignoredGuildId, createdAt, updatedAt, ...settings } = document;
  // A /kokuchi run persists only its schedule fields. Preserve configured
  // environment defaults after that first MongoDB document is created.
  return mergeGuildSettingsWithEnvironmentDefaults(environmentSettings, {
    ...settings,
    guildId,
    createdAt,
    updatedAt,
  });
}

export function mergeGuildSettingsWithEnvironmentDefaults(
  environmentSettings,
  storedSettings,
) {
  return normalizeGuildSettings({
    ...environmentSettings,
    ...storedSettings,
  });
}

/** Backward-compatible, idempotent read-time normalization. */
export function normalizeGuildSettings(settings = {}) {
  const result = { ...settings };
  result.voiceExitScheduleKeepMessage = result.voiceExitScheduleKeepMessage !== false;
  result.callWaitMode = "button";
  result.callWaitIntervalMinutes = [30, 45, 60].includes(Number(result.callWaitIntervalMinutes))
    ? Number(result.callWaitIntervalMinutes)
    : 30;
  const eventTime = /^([01]\d|2[0-3]):[0-5]\d$/.test(result.kokuchiEventTime ?? "")
    ? result.kokuchiEventTime
    : null;
  if (!eventTime) {
    result.kokuchiEventTime = "21:00";
  }
  if (!result.kokuchiAnnouncementChannelId) {
    result.kokuchiAnnouncementChannelId = result.wadaiChannelId ?? result.splitStartChannelId ?? null;
  }
  const mentionRoles = result.kokuchiMentionRoleIds
    ?? result.kokuchiGatheringReminderRoleIds
    ?? [result.kokuchiMentionRoleId, result.kokuchiGatheringReminderRoleId];
  result.kokuchiMentionRoleIds = [...new Set(
    (Array.isArray(mentionRoles) ? mentionRoles : [mentionRoles])
      .filter((roleId) => typeof roleId === "string" && roleId.length > 0),
  )];
  return result;
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
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true, runValidators: true, lean: true },
  );
  const { _id, __v, guildId: ignoredGuildId, ...settings } = saved;
  return normalizeGuildSettings({ ...settings, guildId });
}

export async function saveGuildSettings(guildId, patch) {
  return patchGuildSettings(guildId, patch);
}

export async function updateCallWaitPromptMember({ guildId, messageId, userId, operation }) {
  if (mongoose.connection.readyState !== 1) throw new Error("MongoDB is unavailable; participant state cannot be updated.");
  const update = operation === "add"
    ? { $addToSet: { "callWaitPrompt.memberIds": userId } }
    : { $pull: { "callWaitPrompt.memberIds": userId } };
  const now = new Date();
  return GuildSettings.findOneAndUpdate(
    {
      guildId,
      "callWaitPrompt.messageId": messageId,
      ...createFutureTargetAtFilter("callWaitPrompt.targetAt", now),
    },
    update,
    { returnDocument: "after", lean: true },
  );
}

export async function transitionCallWaitPrompt({
  guildId,
  messageId,
  fromStates,
  toState,
  patch = {},
}) {
  if (mongoose.connection.readyState !== 1) {
    throw new Error("MongoDB is unavailable; call-wait prompt state cannot be updated.");
  }
  const statePath = "callWaitPrompt.lifecycleState";
  const cleanPatch = removeUndefined(patch);
  const set = {
    [statePath]: toState,
    "callWaitPrompt.lifecycleUpdatedAt": new Date().toISOString(),
  };
  for (const [key, value] of Object.entries(cleanPatch)) {
    set[`callWaitPrompt.${key}`] = value;
  }
  return GuildSettings.findOneAndUpdate(
    {
      guildId,
      "callWaitPrompt.messageId": messageId,
      ...(fromStates?.length ? { [statePath]: { $in: fromStates } } : {}),
    },
    { $set: set },
    { returnDocument: "after", lean: true },
  );
}

export async function claimCallWaitPendingNotice({ guildId }) {
  if (mongoose.connection.readyState !== 1) {
    throw new Error("MongoDB is unavailable; call-wait notice cannot be claimed.");
  }
  return GuildSettings.findOneAndUpdate(
    {
      guildId,
      "callWaitPendingNotice.memberIds.0": { $exists: true },
      $or: [
        { "callWaitPendingNotice.status": "pending" },
        { "callWaitPendingNotice.status": "failed" },
        { "callWaitPendingNotice.status": { $exists: false } },
      ],
    },
    {
      $set: {
        "callWaitPendingNotice.status": "processing",
        "callWaitPendingNotice.lastTriedAt": new Date().toISOString(),
      },
      $inc: { "callWaitPendingNotice.attemptCount": 1 },
    },
    { returnDocument: "after", lean: true },
  );
}

export async function failCallWaitPendingNotice({ guildId, error }) {
  if (mongoose.connection.readyState !== 1) {
    throw new Error("MongoDB is unavailable; call-wait notice failure cannot be saved.");
  }
  return GuildSettings.updateOne(
    { guildId, "callWaitPendingNotice.status": "processing" },
    {
      $set: {
        "callWaitPendingNotice.status": "failed",
        "callWaitPendingNotice.lastError": String(error ?? "unknown error").slice(0, 500),
      },
    },
  );
}

export async function recoverInterruptedCallWaitPendingNotices() {
  if (mongoose.connection.readyState !== 1) {
    throw new Error("MongoDB is unavailable; call-wait notice recovery cannot run.");
  }
  return GuildSettings.updateMany(
    { "callWaitPendingNotice.status": "processing" },
    {
      $set: {
        "callWaitPendingNotice.status": "failed",
        "callWaitPendingNotice.lastError": "Bot restarted while call-wait notice was processing",
      },
    },
  );
}

/**
 * A Discord send may have completed even when the process stopped before its
 * message ID was persisted.  Keep this state terminal to prevent a duplicate
 * kokuchi reminder after restart; an operator can inspect the recorded error.
 */
export async function recoverInterruptedKokuchiGatheringReminders() {
  if (mongoose.connection.readyState !== 1) {
    throw new Error("MongoDB is unavailable; kokuchi reminder recovery cannot run.");
  }
  const now = new Date().toISOString();
  return Promise.all([
    GuildSettings.updateMany(
      { kokuchiPreNoticeState: "processing" },
      {
        $set: {
          kokuchiPreNoticeState: "sent_unconfirmed",
          kokuchiPreNoticeUpdatedAt: now,
          kokuchiPreNoticeLastError: "Bot restarted while the pre-notice send was in progress; automatic retry was disabled to prevent duplicates",
        },
      },
    ),
    GuildSettings.updateMany(
      { gatheringVcUnlockState: "processing" },
      {
        $set: {
          gatheringVcUnlockState: "sent_unconfirmed",
          gatheringVcUnlockUpdatedAt: now,
          gatheringVcUnlockLastError: "Bot restarted while the gathering VC permission update was in progress; automatic retry was disabled to prevent duplicate side effects",
        },
      },
    ),
    GuildSettings.updateMany(
      { kokuchiGatheringReminderState: "sending" },
      {
        $set: {
          kokuchiGatheringReminderState: "unconfirmed",
          kokuchiGatheringReminderUpdatedAt: now,
          kokuchiGatheringReminderLastError: "Bot restarted while the Discord reminder send was in progress; automatic retry was disabled to prevent duplicates",
        },
      },
    ),
  ]);
}

/**
 * A process cannot safely infer whether a role grant completed after it died.
 * Return the prompt to a retryable state instead of leaving it permanently
 * claimed by the old process.
 */
export async function recoverInterruptedCallWaitPrompts() {
  if (mongoose.connection.readyState !== 1) {
    throw new Error("MongoDB is unavailable; call-wait prompt recovery cannot run.");
  }
  return GuildSettings.updateMany(
    {
      "callWaitPrompt.lifecycleState": {
        $in: ["evaluating", "role_granting", "notice_pending", "notice_processing", "closing"],
      },
    },
    {
      $set: {
        "callWaitPrompt.lifecycleState": "failed",
        "callWaitPrompt.lifecycleUpdatedAt": new Date().toISOString(),
        "callWaitPrompt.lastError": "Bot restarted while the call-wait prompt was processing",
      },
    },
  );
}

export async function updateNestedArrayItem({ guildId, path, item, operation, filter = {} }) {
  if (mongoose.connection.readyState !== 1) throw new Error("MongoDB is unavailable; participant state cannot be updated.");
  const operator = operation === "add" ? "$addToSet" : "$pull";
  return GuildSettings.findOneAndUpdate({ guildId, ...filter }, { [operator]: { [path]: item } }, { returnDocument: "after", lean: true });
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
    ...createFutureTargetAtFilter(`${basePath}.targetAt`),
  };
  const update = operation === "add"
    ? { $addToSet: { [memberPath]: userId }, ...(pendingConfirmation ? { $set: { [pendingPath]: pendingConfirmation } } : {}) }
    : { $pull: { [memberPath]: userId }, $unset: { [pendingPath]: 1 } };
  return GuildSettings.findOneAndUpdate(filter, update, { returnDocument: "after", lean: true });
}

export async function transitionOteboRecruitment({
  guildId,
  recruitmentId,
  fromStatuses,
  toStatus,
  patch = {},
}) {
  if (mongoose.connection.readyState !== 1) {
    throw new Error("MongoDB is unavailable; otebo recruitment state cannot be updated.");
  }
  const basePath = `oteboRecruitments.${recruitmentId}`;
  const set = {
    [`${basePath}.status`]: toStatus,
    [`${basePath}.stateUpdatedAt`]: new Date().toISOString(),
  };
  for (const [key, value] of Object.entries(removeUndefined(patch))) {
    set[`${basePath}.${key}`] = value;
  }
  return GuildSettings.findOneAndUpdate(
    {
      guildId,
      [`${basePath}.id`]: recruitmentId,
      ...(fromStatuses?.length ? { [`${basePath}.status`]: { $in: fromStatuses } } : {}),
    },
    { $set: set },
    { returnDocument: "after", lean: true },
  );
}

export async function transitionKokuchiGatheringReminder({
  guildId,
  fromStates,
  toState,
  patch = {},
}) {
  if (mongoose.connection.readyState !== 1) {
    throw new Error("MongoDB is unavailable; kokuchi gathering reminder state cannot be updated.");
  }
  const cleanPatch = removeUndefined(patch);
  return GuildSettings.findOneAndUpdate(
    {
      guildId,
      ...(fromStates?.length
        ? { kokuchiGatheringReminderState: { $in: fromStates } }
        : {}),
    },
    {
      $set: {
        kokuchiGatheringReminderState: toState,
        kokuchiGatheringReminderUpdatedAt: new Date().toISOString(),
        ...cleanPatch,
      },
      ...(toState === "sending" ? { $inc: { kokuchiGatheringReminderAttemptCount: 1 } } : {}),
    },
    { returnDocument: "after", lean: true },
  );
}

const kokuchiTimedActionStateKeys = new Set([
  "kokuchiPreNoticeState",
  "gatheringVcUnlockState",
]);

export async function transitionKokuchiTimedAction({
  guildId,
  stateKey,
  fromStates,
  toState,
  patch = {},
}) {
  if (!kokuchiTimedActionStateKeys.has(stateKey)) {
    throw new Error(`Unsupported kokuchi timed-action state key: ${stateKey}`);
  }
  if (mongoose.connection.readyState !== 1) {
    throw new Error("MongoDB is unavailable; kokuchi timed-action state cannot be updated.");
  }
  const actionName = stateKey.slice(0, -"State".length);
  return GuildSettings.findOneAndUpdate(
    {
      guildId,
      ...(fromStates?.length ? { [stateKey]: { $in: fromStates } } : {}),
    },
    {
      $set: {
        [stateKey]: toState,
        [`${actionName}UpdatedAt`]: new Date().toISOString(),
        ...removeUndefined(patch),
      },
      ...(toState === "processing" ? { $inc: { [`${actionName}AttemptCount`]: 1 } } : {}),
    },
    { returnDocument: "after", lean: true },
  );
}

/** Atomically stops the still-pending timers for exactly one kokuchi event. */
export async function cancelKokuchiTimedActions({ guildId, kokuchiEventId }) {
  if (mongoose.connection.readyState !== 1) throw new Error("MongoDB is unavailable; kokuchi actions cannot be canceled.");
  const before = await GuildSettings.findOneAndUpdate(
    { guildId, kokuchiEventId },
    [
      {
        $set: {
          kokuchiPreNoticeState: {
            $cond: [{ $in: ["$kokuchiPreNoticeState", ["pending", "failed"]] }, "canceled", "$kokuchiPreNoticeState"],
          },
          gatheringVcUnlockState: {
            $cond: [{ $in: ["$gatheringVcUnlockState", ["pending", "failed"]] }, "canceled", "$gatheringVcUnlockState"],
          },
          kokuchiGatheringReminderState: {
            $cond: [{ $in: ["$kokuchiGatheringReminderState", ["pending", "failed"]] }, "canceled", "$kokuchiGatheringReminderState"],
          },
          kokuchiTimedActionsCanceledAt: new Date(),
        },
      },
    ],
    { returnDocument: "before", lean: true },
  );
  if (!before) {
    return {
      canceled: 0,
      alreadyCompleted: 0,
      alreadyCanceled: 0,
      failed: 1,
      errors: ["The current GuildSettings kokuchi event does not match the cancellation target."],
    };
  }

  const states = [
    before.kokuchiPreNoticeState,
    before.gatheringVcUnlockState,
    before.kokuchiGatheringReminderState,
  ];
  return states.reduce((result, state) => {
    if (["pending", "failed"].includes(state)) result.canceled += 1;
    else if (state === "canceled") result.alreadyCanceled += 1;
    else result.alreadyCompleted += 1;
    return result;
  }, { canceled: 0, alreadyCompleted: 0, alreadyCanceled: 0, failed: 0, errors: [] });
}

export async function replaceNestedObject({ guildId, path, value }) {
  if (mongoose.connection.readyState !== 1) throw new Error("MongoDB is unavailable; nested state cannot be saved.");
  return GuildSettings.findOneAndUpdate(
    { guildId },
    { $set: { [path]: value }, $setOnInsert: { guildId } },
    { upsert: true, returnDocument: "after", lean: true },
  );
}

export async function unsetNestedObject({ guildId, path }) {
  if (mongoose.connection.readyState !== 1) throw new Error("MongoDB is unavailable; nested state cannot be deleted.");
  return GuildSettings.findOneAndUpdate(
    { guildId },
    { $unset: { [path]: 1 } },
    { returnDocument: "after", lean: true },
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
      ...createFutureTargetAtFilter(`${basePath}.targetAt`),
      [`${basePath}.memberIds`]: [userId],
    },
    { $unset: { [basePath]: 1 } },
    { returnDocument: "after", lean: true },
  );
}

// Existing settings contain ISO strings, while older deployments may have
// stored BSON Date values. MongoDB range comparisons are type-sensitive, so
// accept either representation until all stored settings are normalized.
function createFutureTargetAtFilter(path, now = new Date()) {
  return {
    $or: [
      { [path]: { $gt: now } },
      { [path]: { $gt: now.toISOString() } },
    ],
  };
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
    splitStartChannelId: value("PB_SPLIT_START_CHANNEL_ID"),
    gatheringVoiceChannelId: value("PB_GATHERING_VOICE_CHANNEL_ID"), splitFeedbackChannelId: value("PB_SPLIT_FEEDBACK_CHANNEL_ID"),
    kokuchiMentionRoleIds: parseOptionalIdList(value("PB_KOKUCHI_MENTION_ROLE_IDS")),
    // Legacy environment name remains a read-only migration source.
    kokuchiGatheringReminderRoleIds: parseOptionalIdList(value("PB_KOKUCHI_GATHERING_REMINDER_ROLE_IDS")),
    logChannelId: value("PB_LOG_CHANNEL_ID"), formChannelId: value("PB_FORM_CHANNEL_ID"), formSendChannelId: value("PB_FORM_SEND_CHANNEL_ID"),
    formModeratorRoleId: value("PB_FORM_MODERATOR_ROLE_ID"), finishMessage: value("PB_FINISH_MESSAGE"),
    transferWaitSeconds: integer("PB_TRANSFER_WAIT_SECONDS"), noticeWaitMinutes: integer("PB_NOTICE_WAIT_MINUTES"), roleRemoveWaitMinutes: integer("PB_ROLE_REMOVE_WAIT_MINUTES"),
    callWaitEnabled: bool("PB_CALL_WAIT_ENABLED"), callWaitRoleId: value("PB_CALL_WAIT_ROLE_ID"), callWaitChannelId: value("PB_CALL_WAIT_CHANNEL_ID"),
    callWaitPromptChannelId: value("PB_CALL_WAIT_PROMPT_CHANNEL_ID"), callWaitNoticeChannelId: value("PB_CALL_WAIT_NOTICE_CHANNEL_ID"),
    oteboPreviewChannelId: value("PB_OTEBO_PREVIEW_CHANNEL_ID"), callWaitVoiceCategoryId: value("PB_CALL_WAIT_VOICE_CATEGORY_ID"),
    callWaitIntervalMinutes: integer("PB_CALL_WAIT_INTERVAL_MINUTES"),
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

function parseOptionalIdList(value) {
  if (value === undefined) return undefined;
  const ids = value.split(",").map((item) => item.trim()).filter(Boolean);
  return ids.length > 0 ? [...new Set(ids)] : undefined;
}
