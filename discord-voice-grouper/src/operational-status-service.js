import mongoose from "mongoose";
import { BumpReminder } from "./models/bump-reminder.js";
import { BosyuEditSession } from "./models/bosyu-state.js";
import { CallWaitInterest } from "./models/call-wait-interest.js";
import { FukyoThemeState } from "./models/fukyo-theme-state.js";
import { FukyoWeeklyPost } from "./models/fukyo-weekly-post.js";
import { KokuchiReservation } from "./models/kokuchi-reservation.js";
import { OperationalHealthState } from "./models/operational-health-state.js";
import { OperationalStatusBoard } from "./models/operational-status-board.js";
import { ProfileRegistrationPanel } from "./models/profile-registration-panel.js";
import { ScheduledAction } from "./models/scheduled-action.js";
import { SplitProcessSession } from "./models/split-process-session.js";
import { VoiceChannelControl } from "./models/voice-channel-control.js";
import { VoiceExitSchedule } from "./models/voice-exit-schedule.js";
import { VoiceParticipantRoleGrant } from "./models/voice-participant-role-grant.js";

const ACTIVE_KOKUCHI_STATUSES = ["pending", "processing", "canceling", "cancel_partial", "sent", "published_unconfirmed", "failed"];
const ACTIVE_SPLIT_STATUSES = ["active", "finish_notice_pending", "role_remove_pending", "cleaning_up", "feedback_open"];
const OBSERVED_SPLIT_STATUSES = [...ACTIVE_SPLIT_STATUSES, "failed", "cleanup_required"];
const ACTIVE_ACTION_STATUSES = ["pending", "running"];
const EXPIRED_PROMPT_STATES = ["active", "open", "pending", "processing", "evaluating", "role_granting", "failed"];
const MODULE_KEYS = ["system", "kokuchi", "splitvc", "recruitment", "automation", "panels", "voice"];

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

async function resolveQuery(query) {
  if (!query) return [];
  return typeof query.lean === "function" ? query.lean() : query;
}

async function readMany(model, filter = {}, sort = null) {
  if (!model?.find) return [];
  let query = model.find(filter);
  if (sort && typeof query.sort === "function") query = query.sort(sort);
  return (await resolveQuery(query)) ?? [];
}

async function readOne(model, filter = {}) {
  if (!model?.findOne) return null;
  return resolveQuery(model.findOne(filter));
}

async function verifyPanelMessage(guild, channelId, messageId) {
  if (!guild?.channels?.fetch || !channelId || !messageId) return { checked: false, exists: false, channelId, messageId };
  try {
    const channel = guild.channels.cache?.get(channelId) ?? await guild.channels.fetch(channelId).catch(() => null);
    if (!channel?.messages?.fetch) return { checked: true, exists: false, channelId, messageId };
    const message = channel.messages.cache?.get(messageId) ?? await channel.messages.fetch(messageId).catch(() => null);
    return { checked: true, exists: Boolean(message), channelId, messageId };
  } catch (error) {
    return { checked: true, exists: false, channelId, messageId, error: truncate(error?.message ?? error) };
  }
}

function issue(code, message, blocking = false) {
  return { code, message, blocking };
}

function makeModule({ key, label, summary, details = {}, issues = [], unknown = false, disabled = false, inProgress = false, availableActions = [] }) {
  const blocking = issues.some((item) => item.blocking === true);
  const severity = unknown
    ? "unknown"
    : blocking
      ? "error"
      : issues.length > 0
        ? "warning"
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
    if (admin?.ping) await admin.ping();
    return { status: "connected", error: null };
  } catch (error) {
    return { status: "degraded", error: truncate(error?.message ?? error) };
  }
}

function isReady(client) {
  return Boolean(client?.isReady?.() ?? client?.readyAt);
}

