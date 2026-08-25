import crypto from "node:crypto";
import { extractRepairCandidates, sanitize } from "./reconciliation-service.js";
import {
  REPAIR_ACTION_KEYS,
  ReconciliationRepairJob,
} from "./models/reconciliation-repair-job.js";
import { isVoiceChannelControlTarget } from "./voice-channel-control-service.js";

export const REPAIR_MAX_ATTEMPTS = 3;
export const REPAIR_MAX_MANUAL_RETRIES = 3;
export const REPAIR_LEASE_MS = 120_000;
export const REPAIR_WORKER_INTERVAL_MS = 30_000;
export const REPAIR_DRAIN_TIMEOUT_MS = 15_000;
export const REPAIR_LEASE_PREFIX = "reconciliation-repair";
export const REPAIR_ACTION_ALLOWLIST = REPAIR_ACTION_KEYS;

const ACTIVE_STATUSES = Object.freeze(["pending", "processing", "retry_wait", "blocked", "circuit_open"]);
const DUE_STATUSES = Object.freeze(["pending", "retry_wait"]);
const SUCCESS_STATUSES = new Set(["applied", "current", "created", "updated", "moved", "unchanged", "configured"]);
const PRE_MUTATION_RETRY_STATUSES = new Set(["busy", "lease-unavailable", "retry", "retry_wait"]);
const BLOCKED_RESULT_STATUSES = new Set([
  "blocked", "failed", "send-failed", "save-failed", "channel-unavailable", "not-configured", "unavailable",
  "cleanup-pending", "hidden", "unknown", "uncertain", "outcome-unknown",
]);
const MAX_EVIDENCE_LENGTH = 500;

function plain(value) {
  if (value && typeof value.toObject === "function") return value.toObject();
  return value;
}

async function executeQuery(value) {
  if (value && typeof value.lean === "function") return value.lean();
  return value;
}

