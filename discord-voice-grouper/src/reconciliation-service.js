import crypto from "node:crypto";
import { acquireMongoLease, releaseMongoLease, renewMongoLease } from "./mongo-lease-lock-store.js";
import { ReconciliationObservation } from "./models/reconciliation-observation.js";

export const RECONCILIATION_INTERVAL_MS = 30 * 60 * 1000;
export const RECONCILIATION_SCHEMA_VERSION = 1;
export const RECONCILIATION_LEASE_MS = 60 * 1000;
export const RECONCILIATION_DRAIN_TIMEOUT_MS = 15 * 1000;
export const RECONCILIATION_LEASE_PREFIX = "settings-reconciliation";

const STATUS_RANK = Object.freeze({ healthy: 0, warning: 1, unknown: 2, error: 3, failed: 4 });
const CANDIDATE_LIMIT = 50;
const ERROR_LIMIT = 500;

// This is deliberately a small, reviewable allowlist.  A new action must be
// added with evidence-producing tests before a later apply stage can use it.
const OPERATIONAL_CANDIDATE_RULES = Object.freeze({
  profile_panel_missing: { key: "profile_panel.ensure", reason: "保存済みプロフィールパネルまたはメッセージが確認できません。" },
  profile_panel_message_missing: { key: "profile_panel.ensure", reason: "保存済みプロフィールパネルメッセージが見つかりません。" },
  profile_panel_channel_mismatch: { key: "profile_panel.ensure", reason: "保存済みプロフィールパネルの設置先が設定と一致しません。" },
  vc_panel_missing: { key: "voice_control_panels.ensure", reason: "VCコントロールパネルの保存情報がありません。" },
  vc_panel_message_missing: { key: "voice_control_panels.ensure", reason: "VCコントロールパネルメッセージが見つかりません。" },
  otebo_panel_state_missing: { key: "otebo_panel.ensure", reason: "Oteboパネルの保存情報がありません。" },
  otebo_panel_message_missing: { key: "otebo_panel.ensure", reason: "Oteboパネルメッセージが見つかりません。" },
  otebo_panel_channel_mismatch: { key: "otebo_panel.ensure", reason: "保存済みOteboパネルの設置先が設定と一致しません。" },
});

function asDate(value, fallback = new Date()) {
  const date = value instanceof Date ? value : new Date(value ?? fallback);
  return Number.isNaN(date.getTime()) ? new Date(fallback) : date;
}

