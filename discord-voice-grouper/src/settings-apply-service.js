import { ADMIN_CONFIGURATION_CATALOG, canonicalizeConfiguration, diffConfiguration } from "./settings-configuration.js";
import { isVoiceChannelControlTarget } from "./voice-channel-control-service.js";

export const APPLY_JOB_STATUSES = Object.freeze([
  "pending",
  "processing",
  "applied",
  "retry_wait",
  "failed",
  "superseded",
  "blocked",
]);

const TERMINAL_STATUSES = new Set(["applied", "superseded", "blocked"]);
const RETRYABLE_STATUSES = new Set(["pending", "retry_wait"]);
const KNOWN_NON_MUTATING_RESULTS = new Set([
  "applied",
  "current",
  "absent",
  "not-configured",
  "hidden",
  "disabled",
  "skipped",
  "not-enabled-yet",
  "already-recorded",
  "removed",
  "duplicates-removed",
  "cleanup-pending",
  "configured",
]);

const DEFAULT_LEASE_MS = 120_000;
const DEFAULT_BACKOFF_BASE_MS = 5_000;
const DEFAULT_BACKOFF_MAX_MS = 15 * 60_000;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_SHUTDOWN_DRAIN_MS = 30_000;
export const MAX_MANUAL_RETRIES = 3;
const VOICE_CONTROL_SUCCESS_STATUSES = new Set(["created", "updated"]);

function plain(value) {
  if (value && typeof value.toObject === "function") return value.toObject();
  return value ?? null;
}

async function lean(value) {
  if (value && typeof value.lean === "function") return value.lean();
  return value;
}

async function executeQuery(value) {
  return lean(await value);
}

function dateValue(value, fallback = new Date()) {
  const date = value instanceof Date ? value : new Date(value ?? fallback);
  return Number.isNaN(date.getTime()) ? new Date(fallback) : date;
}

