import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { commands } from "../src/commands.js";
import { buildOperationalStatusPayload, createOperationalStatusBoardService } from "../src/operational-status-board-service.js";
import { createKokuchiRecoveryService } from "../src/kokuchi-recovery-service.js";
import { createOperationalManagementService } from "../src/operational-management-service.js";
import { createOperationalStatusService, makeModule } from "../src/operational-status-service.js";
import { extractRepairCandidates } from "../src/reconciliation-service.js";
import { startHealthServer } from "../src/health-server.js";

function emptyModel() {
  return {
    find: () => ({ lean: async () => [] }),
    findOne: () => ({ lean: async () => null }),
    findOneAndUpdate: async () => null,
  };
}

function emptyModels() {
  return Object.fromEntries([
    "BumpReminder", "BosyuEditSession", "CallWaitInterest", "FukyoThemeState", "FukyoWeeklyPost",
    "KokuchiReservation", "OperationalHealthState", "OperationalStatusBoard", "ProfileRegistrationPanel",
    "ScheduledAction", "SplitProcessSession", "VoiceChannelControl", "VoiceExitSchedule", "VoiceParticipantRoleGrant",
  ].map((name) => [name, emptyModel()]));
}

function readyClient() {
  return { isReady: () => true, user: { username: "bot" }, readyAt: new Date() };
}

test("運用ステータスは共通形式と6段階severityを持つ", () => {
  const module = makeModule({ key: "example", label: "例", summary: "確認", issues: [{ code: "x", message: "要確認", blocking: true }] });
  assert.deepEqual(Object.keys(module).sort(), ["availableActions", "blocking", "details", "issues", "key", "label", "observedAt", "severity", "summary"].sort());
  assert.equal(module.severity, "error");
  assert.equal(module.blocking, true);
});

test("ステータスボードは3 Embedと更新・詳細・管理操作を持つ", () => {
  const snapshot = {
    guildId: "123456789012345678",
    observedAt: "2026-08-01T00:00:00.000Z",
    attentionCount: 1,
    recommendationCount: 2,
    modules: Object.fromEntries(["system", "kokuchi", "splitvc", "recruitment", "automation", "panels", "voice"].map((key) => [key, makeModule({ key, label: key, summary: "正常" })])),
  };
  const payload = buildOperationalStatusPayload(snapshot);
  assert.equal(payload.embeds.length, 3);
  assert.equal(payload.embeds.every((embed) => embed.toJSON().footer?.text === "operational-status-board:v1"), true);
  assert.deepEqual(payload.components[0].components.map((button) => button.toJSON().custom_id), [
    "operational:refresh:123456789012345678",
    "operational:details:123456789012345678",
    "operational:manage:123456789012345678",
  ]);
});

test("/setting status_board と /botstatus の管理操作を登録する", () => {
  const setting = commands.find((command) => command.name === "setting");
  const statusBoard = setting.options.find((option) => option.name === "status_board");
  assert.ok(statusBoard);
  assert.equal(statusBoard.options.find((option) => option.name === "channel")?.type, 7);
  assert.equal(statusBoard.options.find((option) => option.name === "remove")?.type, 5);
  const botstatus = commands.find((command) => command.name === "botstatus");
  assert.deepEqual(botstatus.options.map((option) => option.name), ["show", "refresh", "manage"]);
});

test("kokuchi強制終了は権限復元失敗時にイベント状態を解除しない", async () => {
  let reservation = {
    _id: "reservation-db-id",
    reservationId: "reservation-id",
    guildId: "guild-id",
    status: "sent",
    eventAt: new Date("2026-08-01T12:00:00.000Z"),
  };
  const savedPatches = [];
  const model = {
    find: () => ({ sort: () => ({ lean: async () => [reservation] }) }),
    findOneAndUpdate: async (_filter, update) => {
      reservation = { ...reservation, status: update.$set?.status ?? reservation.status };
      return reservation;
    },
    updateOne: async () => ({ matchedCount: 1 }),
  };
  const service = createKokuchiRecoveryService({
    getGuildSettings: async () => ({ kokuchiEventId: "reservation-id", kokuchiEventAt: reservation.eventAt, gatheringVcUnlockState: "opened", gatheringVcRestorePending: true }),
    saveGuildSettings: async (_guildId, patch) => { savedPatches.push(patch); return patch; },
    acquireMongoLease: async () => ({ lockKey: "lease", ownerId: "owner" }),
    releaseMongoLease: async () => {},
    cancelTimedActions: async () => ({ canceled: 1, errors: [] }),
    cancelScheduledActions: async () => ({ canceled: 1, errors: [] }),
    restoreGatheringVcPermission: async () => false,
    getGatheringVcRestoreState: async () => ({ gatheringVcRestorePending: true, gatheringVcRestoreStatus: "pending" }),
    healthModel: { findOneAndUpdate: async () => null, updateOne: async () => null },
    reservationModel: model,
  });
  const result = await service.forceTerminate({ guild: { id: "guild-id" }, actorUserId: "admin-id" });
  assert.equal(result.status, "canceled");
  assert.equal(result.result, "success");
  assert.equal(savedPatches[0].kokuchiEventId, undefined);
  assert.equal(savedPatches[0].gatheringVcRestorePending, undefined);
  assert.equal(result.permissionRestored, "pending");
});

