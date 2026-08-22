import "./load-env.js";
import { monitorEventLoopDelay } from "node:perf_hooks";
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
import { deleteBumpReminder, getBumpReminders, saveBumpReminder } from "./bump-reminder-store.js";
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
import { cancelKokuchiTimedActions, claimCallWaitPendingNotice, claimOteboRecruitmentSlot, clearOteboRecruitmentConfirmation, deleteOteboRecruitmentIfOnlyMember, failCallWaitPendingNotice, getEnvironmentSettings, getGuildSettings, patchGuildSettingsForKokuchiEvent, recoverInterruptedCallWaitPendingNotices, recoverInterruptedCallWaitPrompts, recoverInterruptedKokuchiGatheringReminders, releaseOteboRecruitmentSlot, replaceNestedObject, saveGuildSettings, transitionCallWaitPrompt, transitionKokuchiGatheringReminder, transitionOteboRecruitmentSlot, transitionKokuchiTimedAction, transitionOteboRecruitment, updateCallWaitPromptMember, updateOteboRecruitmentParticipant, unsetNestedObject } from "./settings-store.js";
import { cancelKokuchiScheduledActions, claimAction, failAction, finishAction, getPendingActions, recoverInterruptedActions, retryAction, scheduleAction, scheduleSingleGuildAction } from "./scheduled-action-store.js";
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
import {
  ensureVoiceParticipantRoleGrantIndexes,
  VoiceParticipantRoleGrant,
} from "./models/voice-participant-role-grant.js";
import { CallWaitInterest } from "./models/call-wait-interest.js";
import { KokuchiReservation } from "./models/kokuchi-reservation.js";
import { MongoLeaseLock } from "./models/mongo-lease-lock.js";
import { ProfileRegistrationPanel } from "./models/profile-registration-panel.js";
import { OteboRecruitmentPanel } from "./models/otebo-recruitment-panel.js";
import { CallWaitRoleGeneration } from "./models/call-wait-role-generation.js";
import { OperationalActionLog } from "./models/operational-action-log.js";
import { GuildSettingsRevision } from "./models/guild-settings-revision.js";
import { SettingsApplyJob } from "./models/settings-apply-job.js";
import { GuildSetupDraft } from "./models/setup-draft.js";
import { OperationalHealthState } from "./models/operational-health-state.js";
import { OperationalStatusBoard } from "./models/operational-status-board.js";
import { ReconciliationObservation } from "./models/reconciliation-observation.js";
import { ReconciliationRepairJob } from "./models/reconciliation-repair-job.js";
import { acquireMongoLease, releaseMongoLease, renewMongoLease } from "./mongo-lease-lock-store.js";
import { handleProfileVoiceState, restoreProfiles } from "./profile-service.js";
import { createProfileRegistrationPanelService } from "./profile-registration-panel-service.js";
import { createOteboRecruitmentPanelService } from "./otebo-recruitment-panel-service.js";
import { createCallWaitRoleService } from "./call-wait-role-service.js";
import {
  BUTTON_RECRUITMENT_CONFLICT_MESSAGE,
  OTEBO_MERGED_NOTICE,
  OTEBO_VOICE_STARTED_NOTICE,
  formatOteboRecruitmentMessage as formatButtonRecruitmentMessage,
  formatOteboSuccessNotice as formatButtonSuccessNotice,
  normalizeOteboDuration as normalizeButtonDuration,
  normalizeOteboNote as normalizeButtonNote,
} from "./otebo-utils.js";
import { createVoiceChannelControlService } from "./voice-channel-control-service.js";
import { createFukyoThemeService } from "./fukyo-theme-service.js";
import { createOperationalStatusService } from "./operational-status-service.js";
import { createOperationalStatusBoardService } from "./operational-status-board-service.js";
import { createOperationalManagementService } from "./operational-management-service.js";
import { createKokuchiRecoveryService } from "./kokuchi-recovery-service.js";
import { runGatheringVcOpenTransaction } from "./kokuchi-gathering-vc-open.js";
import { createVcDmService } from "./vc-dm-service.js";
import { parseVcDmIdList } from "./vc-dm-utils.js";
import { VcDmDailyRun } from "./models/vc-dm-daily-run.js";
import { VcDmMemberTracking } from "./models/vc-dm-member-tracking.js";
import { VcDmMigration } from "./models/vc-dm-migration.js";
import { VcDmPanel } from "./models/vc-dm-panel.js";
import { VcDmReminder } from "./models/vc-dm-reminder.js";
import { BumpReminder } from "./models/bump-reminder.js";
import { FukyoThemeState } from "./models/fukyo-theme-state.js";
import { FukyoWeeklyPost } from "./models/fukyo-weekly-post.js";
import {
  createEveryonePermissionSnapshot,
  countUniqueParticipantIds,
  editEveryoneConnectPermission,
  formatSplitClosingThanks,
  getRestorePermissionPatch,
  permissionSnapshotMatches,
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
import { startHealthServer } from "./health-server.js";
import { createInteractionHandler } from "./interaction-router.js";
import { createReadyHandler } from "./app/startup-coordinator.js";
import { createShutdownController, registerProcessShutdownHandlers } from "./app/shutdown-coordinator.js";
import { registerDiscordEventHandlers } from "./app/discord-event-router.js";
import { createBumpReminderFeature } from "./features/bump-reminder.js";
import { createFeedbackFormsFeature } from "./features/feedback-forms.js";
import { createProfileFeature } from "./features/profile.js";
import { createSplitReviewFeature } from "./features/split-review.js";
import { createBosyuFeature } from "./features/bosyu.js";
import { createKokuchiFeature } from "./features/kokuchi.js";
import { createRecruitmentFeature } from "./features/recruitment.js";
import { createVoiceSplitFeature } from "./features/voice-split.js";
import { createGuildOperationsFeature } from "./features/guild-operations.js";
import { createCheckbotFeature } from "./features/checkbot.js";
import { createConfigurationFeature } from "./features/configuration.js";
import { createSetupFeature } from "./features/setup.js";
import { createSettingsValidationService } from "./settings-validation-service.js";
import { createConfigurationService, createEffectiveConfigurationWriter } from "./configuration-service.js";
import { createSettingsApplyDispatcher, createSettingsApplyService } from "./settings-apply-service.js";
import { createCallWaitSettingsReconciler } from "./callwait-settings-reconciler.js";
import { createReconciliationService } from "./reconciliation-service.js";
import { createReconciliationRepairService } from "./reconciliation-repair-service.js";
import { createSetupDraftService } from "./setup-service.js";
import { toCurrentGroupMemberIds } from "./split-waiting-utils.js";
import {
  canCloseGatheringVcAfterSplit,
  classifyGatheringVcRestoreBlock,
  getKokuchiReservationCleanupAt,
  getGatheringVcRestoreRetryDelayMs,
  GATHERING_VC_RESTORE_BLOCKING_STATUS_VALUES,
  isGatheringVcPermissionSnapshotValid,
  isGatheringVcRestoreOwnedByEvent,
  isGatheringVcRestoreBlocking,
  isKokuchiEventActionInvalid,
  MAX_GATHERING_VC_RESTORE_ATTEMPTS,
  normalizeGatheringVcRestoreStatus,
  normalizeKokuchiStatus,
} from "./kokuchi-event-state.js";

const {
  DISCORD_TOKEN,
  DISBOARD_BOT_ID,
  DISCORD_DEBUG_LOGS,
  KEEP_ALIVE_PORT,
  PORT,
  DISCORD_GUILD_ID,
  PB_LOG_CHANNEL_ID,
} = process.env;

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
const OTEBO_BUTTON_LIFECYCLE_LEASE_PREFIX = "otebo-button-lifecycle";
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

function cleanupAtForKokuchiReservation(reservation) {
  return getKokuchiReservationCleanupAt({
    restoreStatus: normalizeGatheringVcRestoreStatus(reservation ?? {}),
  });
}

const activeSessions = new Map();
const splitCountdownSessions = new Map();
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
const gatheringVcRestoreRetryTimers = new Map();
const kokuchiPreNoticeTimers = new Map();
const kokuchiGatheringReminderTimers = new Map();
const kokuchiReservationTimers = new Map();
const kokuchiPublishGuildLocks = new Set();
const oteboDrafts = new Map();
const oteboRecruitmentTimers = new Map();
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
let shouldSendMongoSuccessLog = false;
const botStartedAt = new Date();
let startupRestoreCompleted = false;
let startupRestoreFailed = false;
let startupRestoreFailures = [];
let shutdownController = null;

function isShuttingDown() {
  return shutdownController?.isShuttingDown() ?? false;
}

function logRecoverableError(context, error) {
  console.error(`${context}: ${error?.message ?? error}`, error);
}

function requestOperationalStatusRefresh(guildId, reason = "state-change") {
  const guild = client.guilds.cache.get(guildId);
  if (guild && operationalStatusBoardService) void operationalStatusBoardService.markDirty(guild, reason).catch((error) => logRecoverableError("Operational status refresh request failed", error));
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
const settingsValidationService = createSettingsValidationService({
  getGuildSettings,
  getStatusBoard: async (guildId) => {
    const query = OperationalStatusBoard.findOne({ guildId });
    return typeof query.lean === "function" ? query.lean() : query;
  },
  logger: console,
});
let settingsApplyService = null;
let reconciliationService = null;
let reconciliationRepairService = null;
const configurationService = createConfigurationService({ logger: console, applyJobModel: SettingsApplyJob });
const rawSaveVersionedGuildConfiguration = createEffectiveConfigurationWriter({
  updateConfiguration: configurationService.updateConfiguration,
  getGuildSettings,
});
// The writer remains the single versioned entrypoint used by /setting and
// future /setup.  Applying the committed revision is best-effort after the
// transaction; a Discord failure is reported as an apply-job state rather
// than being confused with a configuration-save failure.
const saveVersionedGuildConfiguration = async (guildId, patch, options = {}) => {
  const settings = await rawSaveVersionedGuildConfiguration(guildId, patch, options);
  if (!settingsApplyService || !settings?.revision) return settings;
  try {
    const apply = await settingsApplyService.applyCommittedRevision(guildId, settings.revision);
    return { ...settings, apply };
  } catch (error) {
    console.error(`Settings apply request failed after revision ${settings.revision}:`, error);
    return { ...settings, apply: { status: "retry_wait", revision: settings.revision, lastError: String(error?.message ?? error) } };
  }
};
const setupDraftService = createSetupDraftService({
  draftModel: GuildSetupDraft,
  configurationService,
  getGuildSettings,
  getGuild: (guildId) => client.guilds.cache.get(guildId) ?? null,
  saveVersionedGuildConfiguration,
  logger: console,
});
const setupFeature = createSetupFeature({
  draftService: setupDraftService,
  getGuildSettings,
  configurationService,
  logger: console,
});
const configurationFeature = createConfigurationFeature({
  configurationService,
  applyService: () => settingsApplyService,
  reconciliationService: () => reconciliationService,
  repairService: () => reconciliationRepairService,
  logger: console,
});
const checkbotFeature = createCheckbotFeature({
  getGuildSettings,
  validationService: settingsValidationService,
  logger: console,
});
const bumpReminderFeature = createBumpReminderFeature({
  client,
  disboardBotId: DISBOARD_BOT_ID,
  store: {
    deleteReminder: deleteBumpReminder,
    getReminders: getBumpReminders,
    saveReminder: saveBumpReminder,
  },
  requestOperationalStatusRefresh,
});
const feedbackFormsFeature = createFeedbackFormsFeature({
  getGuildSettings,
  replyOrFollowUp,
});
const vcDmService = createVcDmService({
  client,
  getGuildSettings,
  saveGuildSettings,
  acquireMongoLease,
  releaseMongoLease,
  sendOperationalLog,
  requestOperationalStatusRefresh,
  logger: console,
});
const voiceChannelControlService = createVoiceChannelControlService({ getGuildSettings, sendOperationalLog, setVoiceChannelStatus });
const profileRegistrationPanelService = createProfileRegistrationPanelService({ getGuildSettings, sendOperationalLog });
const profileFeature = createProfileFeature({
  getGuildSettings,
  sendOperationalLog,
  profileRegistrationPanelService,
  logRecoverableError,
  acquireMongoLease,
  releaseMongoLease,
  saveGuildSettingsWithCurrent,
  saveVersionedGuildConfiguration,
  replyOrFollowUp,
  formatSettings,
});
const splitReviewFeature = createSplitReviewFeature({
  client,
  getGuildSettings,
  sendOperationalLog,
});
const bosyuFeature = createBosyuFeature({
  client,
  getGuildSettings,
  replyOrFollowUp,
  logRecoverableError,
});
const kokuchiFeature = createKokuchiFeature({
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  GATHERING_VC_RESTORE_BLOCKING_STATUS_VALUES,
  KOKUCHI_RESERVATION_CANCEL_CUSTOM_ID,
  KokuchiReservation,
  MAX_GATHERING_VC_RESTORE_ATTEMPTS,
  MessageFlags,
  PermissionFlagsBits,
  PermissionsBitField,
  SplitProcessSession,
  acquireMongoLease,
  canCloseGatheringVcAfterSplit,
  cancelKokuchiRoleRemovalWait,
  cancelKokuchiScheduledActions,
  cancelKokuchiTimedActions,
  cleanupAtForKokuchiReservation,
  client,
  createEveryonePermissionSnapshot,
  createSessionId,
  editEveryoneConnectPermission,
  formatJstReservationTime,
  formatKokuchiMessage,
  gatheringVcRestoreRetryTimers,
  gatheringVcUnlockTimers,
  getGatheringVcRestoreRetryDelayMs,
  getGuildSettings,
  getKokuchiActionGuard,
  getKokuchiAnnouncementChannelId,
  getKokuchiEventDate,
  getKokuchiExecutionBlockReason,
  getKokuchiReminderStatusOnCancel,
  getKokuchiReservationCleanupAt,
  getNextKokuchiEventAt,
  getNextKokuchiReservationAt,
  getRestorePermissionPatch,
  hasActiveKokuchiEvent,
  isGatheringVcPermissionSnapshotValid,
  isGatheringVcRestoreBlocking,
  isGatheringVcRestoreOwnedByEvent,
  isKokuchiEventActionInvalid,
  kokuchiGatheringReminderTimers,
  kokuchiPreNoticeTimers,
  kokuchiPublishGuildLocks,
  kokuchiReservationTimers,
  logRecoverableError,
  normalizeGatheringVcRestoreStatus,
  normalizeKokuchiStatus,
  patchGuildSettingsForKokuchiEvent,
  permissionSnapshotMatches,
  releaseMongoLease,
  replyOrFollowUp,
  requestOperationalStatusRefresh,
  resolveConfiguredTextChannel,
  resolveKokuchiGatheringVoiceChannelId,
  resolveWadaiSendChannel,
  runGatheringVcOpenTransaction,
  saveGuildSettingsWithCurrent,
  sendOperationalLog,
  transitionKokuchiGatheringReminder,
  transitionKokuchiTimedAction,
});
function handleKokuchi(...args) { return kokuchiFeature.handleKokuchi(...args); }
function publishImmediateKokuchi(...args) { return kokuchiFeature.publishImmediateKokuchi(...args); }
function restoreGatheringVcUnlockSchedules(...args) { return kokuchiFeature.restoreGatheringVcUnlockSchedules(...args); }
function scheduleKokuchiPreNotice(...args) { return kokuchiFeature.scheduleKokuchiPreNotice(...args); }
function clearKokuchiPreNoticeTimer(...args) { return kokuchiFeature.clearKokuchiPreNoticeTimer(...args); }
function sendKokuchiPreNotice(...args) { return kokuchiFeature.sendKokuchiPreNotice(...args); }
function migrateKokuchiEventState(...args) { return kokuchiFeature.migrateKokuchiEventState(...args); }
function restorePendingGatheringVcPermissions(...args) { return kokuchiFeature.restorePendingGatheringVcPermissions(...args); }
function scheduleGatheringVcUnlock(...args) { return kokuchiFeature.scheduleGatheringVcUnlock(...args); }
function clearGatheringVcUnlockTimer(...args) { return kokuchiFeature.clearGatheringVcUnlockTimer(...args); }
function scheduleKokuchiGatheringReminder(...args) { return kokuchiFeature.scheduleKokuchiGatheringReminder(...args); }
function clearKokuchiGatheringReminderTimer(...args) { return kokuchiFeature.clearKokuchiGatheringReminderTimer(...args); }
function sendKokuchiGatheringReminder(...args) { return kokuchiFeature.sendKokuchiGatheringReminder(...args); }
function applyGatheringVcUnlock(...args) { return kokuchiFeature.applyGatheringVcUnlock(...args); }
function closeGatheringVcAfterSplit(...args) { return kokuchiFeature.closeGatheringVcAfterSplit(...args); }
function clearCompletedGatheringVcEventState(...args) { return kokuchiFeature.clearCompletedGatheringVcEventState(...args); }
function setGatheringVcConnectPermission(...args) { return kokuchiFeature.setGatheringVcConnectPermission(...args); }
function compensateGatheringVcCloseAfterPersistenceMismatch(...args) { return kokuchiFeature.compensateGatheringVcCloseAfterPersistenceMismatch(...args); }
function restoreGatheringVcPermissionAfterSplit(...args) { return kokuchiFeature.restoreGatheringVcPermissionAfterSplit(...args); }
function publishKokuchi(...args) { return kokuchiFeature.publishKokuchi(...args); }
function scheduleKokuchiReservation(...args) { return kokuchiFeature.scheduleKokuchiReservation(...args); }
function clearKokuchiReservationTimers(...args) { return kokuchiFeature.clearKokuchiReservationTimers(...args); }
function handleKokuchiReservationCancel(...args) { return kokuchiFeature.handleKokuchiReservationCancel(...args); }
function completeKokuchiCancellation(...args) { return kokuchiFeature.completeKokuchiCancellation(...args); }
function restoreKokuchiReservations(...args) { return kokuchiFeature.restoreKokuchiReservations(...args); }
function getGatheringVcUnlockChannelId(...args) { return kokuchiFeature.getGatheringVcUnlockChannelId(...args); }
function normalizeKokuchiEventTime(...args) { return kokuchiFeature.normalizeKokuchiEventTime(...args); }
function rescheduleCurrentKokuchiEvent(...args) { return kokuchiFeature.rescheduleCurrentKokuchiEvent(...args); }
const callWaitRoleService = createCallWaitRoleService({
  getGuildSettings,
  saveGuildSettings,
  generationModel: CallWaitRoleGeneration,
  scheduleRemoval: ({ actionKey, type, guild, roleId, memberIds, delayMs, payload }) => schedulePersistentRoleRemoval({
    actionKey,
    type,
    guild,
    roleId,
    memberIds,
    delayMs,
    timers: callWaitRoleRemovalTimers,
    payload,
  }),
  removeMembers: (guild, roleId, memberIds, source) => removeCallWaitRoleFromMembers(guild, roleId, memberIds, source),
  sendOperationalLog,
});
const oteboRecruitmentPanelService = createOteboRecruitmentPanelService({
  getGuildSettings,
  sendOperationalLog,
  canShowPanel: isOteboRecruitmentPanelDisplayAllowed,
});
const recruitmentFeature = createRecruitmentFeature({
  ActionRowBuilder,
  BUTTON_RECRUITMENT_CONFLICT_MESSAGE,
  ButtonBuilder,
  ButtonStyle,
  CALL_WAIT_CANCEL_CUSTOM_ID,
  CALL_WAIT_FOLLOWUP_CHECK_MS,
  CALL_WAIT_FOLLOWUP_RETRY_MS,
  CALL_WAIT_INTEREST_CUSTOM_ID,
  CALL_WAIT_INTEREST_SELECT_CUSTOM_ID,
  CALL_WAIT_INTERVAL_MINUTES,
  CALL_WAIT_JOIN_CUSTOM_ID,
  CALL_WAIT_MIN_MEMBERS,
  CALL_WAIT_MODE_BUTTON,
  CALL_WAIT_ROLE_REMOVE_MS,
  CallWaitInterest,
  ChannelType,
  KokuchiReservation,
  MessageFlags,
  ModalBuilder,
  OTEBO_BUTTON_LIFECYCLE_LEASE_PREFIX,
  OTEBO_CREATE_CUSTOM_ID,
  OTEBO_DEFAULT_QUICK_CONFIRM_SECONDS,
  OTEBO_DRAFT_CANCEL_CUSTOM_ID,
  OTEBO_DRAFT_NOTE_CUSTOM_ID,
  OTEBO_DRAFT_SELECT_CUSTOM_ID,
  OTEBO_DRAFT_SUBMIT_CUSTOM_ID,
  OTEBO_DURATION_30,
  OTEBO_DURATION_60,
  OTEBO_DURATION_NONE,
  OTEBO_JOIN_CUSTOM_ID,
  OTEBO_MEMBER_CANCEL_CUSTOM_ID,
  OTEBO_MERGED_NOTICE,
  OTEBO_NOTE_MODAL_CUSTOM_ID,
  OTEBO_OWNER_CANCEL_CONFIRM_CUSTOM_ID,
  OTEBO_OWNER_CANCEL_CUSTOM_ID,
  OTEBO_ROLE_REMOVE_MS,
  OTEBO_SCHEDULED_NOTICE_LEAD_MS,
  OTEBO_TYPE_IMMEDIATE,
  OTEBO_TYPE_SCHEDULED,
  OTEBO_VOICE_STATUS_DEADLINE_MS,
  OTEBO_VOICE_STATUS_EXTRA_MS,
  PermissionFlagsBits,
  PermissionsBitField,
  Routes,
  ScheduledAction,
  SplitProcessSession,
  SplitReviewDraft,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  VoiceParticipantRoleGrant,
  WAITING_ROOM_POLL_MS,
  acquireMongoLease,
  callWaitFollowupTimers,
  callWaitGuildLocks,
  callWaitRoleRemovalTimers,
  callWaitRoleService,
  cancelSplitCountdown,
  claimAction,
  claimCallWaitPendingNotice,
  claimOteboRecruitmentSlot,
  clearCompletedGatheringVcEventState,
  clearOteboRecruitmentConfirmation,
  client,
  createCallWaitInterestRow,
  createCallWaitSlotKey,
  createSessionId,
  deleteOteboRecruitmentIfOnlyMember,
  failAction,
  failCallWaitPendingNotice,
  finishAction,
  formatButtonRecruitmentMessage,
  formatButtonSuccessNotice,
  getGuildSettings,
  getInterestCooldownSeconds,
  getKokuchiActionGuard,
  getMsUntilNextJstCallWaitSlot,
  getNextJstCallWaitSlot,
  getNonNegativeInteger,
  getPendingActions,
  isGatheringVcRestoreBlocking,
  isJstCallWaitSlotDue,
  isKokuchiCallWaitPaused,
  isOteboRecruitmentPanelDisplayAllowed,
  isShuttingDown,
  logRecoverableError,
  minutesToMs,
  normalizeButtonDuration,
  normalizeButtonNote,
  normalizeCallWaitIntervalMinutes,
  normalizeGatheringVcRestoreStatus,
  oteboDrafts,
  oteboRecruitmentPanelService,
  oteboRecruitmentTimers,
  recoverInterruptedActions,
  releaseMongoLease,
  releaseOteboRecruitmentSlot,
  removeVoiceParticipantRole,
  replaceNestedObject,
  replyOrFollowUp,
  requestOperationalStatusRefresh,
  resolveConfiguredTextChannel,
  restoreGatheringVcPermissionAfterSplit,
  retryAction,
  saveGuildSettingsWithCurrent,
  scheduleAction,
  scheduleSingleGuildAction,
  secondsToMs,
  sendOperationalLog,
  sendSplitFinishNotice,
  setVoiceChannelStatus,
  stopInvalidKokuchiAction,
  transitionCallWaitPrompt,
  transitionOteboRecruitment,
  transitionOteboRecruitmentSlot,
  unsetNestedObject,
  updateCallWaitPromptMember,
  updateOteboRecruitmentParticipant,
});
const voiceSplitFeature = createVoiceSplitFeature({
  AUTO_SPLIT_THRESHOLD,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  CALL_WAIT_CANCEL_CUSTOM_ID,
  CALL_WAIT_INTEREST_CUSTOM_ID,
  CALL_WAIT_JOIN_CUSTOM_ID,
  COUNTDOWN_UPDATE_MS,
  ChannelType,
  DEFAULT_FINISH_MESSAGE,
  DEFAULT_NOTICE_WAIT_MINUTES,
  DEFAULT_ROLE_REMOVE_WAIT_MINUTES,
  DEFAULT_TRANSFER_WAIT_SECONDS,
  DEFAULT_WAITING_VC_NAME,
  KokuchiReservation,
  MESSAGE_LIMIT,
  MessageFlags,
  ModalBuilder,
  OTEBO_BUTTON_LIFECYCLE_LEASE_PREFIX,
  OTEBO_ROLE_REMOVE_MS,
  OTEBO_VOICE_STARTED_NOTICE,
  PB_CHILD_WAIT_MS,
  PermissionFlagsBits,
  PermissionsBitField,
  SPLIT_REVIEW_OPEN,
  SUGGESTED_TOPICS,
  SplitProcessSession,
  TextInputBuilder,
  TextInputStyle,
  VOICE_MONITOR_FORM_DELETE_DELAY_MS,
  VOICE_MONITOR_MIN_MEMBERS,
  VOICE_MONITOR_STOP_DELAY_MS,
  VOICE_PARTICIPANT_ROLE_MAX_RETRIES,
  VOICE_PARTICIPANT_ROLE_RETRY_DELAYS_MS,
  VoiceParticipantRoleGrant,
  WADAI_CATEGORIES,
  WAITING_MONITOR_LEASE_MS,
  WAITING_ROOM_MONITOR_MS,
  WAITING_ROOM_POLL_MS,
  acquireMongoLease,
  activeSessions,
  activeSplitVoiceLeases,
  autoSplitLocks,
  autoSplitSuggestionMessages,
  buildGroups,
  callWaitRoleRemovalTimers,
  callWaitRoleService,
  chooseBestGroupForMember,
  chooseBestMemberSubset,
  chooseGroupsWithHistory,
  claimAction,
  clearCompletedGatheringVcEventState,
  clearOteboRecruitmentTimers,
  client,
  closeGatheringVcAfterSplit,
  countRepeatedPairs,
  createPairKey,
  deferCommandResponse,
  deleteOteboRecruitmentMessage,
  deleteOteboRecruitmentState,
  describeGroups,
  editOteboRecruitmentMessageClosed,
  failAction,
  findActiveButtonOteboRecruitment,
  finishAction,
  getCallWaitIntervalMinutes,
  getCallWaitNoticeChannelId,
  getCallWaitPromptChannelId,
  getGuildSettings,
  getKokuchiAnnouncementChannelId,
  getOteboQuickConfirmSeconds,
  getOteboRecruitment,
  getPairKeysFromGroups,
  getSplitGroupingState,
  isGatheringVcRestoreBlocking,
  isKokuchiCallWaitPause,
  isKokuchiEventActionInvalid,
  localWaitingMonitorSessions,
  logRecoverableError,
  maybeSendPendingCallWaitStartNotice,
  mongoose,
  normalizeCallWaitMemberIds,
  normalizeGatheringVcRestoreStatus,
  normalizeKokuchiEventTime,
  oteboRecruitmentPanelService,
  processOteboVoiceStatusSessions,
  releaseMongoLease,
  releaseOteboRecruitmentSlot,
  removeCallWaitRoleFromMembers,
  retryAction,
  replaceNestedObject,
  requestOperationalStatusRefresh,
  resolveConfiguredTextChannel,
  restoreGatheringVcPermissionAfterSplit,
  restoredWaitingMonitorLocks,
  restoredWaitingMonitorTimers,
  saveGuildSettings,
  scheduleAction,
  schedulePersistentRoleRemoval,
  scheduleWaitingVcCleanup,
  sendOperationalLog,
  sendSplitClosingThanks,
  sendSplitGroupingLog,
  sendSplitRandomTopicPanels,
  sendSplitStartAnnouncement,
  shuffle,
  splitCountdownSessions,
  splitVoiceGuildLocks,
  startSplitGrouping,
  toCurrentGroupMemberIds,
  topicFormSessions,
  transitionOteboRecruitment,
  unsetNestedObject,
  validateVoiceParticipantRole,
  voiceMonitorPendingFormDeletions,
  voiceMonitorSessions,
  voiceParticipantRoleFinalFailureLogs,
  voiceParticipantRoleQueues,
  voiceParticipantRoleRetryTimers,
  waitingMemberRetryAfter,
  waitingMonitorLeaseOwner,
});
function getKokuchiActionGuard(...args) { return voiceSplitFeature.getKokuchiActionGuard(...args); }
function stopInvalidKokuchiAction(...args) { return voiceSplitFeature.stopInvalidKokuchiAction(...args); }
function persistSplitProcessSession(...args) { return voiceSplitFeature.persistSplitProcessSession(...args); }
function createCallWaitInterestRow(...args) { return voiceSplitFeature.createCallWaitInterestRow(...args); }
function isKokuchiCallWaitPaused(...args) { return voiceSplitFeature.isKokuchiCallWaitPaused(...args); }
function sendSplitFinishNotice(...args) { return voiceSplitFeature.sendSplitFinishNotice(...args); }
function clearRestoredWaitingMonitor(...args) { return voiceSplitFeature.clearRestoredWaitingMonitor(...args); }
function claimWaitingMonitorLease(...args) { return voiceSplitFeature.claimWaitingMonitorLease(...args); }
function releaseWaitingMonitorLease(...args) { return voiceSplitFeature.releaseWaitingMonitorLease(...args); }
function recordWaitingMonitorFailure(...args) { return voiceSplitFeature.recordWaitingMonitorFailure(...args); }
function createRestoredWaitingGroup(...args) { return voiceSplitFeature.createRestoredWaitingGroup(...args); }
function processRestoredWaitingMonitor(...args) { return voiceSplitFeature.processRestoredWaitingMonitor(...args); }
function startRestoredWaitingMonitor(...args) { return voiceSplitFeature.startRestoredWaitingMonitor(...args); }
function restoreSplitProcessSessions(...args) { return voiceSplitFeature.restoreSplitProcessSessions(...args); }
function formatKokuchiMessage(...args) { return voiceSplitFeature.formatKokuchiMessage(...args); }
function formatSplitStartAnnouncement(...args) { return voiceSplitFeature.formatSplitStartAnnouncement(...args); }
function formatSplitStartExtendedAnnouncement(...args) { return voiceSplitFeature.formatSplitStartExtendedAnnouncement(...args); }
function formatSplitStartClosedAnnouncement(...args) { return voiceSplitFeature.formatSplitStartClosedAnnouncement(...args); }
function editSplitStartAnnouncementExtended(...args) { return voiceSplitFeature.editSplitStartAnnouncementExtended(...args); }
function editSplitStartAnnouncementClosed(...args) { return voiceSplitFeature.editSplitStartAnnouncementClosed(...args); }
function fetchSplitStartAnnouncement(...args) { return voiceSplitFeature.fetchSplitStartAnnouncement(...args); }
function getWadaiTopics(...args) { return voiceSplitFeature.getWadaiTopics(...args); }
function getDefaultWadaiTopicsForCategory(...args) { return voiceSplitFeature.getDefaultWadaiTopicsForCategory(...args); }
function normalizeWadaiTopic(...args) { return voiceSplitFeature.normalizeWadaiTopic(...args); }
function formatWadaiList(...args) { return voiceSplitFeature.formatWadaiList(...args); }
function parseWadaiTarget(...args) { return voiceSplitFeature.parseWadaiTarget(...args); }
function normalizeWadaiTarget(...args) { return voiceSplitFeature.normalizeWadaiTarget(...args); }
function createWadaiTopicId(...args) { return voiceSplitFeature.createWadaiTopicId(...args); }
function saveGuildSettingsWithCurrent(...args) { return voiceSplitFeature.saveGuildSettingsWithCurrent(...args); }
function handleTopicRequestMessage(...args) { return voiceSplitFeature.handleTopicRequestMessage(...args); }
function handleVoiceStateUpdate(...args) { return voiceSplitFeature.handleVoiceStateUpdate(...args); }
function queueVoiceParticipantRoleUpdate(...args) { return voiceSplitFeature.queueVoiceParticipantRoleUpdate(...args); }
function isMemberCurrentlyInMonitoredVoiceChannel(...args) { return voiceSplitFeature.isMemberCurrentlyInMonitoredVoiceChannel(...args); }
function getVoiceMonitorRoleRetryKey(...args) { return voiceSplitFeature.getVoiceMonitorRoleRetryKey(...args); }
function clearVoiceMonitorRoleRetryState(...args) { return voiceSplitFeature.clearVoiceMonitorRoleRetryState(...args); }
function isDiscordUnknownMemberError(...args) { return voiceSplitFeature.isDiscordUnknownMemberError(...args); }
function getVoiceMonitorRetryOperation(...args) { return voiceSplitFeature.getVoiceMonitorRetryOperation(...args); }
function markExactVoiceMonitorGrantRemoved(...args) { return voiceSplitFeature.markExactVoiceMonitorGrantRemoved(...args); }
function recordVoiceMonitorRoleFailure(...args) { return voiceSplitFeature.recordVoiceMonitorRoleFailure(...args); }
function getVoiceMonitorFinalFailureLogKey(...args) { return voiceSplitFeature.getVoiceMonitorFinalFailureLogKey(...args); }
function clearVoiceMonitorFinalFailureLogs(...args) { return voiceSplitFeature.clearVoiceMonitorFinalFailureLogs(...args); }
function sendVoiceMonitorFinalFailureLog(...args) { return voiceSplitFeature.sendVoiceMonitorFinalFailureLog(...args); }
function sendVoiceMonitorOperationalFailureLog(...args) { return voiceSplitFeature.sendVoiceMonitorOperationalFailureLog(...args); }
function retryVoiceMonitorRoleGrant(...args) { return voiceSplitFeature.retryVoiceMonitorRoleGrant(...args); }
function findAssociatedTextChannel(...args) { return voiceSplitFeature.findAssociatedTextChannel(...args); }
function createAutoSplitRow(...args) { return voiceSplitFeature.createAutoSplitRow(...args); }
function maybeSendAutoSplitSuggestion(...args) { return voiceSplitFeature.maybeSendAutoSplitSuggestion(...args); }
function deleteAutoSplitSuggestionMessage(...args) { return voiceSplitFeature.deleteAutoSplitSuggestionMessage(...args); }
function isVoiceChannelMonitored(...args) { return voiceSplitFeature.isVoiceChannelMonitored(...args); }
function getVoiceReminderParentChannelIds(...args) { return voiceSplitFeature.getVoiceReminderParentChannelIds(...args); }
function resolveVoiceReminderParentChannel(...args) { return voiceSplitFeature.resolveVoiceReminderParentChannel(...args); }
function isPbChildVoiceChannel(...args) { return voiceSplitFeature.isPbChildVoiceChannel(...args); }
function getNonBotVoiceMembers(...args) { return voiceSplitFeature.getNonBotVoiceMembers(...args); }
function getVoiceMonitorSessionKey(...args) { return voiceSplitFeature.getVoiceMonitorSessionKey(...args); }
function isMemberInActiveVoiceMonitorContext(...args) { return voiceSplitFeature.isMemberInActiveVoiceMonitorContext(...args); }
function updateVoiceMonitorSession(...args) { return voiceSplitFeature.updateVoiceMonitorSession(...args); }
function stopVoiceMonitorSessionIfStillUnderfilled(...args) { return voiceSplitFeature.stopVoiceMonitorSessionIfStillUnderfilled(...args); }
function startVoiceMonitorSession(...args) { return voiceSplitFeature.startVoiceMonitorSession(...args); }
function handleOteboVoiceStartedRecruitment(...args) { return voiceSplitFeature.handleOteboVoiceStartedRecruitment(...args); }
function persistAutoSplitSuggestion(...args) { return voiceSplitFeature.persistAutoSplitSuggestion(...args); }
function clearAutoSplitSuggestion(...args) { return voiceSplitFeature.clearAutoSplitSuggestion(...args); }
function restoreVoiceMonitorSessions(...args) { return voiceSplitFeature.restoreVoiceMonitorSessions(...args); }
function isPersistedVoiceMonitorGrantInCurrentContext(...args) { return voiceSplitFeature.isPersistedVoiceMonitorGrantInCurrentContext(...args); }
function reconcilePersistedVoiceParticipantRoleGrants(...args) { return voiceSplitFeature.reconcilePersistedVoiceParticipantRoleGrants(...args); }
function sendVoiceMonitorStartNotice(...args) { return voiceSplitFeature.sendVoiceMonitorStartNotice(...args); }
function deleteVoiceMonitorTopicForms(...args) { return voiceSplitFeature.deleteVoiceMonitorTopicForms(...args); }
function scheduleVoiceMonitorTopicFormDeletion(...args) { return voiceSplitFeature.scheduleVoiceMonitorTopicFormDeletion(...args); }
function ensureSessionMembersHaveRole(...args) { return voiceSplitFeature.ensureSessionMembersHaveRole(...args); }
function stopVoiceMonitorSession(...args) { return voiceSplitFeature.stopVoiceMonitorSession(...args); }
function createTopicFormRow(...args) { return voiceSplitFeature.createTopicFormRow(...args); }
function createVoiceTopicModal(...args) { return voiceSplitFeature.createVoiceTopicModal(...args); }
function handleTopicFormButton(...args) { return voiceSplitFeature.handleTopicFormButton(...args); }
function handleAutoSplitButton(...args) { return voiceSplitFeature.handleAutoSplitButton(...args); }
function splitIntoTwoRandomGroups(...args) { return voiceSplitFeature.splitIntoTwoRandomGroups(...args); }
function transferMembersToPbChildChannel(...args) { return voiceSplitFeature.transferMembersToPbChildChannel(...args); }
function handleSuggestTopicButton(...args) { return voiceSplitFeature.handleSuggestTopicButton(...args); }
function handleTopicFormModal(...args) { return voiceSplitFeature.handleTopicFormModal(...args); }
function removeVoiceParticipantRole(...args) { return voiceSplitFeature.removeVoiceParticipantRole(...args); }
function handleSplitVoice(...args) { return voiceSplitFeature.handleSplitVoice(...args); }
function getPbChildChannelName(...args) { return voiceSplitFeature.getPbChildChannelName(...args); }
function resolveProcessConfig(...args) { return voiceSplitFeature.resolveProcessConfig(...args); }
function moveMemberWithParticipantRole(...args) { return voiceSplitFeature.moveMemberWithParticipantRole(...args); }
function transferGroups(...args) { return voiceSplitFeature.transferGroups(...args); }
function waitForPbChildChannel(...args) { return voiceSplitFeature.waitForPbChildChannel(...args); }
function isExpectedPbChildChannel(...args) { return voiceSplitFeature.isExpectedPbChildChannel(...args); }
function runWaitingRoomMonitor(...args) { return voiceSplitFeature.runWaitingRoomMonitor(...args); }
function processWaitingRoom(...args) { return voiceSplitFeature.processWaitingRoom(...args); }
function getWaitingMembers(...args) { return voiceSplitFeature.getWaitingMembers(...args); }
function findUnderfilledChildChannel(...args) { return voiceSplitFeature.findUnderfilledChildChannel(...args); }
function shouldKeepWaitingRoomAlive(...args) { return voiceSplitFeature.shouldKeepWaitingRoomAlive(...args); }
function moveMemberToChildChannel(...args) { return voiceSplitFeature.moveMemberToChildChannel(...args); }
function transferWaitingGroupToNewChild(...args) { return voiceSplitFeature.transferWaitingGroupToNewChild(...args); }
function closeSplitWithoutFeedback(...args) { return voiceSplitFeature.closeSplitWithoutFeedback(...args); }
function sendClaimedSplitFinishNotice(...args) { return voiceSplitFeature.sendClaimedSplitFinishNotice(...args); }
function runEndNotificationFlow(...args) { return voiceSplitFeature.runEndNotificationFlow(...args); }
function persistWaitingGroupMembers(...args) { return voiceSplitFeature.persistWaitingGroupMembers(...args); }
function removeRoleFromMembers(...args) { return voiceSplitFeature.removeRoleFromMembers(...args); }
function areAllChannelsGone(...args) { return voiceSplitFeature.areAllChannelsGone(...args); }
function cancelSplitCountdown(...args) { return voiceSplitFeature.cancelSplitCountdown(...args); }
function runCountdown(...args) { return voiceSplitFeature.runCountdown(...args); }
function handleSessionButton(...args) { return voiceSplitFeature.handleSessionButton(...args); }
function createCancelRow(...args) { return voiceSplitFeature.createCancelRow(...args); }
function formatCurrentSettings(...args) { return voiceSplitFeature.formatCurrentSettings(...args); }
function formatLegacySettings(...args) { return voiceSplitFeature.formatLegacySettings(...args); }
function formatSettings(...args) { return voiceSplitFeature.formatSettings(...args); }
function persistSplitParticipantMemberIds(...args) { return voiceSplitFeature.persistSplitParticipantMemberIds(...args); }
function formatResult(...args) { return voiceSplitFeature.formatResult(...args); }
function escapeMarkdown(...args) { return voiceSplitFeature.escapeMarkdown(...args); }
function splitMessage(...args) { return voiceSplitFeature.splitMessage(...args); }
function replyInChunks(...args) { return voiceSplitFeature.replyInChunks(...args); }
function sendChunked(...args) { return voiceSplitFeature.sendChunked(...args); }
function replySafely(...args) { return voiceSplitFeature.replySafely(...args); }
function replyOrFollowUp(...args) { return voiceSplitFeature.replyOrFollowUp(...args); }
function editSafely(...args) { return voiceSplitFeature.editSafely(...args); }
function formatVoiceTopicStatus(...args) { return voiceSplitFeature.formatVoiceTopicStatus(...args); }
function setVoiceChannelStatus(...args) { return voiceSplitFeature.setVoiceChannelStatus(...args); }
function deleteLater(...args) { return voiceSplitFeature.deleteLater(...args); }
function notifyWaitingVcClosure(...args) { return voiceSplitFeature.notifyWaitingVcClosure(...args); }
function getSendableChannel(...args) { return voiceSplitFeature.getSendableChannel(...args); }
function createSessionId(...args) { return voiceSplitFeature.createSessionId(...args); }
function addMany(...args) { return voiceSplitFeature.addMany(...args); }
function formatDuration(...args) { return voiceSplitFeature.formatDuration(...args); }
function getNonNegativeInteger(...args) { return voiceSplitFeature.getNonNegativeInteger(...args); }
function secondsToMs(...args) { return voiceSplitFeature.secondsToMs(...args); }
function minutesToMs(...args) { return voiceSplitFeature.minutesToMs(...args); }
function sleep(...args) { return voiceSplitFeature.sleep(...args); }
function handleSendCallWait(...args) { return recruitmentFeature.handleSendCallWait(...args); }
function handleSendOtebo(...args) { return recruitmentFeature.handleSendOtebo(...args); }
function handleOteboButton(...args) { return recruitmentFeature.handleOteboButton(...args); }
function handleOteboCreateButton(...args) { return recruitmentFeature.handleOteboCreateButton(...args); }
function handleOteboDraftSelect(...args) { return recruitmentFeature.handleOteboDraftSelect(...args); }
function handleOteboDraftNoteButton(...args) { return recruitmentFeature.handleOteboDraftNoteButton(...args); }
function handleOteboDraftSubmitButton(...args) { return recruitmentFeature.handleOteboDraftSubmitButton(...args); }
function handleOteboNoteModal(...args) { return recruitmentFeature.handleOteboNoteModal(...args); }
function createOteboRecruitmentFromDraft(...args) { return recruitmentFeature.createOteboRecruitmentFromDraft(...args); }
function createButtonOteboRecruitmentFromDraft(...args) { return recruitmentFeature.createButtonOteboRecruitmentFromDraft(...args); }
function handleOteboJoinButton(...args) { return recruitmentFeature.handleOteboJoinButton(...args); }
function handleOteboImmediateJoin(...args) { return recruitmentFeature.handleOteboImmediateJoin(...args); }
function formatOteboImmediateJoinReply(...args) { return recruitmentFeature.formatOteboImmediateJoinReply(...args); }
function startOteboImmediateReplyCountdown(...args) { return recruitmentFeature.startOteboImmediateReplyCountdown(...args); }
function handleOteboMemberCancelButton(...args) { return recruitmentFeature.handleOteboMemberCancelButton(...args); }
function handleOteboOwnerCancelButton(...args) { return recruitmentFeature.handleOteboOwnerCancelButton(...args); }
function handleOteboOwnerCancelConfirmButton(...args) { return recruitmentFeature.handleOteboOwnerCancelConfirmButton(...args); }
function cancelOteboParticipation(...args) { return recruitmentFeature.cancelOteboParticipation(...args); }
function cancelButtonOteboRecruitment(...args) { return recruitmentFeature.cancelButtonOteboRecruitment(...args); }
function respondOteboCancel(...args) { return recruitmentFeature.respondOteboCancel(...args); }
function scheduleNextCallWaitTick(...args) { return recruitmentFeature.scheduleNextCallWaitTick(...args); }
function processCallWaitForAllGuilds(...args) { return recruitmentFeature.processCallWaitForAllGuilds(...args); }
function processCallWaitForGuild(...args) { return recruitmentFeature.processCallWaitForGuild(...args); }
function sendCallWaitPromptForGuild(...args) { return recruitmentFeature.sendCallWaitPromptForGuild(...args); }
function validateCallWaitSettings(...args) { return recruitmentFeature.validateCallWaitSettings(...args); }
function evaluateCallWaitPrompt(...args) { return recruitmentFeature.evaluateCallWaitPrompt(...args); }
function deleteCallWaitPrompt(...args) { return recruitmentFeature.deleteCallWaitPrompt(...args); }
function deleteCallWaitMessage(...args) { return recruitmentFeature.deleteCallWaitMessage(...args); }
function getCallWaitInterestComponents(...args) { return recruitmentFeature.getCallWaitInterestComponents(...args); }
function buildCallWaitInterestReceiptContent(...args) { return recruitmentFeature.buildCallWaitInterestReceiptContent(...args); }
function formatCallWaitInterestEndedContent(...args) { return recruitmentFeature.formatCallWaitInterestEndedContent(...args); }
function formatCallWaitInterestCanceledContent(...args) { return recruitmentFeature.formatCallWaitInterestCanceledContent(...args); }
function formatCallWaitInterestJoinedContent(...args) { return recruitmentFeature.formatCallWaitInterestJoinedContent(...args); }
function getCallWaitPromptUrl(...args) { return recruitmentFeature.getCallWaitPromptUrl(...args); }
function formatCallWaitInterestEndNotificationContent(...args) { return recruitmentFeature.formatCallWaitInterestEndNotificationContent(...args); }
function endCallWaitInterestsForRecruitment(...args) { return recruitmentFeature.endCallWaitInterestsForRecruitment(...args); }
function retryPendingCallWaitEndNotifications(...args) { return recruitmentFeature.retryPendingCallWaitEndNotifications(...args); }
function endOrphanedCallWaitInterests(...args) { return recruitmentFeature.endOrphanedCallWaitInterests(...args); }
function isCallWaitDmFailure(...args) { return recruitmentFeature.isCallWaitDmFailure(...args); }
function editDeferredEphemeralReply(...args) { return recruitmentFeature.editDeferredEphemeralReply(...args); }
function deferComponentResponse(...args) { return recruitmentFeature.deferComponentResponse(...args); }
function deferCommandResponse(...args) { return recruitmentFeature.deferCommandResponse(...args); }
function registerCallWaitInterestFromPublicButton(...args) { return recruitmentFeature.registerCallWaitInterestFromPublicButton(...args); }
function cancelCallWaitInterestFromPublicButton(...args) { return recruitmentFeature.cancelCallWaitInterestFromPublicButton(...args); }
function cancelCallWaitInterestFromDm(...args) { return recruitmentFeature.cancelCallWaitInterestFromDm(...args); }
function endCallWaitInterest(...args) { return recruitmentFeature.endCallWaitInterest(...args); }
function cancelJoinedCallWaitInterest(...args) { return recruitmentFeature.cancelJoinedCallWaitInterest(...args); }
function editCallWaitInterestMessages(...args) { return recruitmentFeature.editCallWaitInterestMessages(...args); }
function handleCallWaitInterestThresholdSelect(...args) { return recruitmentFeature.handleCallWaitInterestThresholdSelect(...args); }
function registerCallWaitParticipant(...args) { return recruitmentFeature.registerCallWaitParticipant(...args); }
function finalizeCallWaitParticipantRegistration(...args) { return recruitmentFeature.finalizeCallWaitParticipantRegistration(...args); }
function joinCallWaitFromInterestDm(...args) { return recruitmentFeature.joinCallWaitFromInterestDm(...args); }
function reconcileCallWaitInterestThresholds(...args) { return recruitmentFeature.reconcileCallWaitInterestThresholds(...args); }
function enableCallWaitInterestRenotification(...args) { return recruitmentFeature.enableCallWaitInterestRenotification(...args); }
function refreshCallWaitPromptMessage(...args) { return recruitmentFeature.refreshCallWaitPromptMessage(...args); }
function notifyCallWaitInterests(...args) { return recruitmentFeature.notifyCallWaitInterests(...args); }
function handleCallWaitButton(...args) { return recruitmentFeature.handleCallWaitButton(...args); }
function sendCallWaitApplicantLog(...args) { return recruitmentFeature.sendCallWaitApplicantLog(...args); }
function sendCallWaitInterestStateLog(...args) { return recruitmentFeature.sendCallWaitInterestStateLog(...args); }
function formatCallWaitApplicantList(...args) { return recruitmentFeature.formatCallWaitApplicantList(...args); }
function formatCallWaitInterestList(...args) { return recruitmentFeature.formatCallWaitInterestList(...args); }
function mergeActiveButtonRecruitmentIntoScheduled(...args) { return recruitmentFeature.mergeActiveButtonRecruitmentIntoScheduled(...args); }
function grantCallWaitRoleAndQueueNotice(...args) { return recruitmentFeature.grantCallWaitRoleAndQueueNotice(...args); }
function maybeSendPendingCallWaitStartNotice(...args) { return recruitmentFeature.maybeSendPendingCallWaitStartNotice(...args); }
function normalizeCallWaitMemberIds(...args) { return recruitmentFeature.normalizeCallWaitMemberIds(...args); }
function getNonBotMemberIds(...args) { return recruitmentFeature.getNonBotMemberIds(...args); }
function getCallWaitPromptChannelId(...args) { return recruitmentFeature.getCallWaitPromptChannelId(...args); }
function getCallWaitNoticeChannelId(...args) { return recruitmentFeature.getCallWaitNoticeChannelId(...args); }
function scheduleCallWaitRoleRemoval(...args) { return recruitmentFeature.scheduleCallWaitRoleRemoval(...args); }
function schedulePersistentRoleRemoval(...args) { return recruitmentFeature.schedulePersistentRoleRemoval(...args); }
function scheduleWaitingVcCleanup(...args) { return recruitmentFeature.scheduleWaitingVcCleanup(...args); }
function executeWaitingVcCleanup(...args) { return recruitmentFeature.executeWaitingVcCleanup(...args); }
function cancelKokuchiRoleRemovalWait(...args) { return recruitmentFeature.cancelKokuchiRoleRemovalWait(...args); }
function executeScheduledRoleRemoval(...args) { return recruitmentFeature.executeScheduledRoleRemoval(...args); }
function completeCallWaitRoleGenerationLifecycle(...args) { return recruitmentFeature.completeCallWaitRoleGenerationLifecycle(...args); }
function executeSplitFinishNotice(...args) { return recruitmentFeature.executeSplitFinishNotice(...args); }
function restoreScheduledActions(...args) { return recruitmentFeature.restoreScheduledActions(...args); }
function scheduleCallWaitFollowupCheck(...args) { return recruitmentFeature.scheduleCallWaitFollowupCheck(...args); }
function executeCallWaitFollowup(...args) { return recruitmentFeature.executeCallWaitFollowup(...args); }
function runCallWaitFollowupCheck(...args) { return recruitmentFeature.runCallWaitFollowupCheck(...args); }
function sendCallWaitSkippedNotice(...args) { return recruitmentFeature.sendCallWaitSkippedNotice(...args); }
function removeCallWaitRoleFromMembers(...args) { return recruitmentFeature.removeCallWaitRoleFromMembers(...args); }
function getCallWaitActiveVoiceMemberIds(...args) { return recruitmentFeature.getCallWaitActiveVoiceMemberIds(...args); }
function formatCallWaitPromptV2(...args) { return recruitmentFeature.formatCallWaitPromptV2(...args); }
function getCallWaitIntervalMinutes(...args) { return recruitmentFeature.getCallWaitIntervalMinutes(...args); }
function getCallWaitSlotKey(...args) { return recruitmentFeature.getCallWaitSlotKey(...args); }
function formatJstTime(...args) { return recruitmentFeature.formatJstTime(...args); }
function createOteboDraftRows(...args) { return recruitmentFeature.createOteboDraftRows(...args); }
function createOteboTimeOptions(...args) { return recruitmentFeature.createOteboTimeOptions(...args); }
function createButtonOteboDraftRows(...args) { return recruitmentFeature.createButtonOteboDraftRows(...args); }
function formatButtonOteboDraftContent(...args) { return recruitmentFeature.formatButtonOteboDraftContent(...args); }
function getNextQuarterHourStart(...args) { return recruitmentFeature.getNextQuarterHourStart(...args); }
function createDefaultOteboDraft(...args) { return recruitmentFeature.createDefaultOteboDraft(...args); }
function formatOteboDraftContent(...args) { return recruitmentFeature.formatOteboDraftContent(...args); }
function formatOteboOwnerCancelMessage(...args) { return recruitmentFeature.formatOteboOwnerCancelMessage(...args); }
function updateOteboDraftMenuAfterModal(...args) { return recruitmentFeature.updateOteboDraftMenuAfterModal(...args); }
function createOteboJoinRow(...args) { return recruitmentFeature.createOteboJoinRow(...args); }
function createButtonOteboJoinRow(...args) { return recruitmentFeature.createButtonOteboJoinRow(...args); }
function createOteboMemberCancelRow(...args) { return recruitmentFeature.createOteboMemberCancelRow(...args); }
function createButtonOteboMemberCancelRow(...args) { return recruitmentFeature.createButtonOteboMemberCancelRow(...args); }
function createOteboOwnerCancelConfirmRow(...args) { return recruitmentFeature.createOteboOwnerCancelConfirmRow(...args); }
function formatOteboRecruitmentMessage(...args) { return recruitmentFeature.formatOteboRecruitmentMessage(...args); }
function editOteboRecruitmentMessage(...args) { return recruitmentFeature.editOteboRecruitmentMessage(...args); }
function getOteboRecruitmentAllowedMentions(...args) { return recruitmentFeature.getOteboRecruitmentAllowedMentions(...args); }
function shouldMentionBosyuInOteboRecruitment(...args) { return recruitmentFeature.shouldMentionBosyuInOteboRecruitment(...args); }
function formatOteboStartNoticeMessage(...args) { return recruitmentFeature.formatOteboStartNoticeMessage(...args); }
function getOteboScheduledDurationText(...args) { return recruitmentFeature.getOteboScheduledDurationText(...args); }
function getOteboImmediateDurationPrefix(...args) { return recruitmentFeature.getOteboImmediateDurationPrefix(...args); }
function normalizeOteboDuration(...args) { return recruitmentFeature.normalizeOteboDuration(...args); }
function normalizeOteboNote(...args) { return recruitmentFeature.normalizeOteboNote(...args); }
function sanitizeDiscordMentions(...args) { return recruitmentFeature.sanitizeDiscordMentions(...args); }
function getOteboQuickConfirmSeconds(...args) { return recruitmentFeature.getOteboQuickConfirmSeconds(...args); }
function getOteboDraftKey(...args) { return recruitmentFeature.getOteboDraftKey(...args); }
function createOteboRecruitmentId(...args) { return recruitmentFeature.createOteboRecruitmentId(...args); }
function validateOteboSettings(...args) { return recruitmentFeature.validateOteboSettings(...args); }
function getOteboRecruitments(...args) { return recruitmentFeature.getOteboRecruitments(...args); }
function getOteboRecruitment(...args) { return recruitmentFeature.getOteboRecruitment(...args); }
function getOteboVoiceStatusSessions(...args) { return recruitmentFeature.getOteboVoiceStatusSessions(...args); }
function isActiveOteboRecruitment(...args) { return recruitmentFeature.isActiveOteboRecruitment(...args); }
function findActiveOteboRecruitmentByOwner(...args) { return recruitmentFeature.findActiveOteboRecruitmentByOwner(...args); }
function findActiveButtonOteboRecruitment(...args) { return recruitmentFeature.findActiveButtonOteboRecruitment(...args); }
function saveOteboRecruitmentState(...args) { return recruitmentFeature.saveOteboRecruitmentState(...args); }
function deleteOteboRecruitmentState(...args) { return recruitmentFeature.deleteOteboRecruitmentState(...args); }
function addUniqueMemberId(...args) { return recruitmentFeature.addUniqueMemberId(...args); }
function createOteboVoiceStatusSession(...args) { return recruitmentFeature.createOteboVoiceStatusSession(...args); }
function getOteboDurationMinutes(...args) { return recruitmentFeature.getOteboDurationMinutes(...args); }
function getOteboVoiceStatusLabel(...args) { return recruitmentFeature.getOteboVoiceStatusLabel(...args); }
function restoreOteboRecruitmentTimers(...args) { return recruitmentFeature.restoreOteboRecruitmentTimers(...args); }
function restoreCallWaitRoleGenerations(...args) { return recruitmentFeature.restoreCallWaitRoleGenerations(...args); }
function scheduleOteboRecruitmentTimers(...args) { return recruitmentFeature.scheduleOteboRecruitmentTimers(...args); }
function shouldScheduleOteboNoticePublish(...args) { return recruitmentFeature.shouldScheduleOteboNoticePublish(...args); }
function getOteboNoticePublishAt(...args) { return recruitmentFeature.getOteboNoticePublishAt(...args); }
function processOteboNoticePublish(...args) { return recruitmentFeature.processOteboNoticePublish(...args); }
function scheduleOteboImmediateConfirmation(...args) { return recruitmentFeature.scheduleOteboImmediateConfirmation(...args); }
function processOteboImmediateConfirmation(...args) { return recruitmentFeature.processOteboImmediateConfirmation(...args); }
function processOteboDeadline(...args) { return recruitmentFeature.processOteboDeadline(...args); }
function releaseOteboSuccessClaim(...args) { return recruitmentFeature.releaseOteboSuccessClaim(...args); }
function finishOteboRecruitmentSuccess(...args) { return recruitmentFeature.finishOteboRecruitmentSuccess(...args); }
function finishButtonOteboRecruitmentSuccess(...args) { return recruitmentFeature.finishButtonOteboRecruitmentSuccess(...args); }
function deleteOteboRecruitmentMessage(...args) { return recruitmentFeature.deleteOteboRecruitmentMessage(...args); }
function editOteboRecruitmentMessageClosed(...args) { return recruitmentFeature.editOteboRecruitmentMessageClosed(...args); }
function addTemporaryRoleToMembers(...args) { return recruitmentFeature.addTemporaryRoleToMembers(...args); }
function scheduleOteboRoleRemoval(...args) { return recruitmentFeature.scheduleOteboRoleRemoval(...args); }
function removeTemporaryRoleFromMembers(...args) { return recruitmentFeature.removeTemporaryRoleFromMembers(...args); }
function processOteboVoiceStatusSessions(...args) { return recruitmentFeature.processOteboVoiceStatusSessions(...args); }
function findFirstOteboVoiceStatusChannel(...args) { return recruitmentFeature.findFirstOteboVoiceStatusChannel(...args); }
function clearOteboVoiceStatusSession(...args) { return recruitmentFeature.clearOteboVoiceStatusSession(...args); }
function scheduleOteboVoiceStatusClear(...args) { return recruitmentFeature.scheduleOteboVoiceStatusClear(...args); }
function scheduleOteboVoiceStatusDeadline(...args) { return recruitmentFeature.scheduleOteboVoiceStatusDeadline(...args); }
function processOteboVoiceStatusClear(...args) { return recruitmentFeature.processOteboVoiceStatusClear(...args); }
function processOteboVoiceStatusDeadline(...args) { return recruitmentFeature.processOteboVoiceStatusDeadline(...args); }
function sendOteboApplicantLog(...args) { return recruitmentFeature.sendOteboApplicantLog(...args); }
function clearOteboRecruitmentTimers(...args) { return recruitmentFeature.clearOteboRecruitmentTimers(...args); }
function clearOteboConfirmationTimer(...args) { return recruitmentFeature.clearOteboConfirmationTimer(...args); }
function getOteboDeadlineTimerKey(...args) { return recruitmentFeature.getOteboDeadlineTimerKey(...args); }
function getOteboPublishTimerKey(...args) { return recruitmentFeature.getOteboPublishTimerKey(...args); }
function getOteboConfirmationTimerKey(...args) { return recruitmentFeature.getOteboConfirmationTimerKey(...args); }
function getOteboRoleTimerKey(...args) { return recruitmentFeature.getOteboRoleTimerKey(...args); }
function getOteboVoiceStatusTimerKey(...args) { return recruitmentFeature.getOteboVoiceStatusTimerKey(...args); }

const fukyoThemeService = createFukyoThemeService({
  getGuildSettings,
  saveGuildSettings,
  saveVersionedGuildConfiguration,
  sendOperationalLog,
  acquireMongoLease,
  releaseMongoLease,
  requestOperationalStatusRefresh,
});
const operationalStatusService = createOperationalStatusService({
  getGuildSettings,
  client,
  getVcDmStatus: (guild) => vcDmService.getOperationalStatus(guild),
  getVoiceMonitorSessions: () => [...voiceMonitorSessions.values()],
  getStartupState: () => ({
    startedAt: botStartedAt,
    restoreCompleted: startupRestoreCompleted,
    restoreFailed: startupRestoreFailed,
  }),
});
const operationalStatusBoardService = createOperationalStatusBoardService({
  getOperationalStatusSnapshot: (guild, options) => operationalStatusService.getOperationalStatusSnapshot(guild, options),
  acquireMongoLease,
  renewMongoLease,
  releaseMongoLease,
  logger: console,
});
reconciliationRepairService = createReconciliationRepairService({
  repairJobModel: ReconciliationRepairJob,
  validationService: settingsValidationService,
  operationalStatusService,
  getGuild: (guildId) => client.guilds.cache.get(guildId) ?? null,
  getGuilds: () => client.guilds.cache,
  getGuildSettings,
  operationalStatusBoardService,
  profileRegistrationPanelService,
  oteboRecruitmentPanelService,
  voiceChannelControlService,
  logger: console,
});
reconciliationService = createReconciliationService({
  client,
  validationService: settingsValidationService,
  operationalStatusService,
  observationModel: ReconciliationObservation,
  onObservation: (observation) => reconciliationRepairService?.enqueueObservation(observation),
  logger: console,
});
const callWaitSettingsReconciler = createCallWaitSettingsReconciler({
  saveGuildSettingsWithCurrent,
  endCallWaitInterestsForRecruitment,
  deleteCallWaitPrompt,
  deleteCallWaitMessage,
  callWaitFollowupTimers,
  logger: console,
});
const settingsApplyDispatcher = createSettingsApplyDispatcher({
  getGuild: (guildId) => client.guilds.cache.get(guildId) ?? null,
  getGuildSettings,
  operationalStatusBoardService,
  profileRegistrationPanelService,
  oteboRecruitmentPanelService,
  vcDmService,
  voiceChannelControlService,
  voiceMonitorSessions,
  isVoiceChannelMonitored,
  stopVoiceMonitorSession,
  reconcilePersistedVoiceParticipantRoleGrants,
  rescheduleCurrentKokuchiEvent,
  requestOperationalStatusRefresh,
  fukyoThemeService,
  callWaitReconciler: callWaitSettingsReconciler,
  logger: console,
});
settingsApplyService = createSettingsApplyService({
  jobModel: SettingsApplyJob,
  configurationService,
  getGuildSettings,
  getEnvironmentSettings,
  getGuild: (guildId) => client.guilds.cache.get(guildId) ?? null,
  dispatcher: settingsApplyDispatcher,
  validationService: settingsValidationService,
  logger: console,
});
const kokuchiRecoveryService = createKokuchiRecoveryService({
  getGuildSettings,
  saveGuildSettings,
  acquireMongoLease,
  releaseMongoLease,
  clearReservationTimers: clearKokuchiReservationTimers,
  restoreGatheringVcPermission: restoreGatheringVcPermissionAfterSplit,
  patchGuildSettingsForEvent: patchGuildSettingsForKokuchiEvent,
  getGatheringVcRestoreState: async ({ eventId }) => eventId
    ? KokuchiReservation.findOne({ reservationId: eventId }).lean()
    : null,
  cancelRoleRemovalWait: cancelKokuchiRoleRemovalWait,
  completeReservationCancellation: completeKokuchiCancellation,
});
const operationalManagementService = createOperationalManagementService({
  statusService: operationalStatusService,
  boardService: operationalStatusBoardService,
  recoveryService: kokuchiRecoveryService,
  getGuildSettings,
  sendOperationalLog,
  actions: {
    removeParticipantRoles: runOperationalParticipantRoleRemoval,
    reinstallPanels: reinstallOperationalPanels,
    closeExpiredRecruitments: closeExpiredOperationalRecruitments,
  },
});
const guildOperationsFeature = createGuildOperationsFeature({
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  CALL_WAIT_MODE_BUTTON,
  ChannelType,
  DEFAULT_SPLIT_FEEDBACK_CHANNEL_ID,
  GATHERING_VC_RESTORE_BLOCKING_STATUS_VALUES,
  KokuchiReservation,
  MessageFlags,
  OTEBO_TYPE_SCHEDULED,
  PermissionFlagsBits,
  PermissionsBitField,
  SPLIT_RANDOM_TOPIC,
  VoiceParticipantRoleGrant,
  acquireMongoLease,
  callWaitFollowupTimers,
  callWaitSettingsReconciler,
  classifyGatheringVcRestoreBlock,
  countUniqueParticipantIds,
  createWadaiTopicId,
  deleteCallWaitMessage,
  deleteCallWaitPrompt,
  endCallWaitInterestsForRecruitment,
  formatSettings,
  formatSplitClosingThanks,
  formatSplitStartAnnouncement,
  formatWadaiList,
  fukyoThemeService,
  getCallWaitNoticeChannelId,
  getGuildSettings,
  getOteboRecruitments,
  getWadaiTopics,
  isGatheringVcRestoreBlocking,
  isVoiceChannelMonitored,
  lastTopicIdByChildChannel,
  logRecoverableError,
  normalizeCallWaitIntervalMinutes,
  normalizeGatheringVcRestoreStatus,
  normalizeKokuchiEventTime,
  normalizeKokuchiStatus,
  operationalStatusBoardService,
  oteboRecruitmentPanelService,
  parseVcDmIdList,
  parseWadaiTarget,
  processCallWaitForGuild,
  processOteboDeadline,
  profileFeature,
  profileRegistrationPanelService,
  randomTopicCooldownByChannel,
  reconcilePersistedVoiceParticipantRoleGrants,
  releaseMongoLease,
  replyInChunks,
  replyOrFollowUp,
  requestOperationalStatusRefresh,
  rescheduleCurrentKokuchiEvent,
  restoreGatheringVcPermissionAfterSplit,
  saveGuildSettingsWithCurrent,
  saveVersionedGuildConfiguration,
  splitReviewFeature,
  stopVoiceMonitorSession,
  validateOteboSettings,
  vcDmService,
  voiceChannelControlService,
  voiceMonitorSessions,
});
function isOteboRecruitmentPanelDisplayAllowed(...args) { return guildOperationsFeature.isOteboRecruitmentPanelDisplayAllowed(...args); }
function handleProfileRegistrationPanelMessage(...args) { return guildOperationsFeature.handleProfileRegistrationPanelMessage(...args); }
function handleOteboRecruitmentPanelMessage(...args) { return guildOperationsFeature.handleOteboRecruitmentPanelMessage(...args); }
function handleSetting(...args) { return guildOperationsFeature.handleSetting(...args); }
function handleRemoveRole(...args) { return guildOperationsFeature.handleRemoveRole(...args); }
function runOperationalParticipantRoleRemoval(...args) { return guildOperationsFeature.runOperationalParticipantRoleRemoval(...args); }
function reinstallOperationalPanels(...args) { return guildOperationsFeature.reinstallOperationalPanels(...args); }
function closeExpiredOperationalRecruitments(...args) { return guildOperationsFeature.closeExpiredOperationalRecruitments(...args); }
function handleKokuchiSetting(...args) { return guildOperationsFeature.handleKokuchiSetting(...args); }
function handleVcDmSetting(...args) { return guildOperationsFeature.handleVcDmSetting(...args); }
function handleCallWaitSetting(...args) { return guildOperationsFeature.handleCallWaitSetting(...args); }
function handleShugoSetting(...args) { return guildOperationsFeature.handleShugoSetting(...args); }
function validateVoiceParticipantRole(...args) { return guildOperationsFeature.validateVoiceParticipantRole(...args); }
function handleAddWadai(...args) { return guildOperationsFeature.handleAddWadai(...args); }
function handleShowWadai(...args) { return guildOperationsFeature.handleShowWadai(...args); }
function handleDelWadai(...args) { return guildOperationsFeature.handleDelWadai(...args); }
function sendSplitRandomTopicPanels(...args) { return guildOperationsFeature.sendSplitRandomTopicPanels(...args); }
function handleSplitRandomTopicButton(...args) { return guildOperationsFeature.handleSplitRandomTopicButton(...args); }
function sendSplitStartAnnouncement(...args) { return guildOperationsFeature.sendSplitStartAnnouncement(...args); }
function sendSplitClosingThanks(...args) { return guildOperationsFeature.sendSplitClosingThanks(...args); }
function formatSplitClosingThanksMessage(...args) { return guildOperationsFeature.formatSplitClosingThanksMessage(...args); }
function getKokuchiAnnouncementChannelId(...args) { return guildOperationsFeature.getKokuchiAnnouncementChannelId(...args); }
function getKokuchiOverviewChannelId(...args) { return guildOperationsFeature.getKokuchiOverviewChannelId(...args); }
function resolveWadaiSendChannel(...args) { return guildOperationsFeature.resolveWadaiSendChannel(...args); }
function resolveConfiguredTextChannel(...args) { return guildOperationsFeature.resolveConfiguredTextChannel(...args); }
function sendOperationalLog(...args) { return guildOperationsFeature.sendOperationalLog(...args); }
function sendSplitGroupingLog(...args) { return guildOperationsFeature.sendSplitGroupingLog(...args); }
function hasActiveKokuchiEvent(...args) { return guildOperationsFeature.hasActiveKokuchiEvent(...args); }
function getKokuchiExecutionBlockReason(...args) { return guildOperationsFeature.getKokuchiExecutionBlockReason(...args); }

let discordReadyWatchdog = null;

const healthPort = Number(PORT ?? KEEP_ALIVE_PORT);
const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });

