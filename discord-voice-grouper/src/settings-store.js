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
  const bosyuChannelId = process.env.PB_BOSYU_CHANNEL_ID;
  const bosyuMentionRoleId = process.env.PB_BOSYU_MENTION_ROLE_ID;
  const voiceParticipantRoleId = process.env.PB_VOICE_PARTICIPANT_ROLE_ID;
  const voiceReminderChannelId = process.env.PB_VOICE_REMINDER_CHANNEL_ID;
  const voiceTopicChannelId = process.env.PB_VOICE_TOPIC_CHANNEL_ID;
  const voiceReminderParentChannelId = process.env.PB_VOICE_REMINDER_PARENT_CHANNEL_ID;
  const voiceReminderChildCategoryId = process.env.PB_VOICE_REMINDER_CHILD_CATEGORY_ID;
  const voiceReminderEnabled = parseOptionalBoolean(process.env.PB_VOICE_REMINDER_ENABLED);
  const wadaiChannelId = process.env.PB_WADAI_CHANNEL_ID;
  const postSplitWadaiChannelId = process.env.PB_POST_SPLIT_WADAI_CHANNEL_ID;
  const splitStartChannelId = process.env.PB_SPLIT_START_CHANNEL_ID;
  const gatheringVoiceChannelId = process.env.PB_GATHERING_VOICE_CHANNEL_ID;
  const splitFeedbackChannelId = process.env.PB_SPLIT_FEEDBACK_CHANNEL_ID;
  const logChannelId = process.env.PB_LOG_CHANNEL_ID;
  const formChannelId = process.env.PB_FORM_CHANNEL_ID;
  const formSendChannelId = process.env.PB_FORM_SEND_CHANNEL_ID;
  const formModeratorRoleId = process.env.PB_FORM_MODERATOR_ROLE_ID;
  const finishMessage = process.env.PB_FINISH_MESSAGE;
  const transferWaitSeconds = process.env.PB_TRANSFER_WAIT_SECONDS;
  const noticeWaitMinutes = process.env.PB_NOTICE_WAIT_MINUTES;
  const roleRemoveWaitMinutes = process.env.PB_ROLE_REMOVE_WAIT_MINUTES;
  const callWaitEnabled = parseOptionalBoolean(process.env.PB_CALL_WAIT_ENABLED);
  const callWaitRoleId = process.env.PB_CALL_WAIT_ROLE_ID;
  const callWaitChannelId = process.env.PB_CALL_WAIT_CHANNEL_ID;
  const callWaitPromptChannelId = process.env.PB_CALL_WAIT_PROMPT_CHANNEL_ID;
  const callWaitNoticeChannelId = process.env.PB_CALL_WAIT_NOTICE_CHANNEL_ID;
  const callWaitVoiceCategoryId = process.env.PB_CALL_WAIT_VOICE_CATEGORY_ID;
  const callWaitMode = process.env.PB_CALL_WAIT_MODE;
  const callWaitBosyuNoticeEnabled = parseOptionalBoolean(
    process.env.PB_CALL_WAIT_BOSYU_NOTICE_ENABLED,
  );
  const oteboQuickConfirmSeconds = process.env.PB_OTEBO_QUICK_CONFIRM_SECONDS;

  if (
    !tempRoleId &&
    !parentChannelId &&
    !childCategoryId &&
    !waitingVcCategoryId &&
    !waitingVcName &&
    !bosyuChannelId &&
    !bosyuMentionRoleId &&
    !voiceParticipantRoleId &&
    !voiceReminderChannelId &&
    !voiceTopicChannelId &&
    !voiceReminderParentChannelId &&
    !voiceReminderChildCategoryId &&
    voiceReminderEnabled === undefined &&
    !wadaiChannelId &&
    !postSplitWadaiChannelId &&
    !splitStartChannelId &&
    !gatheringVoiceChannelId &&
    !splitFeedbackChannelId &&
    !logChannelId &&
    !formChannelId &&
    !formSendChannelId &&
    !formModeratorRoleId &&
    !finishMessage &&
    !transferWaitSeconds &&
    !noticeWaitMinutes &&
    !roleRemoveWaitMinutes &&
    callWaitEnabled === undefined &&
    !callWaitRoleId &&
    !callWaitChannelId &&
    !callWaitPromptChannelId &&
    !callWaitNoticeChannelId &&
    !callWaitVoiceCategoryId &&
    !callWaitMode &&
    callWaitBosyuNoticeEnabled === undefined &&
    !oteboQuickConfirmSeconds
  ) {
    return null;
  }

  return {
    tempRoleId,
    parentChannelId,
    childCategoryId,
    waitingVcCategoryId,
    waitingVcName,
    bosyuChannelId,
    bosyuMentionRoleId,
    voiceParticipantRoleId,
    voiceReminderChannelId,
    voiceTopicChannelId,
    voiceReminderParentChannelId,
    voiceReminderChildCategoryId,
    voiceReminderEnabled,
    wadaiChannelId,
    postSplitWadaiChannelId,
    splitStartChannelId,
    gatheringVoiceChannelId,
    splitFeedbackChannelId,
    logChannelId,
    formChannelId,
    formSendChannelId,
    formModeratorRoleId,
    finishMessage,
    transferWaitSeconds: parseOptionalInteger(transferWaitSeconds),
    noticeWaitMinutes: parseOptionalInteger(noticeWaitMinutes),
    roleRemoveWaitMinutes: parseOptionalInteger(roleRemoveWaitMinutes),
    callWaitEnabled,
    callWaitRoleId,
    callWaitChannelId,
    callWaitPromptChannelId,
    callWaitNoticeChannelId,
    callWaitVoiceCategoryId,
    callWaitMode,
    callWaitBosyuNoticeEnabled,
    oteboQuickConfirmSeconds: parseOptionalInteger(oteboQuickConfirmSeconds),
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
