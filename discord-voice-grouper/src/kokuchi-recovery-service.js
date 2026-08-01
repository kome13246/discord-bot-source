import { cancelKokuchiTimedActions } from "./settings-store.js";
import { cancelKokuchiScheduledActions } from "./scheduled-action-store.js";
import { KokuchiReservation } from "./models/kokuchi-reservation.js";
import { OperationalHealthState } from "./models/operational-health-state.js";

const ACTIVE_STATUSES = ["pending", "processing", "canceling", "cancel_partial", "sent", "published_unconfirmed", "failed"];
const TERMINAL_STATUSES = ["canceled", "published", "completed"];

function truncate(value, max = 500) {
  return String(value ?? "unknown").replace(/\s+/g, " ").trim().slice(0, max);
}

function stateAfterForce(state, keepSent = true) {
  if (["pending", "failed", "processing", "sending"].includes(state)) return "canceled";
  if (keepSent && ["sent", "sent_unconfirmed", "unconfirmed", "skipped"].includes(state)) return state;
  return state;
}

async function lean(value) {
  if (typeof value?.lean === "function") return value.lean();
  return value;
}

export function createKokuchiRecoveryService({
  getGuildSettings,
  saveGuildSettings,
  acquireMongoLease = async () => ({ lockKey: "test" }),
  releaseMongoLease = async () => {},
  cancelTimedActions = cancelKokuchiTimedActions,
  cancelScheduledActions = cancelKokuchiScheduledActions,
  reservationModel = KokuchiReservation,
  clearReservationTimers = () => {},
  restoreGatheringVcPermission = async () => false,
  completeReservationCancellation = null,
  healthModel = OperationalHealthState,
  logger = console,
} = {}) {
  if (!getGuildSettings || !saveGuildSettings) throw new Error("getGuildSettings and saveGuildSettings are required.");

  async function getCurrentTarget(guildId, settings = null) {
    const currentSettings = settings ?? await getGuildSettings(guildId);
    const candidates = await lean(reservationModel.find({ guildId, status: { $in: ACTIVE_STATUSES } }).sort?.({ updatedAt: -1 }) ?? []);
    const currentId = currentSettings?.kokuchiEventId;
    if (currentId) {
      const exact = candidates.filter((item) => item.reservationId === currentId);
      if (exact.length === 1) return { settings: currentSettings, reservation: exact[0], candidates: exact };
      if (exact.length > 1) return { settings: currentSettings, reservation: null, candidates: exact, ambiguous: true };
      return { settings: currentSettings, reservation: null, candidates, orphaned: true };
    }
    if (candidates.length === 1) return { settings: currentSettings, reservation: candidates[0], candidates };
    if (candidates.length > 1) {
      const eventAt = new Date(currentSettings?.kokuchiEventAt ?? 0).getTime();
      const byEventAt = Number.isFinite(eventAt) && eventAt > 0
        ? candidates.filter((item) => new Date(item.eventAt ?? 0).getTime() === eventAt)
        : [];
      if (byEventAt.length === 1) return { settings: currentSettings, reservation: byEventAt[0], candidates };
      return { settings: currentSettings, reservation: null, candidates, ambiguous: true };
    }
    return { settings: currentSettings, reservation: null, candidates, orphaned: Boolean(currentSettings?.kokuchiEventId || currentSettings?.kokuchiEventAt) };
  }

  async function cancelDurableWork(guildId, reservationId) {
    const errors = [];
    const results = [];
    for (const operation of [
      () => cancelTimedActions({ guildId, kokuchiEventId: reservationId }),
      () => cancelScheduledActions({ guildId, kokuchiEventId: reservationId }),
    ]) {
      try {
        results.push(await operation());
      } catch (error) {
        errors.push(truncate(error?.message ?? error));
      }
    }
    return { results, errors };
  }

  async function restoreIfNeeded(guild, settings) {
    if (!settings?.gatheringVcRestorePending && settings?.gatheringVcUnlockState !== "opened") {
      return { status: "not_needed", errors: [] };
    }
    if (!guild) return { status: "failed", errors: ["Guild is unavailable for gathering VC permission restoration."] };
    try {
      const restored = await restoreGatheringVcPermission(guild, settings);
      return restored ? { status: "restored", errors: [] } : { status: "failed", errors: ["Gathering VC permission restoration was not confirmed."] };
    } catch (error) {
      return { status: "failed", errors: [truncate(error?.message ?? error)] };
    }
  }

  async function normalCancel({ guild, actorUserId, targetId = null } = {}) {
    const lease = await acquireMongoLease(`kokuchi-recovery:${guild.id}`, { leaseMs: 5 * 60 * 1000 });
    if (!lease) return { status: "busy", errors: ["別のkokuchi復旧処理が実行中です。"] };
    try {
    const settings = await getGuildSettings(guild.id);
    const target = await getCurrentTarget(guild.id, settings);
    if (targetId) {
      const selected = target.candidates.find((item) => item.reservationId === targetId);
      if (!selected) return { status: "not-found", errors: ["Selected kokuchi reservation was not found."] };
      target.reservation = selected;
      target.ambiguous = false;
    }
    if (target.ambiguous) return { status: "ambiguous", candidates: target.candidates.map((item) => ({ reservationId: item.reservationId, eventAt: item.eventAt, status: item.status })), errors: ["複数の開催回候補があるため自動変更を停止しました。"] };
    if (!target.reservation) return { status: target.orphaned ? "orphaned" : "not-found", before: settings, errors: target.orphaned ? ["GuildSettingsに孤立した現在開催回があります。強制終了を使用してください。"] : ["現在開催回はありません。"] };
    const reservation = target.reservation;
    if (TERMINAL_STATUSES.includes(reservation.status)) return { status: "already-terminal", reservation, before: reservation };
    const claimed = await reservationModel.findOneAndUpdate(
      { _id: reservation._id, status: { $in: ["pending", "sent", "cancel_partial"] } },
      { $set: { status: "canceling", cancellationStartedAt: new Date(), cancellationError: null }, $unset: { activeKey: 1 } },
      { returnDocument: "after", lean: true },
    );
    if (!claimed) return { status: "busy", reservation, errors: ["対象予約は別の処理で更新中です。"] };
    clearReservationTimers(claimed.reservationId);
    if (completeReservationCancellation) {
      const result = await completeReservationCancellation({ reservation: claimed, guild });
      return { ...result, before: reservation, after: { settings: result.settings ?? null, reservation: claimed }, actorUserId };
    }
    const durable = await cancelDurableWork(guild.id, claimed.reservationId);
    const restore = await restoreIfNeeded(guild, settings);
    const errors = [...durable.errors, ...restore.errors];
    const status = errors.length ? "cancel_partial" : "canceled";
    await reservationModel.updateOne(
      { _id: claimed._id, status: "canceling" },
      { $set: { status, cancellationResults: { durable, permissionRestored: restore.status }, ...(status === "canceled" ? { canceledAt: new Date(), cleanupAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) } : { cancellationError: errors.join(" | ").slice(0, 4000) }) } },
    );
    return { status, reservation: claimed, before: reservation, permissionRestored: restore.status, errors, actorUserId };
    } finally {
      await releaseMongoLease(lease).catch((error) => logger.error?.(`kokuchi recovery lease release failed: ${error?.message ?? error}`));
    }
  }

  async function forceTerminate({ guild, actorUserId, targetId = null } = {}) {
    const lease = await acquireMongoLease(`kokuchi-recovery:${guild.id}`, { leaseMs: 2 * 60 * 1000 });
    if (!lease) return { status: "busy", errors: ["別のkokuchi復旧処理が実行中です。"] };
    try {
      const settings = await getGuildSettings(guild.id);
      const target = await getCurrentTarget(guild.id, settings);
      if (targetId) {
        const selected = target.candidates.find((item) => item.reservationId === targetId);
        if (!selected) return { status: "not-found", errors: ["Selected kokuchi reservation was not found."] };
        target.reservation = selected;
        target.ambiguous = false;
      }
      if (target.ambiguous) return { status: "ambiguous", candidates: target.candidates.map((item) => ({ reservationId: item.reservationId, eventAt: item.eventAt, status: item.status })), errors: ["複数の開催回候補があるため自動変更を停止しました。"] };
      const before = { settings, reservation: target.reservation };
      if (target.reservation && !TERMINAL_STATUSES.includes(target.reservation.status)) {
        await reservationModel.updateOne({ _id: target.reservation._id, status: { $in: ACTIVE_STATUSES } }, { $set: { status: "canceling", cancellationStartedAt: new Date(), cancellationError: null }, $unset: { activeKey: 1 } });
        clearReservationTimers(target.reservation.reservationId);
      }
      const durable = target.reservation ? await cancelDurableWork(guild.id, target.reservation.reservationId) : { results: [], errors: [] };
      const restore = await restoreIfNeeded(guild, settings);
      const errors = [...durable.errors, ...restore.errors];
      const patch = {
        ...(settings?.kokuchiPreNoticeState ? { kokuchiPreNoticeState: stateAfterForce(settings.kokuchiPreNoticeState) } : {}),
        ...(settings?.kokuchiGatheringReminderState ? { kokuchiGatheringReminderState: stateAfterForce(settings.kokuchiGatheringReminderState) } : {}),
        ...(settings?.gatheringVcUnlockState ? { gatheringVcUnlockState: restore.status === "restored" ? "closed" : stateAfterForce(settings.gatheringVcUnlockState, false) } : {}),
        ...(restore.status === "restored" ? { gatheringVcRestorePending: false, gatheringVcRestorePendingAt: null, gatheringVcPermissionBeforeOpen: null } : {}),
        ...(errors.length === 0 ? { kokuchiEventId: null, kokuchiEventAt: null } : {}),
      };
      const afterSettings = await saveGuildSettings(guild.id, patch);
      let afterReservation = target.reservation;
      if (target.reservation) {
        const status = errors.length ? "cancel_partial" : "canceled";
        afterReservation = await reservationModel.findOneAndUpdate(
          { _id: target.reservation._id, status: { $in: ["canceling", ...ACTIVE_STATUSES] } },
          { $set: { status, cancellationResults: { durable, permissionRestored: restore.status, forced: true }, ...(errors.length ? { cancellationError: errors.join(" | ").slice(0, 4000) } : { canceledAt: new Date(), cleanupAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), cancellationError: null }), }, $unset: { activeKey: 1, cancellationStartedAt: 1 } },
          { returnDocument: "after", lean: true },
        );
      }
      const result = errors.length ? "partial" : "success";
      if (errors.length && restore.status === "failed") {
        await healthModel.findOneAndUpdate(
          { guildId: guild.id },
          { $set: { lastRecoveryFailureAt: new Date(), lastRecoveryFailureAction: "kokuchi_force_terminate", lastRecoveryFailureReason: errors.join(" | ").slice(0, 1000) }, $setOnInsert: { guildId: guild.id } },
          { upsert: true, setDefaultsOnInsert: true },
        ).catch(() => {});
      }
      if (!errors.length) {
        const healthClear = healthModel.updateOne?.({ guildId: guild.id }, { $set: { lastRecoveryFailureAt: null, lastRecoveryFailureAction: null, lastRecoveryFailureReason: null } });
        if (healthClear?.catch) await healthClear.catch(() => {});
      }
      return { status: errors.length ? "partial" : "canceled", result, before, after: { settings: afterSettings, reservation: afterReservation }, permissionRestored: restore.status, errors, actorUserId };
    } catch (error) {
      logger.error?.(`kokuchi force termination failed for ${guild.id}: ${error?.message ?? error}`);
      return { status: "failed", result: "failed", errors: [truncate(error?.message ?? error)] };
    } finally {
      await releaseMongoLease(lease).catch((error) => logger.error?.(`kokuchi recovery lease release failed: ${error?.message ?? error}`));
    }
  }

  async function clearStateOnly({ guild, actorUserId, reason, confirmed = false, targetId = null } = {}) {
    if (!confirmed || !String(reason ?? "").trim()) return { status: "rejected", errors: ["集合VCの実権限確認と理由入力が必要です。"] };
    const lease = await acquireMongoLease(`kokuchi-recovery:${guild.id}`, { leaseMs: 2 * 60 * 1000 });
    if (!lease) return { status: "busy", errors: ["別のkokuchi復旧処理が実行中です。"] };
    try {
      const settings = await getGuildSettings(guild.id);
      let health = null;
      try {
        const healthQuery = healthModel?.findOne?.({ guildId: guild.id });
        health = healthQuery?.lean ? await healthQuery.lean() : await healthQuery;
      } catch (error) {
        logger.error?.(`kokuchi state-only recovery health check failed for ${guild.id}: ${error?.message ?? error}`);
        return { status: "rejected", errors: ["強制終了失敗の状態を確認できないため、状態のみ解除を実行できません。"] };
      }
      if (
        settings?.gatheringVcRestorePending !== true
        || settings?.gatheringVcPermissionBeforeOpen
        || health?.lastRecoveryFailureAction !== "kokuchi_force_terminate"
        || !health?.lastRecoveryFailureAt
      ) {
        return { status: "rejected", errors: ["状態のみ解除は、権限復元に失敗した強制終了後で、権限スナップショットがない場合だけ実行できます。"] };
      }
      const target = await getCurrentTarget(guild.id, settings);
      if (target.ambiguous) return { status: "ambiguous", candidates: target.candidates.map((item) => ({ reservationId: item.reservationId, eventAt: item.eventAt, status: item.status })), errors: ["複数の開催回候補があるため状態のみ解除を停止しました。"] };
      const reservation = targetId ? target.candidates.find((item) => item.reservationId === targetId) : target.reservation;
      const patch = {
        kokuchiEventId: null,
        kokuchiEventAt: null,
        kokuchiPreNoticeState: stateAfterForce(settings?.kokuchiPreNoticeState),
        kokuchiGatheringReminderState: stateAfterForce(settings?.kokuchiGatheringReminderState),
        gatheringVcUnlockState: "closed",
        gatheringVcRestorePending: false,
        gatheringVcRestorePendingAt: null,
        gatheringVcPermissionBeforeOpen: null,
      };
      const afterSettings = await saveGuildSettings(guild.id, patch);
      const healthClear = healthModel.updateOne?.({ guildId: guild.id }, { $set: { lastRecoveryFailureAt: null, lastRecoveryFailureAction: null, lastRecoveryFailureReason: null } });
      if (healthClear?.catch) await healthClear.catch(() => {});
      let afterReservation = reservation;
      if (reservation) afterReservation = await reservationModel.findOneAndUpdate(
        { _id: reservation._id, status: { $in: ACTIVE_STATUSES } },
        { $set: { status: "canceled", recoveryReason: `State-only clear: ${truncate(reason, 500)}`, canceledAt: new Date(), cleanupAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) }, $unset: { activeKey: 1, cancellationStartedAt: 1 } },
        { returnDocument: "after", lean: true },
      );
      return { status: "cleared", result: "success", before: { settings, reservation }, after: { settings: afterSettings, reservation: afterReservation }, reason, actorUserId };
    } catch (error) {
      return { status: "failed", result: "failed", errors: [truncate(error?.message ?? error)] };
    } finally {
      await releaseMongoLease(lease).catch(() => {});
    }
  }

  async function restorePermission({ guild } = {}) {
    const lease = await acquireMongoLease(`kokuchi-recovery:${guild.id}`, { leaseMs: 2 * 60 * 1000 });
    if (!lease) return { status: "busy", result: "failed", errors: ["kokuchi recovery is already running."] };
    try {
      const settings = await getGuildSettings(guild.id);
      const result = await restoreIfNeeded(guild, settings);
      return { status: result.status, result: result.status === "restored" || result.status === "not_needed" ? "success" : "failed", before: settings, errors: result.errors };
    } finally {
      await releaseMongoLease(lease).catch((error) => logger.error?.(`kokuchi recovery lease release failed for ${guild.id}: ${error?.message ?? error}`));
    }
  }

  return { getCurrentTarget, normalCancel, forceTerminate, clearStateOnly, restorePermission };
}