function revisionOf(settings) {
  const value = Number(settings?.configRevision ?? settings?.revision ?? 0);
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function textError(error, max = 800) {
  return String(error?.message ?? error ?? "unknown error")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .slice(0, max);
}

function nowOrFactory(now) {
  const value = typeof now === "function" ? now() : now;
  return dateValue(value);
}

function setUpdateStatus(job, status, now, extra = {}) {
  const at = nowOrFactory(now);
  const update = {
    $set: {
      status,
      updatedAt: at,
      ...extra,
    },
  };
  if (status === "applied") update.$set.appliedAt = at;
  if (status === "failed" || status === "blocked") update.$set.failedAt = at;
  return update;
}

function changedKeysOf(job) {
  return Array.isArray(job?.changedKeys) ? [...new Set(job.changedKeys.map(String))] : [];
}

export function classifyConfigurationChanges(changedKeys = []) {
  const keys = changedKeys.map(String);
  const features = new Set();
  for (const key of keys) {
    if (key === "statusBoardChannelId") features.add("status_board");
    if (/^profileIntroductionChannelId$/.test(key)) features.add("profile");
    if (/^(callWait|bosyu|otebo)/.test(key)) features.add("callwait");
    if (/^(kokuchi|wadaiChannel|splitStartChannelId|gatheringVoiceChannelId)/.test(key)) features.add("kokuchi");
    if (/^kokuchiEventTime(?:Configured)?$/.test(key)) {
      features.add("kokuchi");
      features.add("vc_dm");
    }
    if (/^vcDm/.test(key)) features.add("vc_dm");
    if (/^(vcControl|voiceExitScheduleKeepMessage)/.test(key)) features.add("voice_control");
    if (/^(fukyo|wadaiTopics)/.test(key)) features.add("fukyo");
    if (/^(form|review|logChannelId)/.test(key)) features.add("forms");
    if (/^(split|tempRoleId|parentChannelId|childCategoryId|waitingVc|voiceParticipantRoleId|voiceReminder|finishMessage|transferWaitSeconds)/.test(key)) features.add("splitvc");
  }
  return [...features].sort();
}

export class SettingsApplyJobUnknownOutcomeError extends Error {
  constructor(message, cause = null) {
    super(message);
    this.name = "SettingsApplyJobUnknownOutcomeError";
    this.code = "SETTINGS_APPLY_UNKNOWN_OUTCOME";
    this.unknownOutcome = true;
    this.cause = cause;
  }
}

export class SettingsApplyJobRetryError extends Error {
  constructor(message, cause = null) {
    super(message);
    this.name = "SettingsApplyJobRetryError";
    this.code = "SETTINGS_APPLY_RETRY";
    this.retryable = true;
    this.cause = cause;
  }
}

export class SettingsApplyJobBlockedError extends Error {
  constructor(message, result = null) {
    super(message);
    this.name = "SettingsApplyJobBlockedError";
    this.code = "SETTINGS_APPLY_BLOCKED";
    this.result = result;
  }
}

export class SettingsApplyLeaseLostError extends Error {
  constructor(message = "The apply-job lease was lost before the next Discord operation.") {
    super(message);
    this.name = "SettingsApplyLeaseLostError";
    this.code = "SETTINGS_APPLY_LEASE_LOST";
    this.leaseLost = true;
    this.retryable = true;
  }
}

export class SettingsApplyPreflightBlockedError extends Error {
  constructor(report, reasons = []) {
    super("Rollback preflight blocked because required Discord resources or permissions are unsafe.");
    this.name = "SettingsApplyPreflightBlockedError";
    this.code = "SETTINGS_APPLY_PREFLIGHT_BLOCKED";
    this.report = report;
    this.reasons = reasons;
  }
}

function resultStatus(result) {
  if (!result) return "applied";
  return String(result.status ?? result.result ?? "applied").toLowerCase();
}

function didMutateUnknown(result) {
  return Boolean(result?.unknownOutcome || result?.status === "unknown" || result?.status === "uncertain");
}

/**
 * Dispatch only the idempotent operational reconciliation associated with a
 * revision.  No GuildSettings writes are performed here.  A mutating
 * Discord operation that does not return a definite result is deliberately
 * blocked instead of being blindly repeated by the retry loop.
 */
export function createSettingsApplyDispatcher({
  getGuild,
  getGuildSettings,
  operationalStatusBoardService = null,
  profileRegistrationPanelService = null,
  oteboRecruitmentPanelService = null,
  vcDmService = null,
  voiceChannelControlService = null,
  voiceMonitorSessions = null,
  isVoiceChannelMonitored = null,
  stopVoiceMonitorSession = null,
  reconcilePersistedVoiceParticipantRoleGrants = null,
  rescheduleCurrentKokuchiEvent = null,
  requestOperationalStatusRefresh = null,
  fukyoThemeService = null,
  callWaitReconciler = null,
  logger = console,
} = {}) {
  async function dispatch(job, context = {}) {
    const guildId = job?.guildId;
    const guild = context.guild ?? await getGuild?.(guildId);
    if (!guild) return { status: "blocked", reason: "guild-unavailable" };
    const settings = context.settings ?? await getGuildSettings?.(guildId) ?? {};
    const keys = changedKeysOf(job);
    const features = classifyConfigurationChanges(keys);
    const results = [];

    const runMutating = async (label, operation) => {
      if (typeof operation !== "function") {
        results.push({ feature: label, status: "applied", noOp: true });
        return;
      }
      try {
        await context.assertLease?.();
        const result = await operation();
        await context.assertLease?.();
        if (didMutateUnknown(result)) throw new SettingsApplyJobUnknownOutcomeError(`${label} returned an unknown Discord outcome.`);
        const status = resultStatus(result);
        if (status === "blocked") {
          throw new SettingsApplyJobBlockedError(`${label} is blocked and requires operator attention.`, result);
        }
        if (result?.retryable || ["retry", "retry_wait", "lease-unavailable"].includes(status)
          || (status === "busy" && result?.beforeDiscord === true)) {
          throw new SettingsApplyJobRetryError(`${label} is temporarily unavailable and will be retried.`);
        }
        if (status === "busy") {
          throw new SettingsApplyJobUnknownOutcomeError(`${label} became busy after Discord work began.`);
        }
        if (["failed", "send-failed", "save-failed", "remove-failed", "channel-unavailable"].includes(status)) {
          throw new SettingsApplyJobUnknownOutcomeError(`${label} did not confirm a completed Discord operation.`);
        }
        results.push({ feature: label, status, result });
      } catch (error) {
        // The underlying operation may have sent/edited before its response
        // failed.  Never make the worker duplicate that uncertain action.
        if (error?.unknownOutcome || error?.code === "SETTINGS_APPLY_UNKNOWN_OUTCOME") throw error;
        if (error?.retryable || error?.code === "SETTINGS_APPLY_RETRY") throw error;
        if (error?.code === "SETTINGS_APPLY_BLOCKED") throw error;
        throw new SettingsApplyJobUnknownOutcomeError(`${label} failed with an indeterminate Discord outcome.`, error);
      }
    };

    if (features.includes("status_board")) {
      await runMutating("status_board", async () => {
        const channelId = settings.statusBoardChannelId ?? null;
        if (channelId) return operationalStatusBoardService?.configure?.(guild, channelId) ?? { status: "applied" };
        return operationalStatusBoardService?.remove?.(guild) ?? { status: "removed" };
      });
    }
    if (features.includes("profile")) {
      await runMutating("profile", async () => {
        if (!settings.profileIntroductionChannelId) return profileRegistrationPanelService?.removeProfileRegistrationPanel?.(guild) ?? { status: "not-configured" };
        return profileRegistrationPanelService?.ensureProfileRegistrationPanel?.(guild) ?? { status: "applied" };
      });
    }
    if (features.includes("callwait")) {
      await runMutating("callwait", async () => {
        const reconcileResult = await callWaitReconciler?.reconcile?.({
          guild,
          currentSettings: context.previousSettings ?? context.current ?? settings,
          nextSettings: settings,
          assertLease: context.assertLease,
        });
        if (reconcileResult?.status && reconcileResult.status !== "not-required" && reconcileResult.status !== "applied") return reconcileResult;
        if (!settings.callWaitEnabled) return oteboRecruitmentPanelService?.removeOteboRecruitmentPanel?.(guild) ?? { status: "disabled" };
        return oteboRecruitmentPanelService?.ensureOteboRecruitmentPanel?.(guild) ?? { status: "applied" };
      });
    }
    if (features.includes("kokuchi")) {
      await runMutating("kokuchi", async () => {
        if (typeof rescheduleCurrentKokuchiEvent !== "function") return { status: "applied" };
        return rescheduleCurrentKokuchiEvent(guild, context.previousSettings ?? settings, settings);
      });
    }
    if (features.includes("vc_dm")) {
      await runMutating("vc_dm", async () => vcDmService?.onSettingsChanged?.(guild) ?? { status: "applied" });
    }
    if (features.includes("voice_control")) {
      await runMutating("voice_control", async () => {
        const channels = [...(guild.channels?.cache?.values?.() ?? [])]
          .filter((channel) => isVoiceChannelControlTarget(channel, settings));
        const results = [];
        for (const channel of channels) {
          await context.assertLease?.();
          const result = await voiceChannelControlService?.ensurePanel?.(channel);
          await context.assertLease?.();
          const status = resultStatus(result);
          if (status === "blocked") {
            throw new SettingsApplyJobBlockedError(`voice_control is blocked for channel ${channel.id}.`, result);
          }
          if (status === "unknown" || status === "uncertain" || result?.unknownOutcome === true) {
            throw new SettingsApplyJobUnknownOutcomeError(`voice_control outcome is unknown for channel ${channel.id}.`);
          }
          if (status === "busy" && result?.beforeDiscord === true) {
            if (results.length > 0) {
              // Earlier channels may already have been created/edited.  A
              // later pre-mutation busy result cannot safely retry the whole
              // batch because that would replay those successful side
              // effects without knowing whether they were durable.
              throw new SettingsApplyJobBlockedError(
                `voice_control became busy after ${results.length} channel(s) completed.`,
                { ...result, partialMutation: true, reason: "partial-voice-control-apply" },
              );
            }
            throw new SettingsApplyJobRetryError(`voice_control is temporarily busy for channel ${channel.id}.`);
          }
          if (status === "busy") {
            throw new SettingsApplyJobUnknownOutcomeError(`voice_control became busy after Discord work began for channel ${channel.id}.`);
          }
          if (["failed", "send-failed", "save-failed", "remove-failed", "channel-unavailable"].includes(status)) {
            throw new SettingsApplyJobUnknownOutcomeError(`voice_control did not confirm channel ${channel.id}.`);
          }
          if (!result || !VOICE_CONTROL_SUCCESS_STATUSES.has(status)) {
            throw new SettingsApplyJobUnknownOutcomeError(`voice_control returned an unconfirmed result for channel ${channel.id}.`);
          }
          results.push({ channelId: channel.id, status: status || "applied" });
        }
        return { status: "applied", channels: channels.length, results };
      });
    }
    if (features.includes("fukyo")) {
      await runMutating("fukyo", async () => {
        if (typeof fukyoThemeService?.onSettingsChanged === "function") return fukyoThemeService.onSettingsChanged(guild);
        await requestOperationalStatusRefresh?.(guild.id, "settings-apply:fukyo");
        return { status: "applied", noOp: true };
      });
    }
    if (features.includes("splitvc")) {
      await runMutating("voice-monitor", async () => {
        const sessions = [...(voiceMonitorSessions?.values?.() ?? [])]
          .filter((session) => session?.guildId === guild.id);
        for (const session of sessions) {
          await context.assertLease?.();
          const shouldKeep = settings.voiceReminderEnabled !== false
            && (typeof isVoiceChannelMonitored !== "function"
              || await isVoiceChannelMonitored(guild, settings, session.voiceChannelId));
          if (shouldKeep || typeof stopVoiceMonitorSession !== "function") continue;
          let channel = null;
          if (typeof guild.channels?.fetch === "function") channel = await guild.channels.fetch(session.voiceChannelId).catch(() => null);
          await stopVoiceMonitorSession(session, guild, channel, settings);
          await context.assertLease?.();
        }
        if (settings.voiceReminderEnabled === false && typeof reconcilePersistedVoiceParticipantRoleGrants === "function") {
          await context.assertLease?.();
          await reconcilePersistedVoiceParticipantRoleGrants(guild, settings);
          await context.assertLease?.();
        }
        return { status: "applied", sessions: sessions.length };
      });
    }
    if (features.includes("splitvc") || features.includes("forms")) {
      await context.assertLease?.();
      await requestOperationalStatusRefresh?.(guild.id, `settings-apply:${features.filter((feature) => feature === "splitvc" || feature === "forms").join(",")}`);
      await context.assertLease?.();
      results.push({ feature: features.includes("splitvc") ? "splitvc" : "forms", status: "applied", noOp: true });
    }
    logger.debug?.(`Settings apply dispatched guild=${guildId} revision=${job?.revision} features=${features.join(",")}`);
    return { status: "applied", features, results };
  }

  return { dispatch, classify: classifyConfigurationChanges };
}

export function createSettingsApplyService({
  jobModel,
  configurationService = null,
  getGuildSettings = null,
  getEnvironmentSettings = null,
  getGuild = null,
  dispatcher = null,
  validationService = null,
  logger = console,
  now = () => new Date(),
  workerId = `settings-apply:${process.pid}:${Math.random().toString(36).slice(2, 10)}`,
  leaseMs = DEFAULT_LEASE_MS,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  maxManualRetries = MAX_MANUAL_RETRIES,
  backoffBaseMs = DEFAULT_BACKOFF_BASE_MS,
  backoffMaxMs = DEFAULT_BACKOFF_MAX_MS,
  shutdownDrainTimeoutMs = DEFAULT_SHUTDOWN_DRAIN_MS,
} = {}) {
  if (!jobModel) throw new Error("jobModel is required.");
  let stopped = false;
  let stopping = false;
  let timer = null;
  let shutdownPromise = null;
  const activeOperations = new Set();
  const activeLeaseGuards = new Set();

  async function trackOperation(operation) {
    const task = Promise.resolve().then(operation);
    activeOperations.add(task);
    try {
      return await task;
    } finally {
      activeOperations.delete(task);
    }
  }

  async function findJob(guildId, revision) {
    if (typeof jobModel.findOne !== "function") return null;
    const query = jobModel.findOne({ guildId, revision });
    return plain(await executeQuery(query));
  }

  async function listJobs(guildId, limit = 20) {
    if (typeof jobModel.find !== "function") return [];
    let query = jobModel.find(guildId ? { guildId } : {});
    if (query?.sort) query = query.sort({ createdAt: -1 });
    if (query?.limit) query = query.limit(Math.max(1, Math.min(100, Number(limit) || 20)));
    const rows = await executeQuery(query);
    return (Array.isArray(rows) ? rows : []).map(plain).filter((row) => !guildId || row.guildId === guildId);
  }

  async function claimNextJob({ guildId = null, revision = null, owner = workerId } = {}) {
    if (stopped || stopping || typeof jobModel.findOneAndUpdate !== "function") return null;
    const at = nowOrFactory(now);
    const eligible = [
      { status: "pending", nextAttemptAt: { $lte: at } },
      { status: "retry_wait", nextAttemptAt: { $lte: at } },
    ];
    const filter = { $or: eligible };
    if (guildId) filter.guildId = guildId;
    if (revision !== null && revision !== undefined) filter.revision = Number(revision);
    const update = {
      $set: {
        status: "processing",
        leaseOwner: owner,
        leaseExpiresAt: new Date(at.getTime() + Math.max(1, Number(leaseMs) || DEFAULT_LEASE_MS)),
        updatedAt: at,
      },
      $inc: { attemptCount: 1 },
    };
    const query = jobModel.findOneAndUpdate(filter, update, { sort: { createdAt: 1, _id: 1 }, new: true, returnDocument: "after" });
    return plain(await executeQuery(query));
  }

  async function recoverExpiredLeases({ force = false } = {}) {
    if ((stopped || stopping) && !force) return { modifiedCount: 0 };
    if (typeof jobModel.updateMany !== "function") return { modifiedCount: 0 };
    const at = nowOrFactory(now);
    const result = await jobModel.updateMany(
      { status: "processing", leaseExpiresAt: { $lte: at } },
      {
        $set: {
          // A processing lease can expire after Discord accepted a request
          // but before MongoDB recorded the result. Retrying automatically
          // could duplicate that side effect, so expired processing is a
          // sticky operator-review state instead of a due job.
          status: "blocked",
          nextAttemptAt: null,
          leaseOwner: null,
          leaseExpiresAt: null,
          lastError: "Apply-job lease expired while Discord outcome was unknown.",
          updatedAt: at,
        },
      },
    );
    return result ?? { modifiedCount: 0 };
  }

  async function updateClaimedJob(job, update) {
    const filter = {
      guildId: job.guildId,
      revision: job.revision,
      status: "processing",
      leaseOwner: job.leaseOwner ?? workerId,
    };
    if (typeof jobModel.findOneAndUpdate === "function") {
      const query = jobModel.findOneAndUpdate(filter, update, { new: true, returnDocument: "after" });
      return plain(await executeQuery(query));
    }
    if (typeof jobModel.updateOne === "function") return jobModel.updateOne(filter, update);
    return null;
  }

  function createLeaseGuard(job) {
    const owner = job?.leaseOwner ?? workerId;
    let leaseLost = false;
    let guardStopped = false;
    let heartbeatTimer = null;

    async function heartbeat() {
      // `stopping` deliberately does not fence an active operation.  A
      // graceful shutdown stops new claims/ticks, but the current worker must
      // keep this lease alive until its in-flight Discord mutation settles.
      if (guardStopped || leaseLost || typeof jobModel.findOneAndUpdate !== "function") return !leaseLost;
      const at = nowOrFactory(now);
      try {
        const query = jobModel.findOneAndUpdate(
          { guildId: job.guildId, revision: job.revision, status: "processing", leaseOwner: owner },
          { $set: { leaseExpiresAt: new Date(at.getTime() + Math.max(1, Number(leaseMs) || DEFAULT_LEASE_MS)), updatedAt: at } },
          { new: true, returnDocument: "after" },
        );
        const row = plain(await executeQuery(query));
        if (!row) leaseLost = true;
        return Boolean(row);
      } catch (error) {
        // A failed conditional heartbeat cannot prove ownership.  Stop before
        // the next Discord mutation and let lease recovery handle the job.
        leaseLost = true;
        logger.warn?.(`Settings apply lease heartbeat failed: ${error?.message ?? error}`);
        return false;
      }
    }

    async function assertLease() {
      if (guardStopped || leaseLost) throw new SettingsApplyLeaseLostError();
      if (typeof jobModel.findOne === "function") {
        const row = plain(await executeQuery(jobModel.findOne({ guildId: job.guildId, revision: job.revision })));
        const expiresAt = row?.leaseExpiresAt ? dateValue(row.leaseExpiresAt) : null;
        if (!row || row.status !== "processing" || row.leaseOwner !== owner || (expiresAt && expiresAt.getTime() <= nowOrFactory(now).getTime())) {
          leaseLost = true;
          throw new SettingsApplyLeaseLostError();
        }
      } else if (typeof jobModel.findOneAndUpdate === "function" && !(await heartbeat())) {
        throw new SettingsApplyLeaseLostError();
      }
      return true;
    }

    function start() {
      if (guardStopped || heartbeatTimer || typeof setInterval !== "function") return;
      const cadence = Math.max(10, Math.floor((Number(leaseMs) || DEFAULT_LEASE_MS) / 3));
      heartbeatTimer = setInterval(() => { void heartbeat(); }, cadence);
      heartbeatTimer.unref?.();
    }

    function stop() {
      guardStopped = true;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }

    async function fence(reason = "Apply worker shutdown timed out while draining an active operation.") {
      // Fencing an in-flight job is safer than allowing its lease to expire
      // while the Discord outcome is unknown.  A blocked job is never claimed
      // by a restarted worker; an operator can inspect the outcome explicitly.
      leaseLost = true;
      try {
        await updateClaimedJob(job, setUpdateStatus(job, "blocked", now, {
          lastError: reason,
          leaseOwner: null,
          leaseExpiresAt: null,
          nextAttemptAt: null,
        }));
      } catch (error) {
        logger.warn?.(`Failed to fence an active settings apply job during shutdown: ${error?.message ?? error}`);
      }
    }

    return { assertLease, heartbeat, start, stop, fence, isLost: () => leaseLost };
  }

  async function drainActiveOperations() {
    const configuredTimeout = Number(shutdownDrainTimeoutMs);
    const timeoutMs = Number.isFinite(configuredTimeout)
      ? Math.max(0, configuredTimeout)
      : DEFAULT_SHUTDOWN_DRAIN_MS;
    const deadline = Date.now() + timeoutMs;
    while (activeOperations.size > 0) {
      const pending = [...activeOperations];
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      let timeoutHandle = null;
      const timeout = new Promise((resolve) => {
        timeoutHandle = setTimeout(() => resolve(false), remaining);
      });
      const drained = await Promise.race([
        Promise.allSettled(pending).then(() => true),
        timeout,
      ]);
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (!drained) return false;
    }
    return true;
  }

  function retryDelay(attemptCount) {
    return Math.min(
      Math.max(0, Number(backoffMaxMs) || DEFAULT_BACKOFF_MAX_MS),
      Math.max(0, Number(backoffBaseMs) || DEFAULT_BACKOFF_BASE_MS) * (2 ** Math.max(0, Number(attemptCount) - 1)),
    );
  }

  async function markRetry(job, error) {
    const attempt = Number(job.attemptCount) || 0;
    const at = nowOrFactory(now);
    const lastError = textError(error);
    if (attempt >= Math.max(1, Number(maxAttempts) || DEFAULT_MAX_ATTEMPTS)) {
      return updateClaimedJob(job, setUpdateStatus(job, "failed", now, { lastError, nextAttemptAt: null, leaseOwner: null, leaseExpiresAt: null }));
    }
    return updateClaimedJob(job, setUpdateStatus(job, "retry_wait", now, {
      lastError,
      nextAttemptAt: new Date(at.getTime() + retryDelay(attempt)),
      leaseOwner: null,
      leaseExpiresAt: null,
    }));
  }

  async function processJob(job) {
    if (!job) return null;
    const leaseGuard = createLeaseGuard(job);
    activeLeaseGuards.add(leaseGuard);
    leaseGuard.start();
    try {
      await leaseGuard.assertLease();
      const current = configurationService?.getCurrentConfiguration
        ? await configurationService.getCurrentConfiguration(job.guildId)
        : await getGuildSettings?.(job.guildId);
      const currentRevision = revisionOf(current);
      if (currentRevision > Number(job.targetRevision)) {
        return updateClaimedJob(job, setUpdateStatus(job, "superseded", now, {
          lastError: "A newer configuration revision superseded this job.",
          leaseOwner: null,
          leaseExpiresAt: null,
          nextAttemptAt: null,
        }));
      }
      if (currentRevision < Number(job.targetRevision)) {
        return markRetry(job, new SettingsApplyJobRetryError(`Configuration revision ${job.targetRevision} is not visible yet.`));
      }
      // Re-read immediately before Discord work. A newer commit that landed
      // while settings were being hydrated must supersede this job rather
      // than letting an old snapshot act on current channels.
      const guard = configurationService?.getCurrentConfiguration
        ? await configurationService.getCurrentConfiguration(job.guildId)
        : await getGuildSettings?.(job.guildId);
      const guardRevision = revisionOf(guard);
      if (guardRevision > Number(job.targetRevision)) {
        return updateClaimedJob(job, setUpdateStatus(job, "superseded", now, {
          lastError: "A newer configuration revision superseded this job before Discord work.",
          leaseOwner: null,
          leaseExpiresAt: null,
          nextAttemptAt: null,
        }));
      }
      if (guardRevision < Number(job.targetRevision)) return markRetry(job, new SettingsApplyJobRetryError("Configuration revision changed before Discord work."));
      let previousSettings = null;
      if (configurationService?.getRevision) {
        const committedRevision = await configurationService.getRevision(job.guildId, Number(job.targetRevision));
        if (Number.isInteger(Number(committedRevision?.baseRevision)) && Number(committedRevision.baseRevision) >= 0) {
          const effectiveSettings = await getGuildSettings?.(job.guildId);
          // Revision snapshots intentionally omit keys which were inherited
          // from the environment.  Rebuild that inherited layer before
          // applying the historical snapshot so runtime reconciliation sees
          // the old prompt/notice targets rather than the current Mongo value.
          // The snapshot is spread last: an explicit historical value always
          // wins over today's environment defaults.
          const environmentDefaults = await getEnvironmentSettings?.(job.guildId) ?? {};
          const environmentSettings = Object.fromEntries(
            Object.entries(environmentDefaults).filter(([key]) => ADMIN_CONFIGURATION_CATALOG.includes(key)),
          );
          const runtimeSettings = Object.fromEntries(
            Object.entries(effectiveSettings ?? {}).filter(([key]) => !ADMIN_CONFIGURATION_CATALOG.includes(key)),
          );
          const baseRevision = Number(committedRevision.baseRevision);
          const baseSnapshot = baseRevision === 0
            ? {}
            : ((await configurationService.getRevision(job.guildId, baseRevision))?.snapshot ?? {});
          previousSettings = Number(committedRevision.baseRevision) === 0
            ? { ...runtimeSettings, ...environmentSettings }
            : { ...runtimeSettings, ...environmentSettings, ...baseSnapshot };
        }
      }
      const result = await dispatcher?.dispatch?.(job, {
        guild: await getGuild?.(job.guildId),
        settings: await getGuildSettings?.(job.guildId),
        current,
        previousSettings,
        assertLease: leaseGuard.assertLease,
      }) ?? { status: "applied" };
      await leaseGuard.assertLease();
      const status = resultStatus(result);
      if (status === "unknown" || status === "blocked" || didMutateUnknown(result)) {
        return updateClaimedJob(job, setUpdateStatus(job, "blocked", now, {
          lastError: textError(result?.reason ?? "Discord operation outcome was unknown."),
          leaseOwner: null,
          leaseExpiresAt: null,
          nextAttemptAt: null,
        }));
      }
      if (["retry", "retry_wait", "failed", "busy"].includes(status)) return markRetry(job, new SettingsApplyJobRetryError(result?.reason ?? `Apply result: ${status}`));
      return updateClaimedJob(job, setUpdateStatus(job, "applied", now, {
        lastError: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        nextAttemptAt: null,
      }));
    } catch (error) {
      if (error?.leaseLost || error?.code === "SETTINGS_APPLY_LEASE_LOST") {
        // Do not terminally update a job after fencing.  The next worker will
        // recover it when the old lease expires.
        return null;
      }
      if (error?.unknownOutcome || error?.code === "SETTINGS_APPLY_UNKNOWN_OUTCOME") {
        return updateClaimedJob(job, setUpdateStatus(job, "blocked", now, {
          lastError: textError(error),
          leaseOwner: null,
          leaseExpiresAt: null,
          nextAttemptAt: null,
        }));
      }
      if (error?.code === "SETTINGS_APPLY_BLOCKED") {
        return updateClaimedJob(job, setUpdateStatus(job, "blocked", now, {
          lastError: textError(error?.result?.reason ?? error),
          leaseOwner: null,
          leaseExpiresAt: null,
          nextAttemptAt: null,
        }));
      }
      return markRetry(job, error);
    } finally {
      leaseGuard.stop();
      activeLeaseGuards.delete(leaseGuard);
    }
  }

  async function processAvailable({ guildId = null, maxJobs = 20 } = {}) {
    if (stopped || stopping) return [];
    await recoverExpiredLeases();
    if (stopped || stopping) return [];
    const results = [];
    for (let index = 0; index < Math.max(1, Number(maxJobs) || 20); index += 1) {
      if (stopped || stopping) break;
      const job = await claimNextJob({ guildId });
      if (!job) break;
      try {
        results.push(await trackOperation(() => processJob(job)));
      } catch (error) {
        logger.error?.("Settings apply worker isolated a guild failure", error);
        results.push(await markRetry(job, error).catch(() => null));
      }
    }
    return results;
  }

  async function applyCommittedRevision(guildId, revision) {
    // Once shutdown has started, do not claim new work.  In-flight jobs are
    // drained separately and keep their lease guard alive until they settle.
    if (stopped || stopping) return { status: "stopped" };
    const job = await claimNextJob({ guildId, revision });
    if (!job) return { status: "pending" };
    const result = await trackOperation(() => processJob(job));
    return plain(result) ?? { status: "pending" };
  }

  async function retryJob(guildId, revision) {
    const job = await findJob(guildId, Number(revision));
    if (!job || job.guildId !== guildId) {
      const error = new Error("Apply job was not found for this guild.");
      error.code = "SETTINGS_APPLY_JOB_NOT_FOUND";
      throw error;
    }
    if (!["failed", "retry_wait"].includes(job.status)) {
      const error = new Error(`Apply job status ${job.status} cannot be retried.`);
      error.code = "SETTINGS_APPLY_RETRY_NOT_ALLOWED";
      throw error;
    }
    const manualRetryCount = Number(job.manualRetryCount) || 0;
    const configuredManualLimit = Number(job.maxManualRetries ?? maxManualRetries);
    const manualLimit = Number.isFinite(configuredManualLimit) && configuredManualLimit >= 0
      ? Math.floor(configuredManualLimit)
      : MAX_MANUAL_RETRIES;
    if (manualRetryCount >= manualLimit) {
      const error = new Error("Apply job retry limit has been reached.");
      // Preserve the existing public error code while the limit now applies
      // to the finite manual retry budget rather than automatic attempts.
      error.code = "SETTINGS_APPLY_RETRY_LIMIT";
      error.manualRetryLimit = manualLimit;
      throw error;
    }
    const at = nowOrFactory(now);
    if (typeof jobModel.findOneAndUpdate === "function") {
      const query = jobModel.findOneAndUpdate(
        { guildId, revision: Number(revision), status: { $in: ["failed", "retry_wait"] } },
         {
           $set: {
             status: "pending",
             attemptCount: 0,
             nextAttemptAt: at,
             lastError: null,
             failedAt: null,
             leaseOwner: null,
             leaseExpiresAt: null,
             updatedAt: at,
           },
           $inc: { manualRetryCount: 1 },
         },
        { new: true, returnDocument: "after" },
      );
      return plain(await executeQuery(query));
    }
    return job;
  }

  async function getJobStatus(guildId, revision = null) {
    if (revision === null || revision === undefined) {
      const jobs = await listJobs(guildId, 1);
      return jobs[0] ?? null;
    }
    return findJob(guildId, Number(revision));
  }

  async function preflightRollback({ guildId, targetRevision, guild = null } = {}) {
    if (!validationService?.validateGuild && !validationService?.validateFeature) {
      throw new SettingsApplyPreflightBlockedError(null, ["validation-service-unavailable"]);
    }
    const target = await configurationService?.getRevision?.(guildId, Number(targetRevision));
    const currentSettings = await getGuildSettings?.(guildId);
    const environmentSettings = await getEnvironmentSettings?.(guildId);
    const targetSettings = { ...(environmentSettings ?? {}), ...(currentSettings ?? {}), ...(target?.snapshot ?? {}) };
    for (const key of ADMIN_CONFIGURATION_CATALOG) {
      if (Object.prototype.hasOwnProperty.call(target?.snapshot ?? {}, key)) continue;
      if (Object.prototype.hasOwnProperty.call(environmentSettings ?? {}, key)) targetSettings[key] = environmentSettings[key];
      else targetSettings[key] = null;
    }
    const targetGuild = guild ?? await getGuild?.(guildId);

    // Rollback only needs to prove that resources affected by this rollback
    // are safe.  Validating every configured feature would block an otherwise
    // safe rollback because an unrelated, disabled feature is incomplete.
    const currentRevision = revisionOf(currentSettings);
    const currentRevisionRecord = await configurationService?.getRevision?.(guildId, currentRevision);
    // A revision-zero read may be hydrated with environment defaults.  It is
    // not a persisted canonical snapshot, so keep it empty for the diff
    // rather than accidentally validating fallback-only features.
    const currentSnapshot = currentRevisionRecord?.snapshot
      ?? (currentRevision === 0 ? {} : canonicalizeConfiguration(currentSettings ?? {}));
    const targetSnapshot = target?.snapshot ?? canonicalizeConfiguration(targetSettings);
    const diff = diffConfiguration(currentSnapshot, targetSnapshot);
    const features = classifyConfigurationChanges(diff.keys);
    const reports = [];
    if (features.length === 0 && typeof validationService.validateFeature !== "function") {
      // Compatibility for minimal composition/test doubles from before the
      // feature-scoped API.  The production validator always exposes
      // validateFeature, so it never broadens a real preflight.
      reports.push(await validationService.validateGuild({ guild: targetGuild, settings: targetSettings }));
    }
    for (const feature of features) {
      const report = await validationService.validateFeature?.({
        guild: targetGuild,
        settings: targetSettings,
        feature,
        // status_board is persisted separately from the runtime board record;
        // always validate the target channel itself during preflight.
        statusBoardOverride: feature === "status_board"
          ? { channelId: targetSettings.statusBoardChannelId ?? null }
          : null,
        disabledFeatureSafe: (feature === "callwait" && targetSettings.callWaitEnabled !== true)
          || (feature === "vc_dm" && targetSettings.vcDmEnabled !== true),
      }) ?? await validationService.validateGuild({ guild: targetGuild, settings: targetSettings, feature });
      reports.push(report);
    }
    const checks = reports.flatMap((report) => report?.checks ?? []);
    const report = {
      guildId,
      feature: features,
      features,
      diff,
      reports,
      checks,
      status: checks.some((check) => check.status === "error") ? "error" : checks.some((check) => check.status === "unknown") ? "unknown" : checks.some((check) => check.status === "warning") ? "warning" : "ok",
    };
    const unsafe = checks.filter((check) => (
      check?.status === "error"
      || (check?.status === "unknown" && !["dm-uncheckable", "developer-intent"].includes(check.reason))
    ));
    if (unsafe.length > 0) throw new SettingsApplyPreflightBlockedError(report, unsafe.map((check) => check.key ?? check.label ?? "unknown"));
    return { report, targetSettings, warningCount: checks.filter((check) => check.status === "warning").length, features, diff };
  }

  function start(intervalMs = 5_000) {
    stopped = false;
    stopping = false;
    shutdownPromise = null;
    if (timer) clearInterval(timer);
    timer = setInterval(() => { void processAvailable().catch((error) => logger.error?.("Settings apply worker tick failed", error)); }, Math.max(250, Number(intervalMs) || 5_000));
    timer.unref?.();
    return { status: "started" };
  }

  async function shutdown() {
    if (shutdownPromise) return shutdownPromise;
    stopping = true;
    if (timer) clearInterval(timer);
    timer = null;
    // Keep active lease guards alive while activeOperations drain.  Stopping
    // them here would allow another worker to claim the still-running job and
    // replay a Discord mutation after SIGTERM.
    shutdownPromise = (async () => {
      // Refresh once immediately as well as relying on the interval.  This
      // closes the small race where shutdown begins just before the next
      // heartbeat tick and another worker observes the old expiry.
      await Promise.allSettled([...activeLeaseGuards].map((guard) => guard.heartbeat?.()));
      const drained = await drainActiveOperations();
      if (!drained) {
        logger.error?.("Settings apply shutdown drain timed out; fencing active jobs.");
        await Promise.allSettled([...activeLeaseGuards].map((guard) => guard.fence?.()));
      }
      for (const guard of activeLeaseGuards) guard.stop();
      await recoverExpiredLeases({ force: true }).catch((error) => logger.warn?.("Settings apply lease recovery during shutdown failed", error));
      stopped = true;
      return { status: "stopped" };
    })();
    return shutdownPromise;
  }

  return {
    applyCommittedRevision,
    claimNextJob,
    claim: claimNextJob,
    getJob: findJob,
    getJobStatus,
    status: getJobStatus,
    listJobs,
    markRetry,
    preflightRollback,
    processAvailable,
    run: processAvailable,
    processJob,
    recoverExpiredLeases,
    recover: recoverExpiredLeases,
    requestRetry: retryJob,
    retryJob,
    shutdown,
    start,
    stop: shutdown,
    workerId,
    apply: applyCommittedRevision,
  };
}

export const createSettingsApplyWorker = createSettingsApplyService;

export { KNOWN_NON_MUTATING_RESULTS, TERMINAL_STATUSES, RETRYABLE_STATUSES };