test("集合VCの手動復元は現在の告知がなくても未復元イベントを対象にできる", async () => {
  const pending = {
    _id: "restore-db-id",
    reservationId: "old-event-id",
    guildId: "guild-id",
    status: "canceled",
    gatheringVcRestorePending: true,
    gatheringVcRestoreStatus: "failed",
  };
  const calls = [];
  const model = {
    find: (filter) => ({
      sort: () => ({
        lean: async () => filter.gatheringVcRestorePending ? [pending] : [],
      }),
    }),
  };
  const service = createKokuchiRecoveryService({
    getGuildSettings: async () => ({ kokuchiEventId: null }),
    saveGuildSettings: async (_guildId, patch) => patch,
    acquireMongoLease: async () => ({ lockKey: "lease", ownerId: "owner" }),
    releaseMongoLease: async () => {},
    reservationModel: model,
    getGatheringVcRestoreState: async ({ eventId }) => ({ reservationId: eventId, gatheringVcRestorePending: true, gatheringVcRestoreStatus: "failed" }),
    restoreGatheringVcPermission: async (_guild, _settings, options) => { calls.push(options.eventId); return true; },
  });
  const result = await service.restorePermission({ guild: { id: "guild-id" } });
  assert.equal(result.status, "restored");
  assert.deepEqual(calls, ["old-event-id"]);
});

test("canceled retry_wait events remain explicit restoration candidates", async () => {
  const pending = {
    _id: "restore-db-id",
    reservationId: "canceled-event-id",
    guildId: "guild-id",
    status: "canceled",
    kokuchiStatus: "canceled",
    gatheringVcRestorePending: false,
    gatheringVcRestoreStatus: "retry_wait",
    gatheringVcPermissionBeforeOpen: { channelId: "vc", guildId: "guild-id", viewChannel: true, connect: null },
    gatheringVcUnlockChannelId: "vc",
  };
  const calls = [];
  const model = {
    find: (filter) => ({
      sort: () => ({
        lean: async () => filter.$or ? [pending] : [],
      }),
    }),
  };
  const service = createKokuchiRecoveryService({
    getGuildSettings: async () => ({ kokuchiEventId: null }),
    saveGuildSettings: async (_guildId, patch) => patch,
    acquireMongoLease: async () => ({ lockKey: "lease", ownerId: "owner" }),
    releaseMongoLease: async () => {},
    reservationModel: model,
    getGatheringVcRestoreState: async ({ reservation }) => reservation,
    restoreGatheringVcPermission: async (_guild, _settings, options) => { calls.push(options.eventId); return true; },
  });
  const result = await service.restorePermission({ guild: { id: "guild-id" } });
  assert.equal(result.status, "restored");
  assert.deepEqual(calls, ["canceled-event-id"]);
});

test("a canceled event with a missing snapshot supports state-only clearing", async () => {
  const reservation = {
    _id: "restore-db-id",
    reservationId: "canceled-event-id",
    guildId: "guild-id",
    status: "canceled",
    kokuchiStatus: "canceled",
    gatheringVcRestorePending: false,
    gatheringVcRestoreStatus: "retry_wait",
    gatheringVcPermissionBeforeOpen: null,
  };
  let updateFilter;
  const model = {
    findOne: async () => reservation,
    findOneAndUpdate: async (filter) => { updateFilter = filter; return { ...reservation, gatheringVcRestoreStatus: "restored", gatheringVcRestorePending: false }; },
  };
  const service = createKokuchiRecoveryService({
    getGuildSettings: async () => ({ kokuchiEventId: "new-event-id", gatheringVcStateEventId: "new-event-id" }),
    saveGuildSettings: async (_guildId, patch) => patch,
    acquireMongoLease: async () => ({ lockKey: "lease", ownerId: "owner" }),
    releaseMongoLease: async () => {},
    reservationModel: model,
    healthModel: { findOne: async () => null, updateOne: async () => ({ matchedCount: 1 }) },
  });
  const result = await service.clearStateOnly({
    guild: { id: "guild-id" },
    targetId: "canceled-event-id",
    confirmed: true,
    reason: "Administrator confirmed the current Discord permissions.",
  });
  assert.equal(result.status, "cleared");
  assert.match(result.warnings[0], /スナップショット欠損/);
  assert.equal(updateFilter._id, "restore-db-id");
  assert.deepEqual(result.after.settings, { kokuchiEventId: "new-event-id", gatheringVcStateEventId: "new-event-id" });
});

test("別イベントの未復元状態はステータス上で孤立状態として新規kokuchiをブロックする", async () => {
  const oldEvent = {
    reservationId: "old-event-id",
    guildId: "guild-id",
    status: "sent",
    kokuchiStatus: "completed",
    gatheringVcRestorePending: true,
    gatheringVcRestoreStatus: "retry_wait",
    gatheringVcRestoreNextRetryAt: new Date(Date.now() + 30_000),
    gatheringVcRestoreLastError: "temporary Discord failure",
  };
  const models = emptyModels();
  models.KokuchiReservation = {
    find: () => ({ sort: () => ({ lean: async () => [oldEvent] }) }),
  };
  const service = createOperationalStatusService({
    getGuildSettings: async () => ({
      kokuchiEventId: "new-event-id",
      gatheringVcStateEventId: "new-event-id",
      gatheringVcRestorePending: false,
    }),
    client: readyClient(),
    getDatabaseStatus: async () => ({ status: "connected", error: null }),
    models,
  });
  const snapshot = await service.getOperationalStatusSnapshot({ id: "guild-id", channels: { cache: new Map() } });
  const kokuchi = snapshot.modules.kokuchi;
  assert.equal(kokuchi.details.newKokuchiBlocked, true);
  assert.equal(kokuchi.details.gatheringVcRestore.eventId, "old-event-id");
  assert.equal(kokuchi.issues.some((item) => item.code === "orphaned_restore_state" && item.blocking), true);
  assert.equal(kokuchi.availableActions.includes("kokuchi_force_terminate"), false);
});

