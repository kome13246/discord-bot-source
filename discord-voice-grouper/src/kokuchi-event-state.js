export const KOKUCHI_STATUS_VALUES = Object.freeze([
  "scheduled",
  "running",
  "canceling",
  "canceled",
  "completed",
]);

export const GATHERING_VC_RESTORE_STATUS_VALUES = Object.freeze([
  "not_required",
  "pending",
  "restoring",
  "retry_wait",
  "restored",
  "failed",
]);

export const GATHERING_VC_RESTORE_BLOCKING_STATUS_VALUES = Object.freeze([
  "pending",
  "restoring",
  "retry_wait",
  "failed",
]);

export const KOKUCHI_RESERVATION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_GATHERING_VC_RESTORE_ATTEMPTS = 6;

const RETRY_DELAYS_MS = Object.freeze([
  5_000,
  15_000,
  30_000,
  60_000,
  5 * 60_000,
  15 * 60_000,
]);

export function normalizeKokuchiStatus(value) {
  if (KOKUCHI_STATUS_VALUES.includes(value)) return value;
  if (["pending", "failed"].includes(value)) return "scheduled";
  if (["processing", "published_unconfirmed"].includes(value)) return "running";
  if (["sent", "published", "completed"].includes(value)) return "completed";
  if (value === "canceling") return "canceling";
  if (["canceled", "cancel_partial"].includes(value)) return "canceled";
  return null;
}

export function normalizeGatheringVcRestoreStatus(record = {}) {
  if (record.gatheringVcRestorePending === true
    && [undefined, null, "not_required", "restored"].includes(record.gatheringVcRestoreStatus)) {
    return "pending";
  }
  if (GATHERING_VC_RESTORE_STATUS_VALUES.includes(record.gatheringVcRestoreStatus)) {
    return record.gatheringVcRestoreStatus;
  }
  if (record.gatheringVcRestorePending === true) return "pending";
  return "not_required";
}

export function isGatheringVcRestoreBlocking(status) {
  return GATHERING_VC_RESTORE_BLOCKING_STATUS_VALUES.includes(status);
}

export function isGatheringVcPermissionSnapshotValid(snapshot, { channelId = null, guildId = null } = {}) {
  if (!snapshot || typeof snapshot !== "object") return false;
  if (channelId !== null && snapshot.channelId !== channelId) return false;
  if (guildId !== null && snapshot.guildId !== guildId) return false;
  return [snapshot.viewChannel, snapshot.connect]
    .every((value) => value === null || typeof value === "boolean");
}

export function isGatheringVcRestoreOwnedByEvent(record, eventId) {
  if (!record || !eventId) return false;
  return !record.gatheringVcRestoreEventId || record.gatheringVcRestoreEventId === eventId;
}

export function getKokuchiReservationCleanupAt({ restoreStatus = "not_required", now = new Date() } = {}) {
  if (isGatheringVcRestoreBlocking(restoreStatus)) return null;
  const timestamp = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(timestamp)) return null;
  return new Date(timestamp + KOKUCHI_RESERVATION_RETENTION_MS);
}

export function isKokuchiEventActionInvalid(event, expectedRevision = null) {
  if (!event) return true;
  const lifecycleStatus = normalizeKokuchiStatus(event.kokuchiStatus ?? event.status);
  if (["canceling", "canceled"].includes(lifecycleStatus)
    || ["canceling", "cancel_partial", "canceled"].includes(event.status)
    || event.cancelRequested === true) return true;
  if (expectedRevision !== null && expectedRevision !== undefined
    && Number(event.lifecycleRevision ?? 0) !== Number(expectedRevision)) return true;
  return false;
}

export function isGatheringVcRestoreRetryable(status, attemptCount = 0) {
  return ["pending", "retry_wait"].includes(status)
    && Number(attemptCount) < MAX_GATHERING_VC_RESTORE_ATTEMPTS;
}

export function getGatheringVcRestoreRetryDelayMs(attemptCount = 0) {
  const index = Math.max(0, Math.min(RETRY_DELAYS_MS.length - 1, Number(attemptCount) || 0));
  return RETRY_DELAYS_MS[index];
}

/** The strict event/session predicate used before closing the gathering VC. */
export function canCloseGatheringVcAfterSplit({
  eventId,
  settings = null,
  event = null,
  session = null,
  targetChannelId = null,
  guildId = null,
} = {}) {
  const eventStatus = normalizeKokuchiStatus(event?.kokuchiStatus ?? event?.status);
  const restoreStatus = normalizeGatheringVcRestoreStatus(event ?? {});
  const snapshot = event?.gatheringVcPermissionBeforeOpen;
  const snapshotValid = isGatheringVcPermissionSnapshotValid(snapshot, { channelId: targetChannelId, guildId });
  return Boolean(
    eventId
    && settings?.kokuchiEventId === eventId
    && settings?.gatheringVcStateEventId === eventId
    && event
    && event.reservationId === eventId
    && ["scheduled", "running", "completed"].includes(eventStatus)
    && event.gatheringVcUnlockState === "opened"
    && event.gatheringVcOpenedAt
    && snapshotValid
    && isGatheringVcRestoreOwnedByEvent(event, eventId)
    && event.gatheringVcUnlockChannelId === targetChannelId
    && event.gatheringVcRestorePending !== true
    && restoreStatus === "not_required"
    && session?.kokuchiEventId === eventId
  );
}

