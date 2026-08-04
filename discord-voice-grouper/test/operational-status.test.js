import assert from "node:assert/strict";
import test from "node:test";
import { commands } from "../src/commands.js";
import { buildOperationalStatusPayload, createOperationalStatusBoardService } from "../src/operational-status-board-service.js";
import { createKokuchiRecoveryService } from "../src/kokuchi-recovery-service.js";
import { createOperationalStatusService, makeModule } from "../src/operational-status-service.js";

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

test("GuildSettings縺ｮ蜿門ｾ怜､ｱ謨励〒隕∝ｯｾ蠢・ｼ医・縺ｧ繧ゅｒunknown縺ｫ縺吶ｋ", async () => {
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
  assert.equal(snapshot.modules.splitvc.severity, "disabled");
  assert.equal(snapshot.modules.system.issues.some((item) => item.code === "settings_unavailable"), true);
  assert.equal(snapshot.issues.some((item) => item.code === "settings_unavailable"), true);
});

test("Otebo縺ｮ螟ｱ謨励・蜿ょ刈譁ｰ隕上′繧ｹ繝ｆ繝ｼ繧ｿ繧ｹ縺ｫ蜿励ｊ莨九＆繧後ｋ", async () => {
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