test("restore status and error details never fall back to a different current event", async () => {
  const oldEvent = {
    reservationId: "old-event-id",
    guildId: "guild-id",
    status: "canceled",
    kokuchiStatus: "canceled",
    gatheringVcRestorePending: true,
    gatheringVcRestoreStatus: "retry_wait",
    gatheringVcRestoreLastError: "old event retry error",
    gatheringVcRestoreNextRetryAt: new Date(Date.now() + 30_000),
    gatheringVcPermissionBeforeOpen: { channelId: "old-vc", guildId: "guild-id", viewChannel: true, connect: null },
    gatheringVcUnlockChannelId: "old-vc",
  };
  const models = emptyModels();
  models.KokuchiReservation = {
    find: () => ({ sort: () => ({ lean: async () => [oldEvent] }) }),
  };
  const service = createOperationalStatusService({
    getGuildSettings: async () => ({
      kokuchiEventId: "new-event-id",
      gatheringVcStateEventId: "new-event-id",
      gatheringVcRestorePending: false,
      gatheringVcRestoreStatus: "not_required",
      gatheringVcRestoreLastError: "new event error must not leak",
    }),
    client: readyClient(),
    getDatabaseStatus: async () => ({ status: "connected", error: null }),
    models,
  });
  const snapshot = await service.getOperationalStatusSnapshot({ id: "guild-id", channels: { cache: new Map() } });
  const restore = snapshot.modules.kokuchi.details.gatheringVcRestore;
  assert.equal(restore.eventId, "old-event-id");
  assert.equal(restore.lastError, "old event retry error");
  assert.notEqual(restore.lastError, "new event error must not leak");
});

test("pending=false retry_wait records are errors and expose state-only recovery when the snapshot is missing", async () => {
  const inconsistent = {
    reservationId: "event-id",
    guildId: "guild-id",
    status: "canceled",
    kokuchiStatus: "canceled",
    gatheringVcRestorePending: false,
    gatheringVcRestoreStatus: "retry_wait",
    gatheringVcPermissionBeforeOpen: null,
  };
  const models = emptyModels();
  models.KokuchiReservation = {
    find: () => ({ sort: () => ({ lean: async () => [inconsistent] }) }),
  };
  const service = createOperationalStatusService({
    getGuildSettings: async () => ({ kokuchiEventId: "event-id", gatheringVcStateEventId: "event-id" }),
    client: readyClient(),
    getDatabaseStatus: async () => ({ status: "connected", error: null }),
    models,
  });
  const snapshot = await service.getOperationalStatusSnapshot({ id: "guild-id", channels: { cache: new Map() } });
  assert.equal(snapshot.modules.kokuchi.issues.some((item) => item.code === "restore_state_inconsistent" && item.blocking), true);
  assert.equal(snapshot.modules.kokuchi.availableActions.includes("kokuchi_clear_state"), true);
});

test("kokuchi状態のみ解除は強制終了失敗後かつ権限スナップショットなしに限定する", async () => {
  const reservation = {
    _id: "reservation-db-id",
    reservationId: "reservation-id",
    guildId: "guild-id",
    status: "cancel_partial",
  };
  const model = {
    find: () => ({ sort: () => ({ lean: async () => [reservation] }) }),
    findOneAndUpdate: async () => ({ ...reservation, status: "canceled" }),
  };
  const healthModel = {
    findOne: async () => ({
      lastRecoveryFailureAt: new Date(),
      lastRecoveryFailureAction: "kokuchi_force_terminate",
    }),
    updateOne: async () => ({ matchedCount: 1 }),
  };
  let savedPatch = null;
  const service = createKokuchiRecoveryService({
    getGuildSettings: async () => ({ gatheringVcRestorePending: true, gatheringVcPermissionBeforeOpen: null }),
    saveGuildSettings: async (_guildId, patch) => { savedPatch = patch; return patch; },
    acquireMongoLease: async () => ({ lockKey: "lease", ownerId: "owner" }),
    releaseMongoLease: async () => {},
    healthModel,
    reservationModel: model,
  });
  const result = await service.clearStateOnly({ guild: { id: "guild-id" }, confirmed: true, reason: "権限を手動確認済み" });
  assert.equal(result.status, "cleared");
  assert.equal(savedPatch.gatheringVcPermissionBeforeOpen, null);

  const rejected = createKokuchiRecoveryService({
    getGuildSettings: async () => ({ gatheringVcRestorePending: true, gatheringVcPermissionBeforeOpen: { channelId: "vc" } }),
    saveGuildSettings: async () => ({}),
    acquireMongoLease: async () => ({ lockKey: "lease", ownerId: "owner" }),
    releaseMongoLease: async () => {},
    healthModel,
    reservationModel: model,
  });
  const rejectedResult = await rejected.clearStateOnly({ guild: { id: "guild-id" }, confirmed: true, reason: "権限を手動確認済み" });
  assert.equal(rejectedResult.status, "rejected");
});

