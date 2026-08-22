import mongoose from "mongoose";
import { BumpReminder } from "./models/bump-reminder.js";
import { PermissionFlagsBits } from "discord.js";
import { BosyuEditSession } from "./models/bosyu-state.js";
import { CallWaitInterest } from "./models/call-wait-interest.js";
import { FukyoThemeState } from "./models/fukyo-theme-state.js";
import { FukyoWeeklyPost } from "./models/fukyo-weekly-post.js";
import { KokuchiReservation } from "./models/kokuchi-reservation.js";
import { OperationalHealthState } from "./models/operational-health-state.js";
import { OperationalStatusBoard } from "./models/operational-status-board.js";
import { ProfileRegistrationPanel } from "./models/profile-registration-panel.js";
import { OteboRecruitmentPanel } from "./models/otebo-recruitment-panel.js";
import { CallWaitRoleGeneration } from "./models/call-wait-role-generation.js";
import { ScheduledAction } from "./models/scheduled-action.js";
import { SplitProcessSession } from "./models/split-process-session.js";
import { VoiceChannelControl } from "./models/voice-channel-control.js";
import { VoiceExitSchedule } from "./models/voice-exit-schedule.js";
import { VoiceParticipantRoleGrant } from "./models/voice-participant-role-grant.js";
import { isVoiceChannelControlTarget } from "./voice-channel-control-service.js";
import { getPermissionOverwriteState } from "./kokuchi-utils.js";
import {
  classifyGatheringVcRestoreBlock,
  GATHERING_VC_RESTORE_BLOCKING_STATUS_VALUES,
  isGatheringVcRestoreBlocking,
  normalizeGatheringVcRestoreStatus,
  normalizeKokuchiStatus,
} from "./kokuchi-event-state.js";

const ACTIVE_KOKUCHI_STATUSES = ["pending", "processing", "canceling", "cancel_partial", "sent", "published_unconfirmed", "failed"];
const ACTIVE_SPLIT_STATUSES = ["active", "finish_notice_pending", "role_remove_pending", "cleaning_up", "feedback_open"];
const OBSERVED_SPLIT_STATUSES = [...ACTIVE_SPLIT_STATUSES, "failed", "cleanup_required"];
const ACTIVE_ACTION_STATUSES = ["pending", "running"];
const EXPIRED_PROMPT_STATES = ["active", "open", "pending", "processing", "evaluating", "role_granting", "failed"];
const MODULE_KEYS = ["system", "kokuchi", "splitvc", "recruitment", "automation", "panels", "voice", "vcDm"];
const INCIDENT_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_STATUS_RECORDS = 100;
const STATUS_QUERY_TIMEOUT_MS = 5_000;
const SNAPSHOT_BUILD_TIMEOUT_MS = 20_000;
const PANEL_PRESENT_CACHE_MS = 5 * 60_000;
const PANEL_MISSING_CACHE_MS = 60_000;
const PANEL_UNKNOWN_CACHE_MS = 30_000;
const PANEL_VERIFY_CONCURRENCY = 5;

const defaultModels = {
  BumpReminder,
  BosyuEditSession,
  CallWaitInterest,
  FukyoThemeState,
  FukyoWeeklyPost,
  KokuchiReservation,
  OperationalHealthState,
  OperationalStatusBoard,
  ProfileRegistrationPanel,
  OteboRecruitmentPanel,
  CallWaitRoleGeneration,
  ScheduledAction,
  SplitProcessSession,
  VoiceChannelControl,
  VoiceExitSchedule,
  VoiceParticipantRoleGrant,
};

function truncate(value, max = 500) {
  return String(value ?? "unknown").replace(/\s+/g, " ").trim().slice(0, max);
}

function asDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function ageMs(value, now = Date.now()) {
  const date = asDate(value);
  return date ? Math.max(0, now - date.getTime()) : null;
}