export function hasMatchingEventIdentity(record, eventId) {
  if (!record || !eventId) return false;
  return record.kokuchiEventId === eventId
    || record.reservationId === eventId
    || record.gatheringVcStateEventId === eventId;
}

export function classifyGatheringVcRestoreBlock({ eventId, event = null, settings = null } = {}) {
  const settingsPending = settings?.gatheringVcRestorePending === true;
  const settingsStateEventId = settings?.gatheringVcStateEventId ?? null;
  const status = normalizeGatheringVcRestoreStatus(event ?? settings ?? {});
  const settingsBelongsToEvent = Boolean(eventId && settingsStateEventId === eventId);
  const ownedSettings = settingsBelongsToEvent ? settings : null;
  const source = event ?? ownedSettings ?? null;
  const failureCode = event?.gatheringVcRestoreFailureCode ?? ownedSettings?.gatheringVcRestoreFailureCode ?? null;
  const savedSnapshot = event?.gatheringVcPermissionBeforeOpen ?? ownedSettings?.gatheringVcPermissionBeforeOpen ?? null;

  if (event?.gatheringVcRestoreEventId && event.reservationId
    && event.gatheringVcRestoreEventId !== event.reservationId
    && (isGatheringVcRestoreBlocking(status) || savedSnapshot)) {
    return {
      code: "restore_event_mismatch",
      severity: "error",
      message: "集合VC復元情報のイベントIDが予約イベント本体と一致しません。対象イベントを指定して確認してください。",
    };
  }

  if (source && isGatheringVcRestoreBlocking(status) && source.gatheringVcRestorePending !== true) {
    return {
      code: "restore_state_inconsistent",
      severity: "error",
      message: "集合VCの復元状態がblockingなのにpendingフラグがfalseです。管理者による整合性確認が必要です。",
    };
  }
  if (event?.reservationId && eventId && event.reservationId !== eventId && isGatheringVcRestoreBlocking(status)) {
    return {
      code: "orphaned_restore_state",
      severity: "error",
      message: "集合VCの復元状態が別のkokuchiイベントに紐づいています。対象イベントを指定してください。",
    };
  }
  if (event?.reservationId && !eventId && isGatheringVcRestoreBlocking(status)) {
    return {
      code: "orphaned_restore_state",
      severity: "error",
      message: "集合VCの復元状態に現在のkokuchiイベントIDがありません。管理者による確認が必要です。",
    };
  }
  if (settingsPending && eventId && settingsStateEventId !== eventId) {
    return {
      code: "orphaned_restore_state",
      severity: "error",
      message: "GuildSettingsの集合VC復元状態が表示対象イベントと一致しません。",
    };
  }
  if (settingsPending && !eventId) {
    return {
      code: "orphaned_restore_state",
      severity: "error",
      message: "集合VCの復元待ちにイベントIDがありません。管理者による確認が必要です。",
    };
  }
  if (settingsPending && eventId && !event) {
    return {
      code: "orphaned_restore_state",
      severity: "error",
      message: "集合VC復元待ちに対応するkokuchiイベントが見つかりません。",
    };
  }
  if (settingsPending && eventId && settingsStateEventId === eventId && !isGatheringVcRestoreBlocking(status)) {
    return {
      code: "orphaned_restore_state",
      severity: "error",
      message: "イベントとGuildSettingsの集合VC復元状態が一致しません。",
    };
  }
  if (isGatheringVcRestoreBlocking(status) && !savedSnapshot) {
    return {
      code: "restore_snapshot_missing",
      severity: "error",
      message: "集合VC復元待ちですが、開放前の権限スナップショットがありません。",
    };
  }
  if (failureCode === "snapshot_missing") {
    return {
      code: "restore_snapshot_missing",
      severity: "error",
      message: "集合VC開放前の権限スナップショットがありません。",
    };
  }
  if (status === "failed" || failureCode === "max_attempts"
    || Number(event?.gatheringVcRestoreAttemptCount ?? ownedSettings?.gatheringVcRestoreAttemptCount ?? 0) >= MAX_GATHERING_VC_RESTORE_ATTEMPTS) {
    return {
      code: "restore_max_attempts_exceeded",
      severity: "error",
      message: "集合VC権限復元の最大再試行回数を超えました。管理者による復元または確認が必要です。",
    };
  }
  if (status === "retry_wait" || status === "restoring") {
    return {
      code: "restore_retrying",
      severity: "warning",
      message: "集合VC権限の自動復元を再試行中です。",
    };
  }
  if (status === "pending") {
    return {
      code: "restore_waiting",
      severity: "info",
      message: "正常なロール解除待ちに伴う集合VC復元待ちです。",
    };
  }
  return null;
}