test("GuildSettingsの取得失敗で依存モジュールをunknownにする", async () => {
  const service = createOperationalStatusService({
    getGuildSettings: async () => { throw new Error("settings read failed"); },
    client: readyClient(),
    getDatabaseStatus: async () => ({ status: "connected", error: null }),
    models: emptyModels(),
  });
  const snapshot = await service.getOperationalStatusSnapshot({ id: "guild-id", channels: { cache: new Map() } });
  for (const key of ["kokuchi", "recruitment", "automation", "panels", "voice"]) {
    assert.equal(snapshot.modules[key].severity, "unknown");
    assert.equal(snapshot.modules[key].issues.some((item) => item.code === "settings_unavailable"), true);
  }
  assert.equal(snapshot.modules.splitvc.severity, "healthy");
  assert.equal(snapshot.modules.system.issues.some((item) => item.code === "settings_unavailable"), true);
  assert.equal(snapshot.modules.system.issues.filter((item) => item.code === "settings_unavailable").length, 1);
  assert.equal(snapshot.issues.some((item) => item.code === "settings_unavailable"), true);
});

test("Oteboの失敗・参加新規がステータスに反映される", async () => {
  const service = createOperationalStatusService({
    getGuildSettings: async () => ({
      callWaitEnabled: true,
      oteboRecruitments: {
        uncertain: { id: "uncertain", status: "published_unconfirmed", targetAt: new Date(Date.now() - 1_000).toISOString() },
        cleanup: { id: "cleanup", status: "cleanup_pending", targetAt: new Date(Date.now() - 1_000).toISOString() },
      },
      callWaitPrompt: { targetAt: new Date(Date.now() - 1_000).toISOString(), lifecycleState: "evaluating" },
    }),
    client: readyClient(),
    getDatabaseStatus: async () => ({ status: "connected", error: null }),
    models: emptyModels(),
  });
  const snapshot = await service.getOperationalStatusSnapshot({ id: "guild-id", channels: { cache: new Map() } });
  const codes = snapshot.modules.recruitment.issues.map((item) => item.code);
  assert.equal(codes.includes("otebo_publication_uncertain"), true);
  assert.equal(codes.includes("otebo_cleanup_pending"), true);
  assert.equal(codes.includes("expired_recruitment"), true);
  assert.equal(snapshot.availableActions.includes("close_expired_recruitments"), true);
});

test("status board reruns after a refresh request arrives during an update", async () => {
  let board = { guildId: "guild-id", channelId: "channel-id", messageId: "message-id", payloadHash: null };
  let snapshotVersion = 1;
  let editCount = 0;
  let resolveFirstEditStarted;
  let releaseFirstEdit;
  let resolveSecondEditStarted;
  const firstEditStarted = new Promise((resolve) => { resolveFirstEditStarted = resolve; });
  const firstEditGate = new Promise((resolve) => { releaseFirstEdit = resolve; });
  const secondEditStarted = new Promise((resolve) => { resolveSecondEditStarted = resolve; });
  const message = {
    id: "message-id",
    edit: async () => {
      editCount += 1;
      if (editCount === 1) {
        resolveFirstEditStarted();
        await firstEditGate;
      } else if (editCount === 2) {
        resolveSecondEditStarted();
      }
      return message;
    },
  };
  const channel = {
    id: "channel-id",
    type: 0,
    permissionsFor: () => ({ has: () => true }),
    messages: {
      fetch: async (value) => typeof value === "string" ? message : { values: () => [] },
    },
    send: async () => message,
  };
  const guild = {
    id: "guild-id",
    members: { me: {} },
    channels: { cache: new Map([[channel.id, channel]]) },
  };
  const boardModel = {
    findOne: () => ({ lean: async () => board }),
    findOneAndUpdate: async (_filter, update) => {
      board = { ...board, ...(update.$set ?? {}) };
      return board;
    },
    findOneAndDelete: async () => board,
  };
  const service = createOperationalStatusBoardService({
    boardModel,
    healthModel: { findOneAndUpdate: async () => null },
    debounceMs: 5,
    getOperationalStatusSnapshot: async () => ({
      guildId: guild.id,
      observedAt: `2026-08-01T00:00:0${snapshotVersion}.000Z`,
      attentionCount: 0,
      recommendationCount: 0,
      modules: Object.fromEntries(["system", "kokuchi", "splitvc", "recruitment", "automation", "panels", "voice"].map((key) => [key, makeModule({ key, label: key, summary: `snapshot-${snapshotVersion}` })])),
    }),
    acquireMongoLease: async () => ({ lockKey: "lease", ownerId: "owner" }),
    releaseMongoLease: async () => {},
  });

  const firstRequest = service.requestRefresh(guild, "first");
  await firstEditStarted;
  const secondRequest = service.requestRefresh(guild, "during-first-update");
  snapshotVersion = 2;
  releaseFirstEdit();
  assert.equal((await firstRequest).status, "updated");
  await secondEditStarted;
  assert.equal(editCount, 2);
  assert.equal((await secondRequest).status, "updated");
  service.stop();
});

