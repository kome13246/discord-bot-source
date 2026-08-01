import assert from "node:assert/strict";
import test from "node:test";
import { commands } from "../src/commands.js";
import { buildOperationalStatusPayload } from "../src/operational-status-board-service.js";
import { createKokuchiRecoveryService } from "../src/kokuchi-recovery-service.js";
import { makeModule } from "../src/operational-status-service.js";

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
    healthModel: { findOneAndUpdate: async () => null, updateOne: async () => null },
    reservationModel: model,
  });
  const result = await service.forceTerminate({ guild: { id: "guild-id" }, actorUserId: "admin-id" });
  assert.equal(result.status, "partial");
  assert.equal(savedPatches[0].kokuchiEventId, undefined);
  assert.equal(savedPatches[0].gatheringVcRestorePending, undefined);
  assert.equal(result.permissionRestored, "failed");
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
