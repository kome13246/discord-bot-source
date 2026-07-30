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
import { connectToMongoDB, disconnectFromMongoDB } from "./mongodb.js";
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
import { cancelKokuchiTimedActions, claimCallWaitPendingNotice, deleteOteboRecruitmentIfOnlyMember, failCallWaitPendingNotice, getGuildSettings, recoverInterruptedCallWaitPendingNotices, recoverInterruptedCallWaitPrompts, recoverInterruptedKokuchiGatheringReminders, replaceNestedObject, saveGuildSettings, transitionCallWaitPrompt, transitionKokuchiGatheringReminder, transitionKokuchiTimedAction, transitionOteboRecruitment, updateCallWaitPromptMember, updateOteboRecruitmentParticipant, unsetNestedObject } from "./settings-store.js";
import { cancelKokuchiScheduledActions, claimAction, failAction, finishAction, getPendingActions, recoverInterruptedActions, retryAction, scheduleAction, scheduleSingleGuildAction } from "./scheduled-action-store.js";
import { consumeBosyuCooldown, deleteBosyuEditSession, getActiveBosyuEditSessions, getBosyuEditSession, getExpiredBosyuEditSessions, saveBosyuEditSession } from "./bosyu-state-store.js";
import { SplitProcessSession } from "./models/split-process-session.js";
import { SplitReview } from "./models/split-review.js";
import { SplitReviewDraft } from "./models/split-review-draft.js";
import { ScheduledAction } from "./models/scheduled-action.js";
import {
  addMembersToCurrentGroup,
  getSplitGroupingState,
  startSplitGrouping,
} from "./split-grouping-state-store.js";
import mongoose from "mongoose";
import { UserProfile } from "./models/user-profile.js";
import {
  ensureVoiceParticipantRoleGrantIndexes,
  VoiceParticipantRoleGrant,
} from "./models/voice-participant-role-grant.js";
import { CallWaitInterest } from "./models/call-wait-interest.js";
import { KokuchiReservation } from "./models/kokuchi-reservation.js";
import { MongoLeaseLock } from "./models/mongo-lease-lock.js";
import { acquireMongoLease, releaseMongoLease } from "./mongo-lease-lock-store.js";
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
  createEveryonePermissionSnapshot,
  countUniqueParticipantIds,
  editEveryoneConnectPermission,
  formatSplitClosingThanks,
  getRestorePermissionPatch,
  isKokuchiCallWaitPause,
  resolveKokuchiGatheringVoiceChannelId,
} from "./kokuchi-utils.js";
import { formatJstReservationTime, getInterestCooldownSeconds, getKokuchiEventDate, getKokuchiReminderStatusOnCancel, getNextKokuchiEventAt, getNextKokuchiReservationAt } from "./kokuchi-reservation-utils.js";
import {
  CALL_WAIT_INTERVAL_MINUTES,
  createCallWaitSlotKey,
  getMsUntilNextJstCallWaitSlot,
  getNextJstCallWaitSlot,
  isJstCallWaitSlotDue,
  normalizeCallWaitIntervalMinutes,
} from "./call-wait-schedule-utils.js";
import { toCurrentGroupMemberIds } from "./split-waiting-utils.js";

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
const WAITING_MONITOR_LEASE_MS = 30 * 1000;
const DEFAULT_TRANSFER_WAIT_SECONDS = 30;
const DEFAULT_NOTICE_WAIT_MINUTES = 25;
const DEFAULT_ROLE_REMOVE_WAIT_MINUTES = 150;
const SPLIT_REVIEW_OPEN = "split_review_open";
const SPLIT_REVIEW_SELECT = "split_review_select";
const SPLIT_REVIEW_SUBMIT = "split_review_submit";
const SPLIT_REVIEW_MODAL = "split_review_comment";
const SPLIT_RANDOM_TOPIC = "split_random_topic";
const TALK_AMOUNT_LABELS = {
  much: "かなり話せた",
  moderate: "そこそこだった",
  little: "あまり話せなかった",
};
const DURATION_FEELING_LABELS = {
  long: "少し長かった",
  just_right: "ちょうどよかった",
  short: "少し短かった",
};
const PRACTICE_EFFECT_LABELS = {
  much: "かなりなった",
  some: "すこしはなった",
  little: "あまりならなかった",
};
const DEFAULT_WAITING_VC_NAME = "途中参加部屋";
const COUNTDOWN_UPDATE_MS = 1000;
const PB_CHILD_WAIT_MS = 20 * 1000;
const DEFAULT_FINISH_MESSAGE =
  "30分が経過しました！各々のちょうどいいタイミングで解散してください";
const MESSAGE_LIMIT = 1900;
const CALL_WAIT_MIN_MEMBERS = 2;
const CALL_WAIT_ROLE_REMOVE_MS = 30 * 60 * 1000;
const CALL_WAIT_FOLLOWUP_CHECK_MS = 30 * 60 * 1000;
const CALL_WAIT_FOLLOWUP_RETRY_MS = 5 * 60 * 1000;
const CALL_WAIT_MODE_BUTTON = "button";
const CALL_WAIT_JOIN_CUSTOM_ID = "call_wait_join";
const CALL_WAIT_CANCEL_CUSTOM_ID = "call_wait_cancel";
const CALL_WAIT_INTEREST_CUSTOM_ID = "call_wait_interest";
const CALL_WAIT_INTEREST_SELECT_CUSTOM_ID = "call_wait_interest_threshold";
const KOKUCHI_RESERVATION_CANCEL_CUSTOM_ID = "kokuchi_reservation_cancel";
const KOKUCHI_RESERVATION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
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
const DEFAULT_SPLIT_FEEDBACK_CHANNEL_ID = "1513457664041160765";

const activeSessions = new Map();
const bumpReminderTimers = new Map();
const lastBosyuTimestamps = new Map();
const bosyuEditSessions = new Map();
const voiceMonitorSessions = new Map();
const voiceMonitorPendingFormDeletions = new Map();
// Serialize only each member's voice-monitor role reconciliation. Discord can
// deliver overlapping VoiceStateUpdate events for the same member.
const voiceParticipantRoleQueues = new Map();
const voiceParticipantRoleRetryTimers = new Map();
const voiceParticipantRoleFinalFailureLogs = new Set();
const VOICE_PARTICIPANT_ROLE_MAX_RETRIES = 3;
const VOICE_PARTICIPANT_ROLE_RETRY_DELAYS_MS = [5_000, 15_000, 30_000];
const topicFormSessions = new Map();
const autoSplitSuggestionMessages = new Map();
const callWaitRoleRemovalTimers = new Map();
const callWaitFollowupTimers = new Map();
const callWaitGuildLocks = new Set();
const gatheringVcUnlockTimers = new Map();
const kokuchiPreNoticeTimers = new Map();
const kokuchiGatheringReminderTimers = new Map();
const kokuchiReservationTimers = new Map();
const kokuchiPublishGuildLocks = new Set();
const oteboDrafts = new Map();
const oteboRecruitmentTimers = new Map();
const profilePublicationLocks = new Set();
const splitVoiceGuildLocks = new Set();
const activeSplitVoiceLeases = new Map();
const autoSplitLocks = new Set();
const waitingMemberRetryAfter = new Map();
const restoredWaitingMonitorTimers = new Map();
const restoredWaitingMonitorLocks = new Set();
const localWaitingMonitorSessions = new Set();
const waitingMonitorLeaseOwner = `${process.pid}:${Math.random().toString(36).slice(2)}`;
const lastTopicIdByChildChannel = new Map();
const randomTopicCooldownByChannel = new Map();

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
let startupRestoreCompleted = false;
let startupRestoreFailed = false;
let shuttingDown = false;
let processingScheduledCallWaitTick = false;

function getKokuchiReservationCleanupAt(now = new Date()) {
  return new Date(now.getTime() + KOKUCHI_RESERVATION_RETENTION_MS);
}

function logRecoverableError(context, error) {
  console.error(`${context}: ${error?.message ?? error}`, error);
}

if (!DISCORD_TOKEN) {
  throw new Error("DISCORD_TOKEN is required.");
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    // Required for the documented normal-message features such as topic
    // requests and DISBOARD bump detection.  It must also be enabled in the
    // Discord Developer Portal for this application.
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
});
const voiceChannelControlService = createVoiceChannelControlService({ getGuildSettings, sendOperationalLog, setVoiceChannelStatus });

let discordReadyWatchdog = null;

const healthPort = Number(PORT ?? KEEP_ALIVE_PORT);

if (Number.isInteger(healthPort) && healthPort > 0) {
  startHealthServer(healthPort);
}

client.once(Events.ClientReady, async (readyClient) => {
  if (discordReadyWatchdog) {
    clearTimeout(discordReadyWatchdog);
    discordReadyWatchdog = null;
  }
  console.log(`Logged in as ${readyClient.user.tag}`);
  const restoreResults = await Promise.allSettled([
    recoverInterruptedCallWaitPrompts(),
    recoverInterruptedCallWaitPendingNotices(),
    recoverInterruptedKokuchiGatheringReminders(),
    restoreBumpReminders(),
    restoreGatheringVcUnlockSchedules(),
    restorePendingGatheringVcPermissions(),
    restoreKokuchiReservations(),
    restoreOteboRecruitmentTimers(),
    restoreFailedSplitReviewDeliveries(),
    restoreProfiles(client, { sendOperationalLog, getGuildSettings }),
    restoreScheduledActions(),
    restoreBosyuEditSessions(),
    restoreSplitProcessSessions(),
    restoreVoiceMonitorSessions(),
    voiceChannelControlService.restore(client),
  ]);
  for (const result of restoreResults) {
    if (result.status === "rejected") {
      startupRestoreFailed = true;
      console.error("Startup restore failed:", result.reason);
    }
  }
  startupRestoreCompleted = true;
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
  // Do not wait until the next interval tick after a restart. This closes
  // overdue recruitments and calculates the next configured JST slot.
  await processCallWaitForAllGuilds().catch((error) => {
    console.error("Initial call-wait processing failed:", error);
  });
  await retryPendingCallWaitEndNotifications().catch((error) => {
    console.error("Initial call-wait end-notification retry failed:", error);
  });
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
  if (shuttingDown) return;
  try {
    await handleDisboardBumpMessage(message);
    await handleTopicRequestMessage(message);
  } catch (error) {
    console.error("Message processing failed", {
      guildId: message.guildId ?? null,
      channelId: message.channelId ?? null,
      userId: message.author?.id ?? null,
      error: error?.stack ?? error,
    });
  }
});