if (Number.isInteger(healthPort) && healthPort > 0) {
  eventLoopDelay.enable();
  startHealthServer({
    port: healthPort,
    client,
    getMongoReady: async () => {
      if (mongoose.connection.readyState !== 1 || !mongoose.connection.db) return false;
      await mongoose.connection.db.command({ ping: 1 }, { maxTimeMS: 1_500 });
      return true;
    },
    getStartupState: () => ({
      completed: startupRestoreCompleted,
      failed: startupRestoreFailed,
    }),
    isShuttingDown,
    getEventLoopLagMs: () => {
      const lagMs = Number.isFinite(eventLoopDelay.mean) ? Math.round((eventLoopDelay.mean / 1e6) * 10) / 10 : null;
      eventLoopDelay.reset();
      return lagMs;
    },
  });
}

client.once(Events.ClientReady, createReadyHandler({
  clearReadyWatchdog: () => {
    if (discordReadyWatchdog) clearTimeout(discordReadyWatchdog);
    discordReadyWatchdog = null;
  },
  migrate: migrateKokuchiEventState,
  settingsApplyTasks: [
    { name: "settings-apply-jobs", run: () => settingsApplyService?.processAvailable({ maxJobs: 100 }) },
  ],
  restoreTasks: [
    { name: "call-wait-prompts", run: recoverInterruptedCallWaitPrompts },
    { name: "call-wait-pending-notices", run: recoverInterruptedCallWaitPendingNotices },
    { name: "kokuchi-gathering-reminders", run: recoverInterruptedKokuchiGatheringReminders },
    { name: "bump-reminders", run: bumpReminderFeature.restore },
    { name: "gathering-vc-unlock-schedules", run: restoreGatheringVcUnlockSchedules },
    { name: "gathering-vc-permissions", run: restorePendingGatheringVcPermissions },
    { name: "kokuchi-reservations", run: restoreKokuchiReservations },
    { name: "otebo-recruitment-timers", run: restoreOteboRecruitmentTimers },
    { name: "split-review-deliveries", run: splitReviewFeature.restoreFailedSplitReviewDeliveries },
    { name: "profiles", run: () => restoreProfiles(client, { sendOperationalLog, getGuildSettings }) },
    { name: "profile-registration-panel", run: () => profileRegistrationPanelService.restore(client) },
    { name: "vc-dm", run: () => vcDmService.restore(client) },
    { name: "scheduled-actions", run: restoreScheduledActions },
    { name: "bosyu-edit-sessions", run: bosyuFeature.restoreBosyuEditSessions },
    { name: "split-process-sessions", run: restoreSplitProcessSessions },
    { name: "voice-monitor-sessions", run: restoreVoiceMonitorSessions },
    { name: "call-wait-role-generations", run: restoreCallWaitRoleGenerations },
    { name: "voice-channel-control", run: () => voiceChannelControlService.restore(client) },
    { name: "fukyo-theme", run: () => fukyoThemeService.restore(client) },
  ],
  lateRestoreTasks: [
    { name: "otebo-recruitment-panel", run: () => oteboRecruitmentPanelService.restore(client) },
  ],
  workerStartTasks: [
    { name: "settings-apply-worker", run: () => settingsApplyService?.start() },
  ],
  updateRestoreState: ({ completed, failed, failures }) => {
    startupRestoreCompleted = completed;
    startupRestoreFailed = failed;
    startupRestoreFailures = failures;
  },
  recordStartupRestore: (state) => operationalStatusService.recordStartupRestore(state),
  statusBoard: operationalStatusBoardService,
  shouldSendMongoSuccessLog: () => shouldSendMongoSuccessLog,
  clearMongoSuccessLog: () => { shouldSendMongoSuccessLog = false; },
  sendMongoStartupEmbed,
  processCallWait: processCallWaitForAllGuilds,
  retryCallWaitNotifications: retryPendingCallWaitEndNotifications,
  scheduleCallWait: scheduleNextCallWaitTick,
  startRepair: () => reconciliationRepairService?.start(),
  startReconciliation: () => reconciliationService?.start(),
}));