test("問題詳細ボタンは権限取得やSnapshotより先に応答をdeferする", async () => {
  const order = [];
  const snapshot = {
    guildId: "guild-id",
    attentionCount: 0,
    recommendationCount: 0,
    modules: { system: makeModule({ key: "system", label: "Bot・DB", summary: "正常" }) },
    availableActions: [],
  };
  const service = createOperationalManagementService({
    statusService: { getOperationalStatusSnapshot: async () => { order.push("snapshot"); return snapshot; } },
    boardService: { requestRefresh: async () => ({}), buildPayload: () => ({}) },
    recoveryService: {},
  });
  const interaction = {
    customId: "operational:details:guild-id",
    guildId: "guild-id",
    guild: { members: { fetch: async () => { order.push("permission"); return { permissions: { has: () => true } }; } } },
    user: { id: "admin-id" },
    memberPermissions: { has: () => true },
    deferred: false,
    replied: false,
    isButton: () => true,
    isStringSelectMenu: () => false,
    isModalSubmit: () => false,
    deferReply: async () => { order.push("defer"); interaction.deferred = true; },
    editReply: async () => { order.push("reply"); },
  };
  assert.equal(await service.handle(interaction), true);
  assert.equal(order[0], "defer");
  assert.ok(order.indexOf("defer") < order.indexOf("permission"));
  assert.ok(order.indexOf("defer") < order.indexOf("snapshot"));
});

test("管理操作の最初のエラーを省略せず応答と監査へ残す", async () => {
  const replies = [];
  const auditEntries = [];
  const auditFallbacks = [];
  const snapshot = {
    guildId: "guild-id",
    modules: {},
    availableActions: ["remove_participant_roles"],
  };
  const service = createOperationalManagementService({
    statusService: { getOperationalStatusSnapshot: async () => snapshot },
    boardService: { requestRefresh: async () => ({}) },
    recoveryService: {},
    actions: { removeParticipantRoles: async () => ({ status: "failed", result: "failed", errors: ["first complete error"] }) },
    actionLogModel: { create: async (entry) => { auditEntries.push(entry); return entry; } },
    sendOperationalLog: async ({ fallbackChannel }) => { auditFallbacks.push(fallbackChannel); return { id: "log-message" }; },
  });
  const interaction = {
    customId: "operational:manage_select:guild-id",
    guildId: "guild-id",
    guild: { members: { fetch: async () => ({ permissions: { has: () => true } }) } },
    channel: { id: "channel-id" },
    user: { id: "admin-id" },
    values: ["remove_participant_roles"],
    deferred: false,
    replied: false,
    isButton: () => false,
    isStringSelectMenu: () => true,
    isModalSubmit: () => false,
    deferReply: async () => { interaction.deferred = true; },
    editReply: async (payload) => { replies.push(payload); },
  };
  assert.equal(await service.handle(interaction), true);
  assert.match(replies.at(-1).content, /first complete error/);
  assert.deepEqual(auditEntries[0].errorMessages, ["first complete error"]);
  assert.deepEqual(auditFallbacks, [null]);
});

test("Discord API一時障害はパネル欠損や再設置候補にしない", async () => {
  const models = emptyModels();
  models.ProfileRegistrationPanel = {
    findOne: () => ({ lean: async () => ({ channelId: "panel-channel", messageId: "panel-message" }) }),
  };
  const service = createOperationalStatusService({
    getGuildSettings: async () => ({ profileIntroductionChannelId: "intro-channel" }),
    client: readyClient(),
    getDatabaseStatus: async () => ({ status: "connected", error: null }),
    models,
  });
  const guild = {
    id: "guild-id",
    channels: {
      cache: new Map(),
      fetch: async () => { const error = new Error("temporary Discord failure"); error.status = 503; throw error; },
    },
  };
  const snapshot = await service.getOperationalStatusSnapshot(guild);
  assert.equal(snapshot.modules.panels.issues.some((item) => item.code === "panel_check_failed"), true);
  assert.equal(snapshot.modules.panels.issues.some((item) => item.code === "profile_panel_message_missing"), false);
  assert.equal(snapshot.modules.panels.availableActions.includes("reinstall_panels"), false);
});

test("保存済みプロフィール・Oteboパネルのchannel driftを検出し、修復候補へ渡す", async () => {
  const models = emptyModels();
  models.ProfileRegistrationPanel = {
    findOne: () => ({ lean: async () => ({ guildId: "guild-id", channelId: "profile-old", messageId: "profile-message" }) }),
  };
  models.OteboRecruitmentPanel = {
    findOne: () => ({ lean: async () => ({ guildId: "guild-id", channelId: "otebo-old", messageId: "otebo-message" }) }),
  };
  const panelMessage = { id: "message" };
  const oldProfile = { id: "profile-old", messages: { fetch: async () => panelMessage } };
  const oldOtebo = { id: "otebo-old", messages: { fetch: async () => panelMessage } };
  const service = createOperationalStatusService({
    getGuildSettings: async () => ({
      profileIntroductionChannelId: "profile-new",
      callWaitEnabled: true,
      callWaitRoleId: "role",
      callWaitNoticeChannelId: "otebo-new",
    }),
    client: readyClient(),
    getDatabaseStatus: async () => ({ status: "connected", error: null }),
    models,
  });
  const snapshot = await service.getOperationalStatusSnapshot({
    id: "guild-id",
    channels: { cache: new Map([[oldProfile.id, oldProfile], [oldOtebo.id, oldOtebo]]), fetch: async (id) => id === oldProfile.id ? oldProfile : id === oldOtebo.id ? oldOtebo : null },
  });
  assert.equal(snapshot.modules.panels.issues.some((item) => item.code === "profile_panel_channel_mismatch"), true);
  assert.equal(snapshot.modules.recruitment.issues.some((item) => item.code === "otebo_panel_channel_mismatch"), true);
  const candidates = extractRepairCandidates({ status: "ok", reports: [{ checks: [] }] }, snapshot);
  assert.deepEqual(candidates.map((candidate) => candidate.key), ["otebo_panel.ensure", "profile_panel.ensure"]);
});

