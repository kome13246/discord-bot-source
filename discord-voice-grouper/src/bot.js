import "./load-env.js";
import { createServer } from "node:http";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  ModalBuilder,
  PermissionFlagsBits,
  Routes,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  PermissionsBitField,
  version as discordJsVersion,
} from "discord.js";
import { connectToMongoDB } from "./mongodb.js";
import {
  deleteBumpReminder,
  getBumpReminders,
  saveBumpReminder,
} from "./bump-reminder-store.js";
import {
  buildGroups,
  chooseBestGroupForMember,
  chooseBestMemberSubset,
  chooseGroupsWithHistory,
  countRepeatedPairs,
  createPairKey,
  describeGroups,
  getPairKeysFromGroups,
  shuffle,
} from "./grouping.js";
import { deleteOteboRecruitmentIfOnlyMember, getGuildSettings, replaceNestedObject, saveGuildSettings, updateCallWaitPromptMember, updateOteboRecruitmentParticipant, unsetNestedObject } from "./settings-store.js";
import { claimAction, failAction, finishAction, getPendingActions, recoverInterruptedActions, scheduleAction } from "./scheduled-action-store.js";
import { consumeBosyuCooldown, deleteBosyuEditSession, getActiveBosyuEditSessions, getBosyuEditSession, getExpiredBosyuEditSessions, saveBosyuEditSession } from "./bosyu-state-store.js";
import { SplitProcessSession } from "./models/split-process-session.js";
import {
  addMembersToCurrentGroup,
  getSplitGroupingState,
  startSplitGrouping,
} from "./split-grouping-state-store.js";
import mongoose from "mongoose";
import { UserProfile } from "./models/user-profile.js";
import { VoiceParticipantRoleGrant } from "./models/voice-participant-role-grant.js";
import { normalizeProfileValue, refreshProfileInVoice, handleProfileVoiceState, restoreProfiles, summarizeProfileError } from "./profile-service.js";
import {
  canSendPublicProfile,
  canPublishProfile,
  profilePublishButton,
  publishProfile,
  refreshPublishedProfile,
} from "./profile-publication-service.js";
import { createVoiceChannelControlService } from "./voice-channel-control-service.js";
import {
  countUniqueParticipantIds,
  editEveryoneConnectPermission,
  formatSplitClosingThanks,
  getJstScheduledTime,
  isKokuchiCallWaitPause,
  resolveKokuchiGatheringVoiceChannelId,
} from "./kokuchi-utils.js";

const {
  DISCORD_TOKEN,
  DISBOARD_BOT_ID,
  DISCORD_DEBUG_LOGS,
  KEEP_ALIVE_PORT,
  PORT,
  DISCORD_GUILD_ID,
  PB_LOG_CHANNEL_ID,
} = process.env;

const DISBOARD_DEFAULT_BOT_ID = "302050872383242240";
const BUMP_REMINDER_WAIT_MS = 2 * 60 * 60 * 1000;
const WAITING_ROOM_MONITOR_MS = 10 * 60 * 1000;
const WAITING_ROOM_POLL_MS = 5 * 1000;
const DEFAULT_TRANSFER_WAIT_SECONDS = 30;
const DEFAULT_NOTICE_WAIT_MINUTES = 25;
const DEFAULT_ROLE_REMOVE_WAIT_MINUTES = 3;
const DEFAULT_WAITING_VC_NAME = "途中参加部屋";
const COUNTDOWN_UPDATE_MS = 1000;
const PB_CHILD_WAIT_MS = 20 * 1000;
const DEFAULT_FINISH_MESSAGE =
  "30分が経過しました！各々のちょうどいいタイミングで解散してください";
const MESSAGE_LIMIT = 1900;
const CALL_WAIT_REACTION = "🤚";
const CALL_WAIT_MIN_MEMBERS = 2;
const CALL_WAIT_ROLE_REMOVE_MS = 30 * 60 * 1000;
const CALL_WAIT_FOLLOWUP_CHECK_MS = 30 * 60 * 1000;
const CALL_WAIT_MODE_REACTION = "reaction";
const CALL_WAIT_MODE_BUTTON = "button";
const CALL_WAIT_JOIN_CUSTOM_ID = "call_wait_join";
const CALL_WAIT_CANCEL_CUSTOM_ID = "call_wait_cancel";
const OTEBO_CREATE_CUSTOM_ID = "otebo_create";
const OTEBO_DRAFT_SELECT_CUSTOM_ID = "otebo_draft_select";
const OTEBO_DRAFT_NOTE_CUSTOM_ID = "otebo_draft_note";
const OTEBO_DRAFT_SUBMIT_CUSTOM_ID = "otebo_draft_submit";
const OTEBO_DRAFT_CANCEL_CUSTOM_ID = "otebo_draft_cancel";
const OTEBO_NOTE_MODAL_CUSTOM_ID = "otebo_note_modal";
const OTEBO_JOIN_CUSTOM_ID = "otebo_join";
const OTEBO_MEMBER_CANCEL_CUSTOM_ID = "otebo_member_cancel";
const OTEBO_OWNER_CANCEL_CUSTOM_ID = "otebo_owner_cancel";
const OTEBO_OWNER_CANCEL_CONFIRM_CUSTOM_ID = "otebo_owner_cancel_confirm";
const OTEBO_TYPE_SCHEDULED = "scheduled";
const OTEBO_TYPE_IMMEDIATE = "immediate";
const OTEBO_DURATION_NONE = "none";
const OTEBO_DURATION_30 = "30";
const OTEBO_DURATION_60 = "60";
const OTEBO_DEFAULT_QUICK_CONFIRM_SECONDS = 30;
const OTEBO_ROLE_REMOVE_MS = 20 * 60 * 1000;
const OTEBO_VOICE_STATUS_DEADLINE_MS = 20 * 60 * 1000;
const OTEBO_VOICE_STATUS_EXTRA_MS = 15 * 60 * 1000;
const OTEBO_SCHEDULED_NOTICE_LEAD_MS = 30 * 60 * 1000;
const GATHERING_VC_OPEN_HOUR_JST = 20;
const GATHERING_VC_OPEN_MINUTE_JST = 40;
const KOKUCHI_PRE_NOTICE_HOUR_JST = 20;
const KOKUCHI_PRE_NOTICE_MINUTE_JST = 30;
const KOKUCHI_GATHERING_REMINDER_HOUR_JST = 20;
const KOKUCHI_GATHERING_REMINDER_MINUTE_JST = 55;
const KOKUCHI_GATHERING_REMINDER_ROLE_IDS = [
  "1504093435525861416",
  "1506629235438129323",
];
const KOKUCHI_GATHERING_REMINDER_VOICE_CHANNEL_ID = "1510233872464347347";
const DEFAULT_SPLIT_FEEDBACK_CHANNEL_ID = "1513457664041160765";

const activeSessions = new Map();
const bumpReminderTimers = new Map();
const lastBosyuTimestamps = new Map();
const bosyuEditSessions = new Map();
const voiceMonitorSessions = new Map();
const voiceMonitorPendingFormDeletions = new Map();
const topicFormSessions = new Map();
const autoSplitSuggestionMessages = new Map();
const callWaitRoleRemovalTimers = new Map();
const callWaitFollowupTimers = new Map();
const gatheringVcUnlockTimers = new Map();
const kokuchiPreNoticeTimers = new Map();
const kokuchiGatheringReminderTimers = new Map();
const oteboDrafts = new Map();
const oteboRecruitmentTimers = new Map();
const profilePublicationLocks = new Set();
const splitVoiceGuildLocks = new Set();

const VOICE_MONITOR_MIN_MEMBERS = 2;
const AUTO_SPLIT_THRESHOLD = 6;
const VOICE_MONITOR_STOP_DELAY_MS = 5 * 60 * 1000;
const VOICE_MONITOR_FORM_DELETE_DELAY_MS = 10 * 60 * 1000;
const SUGGESTED_TOPICS = [
  "最近ハマっているゲームや漫画について",
  "最近見た映画やアニメの話",
  "最近の仕事・学業であった面白い出来事",
  "今後やってみたいことや旅行の予定",
  "好きな音楽やおすすめのアーティスト",
  "日常のちょっとした悩みや相談",
  "最近挑戦したことや学んだこと",
  "おすすめのカフェや飲食店について",
  "最近気になっているニュースや話題",
  "趣味や特技の話",
];
const WADAI_CATEGORIES = {
  1: {
    heading: "話題リスト",
    defaults: [
      "最近の趣味",
      "最近やろうと思っていること",
      "休みの日にやりがちなこと",
      "最近あったちょっとよかったこと",
      "最近食べておいしかったもの",
      "買ってよかったもの",
      "今ほしいと思ってるもの",
      "今ハマってるもの",
    ],
  },
};
const FEEDBACK_FORM_TYPES = {
  topic: "話題提供",
  complaint: "相談・苦情",
  suggestion: "提案・要望",
};

let callWaitTimer = null;
let shouldSendMongoSuccessLog = false;

if (!DISCORD_TOKEN) {
  throw new Error("DISCORD_TOKEN is required.");
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildVoiceStates,
  ],
});
const voiceChannelControlService = createVoiceChannelControlService({ getGuildSettings, sendOperationalLog, setVoiceChannelStatus });

let discordReadyWatchdog = null;

const healthPort = Number(PORT ?? KEEP_ALIVE_PORT);

if (Number.isInteger(healthPort) && healthPort > 0) {
  startHealthServer(healthPort);
}

client.once(Events.ClientReady, (readyClient) => {
  if (discordReadyWatchdog) {
    clearTimeout(discordReadyWatchdog);
    discordReadyWatchdog = null;
  }
  console.log(`Logged in as ${readyClient.user.tag}`);
  void restoreBumpReminders().catch((error) => {
    console.error(error);
  });
  void restoreGatheringVcUnlockSchedules().catch((error) => {
    console.error(error);
  });
  void restoreOteboRecruitmentTimers().catch((error) => {
    console.error(error);
  });
  void restoreProfiles(client, { sendOperationalLog, getGuildSettings }).catch((error) => {
    console.error("Profile startup restore failed:", error);
  });
  void restoreScheduledActions().catch((error) => {
    console.error("Scheduled action startup restore failed:", error);
  });
  void restoreBosyuEditSessions().catch((error) => {
    console.error("Bosyu edit session startup restore failed:", error);
  });
  void restoreSplitProcessSessions().catch((error) => {
    console.error("Split process startup restore failed:", error);
  });
  void restoreVoiceMonitorSessions().catch((error) => {
    console.error("Voice monitor startup restore failed:", error);
  });
  void voiceChannelControlService.restore(client).catch((error) => console.error("VC control restore failed:", error));
  if (shouldSendMongoSuccessLog) {
    shouldSendMongoSuccessLog = false;
    void (async () => {
      const sent = await sendMongoStartupEmbed({ success: true });
      if (!sent) {
        console.warn(
          "MongoDB connected successfully, but startup log channel could not be resolved or used.",
        );
      }
    })().catch((error) => {
      console.error("Failed to send MongoDB success log embed:", error);
    });
  }
  scheduleNextCallWaitTick();
});

client.on(Events.Error, (error) => {
  console.error("Discord client error:", error);
});

client.on(Events.Warn, (message) => {
  console.warn(`Discord client warning: ${message}`);
});

client.on(Events.ShardError, (error, shardId) => {
  console.error(`Discord shard ${shardId} error:`, error);
});

client.on(Events.ShardDisconnect, (event, shardId) => {
  console.error(`Discord shard ${shardId} disconnected: code=${event.code} reason=${event.reason ?? ""}`);
});

client.on(Events.ShardReady, (shardId) => {
  console.log(`Discord shard ${shardId} ready.`);
});

client.on(Events.ShardReconnecting, (shardId) => {
  console.warn(`Discord shard ${shardId} reconnecting...`);
});

if (DISCORD_DEBUG_LOGS === "true") {
  client.on(Events.Debug, (message) => {
    console.debug(`Discord debug: ${message}`);
  });
}

client.on(Events.MessageCreate, async (message) => {
  try {
    await handleDisboardBumpMessage(message);
    await handleTopicRequestMessage(message);
  } catch (error) {
    console.error("Interaction processing failed", {
      processName: interaction.commandName ?? interaction.customId ?? interaction.type,
      guildId: interaction.guildId ?? null,
      channelId: interaction.channelId ?? null,
      userId: interaction.user?.id ?? null,
      customId: interaction.customId ?? null,
      error: error?.stack ?? error,
    });
  }
});

client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  try {
    await handleProfileVoiceState(oldState, newState, { client, sendOperationalLog, getGuildSettings });
    await handleVoiceStateUpdate(oldState, newState);
  } catch (error) {
    console.error(error);
  }
});

client.on(Events.ChannelCreate, async (channel) => {
  if (channel.type === ChannelType.GuildVoice) await voiceChannelControlService.ensurePanel(channel).catch((error) => console.error("VC control panel create failed:", error));
});
client.on(Events.ChannelDelete, async (channel) => {
  if (channel.type === ChannelType.GuildVoice) await voiceChannelControlService.cleanup(channel).catch(() => {});
});
client.on(Events.ChannelUpdate, async (oldChannel, newChannel) => {
  if (newChannel.type !== ChannelType.GuildVoice) return;
  const settings = await getGuildSettings(newChannel.guild.id).catch(() => null);
  const wasTarget = oldChannel.parentId === settings?.vcControlCategoryId;
  const isTarget = newChannel.parentId === settings?.vcControlCategoryId;
  if (isTarget && !wasTarget) await voiceChannelControlService.ensurePanel(newChannel).catch(() => {});
  if (!isTarget && wasTarget) await voiceChannelControlService.cleanup(newChannel).catch(() => {});
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isButton()) {
      if (interaction.customId.startsWith("vc_control:")) { await voiceChannelControlService.handle(interaction); return; }
      if (interaction.customId === "bosyu_edit") {
        await handleBosyuButton(interaction);
        return;
      }

      if (interaction.customId === "profile_open") {
        await handleProfileOpen(interaction);
        return;
      }

      if (interaction.customId.startsWith("profile_publish:")) {
        await handleProfilePublishButton(interaction);
        return;
      }

      if (interaction.customId.startsWith("session_cancel:")) {
        await handleSessionButton(interaction);
        return;
      }

      if (interaction.customId.startsWith("auto_split:")) {
        await handleAutoSplitButton(interaction);
        return;
      }

      if (interaction.customId.startsWith("suggest_topic:")) {
        await handleSuggestTopicButton(interaction);
        return;
      }

      if (interaction.customId.startsWith("feedback_form_button:")) {
        await handleFeedbackFormButton(interaction);
        return;
      }

      if (
        interaction.customId === CALL_WAIT_JOIN_CUSTOM_ID ||
        interaction.customId === CALL_WAIT_CANCEL_CUSTOM_ID ||
        interaction.customId.startsWith(`${CALL_WAIT_CANCEL_CUSTOM_ID}:`)
      ) {
        await handleCallWaitButton(interaction);
        return;
      }

      if (
        interaction.customId === OTEBO_CREATE_CUSTOM_ID ||
        interaction.customId === OTEBO_DRAFT_NOTE_CUSTOM_ID ||
        interaction.customId === OTEBO_DRAFT_SUBMIT_CUSTOM_ID ||
        interaction.customId === OTEBO_DRAFT_CANCEL_CUSTOM_ID ||
        interaction.customId.startsWith(`${OTEBO_JOIN_CUSTOM_ID}:`) ||
        interaction.customId.startsWith(`${OTEBO_MEMBER_CANCEL_CUSTOM_ID}:`) ||
        interaction.customId.startsWith(`${OTEBO_OWNER_CANCEL_CUSTOM_ID}:`) ||
        interaction.customId.startsWith(`${OTEBO_OWNER_CANCEL_CONFIRM_CUSTOM_ID}:`)
      ) {
        await handleOteboButton(interaction);
        return;
      }
    }

    if (interaction.isStringSelectMenu()) {
      if (interaction.customId.startsWith("vc_control:")) { await voiceChannelControlService.handle(interaction); return; }
      if (interaction.customId.startsWith(`${OTEBO_DRAFT_SELECT_CUSTOM_ID}:`)) {
        await handleOteboDraftSelect(interaction);
        return;
      }

      return;
    }

    if (interaction.isModalSubmit()) {
      if (interaction.customId.startsWith("vc_control:")) { await voiceChannelControlService.handle(interaction); return; }
      if (interaction.customId === "profile_modal") {
        await handleProfileModal(interaction);
        return;
      }
      if (interaction.customId.startsWith("bosyu_edit_modal:")) {
        await handleBosyuEditModal(interaction);
        return;
      }

      if (interaction.customId.startsWith("feedback_form_modal:")) {
        await handleFeedbackFormModal(interaction);
        return;
      }

      if (interaction.customId === OTEBO_NOTE_MODAL_CUSTOM_ID) {
        await handleOteboNoteModal(interaction);
        return;
      }

      return;
    }

    if (!interaction.isChatInputCommand()) {
      return;
    }

    if (interaction.commandName === "splitvc") {
      await handleSplitVoice(interaction);
      return;
    }

    if (interaction.commandName === "setup-profile") {
      await handleSetupProfile(interaction);
      return;
    }

    if (interaction.commandName === "b") {
      await handleBosyu(interaction);
      return;
    }

    if (interaction.commandName === "addwadai") {
      await handleAddWadai(interaction);
      return;
    }

    if (interaction.commandName === "showwadai") {
      await handleShowWadai(interaction);
      return;
    }

    if (interaction.commandName === "delwadai") {
      await handleDelWadai(interaction);
      return;
    }

    if (interaction.commandName === "kokuchi") {
      await handleKokuchi(interaction);
      return;
    }

    if (interaction.commandName === "sendcallwait") {
      await handleSendCallWait(interaction);
      return;
    }

    if (interaction.commandName === "sendotebo") {
      await handleSendOtebo(interaction);
      return;
    }

    if (interaction.commandName === "setupforms") {
      await handleSetupForms(interaction);
      return;
    }

    if (interaction.commandName === "setting") {
      await handleSetting(interaction);
    }
  } catch (error) {
    if (interaction.commandName === "splitvc") {
      splitVoiceGuildLocks.delete(interaction.guildId);
    }
    console.error(error);
    await replySafely(interaction, "処理中にエラーが発生しました。Renderのログを確認してください。");
  }
});

async function handleSetupProfile(interaction) {
  if (!interaction.inGuild() || !interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator)) {
    await replyOrFollowUp(interaction, { content: "管理者のみ実行できます。", flags: MessageFlags.Ephemeral }); return;
  }
  const embed = { title: "プロフィール登録・編集", description: "下のボタンからプロフィールを登録・編集できます。", color: 0x5865f2 };
  const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("profile_open").setLabel("プロフィールを登録・編集").setStyle(ButtonStyle.Primary));
  await interaction.reply({ embeds: [embed], components: [row] });
}

async function handleProfileOpen(interaction) {
  if (!interaction.inGuild()) return interaction.reply({ content: "サーバー内で使用してください。", flags: MessageFlags.Ephemeral });
  let profile;
  try {
    profile = await UserProfile.findOne({ guildId: interaction.guildId, userId: interaction.user.id });
  } catch (error) {
    await logProfileFailure(interaction, "profile modal fetch failed", error);
    await interaction.reply({ content: "プロフィールの取得に失敗しました。", flags: MessageFlags.Ephemeral });
    return;
  }
  const input = (id, label, style, max, value, required) => new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setMaxLength(max).setRequired(required).setValue(value ?? ""));
  const modal = new ModalBuilder().setCustomId("profile_modal").setTitle("プロフィール登録・編集").addComponents(
    input("profile_nickname", "呼び名", TextInputStyle.Short, 20, profile?.nickname, true),
    input("profile_status", "現状", TextInputStyle.Short, 30, profile?.status, false),
    input("profile_hobby", "趣味", TextInputStyle.Paragraph, 80, profile?.hobby, false),
    input("profile_comment", "ひとこと", TextInputStyle.Paragraph, 150, profile?.comment, false),
  );
  await interaction.showModal(modal);
}

async function handleProfileModal(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const values = {
    nickname: normalizeProfileValue(interaction.fields.getTextInputValue("profile_nickname"), 20),
    status: normalizeProfileValue(interaction.fields.getTextInputValue("profile_status"), 30),
    hobby: normalizeProfileValue(interaction.fields.getTextInputValue("profile_hobby"), 80),
    comment: normalizeProfileValue(interaction.fields.getTextInputValue("profile_comment"), 150),
  };
  if (!values.nickname) {
    await interaction.editReply({ content: "呼び名は必須です。" });
    return;
  }

  let existing;
  try {
    existing = await UserProfile.findOne({ guildId: interaction.guildId, userId: interaction.user.id });
    await UserProfile.findOneAndUpdate(
      { guildId: interaction.guildId, userId: interaction.user.id },
      values,
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
  } catch (error) {
    await interaction.editReply({ content: "プロフィールの保存に失敗しました。" }).catch(() => {});
    await logProfileFailure(interaction, "profile save failed", error);
    return;
  }

  const settings = await getGuildSettings(interaction.guildId).catch(async (error) => {
    await logProfileFailure(interaction, "profile settings fetch failed", error, existing);
    return null;
  });
  const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
  if (member?.voice?.channel && settings) {
    await refreshProfileInVoice(member, { guild: interaction.guild, settings, sendOperationalLog }).catch((error) => {
      void logProfileFailure(interaction, "profile VC refresh failed", error, existing);
    });
  }

  const latestProfile = await UserProfile.findOne({ guildId: interaction.guildId, userId: interaction.user.id }).catch(async (error) => {
    await logProfileFailure(interaction, "profile latest fetch failed", error, existing);
    return null;
  });
  if (!latestProfile) {
    await interaction.editReply({ content: "プロフィールの保存後確認に失敗しました。" });
    return;
  }
  let publication = { status: "unpublished" };
  if (latestProfile && settings) {
    try {
      publication = await refreshPublishedProfile({
        guild: interaction.guild,
        member: member ?? { displayName: interaction.user.username, user: interaction.user },
        profile: latestProfile,
        settings,
      });
    } catch (error) {
      await logProfileFailure(interaction, "profile public update failed", error, latestProfile);
      publication = { status: "update-failed" };
    }
  }

  const baseMessage = existing ? "プロフィールを更新しました。" : "プロフィールを登録しました。";
  if (publication.status === "updated") {
    await interaction.editReply({ content: `${baseMessage}\n自己紹介チャンネルのメッセージも更新しました。` });
    return;
  }
  if (publication.status === "update-failed") {
    await interaction.editReply({ content: `${baseMessage}\nプロフィールは更新しましたが、自己紹介チャンネルのメッセージ更新に失敗しました。` });
    return;
  }

  const availability = settings
    ? await canPublishProfile({ guild: interaction.guild, settings }).catch(async (error) => {
      await logProfileFailure(interaction, "profile public channel check failed", error, latestProfile);
      return { ok: false, reason: "channel-unavailable" };
    })
    : { ok: false, reason: "channel-unavailable" };
  const content = publication.status === "missing"
    ? `${baseMessage}\n以前送信した自己紹介メッセージが見つかりませんでした。もう一度自己紹介チャンネルに送信しますか？`
    : availability.ok
      ? `${baseMessage}\n自己紹介チャンネルに送信しますか？`
      : availability.reason === "not-configured"
        ? `${baseMessage}\n自己紹介チャンネルが設定されていないため、現在は公開できません。管理者が /setting profile で設定してください。`
        : `${baseMessage}\n自己紹介チャンネルを利用できないため、現在は公開できません。`;
  const button = profilePublishButton(interaction.user.id);
  const components = availability.ok
    ? [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(button.customId).setLabel(button.label).setStyle(ButtonStyle.Primary))]
    : [];
  await interaction.editReply({ content, components });
}

async function logProfileFailure(interaction, processName, error, profile = null) {
  const settings = await getGuildSettings(interaction.guildId).catch(() => null);
  const message = `[${processName}] guild=${interaction.guild?.name ?? "?"}(${interaction.guildId ?? "?"}) user=${interaction.user.username}(${interaction.user.id}) publishedChannelId=${profile?.publishedChannelId ?? "?"} publishedMessageId=${profile?.publishedMessageId ?? "?"} error=${summarizeProfileError(error)} time=${new Date().toISOString()}`;
  console.error(message);
  await sendOperationalLog({ guild: interaction.guild, settings, fallbackChannel: interaction.channel, content: message });
}

async function handleProfilePublishButton(interaction) {
  if (!interaction.inGuild()) {
    await interaction.reply({ content: "サーバー内で使用してください。", flags: MessageFlags.Ephemeral });
    return;
  }
  const [, targetUserId] = interaction.customId.split(":");
  if (targetUserId !== interaction.user.id) {
    await interaction.reply({ content: "このボタンはプロフィールを登録した本人だけが使用できます。", flags: MessageFlags.Ephemeral });
    return;
  }

  const lockKey = `${interaction.guildId}:${targetUserId}`;
  if (profilePublicationLocks.has(lockKey)) {
    await interaction.reply({ content: "自己紹介の送信処理を実行中です。", flags: MessageFlags.Ephemeral });
    return;
  }
  profilePublicationLocks.add(lockKey);
  let profile = null;
  try {
    await interaction.update({ content: "自己紹介を送信しています…", components: [] });
    profile = await UserProfile.findOne({ guildId: interaction.guildId, userId: targetUserId });
    if (!profile) {
      await interaction.editReply({ content: "プロフィールが見つかりません。先にプロフィールを保存してください。" });
      return;
    }
    const member = await interaction.guild.members.fetch(targetUserId).catch(() => null);
    if (interaction.user.bot || member?.user.bot) {
      await interaction.editReply({ content: "Botのプロフィールは公開できません。" });
      return;
    }
    const settings = await getGuildSettings(interaction.guildId);
    const publicMember = member ?? { displayName: interaction.user.username, user: interaction.user };
    const result = await publishProfile({ guild: interaction.guild, member: publicMember, profile, settings });
    if (result.status === "published" || result.status === "updated") {
      await interaction.editReply({ content: "自己紹介チャンネルにプロフィールを送信しました。" });
      return;
    }
    if (result.status === "missing") {
      const button = profilePublishButton(targetUserId);
      await interaction.editReply({
        content: "以前送信した自己紹介メッセージが見つかりませんでした。もう一度送信してください。",
        components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(button.customId).setLabel(button.label).setStyle(ButtonStyle.Primary))],
      });
      return;
    }
    const reason = result.status === "not-configured"
      ? "自己紹介チャンネルが設定されていません。管理者が /setting profile で設定してください。"
      : result.status === "permission-denied"
        ? "Botに自己紹介チャンネルの閲覧・送信・Embed権限がありません。"
        : "自己紹介チャンネルを利用できません。設定とBotの権限を確認してください。";
    await interaction.editReply({ content: reason });
  } catch (error) {
    await logProfileFailure(interaction, "profile publish failed", error, profile);
    const content = error?.code === "PUBLIC_PROFILE_STATE_SAVE_FAILED"
      ? "自己紹介の送信状態を保存できなかったため、投稿を取り消しました。時間をおいてもう一度お試しください。"
      : "自己紹介の送信に失敗しました。時間をおいてもう一度お試しください。";
    await interaction.editReply({ content }).catch(() => {});
  } finally {
    profilePublicationLocks.delete(lockKey);
  }
}

