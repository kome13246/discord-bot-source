import { cancelKokuchiTimedActions } from "./settings-store.js";
import { cancelKokuchiScheduledActions } from "./scheduled-action-store.js";
import { KokuchiReservation } from "./models/kokuchi-reservation.js";
import { OperationalHealthState } from "./models/operational-health-state.js";
import {
  GATHERING_VC_RESTORE_BLOCKING_STATUS_VALUES,
  getKokuchiReservationCleanupAt,
  isGatheringVcRestoreBlocking,
  normalizeGatheringVcRestoreStatus,
  normalizeKokuchiStatus,
} from "./kokuchi-event-state.js";

const ACTIVE_STATUSES = ["pending", "processing", "canceling", "cancel_partial", "sent", "published_unconfirmed", "failed"];
const TERMINAL_STATUSES = ["canceled", "published", "completed"];
const RESTORE_TARGET_STATUSES = GATHERING_VC_RESTORE_BLOCKING_STATUS_VALUES;

function truncate(value, max = 500) {
  return String(value ?? "unknown").replace(/\s+/g, " ").trim().slice(0, max);
}

function stateAfterForce(state, keepSent = true) {
  if (["pending", "failed", "processing", "sending"].includes(state)) return "canceled";
  if (keepSent && ["sent", "sent_unconfirmed", "unconfirmed", "skipped"].includes(state)) return state;
  return state;
}

