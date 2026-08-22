/**
 * The only GuildSettings keys that represent administrator-owned
 * configuration.  Runtime/lifecycle state is deliberately not included in
 * this catalog; anything not listed here is rejected by the versioned writer
 * and omitted from every revision snapshot.
 */
export const CONFIG_SCHEMA_VERSION = 1;

export const ADMIN_CONFIGURATION_CATALOG = Object.freeze([
  "splitMode",
  "tempRoleId",
  "parentChannelId",
  "childCategoryId",
  "waitingVcCategoryId",
  "waitingVcName",
  "splitFeedbackChannelId",
  "finishMessage",
  "transferWaitSeconds",
  "noticeWaitMinutes",
  "roleRemoveWaitMinutes",
  "voiceParticipantRoleId",
  "voiceReminderEnabled",
  "voiceReminderParentChannelIds",
  "voiceReminderParentChannelId",
  "voiceReminderChildCategoryId",
  "kokuchiAnnouncementChannelId",
  "wadaiChannelId",
  "splitStartChannelId",
  "kokuchiOverviewChannelId",
  "gatheringVoiceChannelId",
  "kokuchiEventTime",
  "kokuchiEventTimeConfigured",
  "kokuchiMentionRoleIds",
  "vcDmEnabled",
  "vcDmPanelChannelId",
  "vcDmTargetCategoryId",
  "vcDmTargetChannelIds",
  "vcDmExcludedCategoryIds",
  "vcDmExcludedChannelIds",
  "logChannelId",
  "formChannelId",
  "formSendChannelId",
  "reviewSendChannelId",
  "formModeratorRoleId",
  "callWaitEnabled",
  "callWaitRoleId",
  "bosyuMentionRoleId",
  "callWaitPromptChannelId",
  "callWaitNoticeChannelId",
  "callWaitVoiceCategoryId",
  "callWaitMode",
  "callWaitIntervalMinutes",
  "oteboQuickConfirmSeconds",
  "vcControlCategoryId",
  "vcControlNotifyRoleId",
  "voiceExitScheduleKeepMessage",
  "profileIntroductionChannelId",
  "statusBoardChannelId",
  "fukyoThemeChannelId",
  "fukyoWeeklyThemeEnabled",
  "fukyoThemes",
  "wadaiTopics",
  "wadaiTopicsVersion",
]);

export const ADMIN_CONFIGURATION_KEYS = new Set(ADMIN_CONFIGURATION_CATALOG);
export const CONFIGURATION_CATALOG = ADMIN_CONFIGURATION_CATALOG;

// A deliberately tiny, explicit bridge for runtime state that must commit
// atomically with one administrator setting.  This is not a general runtime
// patch channel: every key must be reviewed and added here intentionally.
export const VERSIONED_COMPANION_RUNTIME_CATALOG = Object.freeze([
  "fukyoWeeklyThemeEnabledAt",
]);
export const VERSIONED_COMPANION_RUNTIME_KEYS = new Set(VERSIONED_COMPANION_RUNTIME_CATALOG);

// Exported for migration/tests/documentation.  The allowlist above is the
// authoritative exclusion mechanism, so newly-added runtime fields remain
// outside snapshots until they are intentionally classified as config.
export const RUNTIME_CONFIGURATION_KEYS = Object.freeze([
  "callWaitPrompt",
  "callWaitPendingNotice",
  "callWaitSkippedNotice",
  "callWaitRoleGeneration",
  "kokuchiEventId",
  "kokuchiEventAt",
  "kokuchiPreNoticeState",
  "kokuchiPreNoticeSentAt",
  "gatheringVcUnlockState",
  "gatheringVcRestorePending",
  "gatheringVcRestoreAttempts",
  "gatheringVcRestoreEventId",
  "gatheringVcRestorePendingAt",
  "gatheringVcRestoreAttemptCount",
  "gatheringVcRestoreFailureCode",
  "gatheringVcRestoreLastError",
  "gatheringVcRestoreNextRetryAt",
  "gatheringVcRestoreStatus",
  "gatheringVcPermissionBeforeOpen",
  "gatheringVcStateEventId",
  "gatheringVcOpenedAt",
  "gatheringVcClosingAt",
  "gatheringVcUnlockAt",
  "gatheringVcUnlockChannelId",
  "kokuchiGatheringReminderState",
  "kokuchiGatheringReminderAt",
  "kokuchiGatheringReminderSentAt",
  "kokuchiPreNoticeAt",
  "kokuchiPreNoticeChannelId",
  "kokuchiStatus",
  "autoSplitSuggestions",
  "voiceMonitorVoiceChannelIds",
  "waitingMonitorStatus",
  "waitingMonitorHeartbeatAt",
  "waitingMonitorLeaseOwner",
  "waitingMonitorLeaseRetryAt",
  "waitingVcCleanupCompleted",
  "oteboRecruitments",
  "oteboRecruitmentSlot",
  "oteboRecruitmentConfirmation",
  "oteboVoiceStatusSessions",
  "wadaiDaily",
  "lastKokuchiPostedAt",
  "lastKokuchiWeekday",
  "fukyoWeeklyThemeEnabledAt",
  "configRevision",
  "configSchemaVersion",
]);

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object ?? {}, key);
}