async function collectSnapshot(guild, dependencies) {
  const {
    getGuildSettings,
    client,
    getStartupState = () => ({}),
    getVoiceMonitorSessions = () => [],
    models,
    getDatabaseStatus: getDatabaseStatusOverride,
  } = dependencies;
  const db = { ...(await getDatabaseStatus(getDatabaseStatusOverride)) };
  const now = new Date();
  const health = db.status === "disconnected" ? null : await readOne(models.OperationalHealthState, { guildId: guild.id }).catch(() => null);
  const board = db.status === "disconnected" ? null : await readOne(models.OperationalStatusBoard, { guildId: guild.id }).catch(() => null);
  const startup = getStartupState() ?? {};
  const systemIssues = [];
  if (!isReady(client)) systemIssues.push(issue("discord_not_ready", "Discord接続がreadyではありません。", true));
  if (db.status !== "connected") systemIssues.push(issue("database_unavailable", `MongoDB状態: ${db.status}${db.error ? ` (${db.error})` : ""}`, true));
  if (startup.restoreFailed || ["failed", "partial"].includes(health?.startupRestoreStatus)) {
    systemIssues.push(issue("startup_restore_failed", "起動時復元処理に失敗または一部失敗があります。", false));
  }
  if (board?.lastSuccessfulRefreshAt && ageMs(board.lastSuccessfulRefreshAt, now.getTime()) > 2 * 60 * 60 * 1000) {
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
    system.issues.push(settingsIssue);
    system.blocking = true;
    system.severity = "error";
    system.summary = truncate(`${system.summary} ${settingsIssue.message}`);
  }

  const modules = { system };
  let unknownModule = false;

  try {
    if (db.status !== "connected") throw new Error(`MongoDB is ${db.status}`);
    const reservations = await readMany(models.KokuchiReservation, {
      guildId: guild.id,
      status: { $in: ACTIVE_KOKUCHI_STATUSES },
    }, { updatedAt: -1 });
    const currentId = settings?.kokuchiEventId;
    const current = currentId
      ? reservations.find((item) => item.reservationId === currentId)
      : reservations.length === 1 ? reservations[0] : null;
    const ambiguousCandidates = !current && reservations.length > 1;
    const kokuchiIssues = [];
    const actions = [];
    const states = {
      preNotice: settings?.kokuchiPreNoticeState ?? null,
      gatheringUnlock: settings?.gatheringVcUnlockState ?? null,
      gatheringReminder: settings?.kokuchiGatheringReminderState ?? null,
      restorePending: settings?.gatheringVcRestorePending === true,
    };
    if (settings?.gatheringVcRestorePending === true) {
      kokuchiIssues.push(issue("gathering_vc_restore_pending", "集合VCの権限復元待ちです。新規kokuchiを停止しています。", true));
      actions.push("restore_gathering_vc");
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
    if (current || settings?.kokuchiEventId || settings?.gatheringVcRestorePending || ambiguousCandidates) actions.push("kokuchi_cancel", "kokuchi_force_terminate");
    if (settings?.gatheringVcRestorePending
      && !settings?.gatheringVcPermissionBeforeOpen
      && health?.lastRecoveryFailureAction === "kokuchi_force_terminate") actions.push("kokuchi_clear_state");
    modules.kokuchi = makeModule({
      key: "kokuchi",
      label: "kokuchi",
      summary: current ? `${current.status} / ${current.eventAt ? new Date(current.eventAt).toLocaleString("ja-JP") : "開催日時未設定"}` : ambiguousCandidates ? `複数の開催回候補 ${reservations.length}件。候補選択が必要です。` : settings?.kokuchiEventId ? "現在開催回の孤立状態を検出" : "待機中です。",
      details: {
        currentEventId: settings?.kokuchiEventId ?? current?.reservationId ?? null,
        eventAt: settings?.kokuchiEventAt ?? current?.eventAt ?? null,
        reservation: current ? {
          reservationId: current.reservationId,
          status: current.status,
          publicationStatus: current.publicationStatus,
          postProcessingStatus: current.postProcessingStatus,
          reminderStatus: current.reminderStatus,
        } : null,
        states,
        candidateCount: reservations.length,
        candidates: reservations.slice(0, 25).map((item) => ({ reservationId: item.reservationId, eventAt: item.eventAt, status: item.status })),
        newKokuchiBlocked: Boolean(settings?.gatheringVcRestorePending || kokuchiIssues.some((item) => item.blocking)),
      },
      issues: kokuchiIssues,
      disabled: !settings?.kokuchiAnnouncementChannelId && !current && !settings?.kokuchiEventId,
      inProgress: Boolean(current && ["pending", "processing", "sent"].includes(current.status)),
      availableActions: actions,
    });
  } catch (error) {
    unknownModule = true;
    modules.kokuchi = makeModule({ key: "kokuchi", label: "kokuchi", summary: "状態を取得できません。", details: {}, issues: [issue("read_failed", truncate(error?.message ?? error), true)], unknown: true });
  }

  try {
    if (db.status !== "connected") throw new Error(`MongoDB is ${db.status}`);
    const sessions = await readMany(models.SplitProcessSession, { guildId: guild.id, status: { $in: OBSERVED_SPLIT_STATUSES } }, { updatedAt: -1 });
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
      disabled: sessions.length === 0,
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
    const expiredPrompt = prompt && asDate(prompt.targetAt)?.getTime() <= Date.now() && EXPIRED_PROMPT_STATES.includes(prompt.lifecycleState ?? "active");
    const expiredOtebo = otebo.filter((item) => asDate(item.targetAt)?.getTime() <= Date.now() && item.status === "active");
    const uncertainOtebo = otebo.filter((item) => ["publishing", "published_unconfirmed"].includes(item.status));
    const pendingOteboCleanup = otebo.filter((item) => ["success_processing", "success_notified", "cleanup_pending", "failed"].includes(item.status));
    const issues = [];
    if (expiredPrompt || expiredOtebo.length) issues.push(issue("expired_recruitment", `期限切れの募集が${Number(Boolean(expiredPrompt)) + expiredOtebo.length}件あります。`, true));
    if (uncertainOtebo.length) issues.push(issue("otebo_publication_uncertain", `送信結果未確認のお手軽募集が${uncertainOtebo.length}件あります。自動削除は行いません。`, false));
    if (pendingOteboCleanup.length) issues.push(issue("otebo_cleanup_pending", `Otebo success cleanup is incomplete: ${pendingOteboCleanup.length}`, true));
    const actions = expiredPrompt || expiredOtebo.length ? ["close_expired_recruitments"] : [];
    modules.recruitment = makeModule({
      key: "recruitment",
      label: "定時募集・お手軽募集",
      summary: settings?.callWaitEnabled ? `定時募集有効 / 現在募集 ${prompt ? 1 : 0}件 / お手軽募集 ${otebo.length}件` : "定時募集は無効です。",
      details: { enabled: settings?.callWaitEnabled === true, currentPrompt: prompt ? { messageId: prompt.messageId, lifecycleState: prompt.lifecycleState, memberCount: prompt.memberIds?.length ?? 0, targetAt: prompt.targetAt } : null, otebo: otebo.map((item) => ({ id: item.id, status: item.status, memberCount: item.memberIds?.length ?? 0, targetAt: item.targetAt, publishedToNotice: item.publishedToNotice })) },
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
    modules.recruitment = makeModule({ key: "recruitment", label: "定時募集・お手軽募集", summary: "状態を取得できません。", issues: [issue("read_failed", truncate(error?.message ?? error), true)], unknown: true });
  }

  try {
    if (db.status !== "connected") throw new Error(`MongoDB is ${db.status}`);
    const themes = await readOne(models.FukyoThemeState, { guildId: guild.id });
    const weekly = await readMany(models.FukyoWeeklyPost, { guildId: guild.id }, { createdAt: -1 });
    const bump = await readMany(models.BumpReminder, { guildId: guild.id }, { dueAt: 1 });
    const scheduledActions = await readMany(models.ScheduledAction, { guildId: guild.id, status: { $in: [...ACTIVE_ACTION_STATUSES, "failed"] } }, { executeAt: 1 });
    const enabled = settings?.fukyoWeeklyThemeEnabled === true;
    const issues = [];
    if (enabled && !settings?.fukyoThemeChannelId) issues.push(issue("fukyo_channel_missing", "布教テーマ自動投稿は有効ですが送信先がありません。", true));
    const failedActions = scheduledActions.filter((action) => action.status === "failed");
    const failedWeekly = weekly.filter((item) => item.status === "failed");
    if (failedActions.length) issues.push(issue("scheduled_action_failed", `永続スケジュール処理の失敗が${failedActions.length}件あります。`, true));
    if (failedWeekly.length) issues.push(issue("fukyo_weekly_failed", `Fukyo weekly post failures: ${failedWeekly.length}`, true));
    const recentWeekly = weekly[0] ?? null;
    modules.automation = makeModule({
      key: "automation",
      label: "自動投稿",
      summary: enabled ? `布教テーマ有効 / テーマ ${themes?.usedThemeIds?.length ? "利用履歴あり" : "未使用"} / 永続処理 ${scheduledActions.length}件` : bump.length ? `Bumpリマインダー ${bump.length}件 / 永続処理 ${scheduledActions.length}件` : scheduledActions.length ? `永続スケジュール処理 ${scheduledActions.length}件` : "自動投稿は未設定です。",
      details: { fukyoEnabled: enabled, fukyoChannelId: settings?.fukyoThemeChannelId ?? null, availableThemeCount: settings?.fukyoThemes?.length ?? 0, lastWeeklyPost: recentWeekly ? { status: recentWeekly.status, weekKey: recentWeekly.weekKey, finishedAt: recentWeekly.finishedAt, reason: recentWeekly.reason } : null, bumpReminderCount: bump.length, nextBumpAt: bump[0]?.dueAt ?? null, scheduledActionCounts: { pending: scheduledActions.filter((action) => action.status === "pending").length, running: scheduledActions.filter((action) => action.status === "running").length, failed: failedActions.length }, nextScheduledActionAt: scheduledActions.find((action) => ACTIVE_ACTION_STATUSES.includes(action.status))?.executeAt ?? null, failedScheduledActions: failedActions.slice(0, 20).map((action) => ({ actionKey: action.actionKey, type: action.type, executeAt: action.executeAt, lastError: action.lastError })) },
      issues,
      disabled: !enabled && bump.length === 0 && scheduledActions.length === 0,
      inProgress: weekly.some((item) => item.status === "executing") || bump.length > 0 || scheduledActions.some((action) => ACTIVE_ACTION_STATUSES.includes(action.status)),
    });
  } catch (error) {
    unknownModule = true;
    modules.automation = makeModule({ key: "automation", label: "自動投稿", summary: "状態を取得できません。", issues: [issue("read_failed", truncate(error?.message ?? error), true)], unknown: true });
  }

  try {
    if (db.status !== "connected") throw new Error(`MongoDB is ${db.status}`);
    const profilePanel = await readOne(models.ProfileRegistrationPanel, { guildId: guild.id });
    const vcPanels = await readMany(models.VoiceChannelControl, { guildId: guild.id });
    const profilePresence = profilePanel ? await verifyPanelMessage(guild, profilePanel.channelId, profilePanel.messageId) : null;
    const vcPresence = await Promise.all(vcPanels.map((panel) => verifyPanelMessage(guild, panel.channelId, panel.panelMessageId)));
    const issues = [];
    if (settings?.profileIntroductionChannelId && !profilePanel) issues.push(issue("profile_panel_missing", "プロフィール登録パネルの保存情報がありません。", false));
    if (settings?.vcControlCategoryId && vcPanels.length === 0) issues.push(issue("vc_panel_missing", "VCコントロールパネルの保存情報がありません。", false));
    if (profilePresence?.checked && !profilePresence.exists) issues.push(issue("profile_panel_message_missing", "プロフィール登録パネルのDiscordメッセージを確認できません。", false));
    const missingVcPanels = vcPresence.filter((presence) => presence.checked && !presence.exists);
    if (missingVcPanels.length) issues.push(issue("vc_panel_message_missing", `VCコントロールパネルのDiscordメッセージを${missingVcPanels.length}件確認できません。`, false));
    modules.panels = makeModule({
      key: "panels",
      label: "常設パネル",
      summary: `プロフィール ${profilePanel ? "1" : "0"}件 / VCコントロール ${vcPanels.length}件`,
      details: { profile: profilePanel ? { channelId: profilePanel.channelId, messageId: profilePanel.messageId, updatedAt: profilePanel.updatedAt, discordMessageExists: profilePresence?.checked ? profilePresence.exists : null } : null, voiceControls: vcPanels.map((panel, index) => ({ channelId: panel.channelId, messageId: panel.panelMessageId, updatedAt: panel.updatedAt, discordMessageExists: vcPresence[index]?.checked ? vcPresence[index].exists : null })) },
      issues,
      disabled: !settings?.profileIntroductionChannelId && !settings?.vcControlCategoryId,
      availableActions: issues.length ? ["reinstall_panels"] : [],
    });
  } catch (error) {
    unknownModule = true;
    modules.panels = makeModule({ key: "panels", label: "常設パネル", summary: "状態を取得できません。", issues: [issue("read_failed", truncate(error?.message ?? error), true)], unknown: true });
  }

  try {
    if (db.status !== "connected") throw new Error(`MongoDB is ${db.status}`);
    const [grants, schedules, sessions] = await Promise.all([
      readMany(models.VoiceParticipantRoleGrant, { guildId: guild.id, status: { $in: ["active", "removing", "failed"] } }),
      readMany(models.VoiceExitSchedule, { guildId: guild.id, status: { $in: ["scheduled", "executing"] } }, { scheduledAt: 1 }),
      readMany(models.SplitProcessSession, { guildId: guild.id, status: { $in: OBSERVED_SPLIT_STATUSES } }),
    ]);
    const activeSessions = sessions.filter((session) => ACTIVE_SPLIT_STATUSES.includes(session.status));
    const failedGrants = grants.filter((grant) => grant.status === "failed");
    const issues = [];
    if (settings?.gatheringVcRestorePending) issues.push(issue("gathering_vc_restore_pending", "集合VC権限の復元待ちです。", true));
    if (failedGrants.length) issues.push(issue("role_cleanup_failed", `参加者ロール解除失敗が${failedGrants.length}件あります。`, true));
    const activeMonitors = activeSessions.filter((session) => session.waitingMonitorStatus && ["active", "extended", "closing"].includes(session.waitingMonitorStatus));
    const staleMonitors = activeMonitors.filter((session) => ageMs(session.waitingMonitorHeartbeatAt ?? session.updatedAt) > 3 * 60 * 1000);
    if (staleMonitors.length) issues.push(issue("voice_monitor_stale", `VC監視ハートビートが3分以上更新されていないセッションが${staleMonitors.length}件あります。`, true));
    const inMemoryVoiceMonitors = (getVoiceMonitorSessions() ?? []).filter((session) => session?.guildId === guild.id);
    modules.voice = makeModule({
      key: "voice",
      label: "VC・ロール",
      summary: `退出予定 ${schedules.length}件 / ロール処理 ${grants.length}件 / 復元待ち ${settings?.gatheringVcRestorePending ? "あり" : "なし"}`,
      details: { gatheringVcRestorePending: settings?.gatheringVcRestorePending === true, hasPermissionSnapshot: Boolean(settings?.gatheringVcPermissionBeforeOpen), roleGrantCounts: { active: grants.filter((grant) => grant.status === "active").length, removing: grants.filter((grant) => grant.status === "removing").length, failed: failedGrants.length }, failedRoleGrants: failedGrants.slice(0, 20).map((grant) => ({ memberId: grant.memberId, roleId: grant.roleId, lastError: grant.lastError })), exitScheduleCount: schedules.length, nextExitScheduleAt: schedules[0]?.scheduledAt ?? null, activeVoiceMonitorCount: activeMonitors.length + inMemoryVoiceMonitors.length, staleVoiceMonitorCount: staleMonitors.length },
      issues,
      disabled: grants.length === 0 && schedules.length === 0 && !settings?.gatheringVcRestorePending,
      inProgress: grants.length > 0 || schedules.length > 0 || activeSessions.length > 0,
      availableActions: [
        ...(settings?.gatheringVcRestorePending ? ["restore_gathering_vc"] : []),
        ...(failedGrants.length ? ["remove_participant_roles"] : []),
      ],
    });
  } catch (error) {
    unknownModule = true;
    modules.voice = makeModule({ key: "voice", label: "VC・ロール", summary: "状態を取得できません。", issues: [issue("read_failed", truncate(error?.message ?? error), true)], unknown: true });
  }

  if (settingsReadFailed) {
    const settingsIssue = issue("settings_unavailable", `GuildSettings could not be read${settingsReadError ? `: ${settingsReadError}` : ""}`, true);
    for (const key of ["kokuchi", "recruitment", "automation", "panels", "voice"]) {
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
  const actions = [...new Set(Object.values(modules).flatMap((module) => module.availableActions ?? []))];
  const snapshotStatus = unknownModule ? "partial" : "success";
  const snapshot = {
    guildId: guild.id,
    observedAt: now.toISOString(),
    modules,
    system: modules.system,
    issues: allIssues,
    attentionCount: allIssues.filter((item) => item.blocking).length,
    recommendationCount: allIssues.filter((item) => !item.blocking).length,
    availableActions: actions,
  };
  const healthWrite = db.status === "disconnected" ? null : models.OperationalHealthState?.findOneAndUpdate?.(
    { guildId: guild.id },
    { $set: { databaseStatus: db.status, lastDatabaseCheckAt: now, lastDatabaseError: db.error ?? null, lastSnapshotStatus: snapshotStatus, lastSnapshotError: unknownModule ? "One or more operational modules could not be read" : null }, $setOnInsert: { guildId: guild.id } },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
  );
  if (healthWrite?.catch) await healthWrite.catch(() => {});
  return snapshot;
}

export function createOperationalStatusService({ getGuildSettings, client, getStartupState, getVoiceMonitorSessions, models: injectedModels = {}, getDatabaseStatus: getDatabaseStatusOverride } = {}) {
  const models = { ...defaultModels, ...injectedModels };
  const dependencies = { getGuildSettings, client, getStartupState, getVoiceMonitorSessions, models, getDatabaseStatus: getDatabaseStatusOverride };

  async function getOperationalStatusSnapshot(guild) {
    if (!guild?.id) throw new Error("A guild is required to build an operational status snapshot.");
    return collectSnapshot(guild, dependencies);
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

export async function getOperationalStatusSnapshot(guild, dependencies) {
  if (!dependencies?.getGuildSettings) throw new Error("getGuildSettings is required.");
  return collectSnapshot(guild, { ...dependencies, models: { ...defaultModels, ...(dependencies.models ?? {}) } });
}

export { makeModule };