function cleanupAtForRestoreStatus(status) {
  const normalized = status === "not_needed" ? "not_required" : status;
  return getKokuchiReservationCleanupAt({ restoreStatus: normalized });
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
  patchGuildSettingsForEvent = null,
  cancelTimedActions = cancelKokuchiTimedActions,
  cancelScheduledActions = cancelKokuchiScheduledActions,
  reservationModel = KokuchiReservation,
  clearReservationTimers = () => {},
  restoreGatheringVcPermission = async () => false,
  getGatheringVcRestoreState = async () => null,
  cancelRoleRemovalWait = async () => ({ errors: [] }),
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

  async function getRestoreTarget(guildId, settings = null, targetId = null) {
    const currentSettings = settings ?? await getGuildSettings(guildId);
    if (targetId) {
      const query = reservationModel.findOne?.({ guildId, reservationId: targetId });
      const explicit = await lean(query?.lean ? query.lean() : query);
      return {
        settings: currentSettings,
        reservation: explicit ?? null,
        candidates: explicit ? [explicit] : [],
        explicit: true,
      };
    }
    const query = reservationModel.find?.({
      guildId,
      $or: [
        { gatheringVcRestorePending: true },
        { gatheringVcRestoreStatus: { $in: RESTORE_TARGET_STATUSES } },
      ],
    });
    const sorted = query?.sort ? query.sort({ updatedAt: -1 }) : query;
    const candidates = await lean(sorted ?? []);
    let list = Array.isArray(candidates) ? candidates : candidates ? [candidates] : [];
    // Keep compatibility with lightweight stores and pre-migration records
    // that can answer the legacy pending query but do not understand $or.
    if (!list.length && reservationModel.find) {
      const legacyQuery = reservationModel.find({ guildId, gatheringVcRestorePending: true });
      const legacySorted = legacyQuery?.sort ? legacyQuery.sort({ updatedAt: -1 }) : legacyQuery;
      const legacy = await lean(legacySorted ?? []);
      list = Array.isArray(legacy) ? legacy : legacy ? [legacy] : [];
    }
    const currentId = currentSettings?.kokuchiEventId;
    if (currentId) {
      const exact = list.filter((item) => item.reservationId === currentId);
      if (exact.length === 1) return { settings: currentSettings, reservation: exact[0], candidates: exact };
      if (exact.length > 1) return { settings: currentSettings, reservation: null, candidates: exact, ambiguous: true };
    }
    if (list.length === 1) return { settings: currentSettings, reservation: list[0], candidates: list };
    if (list.length > 1) return { settings: currentSettings, reservation: null, candidates: list, ambiguous: true };
    return { settings: currentSettings, reservation: null, candidates: [], orphaned: Boolean(currentId) };
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

  async function persistEventSettings(guildId, eventId, { set = {}, unset = {} } = {}) {
    if (patchGuildSettingsForEvent && eventId) {
      return patchGuildSettingsForEvent({ guildId, kokuchiEventId: eventId, set, unset });
    }
    return saveGuildSettings(guildId, {
      ...set,
      ...Object.fromEntries(Object.keys(unset).map((key) => [key, null])),
    });
  }

  async function restoreIfNeeded(guild, settings, reservation = null, { force = false } = {}) {
    const eventId = reservation?.reservationId ?? settings?.kokuchiEventId;
    const state = await getGatheringVcRestoreState({ guild, settings, reservation, eventId }).catch(() => null);
    const stateSource = state ?? reservation ?? (reservation ? null : settings) ?? {};
    const restoreStatus = normalizeGatheringVcRestoreStatus(stateSource);
    const needsRestore = Boolean(
      stateSource?.gatheringVcUnlockState === "opened"
      || stateSource?.gatheringVcPermissionBeforeOpen
      || isGatheringVcRestoreBlocking(restoreStatus)
      || (!reservation && settings?.gatheringVcRestorePending === true),
    );
    if (!needsRestore) return { status: "not_needed", errors: [] };
    if (!guild) return { status: "failed", errors: ["Guild is unavailable for gathering VC permission restoration."] };
    try {
      const restored = await restoreGatheringVcPermission(guild, settings, { eventId, force });
      if (restored === true || restored?.status === "restored") return { status: "restored", errors: [] };
      const after = await getGatheringVcRestoreState({ guild, settings, reservation, eventId }).catch(() => null);
      return {
        status: normalizeGatheringVcRestoreStatus(after ?? stateSource) || "retry_wait",
        errors: ["Gathering VC permission restoration was not confirmed."],
      };
    } catch (error) {
      return { status: "retry_wait", errors: [truncate(error?.message ?? error)] };
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
      { $set: { status: "canceling", kokuchiStatus: "canceling", cancelRequested: true, reminderStatus: "canceled", cancellationStartedAt: new Date(), cancellationError: null }, $inc: { lifecycleRevision: 1 }, $unset: { activeKey: 1 } },
      { returnDocument: "after", lean: true },
    );
    if (!claimed) return { status: "busy", reservation, errors: ["対象予約は別の処理で更新中です。"] };
    clearReservationTimers(claimed.reservationId);
    if (completeReservationCancellation) {
      const result = await completeReservationCancellation({ reservation: claimed, guild });
      return { ...result, before: reservation, after: { settings: result.settings ?? null, reservation: claimed }, actorUserId };
    }
    const durable = await cancelDurableWork(guild.id, claimed.reservationId);
    const roleRemoval = await cancelRoleRemovalWait({ guild, reservation: claimed }).catch((error) => ({ errors: [truncate(error?.message ?? error)] }));
    const restore = await restoreIfNeeded(guild, settings, claimed, { force: true });
    const errors = [...durable.errors, ...(roleRemoval.errors ?? []), ...restore.errors];
    const status = "canceled";
    const cleanupAt = cleanupAtForRestoreStatus(restore.status);
    await reservationModel.updateOne(
      { _id: claimed._id, status: "canceling" },
      {
        $set: { status, kokuchiStatus: "canceled", cancelRequested: true, cancellationResults: { durable, roleRemoval, permissionRestored: restore.status }, canceledAt: new Date(), cancellationError: null, ...(cleanupAt ? { cleanupAt } : {}) },
        ...(cleanupAt ? {} : { $unset: { cleanupAt: 1 } }),
      },
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
        const claimed = await reservationModel.updateOne(
          { _id: target.reservation._id, status: { $in: ACTIVE_STATUSES } },
          { $set: { status: "canceling", kokuchiStatus: "canceling", cancelRequested: true, reminderStatus: "canceled", cancellationStartedAt: new Date(), cancellationError: null }, $inc: { lifecycleRevision: 1 }, $unset: { activeKey: 1, cleanupAt: 1 } },
        );
        if (claimed?.matchedCount !== 1) {
          return { status: "busy", reservation: target.reservation, before, errors: ["対象kokuchiイベントは別の処理で更新されました。"] };
        }
        clearReservationTimers(target.reservation.reservationId);
      }
      const durable = target.reservation ? await cancelDurableWork(guild.id, target.reservation.reservationId) : { results: [], errors: [] };
      const roleRemoval = target.reservation
        ? await cancelRoleRemovalWait({ guild, reservation: target.reservation }).catch((error) => ({ errors: [truncate(error?.message ?? error)] }))
        : { errors: [] };
      if (target.reservation) {
        await reservationModel.updateOne(
          { _id: target.reservation._id, status: "canceling" },
          { $set: { status: "canceled", kokuchiStatus: "canceled", cancelRequested: true, reminderStatus: "canceled", canceledAt: new Date(), cancellationError: null }, $unset: { cleanupAt: 1 } },
        );
      }
      const restore = await restoreIfNeeded(guild, settings, target.reservation, { force: true });
      const eventErrors = [...durable.errors, ...(roleRemoval.errors ?? [])];
      const errors = [...eventErrors, ...restore.errors];
      const patch = {
        ...(settings?.kokuchiPreNoticeState ? { kokuchiPreNoticeState: stateAfterForce(settings.kokuchiPreNoticeState) } : {}),
        ...(settings?.kokuchiGatheringReminderState ? { kokuchiGatheringReminderState: stateAfterForce(settings.kokuchiGatheringReminderState) } : {}),
        ...(settings?.gatheringVcUnlockState ? { gatheringVcUnlockState: restore.status === "restored" ? "closed" : stateAfterForce(settings.gatheringVcUnlockState, false) } : {}),
        ...(restore.status === "restored" ? { gatheringVcRestorePending: false, gatheringVcRestorePendingAt: null, gatheringVcPermissionBeforeOpen: null, gatheringVcRestoreEventId: null, gatheringVcRestoreEventRevision: null } : {}),
      };
      const targetEventId = target.reservation?.reservationId ?? null;
      const settingsReferencesTarget = Boolean(targetEventId && (
        settings?.kokuchiEventId === targetEventId
        || settings?.gatheringVcStateEventId === targetEventId
      ));
      let afterSettings = settings;
      if (!(targetEventId && !settingsReferencesTarget)) {
        try {
          afterSettings = targetEventId
            ? await persistEventSettings(guild.id, targetEventId, { set: patch })
            : await saveGuildSettings(guild.id, patch);
        } catch (error) {
          errors.push(`GuildSettings mirror update failed: ${truncate(error?.message ?? error)}`);
          logger.warn?.(`kokuchi force termination mirror update failed for ${guild.id}: ${error?.message ?? error}`);
        }
      }
      let afterReservation = target.reservation;
      if (target.reservation) {
        const status = "canceled";
        const cleanupAt = cleanupAtForRestoreStatus(restore.status);
        afterReservation = await reservationModel.findOneAndUpdate(
          { _id: target.reservation._id, status: { $in: ["canceling", "canceled", ...ACTIVE_STATUSES] } },
          {
            $set: { status, kokuchiStatus: "canceled", cancelRequested: true, reminderStatus: "canceled", cancellationResults: { durable, roleRemoval, permissionRestored: restore.status, forced: true }, canceledAt: new Date(), cancellationError: null, ...(cleanupAt ? { cleanupAt } : {}) },
            $unset: { activeKey: 1, cancellationStartedAt: 1, ...(cleanupAt ? {} : { cleanupAt: 1 }) },
          },
          { returnDocument: "after", lean: true },
        );
      }
      // A restore retry is intentionally not allowed to turn an already
      // canceled kokuchi event back into a partial lifecycle state. The
      // restore status and error remain visible separately on the event.
      const result = eventErrors.length ? "partial" : "success";
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
      return { status: "canceled", result, before, after: { settings: afterSettings, reservation: afterReservation }, permissionRestored: restore.status, errors, actorUserId };
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
      const restoreTarget = await getRestoreTarget(guild.id, settings, targetId);
      const targetReservation = restoreTarget.reservation;
      const settingsMatchesTarget = Boolean(targetReservation && (
        settings?.kokuchiEventId === targetReservation.reservationId
        || settings?.gatheringVcStateEventId === targetReservation.reservationId
        || (!settings?.kokuchiEventId && !settings?.gatheringVcStateEventId)
      ));
      const settingsRestoreStatus = normalizeGatheringVcRestoreStatus(settings ?? {});
      const restoreStatePending = Boolean(targetReservation && (
        isGatheringVcRestoreBlocking(normalizeGatheringVcRestoreStatus(targetReservation))
        || (settingsMatchesTarget && isGatheringVcRestoreBlocking(settingsRestoreStatus))
      ));
      const savedSnapshot = targetReservation?.gatheringVcPermissionBeforeOpen
        ?? (settingsMatchesTarget ? settings?.gatheringVcPermissionBeforeOpen : null);
      if (
        !restoreStatePending
        || savedSnapshot
      ) {
        return { status: "rejected", errors: ["状態のみ解除は、権限復元に失敗した強制終了後で、権限スナップショットがない場合だけ実行できます。"] };
      }
      const target = restoreTarget;
      if (target.ambiguous) return { status: "ambiguous", candidates: target.candidates.map((item) => ({ reservationId: item.reservationId, eventAt: item.eventAt, status: item.status })), errors: ["複数の開催回候補があるため状態のみ解除を停止しました。"] };
      const reservation = target.reservation;
      const settingsOwnsOrphanedRestore = !settings?.kokuchiEventId && !settings?.gatheringVcStateEventId;
      const settingsOwnsEvent = settingsOwnsOrphanedRestore || settings?.kokuchiEventId === reservation.reservationId;
      const settingsOwnsRestoreMirror = settings?.gatheringVcStateEventId === reservation.reservationId;
      const patch = {
        ...(settingsOwnsEvent ? {
          kokuchiEventId: null,
          kokuchiEventAt: null,
          kokuchiPreNoticeState: stateAfterForce(settings?.kokuchiPreNoticeState),
          kokuchiGatheringReminderState: stateAfterForce(settings?.kokuchiGatheringReminderState),
        } : {}),
        ...(settingsOwnsEvent || settingsOwnsRestoreMirror ? {
          gatheringVcUnlockState: "closed",
          gatheringVcRestorePending: false,
          gatheringVcRestoreStatus: "not_required",
          gatheringVcRestoreFailureCode: "state_only_cleared",
          gatheringVcRestoreLastError: `State-only clear accepted: ${truncate(reason, 500)}`,
          gatheringVcRestoreNextRetryAt: null,
           gatheringVcRestorePendingAt: null,
           gatheringVcPermissionBeforeOpen: null,
           gatheringVcRestoreEventId: null,
           gatheringVcRestoreEventRevision: null,
           gatheringVcStateEventId: null,
          gatheringVcUnlockChannelId: null,
        } : {}),
      };
      const shouldPatchEventMirror = Boolean(
        reservation
        && (settingsOwnsRestoreMirror || (settingsOwnsEvent && !settingsOwnsOrphanedRestore)),
      );
      const mirrorWarnings = [];
      let afterSettings = settings;
      if (Object.keys(patch).length) {
        try {
          afterSettings = shouldPatchEventMirror
            ? await persistEventSettings(guild.id, reservation.reservationId, { set: patch })
            : await saveGuildSettings(guild.id, patch);
        } catch (error) {
          mirrorWarnings.push(`GuildSettings mirror update failed: ${truncate(error?.message ?? error)}`);
          logger.warn?.(`kokuchi state-only mirror update failed for ${guild.id}: ${error?.message ?? error}`);
        }
      }
      const healthClear = healthModel.updateOne?.({ guildId: guild.id }, { $set: { lastRecoveryFailureAt: null, lastRecoveryFailureAction: null, lastRecoveryFailureReason: null } });
      if (healthClear?.catch) await healthClear.catch(() => {});
      let afterReservation = reservation;
      if (reservation) afterReservation = await reservationModel.findOneAndUpdate(
        { _id: reservation._id, status: { $in: [...ACTIVE_STATUSES, ...TERMINAL_STATUSES] } },
        {
          $set: {
            status: "canceled",
            kokuchiStatus: "canceled",
            cancelRequested: true,
            reminderStatus: "canceled",
            gatheringVcRestoreStatus: "not_required",
            gatheringVcRestoreFailureCode: "state_only_cleared",
            gatheringVcRestoreLastError: `State-only clear accepted: ${truncate(reason, 500)}`,
            gatheringVcRestoreNextRetryAt: null,
            gatheringVcRestoreAttemptCount: 0,
            gatheringVcRestorePending: false,
            recoveryReason: `State-only clear: ${truncate(reason, 500)}`,
            canceledAt: new Date(),
            cleanupAt: cleanupAtForRestoreStatus("not_required"),
          },
          $unset: {
            activeKey: 1,
            cancellationStartedAt: 1,
            gatheringVcUnlockChannelId: 1,
            gatheringVcPermissionBeforeOpen: 1,
            gatheringVcRestorePendingAt: 1,
            gatheringVcRestoreEventId: 1,
            gatheringVcRestoreEventRevision: 1,
            gatheringVcClosingAt: 1,
          },
        },
        { returnDocument: "after", lean: true },
      );
      if (!afterReservation) return { status: "failed", result: "failed", before: { settings, reservation }, errors: ["対象kokuchiイベントの状態確定に失敗しました。"], reason, actorUserId };
      return { status: "cleared", result: "success", warnings: [...mirrorWarnings, "権限スナップショット欠損のため、集合VC権限は復元されていない可能性があります。実際の権限状態を確認してください。"], before: { settings, reservation }, after: { settings: afterSettings, reservation: afterReservation }, reason, actorUserId };
    } catch (error) {
      return { status: "failed", result: "failed", errors: [truncate(error?.message ?? error)] };
    } finally {
      await releaseMongoLease(lease).catch(() => {});
    }
  }

  async function restorePermission({ guild, targetId = null } = {}) {
    const lease = await acquireMongoLease(`kokuchi-recovery:${guild.id}`, { leaseMs: 2 * 60 * 1000 });
    if (!lease) return { status: "busy", result: "failed", errors: ["kokuchi recovery is already running."] };
    try {
      const settings = await getGuildSettings(guild.id);
      const target = await getRestoreTarget(guild.id, settings, targetId);
      const restorationReservation = target.reservation;
      if (target.ambiguous) return { status: "ambiguous", result: "failed", candidates: target.candidates.map((item) => ({ reservationId: item.reservationId, eventAt: item.eventAt, status: item.status })), errors: ["複数の集合VC復元対象イベントがあるため、対象イベントを指定してから再試行してください。"] };
      if (!restorationReservation) return { status: target.orphaned ? "orphaned" : "not-found", result: "failed", errors: ["指定された集合VC復元イベントが見つかりません。"] };
      const result = await restoreIfNeeded(guild, settings, restorationReservation, { force: true });
      return { status: result.status, result: result.status === "restored" || result.status === "not_needed" ? "success" : "failed", before: settings, errors: result.errors };
    } finally {
      await releaseMongoLease(lease).catch((error) => logger.error?.(`kokuchi recovery lease release failed for ${guild.id}: ${error?.message ?? error}`));
    }
  }

  return { getCurrentTarget, normalCancel, forceTerminate, clearStateOnly, restorePermission };
}