function sanitize(value, max = ERROR_LIMIT) {
  return String(value ?? "unknown")
    .replace(/mongodb(?:\+srv)?:\/\/[^\s]+/gi, "[redacted MongoDB URI]")
    .replace(/\b(token|password|passwd|pwd|secret)\s*[=:]\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/\b(token|password|passwd|pwd|secret)[-_][A-Za-z0-9._~+/=-]+/gi, "$1-[redacted]")
    .replace(/\bBot\s+[A-Za-z0-9._-]+/g, "Bot [redacted]")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function emptyCounts() {
  return { healthy: 0, warning: 0, error: 0, unknown: 0 };
}

function incrementCount(counts, status) {
  const normalized = status === "ok" || status === "healthy" || status === "info" || status === "disabled"
    ? "healthy"
    : status === "warning"
      ? "warning"
      : status === "error"
        ? "error"
        : "unknown";
  counts[normalized] += 1;
}

function worstStatus(statuses = []) {
  let result = "healthy";
  for (const status of statuses) {
    const normalized = status === "ok" ? "healthy" : status;
    if (STATUS_RANK[normalized] > STATUS_RANK[result]) result = normalized;
  }
  return result;
}

function reportsFromValidation(report) {
  if (!report) return [];
  if (Array.isArray(report.reports)) return report.reports;
  return [report];
}

function checksFromValidation(report) {
  const reports = reportsFromValidation(report);
  return reports.flatMap((item) => Array.isArray(item?.checks) ? item.checks : []);
}

function countValidation(report) {
  const counts = emptyCounts();
  for (const check of checksFromValidation(report)) incrementCount(counts, check?.status);
  if (Object.values(counts).every((value) => value === 0)) {
    for (const item of reportsFromValidation(report)) incrementCount(counts, item?.status);
  }
  return counts;
}

function operationalModules(snapshot) {
  return Object.values(snapshot?.modules ?? {}).filter((module) => module && typeof module === "object");
}

function operationalCounts(snapshot) {
  const counts = emptyCounts();
  for (const module of operationalModules(snapshot)) incrementCount(counts, module.severity);
  if (Object.values(counts).every((value) => value === 0) && snapshot?.status) incrementCount(counts, snapshot.status);
  return counts;
}

function operationalStatus(snapshot) {
  const statuses = operationalModules(snapshot).map((module) => module.severity)
    .filter((status) => status && status !== "disabled" && status !== "info");
  if (statuses.length === 0 && snapshot?.status) statuses.push(snapshot.status);
  return worstStatus(statuses);
}

function candidateFromRule(rule, { source, code, checkKey, evidenceStatus }) {
  return {
    key: rule.key,
    reason: rule.reason,
    evidenceStatus,
    safe: true,
    requiresApplyJob: true,
    evidence: {
      source,
      code: code ?? null,
      checkKey: checkKey ?? null,
    },
  };
}

/**
 * Pure candidate extraction.  Only confirmed warning/error evidence from the
 * explicit allowlist is converted to a future action; unknowns are never
 * repair candidates.
 */
export function extractRepairCandidates(validationReport, operationalSnapshot) {
  const candidates = [];
  const seen = new Set();
  const add = (candidate) => {
    if (!candidate || seen.has(candidate.key) || candidates.length >= CANDIDATE_LIMIT) return;
    seen.add(candidate.key);
    candidates.push(candidate);
  };

  for (const check of checksFromValidation(validationReport)) {
    if (!["warning", "error"].includes(check?.status)) continue;
    const validationChecks = checksFromValidation(validationReport);
    if (check.key?.startsWith("status_board.") && validationChecks.some((item) => item.key?.startsWith("status_board.") && item.status === "unknown")) continue;
    // A status-board channel error means the configured target is not a safe
    // repair destination (missing, wrong type/guild, inaccessible, or an API
    // failure).  The only confirmed channel evidence that may enqueue a
    // repair is an explicit persisted-channel drift.
    if (check.key?.startsWith("status_board.") && validationChecks.some((item) => (
      item.key?.startsWith("status_board.channel")
      && item.status === "error"
      && item.reason !== "channel-mismatch"
    ))) continue;
    // A missing status-board message is a confirmed stale state.  A missing
    // configured channel is not safe to recreate and therefore is excluded.
    if ((check.key === "status_board.message" && check.reason === "message-missing")
      || (check.key === "status_board.channel" && check.reason === "channel-mismatch")) {
      add(candidateFromRule({ key: "status_board.ensure", reason: "保存済みステータスボードメッセージが見つかりません。" }, {
        source: "validation",
        checkKey: check.key,
        evidenceStatus: check.status,
      }));
    }
  }

  for (const module of operationalModules(operationalSnapshot)) {
    if (module.severity === "unknown") continue;
    const source = module.key === "panels" ? "operational" : module.key === "recruitment" ? "operational" : null;
    if (!source) continue;
    for (const issue of module.issues ?? []) {
      const rule = OPERATIONAL_CANDIDATE_RULES[issue?.code];
      if (!rule || issue?.severity === "unknown" || issue?.status === "unknown") continue;
      const evidenceStatus = issue?.blocking === true || issue?.severity === "error" ? "error" : "warning";
      add(candidateFromRule(rule, {
        source,
        code: issue.code,
        evidenceStatus,
      }));
    }
  }
  return candidates;
}

export function summarizeReconciliation(validationReport, operationalSnapshot) {
  const validationCounts = countValidation(validationReport);
  const operationalCountsValue = operationalCounts(operationalSnapshot);
  const validationStatus = worstStatus([
    ...Object.entries(validationCounts).flatMap(([status, count]) => Array.from({ length: count }, () => status)),
    validationReport?.status,
  ]);
  const opStatus = operationalStatus(operationalSnapshot);
  const status = worstStatus([validationStatus, opStatus]);
  return {
    status,
    validationCounts,
    operationalSeverity: opStatus,
    operationalCounts: operationalCountsValue,
    candidates: extractRepairCandidates(validationReport, operationalSnapshot),
  };
}

function valueOfQuery(value) {
  if (value && typeof value.lean === "function") return value.lean();
  return value;
}

async function resolveQuery(value) {
  return valueOfQuery(value);
}

function normalizeGuilds(value) {
  if (!value) return [];
  if (typeof value.values === "function") return [...value.values()];
  if (Array.isArray(value)) return value;
  return [...value];
}

class ReconciliationLeaseLostError extends Error {
  constructor() {
    super("Reconciliation lease ownership was lost.");
    this.code = "RECONCILIATION_LEASE_LOST";
  }
}

export function createReconciliationService({
  client = null,
  getGuilds = null,
  validationService,
  settingsValidationService = null,
  operationalStatusService,
  observationModel = ReconciliationObservation,
  acquireLease = acquireMongoLease,
  renewLease = renewMongoLease,
  releaseLease = releaseMongoLease,
  leasePrefix = RECONCILIATION_LEASE_PREFIX,
  leaseMs = RECONCILIATION_LEASE_MS,
  intervalMs = RECONCILIATION_INTERVAL_MS,
  drainTimeoutMs = RECONCILIATION_DRAIN_TIMEOUT_MS,
  now = () => new Date(),
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  setHeartbeatIntervalFn = setInterval,
  clearHeartbeatIntervalFn = clearInterval,
  awaitInitialRun = false,
  onObservation = null,
  workerId = `${process.pid}:${crypto.randomUUID()}`,
  logger = console,
} = {}) {
  const validator = validationService ?? settingsValidationService;
  if (!validator?.validateGuild) throw new Error("validationService.validateGuild is required.");
  if (!operationalStatusService?.getOperationalStatusSnapshot) throw new Error("operationalStatusService.getOperationalStatusSnapshot is required.");
  if (!observationModel) throw new Error("observationModel is required.");
  if (!Number.isFinite(Number(intervalMs)) || Number(intervalMs) <= 0) throw new Error("intervalMs must be positive.");

  let timer = null;
  let started = false;
  let shuttingDown = false;
  let running = false;
  const activeRuns = new Set();
  const activeHeartbeatGuards = new Set();
  const heartbeatIntervalMs = Math.max(1, Math.floor(Number(leaseMs) / 3));

  function guildList() {
    if (typeof getGuilds === "function") return normalizeGuilds(getGuilds());
    return normalizeGuilds(client?.guilds?.cache);
  }

  async function getLatest(guildId) {
    if (!guildId || typeof observationModel.findOne !== "function") return null;
    const query = observationModel.findOne({ guildId });
    return resolveQuery(query);
  }

  async function saveLatest(document) {
    const update = { ...document, lastError: document.lastError ? sanitize(document.lastError) : null };
    if (typeof observationModel.findOneAndUpdate === "function") {
      return resolveQuery(observationModel.findOneAndUpdate(
        { guildId: document.guildId },
        // guildId is included in the single $set document for both upserts
        // and existing rows.  Supplying it again via $setOnInsert causes a
        // MongoDB update-path conflict during the first insert.
        { $set: update },
        { upsert: true, new: true, returnDocument: "after", setDefaultsOnInsert: true },
      ));
    }
    if (typeof observationModel.create === "function") return observationModel.create(update);
    throw new Error("observationModel cannot persist a reconciliation result.");
  }

  async function assertLease(lease) {
    if (!lease || typeof renewLease !== "function") throw new ReconciliationLeaseLostError();
    const renewed = await renewLease(lease, { leaseMs });
    if (renewed === false) throw new ReconciliationLeaseLostError();
    return true;
  }

  async function runGuild(guild) {
    if (!guild?.id) return { guildId: null, status: "skipped", reason: "guild-id-missing" };
    if (shuttingDown) return { guildId: guild.id, status: "skipped", reason: "shutting-down" };
    const startedAt = asDate(now());
    const runId = crypto.randomUUID();
    let lease = null;
    let previous = null;
    let heartbeatTimer = null;
    let leaseLost = false;
    const heartbeatGuard = {
      stop() {
        leaseLost = true;
        if (heartbeatTimer) clearHeartbeatIntervalFn(heartbeatTimer);
        heartbeatTimer = null;
      },
    };
    const leaseKey = `${leasePrefix}:${guild.id}`;
    try {
      lease = await acquireLease(leaseKey, { ownerId: workerId, leaseMs });
      if (!lease) return { guildId: guild.id, status: "skipped", reason: "lease-unavailable" };
      if (shuttingDown) {
        return { guildId: guild.id, status: "skipped", reason: "shutting-down" };
      }
      activeHeartbeatGuards.add(heartbeatGuard);
      heartbeatTimer = setHeartbeatIntervalFn(() => (async () => {
          if (leaseLost) return;
          try {
            const renewed = await renewLease(lease, { leaseMs });
            if (renewed === false) leaseLost = true;
          } catch {
            leaseLost = true;
          }
        })(), heartbeatIntervalMs);
      heartbeatTimer?.unref?.();
      previous = await getLatest(guild.id).catch(() => null);
      if (leaseLost) throw new ReconciliationLeaseLostError();
      await assertLease(lease);
      if (leaseLost) throw new ReconciliationLeaseLostError();
      const validationReport = await validator.validateGuild({ guild, feature: "all" });
      if (leaseLost) throw new ReconciliationLeaseLostError();
      await assertLease(lease);
      if (leaseLost) throw new ReconciliationLeaseLostError();
      const operationalSnapshot = await operationalStatusService.getOperationalStatusSnapshot(guild, { persistHealth: false, readOnly: true });
      if (leaseLost) throw new ReconciliationLeaseLostError();
      await assertLease(lease);
      if (leaseLost) throw new ReconciliationLeaseLostError();
      const summary = summarizeReconciliation(validationReport, operationalSnapshot);
      const completedAt = asDate(now());
      const document = {
        guildId: guild.id,
        runId,
        status: summary.status,
        startedAt,
        completedAt,
        durationMs: Math.max(0, completedAt.getTime() - startedAt.getTime()),
        validationCounts: summary.validationCounts,
        operationalSeverity: summary.operationalSeverity,
        operationalCounts: summary.operationalCounts,
        candidates: summary.candidates,
        consecutiveFailures: 0,
        lastError: null,
        nextRunAt: new Date(completedAt.getTime() + Number(intervalMs)),
        schemaVersion: RECONCILIATION_SCHEMA_VERSION,
      };
      // The only persistence performed by a reconciliation run is its own
      // aggregate observation document.
      await assertLease(lease);
      if (leaseLost) throw new ReconciliationLeaseLostError();
      const saved = await saveLatest(document);
      if (typeof onObservation === "function") {
        // Repair enqueueing is deliberately outside the read-only validator
        // and occurs only after this aggregate observation is durable.  A
        // repair-service outage must not turn a successful observation into a
        // failed one or cause the read-only loop to retry Discord work.
        try {
          await onObservation(saved ?? document);
        } catch (error) {
          logger.warn?.(`Reconciliation repair enqueue failed for guild=${guild.id}: ${sanitize(error?.message ?? error)}`);
        }
      }
      return { guildId: guild.id, status: document.status, observation: saved ?? document };
    } catch (error) {
      if (error?.code === "RECONCILIATION_LEASE_LOST") {
        return { guildId: guild.id, status: "skipped", reason: "lease-lost" };
      }
      const completedAt = asDate(now());
      const failed = {
        guildId: guild.id,
        runId,
        status: "failed",
        startedAt,
        completedAt,
        durationMs: Math.max(0, completedAt.getTime() - startedAt.getTime()),
        validationCounts: emptyCounts(),
        operationalSeverity: "unknown",
        operationalCounts: emptyCounts(),
        candidates: [],
        consecutiveFailures: Number(previous?.consecutiveFailures ?? 0) + 1,
        lastError: sanitize(error?.message ?? error),
        nextRunAt: new Date(completedAt.getTime() + Number(intervalMs)),
        schemaVersion: RECONCILIATION_SCHEMA_VERSION,
      };
      try {
        if (lease && !leaseLost) {
          await assertLease(lease);
          if (!leaseLost) await saveLatest(failed);
        }
      } catch (saveError) {
        logger.warn?.(`Reconciliation result could not be saved for guild=${guild.id}: ${sanitize(saveError?.message ?? saveError)}`);
      }
      logger.warn?.(`Reconciliation failed for guild=${guild.id}: ${failed.lastError}`);
      return { guildId: guild.id, status: "failed", observation: failed, error };
    } finally {
      heartbeatGuard.stop();
      activeHeartbeatGuards.delete(heartbeatGuard);
      if (lease && typeof releaseLease === "function") {
        try {
          await releaseLease(lease);
        } catch (error) {
          logger.warn?.(`Reconciliation lease release failed for guild=${guild.id}: ${sanitize(error?.message ?? error)}`);
        }
      }
    }
  }

  async function runAll() {
    if (shuttingDown) return { status: "skipped", reason: "shutting-down", results: [] };
    if (running) return { status: "skipped", reason: "overlap", results: [] };
    running = true;
    const task = (async () => {
      const results = [];
      for (const guild of guildList()) {
        if (shuttingDown) break;
        try {
          results.push(await runGuild(guild));
        } catch (error) {
          // runGuild is defensive, but preserve one-guild isolation if a
          // custom dependency throws outside its normal boundary.
          logger.warn?.(`Reconciliation guild loop failed: ${sanitize(error?.message ?? error)}`);
          results.push({ guildId: guild?.id ?? null, status: "failed", error });
        }
      }
      return { status: "completed", results };
    })();
    activeRuns.add(task);
    try {
      return await task;
    } finally {
      activeRuns.delete(task);
      running = false;
    }
  }

  function schedule() {
    if (timer || typeof setIntervalFn !== "function") return;
    timer = setIntervalFn(() => { void runAll().catch((error) => logger.warn?.(`Reconciliation tick failed: ${sanitize(error?.message ?? error)}`)); }, Number(intervalMs));
    timer?.unref?.();
  }

  async function start() {
    if (started && !shuttingDown) return { status: "already_started" };
    started = true;
    shuttingDown = false;
    schedule();
    // Dispatch the first observation only after the ready hook has completed
    // restoration.  Do not hold the ready event open while every guild is
    // read; tests can opt into awaiting it explicitly.
    const initialRun = runAll();
    initialRun.catch((error) => logger.warn?.(`Initial reconciliation failed: ${sanitize(error?.message ?? error)}`));
    return awaitInitialRun ? initialRun : { status: "started", initialRun };
  }

  async function stop() {
    if (!started && activeRuns.size === 0) return { status: "stopped" };
    shuttingDown = true;
    started = false;
    if (timer) clearIntervalFn(timer);
    timer = null;
    const active = [...activeRuns];
    if (active.length > 0) {
      let timeout;
      await Promise.race([
        Promise.allSettled(active),
        new Promise((resolve) => {
          timeout = setTimeout(resolve, Math.max(0, Number(drainTimeoutMs) || RECONCILIATION_DRAIN_TIMEOUT_MS));
          timeout.unref?.();
        }),
      ]);
      clearTimeout(timeout);
      // A run which did not drain within the bounded shutdown window must no
      // longer renew or persist.  Its lease will expire and be safely
      // reclaimed by a later instance.
      for (const guard of activeHeartbeatGuards) guard.stop();
    }
    return { status: "stopped" };
  }

  return {
    getLatest,
    isRunning: () => running,
    isStarted: () => started && !shuttingDown,
    runGuild,
    runNow: runAll,
    start,
    stop,
    shutdown: stop,
    intervalMs: Number(intervalMs),
  };
}

export { OPERATIONAL_CANDIDATE_RULES, ReconciliationLeaseLostError, sanitize };