test("ボード削除失敗を永続化し、次回refreshで削除を完了する", async () => {
  let board = { guildId: "guild-id", channelId: "channel-id", messageId: "message-id", pendingMessageDeletions: [], removalPending: false };
  let deletionFails = true;
  const message = {
    id: "message-id",
    delete: async () => {
      if (deletionFails) throw new Error("temporary delete failure");
    },
  };
  const channel = {
    id: "channel-id",
    type: 0,
    send: async () => message,
    messages: { fetch: async () => message },
  };
  const guild = { id: "guild-id", channels: { cache: new Map([[channel.id, channel]]) } };
  const boardModel = {
    findOne: () => ({ lean: async () => board }),
    updateOne: async (_filter, update) => { if (board) board = { ...board, ...(update.$set ?? {}) }; return { matchedCount: board ? 1 : 0 }; },
    findOneAndUpdate: async (_filter, update) => { if (board) board = { ...board, ...(update.$set ?? {}) }; return board; },
    findOneAndDelete: async () => { const removed = board; board = null; return removed; },
  };
  const service = createOperationalStatusBoardService({
    boardModel,
    healthModel: { findOneAndUpdate: async () => null },
    getOperationalStatusSnapshot: async () => ({ guildId: guild.id, modules: {} }),
    acquireMongoLease: async () => ({ lockKey: "lease", ownerId: "owner", leaseId: "lease-id" }),
    renewMongoLease: async () => true,
    releaseMongoLease: async () => {},
  });
  const first = await service.remove(guild);
  assert.equal(first.status, "cleanup-pending");
  assert.equal(board.removalPending, true);
  deletionFails = false;
  const second = await service.refresh(guild, "cleanup-retry");
  assert.equal(second.status, "removed");
  assert.equal(board, null);
  service.stop();
});

test("新規ボードメッセージ後のDB保存失敗はメッセージをロールバックする", async () => {
  let deleted = 0;
  const message = { id: "new-message", delete: async () => { deleted += 1; } };
  const channel = {
    id: "channel-id",
    type: 0,
    permissionsFor: () => ({ has: () => true }),
    messages: { fetch: async () => message },
    send: async () => message,
  };
  const guild = {
    id: "guild-id",
    members: { me: {} },
    channels: { cache: new Map([[channel.id, channel]]) },
  };
  const board = { guildId: guild.id, channelId: channel.id, messageId: null, payloadHash: null, pendingMessageDeletions: [] };
  const boardModel = {
    findOne: () => ({ lean: async () => board }),
    findOneAndUpdate: async () => { throw new Error("board save failed"); },
  };
  const service = createOperationalStatusBoardService({
    boardModel,
    healthModel: { findOneAndUpdate: async () => null },
    getOperationalStatusSnapshot: async () => ({
      guildId: guild.id,
      observedAt: new Date().toISOString(),
      attentionCount: 0,
      recommendationCount: 0,
      modules: Object.fromEntries(["system", "kokuchi", "splitvc", "recruitment", "automation", "panels", "voice"].map((key) => [key, makeModule({ key, label: key, summary: "正常" })])),
    }),
    acquireMongoLease: async () => ({ lockKey: "lease", ownerId: "owner", leaseId: "lease-id" }),
    renewMongoLease: async () => true,
    releaseMongoLease: async () => {},
    logger: { error: () => {} },
  });
  const result = await service.refresh(guild, "rollback-test");
  assert.equal(result.status, "failed");
  assert.equal(deleted, 1);
  service.stop();
});

test("call_wait_roleの正常なsuperseded世代を障害検索に含めない", async () => {
  const models = emptyModels();
  let generationFilter = null;
  models.CallWaitRoleGeneration = {
    findOne: async () => null,
    find: (filter) => {
      generationFilter = filter;
      return { sort: () => ({ lean: async () => [] }) };
    },
  };
  const service = createOperationalStatusService({
    getGuildSettings: async () => ({ callWaitEnabled: true }),
    client: readyClient(),
    getDatabaseStatus: async () => ({ status: "connected", error: null }),
    models,
  });
  await service.getOperationalStatusSnapshot({ id: "guild-id", channels: { cache: new Map() } });
  assert.equal(generationFilter.status, "failed");
  assert.notEqual(generationFilter.status, "superseded");
});