client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  if (shuttingDown) return;
  // Keep the participant-role flow independent from unrelated voice features.
  try {
    await handleProfileVoiceState(oldState, newState, { client, sendOperationalLog, getGuildSettings });
  } catch (error) {
    logRecoverableError("Profile voice-state processing failed", error);
  }
  try {
    await handleVoiceStateUpdate(oldState, newState);
  } catch (error) {
    logRecoverableError("Voice participant role processing failed", error);
  }
});
client.on(Events.ChannelCreate, async (channel) => {
  if (channel.type === ChannelType.GuildVoice) await voiceChannelControlService.ensurePanel(channel).catch((error) => console.error("VC control panel create failed:", error));
});
client.on(Events.ChannelDelete, async (channel) => {
  if (channel.type === ChannelType.GuildVoice) await voiceChannelControlService.cleanup(channel).catch((error) => logRecoverableError("Recoverable asynchronous operation failed", error));
});
client.on(Events.ChannelUpdate, async (oldChannel, newChannel) => {
  if (newChannel.type !== ChannelType.GuildVoice) return;
  const settings = await getGuildSettings(newChannel.guild.id).catch(() => null);
  const wasTarget = oldChannel.parentId === settings?.vcControlCategoryId;
  const isTarget = newChannel.parentId === settings?.vcControlCategoryId;
  if (isTarget && !wasTarget) await voiceChannelControlService.ensurePanel(newChannel).catch((error) => logRecoverableError("Recoverable asynchronous operation failed", error));
  if (!isTarget && wasTarget) await voiceChannelControlService.cleanup(newChannel).catch((error) => logRecoverableError("Recoverable asynchronous operation failed", error));
});
client.on(Events.InteractionCreate, async (interaction) => {
  if (shuttingDown) {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.reply({
        content: "Botは再起動中です。少し待ってからもう一度お試しください。",
        flags: MessageFlags.Ephemeral,
      }).catch((error) => console.error("Failed to reply during shutdown:", error));
    }
    return;
  }
  try {
    if (interaction.isButton()) {
      if (interaction.customId.startsWith(`${SPLIT_REVIEW_OPEN}:`) || interaction.customId.startsWith(`${SPLIT_REVIEW_SUBMIT}:`)) { await handleSplitReviewButton(interaction); return; }
      if (interaction.customId.startsWith(`${SPLIT_RANDOM_TOPIC}:`)) { await handleSplitRandomTopicButton(interaction); return; }
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
        interaction.customId === CALL_WAIT_INTEREST_CUSTOM_ID ||
        interaction.customId === CALL_WAIT_CANCEL_CUSTOM_ID ||
        interaction.customId.startsWith(`${CALL_WAIT_CANCEL_CUSTOM_ID}:`) ||
        (interaction.isButton() && interaction.customId.startsWith("call_wait_interest_"))
      ) {
        await handleCallWaitButton(interaction);
        return;
      }

      if (interaction.customId.startsWith(`${KOKUCHI_RESERVATION_CANCEL_CUSTOM_ID}:`)) {
        await handleKokuchiReservationCancel(interaction);
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
      if (interaction.customId.startsWith(`${SPLIT_REVIEW_SELECT}:`)) { await handleSplitReviewSelect(interaction); return; }
      if (interaction.customId.startsWith("vc_control:")) { await voiceChannelControlService.handle(interaction); return; }
      if (interaction.customId.startsWith(`${OTEBO_DRAFT_SELECT_CUSTOM_ID}:`)) {
        await handleOteboDraftSelect(interaction);
        return;
      }

      if (interaction.customId.startsWith(`${CALL_WAIT_INTEREST_SELECT_CUSTOM_ID}:`)) {
        await handleCallWaitInterestThresholdSelect(interaction);
        return;
      }

      return;
    }

    if (interaction.isModalSubmit()) {
      if (interaction.customId.startsWith(`${SPLIT_REVIEW_MODAL}:`)) { await handleSplitReviewModal(interaction); return; }
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

    if (interaction.commandName === "remove") {
      await handleRemoveRole(interaction);
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
      return;
    }
async function handleShowReview(interaction) {
  if (!interaction.inGuild()) return;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const settings = await getGuildSettings(interaction.guildId);
  const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
  const canManageGuild = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
  const hasModeratorRole = settings?.formModeratorRoleId
    && member?.roles.cache.has(settings.formModeratorRoleId);
  if (!canManageGuild && !hasModeratorRole) {
    return interaction.editReply({
      content: "このコマンドを使用する権限がありません。",
      flags: MessageFlags.Ephemeral,
    });
  }
  const question = interaction.options.getString("question", true);
  const isAllQuestion = question === "all";
  const recent = interaction.options.getInteger("recent", false);
  let sessions = await SplitProcessSession.find({
    guildId: interaction.guildId,
    reviewAggregationEligible: true,
    status: { $in: ["feedback_open", "completed"] },
    isTestSession: { $ne: true },
  }).sort({ conversationStartedAt: -1, createdAt: -1 }).lean();
  if (recent) sessions = sessions.slice(0, recent);
  const sessionIds = sessions.map((session) => session.sessionId);
  const reviews = sessionIds.length
    ? await SplitReview.find({
      guildId: interaction.guildId,
      splitSessionId: { $in: sessionIds },
      questionnaireVersion: 1,
    }).lean()
    : [];
  const eligibleCount = sessions.reduce(
    (total, session) => total + (session.reviewEligibleMemberIds?.length ?? 0),
    0,
  );
  const dates = [...new Set(sessions
    .slice()
    .reverse()
    .map((session) => jstReviewDate(session.conversationStartedAt ?? session.createdAt)))];
  const dateText = dates.join("・");
  const scopeLines = [
    `対象：${recent ? `直近${recent}回` : "全期間"}`,
    recent
      ? `対象日：${dateText || "対象セッションはありません"}`
      : `対象期間：${dateText ? `${dates[0]}〜${dates[dates.length - 1]}` : "対象セッションはありません"}`,
    `開催回数：${sessions.length}回`,
    `延べ参加者数：${eligibleCount}人`,
    ...(isAllQuestion ? [
      `回答数：${reviews.length}件`,
      `回答率：${eligibleCount ? `${(reviews.length / eligibleCount * 100).toFixed(1)}%` : "算出不可"}`,
    ] : []),
  ];

  const fields = {
    "1": { field: "talkAmount", title: "どれくらい喋れた？", choices: [["much", "かなり話せた"], ["moderate", "そこそこだった"], ["little", "あまり話せなかった"]] },
    "2": { field: "durationFeeling", title: "時間はどう感じた？", choices: [["long", "少し長かった"], ["just_right", "ちょうどよかった"], ["short", "少し短かった"]] },
    "3": { field: "practiceEffect", title: "会話の練習になった？", choices: [["much", "かなりなった"], ["some", "すこしはなった"], ["little", "あまりならなかった"]] },
  };

  const renderQuestion = ({ field, title, choices }) => {
    const valid = reviews.filter((review) => choices.some(([value]) => review[field] === value));
    if (!valid.length) return `【${title}】\n回答はまだありません。`;

    const resultLines = choices.map(([value, label]) => {
      const count = valid.filter((review) => review[field] === value).length;
      return `${label}：${count}票（${(count / valid.length * 100).toFixed(1)}%）`;
    });
    return [
      `【${title}】`,
      ...(!isAllQuestion ? [
        `回答数：${valid.length}件`,
        `回答率：${eligibleCount ? `${(valid.length / eligibleCount * 100).toFixed(1)}%` : "算出不可"}`,
      ] : []),
      "",
      ...resultLines,
    ].join("\n");
  };

  if (question !== "all" && !fields[question]) {
    await interaction.editReply({
      content: "選択した質問は集計できません。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const renderedQuestions = ["1", "2", "3"]
    .map((key) => renderQuestion(fields[key]))
    .join("\n\n");
  const content = question === "all"
    ? [...scopeLines, "", renderedQuestions].join("\n")
    : [...scopeLines, "", renderQuestion(fields[question])].join("\n");
  await interaction.editReply({ content, flags: MessageFlags.Ephemeral });
}


    if (interaction.commandName === "show") {
      await handleShowReview(interaction);
      return;
    }
  } catch (error) {
    if (interaction.commandName === "splitvc") {
      splitVoiceGuildLocks.delete(interaction.guildId);
      const splitLease = activeSplitVoiceLeases.get(interaction.guildId);
      if (splitLease) {
        activeSplitVoiceLeases.delete(interaction.guildId);
        await releaseMongoLease(splitLease).catch((releaseError) => {
          console.error(`Failed to release splitvc lease after an error for ${interaction.guildId}: ${releaseError.message}`);
        });
      }
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
  const input = (id, label, style, max, value, required) => new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setMaxLength(max).setRequired(required).setValue(value ?? ""));
  const modal = new ModalBuilder().setCustomId("profile_modal").setTitle("プロフィール登録・編集").addComponents(
    input("profile_nickname", "呼び名", TextInputStyle.Short, 20, null, true),
    input("profile_status", "現状", TextInputStyle.Short, 30, null, false),
    input("profile_hobby", "趣味", TextInputStyle.Paragraph, 80, null, false),
    input("profile_comment", "ひとこと", TextInputStyle.Paragraph, 150, null, false),
  );
  await interaction.showModal(modal);
}

async function handleProfileModal(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const submittedValues = {
    nickname: normalizeProfileValue(interaction.fields.getTextInputValue("profile_nickname"), 20),
    status: normalizeProfileValue(interaction.fields.getTextInputValue("profile_status"), 30),
    hobby: normalizeProfileValue(interaction.fields.getTextInputValue("profile_hobby"), 80),
    comment: normalizeProfileValue(interaction.fields.getTextInputValue("profile_comment"), 150),
  };
  if (!submittedValues.nickname) {
    await interaction.editReply({ content: "呼び名は必須です。" });
    return;
  }

  let existing;
  try {
    existing = await UserProfile.findOne({ guildId: interaction.guildId, userId: interaction.user.id });
    const values = {
      nickname: submittedValues.nickname,
      // A modal must be shown before any database read.  Empty optional
      // fields therefore preserve existing values instead of erasing them.
      status: submittedValues.status || existing?.status || "",
      hobby: submittedValues.hobby || existing?.hobby || "",
      comment: submittedValues.comment || existing?.comment || "",
    };
    await UserProfile.findOneAndUpdate(
      { guildId: interaction.guildId, userId: interaction.user.id },
      values,
      { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
    );
  } catch (error) {
    await interaction.editReply({ content: "プロフィールの保存に失敗しました。" }).catch((error) => logRecoverableError("Recoverable asynchronous operation failed", error));
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
  let profileLease = null;
  try {
    await interaction.update({ content: "自己紹介を送信しています…", components: [] });
    profileLease = await acquireMongoLease(`profile-publish:${interaction.guildId}:${targetUserId}`, { leaseMs: 2 * 60 * 1000 });
    if (!profileLease) {
      await interaction.editReply({ content: "自己紹介の送信処理を実行中です。少し待ってから確認してください。" });
      return;
    }
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
    await interaction.editReply({ content }).catch((error) => logRecoverableError("Recoverable asynchronous operation failed", error));
  } finally {
    if (profileLease) {
      await releaseMongoLease(profileLease).catch((error) => {
        console.error(`Failed to release profile publication lease for ${lockKey}: ${error.message}`);
      });
    }
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
    await replyInChunks(interaction, formatSettings(settings), {
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (subcommand === "vc_control") {
    const category = interaction.options.getChannel("category", false);
    const notifyRole = interaction.options.getRole("notify_role", false);
    if (!category && !notifyRole) {
      await replyOrFollowUp(interaction, { content: "category または notify_role を指定してください。", flags: MessageFlags.Ephemeral });
      return;
    }

    if (interaction.commandName === "show" && interaction.options.getSubcommand() === "review") {
      await handleShowReview(interaction); return;
    }
    const settings = await saveGuildSettingsWithCurrent(interaction.guildId, await getGuildSettings(interaction.guildId), {
      ...(category ? { vcControlCategoryId: category.id } : {}),
      ...(notifyRole ? { vcControlNotifyRoleId: notifyRole.id } : {}),
    });
    await replyOrFollowUp(interaction, { content: `VCコントロール設定を保存しました。\n対象カテゴリ: ${settings.vcControlCategoryId ? `<#${settings.vcControlCategoryId}>` : "未設定"}\n通知ロール: ${settings.vcControlNotifyRoleId ? `<@&${settings.vcControlNotifyRoleId}>` : "未設定"}`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    if (category) {
      for (const channel of interaction.guild.channels.cache.values()) if (channel.type === ChannelType.GuildVoice && channel.parentId === category.id) await voiceChannelControlService.ensurePanel(channel).catch((error) => logRecoverableError("Recoverable asynchronous operation failed", error));
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

  if (subcommand === "zatudan") {
    await handleShugoSetting(interaction);
    return;
  }

  if (subcommand === "kokuchi") {
    await handleKokuchiSetting(interaction);
    return;
  }

  const tempRole = interaction.options.getRole("participant_role", false);
  const parentChannel = interaction.options.getChannel("parent_channel", false);
  const childCategory = interaction.options.getChannel("child_category", false);
  const waitingVcCategory = interaction.options.getChannel("waiting_vc_category", false,);
  const waitingVcName = interaction.options.getString("waiting_vc_name", false);
  const bosyuChannel = interaction.options.getChannel("bosyu_channel", false);
  const bosyuMentionRole = interaction.options.getRole("bosyu_mention_role", false);
  const splitFeedbackChannel = interaction.options.getChannel("split_feedback_channel", false);
  const logChannel = interaction.options.getChannel("log_channel", false);
  const formChannel = interaction.options.getChannel("form_channel", false);
  const formSendChannel = interaction.options.getChannel("form_send_channel", false);
  const reviewSendChannel = interaction.options.getChannel("review_send_channel", false);
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

  if (reviewSendChannel) {
    const me = interaction.guild.members.me ?? await interaction.guild.members.fetchMe();
    const permissions = reviewSendChannel.permissionsFor(me);
    if (!reviewSendChannel.isTextBased() || !permissions?.has(PermissionFlagsBits.ViewChannel) || !permissions?.has(PermissionFlagsBits.SendMessages)) {
      await interaction.editReply({ content: "感想送信先は、Botが閲覧・送信できるテキストチャンネルを指定してください。" });
      return;
    }
    patch.reviewSendChannelId = reviewSendChannel.id;
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
    await interaction.editReply({
      content: "変更する項目を1つ以上指定してください。",
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
    content: `設定を保存しました。\n\n${formatSettings(settings)}`,
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
}

async function handleRemoveRole(interaction) {
  if (!interaction.inGuild() || interaction.options.getSubcommand() !== "role") return;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageRoles)) {
    await interaction.editReply("この操作にはロールの管理権限が必要です。");
    return;
  }

  const guild = interaction.guild;
  const settings = await getGuildSettings(guild.id);
  const roleIds = [...new Set([settings?.tempRoleId, settings?.voiceParticipantRoleId].filter(Boolean))];
  if (roleIds.length === 0) {
    await interaction.editReply("解除対象の参加者ロールが設定されていません。");
    return;
  }

  const botMember = guild.members.me ?? await guild.members.fetchMe().catch(() => null);
  if (!botMember?.permissions.has(PermissionFlagsBits.ManageRoles)) {
    await interaction.editReply("Botにロールの管理権限がありません。");
    return;
  }

  const fetchedAllMembers = await guild.members.fetch().then(() => true).catch(() => false);
  if (!fetchedAllMembers) {
    await interaction.editReply("メンバー一覧を取得できなかったため、一括解除を実行しませんでした。時間をおいて再試行してください。");
    return;
  }
  const targetMembers = new Map();
  let skipped = 0;
  const reasons = new Set();
  const usableRoleIds = [];
  for (const roleId of roleIds) {
    const role = await guild.roles.fetch(roleId).catch(() => null);
    if (!role) {
      skipped += 1;
      reasons.add("設定済みロールが見つかりません");
      continue;
    }
    if (!role.editable) {
      skipped += 1;
      reasons.add("Botのロール階層が不足しています");
      continue;
    }
    usableRoleIds.push(role.id);
    for (const member of guild.members.cache.filter((item) => item.roles.cache.has(role.id)).values()) {
      if (member.user.bot) {
        skipped += 1;
        reasons.add("Botアカウントは対象外です");
        continue;
      }
      targetMembers.set(member.id, member);
    }
  }
  let fullySucceeded = 0;
  let partiallySucceeded = 0;
  let fullyFailed = 0;
  for (const member of targetMembers.values()) {
    let attemptedRoles = 0;
    let removedRoles = 0;
    let failedRoles = 0;
    for (const roleId of usableRoleIds) {
      if (!member.roles.cache.has(roleId)) continue;
      attemptedRoles += 1;
      const role = guild.roles.cache.get(roleId);
      try {
        await member.roles.remove(role, "一括参加者ロール解除 (/remove role)");
        const removedAt = new Date();
        await VoiceParticipantRoleGrant.updateMany(
          {
            guildId: guild.id,
            memberId: member.id,
            roleId,
            status: { $in: [null, "active", "removing", "failed"] },
          },
          {
            $set: {
              status: "removed",
              removedAt,
              cleanupAt: new Date(removedAt.getTime() + 30 * 24 * 60 * 60 * 1000),
            },
          },
        );
        removedRoles += 1;
      } catch (error) {
        failedRoles += 1;
        reasons.add(error?.code === 50013 ? "権限またはロール階層が不足しています" : "一部メンバーの解除に失敗しました");
      }
    }
    if (attemptedRoles > 0 && removedRoles === attemptedRoles) fullySucceeded += 1;
    else if (removedRoles > 0 && failedRoles > 0) partiallySucceeded += 1;
    else fullyFailed += 1;
  }
  const restoreSettings = await getGuildSettings(guild.id).catch(() => settings);
  const permissionRestored = restoreSettings?.gatheringVcRestorePending
    ? await restoreGatheringVcPermissionAfterSplit(guild, restoreSettings).catch(() => false)
    : null;
  await interaction.editReply([
    `完全成功: ${fullySucceeded}人`,
    `一部成功: ${partiallySucceeded}人`,
    `完全失敗: ${fullyFailed}人`,
    "参加者ロールを一括解除しました。",
    `対象ロール: ${roleIds.length}件`,
    `対象メンバー: ${targetMembers.size}人`,
    `スキップ: ${skipped}件`,
    ...(permissionRestored === null ? [] : [`集合VC権限復元: ${permissionRestored ? "成功" : "失敗"}`]),
    ...(reasons.size ? [`理由: ${[...reasons].join("、")}`] : []),
  ].join("\n"));
  await sendOperationalLog({
    guild,
    settings,
    fallbackChannel: interaction.channel,
    content: `/remove role を実行しました。対象 ${targetMembers.size} 人、完全成功 ${fullySucceeded} 人、一部成功 ${partiallySucceeded} 人、完全失敗 ${fullyFailed} 人、スキップ ${skipped} 件。理由: ${[...reasons].join("、") || "なし"}`,
  }).catch((error) => logRecoverableError("Failed to log bulk role removal", error));
}

async function handleKokuchiSetting(interaction) {
  const channel = interaction.options.getChannel("announcement_channel", false);
  const overviewChannel = interaction.options.getChannel("overview_channel", false);
  const gatheringVoiceChannel = interaction.options.getChannel("gathering_voice_channel", false);
  const eventTime = interaction.options.getString("event_time", false);
  const mentionRole = interaction.options.getRole("mention_role", false);
  const removeMentionRole = interaction.options.getRole("remove_mention_role", false);
  const parsedEventTime = eventTime === null ? null : normalizeKokuchiEventTime(eventTime);

  if (eventTime !== null && !parsedEventTime) {
    await replyOrFollowUp(interaction, { content: "開催予定時刻は HH:mm（00:00〜23:59）で指定してください。", flags: MessageFlags.Ephemeral });
    return;
  }

  if (!channel && !overviewChannel && !gatheringVoiceChannel && !parsedEventTime && !mentionRole && !removeMentionRole) {
    await replyOrFollowUp(interaction, { content: "変更する告知設定を1つ以上指定してください。", flags: MessageFlags.Ephemeral });
    return;
  }

  const current = await getGuildSettings(interaction.guildId);
  if (mentionRole) {
    const botMember = interaction.guild.members.me ?? await interaction.guild.members.fetchMe().catch(() => null);
    if (!mentionRole.mentionable && !botMember?.permissions.has(PermissionFlagsBits.MentionEveryone)) {
      await replyOrFollowUp(interaction, {
        content: "そのロールはメンション不可で、Botにロールメンション権限もありません。ロールをメンション可能にするか、Botへ「@everyone、@here、すべてのロールにメンション」権限を付与してください。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  }
  const roleIds = new Set(Array.isArray(current?.kokuchiMentionRoleIds)
    ? current.kokuchiMentionRoleIds
    : (Array.isArray(current?.kokuchiGatheringReminderRoleIds) ? current.kokuchiGatheringReminderRoleIds : []));
  if (mentionRole) roleIds.add(mentionRole.id);
  if (removeMentionRole) roleIds.delete(removeMentionRole.id);

  const settings = await saveGuildSettingsWithCurrent(interaction.guildId, current, {
    ...(channel ? { kokuchiAnnouncementChannelId: channel.id, wadaiChannelId: channel.id, splitStartChannelId: channel.id } : {}),
    ...(overviewChannel ? { kokuchiOverviewChannelId: overviewChannel.id } : {}),
    ...(gatheringVoiceChannel ? { gatheringVoiceChannelId: gatheringVoiceChannel.id } : {}),
    ...(parsedEventTime ? { kokuchiEventTime: parsedEventTime } : {}),
    ...(mentionRole || removeMentionRole ? { kokuchiMentionRoleIds: [...roleIds] } : {}),
  });
  const rescheduled = await rescheduleCurrentKokuchiEvent(interaction.guild, current, settings);
  await replyOrFollowUp(interaction, {
    content: `設定を保存しました。${rescheduled ? " 未実行の告知後続処理を再計算しました。" : ""}\n\n${formatSettings(settings)}`,
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
  const callWaitIntervalMinutes = interaction.options.getInteger("call_wait_interval_minutes", false);
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

  patch.callWaitMode = CALL_WAIT_MODE_BUTTON;

  if (callWaitIntervalMinutes !== null) {
    patch.callWaitIntervalMinutes = normalizeCallWaitIntervalMinutes(callWaitIntervalMinutes);
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
      callWaitPromptChannel)
  ) {
    await endCallWaitInterestsForRecruitment(interaction.guildId, currentSettings.callWaitPrompt.messageId);
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
    const roleValidationError = await validateVoiceParticipantRole(interaction.guild, voiceParticipantRole);
    if (roleValidationError) {
      await replyOrFollowUp(interaction, { content: roleValidationError, flags: MessageFlags.Ephemeral });
      return;
    }
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
  const roleChangedWithActiveSession = Boolean(
    voiceParticipantRole
      && currentSettings?.voiceParticipantRoleId
      && currentSettings.voiceParticipantRoleId !== voiceParticipantRole.id
      && [...voiceMonitorSessions.values()].some((session) => session.guildId === interaction.guildId),
  );

  if (patch.voiceReminderEnabled === false) {
    const sessions = [...voiceMonitorSessions.values()]
      .filter((session) => session.guildId === interaction.guildId);
    for (const session of sessions) {
      const voiceChannel = await interaction.guild.channels.fetch(session.voiceChannelId).catch(() => null);
      await stopVoiceMonitorSession(session, interaction.guild, voiceChannel, settings).catch((error) => {
        logRecoverableError("Failed to clean up disabled voice monitor session", error);
      });
    }
    await reconcilePersistedVoiceParticipantRoleGrants(interaction.guild, settings).catch((error) => {
      logRecoverableError("Failed to reconcile disabled voice monitor grants", error);
    });
  }

  await replyOrFollowUp(interaction, {
    content: `VC集合フォーム設定を保存しました。\n\n${formatSettings(settings)}${roleChangedWithActiveSession ? "\n\n現在進行中の雑談VCセッションでは、セッション開始時の旧ロールが終了まで使用されます。新しいロールは新規セッションから使用されます。" : ""}`,
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
}

async function validateVoiceParticipantRole(guild, role) {
  const botMember = guild?.members?.me ?? (guild?.members?.fetchMe
    ? await guild.members.fetchMe().catch(() => null)
    : null);
  if (!botMember?.permissions?.has(PermissionFlagsBits.ManageRoles)) {
    return "Botにロールの管理権限がありません。";
  }
  if (!role || role.id === guild.id || role.managed || !role.editable) {
    return "@everyone、連携管理ロール、またはBotより上位のロールは参加者ロールに設定できません。";
  }
  return null;
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
  await saveGuildSettingsWithCurrent(interaction.guildId, settings, {
    wadaiTopics: topics,
    wadaiTopicsVersion: 2,
    wadaiDaily: null,
  });

  await replyOrFollowUp(interaction, {
    content: `話題を削除しました。\n${deleted.text}`,
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
}

async function sendSplitRandomTopicPanels({ guild, settings, childChannelIds }) {
  for (const childChannelId of childChannelIds) {
    try {
      const childChannel = await guild.channels.fetch(childChannelId);
      if (!childChannel || typeof childChannel.send !== "function") {
        throw new Error("Child voice channel cannot send text messages.");
      }

      await childChannel.send({
        content: "下のボタンを押したらランダムに話題が出ます！\n話題に詰まった時などに使ってみてください！",
        components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`${SPLIT_RANDOM_TOPIC}:${childChannel.id}`)
              .setLabel("ランダムな話題を送信")
              .setStyle(ButtonStyle.Primary),
          ),
        ],
        allowedMentions: { parse: [] },
      });
    } catch (error) {
      console.error(`Failed to send split random topic panel for ${childChannelId}:`, error);
      await sendOperationalLog({
        guild,
        settings,
        fallbackChannel: null,
        content: `子VC話題ボタンの送信に失敗しました。 childChannelId=${childChannelId} error=${error?.message ?? error}`,
      }).catch((logError) => console.error("Failed to log split random topic panel error:", logError));
    }
  }
}

async function handleSplitRandomTopicButton(interaction) {
  const [, childChannelId] = interaction.customId.split(":");
  const memberVoiceChannelId = interaction.member?.voice?.channelId;

  if (!childChannelId || memberVoiceChannelId !== childChannelId) {
    await interaction.reply({
      content: "このボタンは対象のVCに参加している間だけ使用できます。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const cooldownUntil = randomTopicCooldownByChannel.get(childChannelId) ?? 0;
  if (cooldownUntil > Date.now()) {
    await interaction.reply({
      content: "少し待ってからもう一度お試しください。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const settings = await getGuildSettings(interaction.guildId).catch((error) => {
    console.error("Failed to load settings for split random topic:", error);
    return null;
  });
  const topicList = getWadaiTopics(settings)["1"] ?? [];
  if (topicList.length === 0) {
    await interaction.reply({
      content: "現在、使用できる話題が登録されていません。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const previousTopicId = lastTopicIdByChildChannel.get(childChannelId);
  const candidates = topicList.length > 1
    ? topicList.filter((topic) => topic.id !== previousTopicId)
    : topicList;
  const topic = candidates[Math.floor(Math.random() * candidates.length)];

  randomTopicCooldownByChannel.set(childChannelId, Date.now() + 10_000);
  await interaction.deferUpdate();
  try {
    const childChannel = await interaction.guild.channels.fetch(childChannelId);
    if (!childChannel || typeof childChannel.send !== "function") {
      throw new Error("Target child voice channel is unavailable.");
    }
    await childChannel.send({
      content: `話題：${topic.text}`,
      allowedMentions: { parse: [] },
    });
    lastTopicIdByChildChannel.set(childChannelId, topic.id);
  } catch (error) {
    randomTopicCooldownByChannel.delete(childChannelId);
    console.error(`Failed to send split random topic for ${childChannelId}:`, error);
    await interaction.followUp({
      content: "話題の送信に失敗しました。時間をおいてもう一度お試しください。",
      flags: MessageFlags.Ephemeral,
    });
  }
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
  return settings?.kokuchiAnnouncementChannelId ?? settings?.wadaiChannelId ?? settings?.splitStartChannelId ?? null;
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

function hasActiveKokuchiEvent(settings) {
  return [
    ["pending", "failed"].includes(settings?.kokuchiPreNoticeState),
    ["pending", "failed", "processing", "opened"].includes(settings?.gatheringVcUnlockState),
    ["pending", "failed"].includes(settings?.kokuchiGatheringReminderState),
    settings?.gatheringVcRestorePending === true,
  ].some(Boolean);
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

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const weekday = interaction.options.getString("weekday", true);
  const overviewChannel = interaction.options.getChannel("overview_channel", false);
  const targetChannel = interaction.options.getChannel("channel", false);
  const settings = await getGuildSettings(interaction.guildId);
  const sendChannel =
    targetChannel && typeof targetChannel.send === "function"
      ? targetChannel
      : await resolveWadaiSendChannel(interaction.guild, settings, null);

  if (!sendChannel) {
    await replyOrFollowUp(interaction, {
      content:
        "告知送信先を取得できませんでした。`channel` を指定するか、`/setting kokuchi announcement_channel:送信先` を設定してください。",
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
        "概要案内チャンネルが未設定です。`/setting kokuchi overview_channel:概要案内チャンネル` を設定してください。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const botMember = interaction.guild.members.me ?? await interaction.guild.members.fetchMe().catch(() => null);
  const sendPermissions = botMember && sendChannel.permissionsFor?.(botMember);
  if (sendPermissions && (!sendPermissions.has(PermissionFlagsBits.ViewChannel) || !sendPermissions.has(PermissionFlagsBits.SendMessages))) {
    await replyOrFollowUp(interaction, {
      content: "告知先チャンネルを閲覧・送信する権限がBotにありません。権限を確認してから再実行してください。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const setHour = interaction.options.getInteger("set", false);
  const activeReservation = await KokuchiReservation.findOne({
    guildId: interaction.guildId,
    status: { $in: ["pending", "processing"] },
  }).lean();
  if (activeReservation) {
    await replyOrFollowUp(interaction, {
      content: "すでに告知の送信予約があります。変更する場合は、現在の予約をキャンセルしてからもう一度実行してください。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const cancellationInProgress = await KokuchiReservation.exists({
    guildId: interaction.guildId,
    status: { $in: ["canceling", "cancel_partial"] },
  });
  if (hasActiveKokuchiEvent(settings) || cancellationInProgress) {
    await replyOrFollowUp(interaction, {
      content: "前回のkokuchiに関連する処理がまだ完了していません。前回の後続処理をキャンセルするか、イベント終了後にもう一度実行してください。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (setHour !== null && setHour !== undefined) {
    const scheduledAt = getNextKokuchiReservationAt({ weekday, hour: setHour });
    if (!scheduledAt) {
      await replyOrFollowUp(interaction, { content: "予約時刻を解釈できませんでした。", flags: MessageFlags.Ephemeral });
      return;
    }
    const reservationId = createSessionId();
    // The reminder is sent only when the reservation is at least exactly
    // thirty minutes away.  A reservation made 29:59 beforehand is skipped.
    const reminderStatus = scheduledAt.getTime() - Date.now() < 30 * 60 * 1000 ? "skipped" : "pending";
    let reservation;
    try {
      reservation = await KokuchiReservation.create({
      guildId: interaction.guildId, reservationId, weekday, displayHour: setHour, scheduledAt,
      eventDate: getKokuchiEventDate(scheduledAt, setHour),
      eventAt: getNextKokuchiEventAt({ weekday, eventTime: normalizeKokuchiEventTime(settings?.kokuchiEventTime) ?? "21:00", now: scheduledAt }),
      activeKey: interaction.guildId,
      publicationKey: `${interaction.guildId}:${getKokuchiEventDate(scheduledAt, setHour)}`,
      commandUserId: interaction.user.id, commandChannelId: interaction.channelId,
      targetChannelId: sendChannel.id, overviewChannelId: resolvedOverviewChannel.id,
      reminderStatus,
      });
    } catch (error) {
      if (error?.code === 11000) {
        await replyOrFollowUp(interaction, { content: "すでに告知の送信予約があります。変更する場合は、現在の予約をキャンセルしてからもう一度実行してください。", flags: MessageFlags.Ephemeral });
        return;
      }
      throw error;
    }
    try {
    const confirmation = await interaction.channel.send({
      content: `告知は${formatJstReservationTime(scheduledAt, setHour)}に送信されます。`,
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`${KOKUCHI_RESERVATION_CANCEL_CUSTOM_ID}:${reservationId}`).setLabel("送信をキャンセル").setStyle(ButtonStyle.Danger),
      )],
    });
    const confirmationSaved = await KokuchiReservation.updateOne(
      { _id: reservation._id, status: "pending" },
      { $set: { confirmationChannelId: confirmation.channelId, confirmationMessageId: confirmation.id } },
    );
    if (confirmationSaved.matchedCount !== 1 || confirmationSaved.modifiedCount !== 1) {
      await confirmation.edit({ content: "【予約失敗】\n\n予約情報を確定できなかったため、送信は行われません。", components: [] }).catch((error) => logRecoverableError("Failed to update rejected kokuchi reservation confirmation", error));
      await KokuchiReservation.updateOne(
        { _id: reservation._id, status: "pending" },
        { $set: { status: "failed", failedAt: new Date(), cleanupAt: getKokuchiReservationCleanupAt() }, $unset: { activeKey: 1 } },
      );
      throw new Error("Reservation confirmation ID persistence failed");
    }
    await scheduleKokuchiReservation(interaction.guild, { ...reservation.toObject(), confirmationChannelId: confirmation.channelId, confirmationMessageId: confirmation.id });
    } catch (error) {
      // A reservation without its confirmation/cancel control must not remain
      // active.  This also releases the sparse active-key slot.
      clearKokuchiReservationTimers(reservationId);
      await KokuchiReservation.deleteOne({ _id: reservation._id, status: "pending" });
      console.error("Kokuchi reservation confirmation failed:", error);
      await replyOrFollowUp(interaction, {
        content: "予約の確認メッセージを送信できなかったため、予約を取り消しました。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await replyOrFollowUp(interaction, { content: "予約を受け付けました。", flags: MessageFlags.Ephemeral });
    return;
  }

  try {
    await publishImmediateKokuchi({
      interaction,
      weekday,
      sendChannel,
      overviewChannel: resolvedOverviewChannel,
      settings,
    });
  } catch (error) {
    if (error?.code === 11000) {
      await replyOrFollowUp(interaction, {
        content: "この開催日の告知はすでに投稿済み、または送信確認中です。重複投稿を防ぐため再送しません。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    throw error;
  }

  await replyOrFollowUp(interaction, {
    content: `告知を ${sendChannel} に投稿しました。`,
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
}

async function publishImmediateKokuchi({ interaction, weekday, sendChannel, overviewChannel, settings }) {
  const now = new Date();
  const jstHour = new Date(now.getTime() + 9 * 60 * 60 * 1000).getUTCHours();
  const eventDate = getKokuchiEventDate(now, jstHour);
  const eventAt = getNextKokuchiEventAt({ weekday, eventTime: normalizeKokuchiEventTime(settings?.kokuchiEventTime) ?? "21:00", now });
  const reservation = await KokuchiReservation.create({
    guildId: interaction.guildId,
    reservationId: createSessionId(),
    weekday,
    displayHour: jstHour,
    scheduledAt: now,
    eventDate,
    eventAt,
    activeKey: interaction.guildId,
    publicationKey: `${interaction.guildId}:${eventDate}`,
    commandUserId: interaction.user.id,
    commandChannelId: interaction.channelId,
    targetChannelId: sendChannel.id,
    overviewChannelId: overviewChannel.id,
    status: "processing",
    publicationStatus: "processing",
    publicationStartedAt: now,
    postProcessingStatus: "pending",
    reminderStatus: "skipped",
  });

  try {
    await publishKokuchi({
      guild: interaction.guild,
      weekday,
      sendChannel,
      overviewChannel,
      settings,
      eventAt,
      kokuchiEventId: reservation.reservationId,
      leaseKey: `kokuchi-publish:${interaction.guildId}:${eventDate}`,
      onPublished: async ({ postedMessage, postedAt }) => {
        const persisted = await KokuchiReservation.updateOne(
          { _id: reservation._id, status: "processing" },
          {
            $set: {
              publicationStatus: "published",
              publicationChannelId: postedMessage.channelId,
              publicationMessageId: postedMessage.id,
              publicationSentAt: postedAt,
              postProcessingStatus: "processing",
            },
          },
        );
        if (persisted.matchedCount !== 1 || persisted.modifiedCount !== 1) {
          throw new Error("Immediate kokuchi publication message ID could not be persisted");
        }
      },
    });
    const completed = await KokuchiReservation.updateOne(
      { _id: reservation._id, status: "processing" },
      {
        $set: {
          status: "sent",
          sentAt: new Date(),
          cleanupAt: getKokuchiReservationCleanupAt(),
          publicationStatus: "published",
          publicationConfirmedAt: new Date(),
          postProcessingStatus: "completed",
        },
        $unset: { activeKey: 1, processingAt: 1, postProcessingError: 1 },
      },
    );
    if (completed.matchedCount !== 1 || completed.modifiedCount !== 1) {
      throw new Error("Immediate kokuchi publication succeeded but confirmation could not be persisted");
    }
    await createKokuchiCancellationControl(interaction.channel, reservation).catch((error) => logRecoverableError("Failed to create immediate kokuchi cancellation control", error));
  } catch (error) {
    const publication = error?.kokuchiPublication ?? null;
    const unconfirmed = Boolean(publication || error?.kokuchiPublicationAttempted === true);
    const failed = await KokuchiReservation.updateOne(
      { _id: reservation._id, status: "processing" },
      {
        $set: unconfirmed
          ? {
            status: "published_unconfirmed",
            publicationStatus: "published_unconfirmed",
            publicationChannelId: publication?.channelId,
            publicationMessageId: publication?.messageId,
            publicationSentAt: publication?.sentAt ?? new Date(),
            postProcessingStatus: "failed",
            postProcessingError: error.message,
            publishedAt: new Date(),
            recoveryReason: `Immediate Discord publication may have succeeded: ${error.message}`,
          }
          : {
            status: "failed",
            publicationStatus: "failed_before_publish",
            postProcessingStatus: "failed",
            postProcessingError: error.message,
            failedAt: new Date(),
            cleanupAt: getKokuchiReservationCleanupAt(),
          },
        $unset: unconfirmed
          ? { activeKey: 1, processingAt: 1 }
          : { activeKey: 1, processingAt: 1, publicationKey: 1 },
      },
    );
    if (failed.matchedCount !== 1) {
      console.error(`Immediate kokuchi failure state could not be persisted for ${reservation.reservationId}`);
    }
    throw error;
  }
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
    !["pending", "failed"].includes(settings.kokuchiPreNoticeState)
  ) {
    return;
  }

  const noticeAt = new Date(settings.kokuchiPreNoticeAt);

  if (!Number.isFinite(noticeAt.getTime())) {
    return;
  }

  const now = new Date();

  if (noticeAt.getTime() <= now.getTime()) {
    await transitionKokuchiTimedAction({
      guildId: guild.id,
      stateKey: "kokuchiPreNoticeState",
      fromStates: ["pending", "failed"],
      toState: "skipped",
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
    !["pending", "failed"].includes(settings.kokuchiPreNoticeState)
  ) {
    return;
  }

  const noticeAt = new Date(settings.kokuchiPreNoticeAt);

  const now = new Date();
  if (!Number.isFinite(noticeAt.getTime()) || noticeAt.getTime() + 5_000 < now.getTime()) {
    await transitionKokuchiTimedAction({
      guildId: guild.id,
      stateKey: "kokuchiPreNoticeState",
      fromStates: ["pending", "failed"],
      toState: "skipped",
    });
    return;
  }

  const claimed = await transitionKokuchiTimedAction({
    guildId: guild.id,
    stateKey: "kokuchiPreNoticeState",
    fromStates: ["pending", "failed"],
    toState: "processing",
  });
  if (!claimed) return;

  const channel = await resolveConfiguredTextChannel(
    guild,
    claimed.kokuchiPreNoticeChannelId,
  );

  if (!channel) {
    await transitionKokuchiTimedAction({
      guildId: guild.id,
      stateKey: "kokuchiPreNoticeState",
      fromStates: ["processing"],
      toState: "failed",
      patch: { kokuchiPreNoticeLastError: "Configured pre-notice channel could not be resolved" },
    });
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
    await transitionKokuchiTimedAction({
      guildId: guild.id,
      stateKey: "kokuchiPreNoticeState",
      fromStates: ["processing"],
      toState: "sent_unconfirmed",
      patch: { kokuchiPreNoticeLastError: "Discord pre-notice send result was not confirmed; automatic retry was disabled to prevent duplicates" },
    });
    return;
  }

  await transitionKokuchiTimedAction({
    guildId: guild.id,
    stateKey: "kokuchiPreNoticeState",
    fromStates: ["processing"],
    toState: "sent",
    patch: {
      kokuchiPreNoticeMessage: {
        channelId: channel.id,
        messageId: message.id,
        sentAt: new Date().toISOString(),
      },
    },
  });
}

async function restorePendingGatheringVcPermissions() {
  for (const guild of client.guilds.cache.values()) {
    try {
      const settings = await getGuildSettings(guild.id);
      if (!settings?.gatheringVcRestorePending) continue;
      const activeSplit = await SplitProcessSession.exists({
        guildId: guild.id,
        status: { $in: ["active", "feedback_open", "role_remove_pending", "cleaning_up"] },
      });
      // Role-removal recovery owns active sessions.  A snapshot left after a
      // completed session is safe to retry after restart.
      if (!activeSplit) await restoreGatheringVcPermissionAfterSplit(guild, settings);
    } catch (error) {
      logRecoverableError(`Failed to restore pending gathering VC permission for ${guild.id}`, error);
    }
  }
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

  if (!["pending", "failed"].includes(settings.gatheringVcUnlockState)) {
    return;
  }

  if (unlockAt.getTime() <= now.getTime()) {
    // A delayed process must never replay an action from earlier today.
    await transitionKokuchiTimedAction({
      guildId: guild.id,
      stateKey: "gatheringVcUnlockState",
      fromStates: ["pending", "failed"],
      toState: "skipped",
    });
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
    !["pending", "failed"].includes(settings.kokuchiGatheringReminderState)
  ) {
    return;
  }

  const remindAt = new Date(settings.kokuchiGatheringReminderAt);

  if (!Number.isFinite(remindAt.getTime())) {
    return;
  }

  const now = new Date();

  if (remindAt.getTime() <= now.getTime()) {
    // A reminder is useful only before its scheduled time.
    await transitionKokuchiGatheringReminder({
      guildId: guild.id,
      fromStates: ["pending", "failed"],
      toState: "skipped",
    });
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
    !["pending", "failed"].includes(settings.kokuchiGatheringReminderState)
  ) {
    return;
  }

  const remindAt = new Date(settings.kokuchiGatheringReminderAt);

  const now = new Date();
  if (!Number.isFinite(remindAt.getTime()) || remindAt.getTime() + 5_000 < now.getTime()) {
    await transitionKokuchiGatheringReminder({
      guildId: guild.id,
      fromStates: ["pending", "failed"],
      toState: "skipped",
    });
    return;
  }

  const claimed = await transitionKokuchiGatheringReminder({
    guildId: guild.id,
    fromStates: ["pending", "failed"],
    toState: "sending",
  });

  if (!claimed) {
    return;
  }

  const channel = await resolveConfiguredTextChannel(
    guild,
    claimed.kokuchiGatheringReminderChannelId,
  );

  if (!channel) {
    await transitionKokuchiGatheringReminder({
      guildId: guild.id,
      fromStates: ["sending"],
      toState: "failed",
      patch: { kokuchiGatheringReminderLastError: "Configured reminder channel could not be resolved" },
    });
    return;
  }

  const roleIds = Array.isArray(claimed.kokuchiMentionRoleIds)
    ? claimed.kokuchiMentionRoleIds.filter(Boolean)
    : [];
  const gatheringVoiceChannelId = getGatheringVcUnlockChannelId(claimed);

  if (!gatheringVoiceChannelId) {
    await transitionKokuchiGatheringReminder({
      guildId: guild.id,
      fromStates: ["sending"],
      toState: "failed",
      patch: { kokuchiGatheringReminderLastError: "Gathering voice channel is not configured" },
    });
    return;
  }

  const roleMentions = roleIds
    .map((roleId) => `<@&${roleId}>`)
    .join(" ");

  const message = await channel.send({
    content:
      `${roleMentions} 会話練習会の集合が開始しました！ ` +
      `<#${gatheringVoiceChannelId}> からぜひご参加ください！5分後に締め切られます`,
    allowedMentions: { roles: roleIds },
  }).catch((error) => {
    console.error(`Failed to send kokuchi gathering reminder: ${error.message}`);
    return null;
  });

  if (!message) {
    await transitionKokuchiGatheringReminder({
      guildId: guild.id,
      fromStates: ["sending"],
      toState: "unconfirmed",
      patch: { kokuchiGatheringReminderLastError: "Discord message send result was not confirmed; automatic retry was disabled to prevent duplicates" },
    });
    return;
  }

  await transitionKokuchiGatheringReminder({
    guildId: guild.id,
    fromStates: ["sending"],
    toState: "sent",
    patch: {
      kokuchiGatheringReminderMessage: {
        channelId: channel.id,
        messageId: message.id,
        sentAt: new Date().toISOString(),
      },
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
    !["pending", "failed"].includes(settings.gatheringVcUnlockState)
  ) {
    return;
  }

  const unlockAt = new Date(settings.gatheringVcUnlockAt);
  if (!Number.isFinite(unlockAt.getTime()) || unlockAt.getTime() + 5_000 < Date.now()) {
    await transitionKokuchiTimedAction({
      guildId: guild.id,
      stateKey: "gatheringVcUnlockState",
      fromStates: ["pending", "failed"],
      toState: "skipped",
    });
    return;
  }

  const claimed = await transitionKokuchiTimedAction({
    guildId: guild.id,
    stateKey: "gatheringVcUnlockState",
    fromStates: ["pending", "failed"],
    toState: "processing",
  });
  if (!claimed) return;

  const changed = await setGatheringVcConnectPermission({
    guild,
    settings: claimed,
    canConnect: true,
    reason: "会話練習会の集合VCを開放",
  });

  if (changed) {
    await transitionKokuchiTimedAction({
      guildId: guild.id,
      stateKey: "gatheringVcUnlockState",
      fromStates: ["processing"],
      toState: "opened",
    });
  } else {
    await transitionKokuchiTimedAction({
      guildId: guild.id,
      stateKey: "gatheringVcUnlockState",
      fromStates: ["processing"],
      toState: "failed",
      patch: { gatheringVcUnlockLastError: "Gathering VC permission update was not applied" },
    });
  }
}

async function closeGatheringVcAfterSplit(guild, settings) {
  clearGatheringVcUnlockTimer(guild.id);
  const closed = await setGatheringVcConnectPermission({
    guild,
    settings,
    canConnect: false,
    reason: "/splitvc完了に伴う集合VCの閲覧・接続停止",
  });
  if (!closed) return false;
  await saveGuildSettingsWithCurrent(guild.id, settings, {
    gatheringVcUnlockState: "closed",
    gatheringVcRestorePending: true,
    gatheringVcRestorePendingAt: new Date().toISOString(),
  });
  return true;
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

  const snapshot = settings?.gatheringVcPermissionBeforeOpen;
  if (!snapshot || snapshot.channelId !== channel.id || snapshot.guildId !== guild.id) {
    const overwrite = channel.permissionOverwrites.cache.get(guild.id) ?? null;
    settings = await saveGuildSettingsWithCurrent(guild.id, settings, {
      gatheringVcPermissionBeforeOpen: createEveryonePermissionSnapshot({
        channelId: channel.id,
        guildId: guild.id,
        overwrite,
        permissions: PermissionFlagsBits,
      }),
    });
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

async function restoreGatheringVcPermissionAfterSplit(guild, settings) {
  const snapshot = settings?.gatheringVcPermissionBeforeOpen;
  const channelId = getGatheringVcUnlockChannelId(settings);
  if (!snapshot || !channelId || snapshot.channelId !== channelId || snapshot.guildId !== guild.id) {
    return false;
  }
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel?.isVoiceBased() || typeof channel.permissionOverwrites?.edit !== "function") return false;

  const overwrite = channel.permissionOverwrites.cache.get(guild.id) ?? null;
  const patch = getRestorePermissionPatch({ snapshot, overwrite, permissions: PermissionFlagsBits });
  try {
    if (Object.keys(patch).length > 0) {
      await channel.permissionOverwrites.edit(guild.id, patch, {
        reason: "/splitvc完了に伴う集合VC権限の復元",
      });
    }
    await saveGuildSettingsWithCurrent(guild.id, settings, {
      gatheringVcUnlockState: "closed",
      gatheringVcPermissionBeforeOpen: null,
      gatheringVcRestorePending: false,
      gatheringVcRestorePendingAt: null,
    });
    return true;
  } catch (error) {
    await sendOperationalLog({
      guild,
      settings,
      fallbackChannel: null,
      content: `集合VC権限の復元に失敗しました: ${error.message}`,
    }).catch((logError) => logRecoverableError("Failed to log gathering VC permission restore failure", logError));
    return false;
  }
}

/** Shared by immediate and reserved /kokuchi posting. */
async function publishKokuchi({ guild, weekday, sendChannel, overviewChannel, settings = null, onPublished = null, leaseKey = null, eventAt = null, kokuchiEventId = null }) {
  if (kokuchiPublishGuildLocks.has(guild.id)) {
    throw new Error("A /kokuchi publication is already in progress for this guild.");
  }
  kokuchiPublishGuildLocks.add(guild.id);
  let lease = null;
  let publicationAttempted = false;
  let postedMessage = null;
  let postedAt = null;
  try {
  lease = await acquireMongoLease(leaseKey ?? `kokuchi:${guild.id}`, { leaseMs: 2 * 60 * 1000 });
  if (!lease) {
    throw new Error("A /kokuchi publication is already in progress for this guild.");
  }
  const currentSettings = settings ?? await getGuildSettings(guild.id);
  const mentionRoleIds = [...new Set(Array.isArray(currentSettings?.kokuchiMentionRoleIds)
    ? currentSettings.kokuchiMentionRoleIds.filter(Boolean)
    : [])];
  postedAt = new Date();
  publicationAttempted = true;
  postedMessage = await sendChannel.send({
    content: `${mentionRoleIds.map((roleId) => `<@&${roleId}>`).join(" ")} ${formatKokuchiMessage({ weekday, overviewChannelId: overviewChannel.id, eventTime: currentSettings?.kokuchiEventTime })}`.trim(),
    allowedMentions: { roles: mentionRoleIds },
  });
  if (onPublished) {
    await onPublished({ postedMessage, postedAt });
  }
  const resolvedEventAt = eventAt instanceof Date && Number.isFinite(eventAt.getTime())
    ? eventAt
    : getNextKokuchiEventAt({
      weekday,
      eventTime: normalizeKokuchiEventTime(currentSettings?.kokuchiEventTime) ?? "21:00",
      now: postedAt,
    });
  if (!resolvedEventAt) throw new Error("Kokuchi event time could not be calculated");
  const preNoticeAt = getKokuchiPreNoticeAt(resolvedEventAt);
  const unlockAt = getGatheringVcUnlockAt(resolvedEventAt);
  const reminderAt = getKokuchiGatheringReminderAt(resolvedEventAt);
  const savedSettings = await saveGuildSettingsWithCurrent(guild.id, currentSettings, {
    lastKokuchiWeekday: weekday,
    lastKokuchiPostedAt: postedAt.toISOString(),
    lastKokuchiMessageId: postedMessage.id,
    lastKokuchiChannelId: postedMessage.channelId,
    kokuchiEventId: kokuchiEventId,
    kokuchiEventAt: resolvedEventAt.toISOString(),
    kokuchiPreNoticeAt: preNoticeAt.toISOString(),
    kokuchiPreNoticeChannelId: sendChannel.id,
    kokuchiPreNoticeState: preNoticeAt.getTime() > postedAt.getTime() ? "pending" : "skipped",
    gatheringVcUnlockAt: unlockAt.toISOString(),
    gatheringVcUnlockChannelId: resolveKokuchiGatheringVoiceChannelId(currentSettings, currentSettings),
    gatheringVcUnlockState: unlockAt.getTime() > postedAt.getTime() ? "pending" : "skipped",
    kokuchiGatheringReminderAt: reminderAt.toISOString(),
    kokuchiGatheringReminderChannelId: sendChannel.id,
    kokuchiGatheringReminderState: reminderAt.getTime() > postedAt.getTime() ? "pending" : "skipped",
  });
  // Each existing scheduler deliberately marks a past event as skipped, so a
  // A late reservation never replays the already-passed timed actions.
  await scheduleKokuchiPreNotice(guild, savedSettings);
  await scheduleGatheringVcUnlock(guild, savedSettings);
  await scheduleKokuchiGatheringReminder(guild, savedSettings);
  return { settings: savedSettings, postedMessage };
  } catch (error) {
    error.kokuchiPublicationAttempted = publicationAttempted;
    if (postedMessage) {
      error.kokuchiPublication = {
        channelId: postedMessage.channelId,
        messageId: postedMessage.id,
        sentAt: postedAt ?? new Date(),
      };
    }
    throw error;
  } finally {
    if (lease) {
      await releaseMongoLease(lease).catch((error) => {
        console.error(`Failed to release /kokuchi lease for ${guild.id}: ${error.message}`);
      });
    }
    kokuchiPublishGuildLocks.delete(guild.id);
  }
}

async function scheduleKokuchiReservation(guild, reservation) {
  clearKokuchiReservationTimers(reservation.reservationId);
  if (reservation.status !== "pending") return;
  const scheduledAt = new Date(reservation.scheduledAt);
  const sendIn = scheduledAt.getTime() - Date.now();
  if (!Number.isFinite(scheduledAt.getTime())) return;
  const sendTimer = setTimeout(() => {
    void processKokuchiReservation(guild.id, reservation.reservationId).catch((error) => console.error("Reserved /kokuchi failed:", error));
  }, Math.max(0, sendIn));
  kokuchiReservationTimers.set(`${reservation.reservationId}:send`, sendTimer);
  if (reservation.reminderStatus === "pending") {
    const reminderIn = sendIn - 30 * 60 * 1000;
    if (reminderIn >= -5_000) {
      const reminderTimer = setTimeout(() => {
        void sendKokuchiReservationReminder(guild.id, reservation.reservationId).catch((error) => console.error("Reserved /kokuchi reminder failed:", error));
      }, reminderIn);
      kokuchiReservationTimers.set(`${reservation.reservationId}:reminder`, reminderTimer);
    } else {
      // This can occur when restoring an older reservation which was created
      // inside the 30-minute reminder window.  Do not send a late reminder.
      await KokuchiReservation.updateOne(
        { _id: reservation._id, status: "pending", reminderStatus: "pending" },
        { $set: { reminderStatus: "skipped" } },
      );
    }
  }
}

function clearKokuchiReservationTimers(reservationId) {
  const prefix = `${reservationId}:`;
  for (const [key, timer] of kokuchiReservationTimers) {
    if (!key.startsWith(prefix)) continue;
    if (timer) clearTimeout(timer);
    kokuchiReservationTimers.delete(key);
  }
}

async function sendKokuchiReservationReminder(guildId, reservationId) {
  const reservation = await KokuchiReservation.findOneAndUpdate(
    { guildId, reservationId, status: "pending", reminderStatus: "pending" },
    { $set: { reminderStatus: "processing", reminderProcessingAt: new Date() } },
    { returnDocument: "after" },
  ).lean();
  if (!reservation) return;
  try {
    const currentBeforeSend = await KokuchiReservation.findOne({
      _id: reservation._id,
      status: "pending",
      reminderStatus: "processing",
    }).lean();
    if (!currentBeforeSend) return;
    // A cancellation can still win only after Discord has accepted the
    // outbound request; that API-level race cannot be recalled.
    const channel = await client.channels.fetch(reservation.commandChannelId).catch(() => null);
    if (!channel?.send) throw new Error("Reservation command channel is unavailable");
    await channel.send({ content: `<@${reservation.commandUserId}> 予約した告知の送信30分前です。\n告知は${formatJstReservationTime(new Date(reservation.scheduledAt), reservation.displayHour)}に送信されます。`, allowedMentions: { users: [reservation.commandUserId] } });
    const current = await KokuchiReservation.findOne({
      _id: reservation._id,
      status: "pending",
      reminderStatus: "processing",
    }).lean();
    if (!current) return;
    await KokuchiReservation.updateOne(
      { _id: reservation._id, status: "pending", reminderStatus: "processing" },
      { $set: { reminderStatus: "sent" }, $unset: { reminderProcessingAt: 1 } },
    );
  } catch (error) {
    await KokuchiReservation.updateOne(
      { _id: reservation._id, status: "pending", reminderStatus: "processing" },
      { $set: { reminderStatus: "failed" }, $unset: { reminderProcessingAt: 1 } },
    );
    console.error("Reserved /kokuchi reminder failed:", error);
  }
}

async function processKokuchiReservation(guildId, reservationId) {
  const reservation = await KokuchiReservation.findOneAndUpdate(
    { guildId, reservationId, status: "pending" },
    {
      $set: {
        status: "processing",
        processingAt: new Date(),
        publicationStatus: "processing",
        publicationStartedAt: new Date(),
        postProcessingStatus: "pending",
      },
    },
    { returnDocument: "after" },
  ).lean();
  if (!reservation) return;
  clearKokuchiReservationTimers(reservationId);
  const guild = client.guilds.cache.get(guildId) ?? await client.guilds.fetch(guildId).catch(() => null);
  let publication = null;
  try {
    const [sendChannel, overviewChannel, settings] = await Promise.all([
      guild?.channels.fetch(reservation.targetChannelId), guild?.channels.fetch(reservation.overviewChannelId), getGuildSettings(guildId),
    ]);
    if (!guild || !sendChannel?.send || !overviewChannel?.send) throw new Error("Configured channel is unavailable");
    let eventAt = new Date(reservation.eventAt);
    if (!Number.isFinite(eventAt.getTime())) {
      eventAt = getNextKokuchiEventAt({
        weekday: reservation.weekday,
        eventTime: normalizeKokuchiEventTime(settings?.kokuchiEventTime) ?? "21:00",
        now: new Date(reservation.scheduledAt),
      });
      if (!Number.isFinite(eventAt?.getTime())) {
        throw new Error("Reserved kokuchi has no valid eventAt");
      }
      const eventAtSaved = await KokuchiReservation.updateOne(
        { _id: reservation._id, status: "processing" },
        { $set: { eventAt } },
      );
      if (eventAtSaved.matchedCount !== 1) {
        throw new Error("Reserved kokuchi eventAt could not be persisted");
      }
    }
    publication = await publishKokuchi({
      guild,
      weekday: reservation.weekday,
      sendChannel,
      overviewChannel,
      settings,
      eventAt,
      kokuchiEventId: reservation.reservationId,
      leaseKey: `kokuchi-publish:${guild.id}:${reservation.eventDate ?? getKokuchiEventDate(reservation.scheduledAt, reservation.displayHour)}`,
      onPublished: async ({ postedMessage, postedAt }) => {
        const publicationPersisted = await KokuchiReservation.updateOne(
          { _id: reservation._id, status: "processing" },
          {
            $set: {
              publicationStatus: "published",
              publicationChannelId: postedMessage.channelId,
              publicationMessageId: postedMessage.id,
              publicationSentAt: postedAt,
              postProcessingStatus: "processing",
            },
          },
        );
        if (publicationPersisted.matchedCount !== 1 || publicationPersisted.modifiedCount !== 1) {
          throw new Error("Reservation publication succeeded but its message ID could not be persisted.");
        }
      },
    });
    const sentPersisted = await KokuchiReservation.updateOne(
      { _id: reservation._id, status: "processing" },
      {
        $set: {
          status: "sent",
          sentAt: new Date(),
          cleanupAt: getKokuchiReservationCleanupAt(),
          publicationStatus: "published",
          publicationConfirmedAt: new Date(),
          postProcessingStatus: "completed",
        },
        $unset: { activeKey: 1, processingAt: 1, postProcessingError: 1 },
      },
    );
    if (sentPersisted.matchedCount !== 1 || sentPersisted.modifiedCount !== 1) {
      throw new Error("Reservation publication completed but sent status could not be persisted; automatic retry is disabled to prevent duplicates.");
    }
    await editKokuchiReservationConfirmation(
      reservation,
      `【送信済み】\n\n告知を${formatJstReservationTime(new Date(reservation.scheduledAt), reservation.displayHour)}に送信しました。未実行の後続処理は下のボタンでキャンセルできます。`,
      createKokuchiCancellationComponents(reservation),
    );
  } catch (error) {
    const confirmedPublication = publication?.postedMessage ?? error?.kokuchiPublication ?? null;
    const publicationUnconfirmed = Boolean(confirmedPublication || error?.kokuchiPublicationAttempted === true);
    await KokuchiReservation.updateOne(
      { _id: reservation._id, status: "processing" },
      {
        $set: publicationUnconfirmed
          ? {
            status: "published_unconfirmed",
            publicationStatus: "published_unconfirmed",
            publicationChannelId: confirmedPublication?.channelId,
            publicationMessageId: confirmedPublication?.messageId,
            publicationSentAt: confirmedPublication?.sentAt ?? new Date(),
            postProcessingStatus: "failed",
            postProcessingError: error.message,
            publishedAt: new Date(),
            failedAt: new Date(),
            recoveryReason: `Discord publication may have succeeded; manual confirmation required: ${error.message}`,
          }
          : {
            status: "failed",
            publicationStatus: "failed_before_publish",
            postProcessingStatus: "failed",
            postProcessingError: error.message,
            failedAt: new Date(),
            cleanupAt: getKokuchiReservationCleanupAt(),
          },
        $unset: publicationUnconfirmed
          ? { activeKey: 1, processingAt: 1 }
          : { activeKey: 1, processingAt: 1, publicationKey: 1 },
      },
    );
    await editKokuchiReservationConfirmation(
      reservation,
      publicationUnconfirmed
        ? "【送信状態を確認中】\n\n告知投稿後の確認処理に失敗しました。重複投稿を防ぐため自動再送は行いません。"
        : "【送信失敗】\n\n予約していた告知を送信できませんでした。\n送信先チャンネルやBotの権限をご確認ください。",
    );
    const commandChannel = await client.channels.fetch(reservation.commandChannelId).catch(() => null);
    await commandChannel?.send?.({ content: `<@${reservation.commandUserId}> 予約していた告知を送信できませんでした。`, allowedMentions: { users: [reservation.commandUserId] } }).catch((error) => logRecoverableError("Recoverable asynchronous operation failed", error));
    await sendOperationalLog({ guild, settings: await getGuildSettings(guildId).catch(() => null), fallbackChannel: commandChannel, content: `予約告知送信失敗: ${error.message}` }).catch((error) => logRecoverableError("Recoverable asynchronous operation failed", error));
  }
}

async function resumeKokuchiPostProcessing(reservation) {
  const guild = client.guilds.cache.get(reservation.guildId)
    ?? await client.guilds.fetch(reservation.guildId).catch(() => null);
  if (!guild) throw new Error("Guild is unavailable for kokuchi post-processing recovery");

  const postedAt = new Date(reservation.publicationSentAt ?? reservation.publishedAt ?? reservation.scheduledAt);
  if (!Number.isFinite(postedAt.getTime())) throw new Error("Published kokuchi reservation has no valid publication time");

  const currentSettings = await getGuildSettings(guild.id);
  const eventAt = new Date(reservation.eventAt ?? getNextKokuchiEventAt({
    weekday: reservation.weekday,
    eventTime: normalizeKokuchiEventTime(currentSettings?.kokuchiEventTime) ?? "21:00",
    now: postedAt,
  }));
  if (!Number.isFinite(eventAt.getTime())) throw new Error("Published kokuchi reservation has no valid event time");
  if (!reservation.eventAt) {
    const eventAtSaved = await KokuchiReservation.updateOne(
      { _id: reservation._id, status: { $in: ["processing", "published_unconfirmed"] } },
      { $set: { eventAt } },
    );
    if (eventAtSaved.matchedCount !== 1) {
      throw new Error("Recovered kokuchi eventAt could not be persisted");
    }
  }
  const preNoticeAt = getKokuchiPreNoticeAt(eventAt);
  const unlockAt = getGatheringVcUnlockAt(eventAt);
  const reminderAt = getKokuchiGatheringReminderAt(eventAt);
  const savedSettings = await saveGuildSettingsWithCurrent(guild.id, currentSettings, {
    lastKokuchiWeekday: reservation.weekday,
    lastKokuchiPostedAt: postedAt.toISOString(),
    lastKokuchiMessageId: reservation.publicationMessageId,
    lastKokuchiChannelId: reservation.publicationChannelId ?? reservation.targetChannelId,
    kokuchiEventId: reservation.reservationId,
    kokuchiEventAt: eventAt.toISOString(),
    kokuchiPreNoticeAt: preNoticeAt.toISOString(),
    kokuchiPreNoticeChannelId: reservation.publicationChannelId ?? reservation.targetChannelId,
    kokuchiPreNoticeState: preNoticeAt.getTime() > postedAt.getTime() ? "pending" : "skipped",
    gatheringVcUnlockAt: unlockAt.toISOString(),
    gatheringVcUnlockChannelId: resolveKokuchiGatheringVoiceChannelId(currentSettings, currentSettings),
    gatheringVcUnlockState: unlockAt.getTime() > postedAt.getTime() ? "pending" : "skipped",
    kokuchiGatheringReminderAt: reminderAt.toISOString(),
    kokuchiGatheringReminderChannelId: reservation.publicationChannelId ?? reservation.targetChannelId,
    kokuchiGatheringReminderState: reminderAt.getTime() > postedAt.getTime() ? "pending" : "skipped",
  });
  await scheduleKokuchiPreNotice(guild, savedSettings);
  await scheduleGatheringVcUnlock(guild, savedSettings);
  await scheduleKokuchiGatheringReminder(guild, savedSettings);

  const completed = await KokuchiReservation.updateOne(
    { _id: reservation._id, status: { $in: ["processing", "published_unconfirmed"] } },
    {
      $set: {
        status: "sent",
        sentAt: new Date(),
        cleanupAt: getKokuchiReservationCleanupAt(),
        publicationStatus: "published",
        publicationConfirmedAt: new Date(),
        postProcessingStatus: "completed",
      },
      $unset: { activeKey: 1, processingAt: 1, postProcessingError: 1 },
    },
  );
  if (completed.matchedCount !== 1 || completed.modifiedCount !== 1) {
    throw new Error("Kokuchi post-processing completion could not be persisted");
  }
  await editKokuchiReservationConfirmation(
    reservation,
    `【送信済み】\n\n告知を${formatJstReservationTime(new Date(reservation.scheduledAt), reservation.displayHour)}に送信しました。未実行の後続処理は下のボタンでキャンセルできます。`,
    createKokuchiCancellationComponents(reservation),
  );
}

function createKokuchiCancellationComponents(reservation) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${KOKUCHI_RESERVATION_CANCEL_CUSTOM_ID}:${reservation.reservationId}`).setLabel("後続処理をキャンセル").setStyle(ButtonStyle.Danger),
  )];
}

async function editKokuchiReservationConfirmation(reservation, content, components = []) {
  const channel = await client.channels.fetch(reservation.confirmationChannelId).catch(() => null);
  const message = await channel?.messages?.fetch?.(reservation.confirmationMessageId).catch(() => null);
  await message?.edit({ content, components }).catch((error) => logRecoverableError("Failed to update kokuchi reservation confirmation", error));
}

async function createKokuchiCancellationControl(channel, reservation) {
  if (!channel?.send) return null;
  const confirmation = await channel.send({
    content: "【告知後の操作】\n\n未実行の事前通知・集合VC開放・集合開始通知をキャンセルできます。",
    components: createKokuchiCancellationComponents(reservation),
  });
  const persisted = await KokuchiReservation.updateOne(
    { _id: reservation._id, status: "sent", confirmationMessageId: null },
    { $set: { confirmationChannelId: confirmation.channelId, confirmationMessageId: confirmation.id } },
  );
  if (persisted.matchedCount !== 1) {
    await confirmation.delete().catch(() => null);
    return null;
  }
  return confirmation;
}

async function handleKokuchiReservationCancel(interaction) {
  // Acknowledge the component before looking up or changing MongoDB state so
  // a slow database cannot make the cancellation button appear to fail.
  await interaction.deferUpdate();
  const reservationId = interaction.customId.slice(`${KOKUCHI_RESERVATION_CANCEL_CUSTOM_ID}:`.length);
  const reservation = await KokuchiReservation.findOne({ reservationId }).lean();
  if (!reservation) {
    await interaction.followUp({ content: "この告知予約は見つかりません。", flags: MessageFlags.Ephemeral });
    return;
  }
  const permitted = reservation.commandUserId === interaction.user.id || interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
  if (!permitted) {
    await interaction.followUp({ content: "この告知予約をキャンセルする権限がありません。", flags: MessageFlags.Ephemeral });
    return;
  }
  if (!["pending", "sent", "cancel_partial"].includes(reservation.status)) {
    const content = reservation.status === "canceled"
        ? "この告知予約はすでにキャンセルされています。"
        : reservation.status === "failed"
          ? "この告知予約は送信失敗として終了しています。"
          : "この告知予約は現在送信処理中のため、キャンセルできません。";
    await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
    return;
  }
  const reminderStatus = getKokuchiReminderStatusOnCancel(reservation.reminderStatus);
  const reminderPatch = reminderStatus === reservation.reminderStatus ? {} : { reminderStatus };
  const canceled = await KokuchiReservation.findOneAndUpdate(
    { _id: reservation._id, status: { $in: ["pending", "sent", "cancel_partial"] } },
    {
      $set: {
        status: "canceling",
        cancellationStartedAt: new Date(),
        cancellationError: null,
        ...reminderPatch,
      },
    },
    { returnDocument: "after", lean: true },
  );
  if (canceled) {
    const cancellation = await completeKokuchiCancellation({
      reservation: canceled,
      guild: interaction.guild ?? await client.guilds.fetch(canceled.guildId).catch(() => null),
    });
    const completeContent = formatKokuchiCancellationResult(cancellation);
    await interaction.editReply({
      content: completeContent,
      components: cancellation.status === "canceled" ? [] : createKokuchiCancellationComponents(canceled),
    });
    await sendOperationalLog({
      guild: interaction.guild,
      settings: cancellation.settings,
      fallbackChannel: interaction.channel,
      content: `kokuchi cancellation ${canceled.reservationId}: ${cancellation.status}; ${completeContent.replace(/\n/g, " ")}`,
    }).catch((error) => logRecoverableError("Failed to log kokuchi reservation cancellation", error));
    return;
  }
  await interaction.followUp({ content: "この告知予約はすでに処理されています。", flags: MessageFlags.Ephemeral });
}

function emptyKokuchiCancellationResult() {
  return { canceled: 0, alreadyCompleted: 0, alreadyCanceled: 0, failed: 0, errors: [] };
}

function addKokuchiCancellationResult(total, next) {
  for (const key of ["canceled", "alreadyCompleted", "alreadyCanceled", "failed"]) {
    total[key] += Number(next?.[key] ?? 0);
  }
  total.errors.push(...(Array.isArray(next?.errors) ? next.errors : []));
}

function formatKokuchiCancellationResult(result) {
  const heading = result.status === "canceled" ? "【キャンセル完了】" : "【キャンセル一部完了】";
  return [
    heading,
    `キャンセル成功：${result.canceled}件`,
    `すでに実行済み：${result.alreadyCompleted}件`,
    `すでにキャンセル済み：${result.alreadyCanceled}件`,
    `失敗：${result.failed}件`,
    `VC権限復元：${result.permissionRestored === "restored" ? "成功" : result.permissionRestored === "not_needed" ? "不要" : "失敗"}`,
    ...(result.status === "cancel_partial" ? ["失敗した処理は同じボタンから再試行できます。"] : []),
  ].join("\n");
}

async function completeKokuchiCancellation({ reservation, guild }) {
  const result = emptyKokuchiCancellationResult();
  clearKokuchiReservationTimers(reservation.reservationId);
  let settings = null;
  try {
    settings = await getGuildSettings(reservation.guildId);
  } catch (error) {
    result.failed += 1;
    result.errors.push(`GuildSettings could not be read: ${error.message}`);
  }

  const isCurrentEvent = settings?.kokuchiEventId === reservation.reservationId;
  if (isCurrentEvent) {
    clearKokuchiPreNoticeTimer(reservation.guildId);
    clearGatheringVcUnlockTimer(reservation.guildId);
    clearKokuchiGatheringReminderTimer(reservation.guildId);
  }

  const work = await Promise.allSettled([
    cancelKokuchiTimedActions({ guildId: reservation.guildId, kokuchiEventId: reservation.reservationId }),
    cancelKokuchiScheduledActions({ guildId: reservation.guildId, kokuchiEventId: reservation.reservationId }),
  ]);
  for (const item of work) {
    if (item.status === "fulfilled") addKokuchiCancellationResult(result, item.value);
    else {
      result.failed += 1;
      result.errors.push(item.reason?.message ?? String(item.reason));
    }
  }

  let permissionRestored = "not_needed";
  if (isCurrentEvent && (settings?.gatheringVcUnlockState === "opened" || settings?.gatheringVcRestorePending)) {
    if (!guild) {
      permissionRestored = "failed";
      result.failed += 1;
      result.errors.push("Guild was unavailable for gathering VC permission restoration.");
    } else {
      const restored = await restoreGatheringVcPermissionAfterSplit(guild, settings).catch((error) => {
        result.errors.push(`Gathering VC permission restoration failed: ${error.message}`);
        return false;
      });
      if (restored) permissionRestored = "restored";
      else {
        permissionRestored = "failed";
        result.failed += 1;
      }
    }
  }

  const status = result.failed === 0 ? "canceled" : "cancel_partial";
  const updated = await KokuchiReservation.updateOne(
    { _id: reservation._id, status: "canceling" },
    {
      $set: {
        status,
        cancellationResults: result,
        ...(status === "canceled"
          ? { canceledAt: new Date(), cleanupAt: getKokuchiReservationCleanupAt(), cancellationError: null }
          : { cancellationError: result.errors.join(" | ").slice(0, 4000) }),
      },
      $unset: status === "canceled" ? { activeKey: 1, cancellationStartedAt: 1 } : { activeKey: 1 },
    },
  );
  if (updated.matchedCount !== 1) {
    throw new Error("Kokuchi cancellation final state could not be persisted.");
  }
  return { ...result, status, settings, permissionRestored };
}

async function restoreKokuchiReservations() {
  // Never automatically replay an interrupted publication: it may already
  // have reached Discord before the process stopped.
  const interrupted = await KokuchiReservation.find({ status: "processing" }).lean();
  for (const reservation of interrupted) {
    try {
      if (reservation.publicationMessageId) {
        await resumeKokuchiPostProcessing(reservation);
        continue;
      }
      const failed = await KokuchiReservation.findOneAndUpdate(
        { _id: reservation._id, status: "processing" },
        {
          $set: {
            status: "failed",
            failedAt: new Date(),
            cleanupAt: getKokuchiReservationCleanupAt(),
            recoveryReason: "Bot restarted while reservation publication was processing",
          },
          $unset: { activeKey: 1, processingAt: 1 },
        },
        { returnDocument: "after", lean: true },
      );
      if (!failed) continue;
      await editKokuchiReservationConfirmation(failed, "【送信失敗】\n\nBotの再起動中に送信処理が中断されたため、予約していた告知を送信できませんでした。\n重複投稿防止のため、自動再送は行っていません。");
      const commandChannel = await client.channels.fetch(failed.commandChannelId).catch(() => null);
      await commandChannel?.send?.({
        content: `<@${failed.commandUserId}> 予約告知の送信処理がBot再起動により中断されました。`,
        allowedMentions: { users: [failed.commandUserId] },
      }).catch((error) => logRecoverableError("Recoverable asynchronous operation failed", error));
      const guild = client.guilds.cache.get(failed.guildId) ?? await client.guilds.fetch(failed.guildId).catch(() => null);
      await sendOperationalLog({
        guild,
        settings: await getGuildSettings(failed.guildId).catch(() => null),
        fallbackChannel: commandChannel,
        content: `予約告知を再起動中断として失敗にしました。予約ID: ${failed.reservationId}`,
      }).catch((error) => logRecoverableError("Recoverable asynchronous operation failed", error));
    } catch (error) {
      console.error(`Failed to recover interrupted kokuchi reservation ${reservation.reservationId}: ${error.message}`);
    }
  }
  await KokuchiReservation.updateMany(
    { status: "pending", reminderStatus: "processing" },
    { $set: { reminderStatus: "failed" }, $unset: { reminderProcessingAt: 1 } },
  );
  const unconfirmedPublications = await KokuchiReservation.find({
    status: "published_unconfirmed",
    publicationMessageId: { $exists: true, $ne: null },
  }).lean();
  for (const reservation of unconfirmedPublications) {
    try {
      await resumeKokuchiPostProcessing(reservation);
    } catch (error) {
      console.error(`Failed to resume kokuchi post-processing ${reservation.reservationId}: ${error.message}`);
    }
  }
  const unfinishedCancellations = await KokuchiReservation.find({
    status: { $in: ["canceling", "cancel_partial"] },
  }).lean();
  for (const pendingCancellation of unfinishedCancellations) {
    try {
      const canceling = pendingCancellation.status === "canceling"
        ? pendingCancellation
        : await KokuchiReservation.findOneAndUpdate(
          { _id: pendingCancellation._id, status: "cancel_partial" },
          { $set: { status: "canceling", cancellationStartedAt: new Date() } },
          { returnDocument: "after", lean: true },
        );
      if (!canceling) continue;
      const guild = client.guilds.cache.get(canceling.guildId)
        ?? await client.guilds.fetch(canceling.guildId).catch(() => null);
      const result = await completeKokuchiCancellation({ reservation: canceling, guild });
      await editKokuchiReservationConfirmation(
        canceling,
        formatKokuchiCancellationResult(result),
        result.status === "canceled" ? [] : createKokuchiCancellationComponents(canceling),
      );
    } catch (error) {
      console.error(`Failed to resume kokuchi cancellation ${pendingCancellation.reservationId}: ${error.message}`);
    }
  }
  const reservations = await KokuchiReservation.find({ status: "pending" }).lean();
  for (const reservation of reservations) {
    try {
      const guild = client.guilds.cache.get(reservation.guildId) ?? await client.guilds.fetch(reservation.guildId).catch(() => null);
      if (!guild) continue;
      if (new Date(reservation.scheduledAt).getTime() <= Date.now()) await processKokuchiReservation(guild.id, reservation.reservationId);
      else await scheduleKokuchiReservation(guild, reservation);
    } catch (error) {
      console.error(`Failed to restore kokuchi reservation ${reservation.reservationId}: ${error.message}`);
    }
  }
}

function getGatheringVcUnlockChannelId(settings) {
  return (
    settings?.gatheringVcUnlockChannelId ??
    settings?.gatheringVoiceChannelId ??
    null
  );
}

function normalizeKokuchiEventTime(value) {
  if (typeof value !== "string") return null;
  const match = /^(\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function getKokuchiTimedActionAt(eventAt, minutesBefore) {
  return new Date(new Date(eventAt).getTime() - minutesBefore * 60_000);
}

function formatKokuchiDerivedTime(settings, minutesBefore) {
  const [hour, minute] = (normalizeKokuchiEventTime(settings?.kokuchiEventTime) ?? "21:00")
    .split(":")
    .map(Number);
  const minutes = (hour * 60 + minute - minutesBefore + 24 * 60) % (24 * 60);
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

function getKokuchiPreNoticeAt(eventAt) {
  return getKokuchiTimedActionAt(eventAt, 30);
}

function getGatheringVcUnlockAt(eventAt) {
  return getKokuchiTimedActionAt(eventAt, 20);
}

function getKokuchiGatheringReminderAt(eventAt) {
  return getKokuchiTimedActionAt(eventAt, 5);
}

function getKokuchiEventAtOnSameJstDate(previousEventAt, eventTime) {
  const prior = new Date(previousEventAt);
  const [hour, minute] = (normalizeKokuchiEventTime(eventTime) ?? "21:00").split(":").map(Number);
  const jst = new Date(prior.getTime() + 9 * 60 * 60 * 1000);
  return new Date(Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate(), hour - 9, minute, 0, 0));
}

async function rescheduleCurrentKokuchiEvent(guild, previousSettings, nextSettings) {
  const eventId = previousSettings?.kokuchiEventId;
  if (!eventId || previousSettings?.kokuchiEventId !== nextSettings?.kokuchiEventId) return false;
  const settingsChanged = previousSettings.kokuchiEventTime !== nextSettings.kokuchiEventTime
    || previousSettings.gatheringVoiceChannelId !== nextSettings.gatheringVoiceChannelId
    || getKokuchiAnnouncementChannelId(previousSettings) !== getKokuchiAnnouncementChannelId(nextSettings);
  if (!settingsChanged) return false;
  const reservation = await KokuchiReservation.findOne({ reservationId: eventId, status: "sent" }).lean();
  if (!reservation) return false;
  const eventAt = getKokuchiEventAtOnSameJstDate(previousSettings.kokuchiEventAt ?? reservation.eventAt, nextSettings.kokuchiEventTime);
  if (!Number.isFinite(eventAt.getTime())) return false;
  clearKokuchiPreNoticeTimer(guild.id);
  clearGatheringVcUnlockTimer(guild.id);
  clearKokuchiGatheringReminderTimer(guild.id);
  const now = new Date();
  const stateFor = (previousState, at) => {
    if (!["pending", "failed"].includes(previousState)) return previousState;
    return at.getTime() > now.getTime() ? "pending" : "skipped";
  };
  const preNoticePending = ["pending", "failed"].includes(previousSettings.kokuchiPreNoticeState);
  const unlockPending = ["pending", "failed"].includes(previousSettings.gatheringVcUnlockState);
  const reminderPending = ["pending", "failed"].includes(previousSettings.kokuchiGatheringReminderState);
  const saved = await saveGuildSettingsWithCurrent(guild.id, nextSettings, {
    kokuchiEventAt: eventAt.toISOString(),
    ...(preNoticePending ? {
      kokuchiPreNoticeAt: getKokuchiPreNoticeAt(eventAt).toISOString(),
      kokuchiPreNoticeChannelId: getKokuchiAnnouncementChannelId(nextSettings),
      kokuchiPreNoticeState: stateFor(previousSettings.kokuchiPreNoticeState, getKokuchiPreNoticeAt(eventAt)),
    } : {}),
    ...(unlockPending ? {
      gatheringVcUnlockAt: getGatheringVcUnlockAt(eventAt).toISOString(),
      gatheringVcUnlockChannelId: getGatheringVcUnlockChannelId(nextSettings),
      gatheringVcUnlockState: stateFor(previousSettings.gatheringVcUnlockState, getGatheringVcUnlockAt(eventAt)),
    } : {}),
    ...(reminderPending ? {
      kokuchiGatheringReminderAt: getKokuchiGatheringReminderAt(eventAt).toISOString(),
      kokuchiGatheringReminderChannelId: getKokuchiAnnouncementChannelId(nextSettings),
      kokuchiGatheringReminderState: stateFor(previousSettings.kokuchiGatheringReminderState, getKokuchiGatheringReminderAt(eventAt)),
    } : {}),
  });
  await KokuchiReservation.updateOne(
    { _id: reservation._id, status: "sent" },
    { $set: { eventAt } },
  );
  await Promise.all([
    preNoticePending ? scheduleKokuchiPreNotice(guild, saved) : null,
    unlockPending ? scheduleGatheringVcUnlock(guild, saved) : null,
    reminderPending ? scheduleKokuchiGatheringReminder(guild, saved) : null,
  ]);
  await sendOperationalLog({
    guild,
    settings: saved,
    fallbackChannel: null,
    content: `kokuchi開催設定を変更したため、未実行の後続処理を再スケジュールしました。開催回: ${eventId}`,
  }).catch((error) => logRecoverableError("Failed to log kokuchi rescheduling", error));
  return true;
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
      ? `通話待機システムの募集メッセージを ${result.channel} に送信しました。${formatJstTime(result.targetAt)} に希望者を確認します。`
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

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
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
  await interaction.deferUpdate();
  const result = await createOteboRecruitmentFromDraft(interaction, "");

  if (!result.ok) {
    await interaction.editReply({
      content: result.reason,
      components: result.keepDraft
        ? createOteboDraftRows(result.draft)
        : [],
      allowedMentions: { parse: [] },
    });
    return;
  }

  await interaction.editReply({
    content: formatOteboOwnerCancelMessage(),
    components: [],
    allowedMentions: { parse: [] },
  });
}

async function handleOteboNoteModal(interaction) {
  const note = interaction.fields.getTextInputValue("note") ?? "";
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const result = await createOteboRecruitmentFromDraft(interaction, note);

  if (!result.ok) {
    await interaction.editReply({
      content: result.reason,
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
    return;
  }

  await updateOteboDraftMenuAfterModal(result.draftMenu);

  await interaction.editReply({
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
  await interaction.deferUpdate();
  const settings = await getGuildSettings(interaction.guildId);
  const recruitment = getOteboRecruitment(settings, recruitmentId);

  if (!isActiveOteboRecruitment(recruitment)) {
    await interaction.editReply({
      content: "この募集は現在有効ではありません。",
      components: [],
    });
    return;
  }

  if (interaction.user.id !== recruitment.ownerId) {
    await interaction.editReply({
      content: "この確認ボタンを使えるのは募集作成者だけです。",
      components: [],
    });
    return;
  }

  if (!normalizeCallWaitMemberIds(recruitment.memberIds).includes(interaction.user.id)) {
    await interaction.editReply({
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
    response: "editReply",
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
  if (response === "update" || response === "editReply") {
    await interaction[response]({
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
  if (shuttingDown) return;
  if (callWaitTimer) {
    clearTimeout(callWaitTimer);
  }

  const now = new Date();
  const delayMs = Math.min(...CALL_WAIT_INTERVAL_MINUTES.map((intervalMinutes) =>
    getMsUntilNextJstCallWaitSlot({ now, intervalMinutes }),
  ));
  callWaitTimer = setTimeout(() => {
    processingScheduledCallWaitTick = true;
    void processCallWaitForAllGuilds()
      .catch((error) => {
        console.error(error);
      })
      .finally(() => {
        processingScheduledCallWaitTick = false;
        scheduleNextCallWaitTick();
      });
  }, delayMs);
}

async function processCallWaitForAllGuilds() {
  if (shuttingDown) return;
  for (const guild of client.guilds.cache.values()) {
    // Settings retrieval is also an external MongoDB operation.  Keep it in
    // the per-guild boundary so one unavailable document cannot prevent every
    // other guild from receiving its scheduled evaluation.
    try {
      const settings = await getGuildSettings(guild.id);
      await processCallWaitForGuild(guild, settings);
    } catch (error) {
      console.error(`Failed to process call wait for ${guild.id}: ${error.message}`, error);
    }
  }
  await retryPendingCallWaitEndNotifications().catch((error) => {
    console.error("Call-wait end notification retry failed:", error);
  });
}

async function processCallWaitForGuild(guild, settings) {
  if (callWaitGuildLocks.has(guild.id)) return;
  callWaitGuildLocks.add(guild.id);
  let lease = null;
  try {
    lease = await acquireMongoLease(`callwait:${guild.id}`, { leaseMs: 5 * 60 * 1000 });
    if (!lease) return;
    await endOrphanedCallWaitInterests(guild.id, settings?.callWaitPrompt?.messageId);
    if (settings?.callWaitEnabled !== true) {
      const prompt = settings?.callWaitPrompt;
      if (prompt?.messageId) {
        const closing = await transitionCallWaitPrompt({
          guildId: guild.id,
          messageId: prompt.messageId,
          fromStates: ["open", "evaluating", "role_granting", "failed"],
          toState: "closing",
          patch: { lastError: "Closing call-wait prompt because the feature is disabled" },
        });
        if (closing) {
          await endCallWaitInterestsForRecruitment(guild.id, prompt.messageId);
          await deleteCallWaitPrompt(guild, prompt).catch((error) => {
            console.error(`Failed to delete disabled call-wait prompt ${prompt.messageId}: ${error.message}`);
          });
          await saveGuildSettingsWithCurrent(guild.id, closing, { callWaitPrompt: null });
        }
      }
      return;
    }

  const configured = await validateCallWaitSettings(guild, settings);
  const now = new Date();

  if (!configured.ok) {
    const expiredPrompt = settings.callWaitPrompt;
    if (
      expiredPrompt?.messageId
      && (
        !Number.isFinite(new Date(expiredPrompt.targetAt).getTime())
        || new Date(expiredPrompt.targetAt).getTime() <= now.getTime()
      )
    ) {
      const closing = await transitionCallWaitPrompt({
        guildId: guild.id,
        messageId: expiredPrompt.messageId,
        fromStates: ["open", "evaluating", "role_granting", "failed"],
        toState: "closing",
        patch: { lastError: `Closing expired prompt because call-wait settings are incomplete: ${configured.reason}` },
      });
      if (closing) {
        await endCallWaitInterestsForRecruitment(guild.id, expiredPrompt.messageId);
        await deleteCallWaitPrompt(guild, expiredPrompt).catch((error) => {
          console.error(`Failed to delete expired call-wait prompt ${expiredPrompt.messageId}: ${error.message}`);
        });
        await saveGuildSettingsWithCurrent(guild.id, closing, { callWaitPrompt: null });
        await sendOperationalLog({
          guild,
          settings: closing,
          fallbackChannel: null,
          content: `設定不備のため、期限到達済みの定時募集を終了しました。募集ID: ${expiredPrompt.messageId}`,
        });
      }
    }
    return;
  }

  if (
    settings.callWaitPrompt?.messageId
    && new Date(settings.callWaitPrompt.targetAt).getTime() <= now.getTime()
  ) {
    const transitioned = await transitionCallWaitPrompt({
      guildId: guild.id,
      messageId: settings.callWaitPrompt.messageId,
      fromStates: ["open", "evaluating", "failed"],
      toState: "evaluating",
    });
    if (!transitioned) return;
    settings = transitioned;
  }
  const promptResult = await evaluateCallWaitPrompt(guild, settings, now);

  if (promptResult.evaluated) {
    const evaluatedRecruitmentId = settings.callWaitPrompt?.messageId;
    const evaluatedPrompt = settings.callWaitPrompt;

    if (promptResult.memberIds.length >= CALL_WAIT_MIN_MEMBERS) {
      const roleGranting = await transitionCallWaitPrompt({
        guildId: guild.id,
        messageId: evaluatedRecruitmentId,
        fromStates: ["evaluating"],
        toState: "role_granting",
      });
      if (!roleGranting) return;
      const queued = await grantCallWaitRoleAndQueueNotice({
        guild,
        settings: roleGranting,
        memberIds: promptResult.memberIds,
        sourceId: evaluatedRecruitmentId,
      });

      if (queued) {
        await endCallWaitInterestsForRecruitment(guild.id, evaluatedRecruitmentId);
        settings = await saveGuildSettingsWithCurrent(guild.id, roleGranting, {
          callWaitPrompt: null,
        });
        await deleteCallWaitPrompt(guild, roleGranting.callWaitPrompt).catch((error) => {
          console.error(`Failed to delete completed call-wait prompt ${evaluatedRecruitmentId}: ${error.message}`);
        });
        await scheduleCallWaitFollowupCheck(guild);
        return;
      }
      await transitionCallWaitPrompt({
        guildId: guild.id,
        messageId: evaluatedRecruitmentId,
        fromStates: ["role_granting"],
        toState: "failed",
      });
      return;
    }

    await endCallWaitInterestsForRecruitment(guild.id, evaluatedRecruitmentId);
    settings = await saveGuildSettingsWithCurrent(guild.id, settings, {
      callWaitPrompt: null,
    });
    await deleteCallWaitPrompt(guild, evaluatedPrompt).catch((error) => {
      console.error(`Failed to delete evaluated call-wait prompt ${evaluatedRecruitmentId}: ${error.message}`);
    });
    if (promptResult.mode === CALL_WAIT_MODE_BUTTON) {
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
  if (await isKokuchiCallWaitPaused(settings, guild.id, now)) {
    return;
  }

  if (activeVoiceMemberIds.length >= CALL_WAIT_MIN_MEMBERS) {
    if (settings.callWaitPrompt) {
      await endCallWaitInterestsForRecruitment(guild.id, settings.callWaitPrompt.messageId);
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

    if (
      !processingScheduledCallWaitTick
      || isJstCallWaitSlotDue({
        now,
        intervalMinutes: getCallWaitIntervalMinutes(settings),
      })
    ) {
      await sendCallWaitPromptForGuild(guild, settings, { force: false, now });
    }
  } finally {
    if (lease) {
      await releaseMongoLease(lease).catch((error) => {
        console.error(`Failed to release call-wait lease for ${guild.id}: ${error.message}`);
      });
    }
    callWaitGuildLocks.delete(guild.id);
  }
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
    await endCallWaitInterestsForRecruitment(guild.id, settings.callWaitPrompt.messageId);
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

  const targetAt = getNextJstCallWaitSlot({
    now,
    intervalMinutes: getCallWaitIntervalMinutes(settings),
  });
  const message = await configured.promptChannel.send({
    content: formatCallWaitPromptV2(targetAt),
    allowedMentions: { parse: [] },
    components: [createCallWaitInterestRow()],
  });

  try {
    await saveGuildSettingsWithCurrent(guild.id, settings, {
      callWaitPrompt: {
        channelId: configured.promptChannel.id,
        messageId: message.id,
        targetAt: targetAt.toISOString(),
        slotKey: getCallWaitSlotKey(targetAt, settings),
        mode: CALL_WAIT_MODE_BUTTON,
        memberIds: [],
        lifecycleState: "open",
        lifecycleUpdatedAt: new Date().toISOString(),
      },
      callWaitPendingNotice: null,
      callWaitSkippedNotice: null,
    });
  } catch (error) {
    // A visible prompt without a persisted identity cannot be evaluated or
    // closed safely on a later tick, so remove that orphan before surfacing
    // the failure to the scheduler.
    await message.delete().catch((error) => logRecoverableError("Failed to delete call-wait prompt", error));
    throw error;
  }

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

  const memberIds = normalizeCallWaitMemberIds(prompt.memberIds);
  return { evaluated: true, memberIds, mode: CALL_WAIT_MODE_BUTTON };
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

function getCallWaitInterestComponents(recruitmentId, {
  includeJoin = false,
  showThreshold = false,
  threshold = 1,
  linkUrl = null,
  allowRenotification = false,
  disabled = false,
} = {}) {
  const rows = [];
  if (showThreshold) {
    rows.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`${CALL_WAIT_INTEREST_SELECT_CUSTOM_ID}:${recruitmentId}`)
        .setPlaceholder(`通知条件：参加予定者${threshold}人以上`)
        .setDisabled(disabled)
        .addOptions(
          { label: "参加予定者が1人以上になったら通知", description: "自分が参加すると2人以上になります", value: "1", default: threshold === 1 },
          { label: "参加予定者が2人以上になったら通知", description: "自分が参加すると3人以上になります", value: "2", default: threshold === 2 },
          { label: "参加予定者が3人以上になったら通知", description: "自分が参加すると4人以上になります", value: "3", default: threshold === 3 },
        ),
    ));
  }
  const buttons = [];
  if (allowRenotification) buttons.push(new ButtonBuilder().setCustomId(`call_wait_interest_renotify:${recruitmentId}`).setLabel("再び集まったら通知する").setStyle(ButtonStyle.Primary).setDisabled(disabled));
  if (includeJoin) buttons.push(new ButtonBuilder().setCustomId(`call_wait_interest_join:${recruitmentId}`).setLabel("参加予定").setStyle(ButtonStyle.Success).setDisabled(disabled));
  if (linkUrl) buttons.push(new ButtonBuilder().setLabel("現在の募集を開く").setStyle(ButtonStyle.Link).setURL(linkUrl));
  buttons.push(new ButtonBuilder().setCustomId(`call_wait_interest_cancel:${recruitmentId}`).setLabel("興味ありを解除").setStyle(ButtonStyle.Danger).setDisabled(disabled));
  rows.push(new ActionRowBuilder().addComponents(buttons));
  return rows;
}

function buildCallWaitInterestReceiptContent({
  targetAt,
  participantCount,
  notificationThreshold,
  hasOtherInterest,
}) {
  const target = targetAt ? formatJstTime(new Date(targetAt)) : "今回";
  const currentCount = Math.max(0, Number(participantCount) || 0);
  const threshold = Math.min(3, Math.max(1, Number(notificationThreshold) || 1));
  const otherInterestNote = currentCount === 0 && hasOtherInterest
    ? "\n\n受付時点では、あなた以外にもこの募集に興味を持っている方がいます。"
    : "";
  if (currentCount === 0) {
    return `【興味ありを受け付けました】\n\n${target}からの定時募集に、興味ありとして登録しました。${otherInterestNote}\n\n参加予定者が指定した人数以上になった際に、DMでお知らせします。\n\n現在の通知条件：\n参加予定者が${threshold}人以上になったら通知\n\n通知条件は、下のメニューから変更できます。`;
  }
  return `【興味ありを受け付けました】\n\n${target}からの定時募集に、興味ありとして登録しました。\n\n現在の参加予定者数：${currentCount}人\nあなたが参加すると${currentCount + 1}人になります。\n\n参加する場合は、下の「参加予定」を押してください。\n通知条件の変更も可能です。`;
}

function formatCallWaitInterestEndedContent(interest) {
  return `【終了済み】\n\n${interest.targetAt ? formatJstTime(new Date(interest.targetAt)) : "今回"}からの定時募集は終了しました。\n今回の興味あり登録は自動的に解除されています。\n\n設定していた通知条件：\n参加予定者が${interest.notificationThreshold}人以上になったら通知`;
}

function formatCallWaitInterestCanceledContent(interest) {
  return `【解除済み】\n\n${interest.targetAt ? formatJstTime(new Date(interest.targetAt)) : "今回"}からの定時募集に対する興味ありを解除しました。\n\nこの募集についてのDM通知は送信されません。`;
}

function formatCallWaitInterestJoinedContent(interest) {
  return `【参加予定へ変更済み】\n\n${interest.targetAt ? formatJstTime(new Date(interest.targetAt)) : "今回"}からの定時募集に、参加予定として登録しました。\n\nこれにより興味あり登録が解除されました。`;
}

function getCallWaitPromptUrl(guildId, prompt) {
  if (!guildId || !prompt?.channelId || !prompt?.messageId) return null;
  return `https://discord.com/channels/${guildId}/${prompt.channelId}/${prompt.messageId}`;
}

function formatCallWaitInterestEndNotificationContent(interest) {
  const target = interest.targetAt ? formatJstTime(new Date(interest.targetAt)) : "今回";
  return `${target}からの定時募集は終了しました。\n\n今回の興味あり登録は自動的に解除されました。\n次回の募集に興味がある場合は、新しい募集から改めて「興味あり」を押してください。`;
}

async function endCallWaitInterestsForRecruitment(guildId, recruitmentId) {
  if (!recruitmentId) return;
  const interests = await CallWaitInterest.find({ guildId, recruitmentId, status: { $in: ["pending", "active", "joining"] } }).lean();
  for (const interest of interests) {
    const ended = await CallWaitInterest.findOneAndUpdate({ _id: interest._id, status: { $in: ["pending", "active", "joining"] } }, { $set: { status: "ended", endedAt: new Date() } }, { returnDocument: "after" }).lean();
    if (!ended) continue;
    await editCallWaitInterestMessages(ended, {
      content: formatCallWaitInterestEndedContent(ended),
      components: [],
    });
    const channel = await client.channels.fetch(ended.receiptDmChannelId).catch(() => null);
    if (!ended.endNotificationSentAt) {
      await CallWaitInterest.updateOne(
        { _id: ended._id, status: "ended", endNotificationSentAt: null },
        { $inc: { endNotificationAttemptCount: 1 }, $set: { endNotificationLastAttemptAt: new Date() } },
      );
      const sent = await channel?.send?.({ content: formatCallWaitInterestEndNotificationContent(ended) }).catch(() => null);
      if (sent) await CallWaitInterest.updateOne(
        { _id: ended._id, endNotificationSentAt: null },
        { $set: { endNotificationSentAt: new Date(), endNotificationStatus: "sent" } },
      );
    }
  }
  await retryPendingCallWaitEndNotifications();
}

async function retryPendingCallWaitEndNotifications() {
  const retryBefore = new Date(Date.now() - 5 * 60 * 1000);
  const interests = await CallWaitInterest.find({
    status: "ended",
    endNotificationSentAt: null,
    endNotificationStatus: { $ne: "failed" },
    endNotificationAttemptCount: { $lt: 3 },
    $or: [
      { endNotificationLastAttemptAt: null },
      { endNotificationLastAttemptAt: { $lte: retryBefore } },
    ],
  }).lean();
  for (const interest of interests) {
    const claimed = await CallWaitInterest.findOneAndUpdate(
      {
        _id: interest._id,
        status: "ended",
        endNotificationSentAt: null,
        endNotificationStatus: { $ne: "failed" },
        endNotificationAttemptCount: { $lt: 3 },
        $or: [
          { endNotificationLastAttemptAt: null },
          { endNotificationLastAttemptAt: { $lte: retryBefore } },
        ],
      },
      {
        $inc: { endNotificationAttemptCount: 1 },
        $set: { endNotificationLastAttemptAt: new Date() },
      },
      { returnDocument: "after", lean: true },
    );
    if (!claimed) continue;
    const channel = await client.channels.fetch(claimed.receiptDmChannelId).catch(() => null);
    const message = await channel?.send?.({
      content: formatCallWaitInterestEndNotificationContent(claimed),
    }).catch(() => null);
    if (message) {
      await CallWaitInterest.updateOne(
        { _id: claimed._id, status: "ended", endNotificationSentAt: null },
        { $set: { endNotificationSentAt: new Date(), endNotificationStatus: "sent" } },
      );
    } else if (claimed.endNotificationAttemptCount >= 3) {
      await CallWaitInterest.updateOne(
        { _id: claimed._id, status: "ended", endNotificationSentAt: null },
        { $set: { endNotificationStatus: "failed" } },
      );
    }
  }
}

async function endOrphanedCallWaitInterests(guildId, promptMessageId) {
  const activeRecruitments = promptMessageId ? [promptMessageId] : [];
  const orphaned = await CallWaitInterest.find({
    guildId,
    status: { $in: ["pending", "active", "joining"] },
    ...(activeRecruitments.length ? { recruitmentId: { $nin: activeRecruitments } } : {}),
  }).distinct("recruitmentId");
  for (const recruitmentId of orphaned) {
    await endCallWaitInterestsForRecruitment(guildId, recruitmentId);
  }
}

function isCallWaitDmFailure(error) {
  return [50007, 50013, 10003, 10013].includes(Number(error?.code))
    || /DM|direct message|cannot send messages/i.test(String(error?.message ?? ""));
}

async function editDeferredEphemeralReply(interaction, payload) {
  const { flags: _flags, ...reply } = payload;
  return interaction.editReply(reply);
}

// Acknowledge a component before touching MongoDB or Discord.  The adapted
// interaction also keeps legacy reply/update call sites on the acknowledged
// interaction path, where Discord requires editReply instead.
async function deferComponentResponse(interaction, responseType) {
  if (responseType === "update") {
    await interaction.deferUpdate();
  } else {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  }
  const editReply = (payload = {}) => {
    const { flags: _flags, ...reply } = payload;
    return interaction.editReply(reply);
  };
  return new Proxy(interaction, {
    get(target, property, receiver) {
      if (["reply", "update", "editReply"].includes(property)) return editReply;
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function deferCommandResponse(interaction, flags) {
  await interaction.deferReply({ flags });
  const editReply = (payload = {}) => {
    const { flags: _flags, ...reply } = payload;
    return interaction.editReply(reply);
  };
  return new Proxy(interaction, {
    get(target, property, receiver) {
      if (["reply", "update", "editReply"].includes(property)) return editReply;
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

// Claims the unique interest row before any DM side effect.  A stale terminal
// row is reusable, but active workflow states can never be overwritten.
async function registerCallWaitInterestFromPublicButton(interaction) {
  interaction = await deferComponentResponse(interaction, "reply");
  if (!interaction.inGuild()) {
    await editDeferredEphemeralReply(interaction, { content: "この操作はサーバー内の募集から行ってください。", flags: MessageFlags.Ephemeral });
    return;
  }
  const settings = await getGuildSettings(interaction.guildId);
  const prompt = settings?.callWaitPrompt;
  if (!prompt || prompt.mode !== CALL_WAIT_MODE_BUTTON || prompt.messageId !== interaction.message?.id || new Date(prompt.targetAt).getTime() <= Date.now()) {
    await editDeferredEphemeralReply(interaction, { content: "この募集は現在受け付けていません。", flags: MessageFlags.Ephemeral });
    return;
  }
  if (normalizeCallWaitMemberIds(prompt.memberIds).includes(interaction.user.id)) {
    await editDeferredEphemeralReply(interaction, { content: "すでに参加予定として登録されています。", flags: MessageFlags.Ephemeral });
    return;
  }

  const identity = { guildId: interaction.guildId, recruitmentId: prompt.messageId, userId: interaction.user.id };
  const now = new Date();
  const cooldownCutoff = new Date(now.getTime() - 30_000);
  const existing = await CallWaitInterest.findOne(identity).lean();
  if (["pending", "active", "joining", "joined"].includes(existing?.status)) {
    await editDeferredEphemeralReply(interaction, { content: "この募集にはすでに興味ありとして登録されています。", flags: MessageFlags.Ephemeral });
    return;
  }
  if (existing?.status === "canceled") {
    const seconds = getInterestCooldownSeconds(existing.canceledAt, now);
    if (seconds > 0) {
      await editDeferredEphemeralReply(interaction, { content: `興味ありを解除した直後です。あと${seconds}秒ほど待ってからもう一度お試しください。`, flags: MessageFlags.Ephemeral });
      return;
    }
  }

  const reset = {
    status: "pending", notificationThreshold: 1, targetAt: new Date(prompt.targetAt), registeredAt: now,
    canceledAt: null, endedAt: null, failedAt: null, thresholdNotificationSent: false,
    thresholdNotificationStatus: "idle", thresholdSatisfiedInReceipt: false,
    thresholdNotificationRetryCount: 0, thresholdNotificationLastTriedAt: null, thresholdNotificationLastError: null,
    renotificationEnabled: false, hadOtherInterestAtRegistration: false,
    receiptDmChannelId: null, receiptDmMessageId: null, latestThresholdDmChannelId: null, latestThresholdDmMessageId: null,
  };
  let claimed = await CallWaitInterest.findOneAndUpdate(
    {
      ...identity,
      $or: [
        { status: { $in: ["ended", "failed"] } },
        { status: "canceled", canceledAt: { $lte: cooldownCutoff } },
      ],
    },
    { $set: reset },
    { returnDocument: "after", lean: true },
  );
  if (!claimed && !existing) {
    try {
      claimed = (await CallWaitInterest.create({ ...identity, ...reset })).toObject();
    } catch (error) {
      if (error?.code !== 11000) throw error;
    }
  }
  if (!claimed) {
    const winner = await CallWaitInterest.findOne(identity).lean();
    const seconds = winner?.status === "canceled" ? getInterestCooldownSeconds(winner.canceledAt, now) : 0;
    await editDeferredEphemeralReply(interaction, {
      content: seconds > 0
        ? `興味ありを解除した直後です。あと${seconds}秒ほど待ってからもう一度お試しください。`
        : "この募集にはすでに興味ありとして登録されています。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  let receipt = null;
  let activeInterest = null;
  try {
    const participantCount = normalizeCallWaitMemberIds(prompt.memberIds).length;
    const hadOtherInterest = Boolean(await CallWaitInterest.exists({ ...identity, userId: { $ne: interaction.user.id }, status: "active" }));
    const thresholdSatisfiedInReceipt = participantCount >= reset.notificationThreshold;
    const dm = await interaction.user.createDM();
    receipt = await dm.send({
      content: buildCallWaitInterestReceiptContent({ targetAt: prompt.targetAt, participantCount, notificationThreshold: 1, hasOtherInterest: hadOtherInterest }),
      components: getCallWaitInterestComponents(prompt.messageId, {
        includeJoin: participantCount > 0, showThreshold: true, threshold: 1,
        linkUrl: getCallWaitPromptUrl(interaction.guildId, prompt),
      }),
    });
    const activated = await CallWaitInterest.updateOne(
      { _id: claimed._id, status: "pending" },
      { $set: { status: "active", receiptDmChannelId: dm.id, receiptDmMessageId: receipt.id, thresholdSatisfiedInReceipt, hadOtherInterestAtRegistration: hadOtherInterest } },
    );
    if (activated.matchedCount !== 1 || activated.modifiedCount !== 1) {
      throw new Error("CALL_WAIT_INTEREST_ACTIVATION_FAILED");
    }
    activeInterest = {
      ...claimed,
      status: "active",
      receiptDmChannelId: dm.id,
      receiptDmMessageId: receipt.id,
      thresholdSatisfiedInReceipt,
      hadOtherInterestAtRegistration: hadOtherInterest,
    };
  } catch (error) {
    await receipt?.edit({ content: "【登録失敗】\n\n興味ありの登録を完了できませんでした。", components: [] }).catch((error) => logRecoverableError("Failed to update failed call-wait interest receipt", error));
    await CallWaitInterest.updateOne({ _id: claimed._id, status: "pending" }, { $set: { status: "failed", failedAt: new Date() } }).catch((error) => logRecoverableError("Failed to persist failed call-wait interest", error));
    await editDeferredEphemeralReply(interaction, {
      content: isCallWaitDmFailure(error)
        ? "DMを送信できなかったため、興味ありとして登録できませんでした。"
        : "興味ありの登録処理中にエラーが発生しました。時間を空けて、もう一度お試しください。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Stage 2: notification/log/reply failures must never revoke a confirmed
  // interest registration or replace its successful receipt.
  try {
    if (!activeInterest.thresholdSatisfiedInReceipt) {
      await notifyCallWaitInterests(interaction.guildId, prompt.messageId);
    }
  } catch (error) {
    await sendOperationalLog({
      guild: interaction.guild,
      settings,
      fallbackChannel: null,
      content: `興味あり登録後の付随処理に失敗しました。募集ID: ${prompt.messageId}、ユーザーID: ${interaction.user.id}、エラー: ${error?.stack ?? error}`,
    }).catch((error) => logRecoverableError("Recoverable asynchronous operation failed", error));
  }
  await interaction.editReply({
    content: "興味ありとして登録しました。\n通知条件の確認や変更は、Botから届いたDMで行えます。",
    flags: MessageFlags.Ephemeral,
  }).catch((error) => sendOperationalLog({
    guild: interaction.guild,
    settings,
    fallbackChannel: null,
    content: `興味あり登録の成功応答に失敗しました。募集ID: ${prompt.messageId}、ユーザーID: ${interaction.user.id}、エラー: ${error?.stack ?? error}`,
  }).catch((error) => logRecoverableError("Recoverable asynchronous operation failed", error)));
}

async function cancelCallWaitInterestFromPublicButton(interaction) {
  if (!interaction.inGuild()) return false;
  const interest = await CallWaitInterest.findOne({ guildId: interaction.guildId, recruitmentId: interaction.message?.id, userId: interaction.user.id, status: "active" }).lean();
  if (!interest) return false;
  await endCallWaitInterest(interest, "canceled");
  await interaction.reply({ content: "興味ありを解除しました。\nこの募集についてのDM通知は送信されません。", flags: MessageFlags.Ephemeral });
  return true;
}

async function cancelCallWaitInterestFromDm(interaction) {
  interaction = await deferComponentResponse(interaction, "update");
  const recruitmentId = interaction.customId.slice("call_wait_interest_cancel:".length);
  const interest = await CallWaitInterest.findOne({ recruitmentId, userId: interaction.user.id, status: "active" }).lean();
  if (!interest) { await interaction.reply({ content: "この募集の興味あり登録は、すでに解除されています。", flags: MessageFlags.Ephemeral }); return; }
  await endCallWaitInterest(interest, "canceled");
  await interaction.update({ content: formatCallWaitInterestCanceledContent(interest), components: [] });
}

async function endCallWaitInterest(interest, status) {
  const update = status === "joined" ? { status, joinedAt: new Date() } : status === "ended" ? { status, endedAt: new Date() } : { status, canceledAt: new Date() };
  const changed = await CallWaitInterest.findOneAndUpdate(
    { _id: interest._id, status: "active" },
    { $set: update },
    { returnDocument: "after", lean: true },
  );
  if (!changed) return;
  if (status === "canceled") {
    await editCallWaitInterestMessages(changed, { content: formatCallWaitInterestCanceledContent(changed), components: [] });
  }
  if (status === "joined") {
    await editCallWaitInterestMessages(changed, { content: formatCallWaitInterestJoinedContent(changed), components: [] });
  }
}

async function cancelJoinedCallWaitInterest({ guildId, recruitmentId, userId }) {
  const canceledInterest = await CallWaitInterest.findOneAndUpdate(
    {
      guildId,
      recruitmentId,
      userId,
      status: "joined",
    },
    {
      $set: {
        status: "canceled",
        canceledAt: new Date(),
      },
      $unset: {
        joinedAt: 1,
      },
    },
    { returnDocument: "after", lean: true },
  );
  if (canceledInterest) {
    await editCallWaitInterestMessages(canceledInterest, {
      content: formatCallWaitInterestCanceledContent(canceledInterest),
      components: [],
    });
  }
  return canceledInterest;
}

async function editCallWaitInterestMessages(interest, payload) {
  const refs = new Map();
  for (const [channelId, messageId] of [
    [interest.receiptDmChannelId, interest.receiptDmMessageId],
    [interest.latestThresholdDmChannelId, interest.latestThresholdDmMessageId],
  ]) {
    if (channelId && messageId) refs.set(`${channelId}:${messageId}`, { channelId, messageId });
  }
  await Promise.all([...refs.values()].map(async ({ channelId, messageId }) => {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    const message = await channel?.messages?.fetch?.(messageId).catch(() => null);
    await message?.edit(payload).catch((error) => logRecoverableError("Failed to update call-wait interest receipt", error));
  }));
}

async function handleCallWaitInterestThresholdSelect(interaction) {
  interaction = await deferComponentResponse(interaction, "update");
  const recruitmentId = interaction.customId.slice(`${CALL_WAIT_INTEREST_SELECT_CUSTOM_ID}:`.length);
  const threshold = Number(interaction.values[0]);
  if (![1, 2, 3].includes(threshold)) {
    await interaction.reply({ content: "通知条件が不正です。", flags: MessageFlags.Ephemeral });
    return;
  }
  const current = await CallWaitInterest.findOne({ recruitmentId, userId: interaction.user.id, status: "active" }).lean();
  if (!current) {
    await interaction.reply({ content: "この募集の興味あり登録は、すでに終了しています。", flags: MessageFlags.Ephemeral });
    return;
  }
  if (current.thresholdNotificationStatus === "processing") {
    await interaction.reply({ content: "通知処理中のため、現在は通知条件を変更できません。少し待ってからもう一度お試しください。", flags: MessageFlags.Ephemeral });
    return;
  }
  const interest = await CallWaitInterest.findOneAndUpdate(
    {
      _id: current._id,
      status: "active",
      $or: [
        { thresholdNotificationSent: false, thresholdNotificationStatus: { $in: [null, "idle", "failed"] } },
        { thresholdSatisfiedInReceipt: true, thresholdNotificationStatus: { $ne: "processing" } },
      ],
    },
    {
      $set: {
        notificationThreshold: threshold,
        thresholdNotificationSent: false,
        thresholdNotificationStatus: "idle",
        thresholdSatisfiedInReceipt: false,
        renotificationEnabled: false,
      },
    },
    { returnDocument: "after", lean: true },
  );
  if (!interest) {
    await interaction.reply({ content: "通知処理中のため、現在は通知条件を変更できません。少し待ってからもう一度お試しください。", flags: MessageFlags.Ephemeral });
    return;
  }
  const settings = await getGuildSettings(interest.guildId);
  const prompt = settings?.callWaitPrompt;
  const count = prompt?.messageId === recruitmentId ? normalizeCallWaitMemberIds(prompt.memberIds).length : 0;
  await interaction.editReply({
    content: buildCallWaitInterestReceiptContent({
      targetAt: prompt?.targetAt ?? interest.targetAt,
      participantCount: count,
      notificationThreshold: interest.notificationThreshold,
      hasOtherInterest: interest.hadOtherInterestAtRegistration,
    }),
    components: getCallWaitInterestComponents(recruitmentId, {
      includeJoin: count > 0,
      showThreshold: true,
      threshold: interest.notificationThreshold,
      linkUrl: getCallWaitPromptUrl(interest.guildId, prompt),
    }),
  });
  await notifyCallWaitInterests(interest.guildId, recruitmentId);
}

/**
 * Registers a participant exactly once across the public prompt and an interest DM.
 * The interest document is used as a short-lived, unique join lock before changing
 * the recruitment document, so two simultaneous component clicks cannot both win.
 */
async function registerCallWaitParticipant({ guildId, recruitmentId, userId, source }) {
  const settings = await getGuildSettings(guildId);
  const prompt = settings?.callWaitPrompt;
  if (!prompt || prompt.messageId !== recruitmentId || new Date(prompt.targetAt).getTime() <= Date.now()) {
    return { ok: false, reason: "expired" };
  }
  if (normalizeCallWaitMemberIds(prompt.memberIds).includes(userId)) {
    return { ok: false, reason: "already_joined" };
  }

  let lock = await CallWaitInterest.findOneAndUpdate(
    { guildId, recruitmentId, userId, status: "active" },
    { $set: { status: "joining" } },
    { returnDocument: "before", lean: true },
  );
  let restoreStatus = lock ? "active" : "canceled";
  if (!lock) {
    try {
      lock = await CallWaitInterest.findOneAndUpdate(
        { guildId, recruitmentId, userId, status: { $nin: ["pending", "active", "joining", "joined"] } },
        { $set: { status: "joining", registeredAt: new Date(), canceledAt: null, notificationThreshold: 1, thresholdNotificationSent: false, renotificationEnabled: false } },
        { upsert: true, returnDocument: "before", setDefaultsOnInsert: true, lean: true },
      );
    } catch (error) {
      if (error?.code === 11000) return { ok: false, reason: "in_progress" };
      throw error;
    }
  }

  const updatedSettings = await updateCallWaitPromptMember({
    guildId,
    messageId: recruitmentId,
    userId,
    operation: "add",
  });
  if (!updatedSettings) {
    await CallWaitInterest.updateOne(
      { guildId, recruitmentId, userId, status: "joining" },
      { $set: { status: restoreStatus, ...(restoreStatus === "canceled" ? { canceledAt: new Date() } : {}) } },
    ).catch((error) => logRecoverableError("Recoverable asynchronous operation failed", error));
    return { ok: false, reason: "expired" };
  }

  const joined = await CallWaitInterest.findOneAndUpdate(
    { guildId, recruitmentId, userId, status: "joining" },
    { $set: { status: "joined", joinedAt: new Date() } },
    { returnDocument: "before", lean: true },
  );
  if (!joined) {
    // The participant list was already updated, so compensate before
    // reporting failure; never treat a missing joining -> joined transition as
    // a successful registration.
    await updateCallWaitPromptMember({ guildId, messageId: recruitmentId, userId, operation: "remove" }).catch((error) => logRecoverableError("Recoverable asynchronous operation failed", error));
    await CallWaitInterest.updateOne(
      { guildId, recruitmentId, userId, status: "joining" },
      { $set: { status: restoreStatus, ...(restoreStatus === "canceled" ? { canceledAt: new Date() } : {}) } },
    ).catch((error) => logRecoverableError("Recoverable asynchronous operation failed", error));
    return { ok: false, reason: "finalization_failed" };
  }
  if (joined) {
    await editCallWaitInterestMessages(joined ?? lock, {
      content: formatCallWaitInterestJoinedContent(joined ?? lock),
      components: [],
    });
  }
  return { ok: true, settings: updatedSettings, interest: joined ?? lock, source };
}

/** Applies every externally visible consequence of a successful participant add.
 * Both the public prompt and an interest DM call this so their state cannot
 * diverge after the shared atomic registration succeeds. */
async function finalizeCallWaitParticipantRegistration({ guild, settings, recruitmentId, userId, source }) {
  const latestSettings = await getGuildSettings(guild.id);
  const prompt = latestSettings?.callWaitPrompt;
  if (!prompt || prompt.messageId !== recruitmentId) return latestSettings;
  const memberIds = normalizeCallWaitMemberIds(prompt.memberIds);
  await refreshCallWaitPromptMessage(guild, prompt);
  await sendCallWaitApplicantLog({
    guild,
    settings: latestSettings ?? settings,
    action: "join",
    userId,
    memberIds,
    source,
  });
  await notifyCallWaitInterests(guild.id, recruitmentId);
  return latestSettings;
}

async function joinCallWaitFromInterestDm(interaction) {
  interaction = await deferComponentResponse(interaction, "update");
  const recruitmentId = interaction.customId.slice("call_wait_interest_join:".length);
  const interest = await CallWaitInterest.findOne({ recruitmentId, userId: interaction.user.id, status: "active" }).lean();
  if (!interest) { await interaction.reply({ content: "この募集の興味あり登録は、すでに解除されています。", flags: MessageFlags.Ephemeral }); return; }
  const guild = client.guilds.cache.get(interest.guildId) ?? await client.guilds.fetch(interest.guildId).catch(() => null);
  const member = await guild?.members.fetch(interaction.user.id).catch(() => null);
  if (!member) { await interaction.reply({ content: "対象のサーバーに参加していないため、参加予定として登録できませんでした。", flags: MessageFlags.Ephemeral }); return; }
  const result = await registerCallWaitParticipant({ guildId: interest.guildId, recruitmentId, userId: interaction.user.id, source: "interest_dm" });
  if (!result.ok) { await interaction.reply({ content: result.reason === "already_joined" ? "すでに参加予定として登録されています。" : "募集がすでに終了または更新されているため、操作を受け付けることができませんでした。", flags: MessageFlags.Ephemeral }); return; }
  await finalizeCallWaitParticipantRegistration({
    guild,
    settings: result.settings,
    recruitmentId,
    userId: interaction.user.id,
    source: "interest_dm",
  });
  await interaction.update({ content: `【参加予定へ変更済み】\n\n${formatJstTime(new Date(result.settings.callWaitPrompt.targetAt))}からの定時募集に、参加予定として登録しました。\n\nこれにより興味あり登録が解除されました。`, components: [] });
}

async function reconcileCallWaitInterestThresholds(guildId, recruitmentId) {
  const settings = await getGuildSettings(guildId); const prompt = settings?.callWaitPrompt;
  if (!prompt || prompt.messageId !== recruitmentId) return;
  const count = normalizeCallWaitMemberIds(prompt.memberIds).length;
  const linkUrl = getCallWaitPromptUrl(guildId, prompt);
  const interests = await CallWaitInterest.find({
    guildId,
    recruitmentId,
    status: "active",
    renotificationEnabled: false,
    notificationThreshold: { $gt: count },
    $or: [
      { thresholdNotificationSent: true, thresholdNotificationStatus: "sent" },
      { thresholdSatisfiedInReceipt: true, thresholdNotificationSent: false, thresholdNotificationStatus: "idle" },
    ],
  }).lean();
  for (const interest of interests) {
    let claimed = null;
    try {
    const receiptBacked = interest.thresholdSatisfiedInReceipt === true && interest.thresholdNotificationSent === false;
    claimed = await CallWaitInterest.findOneAndUpdate(
      receiptBacked
        ? {
          _id: interest._id,
          status: "active",
          thresholdSatisfiedInReceipt: true,
          thresholdNotificationSent: false,
          thresholdNotificationStatus: "idle",
          renotificationEnabled: false,
          notificationThreshold: { $gt: count },
        }
        : {
          _id: interest._id,
          status: "active",
          thresholdNotificationSent: true,
          thresholdNotificationStatus: "sent",
          renotificationEnabled: false,
          notificationThreshold: { $gt: count },
        },
      {
        $set: {
          thresholdSatisfiedInReceipt: false,
          thresholdNotificationSent: true,
          thresholdNotificationStatus: "processing",
          thresholdNotificationLastTriedAt: new Date(),
          thresholdNotificationLastError: null,
        },
        $inc: { thresholdNotificationRetryCount: 1 },
      },
      { returnDocument: "after", lean: true },
    );
    if (!claimed) continue;
    const sourceChannelId = receiptBacked ? claimed.receiptDmChannelId : claimed.latestThresholdDmChannelId;
    const sourceMessageId = receiptBacked ? claimed.receiptDmMessageId : claimed.latestThresholdDmMessageId;
    const channel = await client.channels.fetch(sourceChannelId).catch(() => null);
    const message = await channel?.messages?.fetch?.(sourceMessageId).catch(() => null);
    const payload = {
      content: `【参加予定者数が条件を下回りました】\n\n${formatJstTime(new Date(prompt.targetAt))}からの定時募集は、一度通知条件を満たしましたが、その後参加予定者が減少しました。\n\n現在の参加予定者数：${count}人\n\n再び通知条件を満たした際にお知らせを受け取りたい場合は、下の「再び集まったら通知する」を押してください。`,
      components: getCallWaitInterestComponents(recruitmentId, { linkUrl, allowRenotification: true }),
    };
    let edited = false;
    if (message) edited = await message.edit(payload).then(() => true).catch(() => false);
    if (!edited) {
      const replacement = channel?.send
        ? await channel.send(payload).catch(() => null)
        : null;
      if (replacement) {
        const persisted = await CallWaitInterest.updateOne({ _id: claimed._id, status: "active", thresholdNotificationStatus: "processing" }, {
          $set: {
            thresholdNotificationStatus: "sent",
            ...(receiptBacked ? { receiptDmChannelId: replacement.channelId, receiptDmMessageId: replacement.id } : { latestThresholdDmChannelId: replacement.channelId, latestThresholdDmMessageId: replacement.id }),
          },
        });
        if (persisted.matchedCount !== 1) {
          throw new Error("CALL_WAIT_THRESHOLD_NOTIFICATION_STATE_CHANGED");
        }
      } else {
        const failed = await CallWaitInterest.updateOne(
          { _id: claimed._id, status: "active", thresholdNotificationStatus: "processing" },
          {
            $set: {
              thresholdNotificationStatus: "failed",
              thresholdNotificationLastTriedAt: new Date(),
              thresholdNotificationLastError: "The threshold DM could not be edited or resent.",
            },
          },
        );
        if (failed.matchedCount !== 1) {
          throw new Error("CALL_WAIT_THRESHOLD_NOTIFICATION_STATE_CHANGED");
        }
        const guild = client.guilds.cache.get(guildId) ?? await client.guilds.fetch(guildId).catch(() => null);
        await sendOperationalLog({
          guild,
          settings: await getGuildSettings(guildId).catch(() => null),
          fallbackChannel: null,
          content: `興味あり人数減少DMの再送に失敗しました。募集ID: ${recruitmentId}、ユーザーID: ${interest.userId}`,
        }).catch((error) => logRecoverableError("Recoverable asynchronous operation failed", error));
      }
    } else {
      const persisted = await CallWaitInterest.updateOne(
        { _id: claimed._id, status: "active", thresholdNotificationStatus: "processing" },
        { $set: { thresholdNotificationStatus: "sent" } },
      );
      if (persisted.matchedCount !== 1) {
        throw new Error("CALL_WAIT_THRESHOLD_NOTIFICATION_STATE_CHANGED");
      }
    }
    } catch (error) {
      if (claimed) {
        await CallWaitInterest.updateOne(
          { _id: claimed._id, status: "active", thresholdNotificationStatus: "processing" },
          {
            $set: {
              thresholdNotificationStatus: "failed",
              thresholdNotificationLastTriedAt: new Date(),
              thresholdNotificationLastError: error?.message ?? String(error),
            },
          },
        ).catch((markError) => console.error("Failed to mark threshold notification failure:", markError));
      }
      await sendOperationalLog({
        guild: client.guilds.cache.get(guildId),
        settings,
        fallbackChannel: null,
        content: `興味あり人数減少通知の処理に失敗しました。募集ID: ${recruitmentId}、ユーザーID: ${interest.userId}、エラー: ${error?.stack ?? error}`,
      }).catch((logError) => console.error(logError));
    }
  }
}

async function enableCallWaitInterestRenotification(interaction) {
  interaction = await deferComponentResponse(interaction, "update");
  const recruitmentId = interaction.customId.slice("call_wait_interest_renotify:".length);
  const interest = await CallWaitInterest.findOne({ recruitmentId, userId: interaction.user.id, status: "active", thresholdNotificationSent: true }).lean();
  if (!interest) { await interaction.reply({ content: "この募集の興味あり登録は、すでに終了しています。", flags: MessageFlags.Ephemeral }); return; }
  const settings = await getGuildSettings(interest.guildId); const prompt = settings?.callWaitPrompt;
  const targetAt = new Date(prompt?.targetAt);
  const recruitmentIsActive = Boolean(
    prompt
      && prompt.messageId === recruitmentId
      && Number.isFinite(targetAt.getTime())
      && targetAt.getTime() > Date.now(),
  );
  if (!recruitmentIsActive) {
    await interaction.editReply({
      content: "この募集はすでに終了しています。",
      components: [],
    });
    return;
  }
  const count = prompt?.messageId === recruitmentId ? normalizeCallWaitMemberIds(prompt.memberIds).length : -1;
  const enabled = await CallWaitInterest.findOneAndUpdate(
    {
      _id: interest._id,
      recruitmentId,
      status: "active",
      thresholdNotificationSent: true,
      renotificationEnabled: false,
    },
    { $set: { renotificationEnabled: true, thresholdNotificationStatus: "idle" } },
    { returnDocument: "after", lean: true },
  );
  if (!enabled) { await interaction.reply({ content: "この再通知はすでに処理されています。", flags: MessageFlags.Ephemeral }); return; }
  await interaction.update({
    content: count >= enabled.notificationThreshold
      ? "【再通知を受け付けました】\n\n新しい到達通知を送信します。"
      : `【再通知を受け付けました】\n\n参加予定者が再び${enabled.notificationThreshold}人以上になった際に、DMでお知らせします。\n\n現在の参加予定者数：${Math.max(0, count)}人`,
    components: getCallWaitInterestComponents(recruitmentId, {
      includeJoin: false,
      showThreshold: false,
      allowRenotification: false,
      linkUrl: getCallWaitPromptUrl(interest.guildId, prompt),
    }),
  });
  await notifyCallWaitInterests(interest.guildId, recruitmentId);
}

async function refreshCallWaitPromptMessage(guild, prompt) {
  const channel = await resolveConfiguredTextChannel(guild, prompt?.channelId);
  const message = await channel?.messages?.fetch?.(prompt?.messageId).catch(() => null);
  await message?.edit({ content: formatCallWaitPromptV2(new Date(prompt.targetAt), prompt.memberIds), components: [createCallWaitInterestRow()] }).catch((error) => logRecoverableError("Failed to update call-wait prompt after interest cancellation", error));
}

async function notifyCallWaitInterests(guildId, recruitmentId) {
  const settings = await getGuildSettings(guildId); const prompt = settings?.callWaitPrompt;
  if (!prompt || prompt.messageId !== recruitmentId) return;
  const count = normalizeCallWaitMemberIds(prompt.memberIds).length;
  const linkUrl = getCallWaitPromptUrl(guildId, prompt);
  const interests = await CallWaitInterest.find({ guildId, recruitmentId, status: "active" }).lean();
  for (const interest of interests) {
    let claimed = null;
    let notificationType = "initial";
    try {
    if (count < interest.notificationThreshold) continue;
    // The receipt is the initial notification when the threshold was already
    // satisfied at registration time.
    if (!interest.renotificationEnabled && interest.thresholdSatisfiedInReceipt) continue;
    notificationType = interest.renotificationEnabled ? "renotification" : "initial";
    claimed = await CallWaitInterest.findOneAndUpdate(
      notificationType === "renotification"
        ? { _id: interest._id, status: "active", thresholdNotificationSent: true, renotificationEnabled: true, thresholdNotificationStatus: { $in: [null, "idle", "failed"] }, notificationThreshold: { $lte: count } }
        : { _id: interest._id, status: "active", thresholdNotificationSent: false, thresholdNotificationStatus: { $in: [null, "idle", "failed"] }, notificationThreshold: { $lte: count } },
      {
        $set: {
          thresholdNotificationStatus: "processing",
          thresholdNotificationLastTriedAt: new Date(),
          thresholdNotificationLastError: null,
          ...(notificationType === "renotification" ? { renotificationEnabled: false } : {}),
        },
        $inc: { thresholdNotificationRetryCount: 1 },
      },
      { returnDocument: "after", lean: true },
    );
    if (!claimed) continue;
    const channel = await client.channels.fetch(claimed.receiptDmChannelId).catch(() => null);
    const title = notificationType === "renotification" ? "【参加予定者が再び集まりました】" : "【参加予定者が集まりました】";
    const thresholdSentence = notificationType === "renotification"
      ? `参加予定者数が再び通知条件の${claimed.notificationThreshold}人に達しました。`
      : `参加予定者数が通知条件として設定した${claimed.notificationThreshold}人に達しました。`;
    let sendError = null;
    const message = await channel?.send?.({ content: `${title}\n\n${formatJstTime(new Date(prompt.targetAt))}からの定時募集で、${thresholdSentence}\n\n現在の参加予定者数：${count}人\n\n参加する場合は、下の「参加予定」を押してください。`, components: getCallWaitInterestComponents(recruitmentId, { includeJoin: true, linkUrl }) }).catch((error) => {
      sendError = error;
      return null;
    });
    if (message) {
      const persisted = await CallWaitInterest.updateOne(
        { _id: claimed._id, status: "active", thresholdNotificationStatus: "processing" },
        { $set: { thresholdNotificationSent: true, thresholdNotificationStatus: "sent", thresholdSatisfiedInReceipt: false, renotificationEnabled: false, thresholdNotificationLastError: null, latestThresholdDmChannelId: message.channelId, latestThresholdDmMessageId: message.id } },
      );
      if (persisted.matchedCount !== 1 || persisted.modifiedCount !== 1) {
        await message.edit({ content: "【操作できません】\n\nこの募集の状態が変更されたため、この通知からは操作できません。", components: [] }).catch((error) => logRecoverableError("Failed to disable stale call-wait interest message", error));
        await sendOperationalLog({ guild: client.guilds.cache.get(guildId), settings, fallbackChannel: null, content: `興味あり到達DMの確定に失敗しました。募集ID: ${recruitmentId}、ユーザーID: ${claimed.userId}` }).catch((error) => logRecoverableError("Recoverable asynchronous operation failed", error));
        continue;
      }
      const receipt = await channel?.messages?.fetch?.(interest.receiptDmMessageId).catch(() => null);
      await receipt?.edit({
        components: getCallWaitInterestComponents(recruitmentId, { includeJoin: true, linkUrl }),
      }).catch((error) => logRecoverableError("Recoverable asynchronous operation failed", error));
    } else {
      const failurePatch = notificationType === "renotification"
        ? { thresholdNotificationStatus: "failed", renotificationEnabled: true, thresholdNotificationLastError: sendError?.message ?? "DM channel is unavailable" }
        : { thresholdNotificationSent: false, thresholdNotificationStatus: "failed", thresholdNotificationLastError: sendError?.message ?? "DM channel is unavailable" };
      await CallWaitInterest.updateOne({ _id: claimed._id, thresholdNotificationStatus: "processing" }, { $set: failurePatch });
      await sendOperationalLog({
        guild: client.guilds.cache.get(guildId),
        settings,
        fallbackChannel: null,
        content: `興味あり到達DMの送信に失敗しました。募集ID: ${recruitmentId}、ユーザーID: ${claimed.userId}、種別: ${notificationType}、発生日時: ${new Date().toISOString()}、エラー: ${sendError?.stack ?? sendError?.message ?? "DMチャンネルを取得できませんでした"}`,
      }).catch((error) => logRecoverableError("Recoverable asynchronous operation failed", error));
    }
    } catch (error) {
      if (claimed) {
        const failurePatch = notificationType === "renotification"
          ? { thresholdNotificationStatus: "failed", renotificationEnabled: true, thresholdNotificationLastError: error?.message ?? String(error) }
          : { thresholdNotificationSent: false, thresholdNotificationStatus: "failed", thresholdNotificationLastError: error?.message ?? String(error) };
        await CallWaitInterest.updateOne(
          { _id: claimed._id, status: "active", thresholdNotificationStatus: "processing" },
          { $set: failurePatch },
        ).catch((error) => logRecoverableError("Recoverable asynchronous operation failed", error));
      }
      await sendOperationalLog({
        guild: client.guilds.cache.get(guildId),
        settings,
        fallbackChannel: null,
        content: `興味あり通知処理中にエラーが発生しました。\n募集ID: ${recruitmentId}\nユーザーID: ${interest.userId}\nエラー: ${error?.stack ?? error}`,
      }).catch((error) => logRecoverableError("Recoverable asynchronous operation failed", error));
    }
  }
}

async function handleCallWaitButton(interaction) {
  if (interaction.customId.startsWith("call_wait_interest_renotify:")) {
    await enableCallWaitInterestRenotification(interaction);
    return;
  }
  if (interaction.customId === CALL_WAIT_INTEREST_CUSTOM_ID) {
    await registerCallWaitInterestFromPublicButton(interaction);
    return;
  }
  if (interaction.customId.startsWith("call_wait_interest_join:")) {
    await joinCallWaitFromInterestDm(interaction);
    return;
  }
  if (interaction.customId.startsWith("call_wait_interest_cancel:")) {
    await cancelCallWaitInterestFromDm(interaction);
    return;
  }
  if (!interaction.inGuild()) {
    await interaction.reply({
      content: "このボタンはサーバー内で使ってください。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  interaction = await deferComponentResponse(interaction, "reply");

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
  const activeInterest = !isJoin
    ? await CallWaitInterest.findOne({
      guildId: interaction.guildId,
      recruitmentId: prompt.messageId,
      userId,
      status: "active",
    }).lean()
    : null;
  const joinedInterest = !isJoin
    ? await CallWaitInterest.findOne({
      guildId: interaction.guildId,
      recruitmentId: prompt.messageId,
      userId,
      status: "joined",
    }).lean()
    : null;

  if (isJoin && memberIds.includes(userId)) {
    await interaction.reply({
      content: "すでに参加予定として登録されています。\n取り消す場合は、募集メッセージの「キャンセル」を押してください。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!isJoin && !memberIds.includes(userId)) {
    if (activeInterest) {
      await endCallWaitInterest(activeInterest, "canceled");
      await interaction.reply({
        content: "興味ありを解除しました。\nこの募集についてのDM通知は送信されません。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await interaction.reply({
      content: "この募集には、参加予定または興味ありとして登録されていません。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const participantResult = isJoin
    ? await registerCallWaitParticipant({
      guildId: interaction.guildId,
      recruitmentId: prompt.messageId,
      userId,
      source: "public_prompt",
    })
    : null;
  const updatedPrompt = isJoin
    ? participantResult?.settings
    : await updateCallWaitPromptMember({
      guildId: interaction.guildId,
      messageId: prompt.messageId,
      userId,
      operation: "remove",
    });
  if (!updatedPrompt) {
    await interaction.reply({
      content: participantResult?.reason === "already_joined"
        ? "すでに参加予定として登録されています。"
        : "この募集はすでに更新されています。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (!isJoin && joinedInterest) {
    const canceledInterest = await cancelJoinedCallWaitInterest({
      guildId: interaction.guildId,
      recruitmentId: prompt.messageId,
      userId,
    });
    if (!canceledInterest) {
      const restoredPrompt = await updateCallWaitPromptMember({
        guildId: interaction.guildId,
        messageId: prompt.messageId,
        userId,
        operation: "add",
      });
      const remainingJoinedInterest = await CallWaitInterest.exists({
        guildId: interaction.guildId,
        recruitmentId: prompt.messageId,
        userId,
        status: "joined",
      });
      if (!restoredPrompt || remainingJoinedInterest) {
        await sendOperationalLog({
          guild: interaction.guild,
          settings,
          fallbackChannel: null,
          content: `参加予定キャンセルの整合性回復に失敗しました。募集ID: ${prompt.messageId}、ユーザーID: ${userId}`,
        }).catch((error) => logRecoverableError("Failed to report call-wait cancellation inconsistency", error));
      }
      await interaction.editReply({
        content: "参加予定のキャンセル状態を確定できませんでした。参加予定は維持されています。もう一度お試しください。",
      });
      return;
    }
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
    !isJoin &&
    promptForDisplay?.messageId === prompt.messageId &&
    interaction.message &&
    typeof interaction.message.edit === "function"
  ) {
    await interaction.message.edit({
      content: formatCallWaitPromptV2(displayedTargetAt, displayedMemberIds),
      components: [createCallWaitInterestRow()],
    }).catch((error) => {
      console.error(`Failed to update call wait prompt message: ${error.message}`);
    });
  }

  if (isJoin) {
    await finalizeCallWaitParticipantRegistration({
      guild: interaction.guild,
      settings: latestSettings ?? settings,
      recruitmentId: prompt.messageId,
      userId,
      source: "public_prompt",
    });
  } else {
    await sendCallWaitApplicantLog({
      guild: interaction.guild,
      settings: latestSettings ?? settings,
      action: "cancel",
      userId,
      memberIds: displayedMemberIds,
    });
  }

  if (!isJoin) {
    if (activeInterest) await endCallWaitInterest(activeInterest, "canceled");
    await reconcileCallWaitInterestThresholds(interaction.guildId, prompt.messageId);
  }

  if (isJoin) {
    await interaction.reply({
      content: "参加予定を受け付けました。\n取り消す場合は、募集メッセージの「キャンセル」を押してください。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.reply({
    content: "参加予定を取り消しました。",
    flags: MessageFlags.Ephemeral,
  });
}

async function sendCallWaitApplicantLog({
  guild,
  settings,
  action,
  userId = null,
  memberIds,
  source = null,
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
    ...(action === "join" ? [`操作元: ${source === "interest_dm" ? "DM" : "公開募集メッセージ"}`] : []),
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

async function grantCallWaitRoleAndQueueNotice({ guild, settings, memberIds, sourceId }) {
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

    if (member.roles.cache.has(settings.callWaitRoleId)) {
      eligibleMemberIds.push(member.id);
      continue;
    }

    await member.roles.add(
      settings.callWaitRoleId,
      "通話待機システムの集合通知",
    ).then(async () => {
      try {
        await VoiceParticipantRoleGrant.updateOne(
          {
            guildId: guild.id,
            memberId: member.id,
            roleId: settings.callWaitRoleId,
            sourceType: "call_wait",
            sourceId: sourceId ?? "unknown",
          },
          {
            $set: {
              grantedByBot: true,
              grantedAt: new Date(),
              status: "active",
              removedAt: null,
              cleanupAt: null,
            },
            $setOnInsert: {
              guildId: guild.id,
              memberId: member.id,
              roleId: settings.callWaitRoleId,
              sourceType: "call_wait",
              sourceId: sourceId ?? "unknown",
            },
          },
          { upsert: true },
        );
      } catch (error) {
        await member.roles.remove(settings.callWaitRoleId, "Rollback untracked call-wait role").catch((rollbackError) => {
          console.error(`Failed to roll back call-wait role for ${member.id}: ${rollbackError.message}`);
        });
        throw error;
      }
      newlyAddedMemberIds.push(member.id);
      eligibleMemberIds.push(member.id);
    }).catch((error) => {
      console.error(`Failed to add call wait role to ${member.id}: ${error.message}`);
    });
  }

  if (eligibleMemberIds.length < CALL_WAIT_MIN_MEMBERS) {
    if (newlyAddedMemberIds.length > 0) {
      await removeCallWaitRoleFromMembers(
        guild,
        settings.callWaitRoleId,
        newlyAddedMemberIds,
        { sourceType: "call_wait", sourceId: sourceId ?? "unknown" },
      ).catch((rollbackError) => {
        console.error(`Failed to roll back incomplete call-wait role grants: ${rollbackError.message}`);
      });
    }
    return false;
  }

  const nextSettings = await saveGuildSettingsWithCurrent(guild.id, settings, {
    callWaitPendingNotice: {
      memberIds: eligibleMemberIds,
      createdAt: new Date().toISOString(),
      status: "pending",
      attemptCount: 0,
    },
  });

  if (eligibleMemberIds.length > 0) {
    try {
      await scheduleCallWaitRoleRemoval({
        guild,
        roleId: settings.callWaitRoleId,
        // Removal is source-scoped in VoiceParticipantRoleGrant, so this can
        // safely include members who already had the role.  It also repairs a
        // crash after granting a role but before its first removal timer was
        // persisted.
        memberIds: eligibleMemberIds,
        sourceId,
      });
    } catch (error) {
      // Do not leave temporary roles behind when their persistent removal
      // schedule could not be written.
      await removeCallWaitRoleFromMembers(
        guild,
        settings.callWaitRoleId,
        newlyAddedMemberIds,
        { sourceType: "call_wait", sourceId: sourceId ?? "unknown" },
      ).catch((rollbackError) => {
        console.error(`Failed to roll back scheduled call-wait roles: ${rollbackError.message}`);
      });
      await saveGuildSettingsWithCurrent(guild.id, nextSettings, {
        callWaitPendingNotice: null,
      }).catch((cleanupError) => {
        console.error(`Failed to clear unschedulable call-wait notice: ${cleanupError.message}`);
      });
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

  // Reaching the scheduled time with two confirmed participants is enough to
  // announce immediately; waiting for a VC join delays the established call.
  if ((pendingNotice.memberIds ?? []).length < CALL_WAIT_MIN_MEMBERS) {
    return false;
  }

  const claimedSettings = await claimCallWaitPendingNotice({ guildId: guild.id });
  if (!claimedSettings?.callWaitPendingNotice) {
    return false;
  }
  settings = claimedSettings;

  const channel = await resolveConfiguredTextChannel(
    guild,
    getCallWaitNoticeChannelId(settings),
  );

  if (!channel) {
    await failCallWaitPendingNotice({
      guildId: guild.id,
      error: "Configured call-wait notice channel is unavailable",
    });
    return false;
  }

  try {
  await channel.send({
    content: `<@&${settings.callWaitRoleId}> 雑談希望者が複数人集まりました！VCへの参加お願いします！`,
    allowedMentions: { roles: [settings.callWaitRoleId] },
  });
  } catch (error) {
    await failCallWaitPendingNotice({ guildId: guild.id, error: error?.message ?? error });
    throw error;
  }

  try {
    await saveGuildSettingsWithCurrent(guild.id, settings, {
      callWaitPendingNotice: null,
    });
  } catch (error) {
    await saveGuildSettingsWithCurrent(guild.id, settings, {
      callWaitPendingNotice: {
        ...settings.callWaitPendingNotice,
        status: "sent_unconfirmed",
        sentAt: new Date().toISOString(),
        lastError: `Notice was sent but cleanup persistence failed: ${error.message}`,
      },
    }).catch((statusError) => {
      console.error(`Failed to persist call-wait sent_unconfirmed state: ${statusError.message}`);
    });
    throw error;
  }

  return true;
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

async function scheduleCallWaitRoleRemoval({ guild, roleId, memberIds, sourceId }) {
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
    payload: { sourceType: "call_wait", sourceId: sourceId ?? "unknown" },
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
    const session = sessionId ? await SplitProcessSession.findOne({ sessionId }).lean() : null;
    if (session?.status === "active" && ["active", "extended"].includes(session.waitingMonitorStatus)) {
      // The monitor owns this VC while it is active/extended.  A cleanup action
      // must never delete a channel that can still receive transfers.
      await scheduleWaitingVcCleanup({
        actionKey: `${actionKey}:retry:${Date.now()}`,
        guild,
        channelId,
        delayMs: WAITING_ROOM_POLL_MS,
        sessionId,
      });
      await finishAction(actionKey);
      return;
    }
    const channel = await guild.channels.fetch(channelId).catch((error) => {
      if (error?.code === 10003) return null;
      throw error;
    });
    if (channel) await channel.delete().catch((error) => {
      if (error?.code !== 10003) throw error;
    });
    if (sessionId) await SplitProcessSession.updateOne(
      { sessionId, waitingChannelId: channelId },
      { $set: { waitingVcCleanupCompleted: true, waitingMonitorStatus: "closed", waitingMonitorClosedAt: new Date() } },
    );
    await finishAction(actionKey);
  } catch (error) {
    await failAction(actionKey, error.message).catch((error) => logRecoverableError("Recoverable asynchronous operation failed", error));
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
    // A role can be shared by unrelated operations.  Only remove it from the
    // members recorded by this session/action, never from every role holder.
    const targetMemberIds = payload?.sessionId
      ? normalizeCallWaitMemberIds(session?.participantRoleGrantedMemberIds)
      : normalizeCallWaitMemberIds(memberIds);

    let removed = 0;
    let failed = 0;
    if (payload?.sessionId) {
      for (const memberId of targetMemberIds) {
        try {
          const member = await guild.members.fetch(memberId);
          await removeVoiceParticipantRole(member, roleId, {
            sourceType: "splitvc",
            sourceId: payload.sessionId,
          });
          removed += 1;
        } catch (error) {
          failed += 1;
          console.error(`Failed to remove split participant role from ${memberId}: ${error.message}`);
        }
      }
      if (failed) throw new Error(`Failed to remove role from ${failed} member(s); removed ${removed} member(s)`);
    } else {
      await removeCallWaitRoleFromMembers(guild, roleId, targetMemberIds, payload);
    }

    if (payload?.sessionId) {
      const settings = await getGuildSettings(guild.id);

      await sendOperationalLog({
        guild,
        settings,
        fallbackChannel: null,
        content: `感想受付終了に伴い参加者ロールを解除しました。解除成功: ${removed}人、解除失敗: ${failed}人。`,
      });

      await SplitProcessSession.updateOne(
        { sessionId: payload.sessionId },
        {
          $set: {
            roleRemovalCompleted: true,
            phase: "completed",
            status: "completed",
            completedAt: new Date(),
            lastError: undefined,
          },
        },
      );
      if (settings?.gatheringVcRestorePending) {
        await restoreGatheringVcPermissionAfterSplit(guild, settings).catch((error) => {
          logRecoverableError("Failed to restore gathering VC permission after split role removal", error);
        });
      }
      await SplitReviewDraft.deleteMany({ guildId: guild.id, splitSessionId: payload.sessionId }).catch((error) => logRecoverableError("Recoverable asynchronous operation failed", error));
      if (session?.reviewButtonShown && session?.finishNoticeChannelId && session?.finishNoticeMessageId) {
        const noticeChannel = await guild.channels.fetch(session.finishNoticeChannelId).catch(() => null);
        const notice = await noticeChannel?.messages?.fetch(session.finishNoticeMessageId).catch(() => null);
        await notice?.edit({ components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`split_review_closed:${payload.sessionId}`).setLabel("感想受付は終了しました").setStyle(ButtonStyle.Secondary).setDisabled(true))] }).catch((error) => logRecoverableError("Recoverable asynchronous operation failed", error));
      }
    }
    await finishAction(actionKey);
  } catch (error) {
    if (payload?.sessionId) {
      await SplitProcessSession.updateOne(
        { sessionId: payload.sessionId },
        { $set: { roleRemovalCompleted: false, phase: "role_remove_pending", status: "role_remove_pending", lastError: error.message } },
      ).catch((error) => logRecoverableError("Recoverable asynchronous operation failed", error));
    }
    await failAction(actionKey, error.message).catch((persistError) => logRecoverableError(`Failed to persist waiting-VC cleanup failure for ${actionKey}`, persistError));
    throw error;
  }
}

async function executeSplitFinishNotice({ actionKey, guild, payload }) {
  const claimed = await claimAction(actionKey);
  if (!claimed) return;
  try {
    const session = await SplitProcessSession.findOne({ sessionId: payload?.sessionId }).lean();
    if (session && !session.finishNoticeSent) await sendSplitFinishNotice({ guild, session, channelId: payload?.channelId });
    await finishAction(actionKey);
  } catch (error) {
    await failAction(actionKey, error.message).catch((error) => logRecoverableError("Recoverable asynchronous operation failed", error));
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
      await failAction(action.actionKey, "Guild not found").catch((error) => logRecoverableError("Recoverable asynchronous operation failed", error));
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
    await deleteBosyuEditSession(session.messageId).catch((error) => logRecoverableError("Recoverable asynchronous operation failed", error));
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
  await message?.edit({ components: [] }).catch((error) => logRecoverableError("Recoverable asynchronous operation failed", error));
}

function scheduleBosyuEditExpiry(messageId, channelId, expiresAt) {
  setTimeout(async () => {
    bosyuEditSessions.delete(messageId);
    const channel = await client.channels.fetch(channelId).catch(() => null);
    const message = channel?.messages?.fetch ? await channel.messages.fetch(messageId).catch(() => null) : null;
    await message?.edit({ components: [] }).catch((error) => logRecoverableError("Recoverable asynchronous operation failed", error));
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
  const { guildId, ...setFields } = patch;
  const insertFields = {
    sessionId,
    ...(guildId ? { guildId } : {}),
  };
  return SplitProcessSession.findOneAndUpdate(
    { sessionId },
    { $set: setFields, $setOnInsert: insertFields },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true, lean: true },
  );
}

function createCallWaitInterestRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(CALL_WAIT_JOIN_CUSTOM_ID).setLabel("参加予定").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(CALL_WAIT_INTEREST_CUSTOM_ID).setLabel("興味あり").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(CALL_WAIT_CANCEL_CUSTOM_ID).setLabel("キャンセル").setStyle(ButtonStyle.Danger),
  );
}

async function isKokuchiCallWaitPaused(settings, guildId, now) {
  if (isKokuchiCallWaitPause(settings, now)) return true;
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  if (jst.getUTCHours() < 20 || jst.getUTCHours() >= 22) return false;
  const start = new Date(Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate() - 1, 15, 0, 0));
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return Boolean(await KokuchiReservation.exists({ guildId, status: { $in: ["pending", "processing"] }, scheduledAt: { $gte: start, $lt: end } }));
}

async function sendSplitFinishNotice({ guild, session, channelId }) {
  const settings = await getGuildSettings(guild.id);
  const channel = await guild.channels.fetch(channelId ?? session.operationChannelId).catch(() => null);
  if (!channel?.send) throw new Error("終了通知先チャンネルへ送信できません。");
  const reviewChannelId = settings?.reviewSendChannelId ?? null;
  let canReview = false;
  if (reviewChannelId) {
    const reviewChannel = await guild.channels.fetch(reviewChannelId).catch(() => null);
    const me = guild.members.me ?? await guild.members.fetchMe().catch(() => null);
    const permissions = reviewChannel?.permissionsFor?.(me);
    canReview = Boolean(reviewChannel?.isTextBased?.() && permissions?.has(PermissionFlagsBits.ViewChannel) && permissions?.has(PermissionFlagsBits.SendMessages));
    if (!canReview) await sendOperationalLog({ guild, settings, fallbackChannel: channel, content: "感想ボタンを付けられませんでした：感想送信先が未設定、削除済み、またはBotに閲覧・送信権限がありません。" });
  } else await sendOperationalLog({ guild, settings, fallbackChannel: channel, content: "感想ボタンを付けられませんでした：感想送信先が未設定です。" });
  const now = new Date(); const waitMs = minutesToMs(getNonNegativeInteger(settings?.roleRemoveWaitMinutes, DEFAULT_ROLE_REMOVE_WAIT_MINUTES));
  await guild.members.fetch().catch(() => null);
  const eligible = session.participantRoleId ? [...(guild.roles.cache.get(session.participantRoleId)?.members?.keys() ?? [])].filter((id) => id !== guild.client.user.id) : [];
  const snapshots = await Promise.all((session.childChannelIds ?? []).map(async (id, index) => { const vc = await guild.channels.fetch(id).catch(() => null); const ids = vc?.members ? [...vc.members.keys()].filter((memberId) => memberId !== guild.client.user.id) : (session.groupSnapshots?.[index]?.memberIds ?? []); return { groupNumber: session.groupSnapshots?.[index]?.groupNumber ?? index + 1, channelId: id, memberIds: ids }; }));
  const finishContent = canReview
    ? `<@&${session.participantRoleId}> 30分が経過しました！各々のちょうどいいタイミングで解散してください\n\nお時間があれば下のボタンから今回の感想をお聞かせください！\n３０秒ほどで完了するので今後に活かすためにぜひお願いします 🙏`
    : `<@&${session.participantRoleId}> 30分が経過しました！各々のちょうどいいタイミングで解散してください`;
  const message = await channel.send({
    content: finishContent,
    components: canReview ? [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`${SPLIT_REVIEW_OPEN}:${session.sessionId}`).setLabel("感想を送る").setStyle(ButtonStyle.Primary))] : [],
    allowedMentions: { roles: session.participantRoleId ? [session.participantRoleId] : [] },
  });
  await sendSplitClosingThanks(guild, settings, session.participantMemberIds).catch((error) => logRecoverableError("Recoverable asynchronous operation failed", error));
  const deadline = new Date(now.getTime() + waitMs);
  const conversationStarted = Boolean(session.conversationStartedAt && (session.groupSnapshots ?? []).some((group) => group.memberIds?.length));
  await SplitProcessSession.updateOne({ sessionId: session.sessionId }, { $set: { finishNoticeSent: true, finishNoticeAt: now, reviewDeadlineAt: deadline, roleRemoveAt: deadline, finishNoticeChannelId: channel.id, finishNoticeMessageId: message.id, reviewButtonShown: canReview, reviewEligibleMemberIds: eligible, groupSnapshots: snapshots, status: "feedback_open", phase: "feedback_open", reviewAggregationEligible: canReview && eligible.length > 0 && conversationStarted, conversationStartedAt: session.conversationStartedAt ?? null } });
  await schedulePersistentRoleRemoval({ actionKey: `split-role-remove:${session.sessionId}`, type: "split_role_remove", guild, roleId: session.participantRoleId, memberIds: eligible, delayMs: waitMs, timers: callWaitRoleRemovalTimers, payload: { sessionId: session.sessionId, reviewClose: true } });
}

function splitReviewRows(sessionId, draft = {}) {
  draft ??= {};
  const select = (field, placeholder, options, value) => new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
    .setCustomId(`${SPLIT_REVIEW_SELECT}:${sessionId}:${field}`).setPlaceholder(placeholder)
    .addOptions(options.map((option) => ({ ...option, default: option.value === value }))));
  return [
    select("talk", "どれくらい喋れた？", [{ label: "かなり話せた", value: "much" }, { label: "そこそこだった", value: "moderate" }, { label: "あまり話せなかった", value: "little" }], draft.talkAmount),
    select("duration", "時間はどう感じた？", [{ label: "少し長かった", value: "long" }, { label: "ちょうどよかった", value: "just_right" }, { label: "少し短かった", value: "short" }], draft.durationFeeling),
    select("practice", "会話の練習になった？", [{ label: "かなりなった", value: "much" }, { label: "すこしはなった", value: "some" }, { label: "あまりならなかった", value: "little" }], draft.practiceEffect),
    new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`${SPLIT_REVIEW_SUBMIT}:${sessionId}:comment`).setLabel("コメント付きで送信").setStyle(ButtonStyle.Primary), new ButtonBuilder().setCustomId(`${SPLIT_REVIEW_SUBMIT}:${sessionId}:plain`).setLabel("コメントなしで送信").setStyle(ButtonStyle.Secondary)),
  ];
}
async function getEligibleReviewSession(interaction, sessionId) {
  const session = await SplitProcessSession.findOne({ sessionId, guildId: interaction.guildId }).lean();
  if (!session || session.status !== "feedback_open" || !session.reviewDeadlineAt || Date.now() > new Date(session.reviewDeadlineAt).getTime()) return { error: "感想の受付時間は終了しました。" };
  const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
  if (!member?.roles.cache.has(session.participantRoleId)) return { error: "この感想フォームは、今回の参加者のみ利用できます。" };
  const review = await SplitReview.exists({ guildId: interaction.guildId, splitSessionId: sessionId, userId: interaction.user.id });
  if (review) return { error: "この回の感想はすでに送信済みです。" };
  return { session };
}
async function deferSplitReviewReply(interaction) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  }
}

async function handleSplitReviewButton(interaction) {
  const [, sessionId, kind] = interaction.customId.split(":");
  const isOpenButton = interaction.customId.startsWith(`${SPLIT_REVIEW_OPEN}:`);

  // A modal must be acknowledged with showModal; do not defer this branch.
  if (kind === "comment") {
    const checked = await getEligibleReviewSession(interaction, sessionId);
    if (checked.error) {
      return interaction.reply({ content: checked.error, flags: MessageFlags.Ephemeral });
    }
    const draft = await SplitReviewDraft.findOne({
      guildId: interaction.guildId,
      splitSessionId: sessionId,
      userId: interaction.user.id,
    }).lean();
    if (!draft?.talkAmount || !draft?.durationFeeling || !draft?.practiceEffect) {
      return interaction.reply({ content: "3つの項目をすべて選択してください。", flags: MessageFlags.Ephemeral });
    }
    const modal = new ModalBuilder()
      .setCustomId(`${SPLIT_REVIEW_MODAL}:${sessionId}`)
      .setTitle("感想コメント")
      .addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("comment")
          .setLabel("コメント（任意）")
          .setStyle(TextInputStyle.Paragraph)
          .setMaxLength(1500)
          .setRequired(false),
      ));
    return interaction.showModal(modal);
  }

  if (!isOpenButton) {
    await deferSplitReviewReply(interaction);
  }
  const checked = await getEligibleReviewSession(interaction, sessionId);
  if (checked.error) {
    const reply = { content: checked.error, flags: MessageFlags.Ephemeral };
    return interaction.deferred ? interaction.editReply(reply) : interaction.reply(reply);
  }
  const draft = await SplitReviewDraft.findOne({
    guildId: interaction.guildId,
    splitSessionId: sessionId,
    userId: interaction.user.id,
  }).lean();
  if (isOpenButton) {
    return interaction.reply({
      content: "感想の入力ありがとうございます。この感想は運営に送信されます。\n今後に活かしていくために、遠慮せず送っていただけるとありがたいです。",
      components: splitReviewRows(sessionId, draft),
      flags: MessageFlags.Ephemeral,
    });
  }
  if (!draft?.talkAmount || !draft?.durationFeeling || !draft?.practiceEffect) {
    return interaction.editReply({ content: "3つの項目をすべて選択してください。" });
  }
  await submitSplitReview(interaction, checked.session, draft, "");
}
async function handleSplitReviewSelect(interaction) {
  const [, sessionId, field] = interaction.customId.split(":");
  const checked = await getEligibleReviewSession(interaction, sessionId);
  if (checked.error) return interaction.update({ content: checked.error, components: [] });
  const key = { talk: "talkAmount", duration: "durationFeeling", practice: "practiceEffect" }[field];
  const draft = await SplitReviewDraft.findOneAndUpdate(
    { guildId: interaction.guildId, splitSessionId: sessionId, userId: interaction.user.id },
    { $set: { [key]: interaction.values[0], updatedAt: new Date(), expiresAt: checked.session.reviewDeadlineAt } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).lean();
  await interaction.update({
    content: "感想の入力ありがとうございます。この感想は運営に送信されます。\n今後に活かしていくために、遠慮せず送っていただけるとありがたいです。",
    components: splitReviewRows(sessionId, draft),
  });
}
async function handleSplitReviewModal(interaction) {
  const sessionId = interaction.customId.split(":")[1];
  await deferSplitReviewReply(interaction);
  const checked = await getEligibleReviewSession(interaction, sessionId);
  if (checked.error) return interaction.editReply({ content: checked.error });
  const draft = await SplitReviewDraft.findOne({
    guildId: interaction.guildId,
    splitSessionId: sessionId,
    userId: interaction.user.id,
  }).lean();
  if (!draft?.talkAmount || !draft?.durationFeeling || !draft?.practiceEffect) {
    return interaction.editReply({ content: "3つの項目をすべて選択してください。" });
  }
  await submitSplitReview(
    interaction,
    checked.session,
    draft,
    interaction.fields.getTextInputValue("comment"),
  );
}

async function deliverSplitReview(guild, review) {
  const claimed = await SplitReview.findOneAndUpdate(
    { _id: review._id, deliveryStatus: { $in: ["pending", "failed"] } },
    {
      $set: { deliveryStatus: "processing", deliveryLastTriedAt: new Date() },
      $inc: { deliveryRetryCount: 1 },
      $unset: { deliveryLastError: 1 },
    },
    { returnDocument: "after", lean: true },
  );
  if (!claimed) return { delivered: false, error: "Review delivery is already being processed" };

  try {
    if (!claimed.reviewChannelId) throw new Error("感想送信先が設定されていません。");
    const channel = await guild.channels.fetch(claimed.reviewChannelId);
    if (!channel?.send) throw new Error("感想送信先チャンネルを使用できません。");
    const members = claimed.groupMemberIds
      .filter((id) => id !== claimed.userId)
      .map((id, index) => `${index + 1}. <@${id}>`)
      .join("\n") || "（他のメンバーはいません）";
    const message = await channel.send({
      content: `<@${claimed.userId}> さんの感想（${claimed.eventDate}分）\n\nどれくらい喋れた？：${TALK_AMOUNT_LABELS[claimed.talkAmount] ?? "不明"}\n時間はどうだった？：${DURATION_FEELING_LABELS[claimed.durationFeeling] ?? "不明"}\n会話の練習になった？：${PRACTICE_EFFECT_LABELS[claimed.practiceEffect] ?? "不明"}${claimed.comment ? `\n\nコメント：${claimed.comment}` : ""}\n\n<@${claimed.userId}>さんのグループメンバー\n${members}`,
      allowedMentions: { parse: [] },
    });
    const completed = await SplitReview.updateOne(
      { _id: claimed._id, deliveryStatus: "processing" },
      { $set: { deliveryStatus: "delivered", reviewMessageId: message.id, reviewChannelId: channel.id }, $unset: { deliveryLastError: 1 } },
    );
    if (completed.matchedCount !== 1 || completed.modifiedCount !== 1) {
      throw new Error("Review delivery succeeded but completion could not be persisted");
    }
    return { delivered: true };
  } catch (error) {
    const failed = await SplitReview.updateOne(
      { _id: claimed._id, deliveryStatus: "processing" },
      { $set: { deliveryStatus: "failed", deliveryLastError: error.message, deliveryLastTriedAt: new Date() } },
    ).catch((statusError) => {
      console.error("Failed to persist split review delivery failure:", statusError);
      return null;
    });
    if (!failed || failed.matchedCount !== 1) {
      console.error("Split review delivery failed and its retry state could not be confirmed:", error);
    }
    return { delivered: false, error: error.message };
  }
}

async function restoreFailedSplitReviewDeliveries() {
  const reviews = await SplitReview.find({ deliveryStatus: "failed" }).lean();
  let retried = 0;
  for (const review of reviews) {
    try {
      const guild = client.guilds.cache.get(review.guildId) ?? await client.guilds.fetch(review.guildId).catch(() => null);
      if (!guild) throw new Error("Guild is unavailable");
      const result = await deliverSplitReview(guild, review);
      if (result.delivered) retried += 1;
      else console.error(`Failed to retry split review delivery ${review._id}: ${result.error}`);
    } catch (error) {
      console.error(`Failed to restore split review delivery ${review._id}: ${error.message}`);
    }
  }
  if (reviews.length) console.log(`Startup split review deliveries retried: ${retried}/${reviews.length}`);
}

async function submitSplitReview(interaction, session, draft, rawComment) {
  await deferSplitReviewReply(interaction);
  const finalCheck = await getEligibleReviewSession(interaction, session.sessionId);
  if (finalCheck.error) return interaction.editReply({ content: finalCheck.error });
  session = finalCheck.session;
  const comment = rawComment?.trim() || undefined;
  const group = (session.groupSnapshots ?? []).find(
    (item) => item.memberIds?.includes(interaction.user.id),
  );
  let review;
  let settings = null;
  try {
    settings = await getGuildSettings(interaction.guildId);
  } catch (error) {
    console.error("Failed to load settings before saving split review:", error);
  }
  try {
    review = await SplitReview.create({
      guildId: interaction.guildId,
      splitSessionId: session.sessionId,
      questionnaireVersion: 1,
      eventStartedAt: session.conversationStartedAt ?? session.createdAt,
      eventDate: jstReviewDate(session.conversationStartedAt ?? session.createdAt),
      userId: interaction.user.id,
      participantRoleId: session.participantRoleId,
      groupNumber: group?.groupNumber,
      groupMemberIds: group?.memberIds ?? [],
      talkAmount: draft.talkAmount,
      durationFeeling: draft.durationFeeling,
      practiceEffect: draft.practiceEffect,
      comment,
      deliveryStatus: "pending",
      reviewChannelId: settings?.reviewSendChannelId ?? null,
    });
  } catch (error) {
    if (error?.code === 11000) {
      return interaction.editReply({ content: "この回の感想はすでに送信済みです。" });
    }
    return interaction.editReply({
      content: "感想の送信に失敗しました。時間をおいてもう一度お試しください。",
    });
  }

  await SplitReviewDraft.deleteOne({
    guildId: interaction.guildId,
    splitSessionId: session.sessionId,
    userId: interaction.user.id,
  }).catch((error) => console.error("Failed to delete split review draft:", error));

  const delivery = await deliverSplitReview(interaction.guild, review);
  if (!delivery.delivered) {
    const failureLogContent = `【感想転送失敗】\nサーバー：${interaction.guild.name}（${interaction.guildId}）\nセッションID：${session.sessionId}\n回答者：${interaction.user.username}（${interaction.user.id}）\n感想送信先：${review.reviewChannelId}\nDB保存状態：保存済み\ndeliveryStatus：failed\nエラー内容：${delivery.error}\n発生日時：${new Date().toISOString()}`;
    const logSettings = settings ?? await getGuildSettings(interaction.guildId).catch((settingsError) => {
      console.error("Failed to load settings for review failure log:", settingsError);
      return null;
    });
    if (!logSettings) {
      console.error(failureLogContent);
    } else await sendOperationalLog({
      guild: interaction.guild,
      settings: logSettings,
      fallbackChannel: null,
      content: failureLogContent,
      allowedMentions: { parse: [] },
    }).catch((logError) => {
      console.error("Review delivery and operational log failed", failureLogContent, delivery.error, logError);
    });
    await interaction.editReply({
      content: "回答内容は保存しましたが、運営チャンネルへの転送に失敗しました。\n運営側で再送処理を行います。",
      components: [],
    }).catch((error) => console.error("Failed to complete split review interaction:", error));
    return;
  }

  await interaction.editReply({
    content: "感想を送信しました。ご協力ありがとうございます！",
    components: [],
  }).catch((error) => console.error("Failed to complete split review interaction:", error));
}
function jstReviewDate(value) { const parts = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric" }).formatToParts(new Date(value)); return `${parts.find((x) => x.type === "month")?.value}月${parts.find((x) => x.type === "day")?.value}日`; }

function clearRestoredWaitingMonitor(sessionId) {
  const timer = restoredWaitingMonitorTimers.get(sessionId);
  if (timer) clearInterval(timer);
  restoredWaitingMonitorTimers.delete(sessionId);
}

async function claimWaitingMonitorLease(sessionId) {
  const now = new Date();
  return SplitProcessSession.findOneAndUpdate(
    {
      sessionId,
      status: "active",
      waitingMonitorStatus: { $in: ["active", "extended"] },
      $or: [
        { waitingMonitorLeaseOwner: waitingMonitorLeaseOwner },
        { waitingMonitorLeaseUntil: { $lte: now } },
        { waitingMonitorLeaseUntil: { $exists: false } },
      ],
    },
    {
      $set: {
        waitingMonitorLeaseOwner: waitingMonitorLeaseOwner,
        waitingMonitorLeaseUntil: new Date(now.getTime() + WAITING_MONITOR_LEASE_MS),
        waitingMonitorHeartbeatAt: now,
      },
    },
    { returnDocument: "after", lean: true },
  );
}

async function releaseWaitingMonitorLease(sessionId) {
  await SplitProcessSession.updateOne(
    { sessionId, waitingMonitorLeaseOwner: waitingMonitorLeaseOwner },
    { $unset: { waitingMonitorLeaseOwner: 1, waitingMonitorLeaseUntil: 1 } },
  );
}

async function recordWaitingMonitorFailure(sessionId, error) {
  const session = await SplitProcessSession.findOneAndUpdate(
    { sessionId, status: "active", waitingMonitorStatus: { $in: ["active", "extended"] } },
    {
      $set: {
        waitingMonitorHeartbeatAt: new Date(),
        lastError: `Waiting monitor iteration failed: ${error?.message ?? error}`,
      },
      $inc: { waitingMonitorFailureCount: 1 },
    },
    { returnDocument: "after", lean: true },
  );
  if (!session || session.waitingMonitorFailureCount < 3) return false;
  await SplitProcessSession.updateOne(
    { sessionId, status: "active", waitingMonitorStatus: { $in: ["active", "extended"] } },
    { $set: { waitingMonitorStatus: "failed" } },
  );
  return true;
}

async function createRestoredWaitingGroup({ session, guild, waitingChannel, waitingMembers }) {
  if (waitingMembers.length < 3 || !session.parentChannelId) return false;
  const parentChannel = await guild.channels.fetch(session.parentChannelId).catch(() => null);
  if (!parentChannel?.isVoiceBased?.()) return false;
  const members = waitingMembers.slice(0, 3);
  const addedRoleIds = new Set();
  const addRoleIfNeeded = async (member) => {
    if (!session.participantRoleId || member.roles.cache.has(session.participantRoleId)) return;
    await member.roles.add(session.participantRoleId, "Restored split waiting-room group creation");
    try {
      await VoiceParticipantRoleGrant.updateOne(
        {
          guildId: guild.id,
          memberId: member.id,
          roleId: session.participantRoleId,
          sourceType: "splitvc",
          sourceId: session.sessionId,
        },
        {
          $set: {
            grantedByBot: true,
            grantedAt: new Date(),
            status: "active",
            removedAt: null,
            cleanupAt: null,
          },
          $setOnInsert: {
            guildId: guild.id,
            memberId: member.id,
            roleId: session.participantRoleId,
            sourceType: "splitvc",
            sourceId: session.sessionId,
          },
        },
        { upsert: true },
      );
    } catch (error) {
      await member.roles.remove(session.participantRoleId, "Rollback untracked restored split role").catch((rollbackError) => {
        console.error(`Failed to roll back untracked restored split role for ${member.id}: ${rollbackError.message}`);
      });
      throw error;
    }
    addedRoleIds.add(member.id);
  };
  const rollbackAddedRoles = async () => Promise.all(
    [...addedRoleIds].map((memberId) => guild.members.fetch(memberId)
      .then((member) => removeVoiceParticipantRole(member, session.participantRoleId, {
        sourceType: "splitvc",
        sourceId: session.sessionId,
      }))
      .catch((error) => logRecoverableError("Recoverable asynchronous operation failed", error))),
  );
  let createdChildChannelId = null;

  try {
    const seedMember = members[0];
    await addRoleIfNeeded(seedMember);
    await seedMember.voice.setChannel(parentChannel, "Restored split waiting-room group seed");
    const startedAt = Date.now();
    let childChannel = null;
    while (Date.now() - startedAt < PB_CHILD_WAIT_MS) {
      const candidate = seedMember.voice.channel;
      const expectedCategoryId = session.childCategoryId ?? parentChannel.parentId;
      if (
        candidate?.isVoiceBased?.()
        && candidate.id !== parentChannel.id
        && candidate.id !== waitingChannel.id
        && (!expectedCategoryId || candidate.parentId === expectedCategoryId)
      ) {
        childChannel = candidate;
        break;
      }
      await sleep(750);
    }
    if (!childChannel) {
      await seedMember.voice.setChannel(waitingChannel, "Restore waiting-room after PB child detection failed").catch((error) => logRecoverableError("Failed to restore member to waiting VC", error));
      await rollbackAddedRoles();
      return false;
    }
    createdChildChannelId = childChannel.id;

    const movedMemberIds = [seedMember.id];
    for (const member of members.slice(1)) {
      try {
        await addRoleIfNeeded(member);
        await member.voice.setChannel(childChannel, "Restored split waiting-room group member");
        movedMemberIds.push(member.id);
      } catch (error) {
        if (addedRoleIds.has(member.id)) {
          await removeVoiceParticipantRole(member, session.participantRoleId, {
            sourceType: "splitvc",
            sourceId: session.sessionId,
          }).catch((rollbackError) => {
            console.error(`Failed to roll back restored split role for ${member.id}: ${rollbackError.message}`);
          });
          addedRoleIds.delete(member.id);
        }
        waitingMemberRetryAfter.set(`${guild.id}:${member.id}`, Date.now() + 15_000);
        console.error(`Failed to move restored split waiting member ${member.id}: ${error.message}`);
      }
    }
    const persisted = await SplitProcessSession.updateOne(
      { sessionId: session.sessionId, status: "active", waitingMonitorStatus: { $in: ["active", "extended"] }, waitingMonitorLeaseOwner: waitingMonitorLeaseOwner },
      {
        $addToSet: {
          participantMemberIds: { $each: movedMemberIds },
          participantRoleGrantedMemberIds: { $each: movedMemberIds.filter((memberId) => addedRoleIds.has(memberId)) },
          childChannelIds: childChannel.id,
        },
        $push: {
          groupSnapshots: {
            groupNumber: (session.groupSnapshots?.length ?? 0) + 1,
            channelId: childChannel.id,
            memberIds: movedMemberIds,
          },
        },
        $set: { waitingMonitorHeartbeatAt: new Date(), waitingMonitorFailureCount: 0 },
      },
    );
    if (persisted.matchedCount !== 1 || persisted.modifiedCount !== 1) {
      throw new Error("Restored waiting-group persistence did not update the active session.");
    }
    return true;
  } catch (error) {
    if (createdChildChannelId) {
      await Promise.all(members.map(async (member) => {
        if (member.voice.channelId === createdChildChannelId) {
          await member.voice.setChannel(waitingChannel, "Rollback restored waiting group after persistence failure");
        }
      })).catch((rollbackError) => logRecoverableError("Failed to return restored waiting members", rollbackError));
      await guild.channels.fetch(createdChildChannelId)
        .then((channel) => channel?.delete("Rollback restored waiting child after persistence failure"))
        .catch((rollbackError) => logRecoverableError("Failed to delete restored waiting child", rollbackError));
    }
    await rollbackAddedRoles();
    await sendOperationalLog({
      guild,
      settings: await getGuildSettings(guild.id).catch(() => null),
      fallbackChannel: null,
      content: `復元した途中参加の新規グループ作成に失敗しました。セッション: ${session.sessionId}、エラー: ${error?.message ?? error}`,
    }).catch((error) => logRecoverableError("Recoverable asynchronous operation failed", error));
    return false;
  }
}

async function processRestoredWaitingMonitor(sessionId, guild) {
  if (restoredWaitingMonitorLocks.has(sessionId)) return;
  restoredWaitingMonitorLocks.add(sessionId);
  try {
    const session = await claimWaitingMonitorLease(sessionId);
    if (!session) {
      const current = await SplitProcessSession.findOne({
        sessionId,
        status: "active",
        waitingMonitorStatus: { $in: ["active", "extended"] },
      }).lean();
      const leaseUntil = current?.waitingMonitorLeaseUntil
        ? new Date(current.waitingMonitorLeaseUntil)
        : null;
      if (leaseUntil && Number.isFinite(leaseUntil.getTime()) && leaseUntil.getTime() > Date.now()) {
        // Keep the interval alive while another process owns the old lease.
        // The next interval after this timestamp acquires it if the owner is gone.
        await SplitProcessSession.updateOne(
          { sessionId, waitingMonitorLeaseUntil: current.waitingMonitorLeaseUntil },
          { $set: { waitingMonitorLeaseRetryAt: leaseUntil } },
        );
        return;
      }
      if (current) {
        // Another process may have renewed or released the lease between the
        // claim and this read.  Keep monitoring and try again next interval.
        return;
      }
      clearRestoredWaitingMonitor(sessionId);
      return;
    }
    const waitingChannel = await guild.channels.fetch(session.waitingChannelId).catch(() => null);
    if (!waitingChannel?.isVoiceBased?.()) {
      await SplitProcessSession.updateOne({ sessionId }, { $set: { waitingMonitorStatus: "closed", waitingMonitorClosedAt: new Date(), waitingVcCleanupCompleted: true } });
      clearRestoredWaitingMonitor(sessionId);
      return;
    }
    const childChannels = (await Promise.all((session.childChannelIds ?? []).map((id) => guild.channels.fetch(id).catch(() => null))))
      .filter((channel) => channel?.isVoiceBased?.());
    const hasUnderfilledChildChannel = childChannels.some(
      (channel) => [...channel.members.values()].filter((member) => !member.user.bot).length < 3,
    );
    const monitorEndsAt = new Date(session.waitingMonitorEndsAt).getTime();
    if (Number.isFinite(monitorEndsAt) && Date.now() >= monitorEndsAt) {
      if (hasUnderfilledChildChannel) {
        await SplitProcessSession.updateOne(
          { sessionId, waitingMonitorLeaseOwner: waitingMonitorLeaseOwner, waitingMonitorStatus: "active" },
          { $set: { waitingMonitorStatus: "extended", waitingMonitorExtendedAt: new Date() } },
        );
      } else {
        const closing = await SplitProcessSession.findOneAndUpdate(
          { sessionId, status: "active", waitingMonitorStatus: { $in: ["active", "extended"] }, waitingMonitorLeaseOwner: waitingMonitorLeaseOwner },
          { $set: { waitingMonitorStatus: "closing" }, $unset: { waitingMonitorLeaseOwner: 1, waitingMonitorLeaseUntil: 1 } },
          { returnDocument: "after", lean: true },
        );
        if (closing) {
          const operationChannel = await guild.channels.fetch(session.operationChannelId).catch(() => null);
          await notifyWaitingVcClosure(operationChannel, waitingChannel).catch((error) => logRecoverableError("Recoverable asynchronous operation failed", error));
          try {
            await waitingChannel.delete();
          } catch (error) {
            await SplitProcessSession.updateOne(
              { sessionId, waitingMonitorStatus: "closing" },
              {
                $set: {
                  waitingMonitorStatus: "failed",
                  waitingVcCleanupCompleted: false,
                  lastError: `Restored waiting VC cleanup failed: ${error?.message ?? error}`,
                },
              },
            );
            await sendOperationalLog({
              guild,
              settings: await getGuildSettings(guild.id).catch(() => null),
              fallbackChannel: operationChannel,
              content: `再開した途中参加監視の待機VC削除に失敗しました: ${error?.message ?? error}`,
            }).catch((error) => logRecoverableError("Recoverable asynchronous operation failed", error));
            clearRestoredWaitingMonitor(sessionId);
            return;
          }
          await SplitProcessSession.updateOne(
            { sessionId, waitingMonitorStatus: "closing" },
            { $set: { waitingMonitorStatus: "closed", waitingMonitorClosedAt: new Date(), waitingVcCleanupCompleted: true } },
          );
        }
        clearRestoredWaitingMonitor(sessionId);
        return;
      }
    }
    const waitingMembers = [...waitingChannel.members.values()].filter((member) => !member.user.bot);
    if (!hasUnderfilledChildChannel && waitingMembers.length >= 3) {
      const created = await createRestoredWaitingGroup({ session, guild, waitingChannel, waitingMembers });
      if (created) return;
    }
    for (const member of waitingMembers) {
      const target = childChannels
        .filter((channel) => [...channel.members.values()].filter((voiceMember) => !voiceMember.user.bot).length < 3)
        .sort((left, right) => left.members.size - right.members.size)[0];
      if (!target) break;
      let roleAddedForTransfer = false;
      try {
        if (session.participantRoleId && !member.roles.cache.has(session.participantRoleId)) {
          await member.roles.add(session.participantRoleId, "Restored split waiting-room transfer");
          try {
            await VoiceParticipantRoleGrant.updateOne(
              {
                guildId: guild.id,
                memberId: member.id,
                roleId: session.participantRoleId,
                sourceType: "splitvc",
                sourceId: session.sessionId,
              },
              {
                $set: {
                  grantedByBot: true,
                  grantedAt: new Date(),
                  status: "active",
                  removedAt: null,
                  cleanupAt: null,
                },
                $setOnInsert: {
                  guildId: guild.id,
                  memberId: member.id,
                  roleId: session.participantRoleId,
                  sourceType: "splitvc",
                  sourceId: session.sessionId,
                },
              },
              { upsert: true },
            );
          } catch (error) {
            await member.roles.remove(session.participantRoleId, "Rollback untracked restored split role").catch((rollbackError) => {
              console.error(`Failed to roll back untracked restored split role for ${member.id}: ${rollbackError.message}`);
            });
            throw error;
          }
          roleAddedForTransfer = true;
        }
        await member.voice.setChannel(target, "Restored split waiting-room transfer");
        const snapshotIndex = (session.groupSnapshots ?? []).findIndex((group) => group.channelId === target.id);
        const groupUpdate = snapshotIndex >= 0
          ? { $addToSet: { participantMemberIds: member.id, [`groupSnapshots.${snapshotIndex}.memberIds`]: member.id } }
          : {
            $addToSet: { participantMemberIds: member.id, childChannelIds: target.id },
            $push: {
              groupSnapshots: {
                groupNumber: (session.groupSnapshots?.length ?? 0) + 1,
                channelId: target.id,
                memberIds: [member.id],
              },
            },
          };
        if (roleAddedForTransfer) groupUpdate.$addToSet.participantRoleGrantedMemberIds = member.id;
        const persisted = await SplitProcessSession.updateOne(
          { sessionId, status: "active", waitingMonitorStatus: { $in: ["active", "extended"] }, waitingMonitorLeaseOwner: waitingMonitorLeaseOwner },
          { ...groupUpdate, $set: { waitingMonitorHeartbeatAt: new Date(), waitingMonitorFailureCount: 0 } },
        );
        if (persisted.matchedCount !== 1 || persisted.modifiedCount !== 1) {
          throw new Error("Restored waiting transfer persistence did not match the active session");
        }
      } catch (error) {
        if (member.voice.channelId === target?.id) {
          await member.voice.setChannel(waitingChannel, "Rollback restored waiting transfer after persistence failure").catch((rollbackError) => {
            console.error(`Failed to return restored waiting member ${member.id}: ${rollbackError.message}`);
          });
        }
        if (roleAddedForTransfer) {
          await removeVoiceParticipantRole(member, session.participantRoleId, {
            sourceType: "splitvc",
            sourceId: session.sessionId,
          }).catch((rollbackError) => {
            console.error(`Failed to roll back restored split role for ${member.id}: ${rollbackError.message}`);
          });
        }
        waitingMemberRetryAfter.set(`${guild.id}:${member.id}`, Date.now() + 15_000);
        await recordWaitingMonitorFailure(sessionId, error).catch((error) => logRecoverableError("Recoverable asynchronous operation failed", error));
        await sendOperationalLog({ guild, settings: await getGuildSettings(guild.id).catch(() => null), fallbackChannel: null, content: `復元した途中参加転送に失敗しました。セッション: ${sessionId}、ユーザー: ${member.id}、エラー: ${error?.message ?? error}` }).catch((error) => logRecoverableError("Recoverable asynchronous operation failed", error));
      }
    }
    await SplitProcessSession.updateOne({ sessionId }, { $set: { waitingMonitorHeartbeatAt: new Date() } });
  } finally {
    restoredWaitingMonitorLocks.delete(sessionId);
  }
}

function startRestoredWaitingMonitor(session, guild) {
  clearRestoredWaitingMonitor(session.sessionId);
  const timer = setInterval(() => {
    void processRestoredWaitingMonitor(session.sessionId, guild).catch((error) => {
      console.error(`Restored waiting monitor failed for ${session.sessionId}:`, error);
    });
  }, WAITING_ROOM_POLL_MS);
  restoredWaitingMonitorTimers.set(session.sessionId, timer);
  void processRestoredWaitingMonitor(session.sessionId, guild);
}

async function restoreSplitProcessSessions() {
  if (mongoose.connection.readyState !== 1) return;
  const sessions = await SplitProcessSession.find({ status: { $in: ["active", "finish_notice_pending", "role_remove_pending", "cleaning_up", "feedback_open"] } }).lean();
  let restored = 0;
  for (const session of sessions) {
    try {
      const guild = client.guilds.cache.get(session.guildId) ?? await client.guilds.fetch(session.guildId).catch(() => null);
      if (!guild) continue;
      if (session.phase === "transfer_waiting" && !(session.childChannelIds?.length)) {
        await SplitProcessSession.updateOne(
          { sessionId: session.sessionId, status: "active" },
          { $set: { status: "canceled", phase: "canceled", lastError: "Bot restarted before transfer completed" } },
        );
        continue;
      }
      if (
        session.status === "active"
        && session.waitingChannelId
        && ["active", "extended"].includes(session.waitingMonitorStatus)
      ) {
        startRestoredWaitingMonitor(session, guild);
      }
      if (session.status === "active" && !session.finishNoticeSent) { restored += 1; continue; }
      const roleRemoveAt = session.roleRemoveAt ? new Date(session.roleRemoveAt).getTime() : Date.now();
      const roleId = session.participantRoleId;
      const memberIds = session.reviewEligibleMemberIds ?? session.participantMemberIds ?? [];
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
    } catch (error) {
      console.error(`Failed to restore split session ${session.sessionId}: ${error.message}`);
    }
  }
  console.log(`Startup split sessions restored: ${restored}`);
}

async function scheduleCallWaitFollowupCheck(guild) {
  const actionKey = `callwait-followup:${guild.id}:${createSessionId()}`;
  const executeAt = new Date(Date.now() + CALL_WAIT_FOLLOWUP_CHECK_MS);
  const result = await scheduleSingleGuildAction({
    actionKey,
    guildId: guild.id,
    type: "callwait_followup",
    executeAt,
  });
  const scheduledAction = result.action;
  if (!result.scheduled || scheduledAction.status !== "pending") return;

  const existingTimer = callWaitFollowupTimers.get(scheduledAction.actionKey);

  if (existingTimer) {
    clearTimeout(existingTimer);
  }

  const delayMs = Math.max(0, new Date(scheduledAction.executeAt).getTime() - Date.now());
  const timer = setTimeout(() => {
    callWaitFollowupTimers.delete(scheduledAction.actionKey);
    void executeCallWaitFollowup({ actionKey: scheduledAction.actionKey, guild }).catch((error) => {
      console.error(`Failed to run call wait follow-up ${scheduledAction.actionKey}: ${error.message}`, error);
    });
  }, delayMs);

  callWaitFollowupTimers.set(scheduledAction.actionKey, timer);
}

async function executeCallWaitFollowup({ actionKey, guild }) {
  const claimed = await claimAction(actionKey);
  if (!claimed) return;
  try {
    await runCallWaitFollowupCheck(guild.id);
    await finishAction(actionKey);
  } catch (error) {
    // A transient Discord or MongoDB outage must not permanently suppress
    // future scheduled recruitment.  Put the follow-up back in the durable
    // queue and install a local retry; startup restoration covers restarts.
    const executeAt = new Date(Date.now() + CALL_WAIT_FOLLOWUP_RETRY_MS);
    const retried = await retryAction(actionKey, {
      executeAt,
      lastError: error.message,
    }).catch((retryError) => {
      console.error(`Failed to reschedule call-wait follow-up ${actionKey}: ${retryError.message}`, retryError);
      return null;
    });
    if (retried) {
      const retryTimer = setTimeout(() => {
        callWaitFollowupTimers.delete(actionKey);
        void executeCallWaitFollowup({ actionKey, guild }).catch((retryError) => {
          console.error(`Failed to retry call-wait follow-up ${actionKey}: ${retryError.message}`, retryError);
        });
      }, CALL_WAIT_FOLLOWUP_RETRY_MS);
      callWaitFollowupTimers.set(actionKey, retryTimer);
    } else {
      await failAction(actionKey, error.message).catch((error) => logRecoverableError("Recoverable asynchronous operation failed", error));
    }
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
  if (await isKokuchiCallWaitPaused(settings, guild.id, new Date())) {
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
    content: `現在複数人が雑談中のため、${formatJstTime(getNextJstCallWaitSlot({ now, intervalMinutes: getCallWaitIntervalMinutes(settings) }))}からの定時募集は行いません。`,
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

async function removeCallWaitRoleFromMembers(guild, roleId, memberIds, source = null) {
  const errors = [];
  for (const memberId of memberIds) {
    const member = await guild.members.fetch(memberId).catch(() => null);

    if (!member) {
      continue;
    }

    if (source?.sourceType) {
      await removeVoiceParticipantRole(member, roleId, source);
      continue;
    }

    if (!member.roles.cache.has(roleId)) {
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

function formatCallWaitPromptV2(targetAt, memberIds = []) {
  const time = formatJstTime(targetAt);
  return [
    "【定時募集】",
    "",
    `${time}から雑談したい方を募集しています。`,
    `${time}時点で参加予定者が2人以上集まっていたら、メンションでお知らせします！`,
    "",
    `現在の参加予定者数：${normalizeCallWaitMemberIds(memberIds).length}人`,
  ].join("\n");
}

function getCallWaitIntervalMinutes(settings = null) {
  return normalizeCallWaitIntervalMinutes(settings?.callWaitIntervalMinutes);
}

function getCallWaitSlotKey(targetAt, settings = null) {
  return createCallWaitSlotKey(targetAt, getCallWaitIntervalMinutes(settings));
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

function createOteboVoiceStatusSession({ recruitment, memberIds, notifiedAt }) {
  const durationMinutes = getOteboDurationMinutes(recruitment.duration);
  if (!durationMinutes) {
    return null;
  }

  return {
    id: createOteboRecruitmentId(),
    recruitmentId: recruitment.id,
    memberIds: normalizeCallWaitMemberIds(memberIds),
    duration: normalizeOteboDuration(recruitment.duration),
    durationMinutes,
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
    try {
    const settings = await getGuildSettings(guild.id);

    for (const recruitment of Object.values(getOteboRecruitments(settings))) {
      if (recruitment?.status === "publishing") {
        const recoveredSettings = await transitionOteboRecruitment({
          guildId: guild.id,
          recruitmentId: recruitment.id,
          fromStatuses: ["publishing"],
          toStatus: "active",
          patch: { lastError: "Bot restarted while otebo notice publication was processing" },
        }).catch((error) => {
          console.error(`Failed to recover otebo publishing state ${recruitment.id}: ${error.message}`);
          return null;
        });
        const recovered = recoveredSettings && getOteboRecruitment(recoveredSettings, recruitment.id);
        if (recovered?.status === "active") {
          scheduleOteboRecruitmentTimers(guild, recovered);
        }
        continue;
      }
      if (["success_processing", "success_notified", "cleanup_pending"].includes(recruitment?.status)) {
        const memberIds = normalizeCallWaitMemberIds(
          recruitment.participantRoleGrantedMemberIds ?? recruitment.memberIds,
        );
        if (settings?.callWaitRoleId && memberIds.length) {
          await scheduleOteboRoleRemoval({
            guild,
            roleId: settings.callWaitRoleId,
            memberIds,
            recruitmentId: recruitment.id,
          });
        }
        if (recruitment.status !== "cleanup_pending") {
          await transitionOteboRecruitment({
            guildId: guild.id,
            recruitmentId: recruitment.id,
            fromStatuses: [recruitment.status],
            toStatus: "cleanup_pending",
            patch: { lastError: "Bot restarted during otebo success processing; notice replay is disabled" },
          });
        }
        continue;
      }
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
    } catch (error) {
      console.error(`Failed to restore otebo state for guild ${guild.id}: ${error.message}`);
    }
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

  const claimedSettings = await transitionOteboRecruitment({
    guildId: guild.id,
    recruitmentId,
    fromStatuses: ["active"],
    toStatus: "publishing",
  });
  if (!claimedSettings) {
    return;
  }
  const claimedRecruitment = getOteboRecruitment(claimedSettings, recruitmentId);
  if (!claimedRecruitment || claimedRecruitment.status !== "publishing") {
    return;
  }

  const noticeChannel = await resolveConfiguredTextChannel(
    guild,
    claimedRecruitment.noticeChannelId ?? getCallWaitNoticeChannelId(claimedSettings),
  );

  if (!noticeChannel) {
    await transitionOteboRecruitment({
      guildId: guild.id,
      recruitmentId,
      fromStatuses: ["publishing"],
      toStatus: "active",
      patch: { lastError: "Configured otebo notice channel is unavailable" },
    });
    return;
  }

  const nextRecruitment = {
    ...claimedRecruitment,
    channelId: noticeChannel.id,
    messageId: null,
    noticeChannelId: noticeChannel.id,
    publishedToNotice: true,
    status: "active",
  };
  let message;
  try {
    message = await noticeChannel.send({
      content: formatOteboRecruitmentMessage(nextRecruitment, claimedSettings),
      components: [createOteboJoinRow(nextRecruitment)],
      allowedMentions: getOteboRecruitmentAllowedMentions(nextRecruitment, claimedSettings),
    });
  } catch (error) {
    await transitionOteboRecruitment({
      guildId: guild.id,
      recruitmentId,
      fromStatuses: ["publishing"],
      toStatus: "active",
      patch: { lastError: `Otebo notice send failed: ${error.message}` },
    }).catch((statusError) => {
      console.error(`Failed to restore otebo publication state: ${statusError.message}`);
    });
    throw error;
  }

  nextRecruitment.messageId = message.id;

  let nextSettings;
  try {
    nextSettings = await saveOteboRecruitmentState(
      guild.id,
      claimedSettings,
      nextRecruitment,
    );
  } catch (error) {
    await message.edit({
      content: "【操作できません】\n\n募集の保存に失敗したため、このメッセージは無効です。",
      components: [],
    }).catch((editError) => {
      console.error(`Failed to disable unconfirmed otebo notice: ${editError.message}`);
    });
    await transitionOteboRecruitment({
      guildId: guild.id,
      recruitmentId,
      fromStatuses: ["publishing"],
      toStatus: "published_unconfirmed",
      patch: { lastError: `Otebo notice was sent but persistence failed: ${error.message}` },
    }).catch((statusError) => {
      console.error(`Failed to persist otebo published_unconfirmed state: ${statusError.message}`);
    });
    throw error;
  }

  await deleteOteboRecruitmentMessage(guild, recruitment).catch((error) => {
    console.error(`Failed to delete obsolete otebo preview message: ${error.message}`);
  });
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

async function releaseOteboSuccessClaim(guild, recruitmentId, error) {
  const restoredSettings = await transitionOteboRecruitment({
    guildId: guild.id,
    recruitmentId,
    fromStatuses: ["success_processing"],
    toStatus: "active",
    patch: { lastError: error?.message ?? String(error) },
  });
  const restored = restoredSettings && getOteboRecruitment(restoredSettings, recruitmentId);
  if (restored?.status === "active") scheduleOteboRecruitmentTimers(guild, restored);
  return restoredSettings;
}

async function finishOteboRecruitmentSuccess({ guild, settings, recruitment }) {
  const memberIds = normalizeCallWaitMemberIds(recruitment.memberIds);

  if (memberIds.length < CALL_WAIT_MIN_MEMBERS || !settings?.callWaitRoleId) {
    return false;
  }

  const successLease = await acquireMongoLease(`otebo-success:${guild.id}:${recruitment.id}`, { leaseMs: 2 * 60 * 1000 });
  if (!successLease) return false;

  try {
  const claimedSettings = await transitionOteboRecruitment({
    guildId: guild.id,
    recruitmentId: recruitment.id,
    fromStatuses: ["active"],
    toStatus: "success_processing",
  });
  if (!claimedSettings) return false;
  settings = claimedSettings;
  recruitment = getOteboRecruitment(claimedSettings, recruitment.id);
  if (!recruitment || recruitment.status !== "success_processing") return false;

  const channel = await resolveConfiguredTextChannel(
    guild,
    getCallWaitNoticeChannelId(settings),
  );
  if (!channel) {
    await releaseOteboSuccessClaim(guild, recruitment.id, new Error("Configured otebo success notice channel is unavailable"));
    return false;
  }

  const { memberIds: roleMemberIds, grantedMemberIds } = await addTemporaryRoleToMembers({
    guild,
    roleId: settings.callWaitRoleId,
    memberIds,
    sourceType: "otebo",
    sourceId: recruitment.id,
    reason: "お手軽募集の集合通知",
  });

  if (roleMemberIds.length < CALL_WAIT_MIN_MEMBERS) {
    await removeTemporaryRoleFromMembers({
      guild,
      roleId: settings.callWaitRoleId,
      memberIds: grantedMemberIds,
      sourceType: "otebo",
      sourceId: recruitment.id,
      reason: "Recruitment could not grant roles to enough members",
    }).catch((error) => console.error(`Failed to roll back otebo roles: ${error.message}`, error));
    await releaseOteboSuccessClaim(guild, recruitment.id, new Error("Could not grant the participant role to enough members"));
    return false;
  }

  const notifiedAt = new Date();
  try {
    await channel.send({
      content: formatOteboStartNoticeMessage(settings.callWaitRoleId, recruitment),
      allowedMentions: { roles: [settings.callWaitRoleId] },
    });
  } catch (error) {
    await removeTemporaryRoleFromMembers({
      guild,
      roleId: settings.callWaitRoleId,
      memberIds: grantedMemberIds,
      sourceType: "otebo",
      sourceId: recruitment.id,
      reason: "Recruitment success notice failed",
    }).catch((rollbackError) => console.error(`Failed to roll back otebo roles: ${rollbackError.message}`, rollbackError));
    await releaseOteboSuccessClaim(guild, recruitment.id, error);
    return false;
  }

  const notifiedSettings = await transitionOteboRecruitment({
    guildId: guild.id,
    recruitmentId: recruitment.id,
    fromStatuses: ["success_processing"],
    toStatus: "success_notified",
    patch: {
      successNoticeSentAt: notifiedAt.toISOString(),
      participantRoleGrantedMemberIds: grantedMemberIds,
      lastError: null,
    },
  });
  if (!notifiedSettings) {
    // The Discord notice is already visible.  Do not retry it automatically.
    console.error(`Otebo success notice was sent but its state could not be persisted: ${recruitment.id}`);
    return false;
  }
  settings = notifiedSettings;
  recruitment = getOteboRecruitment(notifiedSettings, recruitment.id);

  try {
    if (grantedMemberIds.length) {
      await scheduleOteboRoleRemoval({
        guild,
        roleId: settings.callWaitRoleId,
        memberIds: grantedMemberIds,
        recruitmentId: recruitment.id,
      });
    }
  } catch (error) {
    await removeTemporaryRoleFromMembers({
      guild,
      roleId: settings.callWaitRoleId,
      memberIds: grantedMemberIds,
      sourceType: "otebo",
      sourceId: recruitment.id,
      reason: "Persistent role removal schedule failed",
    }).catch((rollbackError) => console.error(`Failed to roll back otebo roles: ${rollbackError.message}`, rollbackError));
    await transitionOteboRecruitment({
      guildId: guild.id,
      recruitmentId: recruitment.id,
      fromStatuses: ["success_notified"],
      toStatus: "failed",
      patch: { lastError: `Persistent role removal schedule failed: ${error.message}` },
    }).catch((statusError) => console.error(`Failed to persist otebo failure state: ${statusError.message}`));
    return false;
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

  let nextSettings;
  try {
    nextSettings = await saveGuildSettingsWithCurrent(guild.id, settings, {
      oteboRecruitments: recruitments,
      oteboVoiceStatusSessions: voiceStatusSessions,
    });
  } catch (error) {
    await transitionOteboRecruitment({
      guildId: guild.id,
      recruitmentId: recruitment.id,
      fromStatuses: ["success_notified"],
      toStatus: "cleanup_pending",
      patch: { lastError: `Otebo completion persistence failed after notification: ${error.message}` },
    }).catch((statusError) => console.error(`Failed to persist otebo cleanup-pending state: ${statusError.message}`));
    throw error;
  }
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
  } finally {
    await releaseMongoLease(successLease).catch((error) => {
      console.error(`Failed to release otebo success lease for ${guild.id}:${recruitment.id}: ${error.message}`);
    });
  }
}

async function deleteOteboRecruitmentMessage(guild, recruitment) {
  await deleteCallWaitMessage(guild, {
    channelId: recruitment.channelId,
    messageId: recruitment.messageId,
  });
}

async function addTemporaryRoleToMembers({ guild, roleId, memberIds, reason, sourceType = "otebo", sourceId }) {
  const roleMemberIds = [];
  const grantedMemberIds = [];

  for (const memberId of normalizeCallWaitMemberIds(memberIds)) {
    const member = await guild.members.fetch(memberId).catch(() => null);

    if (!member || member.user?.bot) {
      continue;
    }

    if (member.roles.cache.has(roleId)) {
      roleMemberIds.push(member.id);
      continue;
    }

    try {
      await member.roles.add(roleId, reason);
      await VoiceParticipantRoleGrant.updateOne(
        {
          guildId: guild.id,
          memberId: member.id,
          roleId,
          sourceType,
          sourceId: sourceId ?? "unknown",
        },
        {
          $set: {
            grantedByBot: true,
            grantedAt: new Date(),
            status: "active",
            removedAt: null,
            cleanupAt: null,
          },
          $setOnInsert: {
            guildId: guild.id,
            memberId: member.id,
            roleId,
            sourceType,
            sourceId: sourceId ?? "unknown",
          },
        },
        { upsert: true },
      );
      roleMemberIds.push(member.id);
      grantedMemberIds.push(member.id);
    } catch (error) {
      await member.roles.remove(roleId, "Rollback untracked temporary role").catch((rollbackError) => {
        console.error(`Failed to roll back temporary role for ${member.id}: ${rollbackError.message}`);
      });
      console.error(`Failed to add temporary call role to ${member.id}: ${error.message}`);
    }
  }

  return { memberIds: roleMemberIds, grantedMemberIds };
}

async function scheduleOteboRoleRemoval({ guild, roleId, memberIds, recruitmentId }) {
  const normalizedIds = normalizeCallWaitMemberIds(memberIds);
  const actionKey = `otebo-role-remove:${guild.id}:${recruitmentId ?? roleId}`;
  await schedulePersistentRoleRemoval({
    actionKey,
    type: "otebo_role_remove",
    guild,
    roleId,
    memberIds: normalizedIds,
    delayMs: OTEBO_ROLE_REMOVE_MS,
    timers: oteboRecruitmentTimers,
    payload: { sourceType: "otebo", sourceId: recruitmentId ?? "unknown" },
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

async function removeTemporaryRoleFromMembers({ guild, roleId, memberIds, reason, sourceType = "otebo", sourceId }) {
  const errors = [];
  for (const memberId of normalizeCallWaitMemberIds(memberIds)) {
    const member = await guild.members.fetch(memberId).catch(() => null);

    if (!member) {
      continue;
    }

    await removeVoiceParticipantRole(member, roleId, {
      sourceType,
      sourceId: sourceId ?? "unknown",
    }).catch((error) => {
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

function formatKokuchiMessage({ weekday, overviewChannelId }) {
  const eventTime = normalizeKokuchiEventTime(arguments[0]?.eventTime) ?? "21:00";
  const weekdayLabel = weekday === "土" ? "土曜日" : "火曜日";
  const lines = [
    `本日は${weekdayLabel}！`,
    `${normalizeKokuchiEventTime(eventTime) ?? "21:00"}から会話練習会です！`,
    `（概要は <#${overviewChannelId}> から）`,
  ];

  lines.push(
    "",
    "ただ雑談したい方はもちろん、少しずつ会話に慣れていきたいという方にも参加していただきたいです！",
    "時間の都合が合う方はぜひご参加ください！！",
  );

  return lines.join("\n");
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
  const senderMention = `<@${interaction.user.id}>`;
  const moderatorMention =
    type === "complaint" && settings.formModeratorRoleId
      ? `<@&${settings.formModeratorRoleId}>`
      : null;

  await sendChannel.send({
    content: [
      moderatorMention,
      `送信者:${senderMention}`,
      `分類:${label}`,
      `内容:${content}`,
    ].filter(Boolean).join("\n"),
    allowedMentions: {
      parse: [],
      users: [],
      roles: moderatorMention ? [settings.formModeratorRoleId] : [],
    },
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
      content: "会話練習会の話題ボタンに使えるような話題があればぜひ送ってください！",
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
  const channelChanged = oldState.channelId !== newState.channelId;
  // Mute/deafen/stream/camera changes are not joins or leaves.
  if (!channelChanged) return;
  const changedChannelIds = new Set();

  await maybeSendPendingCallWaitStartNotice(guild, settings).catch((error) => logRecoverableError("Pending call-wait notice failed", error));
  await processOteboVoiceStatusSessions(guild, settings).catch((error) => logRecoverableError("Otebo voice status processing failed", error));

  if (oldState.channelId) {
    changedChannelIds.add(oldState.channelId);
  }

  if (newState.channelId) {
    changedChannelIds.add(newState.channelId);
    const waitingSession = await SplitProcessSession.findOne({
      guildId: guild.id,
      status: "active",
      waitingChannelId: newState.channelId,
      waitingMonitorStatus: { $in: ["active", "extended"] },
    }).lean().catch(() => null);
    if (waitingSession && !localWaitingMonitorSessions.has(waitingSession.sessionId)) {
      startRestoredWaitingMonitor(waitingSession, guild);
    }
  }

  const monitoredChannelIds = [];

  for (const channelId of changedChannelIds) {
    if (await isVoiceChannelMonitored(guild, settings, channelId)) {
      monitoredChannelIds.push(channelId);
    }

    await maybeSendAutoSplitSuggestion(guild, settings, channelId).catch((error) => {
      logRecoverableError("Auto split suggestion processing failed", error);
    });
  }

  if (monitoredChannelIds.length > 0 && settings?.voiceReminderEnabled !== false) {
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
    const memberId = oldState.member.id;
    await queueVoiceParticipantRoleUpdate(guild.id, memberId, async () => {
      const member = await guild.members.fetch(memberId).catch(() => null);
      if (!member) return;
      const ignoredSessionKey = getVoiceMonitorSessionKey(guild.id, oldState.channelId);
      const participantRoleId = voiceMonitorSessions.get(ignoredSessionKey)?.participantRoleId ?? settings.voiceParticipantRoleId;
        await removeVoiceParticipantRole(member, participantRoleId, {
          sourceType: "voice_monitor",
          sourceId: ignoredSessionKey,
        });
    });
  }
}

function queueVoiceParticipantRoleUpdate(guildId, memberId, task) {
  const key = `${guildId}:${memberId}`;
  const previous = voiceParticipantRoleQueues.get(key) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(task);
  voiceParticipantRoleQueues.set(key, next);
  return next.finally(() => {
    if (voiceParticipantRoleQueues.get(key) === next) voiceParticipantRoleQueues.delete(key);
  });
}

async function isMemberCurrentlyInMonitoredVoiceChannel(guild, settings, member) {
  const channelId = member?.voice?.channelId;
  if (!channelId || settings?.voiceReminderEnabled === false) return false;
  const channel = member.voice.channel ?? await guild.channels.fetch(channelId).catch(() => null);
  return Boolean(channel?.isVoiceBased() && getNonBotVoiceMembers(channel).length >= VOICE_MONITOR_MIN_MEMBERS && await isVoiceChannelMonitored(guild, settings, channelId));
}

function getVoiceMonitorRoleRetryKey({ guildId, memberId, roleId, sourceId }) {
  return `${guildId}:${memberId}:${roleId}:${sourceId}`;
}

function clearVoiceMonitorRoleRetryState({ guildId, memberId, roleId, sourceId }) {
  const key = getVoiceMonitorRoleRetryKey({ guildId, memberId, roleId, sourceId });
  const timer = voiceParticipantRoleRetryTimers.get(key);
  if (timer) clearTimeout(timer);
  voiceParticipantRoleRetryTimers.delete(key);
  clearVoiceMonitorFinalFailureLogs({ guildId, memberId, roleId, sourceId });
}

function isDiscordUnknownMemberError(error) {
  return error?.code === 10007 || error?.rawError?.code === 10007;
}

function getVoiceMonitorRetryOperation(grant) {
  return grant?.status === "removing" ? "解除" : "付与";
}

async function markExactVoiceMonitorGrantRemoved({ guildId, memberId, roleId, sourceId }) {
  const removedAt = new Date();
  await VoiceParticipantRoleGrant.updateOne(
    { guildId, memberId, roleId, sourceType: "voice_monitor", sourceId },
    {
      $set: {
        status: "removed",
        removedAt,
        cleanupAt: new Date(removedAt.getTime() + 30 * 24 * 60 * 60 * 1000),
        retryCount: 0,
        nextRetryAt: null,
        lastError: null,
      },
    },
  );
  clearVoiceMonitorRoleRetryState({ guildId, memberId, roleId, sourceId });
}

async function recordVoiceMonitorRoleFailure({ guild, memberId, roleId, sourceId, operation, error, isRetryAttempt = false, ownershipConfirmed }) {
  const now = new Date();
  const filter = { guildId: guild.id, memberId, roleId, sourceType: "voice_monitor", sourceId };
  const existing = await VoiceParticipantRoleGrant.findOne(filter).lean().catch((persistenceError) => {
    logRecoverableError("Failed to read voice participant role failure state", persistenceError);
    return null;
  });
  const isRetryFailure = isRetryAttempt
    && existing?.status === "failed"
    && Number.isInteger(existing?.retryCount);
  // retryCount represents the number of failed retry attempts.  A normal
  // first failure is 0, then retry failures are 1, 2, and the final 3.
  const retryCount = isRetryFailure
    ? Math.min(existing.retryCount + 1, VOICE_PARTICIPANT_ROLE_MAX_RETRIES)
    : 0;
  if (!isRetryFailure) {
    clearVoiceMonitorFinalFailureLogs({ guildId: guild.id, memberId, roleId, sourceId });
    const retryTimerKey = getVoiceMonitorRoleRetryKey({ guildId: guild.id, memberId, roleId, sourceId });
    const pendingTimer = voiceParticipantRoleRetryTimers.get(retryTimerKey);
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      voiceParticipantRoleRetryTimers.delete(retryTimerKey);
    }
  }
  const failureState = {
    status: "failed",
    lastError: error?.message ?? String(error),
    removedAt: null,
    cleanupAt: null,
    retryCount,
    nextRetryAt: null,
  };
  // Never downgrade an already-confirmed bot ownership record merely because
  // this caller could not determine ownership.  A false value is only used
  // for a newly-created failure record.
  if (ownershipConfirmed === true) failureState.grantedByBot = true;
  const result = await VoiceParticipantRoleGrant.findOneAndUpdate(
    filter,
    {
      $set: failureState,
      $setOnInsert: { guildId: guild.id, memberId, roleId, grantedByBot: ownershipConfirmed === true, sourceType: "voice_monitor", sourceId },
    },
    { upsert: true, new: true },
  ).catch((persistenceError) => {
    logRecoverableError("Failed to persist voice participant role failure", persistenceError);
    return null;
  });
  if (!result) return;
  if (result.retryCount >= VOICE_PARTICIPANT_ROLE_MAX_RETRIES) {
    await sendVoiceMonitorFinalFailureLog({ guild, memberId, roleId, sourceId, operation, retryCount: VOICE_PARTICIPANT_ROLE_MAX_RETRIES, error: result.lastError });
    return;
  }
  const delayMs = VOICE_PARTICIPANT_ROLE_RETRY_DELAYS_MS[result.retryCount];
  const retryAt = new Date(now.getTime() + delayMs);
  await VoiceParticipantRoleGrant.updateOne({ _id: result._id }, { $set: { nextRetryAt: retryAt } }).catch(() => {});
  const key = getVoiceMonitorRoleRetryKey({ guildId: guild.id, memberId, roleId, sourceId });
  if (voiceParticipantRoleRetryTimers.has(key)) return;
  const timer = setTimeout(() => {
    voiceParticipantRoleRetryTimers.delete(key);
    void queueVoiceParticipantRoleUpdate(guild.id, memberId, () => retryVoiceMonitorRoleGrant({ guildId: guild.id, memberId, roleId, sourceId })).catch((retryError) => {
      logRecoverableError("Voice participant role retry failed", retryError);
    });
  }, delayMs);
  voiceParticipantRoleRetryTimers.set(key, timer);
}

function getVoiceMonitorFinalFailureLogKey({ guildId, memberId, roleId, sourceId, operation, retryCount }) {
  return `${guildId}:${memberId}:${roleId}:${sourceId}:${operation}:${retryCount}`;
}

function clearVoiceMonitorFinalFailureLogs({ guildId, memberId, roleId, sourceId }) {
  const prefix = `${guildId}:${memberId}:${roleId}:${sourceId}:`;
  for (const key of voiceParticipantRoleFinalFailureLogs) {
    if (key.startsWith(prefix)) voiceParticipantRoleFinalFailureLogs.delete(key);
  }
}

async function sendVoiceMonitorFinalFailureLog({ guild, memberId, roleId, sourceId, operation, retryCount, error }) {
  if (retryCount < VOICE_PARTICIPANT_ROLE_MAX_RETRIES) return;
  const key = getVoiceMonitorFinalFailureLogKey({ guildId: guild.id, memberId, roleId, sourceId, operation, retryCount });
  if (voiceParticipantRoleFinalFailureLogs.has(key)) return;
  const settings = await getGuildSettings(guild.id).catch(() => null);
  const sent = await sendOperationalLog({
    guild,
    settings,
    fallbackChannel: null,
    content: `雑談中ロールの${retryCount >= VOICE_PARTICIPANT_ROLE_MAX_RETRIES ? "最終失敗" : "処理不能"}: guildId=${guild.id} memberId=${memberId} roleId=${roleId} sourceId=${sourceId} 操作=${operation ?? "不明"} retryCount=${retryCount} error=${error ?? "不明"}`,
  }).catch((logError) => logRecoverableError("Failed to send voice monitor final failure log", logError));
  if (sent) voiceParticipantRoleFinalFailureLogs.add(key);
}

async function sendVoiceMonitorOperationalFailureLog({ guild, memberId, roleId, sourceId, operation, stage = null, error }) {
  const settings = await getGuildSettings(guild.id).catch(() => null);
  await sendOperationalLog({
    guild,
    settings,
    fallbackChannel: null,
    content: `雑談中ロールの処理失敗: guildId=${guild.id} memberId=${memberId} roleId=${roleId} sourceId=${sourceId} 操作=${operation}${stage ? ` stage=${stage}` : ""} error=${error ?? "不明"}`,
  }).catch((logError) => logRecoverableError("Failed to send voice monitor operational failure log", logError));
}

async function retryVoiceMonitorRoleGrant({ guildId, memberId, roleId, sourceId }) {
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return;
  const grant = await VoiceParticipantRoleGrant.findOne({ guildId, memberId, roleId, sourceType: "voice_monitor", sourceId }).lean().catch(() => null);
  if (!grant) {
    clearVoiceMonitorRoleRetryState({ guildId, memberId, roleId, sourceId });
    return;
  }
  let settings;
  try {
    settings = await getGuildSettings(guildId);
  } catch (error) {
    await recordVoiceMonitorRoleFailure({
      guild,
      memberId,
      roleId,
      sourceId,
      operation: "状態取得",
      error,
      isRetryAttempt: true,
      ownershipConfirmed: grant.grantedByBot === true,
    });
    return;
  }
  let member;
  try {
    member = await guild.members.fetch(memberId);
  } catch (error) {
    if (isDiscordUnknownMemberError(error)) {
      await markExactVoiceMonitorGrantRemoved({ guildId, memberId, roleId, sourceId }).catch((persistenceError) => {
        logRecoverableError("Failed to retire departed member voice participant role grant", persistenceError);
      });
      return;
    }
    await recordVoiceMonitorRoleFailure({
      guild,
      memberId,
      roleId,
      sourceId,
      operation: getVoiceMonitorRetryOperation(grant),
      error,
      isRetryAttempt: true,
      ownershipConfirmed: grant.grantedByBot === true,
    });
    return;
  }
  const channelId = sourceId.split(":").at(-1);
  let shouldHaveRole;
  try {
    shouldHaveRole = settings?.voiceReminderEnabled !== false
      && member.voice?.channelId === channelId
      && await isMemberCurrentlyInMonitoredVoiceChannel(guild, settings, member);
  } catch (error) {
    await recordVoiceMonitorRoleFailure({
      guild,
      memberId,
      roleId,
      sourceId,
      operation: "状態取得",
      error,
      isRetryAttempt: true,
      ownershipConfirmed: grant.grantedByBot === true,
    });
    return;
  }
  if (!shouldHaveRole) {
    // A failed add that was rolled back never established bot ownership, so
    // an inactive source can be retired without a Discord role API call.
    if (grant.grantedByBot !== true) {
      await markExactVoiceMonitorGrantRemoved({ guildId, memberId, roleId, sourceId }).catch((error) => {
        logRecoverableError("Failed to retire unowned voice participant role failure", error);
      });
      return;
    }
    await removeVoiceParticipantRole(member, roleId, { sourceType: "voice_monitor", sourceId, isRetryAttempt: true });
    return;
  }

  const role = await guild.roles.fetch(roleId).catch(() => null);
  if (!role) {
    await recordVoiceMonitorRoleFailure({ guild, memberId, roleId, sourceId, operation: "付与", error: new Error("参加者ロールが見つかりません"), isRetryAttempt: true, ownershipConfirmed: grant.grantedByBot === true });
    return;
  }
  const roleValidationError = await validateVoiceParticipantRole(guild, role);
  if (roleValidationError) {
    await recordVoiceMonitorRoleFailure({ guild, memberId, roleId, sourceId, operation: "付与", error: new Error(roleValidationError), isRetryAttempt: true, ownershipConfirmed: grant.grantedByBot === true });
    return;
  }

  const hadRole = member.roles.cache.has(role.id);
  // A retry record created by a failed add does not establish ownership of a
  // role that someone assigned manually while the retry was waiting.
  if (hadRole && grant?.grantedByBot !== true) {
    await markExactVoiceMonitorGrantRemoved({ guildId, memberId, roleId, sourceId }).catch((error) => logRecoverableError("Failed to clear manual participant role retry", error));
    return;
  }
  try {
    if (!hadRole) await member.roles.add(role, "VC参加者ロールの再試行付与");
    await VoiceParticipantRoleGrant.updateOne(
      { guildId, memberId, roleId, sourceType: "voice_monitor", sourceId },
      {
        $set: {
          grantedByBot: true,
          grantedAt: new Date(),
          status: "active",
          removedAt: null,
          cleanupAt: null,
          retryCount: 0,
          nextRetryAt: null,
          lastError: null,
        },
        $setOnInsert: { guildId, memberId, roleId, sourceType: "voice_monitor", sourceId },
      },
      { upsert: true },
    );
    clearVoiceMonitorRoleRetryState({ guildId, memberId, roleId, sourceId });
  } catch (error) {
    let rollbackFailed = false;
    if (!hadRole) {
      try {
        await member.roles.remove(role, "VC参加者ロール再試行の記録失敗に伴うロール解除");
      } catch (rollbackError) {
        rollbackFailed = true;
        logRecoverableError(`Failed to roll back retried participant role for ${memberId}`, rollbackError);
      }
    }
    await recordVoiceMonitorRoleFailure({ guild, memberId, roleId, sourceId, operation: "付与", error, isRetryAttempt: true, ownershipConfirmed: hadRole || rollbackFailed });
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

  if (Array.isArray(settings?.voiceMonitorVoiceChannelIds) && settings.voiceMonitorVoiceChannelIds.includes(channelId)) {
    return true;
  }
  // Do not treat every VC in a category as monitored. PB child channels are
  // eligible only while they are recorded by an active split session.
  return Boolean(await SplitProcessSession.exists({
    guildId: guild.id,
    status: "active",
    childChannelIds: channelId,
  }).catch(() => null));
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
    await sendVoiceMonitorStartNotice(voiceChannel, settings).catch((error) => {
      logRecoverableError("Voice monitor start notice failed", error);
    });
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
      // Disabling the feature stops new sessions but still cleans up the
      // voice_monitor grants the bot already owns.
      if (settings.voiceReminderEnabled === false) {
        await reconcilePersistedVoiceParticipantRoleGrants(guild, settings);
        continue;
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

async function isPersistedVoiceMonitorGrantInCurrentContext(guild, settings, member, grant) {
  if (
    grant.guildId !== guild.id ||
    grant.sourceType !== "voice_monitor" ||
    settings?.voiceReminderEnabled === false ||
    grant.roleId !== settings?.voiceParticipantRoleId ||
    member?.guild?.id !== guild.id
  ) {
    return false;
  }

  const sourcePrefix = `${guild.id}:`;
  if (typeof grant.sourceId !== "string" || !grant.sourceId.startsWith(sourcePrefix)) {
    return false;
  }

  const channelId = grant.sourceId.slice(sourcePrefix.length);
  if (
    !channelId ||
    channelId.includes(":") ||
    grant.sourceId !== getVoiceMonitorSessionKey(guild.id, channelId) ||
    member.voice?.channelId !== channelId
  ) {
    return false;
  }

  try {
    const voiceChannel =
      guild.channels.cache.get(channelId) ??
      (await guild.channels.fetch(channelId).catch(() => null));
    if (!voiceChannel?.isVoiceBased()) {
      return false;
    }

    return (
      await isVoiceChannelMonitored(guild, settings, channelId)
    ) && getNonBotVoiceMembers(voiceChannel).length >= VOICE_MONITOR_MIN_MEMBERS;
  } catch {
    return false;
  }
}

async function reconcilePersistedVoiceParticipantRoleGrants(guild, settings) {
  const grants = await VoiceParticipantRoleGrant.find({ guildId: guild.id, sourceType: "voice_monitor", status: { $in: [null, "active", "removing", "failed"] } }).lean();

  for (const grant of grants) {
    const logStartupFailure = async (stage, error) => sendVoiceMonitorOperationalFailureLog({
      guild,
      memberId: grant.memberId,
      roleId: grant.roleId,
      sourceId: grant.sourceId,
      operation: "起動時整合",
      stage,
      error: error?.message ?? String(error),
    });

    try {
      let member;
      try {
        member = await guild.members.fetch(grant.memberId);
      } catch (error) {
        if (isDiscordUnknownMemberError(error)) {
          try {
            await markExactVoiceMonitorGrantRemoved({ guildId: guild.id, memberId: grant.memberId, roleId: grant.roleId, sourceId: grant.sourceId });
          } catch (persistenceError) {
            await logStartupFailure("DB不明メンバー解除", persistenceError);
          }
          continue;
        }
        await recordVoiceMonitorRoleFailure({
          guild,
          memberId: grant.memberId,
          roleId: grant.roleId,
          sourceId: grant.sourceId,
          operation: getVoiceMonitorRetryOperation(grant),
          error,
          isRetryAttempt: grant.status === "failed",
          ownershipConfirmed: true,
        });
        await logStartupFailure("メンバー取得", error);
        continue;
      }

      const shouldKeepGrant = await isPersistedVoiceMonitorGrantInCurrentContext(
        guild,
        settings,
        member,
        grant,
      );

      if (grant.grantedByBot !== true) {
        try {
          if (shouldKeepGrant) {
            await recordVoiceMonitorRoleFailure({
              guild,
              memberId: grant.memberId,
              roleId: grant.roleId,
              sourceId: grant.sourceId,
              operation: "付与",
              error: new Error("起動時整合で未所有の付与失敗記録を再試行"),
              ownershipConfirmed: false,
            });
          } else {
            await markExactVoiceMonitorGrantRemoved({ guildId: guild.id, memberId: grant.memberId, roleId: grant.roleId, sourceId: grant.sourceId });
          }
        } catch (error) {
          await logStartupFailure(shouldKeepGrant ? "未所有記録再試行登録" : "DB未所有記録解除", error);
        }
        continue;
      }

      if (!shouldKeepGrant) {
        try {
          await removeVoiceParticipantRole(member, grant.roleId, {
            sourceType: grant.sourceType,
            sourceId: grant.sourceId,
          });
        } catch (error) {
          await logStartupFailure("ロール解除", error);
        }
        continue;
      }

      try {
        await VoiceParticipantRoleGrant.updateOne(
          { _id: grant._id },
          { $set: { status: "active", removedAt: null, cleanupAt: null, retryCount: 0, nextRetryAt: null, lastError: null } },
        );
        clearVoiceMonitorRoleRetryState({ guildId: guild.id, memberId: grant.memberId, roleId: grant.roleId, sourceId: grant.sourceId });
      } catch (error) {
        await logStartupFailure("DB有効化", error);
      }
    } catch (error) {
      await logStartupFailure("予期しない整合処理", error);
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
    console.warn(`Voice participant role is missing guild=${voiceChannel.guild.id} role=${session.participantRoleId}`);
    await sendVoiceMonitorOperationalFailureLog({ guild: voiceChannel.guild, memberId: "-", roleId: session.participantRoleId, sourceId: getVoiceMonitorSessionKey(session.guildId, session.voiceChannelId), operation: "設定検証", error: "参加者ロールが見つかりません" });
    return;
  }

  const roleValidationError = await validateVoiceParticipantRole(voiceChannel.guild, role);
  if (roleValidationError) {
    console.warn(`Voice participant role is not usable guild=${voiceChannel.guild.id}: ${roleValidationError}`);
    await sendVoiceMonitorOperationalFailureLog({ guild: voiceChannel.guild, memberId: "-", roleId: role.id, sourceId: getVoiceMonitorSessionKey(session.guildId, session.voiceChannelId), operation: "設定検証", error: roleValidationError });
    return;
  }

  for (const member of members) {
    await queueVoiceParticipantRoleUpdate(voiceChannel.guild.id, member.id, async () => {
      const currentMember = await voiceChannel.guild.members.fetch(member.id).catch(() => null);
      if (!currentMember || currentMember.voice.channelId !== voiceChannel.id) return;
      if (getNonBotVoiceMembers(voiceChannel).length < VOICE_MONITOR_MIN_MEMBERS) return;
      const hadRole = currentMember.roles.cache.has(role.id);
      // Do not claim a manually assigned role. A role already owned by this
      // bot for another active source may safely gain this session's record.
      const hasBotOwnedGrant = hadRole && await VoiceParticipantRoleGrant.exists({
        guildId: voiceChannel.guild.id,
        memberId: member.id,
        roleId: role.id,
        grantedByBot: true,
        status: { $in: [null, "active", "removing", "failed"] },
      });
      if (hadRole && !hasBotOwnedGrant) {
        // The member acquired this role outside a bot-owned active grant.
        // Retire only this stale failed record and leave the manual role alone.
        await markExactVoiceMonitorGrantRemoved({
          guildId: voiceChannel.guild.id,
          memberId: member.id,
          roleId: role.id,
          sourceId: getVoiceMonitorSessionKey(session.guildId, session.voiceChannelId),
        }).catch((error) => logRecoverableError("Failed to retire manual voice participant role record", error));
        return;
      }
    if (!hadRole) {
      try {
        await member.roles.add(role, "VC参加者ロールを付与");
        try {
          await VoiceParticipantRoleGrant.updateOne(
            {
              guildId: voiceChannel.guild.id,
              memberId: member.id,
              roleId: role.id,
              sourceType: "voice_monitor",
              sourceId: getVoiceMonitorSessionKey(session.guildId, session.voiceChannelId),
            },
            {
              $set: {
                sourceType: "voice_monitor",
                sourceId: getVoiceMonitorSessionKey(session.guildId, session.voiceChannelId),
                grantedByBot: true,
                grantedAt: new Date(),
                status: "active",
                removedAt: null,
                cleanupAt: null,
              },
              $setOnInsert: { guildId: voiceChannel.guild.id, memberId: member.id, roleId: role.id },
            },
            { upsert: true },
          );
        } catch (error) {
          // A grant without a durable ownership record cannot be reconciled
          // after a restart, so roll it back instead of leaving it untracked.
          let rollbackFailed = false;
          try {
            await member.roles.remove(role, "VC参加者ロール記録の保存失敗に伴うロール解除");
          } catch (rollbackError) {
            rollbackFailed = true;
            logRecoverableError(`Failed to roll back participant role for ${member.id}`, rollbackError);
          }
          console.error(`Failed to persist voice participant role grant for ${member.id}: ${error.message}`);
          await recordVoiceMonitorRoleFailure({ guild: voiceChannel.guild, memberId: member.id, roleId: role.id, sourceId: getVoiceMonitorSessionKey(session.guildId, session.voiceChannelId), operation: "付与", error, ownershipConfirmed: rollbackFailed });
          return;
        }
      } catch (error) {
        console.error(`Failed to add voice participant role to ${member.id}: ${error.message}`);
        await recordVoiceMonitorRoleFailure({ guild: voiceChannel.guild, memberId: member.id, roleId: role.id, sourceId: getVoiceMonitorSessionKey(session.guildId, session.voiceChannelId), operation: "付与", error, ownershipConfirmed: false });
        return;
      }
    }
    // A member moving directly between monitored VCs already has the role,
    // but still needs an ownership record for this session.
    if (!hadRole || hasBotOwnedGrant) {
      const sourceId = getVoiceMonitorSessionKey(session.guildId, session.voiceChannelId);
      await VoiceParticipantRoleGrant.updateOne(
        { guildId: voiceChannel.guild.id, memberId: member.id, roleId: role.id, sourceType: "voice_monitor", sourceId },
        { $set: { sourceType: "voice_monitor", sourceId, grantedByBot: true, grantedAt: new Date(), status: "active", removedAt: null, cleanupAt: null, retryCount: 0, nextRetryAt: null, lastError: null }, $setOnInsert: { guildId: voiceChannel.guild.id, memberId: member.id, roleId: role.id } },
        { upsert: true },
      );
      clearVoiceMonitorRoleRetryState({ guildId: voiceChannel.guild.id, memberId: member.id, roleId: role.id, sourceId });
    }
    });
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

      await removeVoiceParticipantRole(member, participantRoleId, {
        sourceType: "voice_monitor",
        sourceId: sessionKey,
      });
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

  const autoSplitLockKey = `auto-split:${guild.id}:${voiceChannel.id}`;
  if (autoSplitLocks.has(autoSplitLockKey)) {
    await interaction.editReply({ content: "このVCでは、すでに自動分割を処理中です。", components: [] });
    return;
  }
  autoSplitLocks.add(autoSplitLockKey);
  const autoSplitLease = await acquireMongoLease(autoSplitLockKey, { leaseMs: 5 * 60 * 1000 })
    .catch((error) => {
      autoSplitLocks.delete(autoSplitLockKey);
      throw error;
    });
  if (!autoSplitLease) {
    autoSplitLocks.delete(autoSplitLockKey);
    await interaction.editReply({ content: "このVCでは、別のBotプロセスが自動分割を処理中です。", components: [] });
    return;
  }

  try {
  const [stayGroup, moveGroup] = splitIntoTwoRandomGroups(members);
  const roleGrantSourceId = `auto-split:${createSessionId()}`;

  const transferResult = await transferMembersToPbChildChannel(moveGroup, {
    guild,
    parentChannel,
    childCategoryId: settings.childCategoryId,
    participantRole,
    sourceChannelId: voiceChannel.id,
    roleGrantSourceId,
  });

  if (transferResult.participantRoleGrantedMemberIds.length > 0) {
    try {
      await schedulePersistentRoleRemoval({
        actionKey: `auto-split-role-remove:${guild.id}:${roleGrantSourceId}`,
        type: "auto_split_role_remove",
        guild,
        roleId: participantRole.id,
        memberIds: transferResult.participantRoleGrantedMemberIds,
        delayMs: minutesToMs(getNonNegativeInteger(
          settings?.roleRemoveWaitMinutes,
          DEFAULT_ROLE_REMOVE_WAIT_MINUTES,
        )),
        timers: callWaitRoleRemovalTimers,
        payload: { sourceType: "auto_split", sourceId: roleGrantSourceId },
      });
    } catch (error) {
      await removeCallWaitRoleFromMembers(
        guild,
        participantRole.id,
        transferResult.participantRoleGrantedMemberIds,
        { sourceType: "auto_split", sourceId: roleGrantSourceId },
      ).catch((rollbackError) => {
        console.error(`Failed to roll back auto-split participant roles: ${rollbackError.message}`);
      });
      throw error;
    }
  }

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
  } finally {
    autoSplitLocks.delete(autoSplitLockKey);
    await releaseMongoLease(autoSplitLease).catch((error) => {
      console.error(`Failed to release auto-split lease for ${autoSplitLockKey}: ${error.message}`);
    });
  }
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
  const participantRoleGrantedMemberIds = new Set();

  const addRoleForTransfer = async (member) => {
    if (member.roles.cache.has(config.participantRole.id)) {
      participantMemberIds.add(member.id);
      return null;
    }

    try {
      await member.roles.add(config.participantRole, "Participant role for automatic voice grouping");
      try {
        await VoiceParticipantRoleGrant.updateOne(
          {
            guildId: config.guild.id,
            memberId: member.id,
            roleId: config.participantRole.id,
            sourceType: "auto_split",
            sourceId: config.roleGrantSourceId,
          },
          {
            $set: {
              grantedByBot: true,
              grantedAt: new Date(),
              status: "active",
              removedAt: null,
              cleanupAt: null,
            },
            $setOnInsert: {
              guildId: config.guild.id,
              memberId: member.id,
              roleId: config.participantRole.id,
              sourceType: "auto_split",
              sourceId: config.roleGrantSourceId,
            },
          },
          { upsert: true },
        );
      } catch (error) {
        await member.roles.remove(config.participantRole, "Rollback untracked automatic grouping role").catch((rollbackError) => {
          console.error(`Failed to roll back untracked automatic grouping role for ${member.id}: ${rollbackError.message}`);
        });
        throw error;
      }
      participantMemberIds.add(member.id);
      participantRoleGrantedMemberIds.add(member.id);
      return null;
    } catch (error) {
      console.error(`Failed to add automatic grouping role to ${member.id}: ${error.message}`);
      return member.displayName;
    }
  };

  const waitForPbChildChannel = async (member) => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < PB_CHILD_WAIT_MS) {
      const channel = member.voice.channel;
      const expectedCategoryId = config.childCategoryId ?? config.parentChannel.parentId;
      if (
        channel?.isVoiceBased?.()
        && channel.id !== config.parentChannel.id
        && channel.id !== config.sourceChannelId
        && (!expectedCategoryId || channel.parentId === expectedCategoryId)
      ) {
        return channel;
      }
      await sleep(750);
    }
    return null;
  };

  const rollbackGrantedRoles = async () => Promise.all(
    [...participantRoleGrantedMemberIds].map(async (memberId) => {
      const member = await config.guild.members.fetch(memberId).catch(() => null);
      if (!member) return;
      await removeVoiceParticipantRole(member, config.participantRole.id, {
        sourceType: "auto_split",
        sourceId: config.roleGrantSourceId,
      });
    }),
  );

  if (members.length === 0) {
    return { childChannel: null, failed: [], roleFailures, participantRoleGrantedMemberIds: [] };
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
  );

  if (seedRoleFailure) {
    roleFailures.push(seedRoleFailure);
  }

  const childChannel = await waitForPbChildChannel(seedMember);

  if (!childChannel) {
    await rollbackGrantedRoles();
    return { childChannel: null, failed: [seedMember.displayName], roleFailures, participantRoleGrantedMemberIds: [] };
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
    participantRoleGrantedMemberIds: [...participantRoleGrantedMemberIds],
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

async function removeVoiceParticipantRole(member, roleId, source = null) {
  const clearRetryState = () => {
    if (source?.sourceType === "voice_monitor" && source.sourceId) {
      clearVoiceMonitorRoleRetryState({
        guildId: member.guild.id,
        memberId: member.id,
        roleId,
        sourceId: source.sourceId,
      });
    }
  };
  const activeGrantStatuses = [null, "active", "removing", "failed"];
  const ownershipFilter = {
    guildId: member.guild.id,
    memberId: member.id,
    roleId,
    grantedByBot: true,
    status: { $in: activeGrantStatuses },
    ...(source?.sourceType ? { sourceType: source.sourceType } : {}),
    ...(source?.sourceId != null ? { sourceId: source.sourceId } : {}),
  };
  const grant = await VoiceParticipantRoleGrant.exists(ownershipFilter);

  // Only revoke a role that this bot recorded as its own grant.  The same
  // role may also be assigned manually or by another feature.
  if (!grant) {
    clearRetryState();
    return;
  }

  const marked = await VoiceParticipantRoleGrant.updateMany(ownershipFilter, {
    $set: {
      status: "removing",
      removedAt: null,
      cleanupAt: null,
    },
  });
  if (!marked || marked.matchedCount < 1) {
    clearRetryState();
    return;
  }

  const otherActiveGrant = source?.sourceType
    ? await VoiceParticipantRoleGrant.exists({
      guildId: member.guild.id,
      memberId: member.id,
      roleId,
      grantedByBot: true,
      status: { $in: activeGrantStatuses },
      $nor: [{
        sourceType: source.sourceType,
        ...(source.sourceId != null ? { sourceId: source.sourceId } : {}),
      }],
    })
    : false;

  const markRemoved = async () => {
    const removedAt = new Date();
    await VoiceParticipantRoleGrant.updateMany(
      { ...ownershipFilter, status: "removing" },
      {
        $set: {
          status: "removed",
          removedAt,
          cleanupAt: new Date(removedAt.getTime() + 30 * 24 * 60 * 60 * 1000),
          retryCount: 0,
          nextRetryAt: null,
          lastError: null,
        },
      },
    );
  };

  if (otherActiveGrant || !member.roles.cache.has(roleId)) {
    await markRemoved();
    clearRetryState();
    return;
  }

  try {
    await member.roles.remove(roleId, "VC離脱に伴う参加者ロール解除");
  } catch (error) {
    await VoiceParticipantRoleGrant.updateMany(
      {
        ...ownershipFilter,
        status: "removing",
      },
      { $set: { status: "failed", cleanupAt: null } },
    );
    if (source?.sourceType === "voice_monitor" && source.sourceId) {
      await recordVoiceMonitorRoleFailure({ guild: member.guild, memberId: member.id, roleId, sourceId: source.sourceId, operation: "解除", error, isRetryAttempt: source.isRetryAttempt === true, ownershipConfirmed: true });
    }
    throw error;
  }

  await markRemoved();
  clearRetryState();
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

  interaction = await deferCommandResponse(
    interaction,
    privateResult ? MessageFlags.Ephemeral : undefined,
  );

  const botMember = interaction.guild.members.me
    ?? await interaction.guild.members.fetch(interaction.client.user.id);
  const sourcePermissions = sourceChannel.permissionsFor(botMember);

  if (!sourcePermissions?.has(PermissionsBitField.Flags.ViewChannel)) {
    await interaction.editReply({
      content: "Botが対象のボイスチャンネルを見る権限を持っていません。",
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
  const splitLease = await acquireMongoLease(`splitvc:${interaction.guildId}`, {
    leaseMs: 5 * 60 * 1000,
  }).catch((error) => {
    splitVoiceGuildLocks.delete(interaction.guildId);
    throw error;
  });
  if (!splitLease) {
    splitVoiceGuildLocks.delete(interaction.guildId);
    await interaction.reply({
      content: "このサーバーでは、別のBotプロセスが /splitvc を処理中です。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  activeSplitVoiceLeases.set(interaction.guildId, splitLease);
  let splitLeaseReleased = false;
  const releaseSplitVoiceLock = () => {
    splitVoiceGuildLocks.delete(interaction.guildId);
    if (splitLeaseReleased) return;
    splitLeaseReleased = true;
    if (activeSplitVoiceLeases.get(interaction.guildId) === splitLease) {
      activeSplitVoiceLeases.delete(interaction.guildId);
    }
    void releaseMongoLease(splitLease).catch((error) => {
      console.error(`Failed to release splitvc lease for ${interaction.guildId}: ${error.message}`);
    });
  };

  const activeSplitSession = await SplitProcessSession.exists({
    guildId: interaction.guildId,
    status: { $in: ["active", "finish_notice_pending", "feedback_open", "role_remove_pending", "cleaning_up"] },
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
    await interaction.editReply({
      content: `${sourceChannel} に対象メンバーがいません。`,
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

  const childChannelIds = new Set();
  const participantMemberIds = new Set();
  const participantRoleGrantedMemberIds = new Set();
  const processState = { ended: false };
  let temporaryWaitingVc = null;
  let temporaryWaitingVcDeleteTimer = null;
  let splitStartMessage = null;
  const transferAt = new Date(Date.now() + transferWaitMs);

  // Persist the intent before displaying the cancellable countdown.  A
  // restart during this window can now restore or cancel the same session
  // instead of losing the planned transfer entirely.
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
    transferAt,
    plannedMemberIds: targetMembers.map((member) => member.id),
    finishMessage: settings?.finishMessage || DEFAULT_FINISH_MESSAGE,
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
      splitSessionId,
      parentChannel: config.parentChannel,
      childCategoryId: config.childCategoryId,
      participantRole: config.tempRole,
      sourceChannelId: sourceChannel.id,
      guild: interaction.guild,
      settings,
    });
    addMany(childChannelIds, transferResult.childChannelIds);
    addMany(participantMemberIds, transferResult.participantMemberIds);
    addMany(participantRoleGrantedMemberIds, transferResult.participantRoleGrantedMemberIds);

    if (transferResult.groupSummaries.length === 0) {
      const cleanupErrors = [];
      const source = await interaction.guild.channels.fetch(sourceChannel.id).catch((error) => {
        cleanupErrors.push(`source VC lookup: ${error.message}`);
        return null;
      });
      for (const memberId of participantMemberIds) {
        try {
          const member = await interaction.guild.members.fetch(memberId);
          if (source?.isVoiceBased?.() && member.voice.channelId !== source.id) {
            await member.voice.setChannel(source, "Rollback splitvc after every group transfer failed");
          }
        } catch (error) {
          cleanupErrors.push(`member ${memberId} rollback: ${error.message}`);
        }
      }
      try {
        const roleRemoval = await removeRoleFromMembers(
          interaction.guild,
          config.tempRole.id,
          [...participantRoleGrantedMemberIds],
          { sourceType: "splitvc", sourceId: splitSessionId },
        );
        if (roleRemoval.failed > 0) {
          cleanupErrors.push(`participant role rollback failed for ${roleRemoval.failed} member(s)`);
        }
      } catch (error) {
        cleanupErrors.push(`participant role rollback: ${error.message}`);
      }
      for (const channelId of childChannelIds) {
        try {
          const channel = await interaction.guild.channels.fetch(channelId);
          await channel.delete("Remove empty splitvc child after all transfers failed");
        } catch (error) {
          cleanupErrors.push(`child VC ${channelId} cleanup: ${error.message}`);
        }
      }
      const lastError = cleanupErrors.length > 0
        ? `No group was transferred successfully. Cleanup required: ${cleanupErrors.join(" | ")}`
        : "No group was transferred successfully.";
      await persistSplitProcessSession(splitSessionId, {
        status: cleanupErrors.length > 0 ? "cleanup_required" : "failed",
        phase: "failed",
        completedAt: new Date(),
        lastError,
      });
      releaseSplitVoiceLock();
      await operationChannel.send("グループ転送に成功したグループがないため、処理を終了しました。参加者ロールと作成済みVCは回収しました。");
      await sendOperationalLog({
        guild: interaction.guild,
        settings,
        fallbackChannel: operationChannel,
        content: `splitvcを失敗として終了しました。セッション: ${splitSessionId}。${lastError}`,
      });
      return;
    }

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
        participantRoleGrantedMemberIds: [...participantRoleGrantedMemberIds],
        childChannelIds: [...childChannelIds],
        groupSnapshots: transferResult.groupSummaries.map((summary, index) => ({
          groupNumber: summary.groupNumber ?? index + 1,
          channelId: summary.channelId,
          memberIds: summary.memberIds,
        })),
        conversationStartedAt: new Date(),
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
    } catch (error) {
      await removeRoleFromMembers(
        interaction.guild,
        config.tempRole.id,
        [...participantRoleGrantedMemberIds],
        { sourceType: "splitvc", sourceId: splitSessionId },
      ).catch((rollbackError) => {
        console.error(`Failed to roll back splitvc participant roles: ${rollbackError.message}`);
      });
      for (const channelId of childChannelIds) {
        const channel = await interaction.guild.channels.fetch(channelId).catch(() => null);
        await channel?.delete().catch((cleanupError) => logRecoverableError(`Failed to delete rolled-back splitvc child ${channelId}`, cleanupError));
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
        waitingMonitorStatus: "active",
        waitingMonitorStartedAt: new Date(),
        splitStartMessageChannelId: splitStartMessage?.channel?.id ?? operationChannel.id,
        splitStartMessageId: splitStartMessage?.id,
        waitingMonitorEndsAt: new Date(Date.now() + WAITING_ROOM_MONITOR_MS),
        waitingMonitorHeartbeatAt: new Date(),
        finishNoticeAt: new Date(Date.now() + noticeWaitMs),
        phase: "active",
      });
      await scheduleWaitingVcCleanup({
        actionKey: `split-waiting-vc-cleanup:${splitSessionId}`,
        guild: interaction.guild,
        channelId: temporaryWaitingVc.id,
        delayMs: noticeWaitMs,
        sessionId: splitSessionId,
      });

      temporaryWaitingVcDeleteTimer = setTimeout(async () => {

        try {
          const session = await SplitProcessSession.findOne({ sessionId: splitSessionId }).lean().catch(() => null);
          if (session?.status === "active" && ["active", "extended"].includes(session.waitingMonitorStatus)) {
            return;
          }

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
        participantRoleGrantedMemberIds,
        state: processState,
        settings,
        previousPairKeys: getPairKeysFromGroups(previousGroups),
        splitSessionId,
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
      roleGrantedMemberIds: participantRoleGrantedMemberIds,
      finishMessage: settings?.finishMessage || DEFAULT_FINISH_MESSAGE,
      noticeWaitMs,
      roleRemoveWaitMs,
      childChannelIds,
      state: processState,
      splitSessionId,
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

  // A modal is the initial interaction response.  Do not wait for MongoDB
  // here; startup restoration populates the short-lived edit-session cache.
  const session = bosyuEditSessions.get(interaction.message.id);

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

  async function moveMemberWithParticipantRole(
    member,
    targetChannel,
    reason,
    participantRole,
    participantMemberIds,
    participantRoleGrantedMemberIds = null,
    splitSessionId,
  ) {
    const alreadyHasRole = member.roles.cache.has(participantRole.id);
    if (!alreadyHasRole) {
      try {
        await member.roles.add(
          participantRole,
          "Participant role for voice grouping session",
        );
        await VoiceParticipantRoleGrant.updateOne(
          {
            guildId: member.guild.id,
            memberId: member.id,
            roleId: participantRole.id,
            sourceType: "splitvc",
            sourceId: splitSessionId,
          },
          {
            $set: {
              sourceType: "splitvc",
              sourceId: splitSessionId,
              grantedByBot: true,
              grantedAt: new Date(),
              status: "active",
              removedAt: null,
              cleanupAt: null,
            },
            $setOnInsert: {
              guildId: member.guild.id,
              memberId: member.id,
              roleId: participantRole.id,
            },
          },
          { upsert: true },
        );
        participantRoleGrantedMemberIds?.add(member.id);
      } catch (error) {
        await member.roles.remove(
          participantRole,
          "Rollback untracked participant role grant",
        ).catch((rollbackError) => {
          console.error(`Failed to rollback participant role for ${member.id}: ${rollbackError.message}`);
        });
        participantRoleGrantedMemberIds?.delete(member.id);
        console.error(`Failed to persist split participant role grant for ${member.id}: ${error.message}`);
        return { moved: false, reason: "role_grant_failed", memberName: member.displayName };
      }
    }

    try {
      await member.voice.setChannel(targetChannel, reason);
    } catch (error) {
      if (!alreadyHasRole) {
        await member.roles.remove(
          participantRole,
          "Revert participant role because voice transfer failed",
        ).catch((rollbackError) => {
          console.error(
            `Failed to revert participant role for ${member.id}: ${rollbackError.message}`,
          );
        });
        await VoiceParticipantRoleGrant.updateOne(
          {
            guildId: member.guild.id,
            memberId: member.id,
            roleId: participantRole.id,
            sourceType: "splitvc",
            sourceId: splitSessionId,
            status: "active",
          },
          { $set: { status: "removed", removedAt: new Date(), cleanupAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) } },
        ).catch((rollbackError) => {
          console.error(`Failed to record split participant role rollback for ${member.id}: ${rollbackError.message}`);
        });
        participantRoleGrantedMemberIds?.delete(member.id);
      }
      throw error;
    }

    participantMemberIds.add(member.id);
    return { moved: true, reason: null, memberName: member.displayName, roleGranted: !alreadyHasRole };
  }

  async function transferGroups(groups, config) {
    const lines = [];
    const childChannelIds = new Set();
    const participantMemberIds = new Set();
    const participantRoleGrantedMemberIds = new Set();
    const groupSummaries = [];

    for (const [index, group] of groups.entries()) {
      const groupNumber = index + 1;
      const seedMember = group[0];

      if (!seedMember?.voice?.channelId) {
        lines.push(`グループ ${groupNumber}: 代表メンバーがVCにいないため転送できませんでした。`);
        continue;
      }

      try {
        const roleFailures = [];
        const seedHadParticipantRole = seedMember.roles.cache.has(config.participantRole.id);
        const seedTransfer = await moveMemberWithParticipantRole(
          seedMember,
          config.parentChannel,
          "Move one group member to PB parent channel",
          config.participantRole,
          participantMemberIds,
          participantRoleGrantedMemberIds,
          config.splitSessionId,
        );

        if (!seedTransfer.moved) {
          lines.push(`グループ ${groupNumber}: ${seedTransfer.memberName} の参加者ロール付与に失敗しました。`);
          continue;
        }

        const childChannel = await waitForPbChildChannel(seedMember, config);

        if (!childChannel) {
          const sourceChannel = await config.guild.channels.fetch(config.sourceChannelId).catch(() => null);
          if (sourceChannel?.isVoiceBased?.()) await seedMember.voice.setChannel(sourceChannel, "Rollback PB child channel creation failure").catch((error) => logRecoverableError(`Failed to return ${seedMember.id} to the source VC`, error));
          if (!seedHadParticipantRole) {
            await removeVoiceParticipantRole(seedMember, config.participantRole.id, {
              sourceType: "splitvc",
              sourceId: config.splitSessionId,
            }).catch((rollbackError) => {
              console.error(`Failed to roll back split participant role for ${seedMember.id}: ${rollbackError.message}`);
            });
            participantMemberIds.delete(seedMember.id);
            participantRoleGrantedMemberIds.delete(seedMember.id);
          }
          lines.push(`グループ ${groupNumber}: PBの子VCを検出できませんでした。`);
          continue;
        }

        childChannelIds.add(childChannel.id);
        await sendSplitRandomTopicPanels({
          guild: config.guild,
          settings: config.settings,
          childChannelIds: [childChannel.id],
        });
        let movedCount = 1;
        const failed = [];
        const movedMemberIds = [seedMember.id];

        for (const member of group.slice(1)) {
          if (!member.voice?.channelId) {
            failed.push(member.displayName);
            continue;
          }

          try {
            const transfer = await moveMemberWithParticipantRole(
              member,
              childChannel,
              "Move remaining group members to PB child channel",
              config.participantRole,
              participantMemberIds,
              participantRoleGrantedMemberIds,
              config.splitSessionId,
            );

            if (!transfer.moved) {
              roleFailures.push(transfer.memberName);
              failed.push(member.displayName);
              continue;
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
      participantRoleGrantedMemberIds: [...participantRoleGrantedMemberIds],
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
    localWaitingMonitorSessions.add(options.splitSessionId);
    clearRestoredWaitingMonitor(options.splitSessionId);
    try {
    const initialLease = await claimWaitingMonitorLease(options.splitSessionId);
    if (!initialLease) {
      localWaitingMonitorSessions.delete(options.splitSessionId);
      return;
    }
    await persistSplitProcessSession(options.splitSessionId, {
      waitingMonitorStatus: "active",
      waitingMonitorStartedAt: new Date(),
      waitingMonitorHeartbeatAt: new Date(),
    }).catch((error) => logRecoverableError("Recoverable asynchronous operation failed", error));
    await sendOperationalLog({
      guild: options.guild,
      settings: options.settings,
      fallbackChannel: options.channel,
      content: `${options.waitingChannel} の途中参加監視を10分間開始します。`,
    });

    const endsAt = Date.now() + WAITING_ROOM_MONITOR_MS;

    while (Date.now() < endsAt && !options.state.ended) {
      try {
        if (!await claimWaitingMonitorLease(options.splitSessionId)) {
          options.state.ended = true;
          break;
        }
        await processWaitingRoom(options);
        await persistSplitProcessSession(options.splitSessionId, {
          waitingMonitorHeartbeatAt: new Date(),
          waitingMonitorFailureCount: 0,
        });
      } catch (error) {
        await recordWaitingMonitorFailure(options.splitSessionId, error).catch((error) => logRecoverableError("Recoverable asynchronous operation failed", error));
        await sendOperationalLog({ guild: options.guild, settings: options.settings, fallbackChannel: options.channel, content: `途中参加監視でエラーが発生しました: ${error?.message ?? error}` }).catch((error) => logRecoverableError("Recoverable asynchronous operation failed", error));
      }
      await sleep(WAITING_ROOM_POLL_MS);
    }

    if (options.state.ended) {
      localWaitingMonitorSessions.delete(options.splitSessionId);
      return;
    }

    const shouldExtendMonitoring = await shouldKeepWaitingRoomAlive(options);

    if (shouldExtendMonitoring) {
      await persistSplitProcessSession(options.splitSessionId, {
        waitingMonitorStatus: "extended",
        waitingMonitorExtendedAt: new Date(),
        waitingMonitorHeartbeatAt: new Date(),
      }).catch((error) => logRecoverableError("Recoverable asynchronous operation failed", error));
      await sendOperationalLog({
        guild: options.guild,
        settings: options.settings,
        fallbackChannel: options.channel,
        content: "2人以下の子VCが残っているため、途中参加監視を延長します。",
      });

      while (!options.state.ended && (await shouldKeepWaitingRoomAlive(options))) {
        try {
          if (!await claimWaitingMonitorLease(options.splitSessionId)) {
            options.state.ended = true;
            break;
          }
          await processWaitingRoom(options);
          await persistSplitProcessSession(options.splitSessionId, { waitingMonitorHeartbeatAt: new Date(), waitingMonitorFailureCount: 0 });
        } catch (error) {
          await recordWaitingMonitorFailure(options.splitSessionId, error).catch((error) => logRecoverableError("Recoverable asynchronous operation failed", error));
          await sendOperationalLog({ guild: options.guild, settings: options.settings, fallbackChannel: options.channel, content: `延長中の途中参加監視でエラーが発生しました: ${error?.message ?? error}` }).catch((error) => logRecoverableError("Recoverable asynchronous operation failed", error));
        }
        await sleep(WAITING_ROOM_POLL_MS);
      }
    }

    if (!options.state.ended) {
      const closing = await SplitProcessSession.findOneAndUpdate(
        {
          sessionId: options.splitSessionId,
          status: "active",
          waitingMonitorStatus: { $in: ["active", "extended"] },
          waitingMonitorLeaseOwner: waitingMonitorLeaseOwner,
        },
        { $set: { waitingMonitorStatus: "closing" }, $unset: { waitingMonitorLeaseOwner: 1, waitingMonitorLeaseUntil: 1 } },
        { returnDocument: "after", lean: true },
      ).catch(() => null);
      if (closing) {
        await notifyWaitingVcClosure(options.channel, options.waitingChannel).catch((error) => logRecoverableError("Recoverable asynchronous operation failed", error));
        try {
          await options.waitingChannel.delete();
        } catch (error) {
          await SplitProcessSession.updateOne(
            { sessionId: options.splitSessionId, waitingMonitorStatus: "closing" },
            {
              $set: {
                waitingMonitorStatus: "failed",
                waitingVcCleanupCompleted: false,
                lastError: `Waiting VC cleanup failed: ${error?.message ?? error}`,
              },
            },
          );
          await sendOperationalLog({
            guild: options.guild,
            settings: options.settings,
            fallbackChannel: options.channel,
            content: `途中参加監視終了時の待機VC削除に失敗しました: ${error?.message ?? error}`,
          }).catch((error) => logRecoverableError("Recoverable asynchronous operation failed", error));
          return;
        }
        await persistSplitProcessSession(options.splitSessionId, {
          waitingMonitorStatus: "closed",
          waitingMonitorClosedAt: new Date(),
          waitingVcCleanupCompleted: true,
        }).catch((error) => logRecoverableError("Recoverable asynchronous operation failed", error));
      }
      await sendOperationalLog({
        guild: options.guild,
        settings: options.settings,
        fallbackChannel: options.channel,
        content: "途中参加監視を終了しました。",
      });
    }
    localWaitingMonitorSessions.delete(options.splitSessionId);
    } finally {
      localWaitingMonitorSessions.delete(options.splitSessionId);
      await releaseWaitingMonitorLease(options.splitSessionId).catch((error) => {
        console.error(`Failed to release waiting monitor lease for ${options.splitSessionId}: ${error.message}`);
      });
    }
  }

  async function processWaitingRoom(options) {
    const waitingMembers = getWaitingMembers(options.waitingChannel);

    if (waitingMembers.length === 0) {
      return;
    }

    let movedToExistingGroup = false;
    for (const member of waitingMembers) {
      const underfilledChildChannel = await findUnderfilledChildChannel(
        options.guild,
        options.childChannelIds,
        member.id,
        options.previousPairKeys,
        options.currentGroupMembers,
      );
      if (!underfilledChildChannel) break;
      const currentMemberIds = toCurrentGroupMemberIds(
        options.currentGroupMembers,
        underfilledChildChannel.id,
        underfilledChildChannel,
      );
      const repeatedPairCount = currentMemberIds.reduce(
        (count, currentMemberId) =>
          count + (options.previousPairKeys.has(createPairKey(member.id, currentMemberId)) ? 1 : 0),
        0,
      );
      await sendSplitGroupingLog({
        guild: options.guild,
        settings: options.settings,
        content: `[splitvc-history] waiting placement guild=${options.guild.id} session=${options.splitSessionId} user=${member.id} channel=${underfilledChildChannel.id} process=existing-group repeatedPairCount=${repeatedPairCount} memberCount=${currentMemberIds.length}`,
      });
      try {
        const transfer = await moveMemberToChildChannel(
          member,
          underfilledChildChannel,
          options.participantRole,
          options.participantMemberIds,
          options.participantRoleGrantedMemberIds,
          options.splitSessionId,
        );
        if (!transfer.moved) {
          throw new Error(`Participant role grant failed for ${transfer.memberName}`);
        }
        const persistence = await persistWaitingGroupMembers(
          options,
          underfilledChildChannel.id,
          [member.id],
          "existing-group",
          transfer.roleGranted ? [member.id] : [],
        );
        if (!persistence.persisted) continue;
      } catch (error) {
        waitingMemberRetryAfter.set(`${options.guild.id}:${member.id}`, Date.now() + 15_000);
        await sendSplitGroupingLog({
          guild: options.guild,
          settings: options.settings,
          content: `[splitvc-history] waiting transfer failed guild=${options.guild.id} session=${options.splitSessionId} user=${member.id} channel=${underfilledChildChannel.id} process=existing-group error=${error.name ?? "Error"}: ${error.message ?? error}`,
        });
        continue;
      }
      await sendOperationalLog({
        guild: options.guild,
        settings: options.settings,
        fallbackChannel: options.channel,
        content: `途中参加: ${member.displayName} を ${underfilledChildChannel.name} へ転送しました。`,
      });
      movedToExistingGroup = true;
    }

    if (movedToExistingGroup) return;

    if (waitingMembers.length >= 3) {
      const newGroupMembers = chooseBestMemberSubset(
        waitingMembers,
        3,
        options.previousPairKeys,
      );
      await sendSplitGroupingLog({
        guild: options.guild,
        settings: options.settings,
        content: `[splitvc-history] waiting placement guild=${options.guild.id} session=${options.splitSessionId} users=${newGroupMembers.map((member) => member.id).join(",")} process=new-group repeatedPairCount=${countRepeatedPairs([newGroupMembers], options.previousPairKeys)} candidateCount=100`,
      });
      const result = await transferWaitingGroupToNewChild(newGroupMembers, {
        parentChannel: options.parentChannel,
        participantRole: options.participantRole,
        sourceChannelId: options.waitingChannel.id,
        childCategoryId: options.childCategoryId,
        participantMemberIds: options.participantMemberIds,
        participantRoleGrantedMemberIds: options.participantRoleGrantedMemberIds,
        guild: options.guild,
        settings: options.settings,
        splitSessionId: options.splitSessionId,
      });

      if (result.childChannelId) {
        options.childChannelIds.add(result.childChannelId);
        options.currentGroupMembers.set(result.childChannelId, new Set(result.movedMemberIds));
        const persistence = await persistWaitingGroupMembers(
          options,
          result.childChannelId,
          result.movedMemberIds,
          "new-group",
          result.newlyGrantedRoleMemberIds,
        );
        if (!persistence.persisted) return;
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
      .filter((member) => {
        const retryAt = waitingMemberRetryAfter.get(`${waitingChannel.guild.id}:${member.id}`);
        return !retryAt || retryAt <= Date.now();
      })
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

      if (memberCount < 3) {
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
    participantRoleGrantedMemberIds,
    splitSessionId,
  ) {
    return moveMemberWithParticipantRole(
      member,
      childChannel,
      "Move waiting participant to PB child channel",
      participantRole,
      participantMemberIds,
      participantRoleGrantedMemberIds,
      splitSessionId,
    );
  }

  async function transferWaitingGroupToNewChild(members, config) {
    const lines = [];
    const seedMember = members[0];

    try {
      const roleFailures = [];
      const seedHadParticipantRole = seedMember.roles.cache.has(config.participantRole.id);
      const seedTransfer = await moveMemberWithParticipantRole(
        seedMember,
        config.parentChannel,
        "Move waiting group seed to PB parent channel",
        config.participantRole,
        config.participantMemberIds,
        config.participantRoleGrantedMemberIds,
        config.splitSessionId,
      );

      if (!seedTransfer.moved) {
        return {
          childChannelId: null,
          lines: [`${seedTransfer.memberName} の参加者ロール付与に失敗しました。`],
        };
      }

      const childChannel = await waitForPbChildChannel(seedMember, config);

      if (!childChannel) {
        const sourceChannel = await config.guild.channels.fetch(config.sourceChannelId).catch(() => null);
        if (sourceChannel?.isVoiceBased?.()) await seedMember.voice.setChannel(sourceChannel, "Rollback waiting PB child channel creation failure").catch((error) => logRecoverableError(`Failed to return ${seedMember.id} to the source VC`, error));
        if (!seedHadParticipantRole) {
          await removeVoiceParticipantRole(seedMember, config.participantRole.id, {
            sourceType: "splitvc",
            sourceId: config.splitSessionId,
          }).catch((rollbackError) => {
            console.error(`Failed to roll back waiting split participant role for ${seedMember.id}: ${rollbackError.message}`);
          });
          config.participantMemberIds.delete(seedMember.id);
          config.participantRoleGrantedMemberIds?.delete(seedMember.id);
        }
        return {
          childChannelId: null,
          lines: ["PBの子VCを検出できませんでした。"],
        };
      }

      await sendSplitRandomTopicPanels({
        guild: config.guild,
        settings: config.settings,
        childChannelIds: [childChannel.id],
      });

      let movedCount = 1;
      const movedMemberIds = [seedMember.id];
      const newlyGrantedRoleMemberIds = seedTransfer.roleGranted ? [seedMember.id] : [];
      const failed = [];

      for (const member of members.slice(1)) {
        try {
          const transfer = await moveMemberWithParticipantRole(
            member,
            childChannel,
            "Move waiting group members to PB child channel",
            config.participantRole,
            config.participantMemberIds,
            config.participantRoleGrantedMemberIds,
            config.splitSessionId,
          );

          if (!transfer.moved) {
            roleFailures.push(transfer.memberName);
            failed.push(member.displayName);
            continue;
          }

          movedCount += 1;
          movedMemberIds.push(member.id);
          if (transfer.roleGranted) newlyGrantedRoleMemberIds.push(member.id);
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
        newlyGrantedRoleMemberIds,
        lines,
      };
    } catch (error) {
      return {
        childChannelId: null,
        lines: [`転送中に失敗しました。${error.message}`],
      };
    }
  }

  async function closeSplitWithoutFeedback(options, reason) {
    const finishActionKey = `split-finish-notice:${options.splitSessionId}`;
    const finishClaimed = await claimAction(finishActionKey);
    if (finishClaimed) {
      await finishAction(finishActionKey, "completed", "Feedback window canceled");
    }
    const actionKey = `split-role-remove:${options.splitSessionId}`;
    const claimed = await claimAction(actionKey);
    const members = normalizeCallWaitMemberIds(options.roleGrantedMemberIds);
    const result = await removeRoleFromMembers(options.guild, options.roleId, members, {
      sourceType: "splitvc",
      sourceId: options.splitSessionId,
    });
    if (result.failed) {
      if (claimed) await failAction(actionKey, `Failed to remove role from ${result.failed} member(s)`).catch((error) => logRecoverableError("Recoverable asynchronous operation failed", error));
      await persistSplitProcessSession(options.splitSessionId, { status: "role_remove_pending", phase: "role_remove_pending", roleRemovalCompleted: false, lastError: `Failed to remove role from ${result.failed} member(s)` });
      throw new Error(`Failed to remove role from ${result.failed} member(s)`);
    }
    const settings = await getGuildSettings(options.guild.id);
    if (settings?.gatheringVcRestorePending) {
      const restored = await restoreGatheringVcPermissionAfterSplit(options.guild, settings)
        .catch((error) => {
          logRecoverableError("Failed to restore gathering VC permission after split cancellation", error);
          return false;
        });
      if (!restored) {
        await sendOperationalLog({
          guild: options.guild,
          settings,
          fallbackChannel: options.channel,
          content: `集合VC権限を復元できませんでした。再起動時に再試行します。session=${options.splitSessionId}`,
        }).catch((error) => logRecoverableError("Failed to log gathering VC restore pending state", error));
      }
    }
    if (claimed) await finishAction(actionKey);
    if (options.temporaryWaitingVcDeleteTimer) clearTimeout(options.temporaryWaitingVcDeleteTimer);
    const waiting = options.temporaryWaitingVc && await options.guild.channels.fetch(options.temporaryWaitingVc.id).catch(() => null);
    if (waiting) {
      await notifyWaitingVcClosure(options.channel, waiting).catch((error) => logRecoverableError("Recoverable asynchronous operation failed", error));
      await waiting.delete().catch((error) => logRecoverableError("Failed to delete temporary waiting VC", error));
      await editSplitStartAnnouncementClosed(options.splitStartMessage).catch((error) => logRecoverableError("Recoverable asynchronous operation failed", error));
    }
    await persistSplitProcessSession(options.splitSessionId, { status: "canceled", phase: "canceled", roleRemovalCompleted: true, waitingVcCleanupCompleted: true, reviewAggregationEligible: false, completedAt: new Date(), lastError: reason });
    options.state.ended = true;
  }

  async function sendClaimedSplitFinishNotice(options) {
    const actionKey = `split-finish-notice:${options.splitSessionId}`;
    const claimed = await claimAction(actionKey);
    if (!claimed) return false;
    try {
      const session = await SplitProcessSession.findOne({ sessionId: options.splitSessionId }).lean();
      if (session && !session.finishNoticeSent) await sendSplitFinishNotice({ guild: options.guild, session, channelId: options.channel.id });
      await finishAction(actionKey);
      return true;
    } catch (error) {
      await failAction(actionKey, error.message).catch((error) => logRecoverableError("Recoverable asynchronous operation failed", error));
      throw error;
    }
  }

  async function runEndNotificationFlow(options) {
    const notificationCanceled = await runCountdown({
      channel: options.channel, ownerId: options.ownerId, totalMs: options.noticeWaitMs, updateEveryMs: COUNTDOWN_UPDATE_MS,
      buttonLabel: "終了通知キャンセル", cancelText: "終了通知はキャンセルされました。参加者ロールをすぐ解除します。",
      autoCancelWhen: () => areAllChannelsGone(options.guild, options.childChannelIds),
      render: (remainingMs) => `終了通知まで残り ${formatDuration(remainingMs)} です。\nキャンセルできるのはコマンド実行者のみです。`,
    });
    if (notificationCanceled === false) {
      await sendClaimedSplitFinishNotice(options);
      options.state.ended = true;
      return;
    }
    const session = await SplitProcessSession.findOne({ sessionId: options.splitSessionId }).lean();
    const conversationStarted = Boolean(session?.conversationStartedAt && (session.groupSnapshots ?? []).some((group) => group.memberIds?.length));
    if (notificationCanceled === "auto" && conversationStarted) {
      await sendClaimedSplitFinishNotice(options);
      if (options.temporaryWaitingVcDeleteTimer) clearTimeout(options.temporaryWaitingVcDeleteTimer);
      try {
        const waiting = options.temporaryWaitingVc
          ? await options.guild.channels.fetch(options.temporaryWaitingVc.id).catch(() => null)
          : null;
        if (waiting) {
          await notifyWaitingVcClosure(options.channel, waiting).catch((error) => logRecoverableError("Recoverable asynchronous operation failed", error));
          await waiting.delete();
          await editSplitStartAnnouncementClosed(options.splitStartMessage).catch((error) => logRecoverableError("Recoverable asynchronous operation failed", error));
        }
      } catch (error) {
        await sendOperationalLog({
          guild: options.guild,
          settings: options.settings,
          fallbackChannel: options.channel,
          content: `早期終了時の待機VC削除に失敗しました: ${error.message}`,
        }).catch((error) => logRecoverableError("Recoverable asynchronous operation failed", error));
      }
      options.state.ended = true;
      return;
    }
    await closeSplitWithoutFeedback(options, notificationCanceled === "auto" ? "All child channels disappeared before conversation started" : "Finish notification canceled manually");
  }

  async function persistWaitingGroupMembers(options, channelId, memberIds, processName, newlyGrantedRoleMemberIds = []) {
    const groupMembers = options.currentGroupMembers.get(channelId) ?? new Set();
    for (const memberId of memberIds) {
      groupMembers.add(memberId);
    }
    options.currentGroupMembers.set(channelId, groupMembers);

    try {
      const session = await SplitProcessSession.findOne({ sessionId: options.splitSessionId }).lean();
      const existingGroupIndex = (session?.groupSnapshots ?? []).findIndex((group) => group.channelId === channelId);
      const groupNumber = existingGroupIndex >= 0
        ? session.groupSnapshots[existingGroupIndex].groupNumber
        : (session?.groupSnapshots?.length ?? 0) + 1;
      const update = {
        $addToSet: {
          childChannelIds: channelId,
          participantMemberIds: { $each: memberIds },
          participantRoleGrantedMemberIds: { $each: newlyGrantedRoleMemberIds },
        },
        $set: {
          waitingMonitorHeartbeatAt: new Date(),
          waitingMonitorFailureCount: 0,
        },
      };
      if (existingGroupIndex >= 0) {
        update.$addToSet[`groupSnapshots.${existingGroupIndex}.memberIds`] = { $each: memberIds };
      } else {
        update.$push = {
          groupSnapshots: { groupNumber, channelId, memberIds },
        };
      }
      const persisted = await SplitProcessSession.updateOne(
        {
          sessionId: options.splitSessionId,
          status: "active",
          waitingMonitorStatus: { $in: ["active", "extended"] },
        },
        update,
      );
      if (persisted.matchedCount !== 1 || persisted.modifiedCount !== 1) {
        const error = new Error("Split waiting-session persistence did not update the active session.");
        error.persistenceReason = persisted.matchedCount !== 1 ? "session_not_found" : "persistence_not_modified";
        throw error;
      }
      return { persisted: true, groupCreated: existingGroupIndex < 0 };
    } catch (error) {
      const rollbackErrors = [];
      for (const memberId of memberIds) {
        try {
          const member = await options.guild.members.fetch(memberId);
          if (member.voice.channelId === channelId && options.waitingChannel?.isVoiceBased?.()) {
            await member.voice.setChannel(options.waitingChannel, "Rollback waiting transfer after persistence failure");
          }
          if (newlyGrantedRoleMemberIds.includes(memberId) && options.participantRole?.id) {
            await removeVoiceParticipantRole(member, options.participantRole.id, {
              sourceType: "splitvc",
              sourceId: options.splitSessionId,
            });
            options.participantRoleGrantedMemberIds?.delete(memberId);
          }
          options.participantMemberIds?.delete(memberId);
          groupMembers.delete(memberId);
        } catch (rollbackError) {
          rollbackErrors.push(`${memberId}: ${rollbackError.message}`);
        }
      }
      if (processName === "new-group") {
        options.childChannelIds?.delete(channelId);
        options.currentGroupMembers.delete(channelId);
        try {
          const childChannel = await options.guild.channels.fetch(channelId);
          await childChannel?.delete("Rollback split waiting child after persistence failure");
        } catch (rollbackError) {
          rollbackErrors.push(`child channel ${channelId}: ${rollbackError.message}`);
        }
      }
      const statePatch = {
        status: rollbackErrors.length ? "cleanup_required" : "failed",
        phase: rollbackErrors.length ? "cleanup_required" : "failed",
        lastError: `Waiting transfer persistence failed: ${error.message}${rollbackErrors.length ? `; rollback failures: ${rollbackErrors.join(" | ")}` : ""}`,
      };
      const marked = await SplitProcessSession.updateOne(
        { sessionId: options.splitSessionId },
        { $set: statePatch },
      ).catch((stateError) => {
        console.error(`Failed to mark split waiting persistence failure: ${stateError.message}`);
        return null;
      });
      if (!marked || marked.matchedCount !== 1) {
        console.error(`Split waiting persistence failure state could not be confirmed for ${options.splitSessionId}`);
      }
      await sendSplitGroupingLog({
        guild: options.guild,
        settings: options.settings,
        content: `[splitvc-history] current update failed guild=${options.guild.id} session=${options.splitSessionId} users=${memberIds.join(",")} channel=${channelId} process=${processName} error=${error.name ?? "Error"}: ${error.message ?? error}`,
      });
      return {
        persisted: false,
        reason: error.persistenceReason ?? "persistence_failed",
      };
    }
  }

  async function removeRoleFromMembers(guild, roleId, memberIds, source) {
    let removed = 0;
    let failed = 0;

    for (const memberId of memberIds) {
      try {
        const member = await guild.members.fetch(memberId);
        await removeVoiceParticipantRole(member, roleId, source);
        removed += 1;
      } catch (error) {
        console.error(`Failed to remove split participant role from ${memberId}: ${error.message}`);
        failed += 1;
      }
    }

    return { removed, failed };
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
      "【splitvc】",
      `参加者ロール: ${settings.tempRoleId ? `<@&${settings.tempRoleId}>` : "未設定"}`,
      `PB親チャンネル: ${settings.parentChannelId ? `<#${settings.parentChannelId}>` : "未設定"}`,
      `子VCカテゴリ: ${settings.childCategoryId ? `<#${settings.childCategoryId}>` : "未設定"}`,
      `待機VCカテゴリ: ${settings.waitingVcCategoryId ? `<#${settings.waitingVcCategoryId}>` : "未設定"}`,
      `待機VC名: ${settings.waitingVcName || DEFAULT_WAITING_VC_NAME}`,
      `転送前待機: ${getNonNegativeInteger(settings.transferWaitSeconds, DEFAULT_TRANSFER_WAIT_SECONDS)}秒`,
      `終了通知前待機: ${getNonNegativeInteger(settings.noticeWaitMinutes, DEFAULT_NOTICE_WAIT_MINUTES)}分`,
      `通知後ロール解除待機: ${getNonNegativeInteger(settings.roleRemoveWaitMinutes, DEFAULT_ROLE_REMOVE_WAIT_MINUTES)}分`,
      `終了通知文: ${settings.finishMessage || DEFAULT_FINISH_MESSAGE}`,
      "",
      "【通常募集】",
      `使用チャンネル: ${settings.bosyuChannelId ? `<#${settings.bosyuChannelId}>` : "制限なし"}`,
      `メンションロール: ${settings.bosyuMentionRoleId ? `<@&${settings.bosyuMentionRoleId}>` : "未設定"}`,
      "",
      "【雑談・VC集合】",
      `機能: ${settings.voiceReminderEnabled === false ? "無効" : "有効"}`,
      `対象PB親VC: ${settings.voiceReminderParentChannelId ? `<#${settings.voiceReminderParentChannelId}>` : "未設定"}`,
      `対象子VCカテゴリ: ${settings.voiceReminderChildCategoryId ? `<#${settings.voiceReminderChildCategoryId}>` : "未設定"}`,
      `明示的な監視VC: ${Array.isArray(settings.voiceMonitorVoiceChannelIds) && settings.voiceMonitorVoiceChannelIds.length ? settings.voiceMonitorVoiceChannelIds.map((id) => `<#${id}>`).join(" ") : "未設定（PB子VC判定を使用）"}`,
      `参加者ロール: ${settings.voiceParticipantRoleId ? `<@&${settings.voiceParticipantRoleId}>` : "未設定"}`,
      "",
      "【kokuchi】",
      `開催予定時刻: ${normalizeKokuchiEventTime(settings.kokuchiEventTime) ?? "21:00"}`,
      `30分前通知時刻: ${formatKokuchiDerivedTime(settings, 30)}`,
      `VC開放時刻: ${formatKokuchiDerivedTime(settings, 20)}`,
      `募集開始通知時刻: ${formatKokuchiDerivedTime(settings, 5)}`,
      `/kokuchi告知・スタート案内送信先: ${getKokuchiAnnouncementChannelId(settings) ? `<#${getKokuchiAnnouncementChannelId(settings)}>` : "未設定"}`,
      `概要チャンネル: ${getKokuchiOverviewChannelId(settings) ? `<#${getKokuchiOverviewChannelId(settings)}>` : "未設定"}`,
      `集合VC: ${settings.gatheringVoiceChannelId ? `<#${settings.gatheringVoiceChannelId}>` : "未設定"}`,
      `告知メンションロール: ${Array.isArray(settings.kokuchiMentionRoleIds) && settings.kokuchiMentionRoleIds.length > 0 ? settings.kokuchiMentionRoleIds.map((roleId) => `<@&${roleId}>`).join(" ") : "未設定"}`,
      `終了後意見・苦情チャンネル: ${settings.splitFeedbackChannelId ? `<#${settings.splitFeedbackChannelId}>` : `<#${DEFAULT_SPLIT_FEEDBACK_CHANNEL_ID}>`}`,
      "",
      "【フォーム・感想】",
      `フォーム設置先: ${settings.formChannelId ? `<#${settings.formChannelId}>` : "未設定"}`,
      `フォーム転送先: ${settings.formSendChannelId ? `<#${settings.formSendChannelId}>` : "未設定"}`,
      `感想送信先: ${settings.reviewSendChannelId ? `<#${settings.reviewSendChannelId}>` : "未設定"}`,
      `モデレーターロール: ${settings.formModeratorRoleId ? `<@&${settings.formModeratorRoleId}>` : "未設定"}`,
      "",
      "【運用ログ】",
      `送信先: ${settings.logChannelId ? `<#${settings.logChannelId}>` : "未設定"}`,
      "",
      "【定時募集・通話待機】",
      `機能: ${settings.callWaitEnabled === true ? "有効" : "無効"}`,
      "募集方式: ボタン式",
      `参加希望者ロール: ${settings.callWaitRoleId ? `<@&${settings.callWaitRoleId}>` : "未設定"}`,
      `募集メッセージ送信先: ${getCallWaitPromptChannelId(settings) ? `<#${getCallWaitPromptChannelId(settings)}>` : "未設定"}`,
      `集合通知送信先: ${getCallWaitNoticeChannelId(settings) ? `<#${getCallWaitNoticeChannelId(settings)}>` : "未設定"}`,
      `お手軽募集の30分前までの掲載先: ${settings.oteboPreviewChannelId ? `<#${settings.oteboPreviewChannelId}>` : "未設定"}`,
      `参加確認VCカテゴリ: ${settings.callWaitVoiceCategoryId ? `<#${settings.callWaitVoiceCategoryId}>` : "未設定"}`,
      `募集間隔: ${getCallWaitIntervalMinutes(settings)}分（JST 0:00基準）`,
      `お手軽募集の即時募集キャンセル猶予: ${getOteboQuickConfirmSeconds(settings)}秒`,
    ].join("\n");
  }

  function formatSettings(settings) {
    const text = formatLegacySettings(settings);
    if (!settings) return text;
    return `${text}\n\n【プロフィール】\n自己紹介チャンネル: ${settings.profileIntroductionChannelId ? `<#${settings.profileIntroductionChannelId}>` : "未設定"}\n\n【VCコントロール】\n対象カテゴリ: ${settings.vcControlCategoryId ? `<#${settings.vcControlCategoryId}>` : "未設定"}\n通知ロール: ${settings.vcControlNotifyRoleId ? `<@&${settings.vcControlNotifyRoleId}>` : "未設定"}`;
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

    if (interaction.deferred) {
      await interaction.editReply({ content: firstChunk, allowedMentions: options.allowedMentions, components: options.components });
    } else {
      await interaction.reply({ ...options, content: firstChunk });
    }

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

    try {
      if (interaction.deferred && !interaction.__initialResponseSent) {
        await interaction.editReply(payload);
        interaction.__initialResponseSent = true;
      } else if (interaction.replied || interaction.deferred) {
        await interaction.followUp(payload);
      } else {
        await interaction.reply(payload);
      }
    } catch (error) {
      console.error("Interaction response failed", {
        guildId: interaction.guildId ?? null,
        channelId: interaction.channelId ?? null,
        userId: interaction.user?.id ?? null,
        interactionId: interaction.id ?? null,
        commandName: interaction.commandName ?? interaction.customId ?? null,
        deferred: Boolean(interaction.deferred),
        replied: Boolean(interaction.replied),
        discordErrorCode: error?.code ?? null,
        error: error?.stack ?? error?.message ?? String(error),
      });
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
        const discordReady = client.isReady();
        const mongoReady = mongoose.connection.readyState === 1;
        const ok = discordReady && mongoReady && startupRestoreCompleted && !startupRestoreFailed && !shuttingDown;
        const body = JSON.stringify({
          ok,
          discordReady,
          mongoReady,
          startupRestoreCompleted,
          shuttingDown,
          bot: client.user?.tag ?? null,
          uptimeSeconds: Math.round(process.uptime()),
          startedAt: startedAt.toISOString(),
        });

        response.writeHead(ok ? 200 : 503, {
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
      await ensureCoreMongoIndexes();
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

  async function ensureCoreMongoIndexes() {
    // A partial unique index was added after the first deployment.  Normalize
    // old duplicate active follow-ups before creating it so startup remains
    // deterministic instead of failing partway through a recruitment cycle.
    const activeFollowups = await ScheduledAction.find({
      type: "callwait_followup",
      status: { $in: ["pending", "running"] },
    }).sort({ guildId: 1, executeAt: 1, createdAt: 1, _id: 1 }).lean();
    const staleIds = [];
    const seenGuildIds = new Set();
    for (const action of activeFollowups) {
      if (seenGuildIds.has(action.guildId)) staleIds.push(action._id);
      else seenGuildIds.add(action.guildId);
    }
    if (staleIds.length > 0) {
      const result = await ScheduledAction.updateMany(
        { _id: { $in: staleIds }, status: { $in: ["pending", "running"] } },
        {
          $set: {
            status: "failed",
            lastError: "Superseded by the startup migration enforcing one active call-wait follow-up per guild",
          },
        },
      );
      if (result.modifiedCount !== staleIds.length) {
        throw new Error("Could not normalize duplicate active call-wait follow-up actions before index creation.");
      }
      console.warn(`Marked ${staleIds.length} duplicate active call-wait follow-up action(s) as failed during index migration.`);
    }
    await Promise.all([
      ensureVoiceParticipantRoleGrantIndexes(),
      ScheduledAction.createIndexes(),
      CallWaitInterest.createIndexes(),
      KokuchiReservation.createIndexes(),
      MongoLeaseLock.createIndexes(),
      SplitProcessSession.createIndexes(),
      SplitReview.createIndexes(),
      SplitReviewDraft.createIndexes(),
    ]);
  }

  async function gracefulShutdown({ signal, exitCode }) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Graceful shutdown started${signal ? ` (${signal})` : ""}.`);

    if (callWaitTimer) clearTimeout(callWaitTimer);
    if (discordReadyWatchdog) clearTimeout(discordReadyWatchdog);
    for (const timers of [
      bumpReminderTimers,
      callWaitRoleRemovalTimers,
      callWaitFollowupTimers,
      gatheringVcUnlockTimers,
      kokuchiPreNoticeTimers,
      kokuchiGatheringReminderTimers,
      kokuchiReservationTimers,
      oteboRecruitmentTimers,
      restoredWaitingMonitorTimers,
      voiceParticipantRoleRetryTimers,
    ]) {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    }

    // Claimed scheduled actions are intentionally left durable.  Startup
    // recovery returns running actions to pending, so interrupting a process
    // cannot erase a follow-up or role-removal workflow.
    try {
      client.destroy();
    } catch (error) {
      console.error("Failed to destroy Discord client during shutdown:", error);
    }
    try {
      await disconnectFromMongoDB();
    } catch (error) {
      console.error("Failed to close MongoDB during shutdown:", error);
    }
    if (Number.isInteger(exitCode)) process.exit(exitCode);
  }

  process.once("SIGTERM", () => { void gracefulShutdown({ signal: "SIGTERM", exitCode: 0 }); });
  process.once("SIGINT", () => { void gracefulShutdown({ signal: "SIGINT", exitCode: 0 }); });
  process.once("unhandledRejection", (reason) => {
    console.error("Unhandled promise rejection:", reason);
    void gracefulShutdown({ signal: "unhandledRejection", exitCode: 1 });
  });
  process.once("uncaughtException", (error) => {
    console.error("Uncaught exception:", error);
    void gracefulShutdown({ signal: "uncaughtException", exitCode: 1 });
  });

  await startBot();