registerDiscordEventHandlers({
  client,
  Events,
  ChannelType,
  debugLogs: DISCORD_DEBUG_LOGS === "true",
  isShuttingDown,
  getGuildSettings,
  requestOperationalStatusRefresh,
  logRecoverableError,
  services: {
    vcDm: vcDmService,
    oteboRecruitmentPanel: oteboRecruitmentPanelService,
    voiceChannelControl: voiceChannelControlService,
  },
  handlers: {
    handleDisboardBumpMessage: bumpReminderFeature.handleMessage,
    handleTopicRequestMessage,
    handleProfileRegistrationPanelMessage,
    handleOteboRecruitmentPanelMessage,
    handleProfileVoiceState: (oldState, newState) => handleProfileVoiceState(
      oldState,
      newState,
      { client, sendOperationalLog, getGuildSettings },
    ),
    handleVoiceStateUpdate,
  },
});

client.on(Events.InteractionCreate, createInteractionHandler({
  isShuttingDown,
  messageFlags: MessageFlags,
  services: {
    vcDm: vcDmService,
    operationalManagement: operationalManagementService,
    voiceChannelControl: voiceChannelControlService,
    fukyoTheme: fukyoThemeService,
  },
  handlers: {
    handleConfig: configurationFeature.handleConfig,
    handleCheckbot: checkbotFeature.handleCheckbot,
    handleSetup: setupFeature.handleSetup,
    handleSetupInteraction: setupFeature.handleInteraction,
    handleSplitReviewButton: splitReviewFeature.handleSplitReviewButton,
    handleSplitRandomTopicButton,
    handleBosyuButton: bosyuFeature.handleBosyuButton,
    handleProfileOpen: profileFeature.handleProfileOpen,
    handleProfilePublishButton: profileFeature.handleProfilePublishButton,
    handleSessionButton,
    handleAutoSplitButton,
    handleSuggestTopicButton,
    handleFeedbackFormButton: feedbackFormsFeature.handleButton,
    handleCallWaitButton,
    handleKokuchiReservationCancel,
    handleOteboButton,
    handleSplitReviewSelect: splitReviewFeature.handleSplitReviewSelect,
    handleOteboDraftSelect,
    handleCallWaitInterestThresholdSelect,
    handleSplitReviewModal: splitReviewFeature.handleSplitReviewModal,
    handleProfileModal: profileFeature.handleProfileModal,
    handleBosyuEditModal: bosyuFeature.handleBosyuEditModal,
    handleFeedbackFormModal: feedbackFormsFeature.handleModal,
    handleOteboNoteModal,
    handleSplitVoice,
    handleSetupProfile: profileFeature.handleSetupProfile,
    handleAddWadai,
    handleShowWadai,
    handleDelWadai,
    handleKokuchi,
    handleRemoveRole,
    handleSendCallWait,
    handleSetupForms: feedbackFormsFeature.handleSetup,
    handleSetting,
    handleShowReview: splitReviewFeature.handleShowReview,
  },
  ids: {
    splitReviewOpen: SPLIT_REVIEW_OPEN,
    splitReviewSubmit: SPLIT_REVIEW_SUBMIT,
    splitRandomTopic: SPLIT_RANDOM_TOPIC,
    callWaitJoin: CALL_WAIT_JOIN_CUSTOM_ID,
    callWaitInterest: CALL_WAIT_INTEREST_CUSTOM_ID,
    callWaitCancel: CALL_WAIT_CANCEL_CUSTOM_ID,
    kokuchiReservationCancel: KOKUCHI_RESERVATION_CANCEL_CUSTOM_ID,
    oteboCreate: OTEBO_CREATE_CUSTOM_ID,
    oteboDraftNote: OTEBO_DRAFT_NOTE_CUSTOM_ID,
    oteboDraftSubmit: OTEBO_DRAFT_SUBMIT_CUSTOM_ID,
    oteboDraftCancel: OTEBO_DRAFT_CANCEL_CUSTOM_ID,
    oteboJoin: OTEBO_JOIN_CUSTOM_ID,
    oteboMemberCancel: OTEBO_MEMBER_CANCEL_CUSTOM_ID,
    oteboOwnerCancel: OTEBO_OWNER_CANCEL_CUSTOM_ID,
    oteboOwnerCancelConfirm: OTEBO_OWNER_CANCEL_CONFIRM_CUSTOM_ID,
    splitReviewSelect: SPLIT_REVIEW_SELECT,
    oteboDraftSelect: OTEBO_DRAFT_SELECT_CUSTOM_ID,
    callWaitInterestSelect: CALL_WAIT_INTEREST_SELECT_CUSTOM_ID,
    splitReviewModal: SPLIT_REVIEW_MODAL,
    oteboNoteModal: OTEBO_NOTE_MODAL_CUSTOM_ID,
  },
  onError: async (interaction, error) => {
    if (interaction.commandName === "splitvc") {
      const splitSessionId = interaction.__splitSessionId;
      if (splitSessionId) {
        const splitSession = await SplitProcessSession.findOne({ sessionId: splitSessionId }).lean().catch(() => null);
        const canContinueInBackground = Boolean(
          splitSession?.childChannelIds?.length
          && splitSession.phase !== "transfer_waiting"
          && splitSession.status === "active",
        );
        await SplitProcessSession.updateOne(
          { sessionId: splitSessionId, status: { $in: ["active", "finish_notice_pending"] } },
          {
            $set: canContinueInBackground
              ? { lastError: `splitvc command failed after transfer; background recovery continues: ${error?.message ?? error}` }
              : {
                status: "failed",
                phase: "failed",
                completedAt: new Date(),
                lastError: `splitvc command failed: ${error?.message ?? error}`,
              },
          },
        ).catch((persistError) => console.error(`Failed to close failed splitvc session ${splitSessionId}: ${persistError.message}`));
      }
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
  },
  onFinally: async (interaction) => {
    const isOperationalInteraction = interaction.commandName === "botstatus"
      || interaction.customId?.startsWith?.("operational:");
    if (interaction.guildId && !isOperationalInteraction) requestOperationalStatusRefresh(interaction.guildId, "interaction");
  },
}));

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

async function testDiscordHttp() {
  const tests = [
    {
      name: "Gateway (no auth)",
      url: "https://discord.com/api/v10/gateway",
      auth: false,
    },
    {
      name: "Gateway Bot (auth)",
      url: "https://discord.com/api/v10/gateway/bot",
      auth: true,
    },
    {
      name: "Current Bot User",
      url: "https://discord.com/api/v10/users/@me",
      auth: true,
    },
  ];

  for (const test of tests) {
    try {
      const startedAt = Date.now();

      const response = await fetch(test.url, {
        headers: test.auth
          ? { Authorization: `Bot ${DISCORD_TOKEN}` }
          : {},
        signal: AbortSignal.timeout(10_000),
      });

      const body = await response.text();

      console.log(
        `[Discord HTTP Test] ${test.name}: status=${response.status} time=${Date.now() - startedAt}ms`,
      );

      if (!response.ok) {
        console.log(
          `[Discord HTTP Test] ${test.name} body:`,
          body.slice(0, 500),
        );
      }
    } catch (error) {
      console.error(
        `[Discord HTTP Test] ${test.name} failed:`,
        error,
      );
    }
  }
}

async function loginDiscordClient() {
  console.log("Testing Discord HTTP connectivity...");
  await testDiscordHttp();

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
      GuildSettingsRevision.createIndexes(),
      SettingsApplyJob.createIndexes(),
      GuildSetupDraft.createIndexes(),
      ensureVoiceParticipantRoleGrantIndexes(),
      BumpReminder.createIndexes(),
      ScheduledAction.createIndexes(),
      CallWaitInterest.createIndexes(),
      KokuchiReservation.createIndexes(),
      MongoLeaseLock.createIndexes(),
      ProfileRegistrationPanel.createIndexes(),
      FukyoThemeState.createIndexes(),
      FukyoWeeklyPost.createIndexes(),
      SplitProcessSession.createIndexes(),
      SplitReview.createIndexes(),
      SplitReviewDraft.createIndexes(),
      OteboRecruitmentPanel.createIndexes(),
      CallWaitRoleGeneration.createIndexes(),
      OperationalStatusBoard.createIndexes(),
      OperationalHealthState.createIndexes(),
      ReconciliationObservation.createIndexes(),
      ReconciliationRepairJob.createIndexes(),
      OperationalActionLog.createIndexes(),
      VcDmDailyRun.createIndexes(),
      VcDmMemberTracking.createIndexes(),
      VcDmMigration.createIndexes(),
      VcDmPanel.createIndexes(),
      VcDmReminder.createIndexes(),
    ]);
    try {
      await configurationService.backfillGuildSettings();
    } catch (error) {
      if (error?.code === "CONFIGURATION_TRANSACTIONS_UNAVAILABLE") {
        console.warn("GuildSettings revision metadata backfill deferred: MongoDB transactions are unavailable.");
      } else {
        throw error;
      }
    }
  }

  shutdownController = createShutdownController({
    stopServices: [
      () => reconciliationService?.shutdown(),
      () => reconciliationRepairService?.shutdown(),
      () => settingsApplyService?.shutdown(),
      () => voiceSplitFeature.shutdown(),
      () => vcDmService.shutdown(),
      () => bumpReminderFeature.shutdown(),
      () => recruitmentFeature.shutdown(),
      () => operationalStatusBoardService.stop(),
      () => fukyoThemeService.shutdown(),
      () => profileRegistrationPanelService.shutdown(),
    ],
    clearStandaloneTimers: [
      () => {
        if (discordReadyWatchdog) clearTimeout(discordReadyWatchdog);
        discordReadyWatchdog = null;
      },
    ],
    timerCollections: [
      callWaitRoleRemovalTimers,
      callWaitFollowupTimers,
      gatheringVcUnlockTimers,
      gatheringVcRestoreRetryTimers,
      kokuchiPreNoticeTimers,
      kokuchiGatheringReminderTimers,
      kokuchiReservationTimers,
      oteboRecruitmentTimers,
      restoredWaitingMonitorTimers,
      voiceParticipantRoleRetryTimers,
    ],
    destroyClient: () => client.destroy(),
    disconnectDatabase: disconnectFromMongoDB,
  });
  registerProcessShutdownHandlers({ shutdown: shutdownController.shutdown });

  if (process.env.DISCORD_BOT_SKIP_START !== "true") {
    await startBot();
  }