function canonicalValue(value, key = null) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    const values = value.map((item) => canonicalValue(item));
    // These fields represent unordered Discord IDs.  Sorting/deduping makes
    // semantically equivalent settings produce the same snapshot.
    if (key && new Set([
      "kokuchiMentionRoleIds",
      "voiceReminderParentChannelIds",
      "vcDmTargetChannelIds",
      "vcDmExcludedCategoryIds",
      "vcDmExcludedChannelIds",
    ]).has(key)) {
      return [...new Set(values.map((item) => String(item)))].sort();
    }
    return values;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .filter((childKey) => value[childKey] !== undefined)
        .sort()
        .map((childKey) => [childKey, canonicalValue(value[childKey], childKey)]),
    );
  }
  return value;
}

/** Return a stable, allowlisted snapshot from a raw GuildSettings document. */
export function canonicalizeConfiguration(settings = {}) {
  const snapshot = {};
  for (const key of ADMIN_CONFIGURATION_CATALOG) {
    // An explicitly persisted null is different from an absent key: it is an
    // administrator's durable clear that must continue to shadow an
    // environment default.  Only an absent/undefined key means that the
    // setting was never persisted and may be inherited at runtime.
    if (hasOwn(settings, key) && settings[key] !== undefined) snapshot[key] = canonicalValue(settings[key], key);
  }
  return Object.fromEntries(Object.keys(snapshot).sort().map((key) => [key, snapshot[key]]));
}

function valuesEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Produce explicit added/changed/removed metadata.  Values are already
 * canonical and therefore safe to persist and render without runtime state.
 */
export function diffConfiguration(from = {}, to = {}) {
  const before = canonicalizeConfiguration(from);
  const after = canonicalizeConfiguration(to);
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const added = [];
  const changed = [];
  const removed = [];
  for (const key of keys) {
    const hasBefore = hasOwn(before, key);
    const hasAfter = hasOwn(after, key);
    if (!hasBefore && hasAfter) added.push({ key, to: after[key] });
    else if (hasBefore && !hasAfter) removed.push({ key, from: before[key] });
    else if (!valuesEqual(before[key], after[key])) changed.push({ key, from: before[key], to: after[key] });
  }
  return {
    added,
    changed,
    removed,
    count: added.length + changed.length + removed.length,
    keys: [...added, ...changed, ...removed].map((entry) => entry.key).sort(),
  };
}

export function pickConfigurationPatch(patch = {}) {
  const unknown = Object.keys(patch).filter((key) => !ADMIN_CONFIGURATION_KEYS.has(key));
  if (unknown.length > 0) {
    const error = new Error(`Unsupported administrator configuration key(s): ${unknown.join(", ")}`);
    error.code = "UNSUPPORTED_CONFIGURATION_KEY";
    error.keys = unknown;
    throw error;
  }
  return Object.fromEntries(
    Object.entries(patch)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, canonicalValue(value, key)]),
  );
}

export function pickVersionedCompanionRuntimePatch(patch = {}) {
  const unknown = Object.keys(patch ?? {}).filter((key) => !VERSIONED_COMPANION_RUNTIME_KEYS.has(key));
  if (unknown.length > 0) {
    const error = new Error(`Unsupported versioned companion runtime key(s): ${unknown.join(", ")}`);
    error.code = "UNSUPPORTED_VERSIONED_COMPANION_KEY";
    error.keys = unknown;
    throw error;
  }
  return Object.fromEntries(
    Object.entries(patch ?? {})
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, canonicalValue(value, key)]),
  );
}

export function normalizeConfigurationRevision(value) {
  const revision = Number(value);
  return Number.isInteger(revision) && revision >= 0 ? revision : 0;
}