test("管理操作はボード再描画の完了を待たずに結果を返す", async () => {
  const replies = [];
  const snapshot = { guildId: "guild-id", modules: {}, availableActions: ["remove_participant_roles"] };
  const service = createOperationalManagementService({
    statusService: { getOperationalStatusSnapshot: async () => snapshot },
    boardService: { markDirty: () => new Promise(() => {}), requestRefresh: async () => ({}), buildPayload: () => ({}) },
    recoveryService: {},
    actions: { removeParticipantRoles: async () => ({ status: "completed", result: "success", errors: [] }) },
    actionLogModel: { create: async (entry) => entry },
    sendOperationalLog: async () => null,
  });
  const interaction = {
    customId: "operational:manage_select:guild-id",
    guildId: "guild-id",
    guild: { id: "guild-id", members: { fetch: async () => ({ permissions: { has: () => true } }) } },
    user: { id: "admin-id" },
    values: ["remove_participant_roles"],
    deferred: false,
    replied: false,
    isButton: () => false,
    isStringSelectMenu: () => true,
    isModalSubmit: () => false,
    deferReply: async () => { interaction.deferred = true; },
    editReply: async (payload) => { replies.push(payload); },
  };
  const result = await Promise.race([
    service.handle(interaction),
    new Promise((_, reject) => setTimeout(() => reject(new Error("management response waited for board refresh")), 100)),
  ]);
  assert.equal(result, true);
  assert.equal(replies.length, 1);
});

test("ステータスボードはリース喪失後にDiscordメッセージを更新しない", async () => {
  let edits = 0;
  const board = { guildId: "guild-id", channelId: "channel-id", messageId: "message-id", payloadHash: null, fencingToken: 1, pendingMessageDeletions: [] };
  const message = { id: "message-id", edit: async () => { edits += 1; } };
  const channel = {
    id: "channel-id",
    type: 0,
    send: async () => message,
    permissionsFor: () => ({ has: () => true }),
    messages: { fetch: async () => message },
  };
  const guild = { id: "guild-id", members: { me: {} }, channels: { cache: new Map([[channel.id, channel]]) } };
  const service = createOperationalStatusBoardService({
    boardModel: { findOne: () => ({ lean: async () => board }), findOneAndUpdate: async () => board },
    healthModel: { findOneAndUpdate: async () => null },
    getOperationalStatusSnapshot: async () => ({ guildId: guild.id, modules: {} }),
    acquireMongoLease: async () => ({ lockKey: "lease", ownerId: "owner", leaseId: "lease-id", fencingToken: 2 }),
    renewMongoLease: async () => false,
    releaseMongoLease: async () => {},
    logger: { error: () => {} },
  });
  const result = await service.refresh(guild, "lease-loss-test");
  assert.equal(result.status, "failed");
  assert.equal(edits, 0);
  service.stop();
});

test("busy状態のボード更新要求は有限回で解決する", async () => {
  const service = createOperationalStatusBoardService({
    debounceMs: 1,
    getOperationalStatusSnapshot: async () => ({ guildId: "guild-id", modules: {} }),
    acquireMongoLease: async () => null,
  });
  const result = await service.requestRefresh({ id: "guild-id" }, "busy-test");
  assert.equal(result.status, "busy");
  assert.equal(result.reason, "retry-limit");
  service.stop();
});

test("単一のMongoDB障害をモジュール数分だけ重複計上しない", async () => {
  const service = createOperationalStatusService({
    getGuildSettings: async () => ({}),
    client: readyClient(),
    getDatabaseStatus: async () => ({ status: "disconnected", error: "offline" }),
    models: emptyModels(),
  });
  const snapshot = await service.getOperationalStatusSnapshot({ id: "guild-id", channels: { cache: new Map() } });
  assert.equal(snapshot.attentionCount, 1);
  assert.equal(snapshot.rootCauseCount, 1);
});

test("read-only operational snapshots do not persist OperationalHealthState", async () => {
  const models = emptyModels();
  let healthWrites = 0;
  models.OperationalHealthState.findOneAndUpdate = async () => {
    healthWrites += 1;
    return null;
  };
  const service = createOperationalStatusService({
    getGuildSettings: async () => ({}),
    client: readyClient(),
    getDatabaseStatus: async () => ({ status: "connected", error: null }),
    models,
  });
  await service.getOperationalStatusSnapshot({ id: "guild-id", channels: { cache: new Map() } }, { persistHealth: false, readOnly: true });
  assert.equal(healthWrites, 0);
});

test("Discordパネル存在確認を短時間キャッシュする", async () => {
  const models = emptyModels();
  models.ProfileRegistrationPanel = { findOne: () => ({ lean: async () => ({ channelId: "panel-channel", messageId: "panel-message" }) }) };
  let fetches = 0;
  const channel = {
    messages: { cache: new Map(), fetch: async () => { fetches += 1; return { id: "panel-message" }; } },
  };
  const guild = { id: "guild-id", channels: { cache: new Map([["panel-channel", channel]]), fetch: async () => channel } };
  const service = createOperationalStatusService({
    getGuildSettings: async () => ({ profileIntroductionChannelId: "panel-channel" }),
    client: readyClient(),
    getDatabaseStatus: async () => ({ status: "connected", error: null }),
    models,
  });
  await service.getOperationalStatusSnapshot(guild);
  await service.getOperationalStatusSnapshot(guild);
  assert.equal(fetches, 1);
});