async function handleProfileIntroductionSetting(interaction) {
  const channel = interaction.options.getChannel("introduction_channel", true);
  if (![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type) || !canSendPublicProfile(channel, interaction.guild)) {
    await replyOrFollowUp(interaction, { content: "Botが閲覧・メッセージ送信・Embed送信できるテキストチャンネルを指定してください。", flags: MessageFlags.Ephemeral });
    return;
  }
  const settings = await saveGuildSettingsWithCurrent(interaction.guildId, await getGuildSettings(interaction.guildId), { profileIntroductionChannelId: channel.id });
  await replyOrFollowUp(interaction, { content: `自己紹介チャンネルを <#${channel.id}> に設定しました。\n\n${formatSettings(settings)}`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
}

async function handleSetting(interaction) {
  if (!interaction.inGuild()) {
    await replyOrFollowUp(interaction, {
      content: "このコマンドはサーバー内で使ってください。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild)) {
    await replyOrFollowUp(interaction, {
      content: "この設定を変更するには、サーバー管理権限が必要です。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const subcommand = interaction.options.getSubcommand();

  if (subcommand === "show") {
    const settings = await getGuildSettings(interaction.guildId);
    await replyOrFollowUp(interaction, {
      content: formatSettings(settings),
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
    return;
  }

  if (subcommand === "vc_control") {
    const category = interaction.options.getChannel("category", false);
    const notifyRole = interaction.options.getRole("notify_role", false);
    if (!category && !notifyRole) {
      await replyOrFollowUp(interaction, { content: "category または notify_role を指定してください。", flags: MessageFlags.Ephemeral });
      return;
    }
    const settings = await saveGuildSettingsWithCurrent(interaction.guildId, await getGuildSettings(interaction.guildId), {
      ...(category ? { vcControlCategoryId: category.id } : {}),
      ...(notifyRole ? { vcControlNotifyRoleId: notifyRole.id } : {}),
    });
    await replyOrFollowUp(interaction, { content: `VCコントロール設定を保存しました。\n対象カテゴリ: ${settings.vcControlCategoryId ? `<#${settings.vcControlCategoryId}>` : "未設定"}\n通知ロール: ${settings.vcControlNotifyRoleId ? `<@&${settings.vcControlNotifyRoleId}>` : "未設定"}`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    if (category) {
      for (const channel of interaction.guild.channels.cache.values()) if (channel.type === ChannelType.GuildVoice && channel.parentId === category.id) await voiceChannelControlService.ensurePanel(channel).catch(() => {});
    }
    return;
  }

  if (subcommand === "profile") {
    await handleProfileIntroductionSetting(interaction);
    return;
  }

  if (subcommand === "callwait") {
    await handleCallWaitSetting(interaction);
    return;
  }

  if (subcommand === "shugo") {
    await handleShugoSetting(interaction);
    return;
  }

  const tempRole = interaction.options.getRole("participant_role", false);
  const parentChannel = interaction.options.getChannel("parent_channel", false);
  const childCategory = interaction.options.getChannel("child_category", false);
  const kokuchiOverviewChannel = interaction.options.getChannel("kokuchi_overview_channel", false);
  const waitingVcCategory = interaction.options.getChannel("waiting_vc_category", false,);
  const waitingVcName = interaction.options.getString("waiting_vc_name", false);
  const bosyuChannel = interaction.options.getChannel("bosyu_channel", false);
  const bosyuMentionRole = interaction.options.getRole("bosyu_mention_role", false);
  const wadaiChannel = interaction.options.getChannel("wadaich", false);
  const postSplitWadaiChannel = interaction.options.getChannel("post_split_wadai_channel", false);
  const splitStartChannel = interaction.options.getChannel("split_start_channel", false);
  const gatheringVoiceChannel = interaction.options.getChannel("gathering_voice_channel", false);
  const splitFeedbackChannel = interaction.options.getChannel("split_feedback_channel", false);
  const logChannel = interaction.options.getChannel("log_channel", false);
  const formChannel = interaction.options.getChannel("form_channel", false);
  const formSendChannel = interaction.options.getChannel("form_send_channel", false);
  const formModeratorRole = interaction.options.getRole("moderator_role", false);
  const finishMessage = interaction.options.getString("finish_message", false);
  const transferWaitSeconds = interaction.options.getInteger(
    "transfer_wait_seconds",
    false,
  );
  const noticeWaitMinutes = interaction.options.getInteger(
    "notice_wait_minutes",
    false,
  );
  const roleRemoveWaitMinutes = interaction.options.getInteger(
    "role_remove_wait_minutes",
    false,
  );
  const patch = {};

  if (tempRole) {
    patch.tempRoleId = tempRole.id;
  }

  if (parentChannel) {
    patch.parentChannelId = parentChannel.id;
  }

  if (childCategory) {
    patch.childCategoryId = childCategory.id;
  }

  if (kokuchiOverviewChannel) {
    patch.kokuchiOverviewChannelId = kokuchiOverviewChannel.id;
  }

  if (waitingVcCategory) {
    patch.waitingVcCategoryId = waitingVcCategory.id;
  }

  if (waitingVcName?.trim()) {
    patch.waitingVcName = waitingVcName.trim();
  }

  if (bosyuChannel) {
    patch.bosyuChannelId = bosyuChannel.id;
  }

  if (bosyuMentionRole) {
    patch.bosyuMentionRoleId = bosyuMentionRole.id;
  }

  if (wadaiChannel) {
    patch.wadaiChannelId = wadaiChannel.id;
    patch.splitStartChannelId = wadaiChannel.id;
  }

  if (postSplitWadaiChannel) {
    patch.postSplitWadaiChannelId = postSplitWadaiChannel.id;
  }

  if (splitStartChannel) {
    patch.wadaiChannelId = splitStartChannel.id;
    patch.splitStartChannelId = splitStartChannel.id;
  }

  if (gatheringVoiceChannel) {
    patch.gatheringVoiceChannelId = gatheringVoiceChannel.id;
  }

  if (splitFeedbackChannel) {
    patch.splitFeedbackChannelId = splitFeedbackChannel.id;
  }

  if (logChannel) {
    patch.logChannelId = logChannel.id;
  }

  if (formChannel) {
    patch.formChannelId = formChannel.id;
  }

  if (formSendChannel) {
    patch.formSendChannelId = formSendChannel.id;
  }

  if (formModeratorRole) {
    patch.formModeratorRoleId = formModeratorRole.id;
  }

  if (finishMessage?.trim()) {
    patch.finishMessage = finishMessage.trim();
  }

  if (transferWaitSeconds !== null) {
    patch.transferWaitSeconds = transferWaitSeconds;
  }

  if (noticeWaitMinutes !== null) {
    patch.noticeWaitMinutes = noticeWaitMinutes;
  }

  if (roleRemoveWaitMinutes !== null) {
    patch.roleRemoveWaitMinutes = roleRemoveWaitMinutes;
  }

  if (Object.keys(patch).length === 0) {
    await interaction.reply({
      content: "変更する項目を1つ以上指定してください。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const currentSettings = await getGuildSettings(interaction.guildId);
  const settings = await saveGuildSettingsWithCurrent(
    interaction.guildId,
    currentSettings,
    patch,
  );

  if (gatheringVoiceChannel) {
    await scheduleGatheringVcUnlock(interaction.guild, settings);
  }
  await replyOrFollowUp(interaction, {
    content: `設定を保存しました。\n\n${formatSettings(settings)}`,
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
}

async function handleCallWaitSetting(interaction) {
  const callWaitEnabled = interaction.options.getBoolean("call_wait_enabled", false);
  const callWaitRole = interaction.options.getRole("call_wait_role", false);
  const callWaitPromptChannel = interaction.options.getChannel(
    "call_wait_prompt_channel",
    false,
  );
  const callWaitNoticeChannel = interaction.options.getChannel(
    "call_wait_notice_channel",
    false,
  );
  const oteboPreviewChannel = interaction.options.getChannel(
    "otebo_preview_channel",
    false,
  );
  const callWaitVoiceCategory = interaction.options.getChannel(
    "call_wait_voice_category",
    false,
  );
  const callWaitMode = interaction.options.getString("call_wait_mode", false);
  const callWaitBosyuNoticeEnabled = interaction.options.getBoolean(
    "call_wait_bosyu_notice_enabled",
    false,
  );
  const oteboQuickConfirmSeconds = interaction.options.getInteger(
    "otebo_quick_confirm_seconds",
    false,
  );
  const patch = {};

  if (callWaitEnabled !== null) {
    patch.callWaitEnabled = callWaitEnabled;
  }

  if (callWaitRole) {
    patch.callWaitRoleId = callWaitRole.id;
  }

  if (callWaitPromptChannel) {
    patch.callWaitPromptChannelId = callWaitPromptChannel.id;
  }

  if (callWaitNoticeChannel) {
    patch.callWaitNoticeChannelId = callWaitNoticeChannel.id;
  }

  if (oteboPreviewChannel) {
    patch.oteboPreviewChannelId = oteboPreviewChannel.id;
  }

  if (callWaitVoiceCategory) {
    patch.callWaitVoiceCategoryId = callWaitVoiceCategory.id;
  }

  if (callWaitMode !== null) {
    patch.callWaitMode = normalizeCallWaitMode(callWaitMode);
  }

  if (callWaitBosyuNoticeEnabled !== null) {
    patch.callWaitBosyuNoticeEnabled = callWaitBosyuNoticeEnabled;
  }

  if (oteboQuickConfirmSeconds !== null) {
    patch.oteboQuickConfirmSeconds = oteboQuickConfirmSeconds;
  }

  if (Object.keys(patch).length === 0) {
    await replyOrFollowUp(interaction, {
      content: "変更する通話待機システム設定を1つ以上指定してください。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const currentSettings = await getGuildSettings(interaction.guildId);
  let settings = await saveGuildSettingsWithCurrent(
    interaction.guildId,
    currentSettings,
    patch,
  );

  if (
    currentSettings?.callWaitPrompt &&
    (callWaitEnabled === false ||
      callWaitPromptChannel ||
      callWaitMode)
  ) {
    await deleteCallWaitPrompt(interaction.guild, currentSettings.callWaitPrompt);
    settings = await saveGuildSettingsWithCurrent(interaction.guildId, settings, {
      callWaitPrompt: null,
    });
  }

  if (
    currentSettings?.callWaitSkippedNotice &&
    (callWaitEnabled === false || callWaitPromptChannel)
  ) {
    await deleteCallWaitMessage(interaction.guild, currentSettings.callWaitSkippedNotice);
    settings = await saveGuildSettingsWithCurrent(interaction.guildId, settings, {
      callWaitSkippedNotice: null,
    });
  }

  if (callWaitEnabled === false) {
    const actionPrefix = `callwait-followup:${interaction.guildId}:`;
    for (const [actionKey, followupTimer] of callWaitFollowupTimers.entries()) {
      if (actionKey.startsWith(actionPrefix)) {
        clearTimeout(followupTimer);
        callWaitFollowupTimers.delete(actionKey);
      }
    }

    settings = await saveGuildSettingsWithCurrent(interaction.guildId, settings, {
      callWaitPendingNotice: null,
    });
  }

  await replyOrFollowUp(interaction, {
    content: `通話待機システム設定を保存しました。\n\n${formatSettings(settings)}`,
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
}

async function handleShugoSetting(interaction) {
  const voiceParticipantRole = interaction.options.getRole("voice_participant_role", false);
  const voiceReminderEnabled = interaction.options.getBoolean("voice_reminder_enabled", false);
  const voiceReminderParentChannel = interaction.options.getChannel(
    "voice_reminder_parent_channel",
    false,
  );
  const voiceReminderChildCategory = interaction.options.getChannel(
    "voice_reminder_child_category",
    false,
  );
  const patch = {};

  if (voiceParticipantRole) {
    patch.voiceParticipantRoleId = voiceParticipantRole.id;
  }

  if (voiceReminderEnabled !== null) {
    patch.voiceReminderEnabled = voiceReminderEnabled;
  }

  if (voiceReminderParentChannel) {
    patch.voiceReminderParentChannelId = voiceReminderParentChannel.id;
  }

  if (voiceReminderChildCategory) {
    patch.voiceReminderChildCategoryId = voiceReminderChildCategory.id;
  }

  if (Object.keys(patch).length === 0) {
    await replyOrFollowUp(interaction, {
      content: "変更するVC集合フォーム設定を1つ以上指定してください。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const currentSettings = await getGuildSettings(interaction.guildId);
  const settings = await saveGuildSettingsWithCurrent(
    interaction.guildId,
    currentSettings,
    patch,
  );

  await replyOrFollowUp(interaction, {
    content: `VC集合フォーム設定を保存しました。\n\n${formatSettings(settings)}`,
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
}

async function handleAddWadai(interaction) {
  if (!interaction.inGuild()) {
    await replyOrFollowUp(interaction, {
      content: "このコマンドはサーバー内で使ってください。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild)) {
    await replyOrFollowUp(interaction, {
      content: "話題を追加するには、サーバー管理権限が必要です。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const category = "1";
  const content = interaction.options.getString("content", true).trim();

  if (!content) {
    await replyOrFollowUp(interaction, {
      content: "追加する話題の内容を入力してください。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const settings = await getGuildSettings(interaction.guildId);
  const topics = getWadaiTopics(settings);
  const nextTopic = {
    id: createWadaiTopicId(category),
    text: content,
  };

  topics[category].push(nextTopic);
  await saveGuildSettingsWithCurrent(interaction.guildId, settings, {
    wadaiTopics: topics,
    wadaiTopicsVersion: 2,
    wadaiDaily: null,
  });

  await replyOrFollowUp(interaction, {
    content: `話題を追加しました。\n${topics[category].length}. ${content}`,
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
}

async function handleShowWadai(interaction) {
  if (!interaction.inGuild()) {
    await replyOrFollowUp(interaction, {
      content: "このコマンドはサーバー内で使ってください。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const settings = await getGuildSettings(interaction.guildId);
  await replyInChunks(interaction, formatWadaiList(getWadaiTopics(settings)), {
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
}

async function handleDelWadai(interaction) {
  if (!interaction.inGuild()) {
    await replyOrFollowUp(interaction, {
      content: "このコマンドはサーバー内で使ってください。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild)) {
    await replyOrFollowUp(interaction, {
      content: "話題を削除するには、サーバー管理権限が必要です。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const target = interaction.options.getString("target", true).trim();
  const parsed = parseWadaiTarget(target);

  if (!parsed) {
    await replyOrFollowUp(interaction, {
      content: "削除対象は `/showwadai` の番号で指定してください。例: `2`",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const settings = await getGuildSettings(interaction.guildId);
  const topics = getWadaiTopics(settings);
  const categoryTopics = topics[parsed.category];
  const deleteIndex = parsed.index - 1;

  if (!categoryTopics[deleteIndex]) {
    await replyOrFollowUp(interaction, {
      content: `${parsed.index} 番目の話題はありません。`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const [deleted] = categoryTopics.splice(deleteIndex, 1);
  const recentHistory = getWadaiRecentHistory(settings);
  recentHistory[parsed.category] = recentHistory[parsed.category].filter(
    (topicId) => topicId !== deleted.id,
  );

  await saveGuildSettingsWithCurrent(interaction.guildId, settings, {
    wadaiTopics: topics,
    wadaiTopicsVersion: 2,
    wadaiCurrentTopic:
      settings?.wadaiCurrentTopic?.id === deleted.id ? null : settings?.wadaiCurrentTopic,
    wadaiDaily: null,
    wadaiRecentHistory: recentHistory,
  });

  await replyOrFollowUp(interaction, {
    content: `話題を削除しました。\n${deleted.text}`,
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
}

async function sendPostSplitWadaiTopic({
  fallbackChannel,
  groupSummaries,
  guild,
  participantRoleId,
  settings,
}) {
  const currentSettings = (await getGuildSettings(guild.id)) ?? settings;

  if (currentSettings?.kokuchiTopicEnabled === false) {
    return;
  }

  const { settings: nextSettings, topic } = await getOrChooseCurrentWadaiTopic(
    guild.id,
    currentSettings,
  );

  const configuredChannel = nextSettings?.postSplitWadaiChannelId
    ? await resolveConfiguredTextChannel(guild, nextSettings.postSplitWadaiChannelId)
    : null;
  const sendChannel =
    configuredChannel ??
    (fallbackChannel && typeof fallbackChannel.send === "function"
      ? fallbackChannel
      : null);

  if (!sendChannel) {
    return;
  }

  await sendChannel.send({
    content: formatPostSplitWadaiMessage(participantRoleId, topic, groupSummaries),
    allowedMentions: { roles: [participantRoleId] },
  });
}

async function sendSplitStartAnnouncement({ guild, settings, waitingChannel }) {
  const channelId = getKokuchiAnnouncementChannelId(settings);
  const sendChannel = channelId
    ? await resolveConfiguredTextChannel(guild, channelId)
    : null;

  if (!sendChannel) {
    return null;
  }

  return sendChannel.send({
    content: formatSplitStartAnnouncement(waitingChannel),
    allowedMentions: { parse: [] },
  }).catch(() => null);
}

async function sendSplitClosingThanks(guild, settings, participantMemberIds = []) {
  const channelId = getKokuchiAnnouncementChannelId(settings);

  if (!channelId) {
    return null;
  }

  const sendChannel = await resolveConfiguredTextChannel(
    guild,
    channelId,
  );

  if (!sendChannel) {
    return null;
  }

  return sendChannel.send({
    content: formatSplitClosingThanksMessage(settings, participantMemberIds),
    allowedMentions: { parse: [] },
  }).catch((error) => {
    console.error(`Failed to send split closing thanks: ${error.message}`);
    return null;
  });
}

function formatSplitClosingThanksMessage(settings, participantMemberIds) {
  const feedbackChannelId =
    settings?.splitFeedbackChannelId ?? DEFAULT_SPLIT_FEEDBACK_CHANNEL_ID;
  const nextWeekday = settings?.lastKokuchiWeekday === "火" ? "土曜日" : "火曜日";

  return formatSplitClosingThanks({
    feedbackChannelId,
    nextWeekday,
    participantCount: countUniqueParticipantIds(participantMemberIds),
  });
}

function getKokuchiAnnouncementChannelId(settings) {
  return settings?.wadaiChannelId ?? settings?.splitStartChannelId ?? null;
}

function getKokuchiOverviewChannelId(settings) {
  return settings?.kokuchiOverviewChannelId ?? null;
}

async function resolveWadaiSendChannel(guild, settings, fallbackChannel) {
  const textTypes = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
  const channelId = getKokuchiAnnouncementChannelId(settings);

  if (channelId) {
    const configured = await guild.channels.fetch(channelId).catch(() => null);

    if (
      configured &&
      textTypes.includes(configured.type) &&
      typeof configured.send === "function"
    ) {
      return configured;
    }
  }

  return fallbackChannel && typeof fallbackChannel.send === "function"
    ? fallbackChannel
    : null;
}

async function resolveConfiguredTextChannel(guild, channelId) {
  if (!channelId) {
    return null;
  }

  const textTypes = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
  const channel = await guild.channels.fetch(channelId).catch(() => null);

  return channel &&
    textTypes.includes(channel.type) &&
    typeof channel.send === "function"
    ? channel
    : null;
}

async function sendOperationalLog({
  guild,
  settings,
  fallbackChannel,
  content,
  allowedMentions = { parse: [] },
}) {
  const logChannel = settings?.logChannelId
    ? await resolveConfiguredTextChannel(guild, settings.logChannelId)
    : null;
  const channel =
    logChannel ??
    (fallbackChannel && typeof fallbackChannel.send === "function"
      ? fallbackChannel
      : null);

  if (!channel) {
    if (settings?.logChannelId) {
      console.error(`Operational log channel could not be resolved for guild ${guild?.id ?? "unknown"}.`);
    }
    return null;
  }

  return channel.send({
    content,
    allowedMentions,
  }).catch((error) => {
    console.error(`Operational log send failed for guild ${guild?.id ?? "unknown"}: ${error?.name ?? "unknown error"}`);
    return null;
  });
}

async function sendSplitGroupingLog({ guild, settings, content }) {
  return sendOperationalLog({
    guild,
    settings,
    fallbackChannel: null,
    content,
  });
}

async function handleKokuchi(interaction) {
  if (!interaction.inGuild()) {
    await replyOrFollowUp(interaction, {
      content: "このコマンドはサーバー内で使ってください。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild)) {
    await replyOrFollowUp(interaction, {
      content: "告知を投稿するには、サーバー管理権限が必要です。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const weekday = interaction.options.getString("weekday", true);
  const overviewChannel = interaction.options.getChannel("overview_channel", false);
  const targetChannel = interaction.options.getChannel("channel", false);
  const sendTopic = interaction.options.getBoolean("send_topic", false) ?? false;
  const settings = await getGuildSettings(interaction.guildId);
  const sendChannel =
    targetChannel && typeof targetChannel.send === "function"
      ? targetChannel
      : await resolveWadaiSendChannel(interaction.guild, settings, null);

  if (!sendChannel) {
    await replyOrFollowUp(interaction, {
      content:
        "告知送信先を取得できませんでした。`channel` を指定するか、`/setting wadai wadaich:送信先` を設定してください。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const resolvedOverviewChannel =
    overviewChannel ??
    (settings?.kokuchiOverviewChannelId
      ? await interaction.guild.channels
          .fetch(settings.kokuchiOverviewChannelId)
          .catch(() => null)
      : null);

  if (!resolvedOverviewChannel || typeof resolvedOverviewChannel.send !== "function") {
    await replyOrFollowUp(interaction, {
      content:
        "概要案内チャンネルが未設定です。`/setting splitvc kokuchi_overview_channel:概要案内チャンネル` を設定してください。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  let nextSettings = settings;
  let topic = null;

  if (sendTopic) {
    const result = await chooseAndStoreKokuchiWadaiTopic(
      interaction.guildId,
      settings,
    );
    nextSettings = result.settings;
    topic = result.topic;
  }
  const postedAt = new Date();
  const kokuchiPreNoticeAt = getKokuchiPreNoticeAt(postedAt);
  const gatheringVcUnlockAt = getGatheringVcUnlockAt(postedAt);
  const kokuchiGatheringReminderAt = getKokuchiGatheringReminderAt(postedAt);
  const selectedTopic = sendTopic
    ? topic ?? {
    id: "missing",
    text: "未登録です。/addwadai で追加してください。",
      }
    : null;
  const message = await sendChannel.send({
    content: formatKokuchiMessage({
      weekday,
      overviewChannelId: resolvedOverviewChannel.id,
      topic: selectedTopic,
    }),
    allowedMentions: { parse: [] },
  });

  const savedSettings = await saveGuildSettingsWithCurrent(interaction.guildId, nextSettings, {
    lastKokuchiWeekday: weekday,
    lastKokuchiPostedAt: postedAt.toISOString(),
    kokuchiTopicEnabled: sendTopic,
    ...(sendTopic ? {} : { wadaiCurrentTopic: null }),
    kokuchiPreNoticeAt: kokuchiPreNoticeAt.toISOString(),
    kokuchiPreNoticeChannelId: sendChannel.id,
    kokuchiPreNoticeState: "pending",
    gatheringVcUnlockAt: gatheringVcUnlockAt.toISOString(),
    gatheringVcUnlockChannelId: resolveKokuchiGatheringVoiceChannelId(
      settings,
      nextSettings,
    ),
    gatheringVcUnlockState: "pending",
    kokuchiGatheringReminderAt: kokuchiGatheringReminderAt.toISOString(),
    kokuchiGatheringReminderChannelId: sendChannel.id,
    kokuchiGatheringReminderState: "pending",
    wadaiKokuchiMessage: {
      channelId: sendChannel.id,
      messageId: message.id,
      postedAt: postedAt.toISOString(),
    },
  });
  await scheduleKokuchiPreNotice(interaction.guild, savedSettings);
  await scheduleGatheringVcUnlock(interaction.guild, savedSettings);
  await scheduleKokuchiGatheringReminder(interaction.guild, savedSettings);

  await replyOrFollowUp(interaction, {
    content: sendTopic
      ? `告知を ${sendChannel} に投稿しました。\n今回の最初の話題: ${selectedTopic.text}`
      : `告知を ${sendChannel} に投稿しました。\n今回は最初の話題を送信しません。`,
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
}

async function restoreGatheringVcUnlockSchedules() {
  for (const guild of client.guilds.cache.values()) {
    const settings = await getGuildSettings(guild.id);
    await scheduleKokuchiPreNotice(guild, settings);
    await scheduleGatheringVcUnlock(guild, settings);
    await scheduleKokuchiGatheringReminder(guild, settings);
  }
}

async function scheduleKokuchiPreNotice(guild, settings) {
  clearKokuchiPreNoticeTimer(guild.id);

  if (
    !settings?.kokuchiPreNoticeChannelId ||
    settings.kokuchiPreNoticeState !== "pending"
  ) {
    return;
  }

  const noticeAt = new Date(settings.kokuchiPreNoticeAt);

  if (!Number.isFinite(noticeAt.getTime())) {
    return;
  }

  const now = new Date();

  if (noticeAt.getTime() <= now.getTime()) {
    await saveGuildSettingsWithCurrent(guild.id, settings, {
      kokuchiPreNoticeState: "skipped",
    });
    return;
  }

  const timer = setTimeout(() => {
    kokuchiPreNoticeTimers.delete(guild.id);
    void sendKokuchiPreNotice(guild.id).catch((error) => {
      console.error(`Failed to send kokuchi pre notice: ${error.message}`, error);
    });
  }, noticeAt.getTime() - now.getTime());

  kokuchiPreNoticeTimers.set(guild.id, timer);
}

function clearKokuchiPreNoticeTimer(guildId) {
  const timer = kokuchiPreNoticeTimers.get(guildId);

  if (timer) {
    clearTimeout(timer);
    kokuchiPreNoticeTimers.delete(guildId);
  }
}

async function sendKokuchiPreNotice(guildId) {
  const guild =
    client.guilds.cache.get(guildId) ??
    (await client.guilds.fetch(guildId).catch(() => null));

  if (!guild) {
    return;
  }

  const settings = await getGuildSettings(guild.id);

  if (
    !settings?.kokuchiPreNoticeChannelId ||
    settings.kokuchiPreNoticeState !== "pending"
  ) {
    return;
  }

  const noticeAt = new Date(settings.kokuchiPreNoticeAt);

  if (!Number.isFinite(noticeAt.getTime()) || !isSameJstDate(noticeAt, new Date())) {
    return;
  }

  const channel = await resolveConfiguredTextChannel(
    guild,
    settings.kokuchiPreNoticeChannelId,
  );

  if (!channel) {
    return;
  }

  const message = await channel.send({
    content: "30分前です！ぜひご参加ください！",
    allowedMentions: { parse: [] },
  }).catch((error) => {
    console.error(`Failed to send kokuchi pre notice: ${error.message}`);
    return null;
  });

  if (!message) {
    return;
  }

  await saveGuildSettingsWithCurrent(guild.id, settings, {
    kokuchiPreNoticeState: "sent",
    kokuchiPreNoticeMessage: {
      channelId: channel.id,
      messageId: message.id,
      sentAt: new Date().toISOString(),
    },
  });
}

async function scheduleGatheringVcUnlock(guild, settings) {
  clearGatheringVcUnlockTimer(guild.id);

  if (!getGatheringVcUnlockChannelId(settings)) {
    return;
  }

  const unlockAt = new Date(settings.gatheringVcUnlockAt);

  if (!Number.isFinite(unlockAt.getTime())) {
    return;
  }

  const now = new Date();

  if (
    settings.gatheringVcUnlockState === "opened" &&
    isSameJstDate(unlockAt, now)
  ) {
    await setGatheringVcConnectPermission({
      guild,
      settings,
      canConnect: true,
      reason: "会話練習会の集合VC設定変更に伴う開放",
    });
    return;
  }

  if (settings.gatheringVcUnlockState !== "pending") {
    return;
  }

  if (unlockAt.getTime() <= now.getTime()) {
    if (isSameJstDate(unlockAt, now)) {
      await applyGatheringVcUnlock(guild.id);
    }
    return;
  }

  const timer = setTimeout(() => {
    gatheringVcUnlockTimers.delete(guild.id);
    void applyGatheringVcUnlock(guild.id).catch((error) => {
      console.error(`Failed to unlock gathering VC: ${error.message}`, error);
    });
  }, unlockAt.getTime() - now.getTime());

  gatheringVcUnlockTimers.set(guild.id, timer);
}

function clearGatheringVcUnlockTimer(guildId) {
  const timer = gatheringVcUnlockTimers.get(guildId);

  if (timer) {
    clearTimeout(timer);
    gatheringVcUnlockTimers.delete(guildId);
  }
}

async function scheduleKokuchiGatheringReminder(guild, settings) {
  clearKokuchiGatheringReminderTimer(guild.id);

  if (
    !settings?.kokuchiGatheringReminderChannelId ||
    settings.kokuchiGatheringReminderState !== "pending"
  ) {
    return;
  }

  const remindAt = new Date(settings.kokuchiGatheringReminderAt);

  if (!Number.isFinite(remindAt.getTime())) {
    return;
  }

  const now = new Date();

  if (remindAt.getTime() <= now.getTime()) {
    if (isSameJstDate(remindAt, now)) {
      await sendKokuchiGatheringReminder(guild.id);
    }
    return;
  }

  const timer = setTimeout(() => {
    kokuchiGatheringReminderTimers.delete(guild.id);
    void sendKokuchiGatheringReminder(guild.id).catch((error) => {
      console.error(
        `Failed to send kokuchi gathering reminder: ${error.message}`,
        error,
      );
    });
  }, remindAt.getTime() - now.getTime());

  kokuchiGatheringReminderTimers.set(guild.id, timer);
}

function clearKokuchiGatheringReminderTimer(guildId) {
  const timer = kokuchiGatheringReminderTimers.get(guildId);

  if (timer) {
    clearTimeout(timer);
    kokuchiGatheringReminderTimers.delete(guildId);
  }
}

async function sendKokuchiGatheringReminder(guildId) {
  const guild =
    client.guilds.cache.get(guildId) ??
    (await client.guilds.fetch(guildId).catch(() => null));

  if (!guild) {
    return;
  }

  const settings = await getGuildSettings(guild.id);

  if (
    !settings?.kokuchiGatheringReminderChannelId ||
    settings.kokuchiGatheringReminderState !== "pending"
  ) {
    return;
  }

  const remindAt = new Date(settings.kokuchiGatheringReminderAt);

  if (!Number.isFinite(remindAt.getTime()) || !isSameJstDate(remindAt, new Date())) {
    return;
  }

  const channel = await resolveConfiguredTextChannel(
    guild,
    settings.kokuchiGatheringReminderChannelId,
  );

  if (!channel) {
    return;
  }

  const roleMentions = KOKUCHI_GATHERING_REMINDER_ROLE_IDS
    .map((roleId) => `<@&${roleId}>`)
    .join(" ");

  const message = await channel.send({
    content:
      `${roleMentions} 会話練習会の集合が開始しました！ ` +
      `<#${KOKUCHI_GATHERING_REMINDER_VOICE_CHANNEL_ID}> からぜひご参加ください！5分後に締め切られます`,
    allowedMentions: { roles: KOKUCHI_GATHERING_REMINDER_ROLE_IDS },
  }).catch((error) => {
    console.error(`Failed to send kokuchi gathering reminder: ${error.message}`);
    return null;
  });

  if (!message) {
    return;
  }

  await saveGuildSettingsWithCurrent(guild.id, settings, {
    kokuchiGatheringReminderState: "sent",
    kokuchiGatheringReminderMessage: {
      channelId: channel.id,
      messageId: message.id,
      sentAt: new Date().toISOString(),
    },
  });
}

async function applyGatheringVcUnlock(guildId) {
  const guild =
    client.guilds.cache.get(guildId) ??
    (await client.guilds.fetch(guildId).catch(() => null));

  if (!guild) {
    return;
  }

  const settings = await getGuildSettings(guild.id);

  if (
    !getGatheringVcUnlockChannelId(settings) ||
    settings.gatheringVcUnlockState !== "pending"
  ) {
    return;
  }

  const changed = await setGatheringVcConnectPermission({
    guild,
    settings,
    canConnect: true,
    reason: "会話練習会の集合VCを20:40に開放",
  });

  if (changed) {
    await saveGuildSettingsWithCurrent(guild.id, settings, {
      gatheringVcUnlockState: "opened",
    });
  }
}

async function closeGatheringVcAfterSplit(guild, settings) {
  clearGatheringVcUnlockTimer(guild.id);

  const changed = await setGatheringVcConnectPermission({
    guild,
    settings,
    canConnect: false,
    reason: "/splitvc転送完了に伴う集合VC接続停止",
  });

  if (changed) {
    await saveGuildSettingsWithCurrent(guild.id, settings, {
      gatheringVcUnlockState: "closed",
    });
  }

  return changed;
}

async function setGatheringVcConnectPermission({
  guild,
  settings,
  canConnect,
  reason,
}) {
  const channelId = getGatheringVcUnlockChannelId(settings);

  if (!channelId) {
    return false;
  }

  const channel = await guild.channels
    .fetch(channelId)
    .catch(() => null);

  if (!channel?.isVoiceBased() || typeof channel.permissionOverwrites?.edit !== "function") {
    return false;
  }

  const changed = await editEveryoneConnectPermission({
    channel,
    guildId: guild.id,
    canConnect,
    reason,
  })
    .catch((error) => {
      console.error(
        `Failed to ${canConnect ? "open" : "close"} gathering VC ${channel.id}: ${error.message}`,
      );
      return false;
    });

  return changed;
}

function getGatheringVcUnlockChannelId(settings) {
  return (
    settings?.gatheringVcUnlockChannelId ??
    settings?.gatheringVoiceChannelId ??
    null
  );
}

function getKokuchiPreNoticeAt(date) {
  const jstDate = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  return new Date(Date.UTC(
    jstDate.getUTCFullYear(),
    jstDate.getUTCMonth(),
    jstDate.getUTCDate(),
    KOKUCHI_PRE_NOTICE_HOUR_JST - 9,
    KOKUCHI_PRE_NOTICE_MINUTE_JST,
    0,
    0,
  ));
}

function getGatheringVcUnlockAt(date) {
  return getJstScheduledTime(
    date,
    GATHERING_VC_OPEN_HOUR_JST,
    GATHERING_VC_OPEN_MINUTE_JST,
  );
}

function getKokuchiGatheringReminderAt(date) {
  const jstDate = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  return new Date(Date.UTC(
    jstDate.getUTCFullYear(),
    jstDate.getUTCMonth(),
    jstDate.getUTCDate(),
    KOKUCHI_GATHERING_REMINDER_HOUR_JST - 9,
    KOKUCHI_GATHERING_REMINDER_MINUTE_JST,
    0,
    0,
  ));
}

function isSameJstDate(left, right) {
  const leftJst = new Date(left.getTime() + 9 * 60 * 60 * 1000);
  const rightJst = new Date(right.getTime() + 9 * 60 * 60 * 1000);

  return (
    leftJst.getUTCFullYear() === rightJst.getUTCFullYear() &&
    leftJst.getUTCMonth() === rightJst.getUTCMonth() &&
    leftJst.getUTCDate() === rightJst.getUTCDate()
  );
}

async function handleSendCallWait(interaction) {
  if (!interaction.inGuild()) {
    await replyOrFollowUp(interaction, {
      content: "このコマンドはサーバー内で使ってください。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild)) {
    await replyOrFollowUp(interaction, {
      content: "通話待機システムの募集メッセージを送るには、サーバー管理権限が必要です。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const settings = await getGuildSettings(interaction.guildId);
  const result = await sendCallWaitPromptForGuild(interaction.guild, settings, {
    force: true,
  });

  await replyOrFollowUp(interaction, {
    content: result.sent
      ? `通話待機システムの募集メッセージを ${result.channel} に送信しました。${formatJstHour(result.targetAt)} に希望者を確認します。`
      : `通話待機システムの募集メッセージを送信できませんでした。${result.reason}`,
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
}

async function handleSendOtebo(interaction) {
  if (!interaction.inGuild()) {
    await replyOrFollowUp(interaction, {
      content: "このコマンドはサーバー内で使ってください。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild)) {
    await replyOrFollowUp(interaction, {
      content: "お手軽募集の作成ボタンを送るには、サーバー管理権限が必要です。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const settings = await getGuildSettings(interaction.guildId);
  const channel = await resolveConfiguredTextChannel(
    interaction.guild,
    getCallWaitPromptChannelId(settings),
  );

  if (!channel) {
    await replyOrFollowUp(interaction, {
      content: "`/setting callwait call_wait_prompt_channel:送信先` を設定してください。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await channel.send({
    content: "下のボタンから募集作成できます。",
    components: [createOteboCreateRow()],
    allowedMentions: { parse: [] },
  });

  await replyOrFollowUp(interaction, {
    content: `お手軽募集の作成ボタンを ${channel} に送信しました。`,
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
}

async function handleOteboButton(interaction) {
  if (!interaction.inGuild()) {
    await interaction.reply({
      content: "このボタンはサーバー内で使ってください。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (interaction.customId === OTEBO_CREATE_CUSTOM_ID) {
    await handleOteboCreateButton(interaction);
    return;
  }

  if (interaction.customId === OTEBO_DRAFT_NOTE_CUSTOM_ID) {
    await handleOteboDraftNoteButton(interaction);
    return;
  }

  if (interaction.customId === OTEBO_DRAFT_SUBMIT_CUSTOM_ID) {
    await handleOteboDraftSubmitButton(interaction);
    return;
  }

  if (interaction.customId === OTEBO_DRAFT_CANCEL_CUSTOM_ID) {
    oteboDrafts.delete(getOteboDraftKey(interaction.guildId, interaction.user.id));
    await interaction.update({
      content: "お手軽募集の作成をキャンセルしました。",
      components: [],
    });
    return;
  }

  if (interaction.customId.startsWith(`${OTEBO_JOIN_CUSTOM_ID}:`)) {
    await handleOteboJoinButton(
      interaction,
      interaction.customId.slice(`${OTEBO_JOIN_CUSTOM_ID}:`.length),
    );
    return;
  }

  if (interaction.customId.startsWith(`${OTEBO_MEMBER_CANCEL_CUSTOM_ID}:`)) {
    await handleOteboMemberCancelButton(
      interaction,
      interaction.customId.slice(`${OTEBO_MEMBER_CANCEL_CUSTOM_ID}:`.length),
    );
    return;
  }

  if (interaction.customId.startsWith(`${OTEBO_OWNER_CANCEL_CUSTOM_ID}:`)) {
    await handleOteboOwnerCancelButton(
      interaction,
      interaction.customId.slice(`${OTEBO_OWNER_CANCEL_CUSTOM_ID}:`.length),
    );
    return;
  }

  if (interaction.customId.startsWith(`${OTEBO_OWNER_CANCEL_CONFIRM_CUSTOM_ID}:`)) {
    await handleOteboOwnerCancelConfirmButton(
      interaction,
      interaction.customId.slice(`${OTEBO_OWNER_CANCEL_CONFIRM_CUSTOM_ID}:`.length),
    );
  }
}

async function handleOteboCreateButton(interaction) {
  const settings = await getGuildSettings(interaction.guildId);
  const existing = findActiveOteboRecruitmentByOwner(settings, interaction.user.id);

  if (existing) {
    await interaction.reply({
      content: "同時に作成できるお手軽募集は一人一つまでです。内容を変える場合は、既存の募集をキャンセルしてから作り直してください。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const draft = createDefaultOteboDraft(interaction.guildId, interaction.user.id);
  oteboDrafts.set(getOteboDraftKey(interaction.guildId, interaction.user.id), draft);

  await interaction.reply({
    content: formatOteboDraftContent(draft),
    components: createOteboDraftRows(draft),
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
}

async function handleOteboDraftSelect(interaction) {
  if (!interaction.inGuild()) {
    await interaction.reply({
      content: "この選択メニューはサーバー内で使ってください。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const field = interaction.customId.slice(`${OTEBO_DRAFT_SELECT_CUSTOM_ID}:`.length);
  const key = getOteboDraftKey(interaction.guildId, interaction.user.id);
  const draft = oteboDrafts.get(key);

  if (!draft) {
    await interaction.update({
      content: "入力中のお手軽募集が見つかりません。もう一度、募集作成ボタンから作り直してください。",
      components: [],
    });
    return;
  }

  const [value] = interaction.values;

  if (field === "type") {
    draft.type = value === OTEBO_TYPE_IMMEDIATE ? OTEBO_TYPE_IMMEDIATE : OTEBO_TYPE_SCHEDULED;
  } else if (field === "target_at") {
    draft.targetAt = value;
  } else if (field === "duration") {
    draft.duration = normalizeOteboDuration(value);
  } else if (field === "mention") {
    draft.mentionBosyu = value === "yes";
  }

  oteboDrafts.set(key, draft);

  await interaction.update({
    content: formatOteboDraftContent(draft),
    components: createOteboDraftRows(draft),
    allowedMentions: { parse: [] },
  });
}

async function handleOteboDraftNoteButton(interaction) {
  const draft = oteboDrafts.get(getOteboDraftKey(interaction.guildId, interaction.user.id));

  if (!draft) {
    await interaction.reply({
      content: "入力中のお手軽募集が見つかりません。もう一度、募集作成ボタンから作り直してください。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  draft.menuMessageId = interaction.message?.id ?? null;
  draft.menuInteractionToken = interaction.token;
  draft.menuApplicationId = interaction.applicationId;
  oteboDrafts.set(getOteboDraftKey(interaction.guildId, interaction.user.id), draft);

  const modal = new ModalBuilder()
    .setCustomId(OTEBO_NOTE_MODAL_CUSTOM_ID)
    .setTitle("お手軽募集");
  const noteInput = new TextInputBuilder()
    .setCustomId("note")
    .setLabel("ひとこと（任意）")
    .setPlaceholder("例）お暇でしたらぜひ")
    .setStyle(TextInputStyle.Paragraph)
    .setMaxLength(300)
    .setRequired(false);

  modal.addComponents(new ActionRowBuilder().addComponents(noteInput));
  await interaction.showModal(modal);
}

async function handleOteboDraftSubmitButton(interaction) {
  const result = await createOteboRecruitmentFromDraft(interaction, "");

  if (!result.ok) {
    await interaction.update({
      content: result.reason,
      components: result.keepDraft
        ? createOteboDraftRows(result.draft)
        : [],
      allowedMentions: { parse: [] },
    });
    return;
  }

  await interaction.update({
    content: formatOteboOwnerCancelMessage(),
    components: [],
    allowedMentions: { parse: [] },
  });
}

async function handleOteboNoteModal(interaction) {
  const note = interaction.fields.getTextInputValue("note") ?? "";
  const result = await createOteboRecruitmentFromDraft(interaction, note);

  if (!result.ok) {
    await interaction.reply({
      content: result.reason,
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
    return;
  }

  await updateOteboDraftMenuAfterModal(result.draftMenu);

  await interaction.reply({
    content: formatOteboOwnerCancelMessage(),
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
}

async function createOteboRecruitmentFromDraft(interaction, note) {
  const key = getOteboDraftKey(interaction.guildId, interaction.user.id);
  const draft = oteboDrafts.get(key);

  if (!draft) {
    return {
      ok: false,
      keepDraft: false,
      reason: "入力中のお手軽募集が見つかりません。もう一度、募集作成ボタンから作り直してください。",
    };
  }

  const targetAt = new Date(draft.targetAt);
  if (!Number.isFinite(targetAt.getTime()) || targetAt.getTime() <= Date.now()) {
    return {
      ok: false,
      keepDraft: true,
      draft,
      reason: "メンション・掲載終了時刻にすでに経過した時刻を指定しています。時刻を選び直してください。",
    };
  }

  const settings = await getGuildSettings(interaction.guildId);
  const existing = findActiveOteboRecruitmentByOwner(settings, interaction.user.id);

  if (existing) {
    return {
      ok: false,
      keepDraft: false,
      reason: "同時に作成できるお手軽募集は一人一つまでです。内容を変える場合は、既存の募集をキャンセルしてから作り直してください。",
    };
  }

  const configured = await validateOteboSettings(interaction.guild, settings, draft);

  if (!configured.ok) {
    return {
      ok: false,
      keepDraft: true,
      draft,
      reason: configured.reason,
    };
  }

  const shouldUsePreviewChannel =
    draft.type !== OTEBO_TYPE_IMMEDIATE &&
    configured.previewChannel &&
    targetAt.getTime() - OTEBO_SCHEDULED_NOTICE_LEAD_MS > Date.now();
  const sendChannel = shouldUsePreviewChannel
    ? configured.previewChannel
    : configured.noticeChannel;
  const recruitment = {
    id: createOteboRecruitmentId(),
    ownerId: interaction.user.id,
    type: draft.type === OTEBO_TYPE_IMMEDIATE ? OTEBO_TYPE_IMMEDIATE : OTEBO_TYPE_SCHEDULED,
    targetAt: targetAt.toISOString(),
    duration: normalizeOteboDuration(draft.duration),
    mentionBosyu: draft.mentionBosyu === true,
    note: normalizeOteboNote(note),
    channelId: sendChannel.id,
    messageId: null,
    noticeChannelId: configured.noticeChannel.id,
    previewChannelId: shouldUsePreviewChannel ? configured.previewChannel.id : null,
    publishedToNotice: !shouldUsePreviewChannel,
    memberIds: [interaction.user.id],
    pendingConfirmations: {},
    status: "active",
    createdAt: new Date().toISOString(),
    quickConfirmSeconds: getOteboQuickConfirmSeconds(settings),
  };
  const draftMenu = {
    applicationId: draft.menuApplicationId,
    token: draft.menuInteractionToken,
    messageId: draft.menuMessageId,
  };
  const message = await sendChannel.send({
    content: formatOteboRecruitmentMessage(recruitment, settings),
    components: [createOteboJoinRow(recruitment)],
    allowedMentions: getOteboRecruitmentAllowedMentions(recruitment, settings),
  });

  recruitment.messageId = message.id;

  const nextSettings = await saveOteboRecruitmentState(
    interaction.guildId,
    settings,
    recruitment,
  );

  oteboDrafts.delete(key);
  scheduleOteboRecruitmentTimers(interaction.guild, recruitment);
  await sendOteboApplicantLog({
    guild: interaction.guild,
    settings: nextSettings,
    action: "create",
    userId: interaction.user.id,
    memberIds: recruitment.memberIds,
  });

  return {
    ok: true,
    recruitment,
    draftMenu,
  };
}

async function handleOteboJoinButton(interaction, recruitmentId) {
  const settings = await getGuildSettings(interaction.guildId);
  const recruitment = getOteboRecruitment(settings, recruitmentId);

  if (!isActiveOteboRecruitment(recruitment, interaction.message?.id)) {
    await interaction.reply({
      content: "この募集は現在有効ではありません。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const targetAt = new Date(recruitment.targetAt);
  if (!Number.isFinite(targetAt.getTime()) || targetAt.getTime() <= Date.now()) {
    await interaction.reply({
      content: "この募集は締め切られています。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (normalizeCallWaitMemberIds(recruitment.memberIds).includes(interaction.user.id)) {
    await interaction.reply({
      content: "すでに参加希望を受け付けています。キャンセルする場合はメッセージ下のキャンセルボタンから行えます。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (recruitment.type === OTEBO_TYPE_IMMEDIATE) {
    await handleOteboImmediateJoin(interaction, settings, recruitment);
    return;
  }

  const memberIds = addUniqueMemberId(recruitment.memberIds, interaction.user.id);
  const updated = await updateOteboRecruitmentParticipant({
    guildId: interaction.guildId,
    recruitmentId,
    messageId: interaction.message.id,
    userId: interaction.user.id,
    operation: "add",
  });
  if (!updated) {
    await interaction.reply({ content: "この募集はすでに更新されています。", flags: MessageFlags.Ephemeral });
    return;
  }

  const nextSettings = await getGuildSettings(interaction.guildId);
  const nextRecruitment = getOteboRecruitment(nextSettings, recruitmentId) ?? { ...recruitment, memberIds };

  await sendOteboApplicantLog({
    guild: interaction.guild,
    settings: nextSettings,
    action: "join",
    userId: interaction.user.id,
    memberIds,
  });
  await editOteboRecruitmentMessage(interaction.guild, nextSettings, nextRecruitment);

  await interaction.reply({
    content: "参加希望を受け付けました。キャンセルする場合はメッセージ下のキャンセルボタンから行えます。",
    flags: MessageFlags.Ephemeral,
  });
}

async function handleOteboImmediateJoin(interaction, settings, recruitment) {
  const confirmSeconds = getOteboQuickConfirmSeconds(settings, recruitment);
  const confirmExpiresAt = new Date(Date.now() + secondsToMs(confirmSeconds));
  const pendingConfirmations = {
    ...(recruitment.pendingConfirmations ?? {}),
    [interaction.user.id]: confirmExpiresAt.toISOString(),
  };
  const memberIds = addUniqueMemberId(recruitment.memberIds, interaction.user.id);
  const updated = await updateOteboRecruitmentParticipant({
    guildId: interaction.guildId,
    recruitmentId: recruitment.id,
    messageId: recruitment.messageId,
    userId: interaction.user.id,
    operation: "add",
    pendingConfirmation: confirmExpiresAt.toISOString(),
  });
  if (!updated) {
    await interaction.reply({ content: "この募集はすでに更新されています。", flags: MessageFlags.Ephemeral });
    return;
  }
  const nextSettings = await getGuildSettings(interaction.guildId);
  const nextRecruitment = getOteboRecruitment(nextSettings, recruitment.id) ?? { ...recruitment, memberIds, pendingConfirmations };

  scheduleOteboImmediateConfirmation(
    interaction.guild,
    nextRecruitment,
    interaction.user.id,
  );

  await sendOteboApplicantLog({
    guild: interaction.guild,
    settings: nextSettings,
    action: "join",
    userId: interaction.user.id,
    memberIds,
  });

  await interaction.reply({
    content: formatOteboImmediateJoinReply(confirmSeconds),
    flags: MessageFlags.Ephemeral,
  });

  startOteboImmediateReplyCountdown({
    interaction,
    guildId: interaction.guildId,
    recruitmentId: recruitment.id,
    userId: interaction.user.id,
    confirmSeconds,
  });
}

function formatOteboImmediateJoinReply(remainingSeconds) {
  return [
    "参加希望を受け付けました。キャンセルはメッセージ下のキャンセルボタンから行えます。",
    `あと${Math.max(0, remainingSeconds)}秒間キャンセルがなかったら集合メンションが送られます。`,
  ].join("\n");
}

function startOteboImmediateReplyCountdown({
  interaction,
  guildId,
  recruitmentId,
  userId,
  confirmSeconds,
}) {
  let remainingSeconds = Number(confirmSeconds);

  if (!Number.isInteger(remainingSeconds) || remainingSeconds <= 0) {
    return;
  }

  const timer = setInterval(() => {
    remainingSeconds -= 1;

    void (async () => {
      const settings = await getGuildSettings(guildId);
      const recruitment = getOteboRecruitment(settings, recruitmentId);

      if (!recruitment?.pendingConfirmations?.[userId]) {
        clearInterval(timer);
        return;
      }

      await interaction.editReply({
        content: formatOteboImmediateJoinReply(remainingSeconds),
      }).catch(() => null);

      if (remainingSeconds <= 0) {
        clearInterval(timer);
      }
    })().catch(() => {
      clearInterval(timer);
    });
  }, 1000);
}

async function handleOteboMemberCancelButton(interaction, recruitmentId) {
  const settings = await getGuildSettings(interaction.guildId);
  const recruitment = getOteboRecruitment(settings, recruitmentId);

  if (!isActiveOteboRecruitment(recruitment)) {
    await interaction.reply({
      content: "この募集は現在有効ではありません。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const memberIds = normalizeCallWaitMemberIds(recruitment.memberIds);

  if (!memberIds.includes(interaction.user.id)) {
    await interaction.reply({
      content: "この募集への参加の予定はありません。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (interaction.user.id === recruitment.ownerId) {
    await interaction.reply({
      content: "自身が作成した募集ですがキャンセルしてもよろしいですか？",
      components: [createOteboOwnerCancelConfirmRow(recruitment.id)],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await cancelOteboParticipation({
    interaction,
    settings,
    recruitment,
    userId: interaction.user.id,
    response: "reply",
  });
}

async function handleOteboOwnerCancelButton(interaction, recruitmentId) {
  const settings = await getGuildSettings(interaction.guildId);
  const recruitment = getOteboRecruitment(settings, recruitmentId);

  if (!isActiveOteboRecruitment(recruitment)) {
    await interaction.reply({
      content: "この募集は現在有効ではありません。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (interaction.user.id !== recruitment.ownerId) {
    await interaction.reply({
      content: "この募集をキャンセルできるのは作成者だけです。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.reply({
    content: "自身が作成した募集ですがキャンセルしてもよろしいですか？",
    components: [createOteboOwnerCancelConfirmRow(recruitment.id)],
    flags: MessageFlags.Ephemeral,
  });
}

async function handleOteboOwnerCancelConfirmButton(interaction, recruitmentId) {
  const settings = await getGuildSettings(interaction.guildId);
  const recruitment = getOteboRecruitment(settings, recruitmentId);

  if (!isActiveOteboRecruitment(recruitment)) {
    await interaction.update({
      content: "この募集は現在有効ではありません。",
      components: [],
    });
    return;
  }

  if (interaction.user.id !== recruitment.ownerId) {
    await interaction.update({
      content: "この確認ボタンを使えるのは募集作成者だけです。",
      components: [],
    });
    return;
  }

  if (!normalizeCallWaitMemberIds(recruitment.memberIds).includes(interaction.user.id)) {
    await interaction.update({
      content: "この募集への参加の予定はありません。",
      components: [],
    });
    return;
  }

  await cancelOteboParticipation({
    interaction,
    settings,
    recruitment,
    userId: interaction.user.id,
    response: "update",
  });
}

async function cancelOteboParticipation({
  interaction,
  settings,
  recruitment,
  userId,
  response,
}) {
  const pendingConfirmations = { ...(recruitment.pendingConfirmations ?? {}) };
  delete pendingConfirmations[userId];
  clearOteboConfirmationTimer(interaction.guildId, recruitment.id, userId);

  const memberIds = normalizeCallWaitMemberIds(recruitment.memberIds).filter(
    (memberId) => memberId !== userId,
  );

  if (memberIds.length === 0) {
    const deleted = await deleteOteboRecruitmentIfOnlyMember({
      guildId: interaction.guildId,
      recruitmentId: recruitment.id,
      messageId: recruitment.messageId,
      userId,
    });
    if (deleted) {
      await deleteOteboRecruitmentMessage(interaction.guild, recruitment);
      clearOteboRecruitmentTimers(interaction.guildId, recruitment.id);
      await sendOteboApplicantLog({
        guild: interaction.guild,
        settings: await getGuildSettings(interaction.guildId),
        action: "cancel",
        userId,
        memberIds: [],
      });
      await respondOteboCancel(interaction, response);
      return;
    }
  }

  const updated = await updateOteboRecruitmentParticipant({
    guildId: interaction.guildId,
    recruitmentId: recruitment.id,
    messageId: recruitment.messageId,
    userId,
    operation: "remove",
  });
  if (!updated) {
    await respondOteboCancel(interaction, response);
    return;
  }
  const nextSettings = await getGuildSettings(interaction.guildId);
  const nextRecruitment = getOteboRecruitment(nextSettings, recruitment.id) ?? { ...recruitment, memberIds, pendingConfirmations };

  await editOteboRecruitmentMessage(interaction.guild, nextSettings, nextRecruitment);
  await sendOteboApplicantLog({
    guild: interaction.guild,
    settings: nextSettings,
    action: "cancel",
    userId,
    memberIds,
  });

  await respondOteboCancel(interaction, response);
}

async function respondOteboCancel(interaction, response) {
  if (response === "update") {
    await interaction.update({
      content: "参加の希望をキャンセルしました。",
      components: [],
    });
    return;
  }

  await interaction.reply({
    content: "参加の希望をキャンセルしました。",
    flags: MessageFlags.Ephemeral,
  });
}

function scheduleNextCallWaitTick() {
  if (callWaitTimer) {
    clearTimeout(callWaitTimer);
  }

  const delayMs = getMsUntilNextHour(new Date());
  callWaitTimer = setTimeout(() => {
    void processCallWaitForAllGuilds()
      .catch((error) => {
        console.error(error);
      })
      .finally(() => {
        scheduleNextCallWaitTick();
      });
  }, delayMs);
}

async function processCallWaitForAllGuilds() {
  for (const guild of client.guilds.cache.values()) {
    const settings = await getGuildSettings(guild.id);
    await processCallWaitForGuild(guild, settings).catch((error) => {
      console.error(`Failed to process call wait for ${guild.id}: ${error.message}`, error);
    });
  }
}

async function processCallWaitForGuild(guild, settings) {
  if (settings?.callWaitEnabled !== true) {
    return;
  }

  const configured = await validateCallWaitSettings(guild, settings);

  if (!configured.ok) {
    return;
  }

  const now = new Date();
  const promptResult = await evaluateCallWaitPrompt(guild, settings, now);

  if (promptResult.evaluated) {
    settings = await saveGuildSettingsWithCurrent(guild.id, settings, {
      callWaitPrompt: null,
    });

    if (promptResult.memberIds.length >= CALL_WAIT_MIN_MEMBERS) {
      const queued = await grantCallWaitRoleAndQueueNotice({
        guild,
        settings,
        memberIds: promptResult.memberIds,
      });

      if (queued) {
        await scheduleCallWaitFollowupCheck(guild);
        return;
      }
    } else if (promptResult.mode === CALL_WAIT_MODE_BUTTON) {
      await sendCallWaitApplicantLog({
        guild,
        settings,
        action: "reset",
        memberIds: [],
      });
    }
  }

  const activeVoiceMemberIds = getCallWaitActiveVoiceMemberIds(
    guild,
    settings.callWaitVoiceCategoryId,
  );

  if (await maybeSendPendingCallWaitStartNotice(guild, settings)) {
    return;
  }

  // /kokuchi 当日は、21時・22時向けの定時募集を出さない。
  if (isKokuchiCallWaitPause(settings, now)) {
    return;
  }

  if (activeVoiceMemberIds.length >= CALL_WAIT_MIN_MEMBERS) {
    if (settings.callWaitPrompt) {
      await deleteCallWaitPrompt(guild, settings.callWaitPrompt);
      settings = await saveGuildSettingsWithCurrent(guild.id, settings, {
        callWaitPrompt: null,
      });
    }

    settings = await sendCallWaitSkippedNotice({
      guild,
      settings,
      channel: configured.promptChannel,
      now,
    });

    return;
  }

  if (settings.callWaitPrompt) {
    return;
  }

  await sendCallWaitPromptForGuild(guild, settings, { force: false, now });
}

async function sendCallWaitPromptForGuild(guild, settings, { force = false, now = new Date() } = {}) {
  if (settings?.callWaitEnabled !== true) {
    return {
      sent: false,
      reason: "`/setting callwait call_wait_enabled:true` を設定してください。",
    };
  }

  const configured = await validateCallWaitSettings(guild, settings);

  if (!configured.ok) {
    return configured;
  }

  if (force && settings.callWaitPrompt) {
    await deleteCallWaitPrompt(guild, settings.callWaitPrompt);
    settings = await saveGuildSettingsWithCurrent(guild.id, settings, {
      callWaitPrompt: null,
    });
  }

  if (settings.callWaitSkippedNotice) {
    await deleteCallWaitMessage(guild, settings.callWaitSkippedNotice);
    settings = await saveGuildSettingsWithCurrent(guild.id, settings, {
      callWaitSkippedNotice: null,
    });
  }

  if (!force && settings.callWaitPrompt) {
    return {
      sent: false,
      reason: "既に有効な募集メッセージがあります。",
    };
  }

  const targetAt = getNextHourStart(now);
  const mode = normalizeCallWaitMode(settings.callWaitMode);
  const message = await configured.promptChannel.send({
    content: formatCallWaitPrompt(targetAt, mode),
    allowedMentions: { parse: [] },
    components:
      mode === CALL_WAIT_MODE_BUTTON ? [createCallWaitJoinRow(targetAt)] : [],
  });

  if (mode === CALL_WAIT_MODE_REACTION) {
    await message.react(CALL_WAIT_REACTION).catch(() => null);
  }

  await saveGuildSettingsWithCurrent(guild.id, settings, {
    callWaitPrompt: {
      channelId: configured.promptChannel.id,
      messageId: message.id,
      targetAt: targetAt.toISOString(),
      mode,
      memberIds: [],
    },
    callWaitPendingNotice: null,
    callWaitSkippedNotice: null,
  });

  return {
    sent: true,
    channel: configured.promptChannel,
    message,
    targetAt,
  };
}

async function validateCallWaitSettings(guild, settings) {
  const promptChannelId = getCallWaitPromptChannelId(settings);
  const noticeChannelId = getCallWaitNoticeChannelId(settings);

  if (!settings?.callWaitRoleId || !promptChannelId || !noticeChannelId) {
    return {
      ok: false,
      sent: false,
      reason: "`/setting callwait call_wait_role:ロール call_wait_prompt_channel:募集先 call_wait_notice_channel:通知先` を設定してください。",
    };
  }

  const promptChannel = await resolveConfiguredTextChannel(guild, promptChannelId);
  const noticeChannel = await resolveConfiguredTextChannel(guild, noticeChannelId);
  const role = await guild.roles.fetch(settings.callWaitRoleId).catch(() => null);

  if (!promptChannel) {
    return {
      ok: false,
      sent: false,
      reason: "通話待機システムの募集メッセージ送信先チャンネルを取得できません。",
    };
  }

  if (!noticeChannel) {
    return {
      ok: false,
      sent: false,
      reason: "通話待機システムの集合通知送信先チャンネルを取得できません。",
    };
  }

  if (!role) {
    return {
      ok: false,
      sent: false,
      reason: "通話待機システムのロールを取得できません。",
    };
  }

  return {
    ok: true,
    promptChannel,
    noticeChannel,
    role,
  };
}

async function evaluateCallWaitPrompt(guild, settings, now) {
  const prompt = settings?.callWaitPrompt;

  if (!prompt?.channelId || !prompt?.messageId || !prompt?.targetAt) {
    return { evaluated: false, memberIds: [] };
  }

  const targetAt = new Date(prompt.targetAt);
  if (!Number.isFinite(targetAt.getTime()) || targetAt.getTime() > now.getTime()) {
    return { evaluated: false, memberIds: [] };
  }

  const channel = await resolveConfiguredTextChannel(guild, prompt.channelId);

  if (!channel || typeof channel.messages?.fetch !== "function") {
    return { evaluated: true, memberIds: [] };
  }

  const message = await channel.messages.fetch(prompt.messageId).catch(() => null);

  if (!message) {
    return { evaluated: true, memberIds: [] };
  }

  const mode = normalizeCallWaitMode(prompt.mode ?? settings.callWaitMode);

  if (mode === CALL_WAIT_MODE_BUTTON) {
    const memberIds = normalizeCallWaitMemberIds(prompt.memberIds);
    await message.delete().catch(() => null);

    return { evaluated: true, memberIds, mode };
  }

  const reaction = message.reactions.cache.find(
    (cachedReaction) => cachedReaction.emoji.name === CALL_WAIT_REACTION,
  );
  const users = reaction ? await reaction.users.fetch().catch(() => null) : null;
  const memberIds = new Set();

  if (users) {
    for (const user of users.values()) {
      if (user.bot) {
        continue;
      }

      const member = await guild.members.fetch(user.id).catch(() => null);
      if (member) {
        memberIds.add(member.id);
      }
    }
  }

  await message.delete().catch(() => null);

  return { evaluated: true, memberIds: [...memberIds], mode };
}

async function deleteCallWaitPrompt(guild, prompt) {
  await deleteCallWaitMessage(guild, prompt);
}

async function deleteCallWaitMessage(guild, messageRef) {
  if (!messageRef?.channelId || !messageRef?.messageId) {
    return;
  }

  const channel = await resolveConfiguredTextChannel(guild, messageRef.channelId);

  if (!channel || typeof channel.messages?.fetch !== "function") {
    return;
  }

  const message = await channel.messages.fetch(messageRef.messageId).catch(() => null);
  if (message) {
    await message.delete().catch(() => null);
  }
}

async function handleCallWaitButton(interaction) {
  if (!interaction.inGuild()) {
    await interaction.reply({
      content: "このボタンはサーバー内で使ってください。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const settings = await getGuildSettings(interaction.guildId);
  const prompt = settings?.callWaitPrompt;
  const isJoin = interaction.customId === CALL_WAIT_JOIN_CUSTOM_ID;
  const promptMessageId = isJoin || interaction.customId === CALL_WAIT_CANCEL_CUSTOM_ID
    ? interaction.message?.id
    : interaction.customId.slice(`${CALL_WAIT_CANCEL_CUSTOM_ID}:`.length);

  if (
    !prompt ||
    prompt.mode !== CALL_WAIT_MODE_BUTTON ||
    prompt.messageId !== promptMessageId
  ) {
    await interaction.reply({
      content: "この募集は現在有効ではありません。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const targetAt = new Date(prompt.targetAt);
  if (!Number.isFinite(targetAt.getTime()) || targetAt.getTime() <= Date.now()) {
    await interaction.reply({
      content: "この募集は締め切られています。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const memberIds = normalizeCallWaitMemberIds(prompt.memberIds);
  const userId = interaction.user.id;

  if (isJoin && memberIds.includes(userId)) {
    await interaction.reply({
      content: "すでに参加予定になっています。キャンセルする場合は、下のキャンセルボタンを押してください。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!isJoin && !memberIds.includes(userId)) {
    await interaction.reply({
      content: "この募集への参加の予定はありません。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const updatedPrompt = await updateCallWaitPromptMember({
    guildId: interaction.guildId,
    messageId: prompt.messageId,
    userId,
    operation: isJoin ? "add" : "remove",
  });
  if (!updatedPrompt) {
    await interaction.reply({
      content: "この募集はすでに更新されています。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const nextMemberIds = normalizeCallWaitMemberIds(updatedPrompt.callWaitPrompt?.memberIds);
  const nextTargetAt = new Date(updatedPrompt.callWaitPrompt?.targetAt ?? prompt.targetAt);

  // Keep the public募集 message and its count in sync with the atomically
  // updated participant list. Fetch settings again so a concurrent click is
  // reflected whenever possible.
  const latestSettings = await getGuildSettings(interaction.guildId);
  const latestPrompt = latestSettings?.callWaitPrompt;
  const promptForDisplay = latestPrompt?.messageId === prompt.messageId
    ? latestPrompt
    : latestPrompt
      ? null
      : updatedPrompt.callWaitPrompt;
  const displayedMemberIds = normalizeCallWaitMemberIds(promptForDisplay?.memberIds ?? nextMemberIds);
  const displayedTargetAt = new Date(promptForDisplay?.targetAt ?? nextTargetAt);
  if (
    promptForDisplay?.messageId === prompt.messageId &&
    interaction.message &&
    typeof interaction.message.edit === "function"
  ) {
    await interaction.message.edit({
      content: formatCallWaitPrompt(displayedTargetAt, CALL_WAIT_MODE_BUTTON, displayedMemberIds),
      components: [createCallWaitJoinRow(displayedTargetAt)],
    }).catch((error) => {
      console.error(`Failed to update call wait prompt message: ${error.message}`);
    });
  }

  await sendCallWaitApplicantLog({
    guild: interaction.guild,
    settings: latestSettings ?? settings,
    action: isJoin ? "join" : "cancel",
    userId,
    memberIds: displayedMemberIds,
  });

  if (isJoin) {
    await interaction.reply({
      content: "通話参加希望を受け付けました。取り消す場合は下のボタンを押してください。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.reply({
    content: "通話参加希望をキャンセルしました。",
    flags: MessageFlags.Ephemeral,
  });
}

async function sendCallWaitApplicantLog({
  guild,
  settings,
  action,
  userId = null,
  memberIds,
}) {
  const actionLabel =
    action === "join"
      ? "希望ボタンが押されました"
      : action === "cancel"
        ? "希望キャンセルボタンが押されました"
        : "希望者リストをリセットしました";
  const list = await formatCallWaitApplicantList(guild, memberIds);
  const lines = [
    `通話待機システム: ${actionLabel}`,
    `操作ユーザー: ${userId ? `<@${userId}>` : "システム"}`,
    "現在の通話希望者:",
    list,
  ];

  await sendOperationalLog({
    guild,
    settings,
    fallbackChannel: null,
    content: lines.join("\n"),
    allowedMentions: { parse: [] },
  });
}

async function formatCallWaitApplicantList(guild, memberIds) {
  const uniqueMemberIds = normalizeCallWaitMemberIds(memberIds);

  if (uniqueMemberIds.length === 0) {
    return "なし";
  }

  const lines = [];

  for (const memberId of uniqueMemberIds) {
    const member = await guild.members.fetch(memberId).catch(() => null);
    lines.push(member ? `- ${member.displayName} (${member.id})` : `- ${memberId}`);
  }

  return lines.join("\n");
}

async function grantCallWaitRoleAndQueueNotice({ guild, settings, memberIds }) {
  const uniqueMemberIds = [...new Set(memberIds)].filter(Boolean);

  if (uniqueMemberIds.length < CALL_WAIT_MIN_MEMBERS) {
    return false;
  }

  const channel = await resolveConfiguredTextChannel(
    guild,
    getCallWaitNoticeChannelId(settings),
  );

  if (!channel || !settings.callWaitRoleId) {
    return false;
  }

  const newlyAddedMemberIds = [];
  const eligibleMemberIds = [];

  for (const memberId of uniqueMemberIds) {
    const member = await guild.members.fetch(memberId).catch(() => null);

    if (!member || member.user?.bot) {
      continue;
    }

    eligibleMemberIds.push(member.id);

    if (member.roles.cache.has(settings.callWaitRoleId)) {
      continue;
    }

    await member.roles.add(
      settings.callWaitRoleId,
      "通話待機システムの集合通知",
    ).then(() => {
      newlyAddedMemberIds.push(member.id);
    }).catch((error) => {
      console.error(`Failed to add call wait role to ${member.id}: ${error.message}`);
    });
  }

  if (eligibleMemberIds.length < CALL_WAIT_MIN_MEMBERS) {
    return false;
  }

  const nextSettings = await saveGuildSettingsWithCurrent(guild.id, settings, {
    callWaitPendingNotice: {
      memberIds: eligibleMemberIds,
      createdAt: new Date().toISOString(),
    },
  });

  if (newlyAddedMemberIds.length > 0) {
    try {
      await scheduleCallWaitRoleRemoval({
        guild,
        roleId: settings.callWaitRoleId,
        memberIds: newlyAddedMemberIds,
      });
    } catch (error) {
      // Do not leave temporary roles behind when their persistent removal
      // schedule could not be written.
      await removeCallWaitRoleFromMembers(guild, settings.callWaitRoleId, newlyAddedMemberIds).catch(() => {});
      throw error;
    }
  }

  await maybeSendPendingCallWaitStartNotice(guild, nextSettings);

  return true;
}

async function maybeSendPendingCallWaitStartNotice(guild, settings) {
  const pendingNotice = settings?.callWaitPendingNotice;

  if (
    settings?.callWaitEnabled !== true ||
    !pendingNotice ||
    !settings.callWaitRoleId
  ) {
    return false;
  }

  const activeVoiceMemberIds = getCallWaitActiveVoiceMemberIds(
    guild,
    settings.callWaitVoiceCategoryId,
  );

  if (activeVoiceMemberIds.length < CALL_WAIT_MIN_MEMBERS) {
    return false;
  }

  const channel = await resolveConfiguredTextChannel(
    guild,
    getCallWaitNoticeChannelId(settings),
  );

  if (!channel) {
    return false;
  }

  await channel.send({
    content: `<@&${settings.callWaitRoleId}> 雑談希望者が複数人集まりました！VCへの参加お願いします！`,
    allowedMentions: { roles: [settings.callWaitRoleId] },
  });

  await sendCallWaitBosyuNotice(guild, settings, channel);

  await saveGuildSettingsWithCurrent(guild.id, settings, {
    callWaitPendingNotice: null,
  });

  return true;
}

async function sendCallWaitBosyuNotice(guild, settings, fallbackChannel) {
  if (settings.callWaitBosyuNoticeEnabled !== true || !settings.bosyuMentionRoleId) {
    return;
  }

  const channel =
    (await resolveConfiguredTextChannel(guild, getCallWaitNoticeChannelId(settings))) ??
    fallbackChannel;

  if (!channel || typeof channel.send !== "function") {
    return;
  }

  await channel.send({
    content: `<@&${settings.bosyuMentionRoleId}> VCが始まりました！お暇ならぜひ途中参加してみてください！`,
    allowedMentions: { roles: [settings.bosyuMentionRoleId] },
  }).catch((error) => {
    console.error(`Failed to send call wait bosyu notice: ${error.message}`);
  });
}

async function sendOteboBosyuFollowupNotice(guild, settings) {
  if (settings.callWaitBosyuNoticeEnabled !== true || !settings.bosyuMentionRoleId) {
    return;
  }

  const channel = await resolveConfiguredTextChannel(
    guild,
    getCallWaitNoticeChannelId(settings),
  );

  if (!channel || typeof channel.send !== "function") {
    return;
  }

  await channel.send({
    content: `<@&${settings.bosyuMentionRoleId}> 雑談が始まりました！ぜひ途中参加してみてください！`,
    allowedMentions: { roles: [settings.bosyuMentionRoleId] },
  }).catch((error) => {
    console.error(`Failed to send otebo bosyu follow-up notice: ${error.message}`);
  });
}

function createCallWaitJoinRow(targetAt) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(CALL_WAIT_JOIN_CUSTOM_ID)
      .setLabel(`${formatJstHourNumber(targetAt)}時から雑談希望`)
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(CALL_WAIT_CANCEL_CUSTOM_ID)
      .setLabel("参加をキャンセル")
      .setStyle(ButtonStyle.Secondary),
  );
}

function normalizeCallWaitMode(mode) {
  return mode === CALL_WAIT_MODE_REACTION
    ? CALL_WAIT_MODE_REACTION
    : CALL_WAIT_MODE_BUTTON;
}

function normalizeCallWaitMemberIds(memberIds) {
  return Array.isArray(memberIds)
    ? [...new Set(memberIds.filter((memberId) => typeof memberId === "string"))]
    : [];
}

function getCallWaitPromptChannelId(settings) {
  return settings?.callWaitPromptChannelId ?? settings?.callWaitChannelId ?? null;
}

function getCallWaitNoticeChannelId(settings) {
  return settings?.callWaitNoticeChannelId ?? settings?.callWaitChannelId ?? null;
}

async function scheduleCallWaitRoleRemoval({ guild, roleId, memberIds }) {
  const normalizedIds = normalizeCallWaitMemberIds(memberIds);
  const actionKey = `callwait-role-remove:${guild.id}:${createSessionId()}`;
  await schedulePersistentRoleRemoval({
    actionKey,
    type: "callwait_role_remove",
    guild,
    roleId,
    memberIds: normalizedIds,
    delayMs: CALL_WAIT_ROLE_REMOVE_MS,
    timers: callWaitRoleRemovalTimers,
  });
}

async function schedulePersistentRoleRemoval({ actionKey, type, guild, roleId, memberIds, delayMs, timers, payload }) {
  const executeAt = new Date(Date.now() + delayMs);
  await scheduleAction({ actionKey, guildId: guild.id, type, executeAt, roleId, memberIds, payload: payload ?? {} });
  const previous = timers.get(actionKey);
  if (previous) clearTimeout(previous);
  const timer = setTimeout(() => {
    timers.delete(actionKey);
    void executeScheduledRoleRemoval({ actionKey, guild, roleId, memberIds, type, payload }).catch((error) => {
      console.error(`Failed to execute ${type}: ${error.message}`);
    });
  }, Math.max(0, executeAt.getTime() - Date.now()));
  timers.set(actionKey, timer);
}

async function scheduleWaitingVcCleanup({ actionKey, guild, channelId, delayMs, sessionId }) {
  const executeAt = new Date(Date.now() + delayMs);
  await scheduleAction({ actionKey, guildId: guild.id, type: "split_waiting_vc_cleanup", executeAt, payload: { channelId, sessionId } });
  const timer = setTimeout(() => {
    void executeWaitingVcCleanup({ actionKey, guild, channelId, sessionId }).catch((error) => {
      console.error(`Failed to clean up waiting VC: ${error.message}`);
    });
  }, Math.max(0, executeAt.getTime() - Date.now()));
  const previous = callWaitRoleRemovalTimers.get(actionKey);
  if (previous) clearTimeout(previous);
  callWaitRoleRemovalTimers.set(actionKey, timer);
}

async function executeWaitingVcCleanup({ actionKey, guild, channelId, sessionId }) {
  const claimed = await claimAction(actionKey);
  if (!claimed) return;
  try {
    const channel = await guild.channels.fetch(channelId).catch((error) => {
      if (error?.code === 10003) return null;
      throw error;
    });
    if (channel) await channel.delete().catch((error) => {
      if (error?.code !== 10003) throw error;
    });
    if (sessionId) await SplitProcessSession.updateOne({ sessionId }, { $set: { waitingVcCleanupCompleted: true } });
    await finishAction(actionKey);
  } catch (error) {
    await failAction(actionKey, error.message).catch(() => {});
    throw error;
  }
}

async function executeScheduledRoleRemoval({ actionKey, guild, roleId, memberIds, payload }) {
  const claimed = await claimAction(actionKey);
  if (!claimed) return;
  try {
    const session = payload?.sessionId
      ? await SplitProcessSession.findOne({ sessionId: payload.sessionId }).lean()
      : null;
    const targetMemberIds = session?.participantMemberIds ?? memberIds;

    await removeCallWaitRoleFromMembers(guild, roleId, targetMemberIds);

    if (payload?.sessionId) {
      const settings = await getGuildSettings(guild.id);

      if (session) {
        await sendSplitClosingThanks(
          guild,
          settings,
          session.participantMemberIds,
        );
      }

      await SplitProcessSession.updateOne(
        { sessionId: payload.sessionId },
        {
          $set: {
            roleRemovalCompleted: true,
            phase: "completed",
            status: "completed",
            completedAt: new Date(),
          },
        },
      );
    }
    await finishAction(actionKey);
  } catch (error) {
    await failAction(actionKey, error.message).catch(() => {});
    throw error;
  }
}

async function executeSplitFinishNotice({ actionKey, guild, payload }) {
  const claimed = await claimAction(actionKey);
  if (!claimed) return;
  try {
    const session = await SplitProcessSession.findOne({ sessionId: payload?.sessionId }).lean();
    if (!session?.finishNoticeSent) {
      const channel = await guild.channels.fetch(payload?.channelId ?? session?.operationChannelId).catch(() => null);
      if (channel?.send) {
        await channel.send({
          content: `<@&${session.participantRoleId}> ${payload?.finishMessage ?? session.finishMessage ?? ""}`,
          allowedMentions: { roles: session.participantRoleId ? [session.participantRoleId] : [] },
        });
      }
      await SplitProcessSession.updateOne({ sessionId: payload?.sessionId }, { $set: { finishNoticeSent: true, phase: "role_remove_pending" } });
    }
    await finishAction(actionKey);
  } catch (error) {
    await failAction(actionKey, error.message).catch(() => {});
    throw error;
  }
}

async function restoreScheduledActions() {
  const recovery = await recoverInterruptedActions();
  const actions = await getPendingActions();
  let restored = 0;
  for (const action of actions) {
    const guild = client.guilds.cache.get(action.guildId) ?? await client.guilds.fetch(action.guildId).catch(() => null);
    if (!guild) {
      await failAction(action.actionKey, "Guild not found").catch(() => {});
      continue;
    }
    if (action.type === "split_waiting_vc_cleanup") {
      const timer = setTimeout(() => {
        void executeWaitingVcCleanup({ actionKey: action.actionKey, guild, channelId: action.payload?.channelId, sessionId: action.payload?.sessionId }).catch((error) => {
          console.error(`Failed to restore waiting VC cleanup ${action.actionKey}: ${error.message}`);
        });
      }, Math.max(0, new Date(action.executeAt).getTime() - Date.now()));
      callWaitRoleRemovalTimers.set(action.actionKey, timer);
      restored += 1;
      continue;
    }
    if (action.type === "split_finish_notice") {
      const timer = setTimeout(() => {
        void executeSplitFinishNotice({ actionKey: action.actionKey, guild, payload: action.payload }).catch((error) => {
          console.error(`Failed to restore split finish notice ${action.actionKey}: ${error.message}`);
        });
      }, Math.max(0, new Date(action.executeAt).getTime() - Date.now()));
      callWaitRoleRemovalTimers.set(action.actionKey, timer);
      restored += 1;
      continue;
    }
    if (action.type === "callwait_followup") {
      const timer = setTimeout(() => {
        void executeCallWaitFollowup({ actionKey: action.actionKey, guild }).catch((error) => {
          console.error(`Failed to restore call-wait follow-up ${action.actionKey}: ${error.message}`);
        });
      }, Math.max(0, new Date(action.executeAt).getTime() - Date.now()));
      callWaitFollowupTimers.set(action.actionKey, timer);
      restored += 1;
      continue;
    }
    const timers = action.type === "otebo_role_remove" ? oteboRecruitmentTimers : callWaitRoleRemovalTimers;
    const timer = setTimeout(() => {
      timers.delete(action.actionKey);
      void executeScheduledRoleRemoval({ actionKey: action.actionKey, guild, roleId: action.roleId, memberIds: action.memberIds, payload: action.payload }).catch((error) => {
        console.error(`Failed to restore scheduled action ${action.actionKey}: ${error.message}`);
      });
    }, Math.max(0, new Date(action.executeAt).getTime() - Date.now()));
    timers.set(action.actionKey, timer);
    restored += 1;
  }
  console.log(`Startup scheduled actions restored: ${restored}; interrupted actions recovered: ${recovery.modifiedCount}`);
}

async function restoreBosyuEditSessions() {
  const expiredSessions = await getExpiredBosyuEditSessions();
  for (const session of expiredSessions) {
    await invalidateBosyuEditMessage(session).catch((error) => {
      console.error(`Failed to invalidate expired /bosyu edit ${session.messageId}: ${error.message}`);
    });
    await deleteBosyuEditSession(session.messageId).catch(() => {});
  }
  const sessions = await getActiveBosyuEditSessions();
  let restored = 0;
  for (const session of sessions) {
    bosyuEditSessions.set(session.messageId, {
      ownerId: session.ownerId,
      expiresAt: new Date(session.expiresAt).getTime(),
      bosyuMentionRoleId: session.bosyuMentionRoleId,
      anonymous: session.anonymous,
      voiceChannelId: session.voiceChannelId,
    });
    restored += 1;
    scheduleBosyuEditExpiry(session.messageId, session.channelId, new Date(session.expiresAt).getTime());
  }
  console.log(`Startup bosyu edit sessions restored: ${restored}`);
}

async function invalidateBosyuEditMessage(session) {
  const channel = await client.channels.fetch(session.channelId).catch(() => null);
  const message = channel?.messages?.fetch ? await channel.messages.fetch(session.messageId).catch(() => null) : null;
  await message?.edit({ components: [] }).catch(() => {});
}

function scheduleBosyuEditExpiry(messageId, channelId, expiresAt) {
  setTimeout(async () => {
    bosyuEditSessions.delete(messageId);
    const channel = await client.channels.fetch(channelId).catch(() => null);
    const message = channel?.messages?.fetch ? await channel.messages.fetch(messageId).catch(() => null) : null;
    await message?.edit({ components: [] }).catch(() => {});
    await deleteBosyuEditSession(messageId).catch((error) => {
      console.error(`Failed to delete expired /bosyu edit session ${messageId}: ${error.message}`);
    });
  }, Math.max(0, expiresAt - Date.now()));
}

async function persistSplitProcessSession(sessionId, patch) {
  if (!sessionId) return null;
  if (mongoose.connection.readyState !== 1) {
    throw new Error("MongoDB is unavailable; split process state was not persisted.");
  }
  return SplitProcessSession.findOneAndUpdate(
    { sessionId },
    { $set: patch, $setOnInsert: { sessionId, guildId: patch.guildId } },
    { upsert: true, new: true, setDefaultsOnInsert: true, lean: true },
  );
}

async function restoreSplitProcessSessions() {
  if (mongoose.connection.readyState !== 1) return;
  const sessions = await SplitProcessSession.find({ status: { $in: ["active", "finish_notice_pending", "role_remove_pending", "cleaning_up"] } }).lean();
  let restored = 0;
  for (const session of sessions) {
    const guild = client.guilds.cache.get(session.guildId) ?? await client.guilds.fetch(session.guildId).catch(() => null);
    if (!guild) continue;
    if (session.phase === "transfer_waiting" && !(session.childChannelIds?.length)) {
      await SplitProcessSession.updateOne(
        { sessionId: session.sessionId, status: "active" },
        { $set: { status: "canceled", phase: "canceled", lastError: "Bot restarted before transfer completed" } },
      );
      continue;
    }
    const roleRemoveAt = session.roleRemoveAt ? new Date(session.roleRemoveAt).getTime() : Date.now();
    const roleId = session.participantRoleId;
    const memberIds = session.participantMemberIds ?? [];
    if (roleId && memberIds.length) {
      await schedulePersistentRoleRemoval({
        actionKey: `split-role-remove:${session.sessionId}`,
        type: "split_role_remove",
        guild,
        roleId,
        memberIds,
        delayMs: Math.max(0, roleRemoveAt - Date.now()),
        timers: callWaitRoleRemovalTimers,
        payload: { sessionId: session.sessionId },
      }).catch((error) => console.error(`Failed to restore split role removal: ${error.message}`));
    }
    restored += 1;
  }
  console.log(`Startup split sessions restored: ${restored}`);
}

async function scheduleCallWaitFollowupCheck(guild) {
  const actionKey = `callwait-followup:${guild.id}:${createSessionId()}`;
  const existingTimer = callWaitFollowupTimers.get(actionKey);

  if (existingTimer) {
    clearTimeout(existingTimer);
  }

  const executeAt = new Date(Date.now() + CALL_WAIT_FOLLOWUP_CHECK_MS);
  await scheduleAction({
    actionKey,
    guildId: guild.id,
    type: "callwait_followup",
    executeAt,
  });
  const timer = setTimeout(() => {
    callWaitFollowupTimers.delete(actionKey);
    void executeCallWaitFollowup({ actionKey, guild }).catch((error) => {
      console.error(`Failed to run call wait follow-up check: ${error.message}`, error);
    });
  }, Math.max(0, executeAt.getTime() - Date.now()));

  callWaitFollowupTimers.set(actionKey, timer);
}

async function executeCallWaitFollowup({ actionKey, guild }) {
  const claimed = await claimAction(actionKey);
  if (!claimed) return;
  try {
    await runCallWaitFollowupCheck(guild.id);
    await finishAction(actionKey);
  } catch (error) {
    await failAction(actionKey, error.message).catch(() => {});
    throw error;
  }
}

async function runCallWaitFollowupCheck(guildId) {
  const guild =
    client.guilds.cache.get(guildId) ??
    (await client.guilds.fetch(guildId).catch(() => null));

  if (!guild) {
    return;
  }

  const settings = await getGuildSettings(guild.id);

  if (settings?.callWaitEnabled !== true || settings.callWaitPrompt) {
    return;
  }

  if (await maybeSendPendingCallWaitStartNotice(guild, settings)) {
    return;
  }

  // 希望者確認の30分後に行う再確認からも、停止時間中は募集を作らない。
  if (isKokuchiCallWaitPause(settings, new Date())) {
    return;
  }

  const activeVoiceMemberIds = getCallWaitActiveVoiceMemberIds(
    guild,
    settings.callWaitVoiceCategoryId,
  );

  if (activeVoiceMemberIds.length >= CALL_WAIT_MIN_MEMBERS) {
    const promptChannel = await resolveConfiguredTextChannel(
      guild,
      getCallWaitPromptChannelId(settings),
    );

    if (promptChannel) {
      await sendCallWaitSkippedNotice({
        guild,
        settings,
        channel: promptChannel,
        now: new Date(),
      });
    }

    return;
  }

  await sendCallWaitPromptForGuild(guild, settings, {
    force: false,
    now: new Date(),
  });
}

async function sendCallWaitSkippedNotice({ guild, settings, channel, now }) {
  if (settings?.callWaitSkippedNotice) {
    await deleteCallWaitMessage(guild, settings.callWaitSkippedNotice);
    settings = await saveGuildSettingsWithCurrent(guild.id, settings, {
      callWaitSkippedNotice: null,
    });
  }

  const message = await channel.send({
    content: `複数人が雑談中なので${formatJstHourNumber(getNextHourStart(now))}時の募集は出ません`,
    allowedMentions: { parse: [] },
  }).catch((error) => {
    console.error(`Failed to send skipped call wait notice: ${error.message}`);
    return null;
  });

  if (!message) {
    return settings;
  }

  return saveGuildSettingsWithCurrent(guild.id, settings, {
    callWaitSkippedNotice: {
      channelId: channel.id,
      messageId: message.id,
    },
  });
}

async function removeCallWaitRoleFromMembers(guild, roleId, memberIds) {
  const errors = [];
  for (const memberId of memberIds) {
    const member = await guild.members.fetch(memberId).catch(() => null);

    if (!member || !member.roles.cache.has(roleId)) {
      continue;
    }

    await member.roles.remove(
      roleId,
      "通話待機システムの30分経過による自動解除",
    ).catch((error) => {
      console.error(`Failed to remove call wait role from ${member.id}: ${error.message}`);
      errors.push(error);
    });
  }
  if (errors.length) throw new AggregateError(errors, "Failed to remove one or more call-wait roles.");
}

function getCallWaitActiveVoiceMemberIds(guild, categoryId) {
  if (!categoryId) {
    return [];
  }

  const memberIds = new Set();
  const voiceTypes = new Set([ChannelType.GuildVoice, ChannelType.GuildStageVoice]);

  for (const channel of guild.channels.cache.values()) {
    if (!voiceTypes.has(channel.type) || channel.parentId !== categoryId) {
      continue;
    }

    for (const member of channel.members.values()) {
      if (!member.user?.bot) {
        memberIds.add(member.id);
      }
    }
  }

  return [...memberIds];
}

function formatCallWaitPrompt(targetAt, mode = CALL_WAIT_MODE_BUTTON, memberIds = []) {
  const targetHour = formatJstHour(targetAt);

  if (mode === CALL_WAIT_MODE_BUTTON) {
    return [
      "【定時募集】",
      `${formatJstHourNumber(targetAt)}時から雑談したい方は、下のボタンを押してください。`,
      `${targetHour}時点で複数人が集まっていたらメンションでお知らせします！`,
      "",
      `現在の参加予定者数：${normalizeCallWaitMemberIds(memberIds).length}人`,
    ].join("\n");
  }

  return [
    `${targetHour}から雑談したい方はリアクション ${CALL_WAIT_REACTION} を押してください。`,
    `複数人希望者が集まったら${targetHour}に参加希望者ロールを付与します。`,
    "VCに2人以上集まったら、メンションでお知らせします。",
    "もちろん普通の募集もしてOKです",
  ].join("\n");
}

function getMsUntilNextHour(date) {
  const next = getNextHourStart(date);
  return Math.max(1000, next.getTime() - date.getTime());
}

function getNextHourStart(date) {
  const next = new Date(date);
  next.setUTCMinutes(0, 0, 0);
  next.setUTCHours(next.getUTCHours() + 1);
  return next;
}

function formatJstHour(date) {
  const jstDate = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  return `${String(jstDate.getUTCHours()).padStart(2, "0")}:00`;
}

function formatJstHourNumber(date) {
  const jstDate = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  return String(jstDate.getUTCHours());
}

function formatJstTime(date) {
  const jstDate = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  return `${String(jstDate.getUTCHours()).padStart(2, "0")}:${String(
    jstDate.getUTCMinutes(),
  ).padStart(2, "0")}`;
}

function createOteboCreateRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(OTEBO_CREATE_CUSTOM_ID)
      .setLabel("募集作成")
      .setStyle(ButtonStyle.Primary),
  );
}

function createOteboDraftRows(draft) {
  const timeOptions = createOteboTimeOptions(new Date());
  let selectedTargetAt = draft.targetAt;
  const selectedType =
    draft.type === OTEBO_TYPE_IMMEDIATE ? OTEBO_TYPE_IMMEDIATE : OTEBO_TYPE_SCHEDULED;
  const selectedDuration = normalizeOteboDuration(draft.duration);
  const selectedMention = draft.mentionBosyu === true ? "yes" : "no";

  if (!timeOptions.some((option) => option.value === selectedTargetAt)) {
    selectedTargetAt = timeOptions.defaultTargetAt.toISOString();
    draft.targetAt = selectedTargetAt;
  }

  return [
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`${OTEBO_DRAFT_SELECT_CUSTOM_ID}:type`)
        .setPlaceholder("募集タイプ")
        .addOptions(
          {
            label:
              selectedType === OTEBO_TYPE_SCHEDULED
                ? "募集タイプ：指定した時間になったら"
                : "指定した時間になったら",
            value: OTEBO_TYPE_SCHEDULED,
            default: selectedType === OTEBO_TYPE_SCHEDULED,
          },
          {
            label:
              selectedType === OTEBO_TYPE_IMMEDIATE
                ? "募集タイプ：人が集まったらすぐ"
                : "人が集まったらすぐ",
            value: OTEBO_TYPE_IMMEDIATE,
            default: selectedType === OTEBO_TYPE_IMMEDIATE,
          },
        ),
    ),
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`${OTEBO_DRAFT_SELECT_CUSTOM_ID}:target_at`)
        .setPlaceholder("メンション・掲載終了時刻")
        .addOptions(
          timeOptions.map((option) => ({
            label:
              option.value === selectedTargetAt
                ? `メンション・掲載終了時刻：${option.label}`
                : option.label,
            value: option.value,
            default: option.value === selectedTargetAt,
          })),
        ),
    ),
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`${OTEBO_DRAFT_SELECT_CUSTOM_ID}:duration`)
        .setPlaceholder("通話時間")
        .addOptions(
          {
            label:
              selectedDuration === OTEBO_DURATION_NONE
                ? "通話時間：設定しない"
                : "設定しない",
            value: OTEBO_DURATION_NONE,
            default: selectedDuration === OTEBO_DURATION_NONE,
          },
          {
            label:
              selectedDuration === OTEBO_DURATION_30
                ? "通話時間：30分間だけ"
                : "30分間だけ",
            value: OTEBO_DURATION_30,
            default: selectedDuration === OTEBO_DURATION_30,
          },
          {
            label:
              selectedDuration === OTEBO_DURATION_60
                ? "通話時間：1時間だけ"
                : "1時間だけ",
            value: OTEBO_DURATION_60,
            default: selectedDuration === OTEBO_DURATION_60,
          },
        ),
    ),
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`${OTEBO_DRAFT_SELECT_CUSTOM_ID}:mention`)
        .setPlaceholder("@通話へのメンション")
        .addOptions(
          {
            label:
              selectedMention === "no"
                ? "@通話へのメンション：しない"
                : "しない",
            value: "no",
            default: selectedMention === "no",
          },
          {
            label:
              selectedMention === "yes"
                ? "@通話へのメンション：する"
                : "する",
            value: "yes",
            default: selectedMention === "yes",
          },
        ),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(OTEBO_DRAFT_NOTE_CUSTOM_ID)
        .setLabel("ひとこと入力して送信")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(OTEBO_DRAFT_SUBMIT_CUSTOM_ID)
        .setLabel("ひとことなしで送信")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(OTEBO_DRAFT_CANCEL_CUSTOM_ID)
        .setLabel("キャンセル")
        .setStyle(ButtonStyle.Danger),
    ),
  ];
}

function createOteboTimeOptions(now) {
  const first = getNextQuarterHourStart(now);
  const defaultTargetAt = new Date(first.getTime() + 60 * 60 * 1000);
  const options = [];

  for (let offsetMinutes = 0; offsetMinutes <= 120; offsetMinutes += 15) {
    const targetAt = new Date(first.getTime() + minutesToMs(offsetMinutes));
    options.push({
      label: formatJstTime(targetAt),
      value: targetAt.toISOString(),
    });
  }

  options.defaultTargetAt = defaultTargetAt;
  return options;
}

function getNextQuarterHourStart(date) {
  const quarterMs = 15 * 60 * 1000;
  const jstOffsetMs = 9 * 60 * 60 * 1000;
  const shifted = date.getTime() + jstOffsetMs;
  const remainder = shifted % quarterMs;
  const nextShifted = remainder === 0
    ? shifted + quarterMs
    : shifted + (quarterMs - remainder);

  return new Date(nextShifted - jstOffsetMs);
}

function createDefaultOteboDraft(guildId, userId) {
  const timeOptions = createOteboTimeOptions(new Date());

  return {
    guildId,
    userId,
    type: OTEBO_TYPE_SCHEDULED,
    targetAt: timeOptions.defaultTargetAt.toISOString(),
    duration: OTEBO_DURATION_NONE,
    mentionBosyu: true,
    createdAt: new Date().toISOString(),
  };
}

function formatOteboDraftContent(draft) {
  const targetAt = new Date(draft.targetAt);
  const typeLabel =
    draft.type === OTEBO_TYPE_IMMEDIATE
      ? "人が集まったらすぐ"
      : "指定した時間になったら";
  const durationLabel = getOteboDurationLabel(draft.duration, "設定なし");
  const mentionLabel = draft.mentionBosyu ? "する" : "しない";

  return [
    "お手軽募集の内容を選択してください。",
    "",
    `募集タイプ: ${typeLabel}`,
    `メンション・掲載終了時刻: ${Number.isFinite(targetAt.getTime()) ? formatJstTime(targetAt) : "未選択"}`,
    `通話時間: ${durationLabel}`,
    `@通話へのメンション: ${mentionLabel}`,
    "",
    "ひとことを入れる場合は「ひとこと入力して送信」を押してください。",
  ].join("\n");
}

function formatOteboOwnerCancelMessage() {
  return [
    "お手軽募集を使用していただきありがとうございます！",
    "キャンセルは募集メッセージ下のキャンセルボタンから行えます。",
  ].join("\n");
}

async function updateOteboDraftMenuAfterModal(draftMenu) {
  if (!draftMenu?.applicationId || !draftMenu?.token || !draftMenu?.messageId) {
    return;
  }

  await client.rest.patch(
    Routes.webhookMessage(
      draftMenu.applicationId,
      draftMenu.token,
      draftMenu.messageId,
    ),
    {
      body: {
        content: formatOteboOwnerCancelMessage(),
        components: [],
        allowed_mentions: { parse: [] },
      },
    },
  ).catch(() => null);
}

function createOteboJoinRow(recruitment) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${OTEBO_JOIN_CUSTOM_ID}:${recruitment.id}`)
      .setLabel(recruitment.type === OTEBO_TYPE_IMMEDIATE ? "参加希望" : "参加を予定")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`${OTEBO_MEMBER_CANCEL_CUSTOM_ID}:${recruitment.id}`)
      .setLabel("参加をキャンセル")
      .setStyle(ButtonStyle.Secondary),
  );
}

function createOteboMemberCancelRow(recruitmentId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${OTEBO_MEMBER_CANCEL_CUSTOM_ID}:${recruitmentId}`)
      .setLabel("参加をキャンセル")
      .setStyle(ButtonStyle.Danger),
  );
}

function createOteboOwnerCancelConfirmRow(recruitmentId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${OTEBO_OWNER_CANCEL_CONFIRM_CUSTOM_ID}:${recruitmentId}`)
      .setLabel("キャンセル")
      .setStyle(ButtonStyle.Danger),
  );
}

function formatOteboRecruitmentMessage(recruitment, settings) {
  const targetAt = new Date(recruitment.targetAt);
  const time = formatJstTime(targetAt);
  const mention =
    shouldMentionBosyuInOteboRecruitment(recruitment, settings)
      ? `<@&${settings.bosyuMentionRoleId}>`
      : "";
  const note = normalizeOteboNote(recruitment.note);
  const noteLine = note ? `ひとこと：${sanitizeDiscordMentions(note)}` : null;

  if (recruitment.type === OTEBO_TYPE_IMMEDIATE) {
    return [
      `【雑談募集】${mention ? ` ${mention}` : ""}`,
      `${time}まで掲載される${getOteboImmediateDurationPrefix(recruitment.duration)}雑談の募集です。`,
      "下のボタンが押されたらすぐに集合メンションされます。",
      noteLine,
    ].filter((line) => line !== null).join("\n");
  }

  return [
    `【雑談募集】${mention ? ` ${mention}` : ""}`,
    `${time}から${getOteboScheduledDurationText(recruitment.duration)}の雑談の募集です`,
    `${time}時点で2人以上の参加予定者がいたら集合メンションします。`,
    `現在の参加予定者数：${normalizeCallWaitMemberIds(recruitment.memberIds).length}人`,
    noteLine,
    "",
    "ボタンを押してからのキャンセルも可能ですのでお気軽に押してみてください！",
  ].filter((line) => line !== null).join("\n");
}

async function editOteboRecruitmentMessage(guild, settings, recruitment) {
  if (!recruitment?.channelId || !recruitment?.messageId) {
    return;
  }

  const channel = await resolveConfiguredTextChannel(guild, recruitment.channelId);

  if (!channel || typeof channel.messages?.fetch !== "function") {
    return;
  }

  const message = await channel.messages.fetch(recruitment.messageId).catch(() => null);

  if (!message) {
    return;
  }

  await message.edit({
    content: formatOteboRecruitmentMessage(recruitment, settings),
    components: [createOteboJoinRow(recruitment)],
    allowedMentions: getOteboRecruitmentAllowedMentions(recruitment, settings),
  }).catch((error) => {
    console.error(`Failed to edit otebo recruitment message: ${error.message}`);
  });
}

function getOteboRecruitmentAllowedMentions(recruitment, settings) {
  return shouldMentionBosyuInOteboRecruitment(recruitment, settings)
    ? { roles: [settings.bosyuMentionRoleId] }
    : { parse: [] };
}

function shouldMentionBosyuInOteboRecruitment(recruitment, settings) {
  return Boolean(
    recruitment?.mentionBosyu &&
      settings?.bosyuMentionRoleId &&
      (recruitment.publishedToNotice !== false ||
        recruitment.channelId === getCallWaitNoticeChannelId(settings)),
  );
}

function formatOteboStartNoticeMessage(roleId, recruitment) {
  const lines = [
    `<@&${roleId}> お手軽募集の参加予定者が集まりました！VCへの参加お願いします！`,
  ];
  const durationText = getOteboScheduledDurationText(recruitment?.duration);
  const note = normalizeOteboNote(recruitment?.note);

  if (durationText) {
    lines.push(`通話時間：${durationText}`);
  }

  if (note) {
    lines.push(`ひとこと：${sanitizeDiscordMentions(note)}`);
  }

  return lines.join("\n");
}

function getOteboScheduledDurationText(duration) {
  if (normalizeOteboDuration(duration) === OTEBO_DURATION_30) {
    return "30分間";
  }

  if (normalizeOteboDuration(duration) === OTEBO_DURATION_60) {
    return "1時間";
  }

  return "";
}

function getOteboImmediateDurationPrefix(duration) {
  if (normalizeOteboDuration(duration) === OTEBO_DURATION_30) {
    return "30分間の";
  }

  if (normalizeOteboDuration(duration) === OTEBO_DURATION_60) {
    return "1時間の";
  }

  return "";
}

function getOteboDurationLabel(duration, noneLabel) {
  if (normalizeOteboDuration(duration) === OTEBO_DURATION_30) {
    return "30分間だけ";
  }

  if (normalizeOteboDuration(duration) === OTEBO_DURATION_60) {
    return "1時間だけ";
  }

  return noneLabel;
}

function normalizeOteboDuration(duration) {
  return duration === OTEBO_DURATION_30 || duration === OTEBO_DURATION_60
    ? duration
    : OTEBO_DURATION_NONE;
}

function normalizeOteboNote(note) {
  return String(note ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
}

function sanitizeDiscordMentions(text) {
  return String(text ?? "").replace(/@/g, "@\u200b");
}

function getOteboQuickConfirmSeconds(settings, recruitment = null) {
  return getNonNegativeInteger(
    recruitment?.quickConfirmSeconds,
    getNonNegativeInteger(
      settings?.oteboQuickConfirmSeconds,
      OTEBO_DEFAULT_QUICK_CONFIRM_SECONDS,
    ),
  );
}

function getOteboDraftKey(guildId, userId) {
  return `${guildId}:${userId}`;
}

function createOteboRecruitmentId() {
  return `otebo-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

async function validateOteboSettings(guild, settings, draft) {
  if (!settings?.callWaitRoleId || !getCallWaitNoticeChannelId(settings)) {
    return {
      ok: false,
      reason: "`/setting callwait call_wait_role:ロール call_wait_notice_channel:送信先` を設定してください。",
    };
  }

  if (draft.mentionBosyu === true && !settings?.bosyuMentionRoleId) {
    return {
      ok: false,
      reason: "`@通話へのメンション` を使うには `/setting bosyu bosyu_mention_role:ロール` を設定してください。",
    };
  }

  const noticeChannel = await resolveConfiguredTextChannel(
    guild,
    getCallWaitNoticeChannelId(settings),
  );
  const previewChannel = await resolveConfiguredTextChannel(
    guild,
    settings?.oteboPreviewChannelId,
  );
  const role = await guild.roles.fetch(settings.callWaitRoleId).catch(() => null);

  if (!noticeChannel) {
    return {
      ok: false,
      reason: "お手軽募集の送信先チャンネルを取得できません。`/setting callwait call_wait_notice_channel:送信先` を確認してください。",
    };
  }

  if (!role) {
    return {
      ok: false,
      reason: "通話希望者ロールを取得できません。`/setting callwait call_wait_role:ロール` を確認してください。",
    };
  }

  return {
    ok: true,
    noticeChannel,
    previewChannel,
    role,
  };
}

function getOteboRecruitments(settings) {
  return settings?.oteboRecruitments &&
    typeof settings.oteboRecruitments === "object" &&
    !Array.isArray(settings.oteboRecruitments)
    ? settings.oteboRecruitments
    : {};
}

function getOteboRecruitment(settings, recruitmentId) {
  const recruitment = getOteboRecruitments(settings)[recruitmentId];
  return recruitment && typeof recruitment === "object" ? recruitment : null;
}

function getOteboVoiceStatusSessions(settings) {
  return settings?.oteboVoiceStatusSessions &&
    typeof settings.oteboVoiceStatusSessions === "object" &&
    !Array.isArray(settings.oteboVoiceStatusSessions)
    ? settings.oteboVoiceStatusSessions
    : {};
}

function isActiveOteboRecruitment(recruitment, messageId = null) {
  if (!recruitment || recruitment.status !== "active") {
    return false;
  }

  return !messageId || recruitment.messageId === messageId;
}

function findActiveOteboRecruitmentByOwner(settings, ownerId) {
  return Object.values(getOteboRecruitments(settings)).find(
    (recruitment) =>
      recruitment?.status === "active" &&
      recruitment.ownerId === ownerId,
  );
}

async function saveOteboRecruitmentState(guildId, currentSettings, recruitment) {
  return replaceNestedObject({
    guildId,
    path: `oteboRecruitments.${recruitment.id}`,
    value: recruitment,
  }).then(() => getGuildSettings(guildId));
}

async function deleteOteboRecruitmentState(guildId, currentSettings, recruitmentId) {
  await unsetNestedObject({ guildId, path: `oteboRecruitments.${recruitmentId}` });
  return getGuildSettings(guildId);
}

function addUniqueMemberId(memberIds, memberId) {
  return [...new Set([...normalizeCallWaitMemberIds(memberIds), memberId].filter(Boolean))];
}

function createOteboVoiceStatusSession({ recruitment, memberIds, notifiedAt, settings }) {
  const durationMinutes = getOteboDurationMinutes(recruitment.duration);
  const shouldSendBosyuNotice = shouldSendOteboBosyuFollowupNotice(
    recruitment,
    settings,
  );

  if (!durationMinutes && !shouldSendBosyuNotice) {
    return null;
  }

  return {
    id: createOteboRecruitmentId(),
    recruitmentId: recruitment.id,
    memberIds: normalizeCallWaitMemberIds(memberIds),
    duration: normalizeOteboDuration(recruitment.duration),
    durationMinutes,
    sendBosyuNotice: shouldSendBosyuNotice,
    bosyuNoticeSentAt: null,
    notifiedAt: notifiedAt.toISOString(),
    statusChannelId: null,
    statusSetAt: null,
    clearAt: null,
    createdAt: new Date().toISOString(),
  };
}

function getOteboDurationMinutes(duration) {
  if (normalizeOteboDuration(duration) === OTEBO_DURATION_30) {
    return 30;
  }

  if (normalizeOteboDuration(duration) === OTEBO_DURATION_60) {
    return 60;
  }

  return null;
}

function shouldSendOteboBosyuFollowupNotice(recruitment, settings) {
  return Boolean(
    settings?.callWaitBosyuNoticeEnabled === true &&
      settings?.bosyuMentionRoleId &&
      recruitment?.mentionBosyu !== true &&
      normalizeOteboDuration(recruitment?.duration) === OTEBO_DURATION_NONE,
  );
}

function getOteboVoiceStatusLabel(duration) {
  if (normalizeOteboDuration(duration) === OTEBO_DURATION_30) {
    return "30分";
  }

  if (normalizeOteboDuration(duration) === OTEBO_DURATION_60) {
    return "1時間";
  }

  return "";
}

async function restoreOteboRecruitmentTimers() {
  for (const guild of client.guilds.cache.values()) {
    const settings = await getGuildSettings(guild.id);

    for (const recruitment of Object.values(getOteboRecruitments(settings))) {
      if (recruitment?.status === "active") {
        scheduleOteboRecruitmentTimers(guild, recruitment);
      }
    }

    for (const session of Object.values(getOteboVoiceStatusSessions(settings))) {
      if (session?.statusChannelId) {
        scheduleOteboVoiceStatusClear(guild, session);
      } else {
        scheduleOteboVoiceStatusDeadline(guild, session);
      }
    }

    await processOteboVoiceStatusSessions(guild, settings);
  }
}

function scheduleOteboRecruitmentTimers(guild, recruitment) {
  clearOteboRecruitmentTimers(guild.id, recruitment.id);

  if (shouldScheduleOteboNoticePublish(recruitment)) {
    const publishAt = getOteboNoticePublishAt(recruitment);
    const key = getOteboPublishTimerKey(guild.id, recruitment.id);
    const publishDelayMs = Math.max(1000, publishAt.getTime() - Date.now());
    const publishTimer = setTimeout(() => {
      oteboRecruitmentTimers.delete(key);
      void processOteboNoticePublish(guild.id, recruitment.id).catch((error) => {
        console.error(`Failed to publish otebo notice message: ${error.message}`, error);
      });
    }, publishDelayMs);

    oteboRecruitmentTimers.set(key, publishTimer);
  }

  const targetAt = new Date(recruitment.targetAt);
  if (Number.isFinite(targetAt.getTime())) {
    const delayMs = Math.max(1000, targetAt.getTime() - Date.now());
    const key = getOteboDeadlineTimerKey(guild.id, recruitment.id);
    const timer = setTimeout(() => {
      oteboRecruitmentTimers.delete(key);
      void processOteboDeadline(guild.id, recruitment.id).catch((error) => {
        console.error(`Failed to process otebo deadline: ${error.message}`, error);
      });
    }, delayMs);

    oteboRecruitmentTimers.set(key, timer);
  }

  for (const [memberId, expiresAt] of Object.entries(
    recruitment.pendingConfirmations ?? {},
  )) {
    scheduleOteboImmediateConfirmation(guild, recruitment, memberId, expiresAt);
  }
}

function shouldScheduleOteboNoticePublish(recruitment) {
  if (
    recruitment?.status !== "active" ||
    recruitment.type !== OTEBO_TYPE_SCHEDULED ||
    recruitment.publishedToNotice !== false
  ) {
    return false;
  }

  const publishAt = getOteboNoticePublishAt(recruitment);
  const targetAt = new Date(recruitment.targetAt);

  return (
    Number.isFinite(publishAt.getTime()) &&
    Number.isFinite(targetAt.getTime()) &&
    Date.now() < targetAt.getTime()
  );
}

function getOteboNoticePublishAt(recruitment) {
  const targetAt = new Date(recruitment?.targetAt);

  if (!Number.isFinite(targetAt.getTime())) {
    return new Date(Number.NaN);
  }

  return new Date(targetAt.getTime() - OTEBO_SCHEDULED_NOTICE_LEAD_MS);
}

async function processOteboNoticePublish(guildId, recruitmentId) {
  const guild =
    client.guilds.cache.get(guildId) ??
    (await client.guilds.fetch(guildId).catch(() => null));

  if (!guild) {
    return;
  }

  const settings = await getGuildSettings(guild.id);
  const recruitment = getOteboRecruitment(settings, recruitmentId);

  if (!shouldScheduleOteboNoticePublish(recruitment)) {
    return;
  }

  const noticeChannel = await resolveConfiguredTextChannel(
    guild,
    recruitment.noticeChannelId ?? getCallWaitNoticeChannelId(settings),
  );

  if (!noticeChannel) {
    return;
  }

  await deleteOteboRecruitmentMessage(guild, recruitment);

  const nextRecruitment = {
    ...recruitment,
    channelId: noticeChannel.id,
    messageId: null,
    noticeChannelId: noticeChannel.id,
    publishedToNotice: true,
  };
  const message = await noticeChannel.send({
    content: formatOteboRecruitmentMessage(nextRecruitment, settings),
    components: [createOteboJoinRow(nextRecruitment)],
    allowedMentions: getOteboRecruitmentAllowedMentions(nextRecruitment, settings),
  });

  nextRecruitment.messageId = message.id;

  const nextSettings = await saveOteboRecruitmentState(
    guild.id,
    settings,
    nextRecruitment,
  );

  scheduleOteboRecruitmentTimers(guild, nextRecruitment);
  await sendOteboApplicantLog({
    guild,
    settings: nextSettings,
    action: "publish",
    memberIds: normalizeCallWaitMemberIds(nextRecruitment.memberIds),
  });
}

function scheduleOteboImmediateConfirmation(
  guild,
  recruitment,
  memberId,
  expiresAtValue = null,
) {
  const expiresAt = new Date(
    expiresAtValue ??
      recruitment.pendingConfirmations?.[memberId] ??
      Date.now(),
  );
  const key = getOteboConfirmationTimerKey(guild.id, recruitment.id, memberId);
  const existingTimer = oteboRecruitmentTimers.get(key);

  if (existingTimer) {
    clearTimeout(existingTimer);
  }

  const delayMs = Number.isFinite(expiresAt.getTime())
    ? Math.max(0, expiresAt.getTime() - Date.now())
    : 0;
  const timer = setTimeout(() => {
    oteboRecruitmentTimers.delete(key);
    void processOteboImmediateConfirmation(
      guild.id,
      recruitment.id,
      memberId,
    ).catch((error) => {
      console.error(`Failed to process otebo confirmation: ${error.message}`, error);
    });
  }, delayMs);

  oteboRecruitmentTimers.set(key, timer);
}

async function processOteboImmediateConfirmation(guildId, recruitmentId, memberId) {
  const guild =
    client.guilds.cache.get(guildId) ??
    (await client.guilds.fetch(guildId).catch(() => null));

  if (!guild) {
    return;
  }

  const settings = await getGuildSettings(guild.id);
  const recruitment = getOteboRecruitment(settings, recruitmentId);

  if (
    !isActiveOteboRecruitment(recruitment) ||
    recruitment.type !== OTEBO_TYPE_IMMEDIATE ||
    !normalizeCallWaitMemberIds(recruitment.memberIds).includes(memberId)
  ) {
    return;
  }

  const expiresAt = new Date(recruitment.pendingConfirmations?.[memberId]);
  if (Number.isFinite(expiresAt.getTime()) && expiresAt.getTime() > Date.now()) {
    scheduleOteboImmediateConfirmation(guild, recruitment, memberId, expiresAt);
    return;
  }

  if (normalizeCallWaitMemberIds(recruitment.memberIds).length >= CALL_WAIT_MIN_MEMBERS) {
    await finishOteboRecruitmentSuccess({
      guild,
      settings,
      recruitment,
    });
    return;
  }

  const pendingConfirmations = { ...(recruitment.pendingConfirmations ?? {}) };
  delete pendingConfirmations[memberId];
  const nextRecruitment = {
    ...recruitment,
    pendingConfirmations,
  };
  await saveOteboRecruitmentState(guild.id, settings, nextRecruitment);
}

async function processOteboDeadline(guildId, recruitmentId) {
  const guild =
    client.guilds.cache.get(guildId) ??
    (await client.guilds.fetch(guildId).catch(() => null));

  if (!guild) {
    return;
  }

  const settings = await getGuildSettings(guild.id);
  const recruitment = getOteboRecruitment(settings, recruitmentId);

  if (!isActiveOteboRecruitment(recruitment)) {
    return;
  }

  const memberIds = normalizeCallWaitMemberIds(recruitment.memberIds);

  if (recruitment.type === OTEBO_TYPE_SCHEDULED) {
    if (memberIds.length >= CALL_WAIT_MIN_MEMBERS) {
      await finishOteboRecruitmentSuccess({
        guild,
        settings,
        recruitment,
      });
      return;
    }

    await deleteOteboRecruitmentMessage(guild, recruitment);
    const nextSettings = await deleteOteboRecruitmentState(
      guild.id,
      settings,
      recruitment.id,
    );
    clearOteboRecruitmentTimers(guild.id, recruitment.id);
    await sendOteboApplicantLog({
      guild,
      settings: nextSettings,
      action: "reset",
      memberIds: [],
    });
    return;
  }

  const pendingCount = Object.keys(recruitment.pendingConfirmations ?? {}).length;
  if (memberIds.length >= CALL_WAIT_MIN_MEMBERS && pendingCount > 0) {
    return;
  }

  await deleteOteboRecruitmentMessage(guild, recruitment);
  const nextSettings = await deleteOteboRecruitmentState(
    guild.id,
    settings,
    recruitment.id,
  );
  clearOteboRecruitmentTimers(guild.id, recruitment.id);
  await sendOteboApplicantLog({
    guild,
    settings: nextSettings,
    action: "reset",
    memberIds: [],
  });
}

async function finishOteboRecruitmentSuccess({ guild, settings, recruitment }) {
  const memberIds = normalizeCallWaitMemberIds(recruitment.memberIds);

  if (memberIds.length < CALL_WAIT_MIN_MEMBERS || !settings?.callWaitRoleId) {
    return false;
  }

  const roleMemberIds = await addTemporaryRoleToMembers({
    guild,
    roleId: settings.callWaitRoleId,
    memberIds,
    reason: "お手軽募集の集合通知",
  });

  if (roleMemberIds.length < CALL_WAIT_MIN_MEMBERS) {
    return false;
  }

  const channel = await resolveConfiguredTextChannel(
    guild,
    getCallWaitNoticeChannelId(settings),
  );
  const notifiedAt = new Date();

  if (channel) {
    await channel.send({
      content: formatOteboStartNoticeMessage(settings.callWaitRoleId, recruitment),
      allowedMentions: { roles: [settings.callWaitRoleId] },
    });
  }

  try {
    await scheduleOteboRoleRemoval({
      guild,
      roleId: settings.callWaitRoleId,
      memberIds: roleMemberIds,
      recruitmentId: recruitment.id,
    });
  } catch (error) {
    await removeTemporaryRoleFromMembers({
      guild,
      roleId: settings.callWaitRoleId,
      memberIds: roleMemberIds,
      reason: "Persistent role removal schedule failed",
    }).catch(() => {});
    throw error;
  }
  await deleteOteboRecruitmentMessage(guild, recruitment);
  const recruitments = { ...getOteboRecruitments(settings) };
  delete recruitments[recruitment.id];
  const voiceStatusSessions = { ...getOteboVoiceStatusSessions(settings) };
  const voiceStatusSession = createOteboVoiceStatusSession({
    recruitment,
    memberIds: roleMemberIds,
    notifiedAt,
    settings,
  });

  if (voiceStatusSession) {
    voiceStatusSessions[voiceStatusSession.id] = voiceStatusSession;
  }

  const nextSettings = await saveGuildSettingsWithCurrent(guild.id, settings, {
    oteboRecruitments: recruitments,
    oteboVoiceStatusSessions: voiceStatusSessions,
  });
  clearOteboRecruitmentTimers(guild.id, recruitment.id);
  await sendOteboApplicantLog({
    guild,
    settings: nextSettings,
    action: "notify",
    memberIds: roleMemberIds,
  });

  if (voiceStatusSession) {
    scheduleOteboVoiceStatusDeadline(guild, voiceStatusSession);
    await processOteboVoiceStatusSessions(guild, nextSettings);
  }

  return true;
}

async function deleteOteboRecruitmentMessage(guild, recruitment) {
  await deleteCallWaitMessage(guild, {
    channelId: recruitment.channelId,
    messageId: recruitment.messageId,
  });
}

async function addTemporaryRoleToMembers({ guild, roleId, memberIds, reason }) {
  const eligibleMemberIds = [];

  for (const memberId of normalizeCallWaitMemberIds(memberIds)) {
    const member = await guild.members.fetch(memberId).catch(() => null);

    if (!member || member.user?.bot) {
      continue;
    }

    eligibleMemberIds.push(member.id);

    if (member.roles.cache.has(roleId)) {
      continue;
    }

    await member.roles.add(roleId, reason).catch((error) => {
      console.error(`Failed to add temporary call role to ${member.id}: ${error.message}`);
    });
  }

  return eligibleMemberIds;
}

async function scheduleOteboRoleRemoval({ guild, roleId, memberIds, recruitmentId }) {
  const normalizedIds = normalizeCallWaitMemberIds(memberIds);
  const actionKey = `otebo-role-remove:${guild.id}:${recruitmentId ?? createSessionId()}:${createSessionId()}`;
  await schedulePersistentRoleRemoval({
    actionKey,
    type: "otebo_role_remove",
    guild,
    roleId,
    memberIds: normalizedIds,
    delayMs: OTEBO_ROLE_REMOVE_MS,
    timers: oteboRecruitmentTimers,
  });
  return;
  const key = getOteboRoleTimerKey(guild.id, roleId, Date.now());
  const timer = setTimeout(() => {
    oteboRecruitmentTimers.delete(key);
    void removeTemporaryRoleFromMembers({
      guild,
      roleId,
      memberIds,
      reason: "お手軽募集の20分経過による自動解除",
    }).catch((error) => {
      console.error(`Failed to remove otebo role: ${error.message}`, error);
    });
  }, OTEBO_ROLE_REMOVE_MS);

  oteboRecruitmentTimers.set(key, timer);
}

async function removeTemporaryRoleFromMembers({ guild, roleId, memberIds, reason }) {
  const errors = [];
  for (const memberId of normalizeCallWaitMemberIds(memberIds)) {
    const member = await guild.members.fetch(memberId).catch(() => null);

    if (!member || !member.roles.cache.has(roleId)) {
      continue;
    }

    await member.roles.remove(roleId, reason).catch((error) => {
      console.error(`Failed to remove temporary role from ${member.id}: ${error.message}`);
      errors.push(error);
    });
  }
  if (errors.length) throw new AggregateError(errors, "Failed to remove one or more temporary roles.");
}

async function processOteboVoiceStatusSessions(guild, settings) {
  let sessions = { ...getOteboVoiceStatusSessions(settings) };
  let changed = false;
  const now = Date.now();

  for (const session of Object.values(sessions)) {
    if (!session?.id) {
      continue;
    }

    if (session.statusChannelId) {
      const clearAt = new Date(session.clearAt);

      if (Number.isFinite(clearAt.getTime()) && clearAt.getTime() <= now) {
        await clearOteboVoiceStatusSession(guild, session);
        delete sessions[session.id];
        changed = true;
      } else {
        scheduleOteboVoiceStatusClear(guild, session);
      }

      continue;
    }

    const notifiedAt = new Date(session.notifiedAt);

    if (
      !Number.isFinite(notifiedAt.getTime()) ||
      now - notifiedAt.getTime() >= OTEBO_VOICE_STATUS_DEADLINE_MS
    ) {
      delete sessions[session.id];
      changed = true;
      continue;
    }

    const voiceChannel = findFirstOteboVoiceStatusChannel(guild, session.memberIds);

    if (!voiceChannel) {
      scheduleOteboVoiceStatusDeadline(guild, session);
      continue;
    }

    let nextSession = session;

    if (session.sendBosyuNotice && !session.bosyuNoticeSentAt) {
      await sendOteboBosyuFollowupNotice(guild, settings);
      nextSession = {
        ...nextSession,
        bosyuNoticeSentAt: new Date().toISOString(),
      };
      changed = true;
    }

    if (!session.durationMinutes) {
      delete sessions[session.id];
      changed = true;
      continue;
    }

    const statusText = `会話時間：${getOteboVoiceStatusLabel(session.duration)}(予定)`;

    await setVoiceChannelStatus(
      voiceChannel,
      statusText,
      "お手軽募集の参加予定者がVCに集まったため",
    ).then(() => {
      const statusSetAt = new Date();
      sessions[session.id] = {
        ...nextSession,
        statusChannelId: voiceChannel.id,
        statusSetAt: statusSetAt.toISOString(),
        clearAt: new Date(
          statusSetAt.getTime() +
            minutesToMs(session.durationMinutes) +
            OTEBO_VOICE_STATUS_EXTRA_MS,
        ).toISOString(),
      };
      scheduleOteboVoiceStatusClear(guild, sessions[session.id]);
      changed = true;
    }).catch((error) => {
      console.error(`Failed to set otebo voice status: ${error.message}`);
      sessions[session.id] = nextSession;
      scheduleOteboVoiceStatusDeadline(guild, session);
    });
  }

  if (!changed) {
    return settings;
  }

  return saveGuildSettingsWithCurrent(guild.id, settings, {
    oteboVoiceStatusSessions: sessions,
  });
}

function findFirstOteboVoiceStatusChannel(guild, memberIds) {
  const targetMemberIds = new Set(normalizeCallWaitMemberIds(memberIds));
  const voiceTypes = new Set([ChannelType.GuildVoice, ChannelType.GuildStageVoice]);

  for (const channel of guild.channels.cache.values()) {
    if (!voiceTypes.has(channel.type) || !channel?.isVoiceBased?.()) {
      continue;
    }

    let count = 0;

    for (const member of channel.members.values()) {
      if (!member.user?.bot && targetMemberIds.has(member.id)) {
        count += 1;
      }
    }

    if (count >= CALL_WAIT_MIN_MEMBERS) {
      return channel;
    }
  }

  return null;
}

async function clearOteboVoiceStatusSession(guild, session) {
  const channel = await guild.channels.fetch(session.statusChannelId).catch(() => null);

  if (!channel?.isVoiceBased?.()) {
    return;
  }

  await setVoiceChannelStatus(
    channel,
    "",
    "お手軽募集で設定した会話時間ステータスの自動解除",
  ).catch((error) => {
    console.error(`Failed to clear otebo voice status: ${error.message}`);
  });
}

function scheduleOteboVoiceStatusClear(guild, session) {
  const clearAt = new Date(session.clearAt);

  if (!Number.isFinite(clearAt.getTime())) {
    return;
  }

  const key = getOteboVoiceStatusTimerKey(guild.id, session.id);
  const existingTimer = oteboRecruitmentTimers.get(key);

  if (existingTimer) {
    clearTimeout(existingTimer);
  }

  const timer = setTimeout(() => {
    oteboRecruitmentTimers.delete(key);
    void processOteboVoiceStatusClear(guild.id, session.id).catch((error) => {
      console.error(`Failed to process otebo voice status clear: ${error.message}`, error);
    });
  }, Math.max(1000, clearAt.getTime() - Date.now()));

  oteboRecruitmentTimers.set(key, timer);
}

function scheduleOteboVoiceStatusDeadline(guild, session) {
  const notifiedAt = new Date(session.notifiedAt);

  if (!Number.isFinite(notifiedAt.getTime())) {
    return;
  }

  const key = getOteboVoiceStatusTimerKey(guild.id, session.id);
  const existingTimer = oteboRecruitmentTimers.get(key);

  if (existingTimer) {
    clearTimeout(existingTimer);
  }

  const deadlineAt = notifiedAt.getTime() + OTEBO_VOICE_STATUS_DEADLINE_MS;
  const timer = setTimeout(() => {
    oteboRecruitmentTimers.delete(key);
    void processOteboVoiceStatusDeadline(guild.id, session.id).catch((error) => {
      console.error(`Failed to process otebo voice status deadline: ${error.message}`, error);
    });
  }, Math.max(1000, deadlineAt - Date.now()));

  oteboRecruitmentTimers.set(key, timer);
}

async function processOteboVoiceStatusClear(guildId, sessionId) {
  const guild =
    client.guilds.cache.get(guildId) ??
    (await client.guilds.fetch(guildId).catch(() => null));

  if (!guild) {
    return;
  }

  const settings = await getGuildSettings(guild.id);
  const sessions = { ...getOteboVoiceStatusSessions(settings) };
  const session = sessions[sessionId];

  if (!session) {
    return;
  }

  await clearOteboVoiceStatusSession(guild, session);
  delete sessions[sessionId];
  await saveGuildSettingsWithCurrent(guild.id, settings, {
    oteboVoiceStatusSessions: sessions,
  });
}

async function processOteboVoiceStatusDeadline(guildId, sessionId) {
  const guild =
    client.guilds.cache.get(guildId) ??
    (await client.guilds.fetch(guildId).catch(() => null));

  if (!guild) {
    return;
  }

  const settings = await getGuildSettings(guild.id);
  const sessions = { ...getOteboVoiceStatusSessions(settings) };
  const session = sessions[sessionId];

  if (!session || session.statusChannelId) {
    return;
  }

  const notifiedAt = new Date(session.notifiedAt);

  if (
    Number.isFinite(notifiedAt.getTime()) &&
    Date.now() - notifiedAt.getTime() < OTEBO_VOICE_STATUS_DEADLINE_MS
  ) {
    scheduleOteboVoiceStatusDeadline(guild, session);
    return;
  }

  delete sessions[sessionId];
  await saveGuildSettingsWithCurrent(guild.id, settings, {
    oteboVoiceStatusSessions: sessions,
  });
}

async function sendOteboApplicantLog({
  guild,
  settings,
  action,
  userId = null,
  memberIds,
}) {
  const actionLabel =
    action === "create"
      ? "募集が作成されました"
      : action === "join"
        ? "参加希望ボタンが押されました"
        : action === "cancel"
          ? "参加キャンセルボタンが押されました"
          : action === "notify"
            ? "集合通知を送信しました"
            : action === "owner_cancel"
              ? "募集者が募集をキャンセルしました"
              : action === "publish"
                ? "募集メッセージを集合通知送信先へ移動しました"
              : "希望者リストをリセットしました";
  const list = await formatCallWaitApplicantList(guild, memberIds);

  await sendOperationalLog({
    guild,
    settings,
    fallbackChannel: null,
    content: [
      `お手軽募集システム: ${actionLabel}`,
      `操作ユーザー: ${userId ? `<@${userId}>` : "システム"}`,
      "現在の参加予定者:",
      list,
    ].join("\n"),
    allowedMentions: { parse: [] },
  });
}

function clearOteboRecruitmentTimers(guildId, recruitmentId) {
  for (const [key, timer] of oteboRecruitmentTimers.entries()) {
    if (key.startsWith(`${guildId}:${recruitmentId}:`)) {
      clearTimeout(timer);
      oteboRecruitmentTimers.delete(key);
    }
  }
}

function clearOteboConfirmationTimer(guildId, recruitmentId, memberId) {
  const key = getOteboConfirmationTimerKey(guildId, recruitmentId, memberId);
  const timer = oteboRecruitmentTimers.get(key);

  if (timer) {
    clearTimeout(timer);
    oteboRecruitmentTimers.delete(key);
  }
}

function getOteboDeadlineTimerKey(guildId, recruitmentId) {
  return `${guildId}:${recruitmentId}:deadline`;
}

function getOteboPublishTimerKey(guildId, recruitmentId) {
  return `${guildId}:${recruitmentId}:publish`;
}

function getOteboConfirmationTimerKey(guildId, recruitmentId, memberId) {
  return `${guildId}:${recruitmentId}:confirm:${memberId}`;
}

function getOteboRoleTimerKey(guildId, roleId, startedAt) {
  return `${guildId}:role:${roleId}:${startedAt}`;
}

function getOteboVoiceStatusTimerKey(guildId, sessionId) {
  return `${guildId}:voice-status:${sessionId}`;
}

function formatKokuchiMessage({ weekday, overviewChannelId, topic }) {
  const weekdayLabel = weekday === "土" ? "土曜日" : "火曜日";
  const lines = [
    `本日は${weekdayLabel}！`,
    "21:00から会話練習会です！",
    `（概要は <#${overviewChannelId}> から）`,
  ];

  if (topic?.text) {
    lines.push("", `今回の最初の話題は「${topic.text}」です！`);
  }

  lines.push(
    "",
    "ただ雑談したい方はもちろん、少しずつ会話に慣れていきたいという方にも参加していただきたいです！",
    "時間の都合が合う方はぜひご参加ください！！",
  );

  return lines.join("\n");
}

async function chooseAndStoreKokuchiWadaiTopic(guildId, settings) {
  const topics = getWadaiTopics(settings);
  const recentHistory = getWadaiRecentHistory(settings);
  const topic = chooseSingleWadaiTopic(topics, recentHistory);
  const nextSettings = await saveGuildSettingsWithCurrent(guildId, settings, {
    wadaiTopics: topics,
    wadaiTopicsVersion: 2,
    wadaiDaily: null,
    wadaiRecentHistory: recentHistory,
    wadaiCurrentTopic: topic
      ? {
          id: topic.id,
          text: topic.text,
          selectedAt: new Date().toISOString(),
        }
      : null,
  });

  return {
    settings: nextSettings,
    topic,
  };
}

async function getOrChooseCurrentWadaiTopic(guildId, settings) {
  const currentTopic = normalizeWadaiTopic(settings?.wadaiCurrentTopic, "1", 0);

  if (currentTopic) {
    return {
      settings,
      topic: currentTopic,
    };
  }

  return chooseAndStoreKokuchiWadaiTopic(guildId, settings);
}

function chooseSingleWadaiTopic(topics, recentHistory) {
  const category = "1";
  const categoryTopics = topics[category] ?? [];
  const validTopicIds = new Set(categoryTopics.map((topic) => topic.id));
  const history = (recentHistory[category] ?? []).filter((topicId) =>
    validTopicIds.has(topicId),
  );

  if (categoryTopics.length === 0) {
    recentHistory[category] = [];
    return null;
  }

  const candidates = categoryTopics.filter((topic) => !history.includes(topic.id));
  const pool = candidates.length > 0 ? candidates : categoryTopics;
  const selected = pool[Math.floor(Math.random() * pool.length)];
  recentHistory[category] =
    candidates.length > 0 ? [...history, selected.id] : [selected.id];

  return selected;
}

function formatPostSplitWadaiMessage(participantRoleId, topic, groupSummaries) {
  const lines = [
    `<@&${participantRoleId}>`,
    "今日の最初の話題：",
    `「${topic?.text ?? "未登録です。/addwadai で追加してください。"}」`,
    "",
    "話す量は一言くらいで大丈夫です！",
    "まずは以下の順番で、一人ずつ軽く話してみてください。",
    "言葉がまとまらなかったら、順番を後ろに回しても大丈夫です。",
    "",
  ];

  for (const group of groupSummaries ?? []) {
    lines.push(`【${group.channelName}】`);
    group.memberNames.forEach((memberName, index) => {
      lines.push(`${index + 1}. ${memberName}`);
    });
    lines.push("");
  }

  lines.push("ひとことずつ話した後は自由に会話してください！");

  return lines.join("\n").trim();
}

function formatSplitStartAnnouncement(waitingChannel) {
  return [
    "集合開始から5分経ったのでスタートします",
    `スタート後も10分までなら途中参加を受け付けているのでぜひ${waitingChannel}からご参加ください！`,
  ].join("\n");
}

function formatSplitStartExtendedAnnouncement(waitingChannel) {
  return `まだ途中参加可能です。ぜひ${waitingChannel}からご参加ください。`;
}

function formatSplitStartClosedAnnouncement() {
  return [
    "集合開始から５分経ったのでスタートします",
    "人数が集まったので途中参加は締め切られました。",
  ].join("\n");
}

async function editSplitStartAnnouncementExtended(message, waitingChannel) {
  if (!message) {
    return;
  }

  await editSafely(message, {
    content: formatSplitStartExtendedAnnouncement(waitingChannel),
    allowedMentions: { parse: [] },
  });
}

async function editSplitStartAnnouncementClosed(message) {
  if (!message) {
    return;
  }

  await editSafely(message, {
    content: formatSplitStartClosedAnnouncement(),
    allowedMentions: { parse: [] },
  });
}

function getWadaiTopics(settings) {
  const useSavedTopics = settings?.wadaiTopicsVersion === 2;
  const savedTopics =
    useSavedTopics && settings?.wadaiTopics && typeof settings.wadaiTopics === "object"
      ? settings.wadaiTopics
      : {};
  const topics = {};

  for (const category of Object.keys(WADAI_CATEGORIES)) {
    const hasSavedCategory = Object.prototype.hasOwnProperty.call(
      savedTopics,
      category,
    );
    const rawTopics =
      hasSavedCategory && Array.isArray(savedTopics[category])
        ? savedTopics[category]
        : getDefaultWadaiTopicsForCategory(category);

    topics[category] = rawTopics
      .map((topic, index) => normalizeWadaiTopic(topic, category, index))
      .filter(Boolean);
  }

  return topics;
}

function getDefaultWadaiTopicsForCategory(category) {
  return WADAI_CATEGORIES[category].defaults.map((text, index) => ({
    id: `default-${category}-${index + 1}`,
    text,
  }));
}

function normalizeWadaiTopic(topic, category, index) {
  const text =
    typeof topic === "string"
      ? topic
      : typeof topic?.text === "string"
        ? topic.text
        : "";
  const trimmedText = text.trim();

  if (!trimmedText) {
    return null;
  }

  const id =
    typeof topic?.id === "string" && topic.id.trim()
      ? topic.id.trim()
      : `topic-${category}-${index + 1}-${trimmedText}`;

  return {
    id,
    text: trimmedText,
  };
}

function getWadaiRecentHistory(settings) {
  const savedHistory =
    settings?.wadaiRecentHistory && typeof settings.wadaiRecentHistory === "object"
      ? settings.wadaiRecentHistory
      : {};
  const history = {};

  for (const category of Object.keys(WADAI_CATEGORIES)) {
    history[category] = Array.isArray(savedHistory[category])
      ? savedHistory[category].filter((topicId) => typeof topicId === "string")
      : [];
  }

  return history;
}

function formatWadaiList(topics) {
  const lines = [];

  for (const category of Object.keys(WADAI_CATEGORIES)) {
    lines.push(WADAI_CATEGORIES[category].heading);

    if ((topics[category] ?? []).length === 0) {
      lines.push("（未登録）");
    } else {
      topics[category].forEach((topic, index) => {
        lines.push(`${index + 1}. ${topic.text}`);
      });
    }

    lines.push("");
  }

  return lines.join("\n").trim();
}

function parseWadaiTarget(target) {
  const normalized = normalizeWadaiTarget(target);
  const plainMatch = /^(\d+)$/.exec(normalized);

  if (plainMatch) {
    return {
      category: "1",
      index: Number(plainMatch[1]),
    };
  }

  const match = /^1-(\d+)$/.exec(normalized);

  if (!match) {
    return null;
  }

  return {
    category: "1",
    index: Number(match[1]),
  };
}

function normalizeWadaiTarget(target) {
  return target
    .replace(/[０-９]/g, (char) =>
      String.fromCharCode(char.charCodeAt(0) - 0xfee0),
    )
    .replace(/[－ー―]/g, "-")
    .replace(/\s+/g, "");
}

function createWadaiTopicId(category) {
  return `custom-${category}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

async function saveGuildSettingsWithCurrent(guildId, currentSettings, patch) {
  // The store performs an atomic $set. Do not merge a stale snapshot here:
  // concurrent /setting operations must not overwrite each other.
  return saveGuildSettings(guildId, patch);
}

async function handleSetupForms(interaction) {
  if (!interaction.inGuild()) {
    await replyOrFollowUp(interaction, {
      content: "このコマンドはサーバー内で使ってください。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild)) {
    await replyOrFollowUp(interaction, {
      content: "フォームを設置するには、サーバー管理権限が必要です。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const settings = await getGuildSettings(interaction.guildId);

  if (!settings?.formChannelId || !settings?.formSendChannelId) {
    await replyOrFollowUp(interaction, {
      content: "`/setting forms form_channel:設置先 form_send_channel:転送先` を設定してください。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const formChannel = await interaction.guild.channels
    .fetch(settings.formChannelId)
    .catch(() => null);

  if (!formChannel || typeof formChannel.send !== "function") {
    await replyOrFollowUp(interaction, {
      content: "フォーム設置先チャンネルへ送信できません。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  for (const formMessage of createFeedbackFormMessages()) {
    await formChannel.send({
      content: formMessage.content,
      components: [createFeedbackFormRow(formMessage.type)],
      allowedMentions: { parse: [] },
    });
  }

  await replyOrFollowUp(interaction, {
    content: `${formChannel} にフォームを設置しました。`,
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
}

async function handleFeedbackFormButton(interaction) {
  const type = interaction.customId.slice("feedback_form_button:".length);
  const label = FEEDBACK_FORM_TYPES[type];

  if (!label) {
    await interaction.reply({
      content: "不明なフォームです。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId(`feedback_form_modal:${type}`)
    .setTitle(`${label}フォーム`)
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("feedback_form_content")
          .setLabel("内容")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(1500),
      ),
    );

  await interaction.showModal(modal);
}

async function handleFeedbackFormModal(interaction) {
  if (!interaction.inGuild()) {
    await interaction.reply({
      content: "このフォームはサーバー内で使ってください。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const type = interaction.customId.slice("feedback_form_modal:".length);
  const label = FEEDBACK_FORM_TYPES[type];

  if (!label) {
    await interaction.reply({
      content: "不明なフォームです。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const settings = await getGuildSettings(interaction.guildId);

  if (!settings?.formSendChannelId) {
    await interaction.reply({
      content: "フォーム転送先が設定されていません。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const sendChannel = await interaction.guild.channels
    .fetch(settings.formSendChannelId)
    .catch(() => null);

  if (!sendChannel || typeof sendChannel.send !== "function") {
    await interaction.reply({
      content: "フォーム転送先チャンネルへ送信できません。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const content = interaction.fields
    .getTextInputValue("feedback_form_content")
    .trim();
  const senderName = interaction.member?.displayName ?? interaction.user.tag;
  const moderatorMention =
    type === "complaint" && settings.formModeratorRoleId
      ? `<@&${settings.formModeratorRoleId}>`
      : null;

  await sendChannel.send({
    content: [
      moderatorMention,
      `送信者:${senderName}`,
      `分類:${label}`,
      `内容:${content}`,
    ].filter(Boolean).join("\n"),
    allowedMentions: moderatorMention
      ? { roles: [settings.formModeratorRoleId] }
      : { parse: [] },
  });

  await interaction.reply({
    content: "フォームを送信しました。",
    flags: MessageFlags.Ephemeral,
  });
}

function createFeedbackFormMessages() {
  return [
    {
      type: "topic",
      content: "会話練習会の最初の話題にちょうどいい話題があればぜひ！",
    },
    {
      type: "suggestion",
      content: "提案および要望があればぜひお聞かせください！",
    },
    {
      type: "complaint",
      content: "対人トラブルや、サーバーについての苦情があればこちらへ",
    },
  ];
}

function createFeedbackFormRow(type) {
  const buttonConfig = {
    topic: {
      label: "話題提供フォーム",
      style: ButtonStyle.Primary,
    },
    suggestion: {
      label: "提案・要望フォーム",
      style: ButtonStyle.Success,
    },
    complaint: {
      label: "相談・苦情フォーム",
      style: ButtonStyle.Secondary,
    },
  }[type];

  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`feedback_form_button:${type}`)
      .setLabel(buttonConfig.label)
      .setStyle(buttonConfig.style),
  );
}

async function handleDisboardBumpMessage(message) {
  if (!message.inGuild() || !isDisboardBumpMessage(message)) {
    return;
  }

  const user = message.interactionMetadata?.user ?? message.interaction?.user;

  if (!user || user.bot) {
    return;
  }

  const reminder = {
    id: message.id,
    guildId: message.guildId,
    channelId: message.channelId,
    userId: user.id,
    dueAt: new Date(Date.now() + BUMP_REMINDER_WAIT_MS).toISOString(),
    sourceMessageId: message.id,
  };

  await saveBumpReminder(reminder);
  scheduleBumpReminder(reminder);
}

function isDisboardBumpMessage(message) {
  const disboardBotId = DISBOARD_BOT_ID || DISBOARD_DEFAULT_BOT_ID;
  const commandName = message.interaction?.commandName;

  return (
    message.author?.id === disboardBotId &&
    commandName === "bump" &&
    Boolean(message.interactionMetadata?.user ?? message.interaction?.user)
  );
}

async function restoreBumpReminders() {
  const reminders = await getBumpReminders();

  for (const reminder of reminders) {
    scheduleBumpReminder(reminder);
  }
}

async function handleTopicRequestMessage(message) {
  if (!message.inGuild() || message.author.bot) {
    return;
  }

  if (!message.content.includes("話題を出して")) {
    return;
  }

  const session = [...voiceMonitorSessions.values()].find(
    (session) => session.guildId === message.guildId && session.reminderChannelId === message.channelId,
  );

  if (!session) {
    return;
  }

  const topic = SUGGESTED_TOPICS[Math.floor(Math.random() * SUGGESTED_TOPICS.length)];
  await message.channel.send({ content: `話題の提案です：${topic}` });
}

async function handleVoiceStateUpdate(oldState, newState) {
  const guild = newState.guild ?? oldState.guild;
  if (!guild) {
    return;
  }

  const settings = await getGuildSettings(guild.id);
  const changedChannelIds = new Set();

  await maybeSendPendingCallWaitStartNotice(guild, settings);
  await processOteboVoiceStatusSessions(guild, settings);

  if (oldState.channelId) {
    changedChannelIds.add(oldState.channelId);
  }

  if (newState.channelId) {
    changedChannelIds.add(newState.channelId);
  }

  const monitoredChannelIds = [];

  for (const channelId of changedChannelIds) {
    if (await isVoiceChannelMonitored(guild, settings, channelId)) {
      monitoredChannelIds.push(channelId);
    }

    await maybeSendAutoSplitSuggestion(guild, settings, channelId);
  }

  if (monitoredChannelIds.length > 0) {
    await Promise.all(
      monitoredChannelIds.map((channelId) =>
        updateVoiceMonitorSession(guild, settings, channelId),
      ),
    );
  }

  if (
    oldState.member &&
    oldState.member.user &&
    !oldState.member.user.bot &&
    oldState.channelId &&
    settings?.voiceParticipantRoleId &&
    (await isVoiceChannelMonitored(guild, settings, oldState.channelId))
  ) {
    const ignoredSessionKey = getVoiceMonitorSessionKey(guild.id, oldState.channelId);
    const participantRoleId =
      voiceMonitorSessions.get(ignoredSessionKey)?.participantRoleId ??
      settings.voiceParticipantRoleId;
    const stillInActiveSession = await isMemberInActiveVoiceMonitorContext(
      guild,
      settings,
      oldState.member.id,
      ignoredSessionKey,
    );

    if (!stillInActiveSession) {
      const member = await guild.members.fetch(oldState.member.id).catch(() => null);
      if (member) {
        await removeVoiceParticipantRole(member, participantRoleId);
      }
    }
  }
}

async function findAssociatedTextChannel(guild, voiceChannel, settings) {
  const textTypes = [ChannelType.GuildText, ChannelType.GuildAnnouncement];

  if (settings?.voiceReminderChannelId) {
    const configured = await guild.channels.fetch(settings.voiceReminderChannelId).catch(() => null);
    return configured && textTypes.includes(configured.type) ? configured : null;
  }

  const channels = [...guild.channels.cache.values()].filter((c) => textTypes.includes(c.type));

  // 1) exact name match
  let ch = channels.find((c) => c.name === voiceChannel.name);
  if (ch) return ch;

  // 2) same parent + name contains
  if (voiceChannel.parentId) {
    ch = channels.find((c) => c.parentId === voiceChannel.parentId && c.name.includes(voiceChannel.name));
    if (ch) return ch;
  }

  // 3) topic contains voice channel id
  ch = channels.find((c) => typeof c.topic === "string" && c.topic.includes(voiceChannel.id));
  if (ch) return ch;

  // 4) name starts with
  ch = channels.find((c) => c.name.startsWith(voiceChannel.name));
  if (ch) return ch;

  return null;
}

function createAutoSplitRow(channelId, disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`auto_split:${channelId}`)
      .setLabel("自動振り分け")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(disabled),
  );
}

async function maybeSendAutoSplitSuggestion(guild, settings, channelId) {
  const voiceChannel = await guild.channels.fetch(channelId).catch(() => null);

  if (!voiceChannel?.isVoiceBased()) {
    return;
  }

  if (settings?.voiceReminderParentChannelId === channelId) {
    return;
  }

  const persistedSuggestion = settings?.autoSplitSuggestions?.[channelId];
  const existingMessageId = autoSplitSuggestionMessages.get(channelId) ?? persistedSuggestion?.messageId;
  if (existingMessageId && !autoSplitSuggestionMessages.has(channelId)) {
    autoSplitSuggestionMessages.set(channelId, existingMessageId);
  }
  const isTargetCategory = await isPbChildVoiceChannel(
    guild,
    settings,
    voiceChannel,
  );

  if (!isTargetCategory) {
    if (existingMessageId) {
      await deleteAutoSplitSuggestionMessage(
        guild,
        settings,
        voiceChannel,
        existingMessageId,
      );
      autoSplitSuggestionMessages.delete(channelId);
      await clearAutoSplitSuggestion(guild.id, channelId);
    }

    return;
  }

  const members = getNonBotVoiceMembers(voiceChannel);

  if (members.length >= AUTO_SPLIT_THRESHOLD) {
    if (existingMessageId) {
      return;
    }

    const reminderChannel = await findAssociatedTextChannel(guild, voiceChannel, settings);

    if (!reminderChannel || typeof reminderChannel.send !== "function") {
      return;
    }

    const canAutoSplit = Boolean(settings?.voiceReminderParentChannelId && settings?.tempRoleId);
    const components = [createAutoSplitRow(channelId, !canAutoSplit)];
    const mentionRoleId = settings?.voiceParticipantRoleId;
    const mentionText = mentionRoleId ? `<@&${mentionRoleId}> ` : "";
    const content =
      `${mentionText}1つのvcに６人以上集まると喋れない人が出てきがちなので当チャンネルでは振り分けを推奨しています。\nまた、振り分け方が決まらないときは下の自動振り分けボタンをご活用ください！` +
      (canAutoSplit
        ? ""
        : "\n※リマインダー対象PB親チャンネルまたは参加者ロールが設定されていないため、自動振り分けは無効です。");

    const suggestionMessage = await reminderChannel.send({
      content,
      components,
      allowedMentions: mentionRoleId ? { roles: [mentionRoleId] } : { parse: [] },
    });

    autoSplitSuggestionMessages.set(channelId, suggestionMessage.id);
    await persistAutoSplitSuggestion(guild.id, channelId, suggestionMessage);
    return;
  }

  if (existingMessageId && members.length < AUTO_SPLIT_THRESHOLD) {
    await deleteAutoSplitSuggestionMessage(
      guild,
      settings,
      voiceChannel,
      existingMessageId,
    );
    autoSplitSuggestionMessages.delete(channelId);
    await clearAutoSplitSuggestion(guild.id, channelId);
  }
}

async function deleteAutoSplitSuggestionMessage(
  guild,
  settings,
  voiceChannel,
  messageId,
) {
  const reminderChannel = await findAssociatedTextChannel(
    guild,
    voiceChannel,
    settings,
  );

  if (!reminderChannel || typeof reminderChannel.messages?.fetch !== "function") {
    return;
  }

  const message = await reminderChannel.messages.fetch(messageId).catch(() => null);
  if (message) {
    await message.delete().catch(() => null);
  }
}

async function isVoiceChannelMonitored(guild, settings, channelId) {
  if (!channelId) {
    return false;
  }

  const voiceChannel =
    guild.channels.cache.get(channelId) ??
    (await guild.channels.fetch(channelId).catch(() => null));

  if (!voiceChannel?.isVoiceBased()) {
    return false;
  }

  if (await isPbChildVoiceChannel(guild, settings, voiceChannel)) {
    return true;
  }

  return (
    Array.isArray(settings?.voiceMonitorVoiceChannelIds) &&
    settings.voiceMonitorVoiceChannelIds.includes(channelId)
  );
}

async function isPbChildVoiceChannel(guild, settings, voiceChannel) {
  if (!settings?.voiceReminderParentChannelId || !voiceChannel?.isVoiceBased()) {
    return false;
  }

  const parentChannel = await guild.channels
    .fetch(settings.voiceReminderParentChannelId)
    .catch(() => null);

  if (!parentChannel?.isVoiceBased() || voiceChannel.id === parentChannel.id) {
    return false;
  }

  if (settings.voiceReminderChildCategoryId) {
    return voiceChannel.parentId === settings.voiceReminderChildCategoryId;
  }

  if (settings.childCategoryId) {
    return voiceChannel.parentId === settings.childCategoryId;
  }

  return Boolean(parentChannel.parentId && voiceChannel.parentId === parentChannel.parentId);
}

function getNonBotVoiceMembers(voiceChannel) {
  return [...voiceChannel.members.values()].filter((member) => !member.user.bot);
}

function getVoiceMonitorSessionKey(guildId, channelId) {
  return `${guildId}:${channelId}`;
}

async function isMemberInActiveVoiceMonitorContext(
  guild,
  settings,
  memberId,
  ignoredSessionKey = null,
) {
  for (const session of voiceMonitorSessions.values()) {
    const sessionKey = getVoiceMonitorSessionKey(session.guildId, session.voiceChannelId);

    if (
      session.guildId === guild.id &&
      sessionKey !== ignoredSessionKey &&
      session.memberIds.has(memberId)
    ) {
      return true;
    }
  }

  for (const voiceState of guild.voiceStates.cache.values()) {
    if (voiceState.member?.id !== memberId || !voiceState.channelId) {
      continue;
    }

    const sessionKey = getVoiceMonitorSessionKey(guild.id, voiceState.channelId);

    if (sessionKey === ignoredSessionKey) {
      continue;
    }

    if (voiceMonitorSessions.has(sessionKey)) {
      return true;
    }

    const voiceChannel =
      guild.channels.cache.get(voiceState.channelId) ??
      (await guild.channels.fetch(voiceState.channelId).catch(() => null));

    if (
      voiceChannel?.isVoiceBased() &&
      getNonBotVoiceMembers(voiceChannel).length >= VOICE_MONITOR_MIN_MEMBERS &&
      (await isVoiceChannelMonitored(guild, settings, voiceState.channelId))
    ) {
      return true;
    }
  }

  return false;
}

async function updateVoiceMonitorSession(guild, settings, channelId, options = {}) {
  const voiceChannel = await guild.channels.fetch(channelId).catch(() => null);

  if (!voiceChannel?.isVoiceBased()) {
    return;
  }

  const members = getNonBotVoiceMembers(voiceChannel);

  const sessionKey = getVoiceMonitorSessionKey(guild.id, channelId);
  const existingSession = voiceMonitorSessions.get(sessionKey);

  if (members.length >= VOICE_MONITOR_MIN_MEMBERS) {
    if (!existingSession) {
      const pendingDeletion = voiceMonitorPendingFormDeletions.get(sessionKey);

      if (pendingDeletion) {
        clearTimeout(pendingDeletion.timer);
        voiceMonitorPendingFormDeletions.delete(sessionKey);
        const resumedSession = pendingDeletion.session;
        resumedSession.stopTimer = null;
        voiceMonitorSessions.set(sessionKey, resumedSession);
        await ensureSessionMembersHaveRole(resumedSession, voiceChannel, members);
        return;
      }

      const session = {
        guildId: guild.id,
        voiceChannelId: channelId,
        participantRoleId: settings.voiceParticipantRoleId,
        memberIds: new Set(),
        topicForms: new Map(),
        stopTimer: null,
      };

      voiceMonitorSessions.set(sessionKey, session);
      await startVoiceMonitorSession(session, voiceChannel, members, settings, options);
      return;
    }

    if (existingSession.stopTimer) {
      clearTimeout(existingSession.stopTimer);
      existingSession.stopTimer = null;
    }

    const pendingDeletion = voiceMonitorPendingFormDeletions.get(sessionKey);
    if (pendingDeletion) {
      clearTimeout(pendingDeletion.timer);
      voiceMonitorPendingFormDeletions.delete(sessionKey);
    }

    await ensureSessionMembersHaveRole(existingSession, voiceChannel, members);

    return;
  }

  if (existingSession && !existingSession.stopTimer) {
    scheduleVoiceMonitorTopicFormDeletion(existingSession);

    existingSession.stopTimer = setTimeout(() => {
      void stopVoiceMonitorSessionIfStillUnderfilled(
        existingSession,
        guild,
        channelId,
        settings,
      ).catch((error) => {
        console.error(error);
      });
    }, VOICE_MONITOR_STOP_DELAY_MS);
  }
}

async function stopVoiceMonitorSessionIfStillUnderfilled(
  session,
  guild,
  channelId,
  settings,
) {
  const sessionKey = getVoiceMonitorSessionKey(guild.id, channelId);

  if (voiceMonitorSessions.get(sessionKey) !== session) {
    return;
  }

  const voiceChannel = await guild.channels.fetch(channelId).catch(() => null);

  if (
    voiceChannel?.isVoiceBased() &&
    getNonBotVoiceMembers(voiceChannel).length >= VOICE_MONITOR_MIN_MEMBERS
  ) {
    session.stopTimer = null;
    return;
  }

  await stopVoiceMonitorSession(session, guild, voiceChannel, settings);
}

async function startVoiceMonitorSession(session, voiceChannel, members, settings, options = {}) {
  await ensureSessionMembersHaveRole(session, voiceChannel, members);
  if (!options.suppressStartNotice) {
    await sendVoiceMonitorStartNotice(voiceChannel, settings);
  }
}

async function persistAutoSplitSuggestion(guildId, channelId, message) {
  await replaceNestedObject({
    guildId,
    path: `autoSplitSuggestions.${channelId}`,
    value: {
      messageId: message.id,
      reminderChannelId: message.channelId,
      createdAt: new Date().toISOString(),
    },
  });
}

async function clearAutoSplitSuggestion(guildId, channelId) {
  await unsetNestedObject({ guildId, path: `autoSplitSuggestions.${channelId}` });
}

async function restoreVoiceMonitorSessions() {
  let rebuilt = 0;
  for (const guild of client.guilds.cache.values()) {
    try {
      const settings = await getGuildSettings(guild.id).catch(() => null);
      if (!settings) continue;
      for (const [channelId, suggestion] of Object.entries(settings.autoSplitSuggestions ?? {})) {
        if (suggestion?.messageId) autoSplitSuggestionMessages.set(channelId, suggestion.messageId);
      }
      const candidates = [...guild.channels.cache.values()].filter((channel) => channel.isVoiceBased());
      for (const channel of candidates) {
        try {
          if (getNonBotVoiceMembers(channel).length < VOICE_MONITOR_MIN_MEMBERS) continue;
          if (!(await isVoiceChannelMonitored(guild, settings, channel.id))) continue;
          await updateVoiceMonitorSession(guild, settings, channel.id, { suppressStartNotice: true });
          rebuilt += 1;
        } catch (error) {
          console.error(`Voice monitor restore failed guild=${guild.id} channel=${channel.id}: ${error.message}`);
        }
      }
      await reconcilePersistedVoiceParticipantRoleGrants(guild, settings);
    } catch (error) {
      console.error(`Voice monitor guild restore failed guild=${guild.id}: ${error.message}`);
    }
  }
  console.log(`Startup voice monitor sessions rebuilt: ${rebuilt}`);
}

async function reconcilePersistedVoiceParticipantRoleGrants(guild, settings) {
  const grants = await VoiceParticipantRoleGrant.find({ guildId: guild.id }).lean();

  for (const grant of grants) {
    const member = await guild.members.fetch(grant.memberId).catch(() => null);

    if (!member || !member.roles.cache.has(grant.roleId)) {
      await VoiceParticipantRoleGrant.deleteOne({ _id: grant._id });
      continue;
    }

    const hasActiveVoiceMonitorSession = await isMemberInActiveVoiceMonitorContext(
      guild,
      settings,
      grant.memberId,
    );
    const shouldKeepGrant =
      grant.roleId === settings?.voiceParticipantRoleId &&
      hasActiveVoiceMonitorSession;

    if (!shouldKeepGrant) {
      await removeVoiceParticipantRole(member, grant.roleId);
    }
  }
}

async function sendVoiceMonitorStartNotice(voiceChannel, settings) {
  if (settings?.voiceReminderEnabled === false) {
    return;
  }

  const bosyuChannel = await resolveConfiguredTextChannel(
    voiceChannel.guild,
    settings?.bosyuChannelId,
  );

  if (!bosyuChannel) {
    return;
  }

  const mentionText = settings?.bosyuMentionRoleId
    ? `<@&${settings.bosyuMentionRoleId}> `
    : "";

  await bosyuChannel.send({
    content: `${mentionText}<#${voiceChannel.id}> にて通話が始まりました！`,
    allowedMentions: settings?.bosyuMentionRoleId
      ? { roles: [settings.bosyuMentionRoleId] }
      : { parse: [] },
  });
}

async function deleteVoiceMonitorTopicForms(session) {
  for (const [formId, topicForm] of session.topicForms.entries()) {
    if (topicForm.disableTimer) {
      clearTimeout(topicForm.disableTimer);
    }

    const reminderChannel = await client.channels
      .fetch(topicForm.reminderChannelId)
      .catch(() => null);

    if (reminderChannel && typeof reminderChannel.messages?.fetch === "function") {
      const formMessage = await reminderChannel.messages
        .fetch(topicForm.messageId)
        .catch(() => null);

      if (formMessage) {
        await formMessage.delete().catch(() => null);
      }
    }

    topicFormSessions.delete(formId);
  }

  session.topicForms.clear();
}

function scheduleVoiceMonitorTopicFormDeletion(session) {
  const sessionKey = getVoiceMonitorSessionKey(
    session.guildId,
    session.voiceChannelId,
  );

  if (voiceMonitorPendingFormDeletions.has(sessionKey)) {
    return;
  }

  const timer = setTimeout(() => {
    voiceMonitorPendingFormDeletions.delete(sessionKey);
    void deleteVoiceMonitorTopicForms(session).catch((error) => {
      console.error(`Failed to delete voice topic forms: ${error.message}`, error);
    });
  }, VOICE_MONITOR_FORM_DELETE_DELAY_MS);

  voiceMonitorPendingFormDeletions.set(sessionKey, {
    session,
    timer,
  });
}

async function ensureSessionMembersHaveRole(session, voiceChannel, members) {
  session.memberIds = new Set(members.map((member) => member.id));

  if (!session.participantRoleId || members.length < VOICE_MONITOR_MIN_MEMBERS) {
    return;
  }

  const role = await voiceChannel.guild.roles
    .fetch(session.participantRoleId)
    .catch(() => null);

  if (!role) {
    return;
  }

  for (const member of members) {
    if (!member.roles.cache.has(role.id)) {
      try {
        await member.roles.add(role, "VC参加者ロールを付与");
        try {
          await VoiceParticipantRoleGrant.updateOne(
            { guildId: voiceChannel.guild.id, memberId: member.id, roleId: role.id },
            { $setOnInsert: { guildId: voiceChannel.guild.id, memberId: member.id, roleId: role.id } },
            { upsert: true },
          );
        } catch (error) {
          // A grant without a durable ownership record cannot be reconciled
          // after a restart, so roll it back instead of leaving it untracked.
          await member.roles.remove(role, "VC参加者ロール記録の保存失敗に伴うロール解除").catch(() => {});
          console.error(`Failed to persist voice participant role grant for ${member.id}: ${error.message}`);
        }
      } catch (error) {
        console.error(`Failed to add voice participant role to ${member.id}: ${error.message}`);
      }
    }
  }
}

async function stopVoiceMonitorSession(session, guild, voiceChannel, settings) {
  if (session.stopTimer) {
    clearTimeout(session.stopTimer);
    session.stopTimer = null;
  }

  const sessionKey = getVoiceMonitorSessionKey(session.guildId, session.voiceChannelId);

  voiceMonitorSessions.delete(sessionKey);

  const memberIds = new Set(
    [
      ...session.memberIds,
      ...(voiceChannel?.isVoiceBased()
        ? getNonBotVoiceMembers(voiceChannel).map((member) => member.id)
        : []),
    ],
  );

  const participantRoleId = session.participantRoleId ?? settings.voiceParticipantRoleId;

  for (const memberId of memberIds) {
    if (!participantRoleId) {
      continue;
    }

    const stillInActiveSession = await isMemberInActiveVoiceMonitorContext(
      guild,
      settings,
      memberId,
      sessionKey,
    );

    if (!stillInActiveSession) {
      const member = await guild.members.fetch(memberId).catch(() => null);
      if (!member) {
        continue;
      }

      await removeVoiceParticipantRole(member, participantRoleId);
    }
  }

  // ノーティフィケーションは不要のため送信しない
}

function createTopicFormRow(formId, disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`topic_form_button:${formId}`)
      .setLabel(disabled ? "フォーム期限切れ" : "話題フォームを開く")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(disabled),
  );
}

function createVoiceTopicModal(formId) {
  return new ModalBuilder()
    .setCustomId(`topic_form:${formId}`)
    .setTitle("今の話題を投稿")
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("voice_topic_input")
          .setLabel("今話している話題を入力してください")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(400)
          .setPlaceholder("例：ゲームについてしゃべってます！"),
      ),
    );
}

async function handleTopicFormButton(interaction) {
  const formId = interaction.customId.slice("topic_form_button:".length);
  const topicForm = topicFormSessions.get(formId);

  if (!topicForm || Date.now() > topicForm.expiresAt) {
    await interaction.reply({
      content: "このフォームの有効期限が切れました。次のリマインダーをお待ちください。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.showModal(createVoiceTopicModal(formId));
}

async function handleAutoSplitButton(interaction) {
  if (!interaction.inGuild()) {
    await replyOrFollowUp(interaction, {
      content: "この操作はサーバー内で実行してください。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const channelId = interaction.customId.slice("auto_split:".length);
  const settings = await getGuildSettings(interaction.guildId);
  const guild = interaction.guild;
  const voiceChannel = await guild.channels.fetch(channelId).catch(() => null);

  if (!voiceChannel?.isVoiceBased()) {
    await interaction.reply({
      content: "対象のボイスチャンネルが見つかりませんでした。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const members = [...voiceChannel.members.values()].filter((member) => !member.user.bot);

  if (members.length < AUTO_SPLIT_THRESHOLD) {
    await interaction.reply({
      content: "参加人数が6人未満になったため、自動振り分けは実行できませんでした。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

const parentChannelId = settings?.voiceReminderParentChannelId;
    const parentChannel = parentChannelId
      ? await guild.channels.fetch(parentChannelId).catch(() => null)
      : null;
    const participantRole = settings?.tempRoleId
      ? await guild.roles.fetch(settings.tempRoleId).catch(() => null)
      : null;

    if (!parentChannelId || !parentChannel?.isVoiceBased() || !participantRole) {
      await interaction.reply({
        content:
          "リマインダー対象PB親チャンネルまたは参加者ロールが未設定のため、自動振り分けを実行できませんでした。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.update({
    content: "自動振り分けを実行します。少々お待ちください…",
    components: [],
  });

  const [stayGroup, moveGroup] = splitIntoTwoRandomGroups(members);

  const transferResult = await transferMembersToPbChildChannel(moveGroup, {
    parentChannel,
    childCategoryId: settings.childCategoryId,
    participantRole,
    sourceChannelId: voiceChannel.id,
  });

  const moved = moveGroup.length - transferResult.failed.length;
  const roleFailedText = transferResult.roleFailures.length
    ? ` 参加者ロール付与失敗: ${transferResult.roleFailures.join("、")}`
    : "";
  const failedText = transferResult.failed.length
    ? ` 転送失敗: ${transferResult.failed.join("、")}`
    : "";

  await interaction.followUp({
    content: `自動振り分けを完了しました。
${transferResult.childChannel ? `<#${transferResult.childChannel.id}>` : "PB子VCの検出に失敗しました。"} へ ${moved}/${moveGroup.length} 人を転送しました。${failedText}${roleFailedText}`,
    allowedMentions: { parse: [] },
  });

  autoSplitSuggestionMessages.delete(channelId);
  await clearAutoSplitSuggestion(interaction.guildId, channelId);
}

function splitIntoTwoRandomGroups(members) {
  const shuffled = shuffle(members);
  const firstGroupSize = Math.ceil(shuffled.length / 2);
  return [
    shuffled.slice(0, firstGroupSize),
    shuffled.slice(firstGroupSize),
  ];
}

async function transferMembersToPbChildChannel(members, config) {
  const failures = [];
  const roleFailures = [];
  const participantMemberIds = new Set();

  if (members.length === 0) {
    return { childChannel: null, failed: [], roleFailures };
  }

  const seedMember = members[0];

  try {
    await seedMember.voice.setChannel(
      config.parentChannel,
      "Move split group seed to PB parent channel",
    );
  } catch {
    failures.push(seedMember.displayName);
  }

  const seedRoleFailure = await addRoleForTransfer(
    seedMember,
    config.participantRole,
    participantMemberIds,
  );

  if (seedRoleFailure) {
    roleFailures.push(seedRoleFailure);
  }

  const childChannel = await waitForPbChildChannel(seedMember, {
    parentChannel: config.parentChannel,
    sourceChannelId: config.sourceChannelId,
    childCategoryId: config.childCategoryId,
  });

  if (!childChannel) {
    return { childChannel: null, failed: [seedMember.displayName], roleFailures };
  }

  let movedCount = failures.length === 0 ? 1 : 0;

  for (const member of members.slice(1)) {
    try {
      await member.voice.setChannel(
        childChannel,
        "Move group member to PB child channel",
      );
      const roleFailure = await addRoleForTransfer(
        member,
        config.participantRole,
        participantMemberIds,
      );

      if (roleFailure) {
        roleFailures.push(roleFailure);
      }

      movedCount += 1;
    } catch {
      failures.push(member.displayName);
    }
  }

  return {
    childChannel,
    failed: failures,
    roleFailures,
    participantMemberIds: [...participantMemberIds],
  };
}

async function handleSuggestTopicButton(interaction) {
  const session = [...voiceMonitorSessions.values()].find(
    (session) =>
      interaction.customId === `suggest_topic:${session.voiceChannelId}` &&
      session.guildId === interaction.guildId,
  );

  if (!session) {
    await interaction.reply({
      content: "現在、話題提案を行えるセッションがありません。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const topic = SUGGESTED_TOPICS[Math.floor(Math.random() * SUGGESTED_TOPICS.length)];

  await interaction.reply({
    content: `話題の提案です：${topic}`,
    flags: MessageFlags.Ephemeral,
  });
}

async function handleTopicFormModal(interaction) {
  const formId = interaction.customId.slice("topic_form:".length);
  const topicForm = topicFormSessions.get(formId);

  if (!topicForm || Date.now() > topicForm.expiresAt) {
    await interaction.reply({
      content: "このフォームの有効期限が切れました。次のリマインダーをお待ちください。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const topicText = interaction.fields.getTextInputValue("voice_topic_input").trim();
  const statusText = formatVoiceTopicStatus(topicText);

  if (!statusText) {
    await replyOrFollowUp(interaction, {
      content: "話題を入力してください。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Require the submitter to be in a VC. If not, reject the submission.
  const posterVoiceChannel = interaction.member?.voice?.channel;
  if (!posterVoiceChannel?.isVoiceBased()) {
    await replyOrFollowUp(interaction, {
      content: "VC参加者のみが使えます",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const voiceChannel = posterVoiceChannel;

  try {
    await setVoiceChannelStatus(
      voiceChannel,
      statusText,
      "Update VC status from reminder topic form",
    );
  } catch (error) {
    console.error(`Failed to update voice channel status: ${error?.message ?? error}`);
    await replyOrFollowUp(interaction, {
      content:
        "VCのチャンネルステータス更新に失敗しました。Botに Set Voice Channel Status 権限があるか確認してください。BotがそのVCに入っていない場合は Manage Channels 権限も必要です。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.reply({
    content: "VCのチャンネルステータスを更新しました。",
    flags: MessageFlags.Ephemeral,
  });
}

async function removeVoiceParticipantRole(member, roleId) {
  const grant = await VoiceParticipantRoleGrant.exists({
    guildId: member.guild.id,
    memberId: member.id,
    roleId,
  }).catch((error) => {
    console.error(`Failed to look up voice participant role grant for ${member.id}: ${error.message}`);
    return null;
  });

  // Only revoke a role that this bot recorded as its own grant.  The same
  // role may also be assigned manually or by another feature.
  if (!grant) {
    return;
  }

  if (!member.roles.cache.has(roleId)) {
    await VoiceParticipantRoleGrant.deleteOne({
      guildId: member.guild.id,
      memberId: member.id,
      roleId,
    }).catch((error) => {
      console.error(`Failed to clear voice participant role grant for ${member.id}: ${error.message}`);
    });
    return;
  }

  try {
    await member.roles.remove(roleId, "VC離脱に伴う参加者ロール解除");
  } catch (error) {
    console.error(`Failed to remove voice participant role from ${member.id}: ${error.message}`);
    return;
  }

  await VoiceParticipantRoleGrant.deleteOne({
    guildId: member.guild.id,
    memberId: member.id,
    roleId,
  }).catch((error) => {
    console.error(`Failed to clear voice participant role grant for ${member.id}: ${error.message}`);
  });
}

function scheduleBumpReminder(reminder) {
  if (bumpReminderTimers.has(reminder.id)) {
    clearTimeout(bumpReminderTimers.get(reminder.id));
  }

  const delayMs = Math.max(0, new Date(reminder.dueAt).getTime() - Date.now());
  const timer = setTimeout(() => {
    bumpReminderTimers.delete(reminder.id);
    void sendBumpReminder(reminder).catch((error) => {
      console.error(error);
    });
  }, delayMs);

  bumpReminderTimers.set(reminder.id, timer);
}

async function sendBumpReminder(reminder) {
  const channel = await client.channels.fetch(reminder.channelId).catch(() => null);

  if (!channel || typeof channel.send !== "function") {
    await deleteBumpReminder(reminder.id);
    return;
  }

  await channel.send({
    content: "前回のbumpから２時間が経過しました",
    allowedMentions: { parse: [] },
  });
  await deleteBumpReminder(reminder.id);
}

async function handleSplitVoice(interaction) {
  if (!interaction.inGuild()) {
    await interaction.reply({
      content: "このコマンドはサーバー内で使ってください。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const selectedChannel = interaction.options.getChannel("channel", false);
  const fallbackChannel = interaction.member?.voice?.channel ?? null;
  const sourceChannel = selectedChannel ?? fallbackChannel;
  const privateResult = interaction.options.getBoolean("private") ?? false;

  if (!sourceChannel?.isVoiceBased()) {
    await interaction.reply({
      content: "対象のボイスチャンネルを指定するか、自分がボイスチャンネルに入ってから実行してください。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const botMember = await interaction.guild.members.fetch(interaction.client.user.id);
  const sourcePermissions = sourceChannel.permissionsFor(botMember);

  if (!sourcePermissions?.has(PermissionsBitField.Flags.ViewChannel)) {
    await interaction.reply({
      content: "Botが対象のボイスチャンネルを見る権限を持っていません。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (splitVoiceGuildLocks.has(interaction.guildId)) {
    await interaction.reply({
      content: "このサーバーでは、すでに /splitvc を処理中です。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  splitVoiceGuildLocks.add(interaction.guildId);
  const releaseSplitVoiceLock = () => splitVoiceGuildLocks.delete(interaction.guildId);

  const activeSplitSession = await SplitProcessSession.exists({
    guildId: interaction.guildId,
    status: "active",
  });
  if (activeSplitSession) {
    releaseSplitVoiceLock();
    await interaction.reply({
      content: "このサーバーでは、進行中の /splitvc セッションがあります。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const includeBots = interaction.options.getBoolean("include_bots") ?? false;
  const splitSessionId = createSessionId();
  const members = [...sourceChannel.members.values()]
    .filter((member) => includeBots || !member.user.bot)
    .sort((left, right) =>
      left.displayName.localeCompare(right.displayName, "ja"),
    );

  let groupingState = null;
  let groupingHistoryError = null;
  try {
    groupingState = await getSplitGroupingState(interaction.guildId);
  } catch (error) {
    groupingHistoryError = error;
  }

  const previousGroups = groupingState?.current?.groups ?? groupingState?.previous?.groups ?? [];
  const targetMembers = members;
  const groupingSelection = groupingHistoryError
    ? {
        groups: buildGroups(shuffle(targetMembers)),
        score: null,
        candidateCount: 1,
        evaluatedCandidateCount: 1,
      }
    : chooseGroupsWithHistory(targetMembers, previousGroups);
  const groups = groupingSelection.groups;

  if (targetMembers.length === 0) {
    releaseSplitVoiceLock();
    await interaction.reply({
      content: `${sourceChannel} に対象メンバーがいません。`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await replyInChunks(interaction, formatResult(sourceChannel, targetMembers.length, groups), {
    flags: privateResult ? MessageFlags.Ephemeral : undefined,
    allowedMentions: { parse: [] },
  });

  const settings = await getGuildSettings(interaction.guildId);
  const config = await resolveProcessConfig(interaction, settings, botMember);
  const transferWaitMs = secondsToMs(
    getNonNegativeInteger(
      settings?.transferWaitSeconds,
      DEFAULT_TRANSFER_WAIT_SECONDS,
    ),
  );
  const noticeWaitMs = minutesToMs(
    getNonNegativeInteger(settings?.noticeWaitMinutes, DEFAULT_NOTICE_WAIT_MINUTES),
  );
  const roleRemoveWaitMs = minutesToMs(
    getNonNegativeInteger(
      settings?.roleRemoveWaitMinutes,
      DEFAULT_ROLE_REMOVE_WAIT_MINUTES,
    ),
  );

  if (config.errors.length > 0) {
    releaseSplitVoiceLock();
    await interaction.followUp({
      content: `PB連携プロセスは実行できません。\n${config.errors.map((error) => `- ${error}`).join("\n")}`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const operationChannel = getSendableChannel(interaction);

  if (!operationChannel) {
    releaseSplitVoiceLock();
    await interaction.followUp({
      content: "結果や待機メッセージを送信できるテキストチャンネルが見つかりません。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await sendOperationalLog({
    guild: interaction.guild,
    settings,
    fallbackChannel: operationChannel,
    content: `${config.tempRole} は、各メンバーをVCへ転送したタイミングで付与します。`,
    allowedMentions: { roles: [] },
  });

  const previousPairCount = getPairKeysFromGroups(previousGroups).size;
  await sendSplitGroupingLog({
    guild: interaction.guild,
    settings,
    content: [
      `[splitvc-history] guild=${interaction.guildId} session=${splitSessionId}`,
      `source=${groupingState?.current ? "current" : groupingState?.previous ? "previous" : "none"}`,
      `previousPairCount=${previousPairCount}`,
      `candidateCount=${groupingSelection.candidateCount}`,
      `evaluatedCandidateCount=${groupingSelection.evaluatedCandidateCount}`,
      `selectedRepeatedPairCount=${groupingSelection.score ?? "fallback"}`,
      groupingHistoryError
        ? `historyError=${groupingHistoryError.name ?? "Error"}: ${groupingHistoryError.message ?? groupingHistoryError}`
        : "historyError=none",
    ].join("\n"),
  });

  const transferCanceled = await runCountdown({
    channel: operationChannel,
    ownerId: interaction.user.id,
    totalMs: transferWaitMs,
    updateEveryMs: COUNTDOWN_UPDATE_MS,
    buttonLabel: "転送キャンセル",
    cancelText: "転送はキャンセルされました。終了通知の待機は続行します。",
    render: (remainingMs) =>
      `PB親チャンネルへの転送開始まで残り ${formatDuration(remainingMs)} です。\nキャンセルできるのはコマンド実行者のみです。`,
  });

  const childChannelIds = new Set();
  const participantMemberIds = new Set();
  const processState = { ended: false };
  let temporaryWaitingVc = null;
  let temporaryWaitingVcDeleteTimer = null;
  let splitStartMessage = null;

  await persistSplitProcessSession(splitSessionId, {
    guildId: interaction.guildId,
    ownerId: interaction.user.id,
    sourceChannelId: sourceChannel.id,
    operationChannelId: operationChannel.id,
    parentChannelId: config.parentChannel.id,
    childCategoryId: config.childCategoryId,
    participantRoleId: config.tempRole.id,
    phase: "transfer_waiting",
    status: "active",
    transferAt: new Date(Date.now() + transferWaitMs),
    finishMessage: settings?.finishMessage || DEFAULT_FINISH_MESSAGE,
  });

  if (transferCanceled) {
    await persistSplitProcessSession(splitSessionId, {
      status: "canceled",
      phase: "canceled",
      completedAt: new Date(),
    });
    releaseSplitVoiceLock();
    await operationChannel.send("転送をキャンセルしました。");
  } else {
    const transferResult = await transferGroups(groups, {
      parentChannel: config.parentChannel,
      childCategoryId: config.childCategoryId,
      participantRole: config.tempRole,
      sourceChannelId: sourceChannel.id,
    });
    addMany(childChannelIds, transferResult.childChannelIds);
    addMany(participantMemberIds, transferResult.participantMemberIds);

    if (transferResult.groupSummaries.length > 0) {
      try {
        await startSplitGrouping({
          guildId: interaction.guildId,
          sessionId: splitSessionId,
          groups: transferResult.groupSummaries.map((summary) => ({
            channelId: summary.channelId,
            memberIds: summary.memberIds,
          })),
        });
        await sendSplitGroupingLog({
          guild: interaction.guild,
          settings,
          content: `[splitvc-history] current saved guild=${interaction.guildId} session=${splitSessionId} groups=${transferResult.groupSummaries.length} successfulMembers=${transferResult.groupSummaries.reduce((total, summary) => total + summary.memberIds.length, 0)}`,
        });
      } catch (error) {
        await sendSplitGroupingLog({
          guild: interaction.guild,
          settings,
          content: `[splitvc-history] current save failed guild=${interaction.guildId} session=${splitSessionId} process=initial-transfer error=${error.name ?? "Error"}: ${error.message ?? error}`,
        });
      }
    }
    try {
      const finishNoticeAt = new Date(Date.now() + noticeWaitMs);
      const roleRemoveAt = new Date(finishNoticeAt.getTime() + roleRemoveWaitMs);
      await persistSplitProcessSession(splitSessionId, {
        phase: "active",
        status: "active",
        participantMemberIds: [...participantMemberIds],
        childChannelIds: [...childChannelIds],
        finishNoticeAt,
        roleRemoveAt,
      });
      await scheduleAction({
        actionKey: `split-finish-notice:${splitSessionId}`,
        guildId: interaction.guildId,
        type: "split_finish_notice",
        executeAt: finishNoticeAt,
        roleId: config.tempRole.id,
        memberIds: [...participantMemberIds],
        payload: { sessionId: splitSessionId, channelId: operationChannel.id, finishMessage: settings?.finishMessage || DEFAULT_FINISH_MESSAGE },
      });
      await scheduleAction({
        actionKey: `split-role-remove:${splitSessionId}`,
        guildId: interaction.guildId,
        type: "split_role_remove",
        executeAt: roleRemoveAt,
        roleId: config.tempRole.id,
        memberIds: [...participantMemberIds],
        payload: { sessionId: splitSessionId },
      });
    } catch (error) {
      await removeRoleFromMembers(interaction.guild, config.tempRole.id, [...participantMemberIds]).catch(() => {});
      for (const channelId of childChannelIds) {
        const channel = await interaction.guild.channels.fetch(channelId).catch(() => null);
        await channel?.delete().catch(() => {});
      }
      throw error;
    }
    releaseSplitVoiceLock();

    await sendOperationalLog({
      guild: interaction.guild,
      settings,
      fallbackChannel: operationChannel,
      content: `転送結果\n${transferResult.lines.join("\n")}`,
    });

    const gatheringClosed = await closeGatheringVcAfterSplit(
      interaction.guild,
      settings,
    );

    if (gatheringClosed) {
      await sendOperationalLog({
        guild: interaction.guild,
        settings,
        fallbackChannel: operationChannel,
        content: "集合VCのeveryone接続権限を不可にしました。",
      });
    }

    try {
      await sendPostSplitWadaiTopic({
        fallbackChannel: operationChannel,
        groupSummaries: transferResult.groupSummaries,
        guild: interaction.guild,
        participantRoleId: config.tempRole.id,
        settings,
      });
    } catch (error) {
      console.error(`Failed to send post-split wadai choices: ${error.message}`, error);
    }

    if (config.waitingVcCategoryId) {

      temporaryWaitingVc = await operationChannel.guild.channels.create({
        name: config.waitingVcName,
        type: ChannelType.GuildVoice,
        parent: config.waitingVcCategoryId,

        permissionOverwrites: [
          {
            id: operationChannel.guild.roles.everyone.id,

            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.Connect,
            ],

            deny: [
              PermissionFlagsBits.Speak,
            ],
          },
        ],
      });

      await sendOperationalLog({
        guild: interaction.guild,
        settings,
        fallbackChannel: operationChannel,
        content: `待機用VC ${temporaryWaitingVc} を作成しました。10分後に自動削除されます。`,
      });

      splitStartMessage = await sendSplitStartAnnouncement({
        guild: interaction.guild,
        settings,
        waitingChannel: temporaryWaitingVc,
      });
      await persistSplitProcessSession(splitSessionId, {
        waitingChannelId: temporaryWaitingVc.id,
        splitStartMessageChannelId: splitStartMessage?.channel?.id ?? operationChannel.id,
        splitStartMessageId: splitStartMessage?.id,
        waitingMonitorEndsAt: new Date(Date.now() + WAITING_ROOM_MONITOR_MS),
        finishNoticeAt: new Date(Date.now() + noticeWaitMs),
        phase: "active",
      });
      await scheduleWaitingVcCleanup({
        actionKey: `split-waiting-vc-cleanup:${splitSessionId}`,
        guild: interaction.guild,
        channelId: temporaryWaitingVc.id,
        delayMs: noticeWaitMs + roleRemoveWaitMs,
        sessionId: splitSessionId,
      });

      temporaryWaitingVcDeleteTimer = setTimeout(async () => {

        try {

          const fetchedChannel =
            await operationChannel.guild.channels.fetch(
              temporaryWaitingVc.id,
            ).catch(() => null);

          if (fetchedChannel) {
            const keepMonitoring = await shouldKeepWaitingRoomAlive({
              guild: interaction.guild,
              childChannelIds,
            });

            if (keepMonitoring) {
              await editSplitStartAnnouncementExtended(splitStartMessage, fetchedChannel);

              await sendOperationalLog({
                guild: interaction.guild,
                settings,
                fallbackChannel: operationChannel,
                content: "2人以下の子VCが残っているため、待機用VCの自動削除を延長しました。",
              });

              return;
            }

            await notifyWaitingVcClosure(operationChannel, fetchedChannel);
            await editSplitStartAnnouncementClosed(splitStartMessage);
            await fetchedChannel.delete();

            await sendOperationalLog({
              guild: interaction.guild,
              settings,
              fallbackChannel: operationChannel,
              content: "待機用VCを自動削除しました。",
            });
          }

        } catch (error) {

          console.error(error);

        }

      }, 10 * 60 * 1000);

      void runWaitingRoomMonitor({
        channel: operationChannel,
        guild: interaction.guild,
        waitingChannel: temporaryWaitingVc,
        parentChannel: config.parentChannel,
        participantRole: config.tempRole,
        childCategoryId: config.childCategoryId,
        childChannelIds,
        participantMemberIds,
        state: processState,
        settings,
        previousPairKeys: getPairKeysFromGroups(previousGroups),
        groupingSessionId: splitSessionId,
        currentGroupMembers: new Map(
          transferResult.groupSummaries.map((summary) => [summary.channelId, new Set(summary.memberIds)]),
        ),
      }).catch((error) => {
        console.error(error);
      });
    }


    void runEndNotificationFlow({
      channel: operationChannel,
      guild: interaction.guild,
      ownerId: interaction.user.id,
      roleId: config.tempRole.id,
      memberIds: participantMemberIds,
      finishMessage: settings?.finishMessage || DEFAULT_FINISH_MESSAGE,
      noticeWaitMs,
      roleRemoveWaitMs,
      childChannelIds,
      state: processState,
      sessionId: splitSessionId,
      temporaryWaitingVc,
      temporaryWaitingVcDeleteTimer,
      splitStartMessage,
      settings,
    }).catch((error) => {
      console.error(error);
    });
  }
}

const BOSYU_COOLDOWN_MS = 15 * 60 * 1000;
const BOSYU_EDIT_WINDOW_MS = 15 * 60 * 1000;

async function handleBosyu(interaction) {
  if (!interaction.inGuild()) {
    await interaction.reply({
      content: "このコマンドはサーバー内で使ってください。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const settings = await getGuildSettings(interaction.guildId);
  const bosyuChannelId = settings?.bosyuChannelId;
  const bosyuMentionRoleId = settings?.bosyuMentionRoleId;

  if (bosyuChannelId && interaction.channelId !== bosyuChannelId) {
    await replyOrFollowUp(interaction, {
      content: "このチャンネルでは /bosyu を使用できません。設定された募集チャンネルで実行してください。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const rateLimitKey = `${interaction.guildId}:${interaction.user.id}`;
  const now = Date.now();
  const cooldown = await consumeBosyuCooldown({
    guildId: interaction.guildId,
    userId: interaction.user.id,
    now: new Date(now),
    durationMs: BOSYU_COOLDOWN_MS,
  });

  if (!cooldown.allowed) {
    const remainingMs = Math.max(0, new Date(cooldown.availableAt).getTime() - now);
    const remainingMinutes = Math.floor(remainingMs / 60000);
    const remainingSeconds = Math.floor((remainingMs % 60000) / 1000);

    await replyOrFollowUp(interaction, {
      content: `15分以内に再度 /bosyu を使用できません。あと ${remainingMinutes}分${remainingSeconds}秒 です。`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  lastBosyuTimestamps.set(rateLimitKey, now);

  const timeValue = interaction.options.getString("time", false)?.trim() ?? "";
  let purposeValue = interaction.options.getString("purpose", false)?.trim() ?? "";
  const anonymous = interaction.options.getBoolean("anonymous", false) ?? false;
  const noteValue = interaction.options.getString("note", true).trim();

  const currentVoiceChannel = interaction.member?.voice?.channel;

  if (currentVoiceChannel?.isVoiceBased()) {
    if (purposeValue) {
      try {
        await currentVoiceChannel.edit(
          { name: purposeValue },
          "募集名目に合わせてVC名を更新",
        );
      } catch {
        // 応答は作成するが、変更できない場合は無視する
      }
    }
  }

  const content = formatBosyuMessage(
    timeValue,
    purposeValue,
    noteValue,
    bosyuMentionRoleId,
    anonymous,
  );

  await replyOrFollowUp(interaction, {
    content,
    components: [createBosyuEditRow()],
    allowedMentions: {
      roles: bosyuMentionRoleId ? [bosyuMentionRoleId] : [],
    },
  });

  const message = await interaction.fetchReply();
  const expiresAt = now + BOSYU_EDIT_WINDOW_MS;

  bosyuEditSessions.set(message.id, {
    ownerId: interaction.user.id,
    expiresAt,
    bosyuMentionRoleId,
    anonymous,
    voiceChannelId: currentVoiceChannel?.isVoiceBased() ? currentVoiceChannel.id : null,
  });
  await saveBosyuEditSession({
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    messageId: message.id,
    ownerId: interaction.user.id,
    expiresAt: new Date(expiresAt),
    bosyuMentionRoleId,
    anonymous,
    voiceChannelId: currentVoiceChannel?.isVoiceBased() ? currentVoiceChannel.id : null,
  });
  scheduleBosyuEditExpiry(message.id, interaction.channelId, expiresAt);

  setTimeout(async () => {
    bosyuEditSessions.delete(message.id);

    try {
      const channel = await client.channels.fetch(interaction.channelId).catch(() => null);
      if (!channel || typeof channel.messages?.fetch !== "function") {
        return;
      }

      const replyMessage = await channel.messages.fetch(message.id).catch(() => null);
      if (!replyMessage) {
        return;
      }

      await replyMessage.edit({ components: [] });
    } catch {
      // ignore expired cleanup errors
    }
  }, BOSYU_EDIT_WINDOW_MS);
}

async function handleBosyuButton(interaction) {
  if (!interaction.inGuild()) {
    await interaction.reply({
      content: "この操作はサーバー内で実行してください。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const session = bosyuEditSessions.get(interaction.message.id) ?? await getBosyuEditSession(interaction.message.id);

  if (!session || Date.now() > session.expiresAt) {
    await replyOrFollowUp(interaction, {
      content: "募集内容の編集期限が終了しました。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (interaction.user.id !== session.ownerId) {
    await replyOrFollowUp(interaction, {
      content: "この募集メッセージを編集できるのは実行者のみです。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  try {
    await interaction.showModal(createBosyuModal(interaction.message.id, interaction.message.content));
  } catch (error) {
    console.error(`Failed to show modal for bosyu_edit: ${error.message}`, error);
    await replyOrFollowUp(interaction, {
      content: "モーダルの表示に失敗しました。ブラウザやクライアントを最新にして再試行してください。",
      flags: MessageFlags.Ephemeral,
    });
  }
}

async function handleBosyuEditModal(interaction) {
  if (!interaction.inGuild()) {
    await replyOrFollowUp(interaction, {
      content: "この操作はサーバー内で実行してください。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const messageId = interaction.customId.slice("bosyu_edit_modal:".length);
  const session = bosyuEditSessions.get(messageId) ?? await getBosyuEditSession(messageId);

  if (!session || Date.now() > session.expiresAt) {
    await replyOrFollowUp(interaction, {
      content: "募集内容の編集期限が終了しました。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (interaction.user.id !== session.ownerId) {
    await replyOrFollowUp(interaction, {
      content: "この募集メッセージを編集できるのは実行者のみです。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const timeValue = interaction.fields.getTextInputValue("bosyu_time");
  const purposeValue = interaction.fields.getTextInputValue("bosyu_purpose");
  const noteValue = interaction.fields.getTextInputValue("bosyu_note");
  const content = formatBosyuMessage(
    timeValue,
    purposeValue,
    noteValue,
    session.bosyuMentionRoleId,
    session.anonymous,
  );

  const channel = interaction.channel;
  const replyMessage = await channel.messages.fetch(messageId).catch(() => null);

  if (!replyMessage) {
    await replyOrFollowUp(interaction, {
      content: "募集メッセージの取得に失敗しました。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  let replyMessageUpdated = true;
  try {
    await replyMessage.edit({
      content,
      components: Date.now() <= session.expiresAt ? [createBosyuEditRow()] : [],
      allowedMentions: {
        roles: session.bosyuMentionRoleId ? [session.bosyuMentionRoleId] : [],
      },
    });
  } catch (error) {
    replyMessageUpdated = false;
    console.error(`Failed to update bosyu message: ${error.message}`, error);
  }

  // Update the original VC from the bosyu session if available, otherwise fall back to the editor's current VC.
  try {
    let targetVoiceChannel = null;
    if (session.voiceChannelId) {
      targetVoiceChannel = await interaction.guild.channels.fetch(session.voiceChannelId).catch(() => null);
    }

    if (!targetVoiceChannel) {
      targetVoiceChannel = interaction.member?.voice?.channel;
    }

    if (targetVoiceChannel?.isVoiceBased()) {
      if (purposeValue?.trim()) {
        try {
          await targetVoiceChannel.edit({ name: purposeValue }, "Update VC name from bosyu edit");
        } catch (err) {
          console.error(`Failed to update bosyu VC name: ${err.message}`, err);
        }
      }

      // 'noteValue' (ひとこと) is included in the message content; do not attempt to set a channel status.
    }
  } catch (error) {
    console.error(`Error updating VC from bosyu edit: ${error.message}`);
  }

  await replyOrFollowUp(interaction, {
    content: replyMessageUpdated
      ? "募集内容を更新しました。"
      : "募集内容の更新は試みましたが、募集メッセージの編集に失敗しました。",
    flags: MessageFlags.Ephemeral,
  });
}

function createBosyuEditRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("bosyu_edit")
      .setLabel("募集内容を編集")
      .setStyle(ButtonStyle.Primary),
  );
}

function createBosyuModal(messageId, content) {
  const defaultValues = parseBosyuContent(content);

  return new ModalBuilder()
    .setCustomId(`bosyu_edit_modal:${messageId}`)
    .setTitle("募集内容を編集")
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("bosyu_time")
          .setLabel("時間")
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(100)
          .setPlaceholder("例: 1時間、30分、〇〇まで（省略可）")
          .setValue(defaultValues.time),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("bosyu_purpose")
          .setLabel("名目")
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(100)
          .setPlaceholder("例: ゲーム、作業、雑談（省略可）")
          .setValue(defaultValues.purpose),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("bosyu_note")
          .setLabel("ひとこと")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(200)
          .setPlaceholder("例: 遠慮せずご参加ください！")
          .setValue(defaultValues.note),
      ),
    );
}

function parseBosyuContent(content) {
  if (!content) {
    return { time: "", purpose: "", note: "" };
  }

  const lines = content.split("\n").map((line) => line.trim());
  const timeLine = lines.find((line) => line.startsWith("時間:"));
  const purposeLine = lines.find((line) => line.startsWith("名目:"));
  const noteLine = lines.find((line) => line.startsWith("ひとこと:"));

  return {
    time: timeLine ? timeLine.replace(/^時間:\s*/, "") : "",
    purpose: purposeLine ? purposeLine.replace(/^名目:\s*/, "") : "",
    note: noteLine ? noteLine.replace(/^ひとこと:\s*/, "") : "",
  };
}

function formatBosyuMessage(time, purpose, note, mentionRoleId, anonymous = false) {
  const lines = [];

  if (mentionRoleId && !anonymous) {
    lines.push(`<@&${mentionRoleId}>`);
  }

  if (time) {
    lines.push(`時間：${time}`);
  }

  if (purpose) {
    lines.push(`名目：${purpose}`);
  }

  if (note) {
    lines.push(`ひとこと：${note}`);
  }

  return lines.join("\n");
}

async function getPbChildChannelName(voiceChannel, settings, guild) {
  if (!voiceChannel?.isVoiceBased() || !settings?.parentChannelId || !guild) {
    return null;
  }

  if (voiceChannel.id === settings.parentChannelId) {
    return null;
  }

  if (settings.childCategoryId) {
    if (voiceChannel.parentId !== settings.childCategoryId) {
      return null;
    }
    return voiceChannel.name;
  }

  const parentChannel = await guild.channels
    .fetch(settings.parentChannelId)
    .catch(() => null);

  if (!parentChannel?.isVoiceBased()) {
    return null;
  }

  if (voiceChannel.parentId !== parentChannel.parentId) {
    return null;
  }

  return voiceChannel.name;
}

  async function resolveProcessConfig(interaction, settings, botMember) {
    const errors = [];

    if (!settings?.tempRoleId) {
      errors.push("/setting splitvc で参加者ロールを設定してください。");
    }

    if (!settings?.parentChannelId) {
      errors.push("/setting splitvc でPB親ボイスチャンネルを設定してください。");
    }

    const tempRole = settings?.tempRoleId
      ? await interaction.guild.roles.fetch(settings.tempRoleId).catch(() => null)
      : null;
    const parentChannel = settings?.parentChannelId
      ? await interaction.guild.channels.fetch(settings.parentChannelId).catch(() => null)
      : null;
    const childCategory = settings?.childCategoryId
      ? await interaction.guild.channels.fetch(settings.childCategoryId).catch(() => null)
      : null;
    const waitingVcCategory = settings?.waitingVcCategoryId
      ? await interaction.guild.channels.fetch(settings.waitingVcCategoryId,).catch(() => null)
      : null;

    if (settings?.tempRoleId && !tempRole) {
      errors.push("設定済みの参加者ロールが見つかりません。");
    }

    if (settings?.parentChannelId && !parentChannel?.isVoiceBased()) {
      errors.push("設定済みのPB親チャンネルがボイスチャンネルではありません。");
    }

    if (settings?.childCategoryId && !childCategory) {
      errors.push("設定済みの子VCカテゴリが見つかりません。");
    } else if (settings?.childCategoryId && childCategory.type !== ChannelType.GuildCategory) {
      errors.push("設定済みの子VCカテゴリがカテゴリチャンネルではありません。");
    }

    if (settings?.waitingVcCategoryId && !waitingVcCategory) {
      errors.push("設定済みの待機VCカテゴリが見つかりません。");
    } else if (
      settings?.waitingVcCategoryId &&
      waitingVcCategory.type !== ChannelType.GuildCategory
    ) {
      errors.push("待機VCカテゴリがカテゴリチャンネルではありません。");
    }

    if (tempRole) {
      if (tempRole.managed || tempRole.id === interaction.guild.id) {
        errors.push("その参加者ロールはBotから付与できません。");
      }

      if (tempRole.position >= botMember.roles.highest.position) {
        errors.push("参加者ロールはBotの最上位ロールより下に置いてください。");
      }
    }

    if (!botMember.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
      errors.push("Botに Manage Roles 権限がありません。");
    }

    if (!botMember.permissions.has(PermissionsBitField.Flags.MoveMembers)) {
      errors.push("Botに Move Members 権限がありません。");
    }

    if (parentChannel?.isVoiceBased()) {
      const parentPermissions = parentChannel.permissionsFor(botMember);

      if (!parentPermissions?.has(PermissionsBitField.Flags.ViewChannel)) {
        errors.push("BotがPB親チャンネルを見る権限を持っていません。");
      }

      if (!parentPermissions?.has(PermissionsBitField.Flags.Connect)) {
        errors.push("BotがPB親チャンネルへ接続する権限を持っていません。");
      }
    }


    const sendableChannel = getSendableChannel(interaction);
    const textPermissions = sendableChannel?.permissionsFor(botMember);

    if (!textPermissions?.has(PermissionsBitField.Flags.SendMessages)) {
      errors.push("Botがこのチャンネルにメッセージを送信できません。");
    }

    return {
      errors,
      tempRole,
      parentChannel,
      waitingVcCategory,
      childCategoryId: childCategory?.id ?? null,
      waitingVcCategoryId: waitingVcCategory?.id ?? null,
      waitingVcName: settings?.waitingVcName || DEFAULT_WAITING_VC_NAME,
    };
  }

  async function addRoleToMembers(members, role) {
    const failed = [];

    for (const member of members) {
      try {
        await member.roles.add(role, "Participant role for voice grouping session");
      } catch {
        failed.push(member.displayName);
      }
    }

    return { failed };
  }

    async function addRoleForTransfer(member, role, participantMemberIds) {
      if (member.roles.cache.has(role.id)) {
        participantMemberIds.add(member.id);
        return null;
    }

    try {
      await member.roles.add(role, "Participant role for voice grouping session");
      participantMemberIds.add(member.id);
      return null;
    } catch {
      return member.displayName;
    }
  }

  async function transferGroups(groups, config) {
    const lines = [];
    const childChannelIds = new Set();
    const participantMemberIds = new Set();
    const groupSummaries = [];

    for (const [index, group] of groups.entries()) {
      const groupNumber = index + 1;
      const seedMember = group[0];

      if (!seedMember?.voice?.channelId) {
        lines.push(`グループ ${groupNumber}: 代表メンバーがVCにいないため転送できませんでした。`);
        continue;
      }

      try {
        await seedMember.voice.setChannel(
          config.parentChannel,
          "Move one group member to PB parent channel",
        );
        const roleFailures = [];
        const seedRoleFailure = await addRoleForTransfer(
          seedMember,
          config.participantRole,
          participantMemberIds,
        );

        if (seedRoleFailure) {
          roleFailures.push(seedRoleFailure);
        }

        const childChannel = await waitForPbChildChannel(seedMember, config);

        if (!childChannel) {
          lines.push(`グループ ${groupNumber}: PBの子VCを検出できませんでした。`);
          continue;
        }

        childChannelIds.add(childChannel.id);
        let movedCount = 1;
        const failed = [];
        const movedMemberIds = [seedMember.id];

        for (const member of group.slice(1)) {
          if (!member.voice?.channelId) {
            failed.push(member.displayName);
            continue;
          }

          try {
            await member.voice.setChannel(
              childChannel,
              "Move remaining group members to PB child channel",
            );
            const roleFailure = await addRoleForTransfer(
              member,
              config.participantRole,
              participantMemberIds,
            );

            if (roleFailure) {
              roleFailures.push(roleFailure);
            }

            movedCount += 1;
            movedMemberIds.push(member.id);
          } catch {
            failed.push(member.displayName);
          }
        }

        groupSummaries.push({
          groupNumber,
          channelId: childChannel.id,
          channelName: childChannel.name,
          memberNames: shuffle(group).map((member) => member.displayName),
          memberIds: movedMemberIds,
        });

        const failedText =
          failed.length > 0 ? ` 転送失敗: ${failed.join("、")}` : "";
        const roleFailedText =
          roleFailures.length > 0
            ? ` 参加者ロール付与失敗: ${roleFailures.join("、")}`
            : "";
        lines.push(
          `グループ ${groupNumber}: ${childChannel.name} へ ${movedCount}/${group.length} 人を転送しました。${failedText}${roleFailedText}`,
        );
      } catch (error) {
        lines.push(`グループ ${groupNumber}: 転送中に失敗しました。${error.message}`);
      }
    }

    return {
      lines,
      childChannelIds: [...childChannelIds],
      groupSummaries,
      participantMemberIds: [...participantMemberIds],
    };
  }

  async function waitForPbChildChannel(member, config) {
    const startedAt = Date.now();

    while (Date.now() - startedAt < PB_CHILD_WAIT_MS) {
      const channel = member.voice.channel;

      if (isExpectedPbChildChannel(channel, config)) {
        return channel;
      }

      await sleep(750);
    }

    return null;
  }

  function isExpectedPbChildChannel(channel, config) {
    if (
      !channel?.isVoiceBased() ||
      channel.id === config.parentChannel.id ||
      channel.id === config.sourceChannelId
    ) {
      return false;
    }

    if (config.childCategoryId) {
      return channel.parentId === config.childCategoryId;
    }

    if (config.parentChannel.parentId) {
      return channel.parentId === config.parentChannel.parentId;
    }

    return true;
  }

  async function runWaitingRoomMonitor(options) {
    await sendOperationalLog({
      guild: options.guild,
      settings: options.settings,
      fallbackChannel: options.channel,
      content: `${options.waitingChannel} の途中参加監視を10分間開始します。`,
    });

    const endsAt = Date.now() + WAITING_ROOM_MONITOR_MS;

    while (Date.now() < endsAt && !options.state.ended) {
      await processWaitingRoom(options);
      await sleep(WAITING_ROOM_POLL_MS);
    }

    const shouldExtendMonitoring = await shouldKeepWaitingRoomAlive(options);

    if (shouldExtendMonitoring) {
      await sendOperationalLog({
        guild: options.guild,
        settings: options.settings,
        fallbackChannel: options.channel,
        content: "2人以下の子VCが残っているため、途中参加監視を延長します。",
      });

      while (!options.state.ended && (await shouldKeepWaitingRoomAlive(options))) {
        await processWaitingRoom(options);
        await sleep(WAITING_ROOM_POLL_MS);
      }
    }

    if (!options.state.ended) {
      await sendOperationalLog({
        guild: options.guild,
        settings: options.settings,
        fallbackChannel: options.channel,
        content: "途中参加監視を終了しました。",
      });
    }
  }

  async function processWaitingRoom(options) {
    const waitingMembers = getWaitingMembers(options.waitingChannel);

    if (waitingMembers.length === 0) {
      return;
    }

    const underfilledChildChannel = await findUnderfilledChildChannel(
      options.guild,
      options.childChannelIds,
      waitingMembers[0].id,
      options.previousPairKeys,
      options.currentGroupMembers,
    );

    if (underfilledChildChannel) {
      const member = waitingMembers[0];
      const currentMembers = options.currentGroupMembers.get(underfilledChildChannel.id) ??
        [...underfilledChildChannel.members.values()]
          .filter((voiceMember) => !voiceMember.user.bot)
          .map((voiceMember) => voiceMember.id);
      const repeatedPairCount = currentMembers.reduce(
        (count, currentMemberId) =>
          count + (options.previousPairKeys.has(createPairKey(member.id, currentMemberId)) ? 1 : 0),
        0,
      );
      await sendSplitGroupingLog({
        guild: options.guild,
        settings: options.settings,
        content: `[splitvc-history] waiting placement guild=${options.guild.id} session=${options.groupingSessionId} user=${member.id} channel=${underfilledChildChannel.id} process=existing-group repeatedPairCount=${repeatedPairCount} memberCount=${currentMembers.length}`,
      });
      let roleFailure = null;
      try {
        roleFailure = await moveMemberToChildChannel(
          member,
          underfilledChildChannel,
          options.participantRole,
          options.participantMemberIds,
        );
        await persistWaitingGroupMembers(options, underfilledChildChannel.id, [member.id], "existing-group");
      } catch (error) {
        await sendSplitGroupingLog({
          guild: options.guild,
          settings: options.settings,
          content: `[splitvc-history] waiting transfer failed guild=${options.guild.id} session=${options.groupingSessionId} user=${member.id} channel=${underfilledChildChannel.id} process=existing-group error=${error.name ?? "Error"}: ${error.message ?? error}`,
        });
        return;
      }
      const roleFailureText = roleFailure
        ? ` 参加者ロール付与失敗: ${roleFailure}`
        : "";

      await sendOperationalLog({
        guild: options.guild,
        settings: options.settings,
        fallbackChannel: options.channel,
        content: `途中参加: ${member.displayName} を ${underfilledChildChannel.name} へ転送しました。${roleFailureText}`,
      });
      return;
    }

    if (waitingMembers.length >= 3) {
      const newGroupMembers = chooseBestMemberSubset(
        waitingMembers,
        3,
        options.previousPairKeys,
      );
      await sendSplitGroupingLog({
        guild: options.guild,
        settings: options.settings,
        content: `[splitvc-history] waiting placement guild=${options.guild.id} session=${options.groupingSessionId} users=${newGroupMembers.map((member) => member.id).join(",")} process=new-group repeatedPairCount=${countRepeatedPairs([newGroupMembers], options.previousPairKeys)} candidateCount=100`,
      });
      const result = await transferWaitingGroupToNewChild(newGroupMembers, {
        parentChannel: options.parentChannel,
        participantRole: options.participantRole,
        sourceChannelId: options.waitingChannel.id,
        childCategoryId: options.childCategoryId,
        participantMemberIds: options.participantMemberIds,
      });

      if (result.childChannelId) {
        options.childChannelIds.add(result.childChannelId);
        options.currentGroupMembers.set(result.childChannelId, new Set(result.movedMemberIds));
        await persistWaitingGroupMembers(
          options,
          result.childChannelId,
          result.movedMemberIds,
          "new-group",
        );
      }

      await sendOperationalLog({
        guild: options.guild,
        settings: options.settings,
        fallbackChannel: options.channel,
        content: `途中参加の新規グループ\n${result.lines.join("\n")}`,
      });
    }
  }

  function getWaitingMembers(waitingChannel) {
    return [...waitingChannel.members.values()]
      .filter((member) => !member.user.bot)
      .sort((left, right) =>
        left.displayName.localeCompare(right.displayName, "ja"),
      );
  }

  async function findUnderfilledChildChannel(
    guild,
    childChannelIds,
    memberId = null,
    previousPairKeys = new Set(),
    currentGroupMembers = null,
  ) {
    let bestChannel = null;
    let bestCount = Infinity;
    const candidates = [];

    for (const channelId of childChannelIds) {
      const channel =
        guild.channels.cache.get(channelId) ??
        (await guild.channels.fetch(channelId).catch(() => null));

      if (!channel?.isVoiceBased()) {
        continue;
      }

      const memberCount = [...channel.members.values()].filter(
        (member) => !member.user.bot,
      ).length;

      if (memberCount <= 3) {
        candidates.push({
          channel,
          memberIds: currentGroupMembers?.get(channel.id)
            ? [...currentGroupMembers.get(channel.id)]
            : [...channel.members.values()]
                .filter((member) => !member.user.bot)
                .map((member) => member.id),
        });
        if (memberCount < bestCount) {
          bestChannel = channel;
          bestCount = memberCount;
        }
      }
    }

    if (!memberId || candidates.length === 0) {
      return bestChannel;
    }

    const selected = chooseBestGroupForMember(memberId, candidates, previousPairKeys);
    return selected ? selected.channel : bestChannel;
  }

  async function shouldKeepWaitingRoomAlive(options) {
    return Boolean(
      await findUnderfilledChildChannel(options.guild, options.childChannelIds),
    );
  }

  async function moveMemberToChildChannel(
    member,
    childChannel,
    participantRole,
    participantMemberIds,
  ) {
    await member.voice.setChannel(
      childChannel,
      "Move waiting participant to PB child channel",
    );
    return addRoleForTransfer(member, participantRole, participantMemberIds);
  }

  async function transferWaitingGroupToNewChild(members, config) {
    const lines = [];
    const seedMember = members[0];

    try {
      await seedMember.voice.setChannel(
        config.parentChannel,
        "Move waiting group seed to PB parent channel",
      );
      const roleFailures = [];
      const seedRoleFailure = await addRoleForTransfer(
        seedMember,
        config.participantRole,
        config.participantMemberIds,
      );

      if (seedRoleFailure) {
        roleFailures.push(seedRoleFailure);
      }

      const childChannel = await waitForPbChildChannel(seedMember, config);

      if (!childChannel) {
        return {
          childChannelId: null,
          lines: ["PBの子VCを検出できませんでした。"],
        };
      }

      let movedCount = 1;
      const movedMemberIds = [seedMember.id];
      const failed = [];

      for (const member of members.slice(1)) {
        try {
          await member.voice.setChannel(
            childChannel,
            "Move waiting group members to PB child channel",
          );
          const roleFailure = await addRoleForTransfer(
            member,
            config.participantRole,
            config.participantMemberIds,
          );

          if (roleFailure) {
            roleFailures.push(roleFailure);
          }

          movedCount += 1;
          movedMemberIds.push(member.id);
        } catch {
          failed.push(member.displayName);
        }
      }

      const failedText =
        failed.length > 0 ? ` 転送失敗: ${failed.join("、")}` : "";
      const roleFailedText =
        roleFailures.length > 0
          ? ` 参加者ロール付与失敗: ${roleFailures.join("、")}`
          : "";
      lines.push(
        `${childChannel.name} へ ${movedCount}/${members.length} 人を転送しました。${failedText}${roleFailedText}`,
      );

      return {
        childChannelId: childChannel.id,
        movedMemberIds,
        lines,
      };
    } catch (error) {
      return {
        childChannelId: null,
        lines: [`転送中に失敗しました。${error.message}`],
      };
    }
  }

  async function runEndNotificationFlow(options) {
    const notificationCanceled = await runCountdown({
      channel: options.channel,
      ownerId: options.ownerId,
      totalMs: options.noticeWaitMs,
      updateEveryMs: COUNTDOWN_UPDATE_MS,
      buttonLabel: "終了通知キャンセル",
      cancelText: "終了通知はキャンセルされました。参加者ロールをすぐ解除します。",
      autoCancelWhen: () => areAllChannelsGone(options.guild, options.childChannelIds),
      render: (remainingMs) =>
        `終了通知まで残り ${formatDuration(remainingMs)} です。\nキャンセルできるのはコマンド実行者のみです。`,
    });

    const finishActionKey = `split-finish-notice:${options.sessionId}`;
    const roleActionKey = `split-role-remove:${options.sessionId}`;
    if (notificationCanceled) {
      const skippedFinish = await claimAction(finishActionKey);
      if (skippedFinish) await finishAction(finishActionKey, "completed", "Notification canceled");
      const cancelText =
        notificationCanceled === "auto"
          ? "PBの子VCがすべて削除されたため、終了通知を自動キャンセルしました。参加者ロールを解除します。"
          : "終了通知をキャンセルしました。参加者ロールを解除します。";

      if (notificationCanceled === "auto") {
        await sendOperationalLog({
          guild: options.guild,
          settings: options.settings,
          fallbackChannel: options.channel,
          content: cancelText,
        });
      } else {
        await options.channel.send(cancelText);
      }
      if (options.temporaryWaitingVc) {

        if (options.temporaryWaitingVcDeleteTimer) {
          clearTimeout(options.temporaryWaitingVcDeleteTimer);
        }

        const fetchedChannel =
          await options.guild.channels.fetch(
            options.temporaryWaitingVc.id,
          ).catch(() => null);

        if (fetchedChannel) {
          await notifyWaitingVcClosure(options.channel, fetchedChannel);
          const deleted = await fetchedChannel.delete()
            .then(() => true)
            .catch(() => false);

          if (deleted) {
            await editSplitStartAnnouncementClosed(options.splitStartMessage);
          }

          await sendOperationalLog({
            guild: options.guild,
            settings: options.settings,
            fallbackChannel: options.channel,
            content: "待機用VCを削除しました。",
          });
        }
      }
      const canceledRoleClaim = await claimAction(roleActionKey);
      const cleanupMemberIds = await collectRoleCleanupMemberIds(
        options.guild,
        options.roleId,
      );
      const cleanupResult = await removeRoleFromMembers(
        options.guild,
        options.roleId,
        cleanupMemberIds,
      );
      if (cleanupResult.failed > 0) {
        if (canceledRoleClaim) {
          await failAction(roleActionKey, `Failed to remove role from ${cleanupResult.failed} member(s)`).catch(() => {});
        }
        throw new Error(`Failed to remove role from ${cleanupResult.failed} member(s)`);
      }
      if (canceledRoleClaim) await finishAction(roleActionKey);
      await persistSplitProcessSession(options.sessionId, { roleRemovalCompleted: true, waitingVcCleanupCompleted: true });

      await sendOperationalLog({
        guild: options.guild,
        settings: options.settings,
        fallbackChannel: options.channel,
        content: `参加者ロールを解除しました。解除成功: ${cleanupResult.removed}人、解除失敗: ${cleanupResult.failed}人。`,
      });
      await sendSplitClosingThanks(
        options.guild,
        options.settings,
        options.participantMemberIds,
      );
      options.state.ended = true;
      await persistSplitProcessSession(options.sessionId, {
        status: "completed",
        phase: "completed",
        completedAt: new Date(),
      });
      return;
    }

    const finishClaim = await claimAction(finishActionKey);
    if (!finishClaim) return;
    await options.channel.send({
      content: `<@&${options.roleId}> ${options.finishMessage}`,
      allowedMentions: { roles: [options.roleId] },
    });
    await finishAction(finishActionKey);

    await sleep(options.roleRemoveWaitMs);

    const roleClaim = await claimAction(roleActionKey);
    if (!roleClaim) return;

    const cleanupMemberIds = await collectRoleCleanupMemberIds(
      options.guild,
      options.roleId,
    );
    const cleanupResult = await removeRoleFromMembers(
      options.guild,
      options.roleId,
      cleanupMemberIds,
    );
    if (cleanupResult.failed > 0) {
      await failAction(roleActionKey, `Failed to remove role from ${cleanupResult.failed} member(s)`).catch(() => {});
      throw new Error(`Failed to remove role from ${cleanupResult.failed} member(s)`);
    }
    await finishAction(roleActionKey);
    await persistSplitProcessSession(options.sessionId, { roleRemovalCompleted: true, waitingVcCleanupCompleted: !options.temporaryWaitingVc });

    await sendOperationalLog({
      guild: options.guild,
      settings: options.settings,
      fallbackChannel: options.channel,
      content: `参加者ロールを解除しました。解除成功: ${cleanupResult.removed}人、解除失敗: ${cleanupResult.failed}人。`,
    });
    await sendSplitClosingThanks(
      options.guild,
      options.settings,
      options.participantMemberIds,
    );
    options.state.ended = true;
    await persistSplitProcessSession(options.sessionId, {
      status: "completed",
      phase: "completed",
      completedAt: new Date(),
    });
  }

  async function persistWaitingGroupMembers(options, channelId, memberIds, processName) {
    const groupMembers = options.currentGroupMembers.get(channelId) ?? new Set();
    for (const memberId of memberIds) {
      groupMembers.add(memberId);
    }
    options.currentGroupMembers.set(channelId, groupMembers);

    try {
      await addMembersToCurrentGroup({
        guildId: options.guild.id,
        sessionId: options.groupingSessionId,
        channelId,
        memberIds,
      });
      await persistSplitParticipantMemberIds(
        options.sessionId,
        options.participantMemberIds,
      );
    } catch (error) {
      await sendSplitGroupingLog({
        guild: options.guild,
        settings: options.settings,
        content: `[splitvc-history] current update failed guild=${options.guild.id} session=${options.groupingSessionId} users=${memberIds.join(",")} channel=${channelId} process=${processName} error=${error.name ?? "Error"}: ${error.message ?? error}`,
      });
    }
  }

  async function removeRoleFromMembers(guild, roleId, memberIds) {
    let removed = 0;
    let failed = 0;

    for (const memberId of memberIds) {
      try {
        const member = await guild.members.fetch(memberId);

        if (member.roles.cache.has(roleId)) {
          await member.roles.remove(roleId, "Remove participant voice grouping role");
          removed += 1;
        }
      } catch {
        failed += 1;
      }
    }

    return { removed, failed };
  }

  async function collectRoleCleanupMemberIds(guild, roleId) {
    const memberIds = new Set();
    await guild.members.fetch().catch(() => null);
    const role =
      guild.roles.cache.get(roleId) ??
      (await guild.roles.fetch(roleId).catch(() => null));

    for (const member of role?.members.values() ?? []) {
      memberIds.add(member.id);
    }

    return memberIds;
  }

  async function areAllChannelsGone(guild, channelIds) {
    const ids = [...channelIds];

    if (ids.length === 0) {
      return false;
    }

    for (const channelId of ids) {
      const cachedChannel = guild.channels.cache.get(channelId);

      if (cachedChannel) {
        return false;
      }

      const fetchedChannel = await guild.channels
        .fetch(channelId)
        .catch(() => null);

      if (fetchedChannel) {
        return false;
      }
    }

    return true;
  }

  async function runCountdown(options) {
    if (options.totalMs <= 0) {
      return false;
    }

    const sessionId = createSessionId();
    const session = {
      ownerId: options.ownerId,
      canceled: false,
      cancelText: options.cancelText,
    };

    activeSessions.set(sessionId, session);

    const message = await options.channel.send({
      content: options.render(options.totalMs),
      components: [createCancelRow(sessionId, options.buttonLabel)],
    });

    const startedAt = Date.now();

    while (Date.now() - startedAt < options.totalMs) {
      if (session.canceled) {
        activeSessions.delete(sessionId);
        await deleteLater(message);
        return true;
      }

      const elapsedMs = Date.now() - startedAt;
      const remainingMs = Math.max(0, options.totalMs - elapsedMs);
      await sleep(Math.min(options.updateEveryMs, remainingMs));

      if (!session.canceled && options.autoCancelWhen) {
        const shouldAutoCancel = await options.autoCancelWhen();

        if (shouldAutoCancel) {
          activeSessions.delete(sessionId);
          await editSafely(message, {
            content: "PBの子VCがすべて削除されたため、終了通知を自動キャンセルします。",
            components: [],
          });
          await deleteLater(message);
          return "auto";
        }
      }

      if (!session.canceled) {
        await editSafely(message, {
          content: options.render(Math.max(0, options.totalMs - (Date.now() - startedAt))),
          components: [createCancelRow(sessionId, options.buttonLabel)],
        });
      }
    }

    activeSessions.delete(sessionId);
    await deleteLater(message);
    return false;
  }

  async function handleSessionButton(interaction) {
    if (!interaction.customId.startsWith("session_cancel:")) {
      return;
    }

    const sessionId = interaction.customId.slice("session_cancel:".length);
    const session = activeSessions.get(sessionId);

    if (!session) {
      await interaction.reply({
        content: "この待機操作はすでに終了しています。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (interaction.user.id !== session.ownerId) {
      await interaction.reply({
        content: "このボタンを押せるのは、コマンドを実行した人だけです。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    session.canceled = true;
    await interaction.update({
      content: session.cancelText,
      components: [],
    });
  }

  function createCancelRow(sessionId, label) {
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`session_cancel:${sessionId}`)
        .setLabel(label)
        .setStyle(ButtonStyle.Danger),
    );
  }

  function formatLegacySettings(settings) {
    if (!settings) {
      return "PB連携設定はまだ保存されていません。";
    }

    return [
      "【/splitvc・PB連携】",
      `参加者ロール: ${settings.tempRoleId ? `<@&${settings.tempRoleId}>` : "未設定"}`,
      `PB親チャンネル: ${settings.parentChannelId ? `<#${settings.parentChannelId}>` : "未設定"}`,
      `子VCカテゴリ: ${settings.childCategoryId ? `<#${settings.childCategoryId}>` : "未設定"}`,
      `告知の概要案内チャンネル: ${getKokuchiOverviewChannelId(settings) ? `<#${getKokuchiOverviewChannelId(settings)}>` : "未設定"}`,
      `待機VCカテゴリ: ${settings.waitingVcCategoryId ? `<#${settings.waitingVcCategoryId}>` : "未設定"}`,
      `待機VC名: ${settings.waitingVcName || DEFAULT_WAITING_VC_NAME}`,
      `転送前待機: ${getNonNegativeInteger(settings.transferWaitSeconds, DEFAULT_TRANSFER_WAIT_SECONDS)}秒`,
      `終了通知前待機: ${getNonNegativeInteger(settings.noticeWaitMinutes, DEFAULT_NOTICE_WAIT_MINUTES)}分`,
      `通知後ロール解除待機: ${getNonNegativeInteger(settings.roleRemoveWaitMinutes, DEFAULT_ROLE_REMOVE_WAIT_MINUTES)}分`,
      `終了通知文: ${settings.finishMessage || DEFAULT_FINISH_MESSAGE}`,
      "",
      "【/b 募集】",
      `使用チャンネル: ${settings.bosyuChannelId ? `<#${settings.bosyuChannelId}>` : "制限なし"}`,
      `メンションロール: ${settings.bosyuMentionRoleId ? `<@&${settings.bosyuMentionRoleId}>` : "未設定"}`,
      "",
      "【VC集合フォーム】",
      `機能: ${settings.voiceReminderEnabled === false ? "無効" : "有効"}`,
      `対象PB親VC: ${settings.voiceReminderParentChannelId ? `<#${settings.voiceReminderParentChannelId}>` : "未設定"}`,
      `対象子VCカテゴリ: ${settings.voiceReminderChildCategoryId ? `<#${settings.voiceReminderChildCategoryId}>` : "未設定"}`,
      `参加者ロール: ${settings.voiceParticipantRoleId ? `<@&${settings.voiceParticipantRoleId}>` : "未設定"}`,
      "",
      "【おすすめ話題・案内】",
      `/kokuchi告知・スタート案内送信先: ${getKokuchiAnnouncementChannelId(settings) ? `<#${getKokuchiAnnouncementChannelId(settings)}>` : "未設定"}`,
      `/splitvc後の最初の話題送信先: ${settings.postSplitWadaiChannelId ? `<#${settings.postSplitWadaiChannelId}>` : "実行チャンネル"}`,
      `/kokuchi話題送信: ${settings.kokuchiTopicEnabled === false ? "送信しない" : "送信する"}`,
      `最後に選ばれた話題: ${settings.wadaiCurrentTopic?.text ?? "未設定"}`,
      `集合VC: ${settings.gatheringVoiceChannelId ? `<#${settings.gatheringVoiceChannelId}>` : "未設定"}`,
      `終了後意見・苦情チャンネル: ${settings.splitFeedbackChannelId ? `<#${settings.splitFeedbackChannelId}>` : `<#${DEFAULT_SPLIT_FEEDBACK_CHANNEL_ID}>`}`,
      "",
      "【意見・相談フォーム】",
      `フォーム設置先: ${settings.formChannelId ? `<#${settings.formChannelId}>` : "未設定"}`,
      `フォーム転送先: ${settings.formSendChannelId ? `<#${settings.formSendChannelId}>` : "未設定"}`,
      `モデレーターロール: ${settings.formModeratorRoleId ? `<@&${settings.formModeratorRoleId}>` : "未設定"}`,
      "",
      "【運用ログ】",
      `送信先: ${settings.logChannelId ? `<#${settings.logChannelId}>` : "未設定"}`,
      "",
      "【通話待機システム】",
      `機能: ${settings.callWaitEnabled === true ? "有効" : "無効"}`,
      `募集方式: ${normalizeCallWaitMode(settings.callWaitMode) === CALL_WAIT_MODE_BUTTON ? "ボタン式" : "リアクション式"}`,
      `参加希望者ロール: ${settings.callWaitRoleId ? `<@&${settings.callWaitRoleId}>` : "未設定"}`,
      `募集メッセージ送信先: ${getCallWaitPromptChannelId(settings) ? `<#${getCallWaitPromptChannelId(settings)}>` : "未設定"}`,
      `集合通知送信先: ${getCallWaitNoticeChannelId(settings) ? `<#${getCallWaitNoticeChannelId(settings)}>` : "未設定"}`,
      `お手軽募集の30分前までの掲載先: ${settings.oteboPreviewChannelId ? `<#${settings.oteboPreviewChannelId}>` : "未設定"}`,
      `参加確認VCカテゴリ: ${settings.callWaitVoiceCategoryId ? `<#${settings.callWaitVoiceCategoryId}>` : "未設定"}`,
      `募集ロール途中参加案内: ${settings.callWaitBosyuNoticeEnabled === true ? "有効" : "無効"}`,
      `お手軽募集の即時募集キャンセル猶予: ${getOteboQuickConfirmSeconds(settings)}秒`,
    ].join("\n");
  }

  function formatSettings(settings) {
    const text = formatLegacySettings(settings);
    if (!settings) return text;
    return `${text}\n自己紹介チャンネル: ${settings.profileIntroductionChannelId ? `<#${settings.profileIntroductionChannelId}>` : "未設定"}\nVCコントロール対象カテゴリ: ${settings.vcControlCategoryId ? `<#${settings.vcControlCategoryId}>` : "未設定"}\nVCタイマー通知ロール: ${settings.vcControlNotifyRoleId ? `<@&${settings.vcControlNotifyRoleId}>` : "未設定"}`;
  }

  async function persistSplitParticipantMemberIds(sessionId, participantMemberIds) {
    if (!sessionId || participantMemberIds.size === 0) {
      return;
    }

    await SplitProcessSession.updateOne(
      { sessionId },
      { $addToSet: { participantMemberIds: { $each: [...participantMemberIds] } } },
    );
  }

  function formatResult(channel, total, groups) {
    const lines = [
      `**${channel.name} のグループ分け**`,
      describeGroups(total, groups),
      "",
    ];

    groups.forEach((group, index) => {
      const members = group
        .map((member) => `- ${escapeMarkdown(member.displayName)}`)
        .join("\n");

      lines.push(`**グループ ${index + 1} (${group.length}人)**`);
      lines.push(members);
      lines.push("");
    });

    return lines.join("\n").trim();
  }

  function escapeMarkdown(text) {
    return text.replace(/([\\`*_{}[\]()#+\-.!|>])/g, "\\$1");
  }

  function splitMessage(content, maxLength = MESSAGE_LIMIT) {
    const chunks = [];
    let current = "";

    for (const line of content.split("\n")) {
      if (line.length > maxLength) {
        if (current) {
          chunks.push(current);
          current = "";
        }

        for (let index = 0; index < line.length; index += maxLength) {
          chunks.push(line.slice(index, index + maxLength));
        }

        continue;
      }

      const next = current ? `${current}\n${line}` : line;

      if (next.length > maxLength) {
        chunks.push(current);
        current = line;
      } else {
        current = next;
      }
    }

    if (current) {
      chunks.push(current);
    }

    return chunks.length > 0 ? chunks : [content];
  }

  async function replyInChunks(interaction, content, options) {
    const chunks = splitMessage(content);
    const [firstChunk, ...restChunks] = chunks;

    await interaction.reply({
      ...options,
      content: firstChunk,
    });

    for (const chunk of restChunks) {
      await interaction.followUp({
        ...options,
        content: chunk,
      });
    }
  }

  async function sendChunked(channel, content, options = {}) {
    for (const chunk of splitMessage(content)) {
      await channel.send({
        ...options,
        content: chunk,
      });
    }
  }

  async function replySafely(interaction, content) {
    const payload = {
      content,
      flags: MessageFlags.Ephemeral,
    };

    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(payload).catch(() => null);
    } else {
      await interaction.reply(payload).catch(() => null);
    }
  }

  async function replyOrFollowUp(interaction, payload) {
    if (!payload || typeof payload !== "object") {
      payload = { content: String(payload ?? ""), flags: MessageFlags.Ephemeral };
    }

    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(payload).catch(() => null);
    } else {
      await interaction.reply(payload).catch(() => null);
    }
  }

  async function editSafely(message, payload) {
    await message.edit(payload).catch(() => null);
  }

  function formatVoiceTopicStatus(topicText) {
    const normalizedTopicText = String(topicText ?? "")
      .replace(/\s+/g, " ")
      .trim();

    return normalizedTopicText ? `今の話題：${normalizedTopicText}` : "";
  }

  async function setVoiceChannelStatus(voiceChannel, status, reason) {
    if (!voiceChannel?.isVoiceBased()) {
      throw new Error("Target channel is not a voice channel.");
    }

    await client.rest.put(`/channels/${voiceChannel.id}/voice-status`, {
      body: { status },
      reason,
    });
  }

  async function deleteLater(message) {
    await sleep(1500);
    await message.delete().catch(() => null);
  }

  async function notifyWaitingVcClosure(operationChannel, waitingVc) {
    const waitingMembers = [...waitingVc.members.values()].filter(
      (member) => !member.user.bot,
    );

    if (waitingMembers.length === 0) {
      return;
    }

    await operationChannel.send(
      "誠に申し訳ございませんが、途中参加の条件がそろわなかったため途中参加部屋が削除されました。次の機会があればぜひまたご参加ください",
    );
  }

  function getSendableChannel(interaction) {
    const channel = interaction.channel;
    return channel && typeof channel.send === "function" ? channel : null;
  }

  function createSessionId() {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  }

  function addMany(set, values) {
    for (const value of values) {
      set.add(value);
    }
  }

  function formatDuration(ms) {
    const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;

    return `${minutes}分${seconds.toString().padStart(2, "0")}秒`;
  }

  function getNonNegativeInteger(value, fallback) {
    return Number.isInteger(value) && value >= 0 ? value : fallback;
  }

  function secondsToMs(seconds) {
    return seconds * 1000;
  }

  function minutesToMs(minutes) {
    return minutes * 60 * 1000;
  }

  function sleep(ms) {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  function startHealthServer(port) {
    const startedAt = new Date();

    const server = createServer((request, response) => {
      const path = request.url?.split("?")[0] ?? "/";

      if (request.method === "GET" && (path === "/" || path === "/health")) {
        const body = JSON.stringify({
          ok: true,
          ready: client.isReady(),
          bot: client.user?.tag ?? null,
          uptimeSeconds: Math.round(process.uptime()),
          startedAt: startedAt.toISOString(),
        });

        response.writeHead(200, {
          "cache-control": "no-store",
          "content-type": "application/json; charset=utf-8",
        });
        response.end(body);
        return;
      }

      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not Found");
    });

    server.listen(port, "0.0.0.0", () => {
      console.log(`Health server listening on port ${port}`);
    });
  }

  async function resolveStartupLogChannelId() {
    if (PB_LOG_CHANNEL_ID?.trim()) {
      return PB_LOG_CHANNEL_ID.trim();
    }

    if (DISCORD_GUILD_ID) {
      const settings = await getGuildSettings(DISCORD_GUILD_ID);
      if (settings?.logChannelId) {
        return settings.logChannelId;
      }
    }

    if (!client.isReady()) {
      return null;
    }

    for (const guild of client.guilds.cache.values()) {
      const settings = await getGuildSettings(guild.id);
      if (settings?.logChannelId) {
        return settings.logChannelId;
      }
    }

    return null;
  }

  async function resolveTextChannelById(channelId) {
    if (!channelId) {
      return null;
    }

    const textTypes = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
    const channel = await client.channels.fetch(channelId).catch(() => null);

    return channel &&
      textTypes.includes(channel.type) &&
      typeof channel.send === "function"
      ? channel
      : null;
  }

  function formatMongoError(error) {
    if (error instanceof Error) {
      return error.stack || `${error.name}: ${error.message}`;
    }

    return String(error);
  }

  function truncateForEmbed(text, maxLength = 1000) {
    if (text.length <= maxLength) {
      return text;
    }

    return `${text.slice(0, maxLength - 3)}...`;
  }

  function createMongoStartupEmbed({ success, error }) {
    const embed = {
      title: success ? "MongoDB接続成功" : "MongoDB接続失敗",
      description: success
        ? "MongoDB Atlasへの接続に成功しました。"
        : "MongoDB Atlasへの接続に失敗しました。Botを終了します。",
      color: success ? 0x57F287 : 0xED4245,
      timestamp: new Date().toISOString(),
    };

    if (error) {
      const details = truncateForEmbed(formatMongoError(error));
      embed.fields = [{ name: "エラー詳細", value: `\`\`\`\n${details}\n\`\`\`` }];
    }

    return embed;
  }

  async function sendMongoStartupEmbed({ success, error = null }) {
    const logChannelId = await resolveStartupLogChannelId();
    if (!logChannelId) {
      return false;
    }

    const channel = await resolveTextChannelById(logChannelId);
    if (!channel) {
      return false;
    }

    await channel.send({
      embeds: [createMongoStartupEmbed({ success, error })],
      allowedMentions: { parse: [] },
    });
    return true;
  }

  async function waitForClientReady(timeoutMs = 30_000) {
    if (client.isReady()) {
      return;
    }

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("Discord client did not become ready in time."));
      }, timeoutMs);

      const handleReady = () => {
        cleanup();
        resolve();
      };

      const handleError = (error) => {
        cleanup();
        reject(error);
      };

      function cleanup() {
        clearTimeout(timeout);
        client.off(Events.ClientReady, handleReady);
        client.off(Events.Error, handleError);
      }

      client.on(Events.ClientReady, handleReady);
      client.on(Events.Error, handleError);
    });
  }

  async function ensureDiscordReadyForStartupLog() {
    if (client.isReady()) {
      return true;
    }

    try {
      await client.login(DISCORD_TOKEN);
      await waitForClientReady();
      return true;
    } catch (error) {
      console.error("Failed to login to Discord for MongoDB startup failure logging.", error);
      return false;
    }
  }

  async function loginDiscordClient() {
    console.log("Attempting to login to Discord...");

    discordReadyWatchdog = setTimeout(() => {
      if (!client.isReady()) {
        console.error(
          `Discord client did not become ready within 30 seconds. wsStatus=${client.ws.status}`,
        );
      }
    }, 30_000);

    try {
      await client.login(DISCORD_TOKEN);
    } catch (error) {
      if (discordReadyWatchdog) {
        clearTimeout(discordReadyWatchdog);
        discordReadyWatchdog = null;
      }
      console.error(
        "Failed to login to Discord. Check DISCORD_TOKEN and bot application settings.",
        error,
      );
      throw error;
    }
  }

  async function startBot() {
    console.log(`Node.js runtime: ${process.version}`);
    console.log(`discord.js version: ${discordJsVersion}`);

    try {
      await connectToMongoDB();
      shouldSendMongoSuccessLog = true;
    } catch (error) {
      console.error("Failed to connect to MongoDB Atlas.", error);

      const readyForLog = await ensureDiscordReadyForStartupLog();

      if (readyForLog) {
        const sent = await sendMongoStartupEmbed({ success: false, error }).catch(
          (sendError) => {
            console.error("Failed to send MongoDB failure log embed.", sendError);
            return false;
          },
        );

        if (!sent) {
          console.error(
            "MongoDB connection failed, and startup log channel could not be resolved or used.",
          );
        }
      } else {
        console.error(
          "MongoDB connection failed before Discord logging became available.",
        );
      }

      process.exit(1);
      return;
    }

    await loginDiscordClient();
  }

  await startBot();