function formatJstDateTime(value) {
  const date = asDate(value);
  if (!date) return "日時不明";
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

async function resolveQuery(query) {
  if (!query) return [];
  return typeof query.lean === "function" ? query.lean() : query;
}

function withTimeout(value, timeoutMs, label) {
  let timer;
  return Promise.race([
    Promise.resolve(value),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

async function readMany(model, filter = {}, sort = null, limit = MAX_STATUS_RECORDS) {
  if (!model?.find) return [];
  let query = model.find(filter);
  if (sort && typeof query.sort === "function") query = query.sort(sort);
  if (limit && typeof query.limit === "function") query = query.limit(limit);
  if (typeof query.maxTimeMS === "function") query = query.maxTimeMS(STATUS_QUERY_TIMEOUT_MS);
  return (await withTimeout(resolveQuery(query), STATUS_QUERY_TIMEOUT_MS + 1_000, "Operational status query")) ?? [];
}

async function readOne(model, filter = {}) {
  if (!model?.findOne) return null;
  let query = model.findOne(filter);
  if (typeof query?.maxTimeMS === "function") query = query.maxTimeMS(STATUS_QUERY_TIMEOUT_MS);
  return withTimeout(resolveQuery(query), STATUS_QUERY_TIMEOUT_MS + 1_000, "Operational status query");
}

async function readCount(model, filter = {}) {
  if (!model?.countDocuments) return null;
  let query = model.countDocuments(filter);
  if (typeof query?.maxTimeMS === "function") query = query.maxTimeMS(STATUS_QUERY_TIMEOUT_MS);
  return withTimeout(query, STATUS_QUERY_TIMEOUT_MS + 1_000, "Operational status count");
}

function isDiscordMissingError(error) {
  return [10003, 10008].includes(Number(error?.code)) || error?.status === 404;
}

async function verifyPanelMessage(guild, channelId, messageId, cache = null) {
  if (!guild?.channels?.fetch || !channelId || !messageId) return { checked: false, exists: false, channelId, messageId };
  const cacheKey = `${guild.id}:${channelId}:${messageId}`;
  const cached = cache?.get(cacheKey);
  if (cached?.expiresAt > Date.now()) return cached.value;
  let result;
  try {
    let channel = guild.channels.cache?.get(channelId) ?? null;
    if (!channel) channel = await guild.channels.fetch(channelId);
    if (!channel?.messages?.fetch) {
      result = { checked: true, exists: false, status: "missing", channelId, messageId };
    } else if (typeof channel.permissionsFor === "function" && guild.members?.me) {
      const permissions = channel.permissionsFor(guild.members.me);
      const canView = typeof permissions?.has === "function" ? permissions.has(PermissionFlagsBits.ViewChannel) : null;
      const canRead = typeof permissions?.has === "function" ? permissions.has(PermissionFlagsBits.ReadMessageHistory) : null;
      if (canView === false || canRead === false) {
        result = { checked: true, exists: null, status: "unknown", channelId, messageId, error: "Bot lacks permission to verify the panel message." };
      }
    }
    if (!result && channel?.messages?.fetch) {
      let message = channel.messages.cache?.get(messageId) ?? null;
      if (!message) message = await channel.messages.fetch(messageId);
      result = { checked: true, exists: Boolean(message), status: message ? "present" : "missing", channelId, messageId };
    }
  } catch (error) {
    result = isDiscordMissingError(error)
      ? { checked: true, exists: false, status: "missing", channelId, messageId }
      : { checked: true, exists: null, status: "unknown", channelId, messageId, error: truncate(error?.message ?? error) };
  }
  if (cache) {
    const ttl = result.status === "present" ? PANEL_PRESENT_CACHE_MS : result.status === "missing" ? PANEL_MISSING_CACHE_MS : PANEL_UNKNOWN_CACHE_MS;
    if (cache.size >= 2_000) cache.delete(cache.keys().next().value);
    cache.set(cacheKey, { value: result, expiresAt: Date.now() + ttl });
  }
  return result;
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

function issue(code, message, blocking = false, severity = null, rootCauseId = null) {
  return { code, message, blocking, severity: severity ?? (blocking ? "error" : "warning"), ...(rootCauseId ? { rootCauseId } : {}) };
}

function makeModule({ key, label, summary, details = {}, issues = [], unknown = false, disabled = false, inProgress = false, availableActions = [] }) {
  const blocking = issues.some((item) => item.blocking === true);
  const severity = unknown
    ? "unknown"
    : blocking
      ? "error"
        : issues.length > 0
        ? issues.some((item) => item.severity === "warning") ? "warning" : "info"
        : inProgress
          ? "info"
          : disabled
            ? "disabled"
            : "healthy";
  return {
    key,
    label,
    severity,
    summary: truncate(summary, 900),
    details,
    issues,
    blocking,
    availableActions: [...new Set(availableActions)],
    observedAt: new Date().toISOString(),
  };
}

async function getDatabaseStatus(getDatabaseStatusOverride) {
  if (getDatabaseStatusOverride) return getDatabaseStatusOverride();
  if (mongoose.connection.readyState !== 1) return { status: "disconnected", error: "MongoDB connection is not ready" };
  try {
    const admin = mongoose.connection.db?.admin?.();
    if (admin?.ping) await withTimeout(admin.ping(), STATUS_QUERY_TIMEOUT_MS, "MongoDB ping");
    return { status: "connected", error: null };
  } catch (error) {
    return { status: "degraded", error: truncate(error?.message ?? error) };
  }
}

function isReady(client) {
  return Boolean(client?.isReady?.() ?? client?.readyAt);
}

async function collectSnapshot(guild, dependencies, options = {}) {
  const {
    getGuildSettings,
    client,
    getStartupState = () => ({}),
    getVoiceMonitorSessions = () => [],
    getVcDmStatus,
    models,
    getDatabaseStatus: getDatabaseStatusOverride,
    panelPresenceCache,
  } = dependencies;
  const db = { ...(await getDatabaseStatus(getDatabaseStatusOverride)) };
  const now = new Date();
  let healthReadError = null;
  let boardReadError = null;
  const health = db.status === "disconnected" ? null : await readOne(models.OperationalHealthState, { guildId: guild.id }).catch((error) => {
    healthReadError = truncate(error?.message ?? error);
    return null;
  });
  const board = db.status === "disconnected" ? null : await readOne(models.OperationalStatusBoard, { guildId: guild.id }).catch((error) => {
    boardReadError = truncate(error?.message ?? error);
    return null;
  });
  const startup = getStartupState() ?? {};
  const systemIssues = [];
  if (!isReady(client)) systemIssues.push(issue("discord_not_ready", "Discord接続がreadyではありません。", true));
  if (db.status !== "connected") systemIssues.push(issue("database_unavailable", `MongoDB状態: ${db.status}${db.error ? ` (${db.error})` : ""}`, true));
  if (healthReadError) systemIssues.push(issue("health_state_read_failed", `運用ヘルス状態を取得できません: ${healthReadError}`, true));
  if (boardReadError) systemIssues.push(issue("board_state_read_failed", `ステータスボード設定を取得できません: ${boardReadError}`, true));
  if (startup.restoreFailed || ["failed", "partial"].includes(health?.startupRestoreStatus)) {
    systemIssues.push(issue("startup_restore_failed", "起動時復元処理に失敗または一部失敗があります。", false));
  }
  const boardPublishError = board?.lastRefreshError ?? health?.lastBoardPublishError ?? null;
  if (!options.suppressBoardDeliveryIssues && boardPublishError) {
    systemIssues.push(issue("board_refresh_failed", `ステータスボードの前回更新に失敗しています: ${truncate(boardPublishError, 300)}`, false));
  }
  if (!options.suppressBoardDeliveryIssues && board?.lastSuccessfulRefreshAt && ageMs(board.lastSuccessfulRefreshAt, now.getTime()) > 2 * 60 * 60 * 1000) {
    systemIssues.push(issue("board_refresh_stale", "ステータスボードの最終成功更新が2時間を超えています。", false));
  }
  const system = makeModule({
    key: "system",
    label: "Bot・DB",
    summary: systemIssues.length ? systemIssues.map((item) => item.message).join(" ") : "Discord、MongoDB、起動時復元は正常です。",
    details: {
      discordReady: isReady(client),
      botUser: client?.user?.tag ?? client?.user?.username ?? null,
      botStartedAt: startup.startedAt ?? client?.readyAt ?? null,
      databaseStatus: db.status,
      startupRestoreStatus: health?.startupRestoreStatus ?? (startup.restoreCompleted ? "success" : "pending"),
      startupRestoreFailures: health?.startupRestoreFailures ?? [],
      lastDatabaseCheckAt: health?.lastDatabaseCheckAt ?? null,
      statusBoard: board ? { channelId: board.channelId, messageId: board.messageId, lastSuccessfulRefreshAt: board.lastSuccessfulRefreshAt, lastRefreshError: board.lastRefreshError } : null,
      boardPublishStatus: health?.lastBoardPublishStatus ?? null,
      boardPublishAt: health?.lastBoardPublishAt ?? null,
      boardPublishError: health?.lastBoardPublishError ?? null,
      lastSnapshotAt: now.toISOString(),
      attentionCount: systemIssues.filter((item) => item.blocking).length,
      recommendationCount: systemIssues.filter((item) => !item.blocking).length,
    },
    issues: systemIssues,
  });

  let settings;
  let settingsReadFailed = false;
  let settingsReadError = null;
  try {
    settings = await getGuildSettings(guild.id);
  } catch (error) {
    settings = null;
    settingsReadFailed = true;
    settingsReadError = truncate(error?.message ?? error);
    const settingsIssue = issue("settings_unavailable", `GuildSettingsを取得できません: ${truncate(error?.message ?? error)}`, true);
    systemIssues.push(settingsIssue);
    system.blocking = true;
    system.severity = "error";
    system.summary = truncate(`${system.summary} ${settingsIssue.message}`);
    system.details.attentionCount = system.issues.filter((item) => item.blocking).length;
    system.details.recommendationCount = system.issues.filter((item) => !item.blocking).length;
  }

  const modules = { system };
  let unknownModule = false;

  try {
    if (db.status !== "connected") throw new Error(`MongoDB is ${db.status}`);
    const currentId = settings?.kokuchiEventId;
    const reservations = await readMany(models.KokuchiReservation, {
      guildId: guild.id,
      $or: [
        ...(currentId ? [{ reservationId: currentId }] : []),
        { status: { $in: ACTIVE_KOKUCHI_STATUSES } },
        { gatheringVcRestorePending: true },
        { gatheringVcRestoreStatus: { $in: GATHERING_VC_RESTORE_BLOCKING_STATUS_VALUES } },
      ],
    }, { updatedAt: -1 }, 50);
    const current = currentId
      ? reservations.find((item) => item.reservationId === currentId)
      : reservations.length === 1 ? reservations[0] : null;
    const ambiguousCandidates = !current && reservations.length > 1;
    const pendingRestoreEvents = reservations.filter((item) => item.gatheringVcRestorePending === true || isGatheringVcRestoreBlocking(normalizeGatheringVcRestoreStatus(item)));
    const currentRestoreStatus = normalizeGatheringVcRestoreStatus(current ?? {});
    const restoreEvent = current
      && (current.gatheringVcRestorePending === true || isGatheringVcRestoreBlocking(currentRestoreStatus))
      ? current
      : pendingRestoreEvents.find((item) => item.reservationId === currentId)
        ?? pendingRestoreEvents[0]
        ?? null;
    const restoreEventId = restoreEvent?.reservationId
      ?? settings?.gatheringVcStateEventId
      ?? currentId
      ?? null;
    const restoreRecord = restoreEvent ?? (restoreEventId === currentId ? current : null);
    const kokuchiIssues = [];
    const actions = [];
    const restoreSettings = restoreEventId && settings?.gatheringVcStateEventId === restoreEventId ? settings : null;
    const restoreStatus = normalizeGatheringVcRestoreStatus(restoreRecord ?? restoreSettings ?? {});
    const states = {
      kokuchiStatus: normalizeKokuchiStatus(current?.kokuchiStatus ?? current?.status),
      preNotice: settings?.kokuchiPreNoticeState ?? null,
      gatheringUnlock: settings?.gatheringVcUnlockState ?? null,
      gatheringReminder: settings?.kokuchiGatheringReminderState ?? null,
      restorePending: restoreEvent?.gatheringVcRestorePending === true || isGatheringVcRestoreBlocking(restoreStatus),
      restoreStatus,
      restoreAttemptCount: restoreRecord?.gatheringVcRestoreAttemptCount ?? restoreSettings?.gatheringVcRestoreAttemptCount ?? 0,
      restoreFailureCode: restoreRecord?.gatheringVcRestoreFailureCode ?? restoreSettings?.gatheringVcRestoreFailureCode ?? null,
      restoreNextRetryAt: restoreRecord?.gatheringVcRestoreNextRetryAt ?? restoreSettings?.gatheringVcRestoreNextRetryAt ?? null,
      restoreLastError: restoreRecord?.gatheringVcRestoreLastError ?? restoreSettings?.gatheringVcRestoreLastError ?? null,
    };
    const restoreChannelId = restoreRecord?.gatheringVcUnlockChannelId
      ?? (restoreSettings ? settings?.gatheringVcUnlockChannelId : null);
    const savedRestoreSnapshot = restoreRecord?.gatheringVcPermissionBeforeOpen
      ?? (restoreSettings ? settings?.gatheringVcPermissionBeforeOpen : null);
    let currentRestorePermission = null;
    if (restoreChannelId && typeof guild.channels?.fetch === "function") {
      const restoreChannel = guild.channels.cache?.get(restoreChannelId)
        ?? await guild.channels.fetch(restoreChannelId).catch(() => null);
      const everyoneOverwrite = restoreChannel?.permissionOverwrites?.cache?.get(guild.id) ?? null;
      if (restoreChannel) {
        currentRestorePermission = {
          viewChannel: everyoneOverwrite ? getPermissionOverwriteState(everyoneOverwrite, PermissionFlagsBits.ViewChannel) : null,
          connect: everyoneOverwrite ? getPermissionOverwriteState(everyoneOverwrite, PermissionFlagsBits.Connect) : null,
        };
      }
    }
    const restoreBlock = classifyGatheringVcRestoreBlock({ eventId: currentId, event: restoreEvent ?? current, settings });
    if (restoreBlock) {
      const nextRetryAt = asDate(states.restoreNextRetryAt);
      const restoreMessage = [
        restoreBlock.message,
        nextRetryAt ? `次回復元予定: ${formatJstDateTime(nextRetryAt)}` : null,
        states.restoreLastError ? `最終復元エラー: ${truncate(states.restoreLastError, 240)}` : null,
      ].filter(Boolean).join(" ");
      kokuchiIssues.push(issue(restoreBlock.code, restoreMessage, restoreBlock.severity === "error", restoreBlock.severity));
      if (restoreBlock.severity !== "info") actions.push("restore_gathering_vc");
    }
    if (["sent_unconfirmed", "unconfirmed", "published_unconfirmed"].some((value) => Object.values(states).includes(value)) || current?.status === "published_unconfirmed") {
      kokuchiIssues.push(issue("unconfirmed", "送信結果未確認の状態があります。再送は自動で行いません。", false));
    }
    if (current?.status === "cancel_partial" || current?.status === "failed") {
      kokuchiIssues.push(issue("reservation_failed", `予約状態が ${current.status} です。`, true));
    }
    if (current && ageMs(current.processingAt ?? current.updatedAt) > 5 * 60 * 1000 && ["processing", "canceling"].includes(current.status)) {
      kokuchiIssues.push(issue("reservation_timeout", "予約処理が5分を超えて継続しています。", true));
    }
    if (settings?.kokuchiEventId && !current) {
      kokuchiIssues.push(issue("orphaned_event", "GuildSettingsに現在開催回が残っていますが予約レコードを特定できません。", true));
    }
    if (ambiguousCandidates) kokuchiIssues.push(issue("ambiguous_reservations", "複数の開催回候補があるため、候補を選択してから復旧操作を実行してください。", true));
    const currentKokuchiStatus = normalizeKokuchiStatus(current?.kokuchiStatus ?? current?.status);
    const eventCanBeCanceled = ["scheduled", "running", "canceling"].includes(currentKokuchiStatus)
      || ["pending", "processing", "sent"].includes(current?.status);
    if (eventCanBeCanceled || ambiguousCandidates) actions.push("kokuchi_cancel");
    if (eventCanBeCanceled) actions.push("kokuchi_force_terminate");
    if (["restore_snapshot_missing", "restore_state_inconsistent"].includes(restoreBlock?.code)
      && restoreRecord
      && (restoreRecord.gatheringVcRestorePending === true || isGatheringVcRestoreBlocking(states.restoreStatus))
      && !savedRestoreSnapshot) actions.push("kokuchi_clear_state");
    modules.kokuchi = makeModule({
      key: "kokuchi",
      label: "kokuchi",
      summary: current ? `${current.status} / ${current.eventAt ? formatJstDateTime(current.eventAt) : "開催日時未設定"}` : ambiguousCandidates ? `複数の開催回候補 ${reservations.length}件。候補選択が必要です。` : settings?.kokuchiEventId ? "現在開催回の孤立状態を検出" : "待機中です。",
      details: {
        currentEventId: settings?.kokuchiEventId ?? current?.reservationId ?? null,
        eventAt: settings?.kokuchiEventAt ?? current?.eventAt ?? null,
        reservation: current ? {
          reservationId: current.reservationId,
          status: current.status,
          kokuchiStatus: normalizeKokuchiStatus(current.kokuchiStatus ?? current.status),
          publicationStatus: current.publicationStatus,
          postProcessingStatus: current.postProcessingStatus,
          reminderStatus: current.reminderStatus,
          gatheringVcRestoreStatus: normalizeGatheringVcRestoreStatus(current),
          gatheringVcRestoreEventId: current.gatheringVcRestoreEventId ?? null,
          gatheringVcRestoreEventRevision: current.gatheringVcRestoreEventRevision ?? null,
          gatheringVcUnlockChannelId: current.gatheringVcUnlockChannelId ?? null,
          gatheringVcPermissionBeforeOpen: current.gatheringVcPermissionBeforeOpen ?? null,
          gatheringVcCurrentPermission: restoreEventId === current?.reservationId ? currentRestorePermission : null,
          gatheringVcRestoreAttemptCount: current.gatheringVcRestoreAttemptCount ?? 0,
          gatheringVcRestoreFailureCode: current.gatheringVcRestoreFailureCode ?? null,
          gatheringVcRestoreNextRetryAt: current.gatheringVcRestoreNextRetryAt ?? null,
          gatheringVcRestoreLastError: current.gatheringVcRestoreLastError ?? null,
        } : null,
        states,
        gatheringVcRestore: {
          eventId: restoreEventId,
          channelId: restoreChannelId,
          currentPermission: currentRestorePermission,
          savedSnapshot: savedRestoreSnapshot,
          status: states.restoreStatus,
          attemptCount: states.restoreAttemptCount,
          failureCode: states.restoreFailureCode,
          nextRetryAt: states.restoreNextRetryAt,
          lastError: states.restoreLastError,
          restoreEventId: restoreRecord?.gatheringVcRestoreEventId ?? restoreEventId,
          restoreEventRevision: restoreRecord?.gatheringVcRestoreEventRevision ?? null,
        },
        candidateCount: reservations.length,
        candidates: reservations.slice(0, 25).map((item) => ({ reservationId: item.reservationId, eventAt: item.eventAt, status: item.status, kokuchiStatus: normalizeKokuchiStatus(item.kokuchiStatus ?? item.status), gatheringVcRestoreStatus: normalizeGatheringVcRestoreStatus(item) })),
        newKokuchiBlocked: Boolean(isGatheringVcRestoreBlocking(states.restoreStatus) || ["scheduled", "running", "canceling"].includes(currentKokuchiStatus) || kokuchiIssues.some((item) => item.blocking)),
      },
      issues: kokuchiIssues,
      disabled: !settings?.kokuchiAnnouncementChannelId && !current && !settings?.kokuchiEventId,
      inProgress: Boolean(current && ["scheduled", "running", "canceling"].includes(normalizeKokuchiStatus(current.kokuchiStatus ?? current.status))),
      availableActions: actions,
    });
  } catch (error) {
    unknownModule = true;
    modules.kokuchi = makeModule({ key: "kokuchi", label: "kokuchi", summary: "状態を取得できません。", details: {}, issues: [issue("read_failed", truncate(error?.message ?? error), true)], unknown: true });
  }

  try {
    if (db.status !== "connected") throw new Error(`MongoDB is ${db.status}`);
    const incidentCutoff = new Date(now.getTime() - INCIDENT_LOOKBACK_MS);
    const sessions = await readMany(models.SplitProcessSession, {
      guildId: guild.id,
      $or: [
        { status: { $in: ACTIVE_SPLIT_STATUSES } },
        { status: { $in: ["failed", "cleanup_required"] }, updatedAt: { $gte: incidentCutoff } },
      ],
    }, { updatedAt: -1 });
    const activeSessions = sessions.filter((session) => ACTIVE_SPLIT_STATUSES.includes(session.status));
    const issues = [];
    const stale = activeSessions.filter((session) => ageMs(session.waitingMonitorHeartbeatAt ?? session.updatedAt) > 10 * 60 * 1000 && ["active", "cleaning_up", "role_remove_pending"].includes(session.status));
    if (stale.length) issues.push(issue("session_stale", `${stale.length}件のsplitvcセッションが長時間更新されていません。`, true));
    const failed = sessions.filter((session) => session.status === "failed" || session.lastError);
    if (failed.length) issues.push(issue("session_failed", `${failed.length}件のsplitvcセッションにエラーがあります。`, true));
    modules.splitvc = makeModule({
      key: "splitvc",
      label: "splitvc・会話練習会",
      summary: activeSessions.length
        ? `${activeSessions.length}件のセッションが進行中です。${failed.length ? ` 失敗・要確認 ${failed.length}件。` : ""}`
        : failed.length ? `進行中のセッションはありません。失敗・要確認 ${failed.length}件。` : "進行中のセッションはありません。",
      details: { sessions: sessions.map((session) => ({ sessionId: session.sessionId, status: session.status, phase: session.phase, participantCount: session.participantMemberIds?.length ?? 0, groupCount: session.groupSnapshots?.length ?? 0, waitingMonitorStatus: session.waitingMonitorStatus, waitingMonitorHeartbeatAt: session.waitingMonitorHeartbeatAt, finishNoticeAt: session.finishNoticeAt, roleRemovalCompleted: session.roleRemovalCompleted })) },
      issues,
      disabled: false,
      inProgress: activeSessions.length > 0,
    });
  } catch (error) {
    unknownModule = true;
    modules.splitvc = makeModule({ key: "splitvc", label: "splitvc・会話練習会", summary: "状態を取得できません。", issues: [issue("read_failed", truncate(error?.message ?? error), true)], unknown: true });
  }

  try {
    if (db.status !== "connected") throw new Error(`MongoDB is ${db.status}`);
    const prompt = settings?.callWaitPrompt ?? null;
    const otebo = Object.values(settings?.oteboRecruitments ?? {}).filter(Boolean);
    const panel = await readOne(models.OteboRecruitmentPanel, { guildId: guild.id });
    const panelPresence = panel ? await verifyPanelMessage(guild, panel.channelId, panel.messageId, panelPresenceCache) : null;
    const currentGeneration = await readOne(models.CallWaitRoleGeneration, { guildId: guild.id, status: { $in: ["scheduled", "executing"] } });
    const failedGenerations = await readMany(models.CallWaitRoleGeneration, { guildId: guild.id, status: "failed", updatedAt: { $gte: new Date(now.getTime() - INCIDENT_LOOKBACK_MS) } }, { updatedAt: -1 }, 20);
    const activeButton = otebo.find((item) => item.sourceType === "button" && ["creating", "active", "closing", "merging", "auto_cancel_processing", "success_processing", "success_notified", "cleanup_pending", "published_unconfirmed", "voice_started_notified"].includes(item.status));
    const panelHiddenReasons = [];
    if (settings?.callWaitEnabled !== true) panelHiddenReasons.push("call_wait_disabled");
    if (!settings?.callWaitRoleId) panelHiddenReasons.push("call_wait_role_not_configured");
    if (activeButton) panelHiddenReasons.push("button_recruitment_active");
    if (["evaluating", "role_granting", "closing"].includes(prompt?.lifecycleState)) panelHiddenReasons.push("call_wait_prompt_processing");
    if (["pending", "processing", "sent_unconfirmed", "failed"].includes(settings?.callWaitPendingNotice?.status)) panelHiddenReasons.push("call_wait_notice_processing");
    if (settings?.oteboRecruitmentSlot?.status && !["closed", "cancelled", "completed"].includes(settings.oteboRecruitmentSlot.status)) panelHiddenReasons.push(`slot_${settings.oteboRecruitmentSlot.status}`);
    if (settings?.callWaitRoleGeneration || currentGeneration) panelHiddenReasons.push("call_wait_role_generation_active");
    if (Object.values(settings?.oteboVoiceStatusSessions ?? {}).some(Boolean)) panelHiddenReasons.push("otebo_voice_status_active");
    if ((getVoiceMonitorSessions?.() ?? []).some((session) => session?.guildId === guild.id)) panelHiddenReasons.push("voice_monitor_active");
    const participantRole = settings?.voiceParticipantRoleId
      ? guild.roles?.cache?.get(settings.voiceParticipantRoleId)
        ?? (typeof guild.roles?.fetch === "function" ? await guild.roles.fetch(settings.voiceParticipantRoleId).catch(() => null) : null)
      : null;
    if ([...(participantRole?.members?.values?.() ?? [])].some((member) => !member.user?.bot)) panelHiddenReasons.push("voice_participant_role_active");
    if (!settings?.callWaitNoticeChannelId) panelHiddenReasons.push("notice_channel_not_configured");
    const expiredPrompt = prompt && asDate(prompt.targetAt)?.getTime() <= Date.now() && EXPIRED_PROMPT_STATES.includes(prompt.lifecycleState ?? "active");
    const expiredOtebo = otebo.filter((item) => asDate(item.targetAt)?.getTime() <= Date.now() && item.status === "active");
    const uncertainOtebo = otebo.filter((item) => ["publishing", "published_unconfirmed"].includes(item.status));
    const pendingOteboCleanup = otebo.filter((item) => ["auto_cancel_processing", "success_processing", "success_notified", "cleanup_pending", "failed", "voice_started_notified"].includes(item.status));
    const slotStatus = settings?.oteboRecruitmentSlot?.status ?? null;
    const uncertainSlot = ["creating", "cleanup_pending", "uncertain"].includes(slotStatus);
    const issues = [];
    if (expiredPrompt || expiredOtebo.length) issues.push(issue("expired_recruitment", `期限切れの募集が${Number(Boolean(expiredPrompt)) + expiredOtebo.length}件あります。`, true));
    if (uncertainOtebo.length) issues.push(issue("otebo_publication_uncertain", `送信結果未確認のボタン募集が${uncertainOtebo.length}件あります。自動削除は行いません。`, false));
    if (pendingOteboCleanup.length) issues.push(issue("otebo_cleanup_pending", `Otebo success cleanup is incomplete: ${pendingOteboCleanup.length}`, true));
    if (uncertainSlot) issues.push(issue("otebo_slot_uncertain", `ボタン募集スロットが${slotStatus}状態です。自動再送は行いません。`, true));
    const actions = expiredPrompt || expiredOtebo.length ? ["close_expired_recruitments"] : [];
    if (!panel && settings?.callWaitNoticeChannelId && panelHiddenReasons.length === 0) issues.push(issue("otebo_panel_state_missing", "ボタン募集パネルの保存情報がありません。", false));
    if (panel && settings?.callWaitNoticeChannelId && panel.channelId !== settings.callWaitNoticeChannelId
      && panelHiddenReasons.length === 0 && panelPresence?.checked === true && panelPresence.status !== "unknown") {
      issues.push(issue("otebo_panel_channel_mismatch", "保存済みボタン募集パネルの設置先が現在の設定と一致しません。", false));
    }
    if (panel && panelPresence?.checked && panelPresence.exists === false && panelHiddenReasons.length === 0) issues.push(issue("otebo_panel_message_missing", "ボタン募集パネルのDiscordメッセージが見つかりません。", false));
    if (panelPresence?.status === "unknown") issues.push(issue("otebo_panel_check_failed", `ボタン募集パネルを確認できません: ${panelPresence.error ?? "Discord API error"}`, false));
    if (failedGenerations.length) issues.push(issue("call_wait_role_generation_failed", `直近7日間のcall_wait_role世代処理の失敗が${failedGenerations.length}件あります。`, true));
    modules.recruitment = makeModule({
      key: "recruitment",
      label: "定時募集・ボタン募集",
      summary: settings?.callWaitEnabled ? `定時募集有効 / 現在募集 ${prompt ? 1 : 0}件 / ボタン募集 ${otebo.length}件` : "定時募集は無効です。",
      details: {
        enabled: settings?.callWaitEnabled === true,
        currentPrompt: prompt ? { messageId: prompt.messageId, lifecycleState: prompt.lifecycleState, memberCount: prompt.memberIds?.length ?? 0, targetAt: prompt.targetAt } : null,
        otebo: otebo.map((item) => ({ id: item.id, sourceType: item.sourceType ?? (item.type === "immediate" ? "button" : "scheduled"), status: item.status, ownerId: item.ownerId ?? null, memberCount: item.memberIds?.length ?? 0, pendingConfirmationCount: Object.keys(item.pendingConfirmations ?? {}).length, targetAt: item.targetAt, publishedToNotice: item.publishedToNotice, roleGenerationId: item.roleGenerationId ?? null })),
        buttonRecruitmentSlot: settings?.oteboRecruitmentSlot ?? null,
        oteboPanel: panel ? { channelId: panel.channelId, messageId: panel.messageId, updatedAt: panel.updatedAt, discordMessageExists: panelPresence?.checked ? panelPresence.exists : null } : null,
        panelHiddenReasons,
        currentCallWaitRoleGeneration: currentGeneration ? { generationId: currentGeneration.generationId, sourceType: currentGeneration.sourceType, sourceId: currentGeneration.sourceId, targetCount: currentGeneration.memberIds?.length ?? 0, memberIds: currentGeneration.memberIds ?? [], removeAt: currentGeneration.executeAt, status: currentGeneration.status } : settings?.callWaitRoleGeneration ?? null,
        staleCallWaitRoleGenerations: failedGenerations.slice(0, 20).map((item) => ({ generationId: item.generationId, status: item.status, sourceType: item.sourceType, sourceId: item.sourceId, lastError: item.lastError, updatedAt: item.updatedAt })),
      },
      issues,
      disabled: settings?.callWaitEnabled !== true && otebo.length === 0,
      inProgress: Boolean(prompt || otebo.length),
      availableActions: actions,
    });
    // This read is intentionally scoped to the guild and is used to surface
    // stale interest records without dumping business-data contents.
    const interestQuery = models.CallWaitInterest?.countDocuments?.({ guildId: guild.id, status: { $in: ["pending", "active", "joining"] } });
    const interestCount = interestQuery ? await interestQuery.catch(() => null) : null;
    modules.recruitment.details.activeInterestCount = interestCount;
    const bosyuQuery = models.BosyuEditSession?.countDocuments?.({ guildId: guild.id });
    const bosyuCount = bosyuQuery ? await bosyuQuery.catch(() => null) : null;
    modules.recruitment.details.pendingQuickRecruitments = bosyuCount;
  } catch (error) {
    unknownModule = true;
    modules.recruitment = makeModule({ key: "recruitment", label: "定時募集・ボタン募集", summary: "状態を取得できません。", issues: [issue("read_failed", truncate(error?.message ?? error), true)], unknown: true });
  }

  try {
    if (db.status !== "connected") throw new Error(`MongoDB is ${db.status}`);
    const themes = await readOne(models.FukyoThemeState, { guildId: guild.id });
    const weekly = await readMany(models.FukyoWeeklyPost, { guildId: guild.id }, { createdAt: -1 }, 8);
    const bump = await readMany(models.BumpReminder, { guildId: guild.id, dueAt: { $gte: new Date(now.getTime() - 24 * 60 * 60 * 1000) } }, { dueAt: 1 });
    const failedActionFilter = { guildId: guild.id, status: "failed", updatedAt: { $gte: new Date(now.getTime() - INCIDENT_LOOKBACK_MS) } };
    const [activeActions, failedActions, pendingActionCount, runningActionCount, failedActionCount] = await Promise.all([
      readMany(models.ScheduledAction, { guildId: guild.id, status: { $in: ACTIVE_ACTION_STATUSES } }, { executeAt: 1 }),
      readMany(models.ScheduledAction, failedActionFilter, { updatedAt: -1 }, 20),
      readCount(models.ScheduledAction, { guildId: guild.id, status: "pending" }),
      readCount(models.ScheduledAction, { guildId: guild.id, status: "running" }),
      readCount(models.ScheduledAction, failedActionFilter),
    ]);
    const scheduledActionCounts = {
      pending: pendingActionCount ?? activeActions.filter((action) => action.status === "pending").length,
      running: runningActionCount ?? activeActions.filter((action) => action.status === "running").length,
      failed: failedActionCount ?? failedActions.length,
    };
    const scheduledActionCount = scheduledActionCounts.pending + scheduledActionCounts.running + scheduledActionCounts.failed;
    const enabled = settings?.fukyoWeeklyThemeEnabled === true;
    const issues = [];
    if (enabled && !settings?.fukyoThemeChannelId) issues.push(issue("fukyo_channel_missing", "布教テーマ自動投稿は有効ですが送信先がありません。", true));
    const recentWeekly = weekly[0] ?? null;
    const failedWeekly = recentWeekly?.status === "failed" ? [recentWeekly] : [];
    if (scheduledActionCounts.failed) issues.push(issue("scheduled_action_failed", `永続スケジュール処理の失敗が${scheduledActionCounts.failed}件あります。`, true));
    if (failedWeekly.length) issues.push(issue("fukyo_weekly_failed", `Fukyo weekly post failures: ${failedWeekly.length}`, true));
    const overdueBump = bump.filter((item) => ageMs(item.dueAt, now.getTime()) > 5 * 60 * 1000);
    if (overdueBump.length) issues.push(issue("bump_reminder_overdue", `期限を5分以上過ぎたBumpリマインダーが${overdueBump.length}件あります。`, true));
    modules.automation = makeModule({
      key: "automation",
      label: "自動投稿",
      summary: enabled ? `布教テーマ有効 / テーマ ${themes?.usedThemeIds?.length ? "利用履歴あり" : "未使用"} / 永続処理 ${scheduledActionCount}件` : bump.length ? `Bumpリマインダー ${bump.length}件 / 永続処理 ${scheduledActionCount}件` : scheduledActionCount ? `永続スケジュール処理 ${scheduledActionCount}件` : "自動投稿は未設定です。",
      details: { fukyoEnabled: enabled, fukyoChannelId: settings?.fukyoThemeChannelId ?? null, availableThemeCount: settings?.fukyoThemes?.length ?? 0, lastWeeklyPost: recentWeekly ? { status: recentWeekly.status, weekKey: recentWeekly.weekKey, finishedAt: recentWeekly.finishedAt, reason: recentWeekly.reason } : null, bumpReminderCount: bump.length, nextBumpAt: bump[0]?.dueAt ?? null, scheduledActionCounts, nextScheduledActionAt: activeActions[0]?.executeAt ?? null, failedScheduledActions: failedActions.map((action) => ({ actionKey: action.actionKey, type: action.type, executeAt: action.executeAt, lastError: action.lastError })) },
      issues,
      disabled: !enabled && bump.length === 0 && scheduledActionCount === 0,
      inProgress: weekly.some((item) => item.status === "executing") || bump.length > 0 || scheduledActionCounts.pending > 0 || scheduledActionCounts.running > 0,
    });
  } catch (error) {
    unknownModule = true;
    modules.automation = makeModule({ key: "automation", label: "自動投稿", summary: "状態を取得できません。", issues: [issue("read_failed", truncate(error?.message ?? error), true)], unknown: true });
  }

  try {
    if (db.status !== "connected") throw new Error(`MongoDB is ${db.status}`);
    const profilePanel = await readOne(models.ProfileRegistrationPanel, { guildId: guild.id });
    const vcPanelCount = await readCount(models.VoiceChannelControl, { guildId: guild.id }).catch(() => null);
    const targetVoiceChannels = [...(guild.channels?.cache?.values?.() ?? [])]
      .filter((channel) => isVoiceChannelControlTarget(channel, settings));
    const targetVoiceChannelIds = new Set(targetVoiceChannels.map((channel) => channel.id));
    // Query the configured target IDs when possible so stale records for
    // deleted or out-of-category channels cannot satisfy the target count.
    const panelFilter = targetVoiceChannelIds.size > 0
      ? { guildId: guild.id, channelId: { $in: [...targetVoiceChannelIds] } }
      : { guildId: guild.id };
    const vcPanels = await readMany(
      models.VoiceChannelControl,
      panelFilter,
      null,
      Math.max(MAX_STATUS_RECORDS, targetVoiceChannelIds.size),
    );
    const targetVcPanels = vcPanels.filter((panel) => targetVoiceChannelIds.has(panel?.channelId));
    const storedVcPanelCount = vcPanelCount ?? vcPanels.length;
    const profilePresence = profilePanel ? await verifyPanelMessage(guild, profilePanel.channelId, profilePanel.messageId, panelPresenceCache) : null;
    const vcPresence = await mapWithConcurrency(
      targetVcPanels,
      PANEL_VERIFY_CONCURRENCY,
      (panel) => verifyPanelMessage(guild, panel.channelId, panel.panelMessageId, panelPresenceCache),
    );
    const issues = [];
    if (settings?.profileIntroductionChannelId && !profilePanel) issues.push(issue("profile_panel_missing", "プロフィール登録パネルの保存情報がありません。", false));
    if (profilePanel && settings?.profileIntroductionChannelId && profilePanel.channelId !== settings.profileIntroductionChannelId
      && profilePresence?.checked === true && profilePresence.status !== "unknown") {
      issues.push(issue("profile_panel_channel_mismatch", "保存済みプロフィール登録パネルの設置先が現在の設定と一致しません。", false));
    }
    const persistedTargetIds = new Set(targetVcPanels.map((panel) => panel.channelId));
    const missingTargetPanelIds = targetVoiceChannels
      .map((channel) => channel.id)
      .filter((channelId) => !persistedTargetIds.has(channelId));
    if (settings?.vcControlCategoryId && missingTargetPanelIds.length > 0) {
      issues.push(issue("vc_panel_missing", `対象VC ${missingTargetPanelIds.length}件のコントロールパネル保存情報がありません。`, false));
    }
    if (profilePresence?.checked && profilePresence.exists === false) issues.push(issue("profile_panel_message_missing", "プロフィール登録パネルのDiscordメッセージを確認できません。", false));
    const missingVcPanels = vcPresence.filter((presence) => presence.checked && presence.exists === false);
    const incompleteVcPanels = targetVcPanels.filter((panel) => !panel?.panelMessageId);
    if (missingVcPanels.length || incompleteVcPanels.length) {
      issues.push(issue("vc_panel_message_missing", `VCコントロールパネルのDiscordメッセージを${missingVcPanels.length + incompleteVcPanels.length}件確認できません。`, false));
    }
    const unknownPanelChecks = [profilePresence, ...vcPresence].filter((presence) => presence?.status === "unknown");
    if (unknownPanelChecks.length) issues.push(issue("panel_check_failed", `Discord APIの一時エラーにより常設パネルを${unknownPanelChecks.length}件確認できません。`, false));
    const repairableIssueCodes = new Set(["profile_panel_missing", "profile_panel_channel_mismatch", "vc_panel_missing", "profile_panel_message_missing", "vc_panel_message_missing"]);
    modules.panels = makeModule({
      key: "panels",
      label: "常設パネル",
      summary: `プロフィール ${profilePanel ? "1" : "0"}件 / VCコントロール ${targetVcPanels.length}/${targetVoiceChannels.length}件`,
      details: { profile: profilePanel ? { channelId: profilePanel.channelId, messageId: profilePanel.messageId, updatedAt: profilePanel.updatedAt, discordMessageExists: profilePresence?.checked ? profilePresence.exists : null } : null, voiceControlCount: storedVcPanelCount, targetVoiceControlCount: targetVoiceChannels.length, persistedTargetVoiceControlCount: targetVcPanels.length, ignoredStoredVoiceControlCount: Math.max(0, storedVcPanelCount - targetVcPanels.length), missingTargetVoiceChannelIds: missingTargetPanelIds, verifiedVoiceControlCount: targetVcPanels.length, verificationTruncated: false, voiceControls: targetVcPanels.map((panel, index) => ({ channelId: panel.channelId, messageId: panel.panelMessageId, updatedAt: panel.updatedAt, discordMessageExists: vcPresence[index]?.checked ? vcPresence[index].exists : null })) },
      issues,
      disabled: !settings?.profileIntroductionChannelId && !settings?.vcControlCategoryId,
      availableActions: issues.some((item) => repairableIssueCodes.has(item.code)) ? ["reinstall_panels"] : [],
    });
  } catch (error) {
    unknownModule = true;
    modules.panels = makeModule({ key: "panels", label: "常設パネル", summary: "状態を取得できません。", issues: [issue("read_failed", truncate(error?.message ?? error), true)], unknown: true });
  }

  try {
    if (db.status !== "connected") throw new Error(`MongoDB is ${db.status}`);
    const [failedGrants, schedules, sessions, activeGrantCount, removingGrantCount, failedGrantCount, scheduleCount] = await Promise.all([
      readMany(models.VoiceParticipantRoleGrant, { guildId: guild.id, status: "failed" }, { updatedAt: -1 }, 20),
      readMany(models.VoiceExitSchedule, { guildId: guild.id, status: { $in: ["scheduled", "executing"] } }, { scheduledAt: 1 }),
      readMany(models.SplitProcessSession, { guildId: guild.id, status: { $in: OBSERVED_SPLIT_STATUSES } }),
      readCount(models.VoiceParticipantRoleGrant, { guildId: guild.id, status: "active" }),
      readCount(models.VoiceParticipantRoleGrant, { guildId: guild.id, status: "removing" }),
      readCount(models.VoiceParticipantRoleGrant, { guildId: guild.id, status: "failed" }),
      readCount(models.VoiceExitSchedule, { guildId: guild.id, status: { $in: ["scheduled", "executing"] } }),
    ]);
    const roleGrantCounts = {
      active: activeGrantCount ?? 0,
      removing: removingGrantCount ?? 0,
      failed: failedGrantCount ?? failedGrants.length,
    };
    const totalRoleGrantCount = roleGrantCounts.active + roleGrantCounts.removing + roleGrantCounts.failed;
    const totalScheduleCount = scheduleCount ?? schedules.length;
    const activeSessions = sessions.filter((session) => ACTIVE_SPLIT_STATUSES.includes(session.status));
    const issues = [];
    if (settings?.gatheringVcRestorePending) issues.push(issue("gathering_vc_restore_pending", "集合VC権限の復元待ちです。", true));
    if (roleGrantCounts.failed) issues.push(issue("role_cleanup_failed", `参加者ロール解除失敗が${roleGrantCounts.failed}件あります。`, true));
    const activeMonitors = activeSessions.filter((session) => session.waitingMonitorStatus && ["active", "extended", "closing"].includes(session.waitingMonitorStatus));
    const staleMonitors = activeMonitors.filter((session) => ageMs(session.waitingMonitorHeartbeatAt ?? session.updatedAt) > 3 * 60 * 1000);
    if (staleMonitors.length) issues.push(issue("voice_monitor_stale", `VC監視ハートビートが3分以上更新されていないセッションが${staleMonitors.length}件あります。`, true));
    const inMemoryVoiceMonitors = (getVoiceMonitorSessions() ?? []).filter((session) => session?.guildId === guild.id);
    for (let index = issues.length - 1; index >= 0; index -= 1) {
      if (issues[index].code === "gathering_vc_restore_pending") issues.splice(index, 1);
    }
    modules.voice = makeModule({
      key: "voice",
      label: "VC・ロール",
      summary: `退出予定 ${totalScheduleCount}件 / ロール処理 ${totalRoleGrantCount}件 / 復元待ち ${settings?.gatheringVcRestorePending ? "あり" : "なし"}`,
      details: { gatheringVcRestorePending: settings?.gatheringVcRestorePending === true, hasPermissionSnapshot: Boolean(settings?.gatheringVcPermissionBeforeOpen), roleGrantCounts, failedRoleGrants: failedGrants.map((grant) => ({ memberId: grant.memberId, roleId: grant.roleId, lastError: grant.lastError })), exitScheduleCount: totalScheduleCount, nextExitScheduleAt: schedules[0]?.scheduledAt ?? null, activeVoiceMonitorCount: activeMonitors.length + inMemoryVoiceMonitors.length, staleVoiceMonitorCount: staleMonitors.length },
      issues,
      disabled: false,
      inProgress: totalRoleGrantCount > 0 || totalScheduleCount > 0 || activeSessions.length > 0,
      availableActions: [
        ...(roleGrantCounts.failed ? ["remove_participant_roles"] : []),
      ],
    });
  } catch (error) {
    unknownModule = true;
    modules.voice = makeModule({ key: "voice", label: "VC・ロール", summary: "状態を取得できません。", issues: [issue("read_failed", truncate(error?.message ?? error), true)], unknown: true });
  }

  if (getVcDmStatus) {
    try {
      modules.vcDm = await getVcDmStatus(guild, { settings });
    } catch (error) {
      unknownModule = true;
      modules.vcDm = makeModule({
        key: "vcDm",
        label: "VC未参加者DM",
        summary: "VC未参加者DMの状態を取得できません。",
        issues: [issue("read_failed", truncate(error?.message ?? error), true)],
        unknown: true,
      });
    }
  }

  if (settingsReadFailed) {
    const settingsIssue = issue("settings_unavailable", `GuildSettings could not be read${settingsReadError ? `: ${settingsReadError}` : ""}`, true, null, "settings_unavailable");
    for (const key of ["kokuchi", "recruitment", "automation", "panels", "voice", "vcDm"]) {
      const module = modules[key];
      if (!module) continue;
      module.issues = [...(module.issues ?? []), settingsIssue];
      module.blocking = true;
      module.severity = "unknown";
      module.summary = truncate(`${module.summary} GuildSettings is unavailable.`);
    }
    unknownModule = true;
  }
  const allIssues = Object.values(modules).flatMap((module) => module.issues ?? []);
  const uniqueIssues = [...new Map(allIssues.map((item) => {
    const rootCauseId = item.rootCauseId
      ?? (["database_unavailable", "health_state_read_failed", "board_state_read_failed"].includes(item.code)
        || (item.code === "read_failed" && /^MongoDB is /i.test(item.message ?? ""))
        ? "database_unavailable"
        : item.code === "settings_unavailable"
          ? "settings_unavailable"
          : `${item.code}:${item.message}`);
    return [rootCauseId, item];
  })).values()];
  const actions = [...new Set(Object.values(modules).flatMap((module) => module.availableActions ?? []))];
  const snapshotStatus = unknownModule ? "partial" : "success";
  const snapshot = {
    guildId: guild.id,
    observedAt: now.toISOString(),
    modules,
    system: modules.system,
    issues: allIssues,
    attentionCount: uniqueIssues.filter((item) => item.blocking).length,
    recommendationCount: uniqueIssues.filter((item) => !item.blocking).length,
    rootCauseCount: uniqueIssues.length,
    availableActions: actions,
  };
  // Reconciliation uses this snapshot as a strictly read-only observation.
  // Preserve the historical default write for status-board/manual callers,
  // while allowing explicit callers to suppress the health-state update.
  const healthWrite = options.persistHealth === false || db.status === "disconnected" ? null : models.OperationalHealthState?.findOneAndUpdate?.(
    { guildId: guild.id },
    { $set: { databaseStatus: db.status, lastDatabaseCheckAt: now, lastDatabaseError: db.error ?? null, lastSnapshotStatus: snapshotStatus, lastSnapshotError: unknownModule ? "One or more operational modules could not be read" : null }, $setOnInsert: { guildId: guild.id } },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
  );
  if (healthWrite?.catch) await healthWrite.catch(() => {});
  return snapshot;
}

export function createOperationalStatusService({ getGuildSettings, client, getStartupState, getVoiceMonitorSessions, getVcDmStatus, models: injectedModels = {}, getDatabaseStatus: getDatabaseStatusOverride } = {}) {
  const models = { ...defaultModels, ...injectedModels };
  const panelPresenceCache = new Map();
  if (Object.keys(injectedModels).length > 0) {
    if (!("OteboRecruitmentPanel" in injectedModels)) models.OteboRecruitmentPanel = null;
    if (!("CallWaitRoleGeneration" in injectedModels)) models.CallWaitRoleGeneration = null;
  }
  const dependencies = { getGuildSettings, client, getStartupState, getVoiceMonitorSessions, getVcDmStatus, models, getDatabaseStatus: getDatabaseStatusOverride, panelPresenceCache };

  async function getOperationalStatusSnapshot(guild, options = {}) {
    if (!guild?.id) throw new Error("A guild is required to build an operational status snapshot.");
    const snapshotDependencies = options.refreshPanelPresence
      ? { ...dependencies, panelPresenceCache: null }
      : dependencies;
    return withTimeout(collectSnapshot(guild, snapshotDependencies, options), SNAPSHOT_BUILD_TIMEOUT_MS, "Operational status snapshot");
  }

  async function recordStartupRestore({ results = [], completedAt = new Date() } = {}) {
    const failures = results.filter((result) => result.status === "rejected").map((result) => ({ name: result.name ?? "restore", error: truncate(result.reason?.message ?? result.reason) }));
    const status = failures.length === 0 ? "success" : failures.length < results.length ? "partial" : "failed";
    await Promise.all((client?.guilds?.cache?.values?.() ?? []).map((guild) => models.OperationalHealthState.findOneAndUpdate(
      { guildId: guild.id },
      { $set: { startupRestoreStatus: status, startupRestoreFailures: failures, startupRestoreCompletedAt: completedAt }, $setOnInsert: { guildId: guild.id } },
      { upsert: true, setDefaultsOnInsert: true },
    ).catch(() => null)));
    return { status, failures };
  }

  return {
    getOperationalStatusSnapshot,
    recordStartupRestore,
    moduleKeys: MODULE_KEYS,
  };
}

export async function getOperationalStatusSnapshot(guild, dependencies, options = {}) {
  if (!dependencies?.getGuildSettings) throw new Error("getGuildSettings is required.");
  const injectedModels = dependencies.models ?? {};
  const models = { ...defaultModels, ...injectedModels };
  if (Object.keys(injectedModels).length > 0) {
    if (!("OteboRecruitmentPanel" in injectedModels)) models.OteboRecruitmentPanel = null;
    if (!("CallWaitRoleGeneration" in injectedModels)) models.CallWaitRoleGeneration = null;
  }
  return withTimeout(
    collectSnapshot(guild, { ...dependencies, models, panelPresenceCache: dependencies.panelPresenceCache ?? new Map() }, options),
    SNAPSHOT_BUILD_TIMEOUT_MS,
    "Operational status snapshot",
  );
}

export { makeModule };