test("VCパネル照合は対象VC集合と保存レコード集合を比較し、部分欠落を修復候補にする", async () => {
  const models = emptyModels();
  const persisted = [
    { guildId: "guild-id", channelId: "target-a", panelMessageId: "message-a" },
    // Stale records outside the configured category must not hide target-b.
    { guildId: "guild-id", channelId: "stale-channel", panelMessageId: "stale-message" },
  ];
  models.VoiceChannelControl = {
    find: () => ({ lean: async () => persisted }),
    countDocuments: async () => persisted.length,
  };
  const targetA = { id: "target-a", type: 2, parentId: "category" };
  const targetB = { id: "target-b", type: 2, parentId: "category" };
  const parent = { id: "parent", type: 2, parentId: "category" };
  const reminderParent = { id: "reminder", type: 2, parentId: "category" };
  const outside = { id: "outside", type: 2, parentId: "other-category" };
  const guild = {
    id: "guild-id",
    channels: { cache: new Map([targetA, targetB, parent, reminderParent, outside].map((channel) => [channel.id, channel])) },
  };
  const service = createOperationalStatusService({
    getGuildSettings: async () => ({ vcControlCategoryId: "category", parentChannelId: "parent", voiceReminderParentChannelIds: ["reminder"] }),
    client: readyClient(),
    getDatabaseStatus: async () => ({ status: "connected", error: null }),
    models,
  });
  const snapshot = await service.getOperationalStatusSnapshot(guild);
  const panelIssue = snapshot.modules.panels.issues.find((item) => item.code === "vc_panel_missing");
  assert.ok(panelIssue);
  assert.equal(snapshot.modules.panels.details.targetVoiceControlCount, 2);
  assert.deepEqual(snapshot.modules.panels.details.missingTargetVoiceChannelIds, ["target-b"]);
  assert.equal(snapshot.modules.panels.availableActions.includes("reinstall_panels"), true);
  const candidates = extractRepairCandidates({}, snapshot);
  assert.equal(candidates.some((candidate) => candidate.key === "voice_control_panels.ensure"), true);
});

test("HTTP readinessはMongoDBの非同期ping結果を待って判定する", async () => {
  const server = startHealthServer({
    port: 0,
    client: { isReady: () => true, user: { tag: "bot#0001" } },
    getMongoReady: async () => false,
    getStartupState: () => ({ completed: true, failed: false }),
    isShuttingDown: () => false,
    logger: { log: () => {}, error: () => {} },
  });
  await once(server, "listening");
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/ready`);
    const body = await response.json();
    assert.equal(response.status, 503);
    assert.equal(body.mongoReady, false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("DBへ新ボード参照を保存した後の清掃失敗では新メッセージを削除しない", async () => {
  let deleted = 0;
  let board = { guildId: "guild-id", channelId: "channel-id", messageId: null, payloadHash: null, pendingMessageDeletions: [] };
  const message = { id: "new-message", delete: async () => { deleted += 1; } };
  const channel = {
    id: "channel-id",
    type: 0,
    permissionsFor: () => ({ has: () => true }),
    messages: { fetch: async () => null },
    send: async () => message,
  };
  const guild = { id: "guild-id", members: { me: {} }, channels: { cache: new Map([[channel.id, channel]]) } };
  const boardModel = {
    findOne: () => ({ lean: async () => board }),
    findOneAndUpdate: async (_filter, update) => { board = { ...board, ...(update.$set ?? {}) }; return board; },
    updateOne: async () => { throw new Error("cleanup state write failed"); },
  };
  const service = createOperationalStatusBoardService({
    boardModel,
    healthModel: { findOneAndUpdate: async () => null },
    getOperationalStatusSnapshot: async () => ({ guildId: guild.id, modules: {} }),
    acquireMongoLease: async () => ({ lockKey: "lease", ownerId: "owner", leaseId: "lease-id", fencingToken: 2 }),
    renewMongoLease: async () => true,
    releaseMongoLease: async () => {},
    logger: { error: () => {} },
  });
  const result = await service.refresh(guild, "post-save-cleanup-failure");
  assert.equal(result.status, "failed");
  assert.equal(board.messageId, "new-message");
  assert.equal(deleted, 0);
  service.stop();
});

test("ステータス件数は詳細サンプル上限を超えてもcountDocumentsを使用する", async () => {
  const models = emptyModels();
  models.VoiceParticipantRoleGrant = {
    find: () => ({ sort: () => ({ limit: () => ({ lean: async () => [{ memberId: "sample", status: "failed" }] }) }) }),
    countDocuments: async (filter) => ({ active: 150, removing: 2, failed: 3 }[filter.status] ?? 0),
  };
  models.VoiceExitSchedule = {
    find: () => ({ sort: () => ({ limit: () => ({ lean: async () => [] }) }) }),
    countDocuments: async () => 120,
  };
  const service = createOperationalStatusService({
    getGuildSettings: async () => ({}),
    client: readyClient(),
    getDatabaseStatus: async () => ({ status: "connected", error: null }),
    models,
  });
  const snapshot = await service.getOperationalStatusSnapshot({ id: "guild-id", channels: { cache: new Map() } });
  assert.deepEqual(snapshot.modules.voice.details.roleGrantCounts, { active: 150, removing: 2, failed: 3 });
  assert.equal(snapshot.modules.voice.details.exitScheduleCount, 120);
});