function nowDate(now) {
  const value = typeof now === "function" ? now() : now;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function bounded(value, max = MAX_EVIDENCE_LENGTH) {
  return sanitize(value, max).replace(/<@!?\d+>|<@&\d+>/g, "[mention]").slice(0, max);
}

function boundedEvidence(candidate) {
  if (!candidate || !isValidEvidenceForAction(candidate)) return null;
  if (!candidate.evidence || !["validation", "operational"].includes(candidate.evidence.source)) return null;
  if (![
    "warning", "error",
  ].includes(candidate.evidenceStatus)) return null;
  return {
    key: bounded(candidate.key, 120),
    reason: bounded(candidate.reason, MAX_EVIDENCE_LENGTH),
    evidenceStatus: candidate.evidenceStatus,
    source: candidate.evidence.source,
    code: candidate.evidence.code ? bounded(candidate.evidence.code, 120) : null,
    checkKey: candidate.evidence.checkKey ? bounded(candidate.evidence.checkKey, 160) : null,
  };
}

function normalizeActionKey(value) {
  const action = String(value ?? "");
  return REPAIR_ACTION_ALLOWLIST.includes(action) ? action : null;
}

function candidateForAction(validationReport, operationalSnapshot, actionKey) {
  return extractRepairCandidates(validationReport, operationalSnapshot)
    .find((candidate) => candidate.key === actionKey) ?? null;
}

function checksFromValidation(report) {
  const reports = Array.isArray(report?.reports) ? report.reports : report ? [report] : [];
  return reports.flatMap((item) => Array.isArray(item?.checks) ? item.checks : []);
}

const CONFIRMED_ACTION_CODES = Object.freeze({
  "profile_panel.ensure": new Set(["profile_panel_missing", "profile_panel_message_missing", "profile_panel_channel_mismatch"]),
  "otebo_panel.ensure": new Set(["otebo_panel_state_missing", "otebo_panel_message_missing", "otebo_panel_channel_mismatch"]),
  "voice_control_panels.ensure": new Set(["vc_panel_missing", "vc_panel_message_missing"]),
});

const UNKNOWN_EVIDENCE_CODES = Object.freeze({
  "profile_panel.ensure": new Set(["panel_check_failed"]),
  "otebo_panel.ensure": new Set(["otebo_panel_check_failed"]),
  "voice_control_panels.ensure": new Set(["panel_check_failed"]),
});

function isValidEvidenceForAction(candidate) {
  const actionKey = normalizeActionKey(candidate?.key);
  if (!actionKey || candidate.safe !== true || candidate.requiresApplyJob !== true) return false;
  const evidence = candidate.evidence;
  if (!evidence || !["warning", "error"].includes(candidate.evidenceStatus)) return false;
  if (actionKey === "status_board.ensure") {
    return evidence.source === "validation"
      && ["status_board.message", "status_board.channel"].includes(evidence.checkKey)
      && !evidence.code;
  }
  return evidence.source === "operational"
    && CONFIRMED_ACTION_CODES[actionKey]?.has(evidence.code)
    && !UNKNOWN_EVIDENCE_CODES[actionKey]?.has(evidence.code);
}

function hasUnknownEvidence(validationReport, operationalSnapshot, actionKey) {
  if (actionKey === "status_board.ensure" && checksFromValidation(validationReport).some((check) => (
    check?.key?.startsWith("status_board.") && check?.status === "unknown"
  ))) return true;

  const codes = UNKNOWN_EVIDENCE_CODES[actionKey] ?? new Set();
  for (const module of Object.values(operationalSnapshot?.modules ?? {})) {
    if (!module || typeof module !== "object") continue;
    const relevant = actionKey === "profile_panel.ensure"
      ? module.key === "panels"
      : actionKey === "otebo_panel.ensure"
        ? module.key === "recruitment"
        : actionKey === "voice_control_panels.ensure"
          ? module.key === "panels" || module.key === "voice"
          : false;
    if (!relevant) continue;
    if (module.severity === "unknown") return true;
    if ((module.issues ?? []).some((issue) => codes.has(issue?.code))) return true;
  }
  return false;
}

function resultStatus(result) {
  return String(result?.status ?? "").toLowerCase();
}

function isExplicitPreMutationRetry(error, result) {
  const explicitPreMutation = Boolean(
    result?.beforeDiscord === true
    || result?.preMutation === true
    || error?.beforeDiscord === true
    || error?.preMutation === true,
  );
  return Boolean(
    explicitPreMutation
    &&
    result?.partialMutation !== true
    && error?.partialMutation !== true
    && (error?.retryable === true
      || result?.retryable === true
      || PRE_MUTATION_RETRY_STATUSES.has(resultStatus(result))
      || PRE_MUTATION_RETRY_STATUSES.has(resultStatus(error))
      || explicitPreMutation),
  );
}

function isUnknownOutcome(error, result) {
  const status = resultStatus(result);
  return Boolean(
    error?.unknownOutcome === true
    || error?.code === "RECONCILIATION_REPAIR_UNKNOWN_OUTCOME"
    || result?.unknownOutcome === true
    || status === "unknown"
    || status === "uncertain"
    || status === "outcome-unknown"
    || BLOCKED_RESULT_STATUSES.has(status),
  );
}

function updateCount(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

class RepairLeaseLostError extends Error {
  constructor() {
    super("Reconciliation repair lease ownership was lost.");
    this.code = "RECONCILIATION_REPAIR_LEASE_LOST";
  }
}

export function createReconciliationRepairService({
  repairJobModel = ReconciliationRepairJob,
  validationService,
  settingsValidationService = null,
  operationalStatusService,
  getGuild = null,
  getGuilds = null,
  getGuildSettings = null,
  operationalStatusBoardService = null,
  profileRegistrationPanelService = null,
  oteboRecruitmentPanelService = null,
  voiceChannelControlService = null,
  now = () => new Date(),
  workerId = `reconciliation-repair:${process.pid}:${crypto.randomUUID()}`,
  leaseMs = REPAIR_LEASE_MS,
  workerIntervalMs = REPAIR_WORKER_INTERVAL_MS,
  maxAttempts = REPAIR_MAX_ATTEMPTS,
  maxManualRetries = REPAIR_MAX_MANUAL_RETRIES,
  backoffBaseMs = 15_000,
  backoffMaxMs = 10 * 60_000,
  drainTimeoutMs = REPAIR_DRAIN_TIMEOUT_MS,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  setHeartbeatIntervalFn = setInterval,
  clearHeartbeatIntervalFn = clearInterval,
  logger = console,
} = {}) {
  const validator = validationService ?? settingsValidationService;
  if (!repairJobModel) throw new Error("repairJobModel is required.");
  if (!validator?.validateGuild) throw new Error("validationService.validateGuild is required.");
  if (!operationalStatusService?.getOperationalStatusSnapshot) throw new Error("operationalStatusService.getOperationalStatusSnapshot is required.");

  let timer = null;
  let started = false;
  let stopping = false;
  let running = false;
  const activeOperations = new Set();
  const activeRuns = new Set();
  const activeGuards = new Set();

  function guilds() {
    const value = typeof getGuilds === "function" ? getGuilds() : null;
    if (value?.values) return [...value.values()];
    return Array.isArray(value) ? value : [];
  }

  async function findOne(filter) {
    if (typeof repairJobModel.findOne !== "function") return null;
    return plain(await executeQuery(repairJobModel.findOne(filter)));
  }

  async function list(guildId = null, limit = 20) {
    if (typeof repairJobModel.find !== "function") return [];
    let query = repairJobModel.find(guildId ? { guildId } : {});
    if (query?.sort) query = query.sort({ createdAt: -1 });
    if (query?.limit) query = query.limit(Math.max(1, Math.min(50, Number(limit) || 20)));
    const rows = await executeQuery(query);
    return (Array.isArray(rows) ? rows : []).map(plain).filter((row) => !guildId || row.guildId === guildId);
  }

  async function getStatus(guildId, limit = 20) {
    return list(guildId, limit);
  }

  async function enqueueObservation(observation) {
    if (stopping || !observation?.guildId || !observation?.runId) return { status: "skipped", reason: stopping ? "shutting-down" : "invalid-observation", jobs: [] };
    const candidates = (Array.isArray(observation.candidates) ? observation.candidates : [])
      .map(boundedEvidence)
      .filter(Boolean)
      .slice(0, 20);
    const jobs = [];
    for (const evidence of candidates) {
      const actionKey = normalizeActionKey(evidence.key);
      if (!actionKey) continue;
      const exact = await findOne({ guildId: observation.guildId, observationRunId: observation.runId, actionKey });
      if (exact) {
        jobs.push(exact);
        continue;
      }
      const active = await findOne({ guildId: observation.guildId, actionKey, status: { $in: ACTIVE_STATUSES } });
      if (active) {
        // A blocked/unknown job is intentionally sticky.  A fresh 30-minute
        // observation must not circumvent the circuit breaker.
        jobs.push(active);
        continue;
      }
      const document = {
        guildId: observation.guildId,
        observationRunId: bounded(observation.runId, 100),
        actionKey,
        evidence,
        status: "pending",
        attemptCount: 0,
        maxAttempts: Math.max(1, Number(maxAttempts) || REPAIR_MAX_ATTEMPTS),
        manualRetryCount: 0,
        maxManualRetries: Math.max(0, Number(maxManualRetries) || REPAIR_MAX_MANUAL_RETRIES),
        nextAttemptAt: nowDate(now),
        observedAt: observation.completedAt ?? observation.startedAt ?? nowDate(now),
        lastError: null,
        result: null,
      };
      try {
        const created = typeof repairJobModel.create === "function"
          ? await repairJobModel.create(document)
          : null;
        if (created) jobs.push(plain(created));
      } catch (error) {
        // Unique indexes are the final CAS boundary.  Read back the winner
        // rather than creating a second action or masking a real DB error.
        const winner = await findOne({ guildId: observation.guildId, actionKey, status: { $in: ACTIVE_STATUSES } });
        if (winner) jobs.push(winner);
        else throw error;
      }
    }
    return { status: "enqueued", jobs };
  }

  async function claimNextJob() {
    if (stopping || typeof repairJobModel.findOneAndUpdate !== "function") return null;
    const at = nowDate(now);
    const leaseExpiresAt = new Date(at.getTime() + Math.max(1, Number(leaseMs) || REPAIR_LEASE_MS));
    const leaseId = crypto.randomUUID();
    const filter = {
      status: { $in: DUE_STATUSES },
      attemptCount: { $lt: Math.max(1, Number(maxAttempts) || REPAIR_MAX_ATTEMPTS) },
      $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: at } }],
    };
    const update = {
      $set: {
        status: "processing",
        leaseOwner: workerId,
        leaseId,
        leaseExpiresAt,
        heartbeatAt: at,
        updatedAt: at,
      },
      $inc: { attemptCount: 1, fencingToken: 1 },
    };
    const query = repairJobModel.findOneAndUpdate(filter, update, {
      sort: { createdAt: 1, _id: 1 },
      returnDocument: "after",
    });
    return plain(await executeQuery(query));
  }

  async function recoverExpiredLeases() {
    if (typeof repairJobModel.updateMany !== "function") return { modifiedCount: 0 };
    const at = nowDate(now);
    // Discord outcome is unknowable once a worker lease expires.  Fencing the
    // row as blocked is safer than replaying a potentially successful send.
    return repairJobModel.updateMany(
      { status: "processing", leaseExpiresAt: { $lte: at } },
      {
        $set: {
          status: "blocked",
          blockedAt: at,
          leaseOwner: null,
          leaseId: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
          lastError: "修復workerのlease期限切れにより結果不明のため停止しました。",
          result: { status: "blocked", reason: "lease-expired-unknown" },
          updatedAt: at,
        },
      },
    );
  }

  function createLeaseGuard(job) {
    let lost = false;
    let stopped = false;
    let heartbeatTimer = null;
    const owner = job.leaseOwner ?? workerId;
    const leaseId = job.leaseId;
    const fencingToken = job.fencingToken;

    async function heartbeat() {
      if (stopped || lost) return !lost;
      if (typeof repairJobModel.findOneAndUpdate !== "function") return true;
      const at = nowDate(now);
      try {
        const query = repairJobModel.findOneAndUpdate(
          { _id: job._id, guildId: job.guildId, actionKey: job.actionKey, status: "processing", leaseOwner: owner, leaseId, fencingToken },
          { $set: { leaseExpiresAt: new Date(at.getTime() + Math.max(1, Number(leaseMs) || REPAIR_LEASE_MS)), heartbeatAt: at, updatedAt: at } },
          { returnDocument: "after" },
        );
        const updated = await executeQuery(query);
        if (!updated) lost = true;
      } catch {
        lost = true;
      }
      return !lost;
    }

    heartbeatTimer = typeof setHeartbeatIntervalFn === "function"
      ? setHeartbeatIntervalFn(() => { void heartbeat(); }, Math.max(1, Math.floor(Number(leaseMs) / 3)))
      : null;
    heartbeatTimer?.unref?.();
    activeGuards.add({ stop: () => { stopped = true; if (heartbeatTimer) clearHeartbeatIntervalFn(heartbeatTimer); heartbeatTimer = null; }, heartbeat, isLost: () => lost });
    const guard = [...activeGuards].at(-1);
    return {
      heartbeat,
      isLost: () => lost,
      assertOwned: async () => {
        if (stopped || lost) throw new RepairLeaseLostError();
        await heartbeat();
        if (stopped || lost) throw new RepairLeaseLostError();
      },
      stop: () => {
        stopped = true;
        if (heartbeatTimer) clearHeartbeatIntervalFn(heartbeatTimer);
        heartbeatTimer = null;
        if (guard) activeGuards.delete(guard);
      },
    };
  }

  async function updateClaimed(job, update) {
    const filter = {
      _id: job._id,
      guildId: job.guildId,
      actionKey: job.actionKey,
      status: "processing",
      leaseOwner: job.leaseOwner ?? workerId,
      leaseId: job.leaseId,
      fencingToken: job.fencingToken,
    };
    if (typeof repairJobModel.findOneAndUpdate === "function") {
      return plain(await executeQuery(repairJobModel.findOneAndUpdate(filter, update, { returnDocument: "after" })));
    }
    if (typeof repairJobModel.updateOne === "function") return repairJobModel.updateOne(filter, update);
    return null;
  }

  async function releaseUnstartedClaim(job) {
    if (!job) return null;
    try {
      return await updateClaimed(job, {
        $set: {
          status: "pending",
          nextAttemptAt: nowDate(now),
          leaseOwner: null,
          leaseId: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
          updatedAt: nowDate(now),
        },
      });
    } catch (error) {
      logger.warn?.(`Repair claim could not be returned during shutdown: ${bounded(error?.message ?? error)}`);
      return null;
    }
  }

  async function readFreshEvidence(guild, actionKey, { refreshPanelPresence = false } = {}) {
    let validationReport;
    let operationalSnapshot;
    try {
      validationReport = await validator.validateGuild({ guild, feature: "all" });
      operationalSnapshot = await operationalStatusService.getOperationalStatusSnapshot(guild, { persistHealth: false, readOnly: true, refreshPanelPresence });
    } catch (error) {
      return { status: "blocked", reason: "preflight-unknown", error };
    }
    if (hasUnknownEvidence(validationReport, operationalSnapshot, actionKey)) {
      return { status: "blocked", reason: "evidence-unknown", validationReport, operationalSnapshot };
    }
    const candidate = candidateForAction(validationReport, operationalSnapshot, actionKey);
    if (!candidate) return { status: "no_longer_needed", reason: "candidate-cleared", validationReport, operationalSnapshot };
    return { status: "confirmed", candidate, validationReport, operationalSnapshot };
  }

  function targetVoiceChannels(guild, settings) {
    return [...(guild?.channels?.cache?.values?.() ?? [])]
      .filter((channel) => isVoiceChannelControlTarget(channel, settings));
  }

  async function dispatchAction(actionKey, guild, guard) {
    if (actionKey === "status_board.ensure") {
      const settings = await getGuildSettings?.(guild.id);
      if (!settings?.statusBoardChannelId) return { status: "blocked", reason: "status-board-channel-not-configured", beforeDiscord: true };
      await guard.assertOwned();
      let result;
      try {
        result = await operationalStatusBoardService?.configure?.(guild, settings.statusBoardChannelId);
      } catch (error) {
        // Only the adapter that owns the operation can prove that no Discord
        // call has started.  A message mentioning "busy" or "lease" after a
        // send/save is not evidence that replay is safe.
        throw error;
      }
      await guard.assertOwned();
      return result ?? { status: "unknown", reason: "status-board-result-missing" };
    }
    if (actionKey === "profile_panel.ensure") {
      await guard.assertOwned();
      const result = await profileRegistrationPanelService?.ensureProfileRegistrationPanel?.(guild);
      await guard.assertOwned();
      return result ?? { status: "unknown", reason: "profile-panel-result-missing" };
    }
    if (actionKey === "otebo_panel.ensure") {
      await guard.assertOwned();
      const result = await oteboRecruitmentPanelService?.ensureOteboRecruitmentPanel?.(guild);
      await guard.assertOwned();
      return result ?? { status: "unknown", reason: "otebo-panel-result-missing" };
    }
    if (actionKey === "voice_control_panels.ensure") {
      const settings = await getGuildSettings?.(guild.id);
      const channels = targetVoiceChannels(guild, settings);
      if (channels.length === 0) return { status: "blocked", reason: "voice-control-targets-not-configured", beforeDiscord: true };
      const results = [];
      for (const channel of channels) {
        await guard.assertOwned();
        const result = await voiceChannelControlService?.ensurePanel?.(channel);
        await guard.assertOwned();
        if (!result || !SUCCESS_STATUSES.has(resultStatus(result))) {
          return {
            ...(result ?? { status: "unknown", reason: "voice-control-result-missing" }),
            partialMutation: results.length > 0,
            beforeDiscord: results.length === 0 && result?.beforeDiscord === true,
          };
        }
        results.push(result);
      }
      return { status: "applied", channels: channels.length, results };
    }
    return { status: "blocked", reason: "action-not-allowlisted", beforeDiscord: true };
  }

  function retryDelay(attempt) {
    const base = Math.max(1, Number(backoffBaseMs) || 15_000);
    const cap = Math.max(base, Number(backoffMaxMs) || 10 * 60_000);
    return Math.min(cap, base * (2 ** Math.max(0, Number(attempt) - 1)));
  }

  async function processJob(job) {
    if (!job || stopping) return { status: "skipped", reason: stopping ? "shutting-down" : "missing-job" };
    if (job._id == null || !job.guildId || !job.actionKey || !job.leaseOwner || !job.leaseId || !Number.isFinite(Number(job.fencingToken))) {
      return { status: "skipped", reason: "incomplete-claim" };
    }
    let guild;
    try {
      guild = typeof getGuild === "function" ? await getGuild(job.guildId) : guilds().find((item) => item.id === job.guildId);
    } catch (error) {
      try {
        return await updateClaimed(job, { $set: { status: "blocked", blockedAt: nowDate(now), lastError: bounded(error?.message ?? error), result: { status: "blocked", reason: "guild-read-failed" }, leaseOwner: null, leaseId: null, leaseExpiresAt: null, updatedAt: nowDate(now) } });
      } catch {
        return { status: "fenced", reason: "guild-read-failed" };
      }
    }
    if (!guild) {
      return updateClaimed(job, { $set: { status: "blocked", blockedAt: nowDate(now), lastError: "guild-unavailable", result: { status: "blocked", reason: "guild-unavailable" }, leaseOwner: null, leaseId: null, leaseExpiresAt: null, updatedAt: nowDate(now) } });
    }
    const actionKey = normalizeActionKey(job.actionKey);
    if (!actionKey) {
      return updateClaimed(job, { $set: { status: "blocked", blockedAt: nowDate(now), lastError: "action-not-allowlisted", result: { status: "blocked", reason: "action-not-allowlisted" }, leaseOwner: null, leaseId: null, leaseExpiresAt: null, updatedAt: nowDate(now) } });
    }
    const guard = createLeaseGuard(job);
    try {
      await guard.assertOwned();
      const preflight = await readFreshEvidence(guild, actionKey);
      await guard.assertOwned();
      if (preflight.status !== "confirmed") {
        const status = preflight.status === "no_longer_needed" ? "no_longer_needed" : "blocked";
        const result = await updateClaimed(job, {
          $set: {
            status,
            blockedAt: status === "blocked" ? nowDate(now) : null,
            lastError: preflight.reason,
            result: { status, reason: preflight.reason },
            leaseOwner: null,
            leaseId: null,
            leaseExpiresAt: null,
            heartbeatAt: null,
            updatedAt: nowDate(now),
          },
        });
        return result ?? { status };
      }
      await guard.assertOwned();
      let actionResult;
      try {
        actionResult = await dispatchAction(actionKey, guild, guard);
      } catch (error) {
        if (error?.code === "RECONCILIATION_REPAIR_LEASE_LOST") throw error;
        const retryable = isExplicitPreMutationRetry(error, null);
        if (retryable && updateCount(job.attemptCount) < updateCount(job.maxAttempts ?? maxAttempts)) {
          await guard.assertOwned();
          return updateClaimed(job, { $set: { status: "retry_wait", nextAttemptAt: new Date(nowDate(now).getTime() + retryDelay(job.attemptCount)), lastError: bounded(error?.message ?? error), result: { status: "retry_wait", reason: "pre-mutation-transient" }, leaseOwner: null, leaseId: null, leaseExpiresAt: null, heartbeatAt: null, updatedAt: nowDate(now) } });
        }
        await guard.assertOwned();
        const exhausted = retryable;
        return updateClaimed(job, { $set: { status: exhausted ? "circuit_open" : "blocked", blockedAt: nowDate(now), lastError: bounded(error?.message ?? error), result: { status: exhausted ? "circuit_open" : "blocked", reason: exhausted ? "retry-limit" : "discord-outcome-unknown" }, leaseOwner: null, leaseId: null, leaseExpiresAt: null, heartbeatAt: null, updatedAt: nowDate(now) } });
      }
      await guard.assertOwned();
      const status = resultStatus(actionResult);
      if (PRE_MUTATION_RETRY_STATUSES.has(status)
        && isExplicitPreMutationRetry(null, actionResult)
        && updateCount(job.attemptCount) < updateCount(job.maxAttempts ?? maxAttempts)) {
        return updateClaimed(job, { $set: { status: "retry_wait", nextAttemptAt: new Date(nowDate(now).getTime() + retryDelay(job.attemptCount)), lastError: bounded(actionResult?.reason ?? status), result: { status: "retry_wait", reason: "pre-mutation-transient" }, leaseOwner: null, leaseId: null, leaseExpiresAt: null, heartbeatAt: null, updatedAt: nowDate(now) } });
      }
      const actionOutcomeUnknown = isUnknownOutcome(null, actionResult) || !SUCCESS_STATUSES.has(status);
      // A successful-looking adapter result is not enough: another read-only
      // validation must prove that the exact confirmed candidate disappeared.
      // This prevents a stale/ambiguous ensure from becoming an applied job
      // and being recreated by every 30-minute observation.
      const postflight = await readFreshEvidence(guild, actionKey, { refreshPanelPresence: true });
      await guard.assertOwned();
      if (postflight.status !== "no_longer_needed" || actionOutcomeUnknown) {
        const exhausted = PRE_MUTATION_RETRY_STATUSES.has(status)
          && updateCount(job.attemptCount) >= updateCount(job.maxAttempts ?? maxAttempts);
        const terminalStatus = exhausted ? "circuit_open" : "blocked";
        return updateClaimed(job, { $set: { status: terminalStatus, blockedAt: nowDate(now), lastError: bounded(postflight.reason ?? actionResult?.reason ?? `repair-${status || "unknown"}`), result: { status: terminalStatus, reason: exhausted ? "retry-limit" : postflight.status === "confirmed" ? "candidate-remains" : postflight.reason ?? (actionOutcomeUnknown ? "discord-outcome-unknown" : "postflight-unknown") }, leaseOwner: null, leaseId: null, leaseExpiresAt: null, heartbeatAt: null, updatedAt: nowDate(now) } });
      }
      return updateClaimed(job, { $set: { status: "applied", appliedAt: nowDate(now), lastError: null, result: { status: "applied", reason: status }, leaseOwner: null, leaseId: null, leaseExpiresAt: null, heartbeatAt: null, updatedAt: nowDate(now) } });
    } catch (error) {
      if (error?.code === "RECONCILIATION_REPAIR_LEASE_LOST") return { status: "fenced", reason: "lease-lost" };
      logger.warn?.(`Reconciliation repair failed guild=${job.guildId} action=${job.actionKey}: ${bounded(error?.message ?? error)}`);
      try {
        await guard.assertOwned();
        const fenced = await updateClaimed(job, {
          $set: {
            status: "blocked",
            blockedAt: nowDate(now),
            lastError: bounded(error?.message ?? error),
            result: { status: "blocked", reason: "repair-exception" },
            leaseOwner: null,
            leaseId: null,
            leaseExpiresAt: null,
            heartbeatAt: null,
            updatedAt: nowDate(now),
          },
        });
        return fenced ?? { status: "fenced", reason: "terminal-update-unavailable" };
      } catch {
        return { status: "fenced", reason: "lease-lost-or-terminal-update-failed" };
      }
    } finally {
      guard.stop();
    }
  }

  async function processAvailable({ maxJobs = 20 } = {}) {
    if (stopping || running) return { status: "skipped", reason: stopping ? "shutting-down" : "overlap", results: [] };
    running = true;
    const task = (async () => {
      const results = [];
      await recoverExpiredLeases().catch((error) => logger.warn?.(`Repair lease recovery failed: ${bounded(error?.message ?? error)}`));
      for (let index = 0; index < Math.max(1, Number(maxJobs) || 20); index += 1) {
        if (stopping) break;
        let job;
        try { job = await claimNextJob(); } catch (error) { logger.warn?.(`Repair claim failed: ${bounded(error?.message ?? error)}`); break; }
        if (!job) break;
        if (stopping) {
          await releaseUnstartedClaim(job);
          break;
        }
        const operation = Promise.resolve().then(() => processJob(job));
        activeOperations.add(operation);
        try { results.push(await operation); } catch (error) { results.push({ status: "failed", error }); } finally { activeOperations.delete(operation); }
      }
      return { status: "completed", results };
    })();
    activeRuns.add(task);
    try { return await task; } finally { activeRuns.delete(task); running = false; }
  }

  async function retryJob(guildId, actionKey) {
    const normalized = normalizeActionKey(actionKey);
    if (!normalized) {
      const error = new Error("修復アクションが許可リストにありません。");
      error.code = "RECONCILIATION_REPAIR_ACTION_INVALID";
      throw error;
    }
    const job = await findOne({ guildId, actionKey, status: { $in: ["blocked", "retry_wait", "failed", "circuit_open"] } });
    if (!job) {
      const error = new Error("再試行できる修復ジョブがありません。");
      error.code = "RECONCILIATION_REPAIR_NOT_RETRYABLE";
      throw error;
    }
    if (updateCount(job.manualRetryCount) >= updateCount(job.maxManualRetries ?? maxManualRetries)) {
      const error = new Error("修復ジョブの手動再試行上限に達しています。");
      error.code = "RECONCILIATION_REPAIR_RETRY_LIMIT";
      throw error;
    }
    if (typeof repairJobModel.findOneAndUpdate !== "function") return job;
    const retried = plain(await executeQuery(repairJobModel.findOneAndUpdate(
      { _id: job._id, guildId, actionKey, status: job.status, manualRetryCount: job.manualRetryCount ?? 0 },
      { $set: { status: "pending", attemptCount: 0, nextAttemptAt: nowDate(now), lastError: null, result: null, blockedAt: null, leaseOwner: null, leaseId: null, leaseExpiresAt: null, heartbeatAt: null, updatedAt: nowDate(now) }, $inc: { manualRetryCount: 1, fencingToken: 1 } },
      { returnDocument: "after" },
    )));
    if (!retried) {
      const error = new Error("修復ジョブの状態が競合したため再試行を受け付けませんでした。");
      error.code = "RECONCILIATION_REPAIR_RETRY_CONFLICT";
      throw error;
    }
    return retried;
  }

  function schedule() {
    if (timer || typeof setIntervalFn !== "function") return;
    timer = setIntervalFn(() => { void processAvailable().catch((error) => logger.warn?.(`Repair worker tick failed: ${bounded(error?.message ?? error)}`)); }, Math.max(1, Number(workerIntervalMs) || REPAIR_WORKER_INTERVAL_MS));
    timer?.unref?.();
  }

  async function start() {
    if (started && !stopping) return { status: "already_started" };
    started = true;
    stopping = false;
    await recoverExpiredLeases().catch((error) => logger.warn?.(`Repair startup recovery failed: ${bounded(error?.message ?? error)}`));
    schedule();
    const initial = processAvailable();
    initial.catch((error) => logger.warn?.(`Repair initial processing failed: ${bounded(error?.message ?? error)}`));
    return { status: "started", initialRun: initial };
  }

  async function stop() {
    if (!started && activeOperations.size === 0) return { status: "stopped" };
    stopping = true;
    started = false;
    if (timer) clearIntervalFn(timer);
    timer = null;
    const active = [...activeRuns, ...activeOperations];
    if (active.length) {
      let timeout;
      await Promise.race([
        Promise.allSettled(active),
        new Promise((resolve) => {
          timeout = setTimeout(resolve, Math.max(0, Number(drainTimeoutMs) || REPAIR_DRAIN_TIMEOUT_MS));
          timeout.unref?.();
        }),
      ]);
      if (timeout) clearTimeout(timeout);
      for (const guard of activeGuards) guard.stop();
    }
    return { status: "stopped" };
  }

  return {
    enqueueObservation,
    enqueueFromObservation: enqueueObservation,
    getStatus,
    list,
    claimNextJob,
    processJob,
    processAvailable,
    recoverExpiredLeases,
    retryJob,
    start,
    stop,
    shutdown: stop,
    isStarted: () => started && !stopping,
    isRunning: () => running,
  };
}

export {
  ACTIVE_STATUSES,
  boundedEvidence,
  candidateForAction,
  CONFIRMED_ACTION_CODES,
  extractRepairCandidates,
  hasUnknownEvidence,
  isExplicitPreMutationRetry,
  isUnknownOutcome,
  UNKNOWN_EVIDENCE_CODES,
  RepairLeaseLostError,
};
