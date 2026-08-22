import mongoose from "mongoose";
import { GuildSettings } from "./models/guild-settings.js";
import { GuildSettingsRevision } from "./models/guild-settings-revision.js";
import {
  ADMIN_CONFIGURATION_CATALOG,
  CONFIG_SCHEMA_VERSION,
  canonicalizeConfiguration,
  diffConfiguration,
  normalizeConfigurationRevision,
  pickConfigurationPatch,
  pickVersionedCompanionRuntimePatch,
} from "./settings-configuration.js";

const TRANSACTION_TOPOLOGY_TYPES = new Set(["ReplicaSet", "ReplicaSetWithPrimary", "Sharded", "LoadBalanced"]);

export class ConfigurationRevisionConflictError extends Error {
  constructor(guildId, expectedRevision, actualRevision) {
    super(`Configuration revision conflict for guild ${guildId}: expected ${expectedRevision}, current ${actualRevision}.`);
    this.name = "ConfigurationRevisionConflictError";
    this.code = "CONFIGURATION_REVISION_CONFLICT";
    this.guildId = guildId;
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

export class ConfigurationTransactionUnavailableError extends Error {
  constructor() {
    super("Versioned configuration updates require a MongoDB replica set, sharded cluster, or load-balanced deployment; no update was attempted.");
    this.name = "ConfigurationTransactionUnavailableError";
    this.code = "CONFIGURATION_TRANSACTIONS_UNAVAILABLE";
  }
}

export class ConfigurationRevisionNotFoundError extends Error {
  constructor(guildId, revision) {
    super(`Configuration revision ${revision} was not found for guild ${guildId}.`);
    this.name = "ConfigurationRevisionNotFoundError";
    this.code = "CONFIGURATION_REVISION_NOT_FOUND";
    this.guildId = guildId;
    this.revision = revision;
  }
}

export class ConfigurationRevisionReadbackError extends Error {
  constructor(guildId, committedRevision, effectiveRevision) {
    super(`Configuration revision readback mismatch for guild ${guildId}: committed ${committedRevision}, effective ${effectiveRevision}.`);
    this.name = "ConfigurationRevisionReadbackError";
    this.code = "CONFIGURATION_REVISION_READBACK_CONFLICT";
    this.guildId = guildId;
    this.committedRevision = committedRevision;
    this.effectiveRevision = effectiveRevision;
  }
}

function topologyTypeOf(connection) {
  return connection?.client?.topology?.description?.type
    ?? connection?.getClient?.()?.topology?.description?.type
    ?? null;
}

export function supportsMongoTransactions(connection = mongoose.connection) {
  return Boolean(
    connection?.readyState === 1
    && TRANSACTION_TOPOLOGY_TYPES.has(topologyTypeOf(connection)),
  );
}

/**
 * Wrap the atomic writer for bot-facing callers.  GuildSettings reads apply
 * environment compatibility defaults, so callers must use this readback
 * rather than the raw transaction result.  The revision check prevents a
 * stale or cross-guild read from being mistaken for the committed state.
 */
export function createEffectiveConfigurationWriter({ updateConfiguration, getGuildSettings } = {}) {
  if (typeof updateConfiguration !== "function") throw new Error("updateConfiguration is required.");
  if (typeof getGuildSettings !== "function") throw new Error("getGuildSettings is required.");
  return async function saveVersionedGuildConfiguration(guildId, patch, options = {}) {
    const committed = await updateConfiguration(guildId, patch, options);
    const effective = await getGuildSettings(guildId);
    const committedRevision = normalizeConfigurationRevision(committed?.revision ?? committed?.configRevision);
    const effectiveRevision = normalizeConfigurationRevision(effective?.configRevision);
    if (!effective || effective.guildId !== guildId || effectiveRevision < committedRevision) {
      throw new ConfigurationRevisionReadbackError(guildId, committedRevision, effectiveRevision);
    }
    if (effectiveRevision > committedRevision) {
      return {
        ...effective,
        revision: effectiveRevision,
        committedRevision,
        superseded: true,
        committedResult: committed,
      };
    }
    return {
      ...effective,
      revision: committedRevision,
      committedRevision,
      baseRevision: committed?.baseRevision,
      schemaVersion: committed?.schemaVersion,
      snapshot: committed?.snapshot,
      changes: committed?.changes,
      actorUserId: committed?.actorUserId,
      source: committed?.source,
      reason: committed?.reason,
      applyJob: committed?.applyJob,
      createdAt: committed?.createdAt,
    };
  };
}

function sessionQuery(query, session) {
  if (session && typeof query?.session === "function") return query.session(session);
  return query;
}

async function asLean(value) {
  if (value && typeof value.lean === "function") return value.lean();
  return value;
}

async function readSettings(settingsModel, guildId, session) {
  return asLean(sessionQuery(settingsModel.findOne({ guildId }), session));
}

async function readAllSettings(settingsModel, session) {
  if (typeof settingsModel.find !== "function") return [];
  const query = sessionQuery(settingsModel.find({}), session);
  const rows = await asLean(query);
  return Array.isArray(rows) ? rows.map(plainDocument).filter(Boolean) : [];
}

async function findRevision(revisionModel, filter, session) {
  return asLean(sessionQuery(revisionModel.findOne(filter), session));
}

function plainDocument(document) {
  if (document && typeof document.toObject === "function") return document.toObject();
  return document ?? null;
}

function boundedText(value, max, fallback = null) {
  if (value === undefined || value === null) return fallback;
  return String(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim().slice(0, max) || fallback;
}

function metadata(options = {}) {
  return {
    actorUserId: boundedText(options.actorUserId, 128),
    source: boundedText(options.source, 100, "unknown"),
    reason: boundedText(options.reason, 500),
  };
}

async function defaultTransactionRunner(connection, work) {
  if (!supportsMongoTransactions(connection)) throw new ConfigurationTransactionUnavailableError();
  const session = await connection.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await work(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}

async function createRevision(revisionModel, revision, session) {
  if (typeof revisionModel.create === "function") {
    const created = await revisionModel.create([revision], session ? { session } : undefined);
    return Array.isArray(created) ? created[0] : created;
  }
  if (typeof revisionModel.insertOne === "function") return revisionModel.insertOne(revision, session ? { session } : undefined);
  throw new Error("GuildSettingsRevision model cannot create a document.");
}

async function createApplyJob(applyJobModel, job, session) {
  if (!applyJobModel) return null;
  if (typeof applyJobModel.create === "function") {
    const created = await applyJobModel.create([job], session ? { session } : undefined);
    return Array.isArray(created) ? created[0] : created;
  }
  if (typeof applyJobModel.insertOne === "function") {
    return applyJobModel.insertOne(job, session ? { session } : undefined);
  }
  throw new Error("SettingsApplyJob model cannot create a document.");
}

async function updateSettings(settingsModel, filter, update, options, session) {
  const query = settingsModel.findOneAndUpdate(filter, update, {
    ...options,
    session,
  });
  return plainDocument(await asLean(query));
}

function snapshotForRevision(revision) {
  return canonicalizeConfiguration(revision?.snapshot ?? {});
}

function baselineChanges() {
  return {
    added: [],
    changed: [],
    removed: [],
    count: 0,
    keys: [],
    baseline: true,
    type: "baseline",
  };
}

function isConfigurationRevisionMissingOrZero(document) {
  return document && normalizeConfigurationRevision(document.configRevision) === 0;
}

/**
 * Read-only configuration/revision and atomic update service.  The default
 * writer refuses standalone MongoDB before opening a write transaction; tests
 * may inject transactionRunner to exercise CAS semantics without MongoDB.
 */
export function createConfigurationService({
  settingsModel = GuildSettings,
  revisionModel = GuildSettingsRevision,
  // Unit/in-process callers may intentionally omit jobs.  The composition
  // root passes the real model so production revision writes are atomic with
  // their apply job.
  applyJobModel = null,
  connection = mongoose.connection,
  transactionRunner = null,
  now = () => new Date(),
  logger = console,
} = {}) {
  const runTransaction = transactionRunner
    ? (work) => transactionRunner(work)
    : (work) => defaultTransactionRunner(connection, work);

  async function getCurrentConfiguration(guildId, { session = null } = {}) {
    const raw = plainDocument(await readSettings(settingsModel, guildId, session));
    return {
      guildId,
      revision: normalizeConfigurationRevision(raw?.configRevision),
      schemaVersion: Number.isInteger(Number(raw?.configSchemaVersion))
        && Number(raw.configSchemaVersion) > 0
        ? Number(raw.configSchemaVersion)
        : CONFIG_SCHEMA_VERSION,
      snapshot: canonicalizeConfiguration(raw ?? {}),
      exists: Boolean(raw),
    };
  }

  /**
   * Give an already-persisted GuildSettings document a stable starting
   * point.  This is intentionally done with a revision-guarded update and
   * the baseline insert in the same transaction so two bot processes cannot
   * publish duplicate baselines or leave only one side of the migration.
   */
  async function ensureBaselineRevision(guildId, session, initialDocument = null) {
    let current = plainDocument(initialDocument ?? await readSettings(settingsModel, guildId, session));
    if (!current) return { status: "missing", revision: 0, document: null };
    const actual = normalizeConfigurationRevision(current.configRevision);
    if (actual > 0) return { status: "current", revision: actual, document: current };

    const filter = {
      guildId,
      $or: [
        { configRevision: { $exists: false } },
        { configRevision: 0 },
      ],
    };
    const existingBaseline = await findRevision(revisionModel, { guildId, revision: 1 }, session);
    if (existingBaseline) {
      const updated = await updateSettings(
        settingsModel,
        filter,
        { $set: { configRevision: 1, configSchemaVersion: CONFIG_SCHEMA_VERSION } },
        { upsert: false, returnDocument: "after", new: true },
        session,
      );
      if (updated) return { status: "existing", revision: 1, document: updated };
      current = plainDocument(await readSettings(settingsModel, guildId, session));
      if (normalizeConfigurationRevision(current?.configRevision) >= 1) {
        return { status: "current", revision: normalizeConfigurationRevision(current.configRevision), document: current };
      }
      throw new ConfigurationRevisionConflictError(guildId, 0, normalizeConfigurationRevision(current?.configRevision));
    }

    const snapshot = canonicalizeConfiguration(current);
    const updated = await updateSettings(
      settingsModel,
      filter,
      { $set: { configRevision: 1, configSchemaVersion: CONFIG_SCHEMA_VERSION } },
      { upsert: false, returnDocument: "after", new: true },
      session,
    );
    if (!updated) {
      current = plainDocument(await readSettings(settingsModel, guildId, session));
      if (normalizeConfigurationRevision(current?.configRevision) >= 1) {
        return { status: "current", revision: normalizeConfigurationRevision(current.configRevision), document: current };
      }
      throw new ConfigurationRevisionConflictError(guildId, 0, normalizeConfigurationRevision(current?.configRevision));
    }

    const createdAt = new Date(now());
    await createRevision(revisionModel, {
      guildId,
      revision: 1,
      baseRevision: 0,
      schemaVersion: CONFIG_SCHEMA_VERSION,
      snapshot,
      changes: baselineChanges(),
      actorUserId: null,
      source: "migration/backfill",
      reason: "initial configuration baseline",
      createdAt,
    }, session);
    return { status: "created", revision: 1, document: updated };
  }

  async function updateConfiguration(guildId, patch, {
    expectedRevision,
    actorUserId = null,
    source = "unknown",
    reason = null,
    companionPatch = {},
    jobType = "update",
    rollbackTargetRevision = null,
  } = {}) {
    if (!guildId) throw new Error("guildId is required.");
    if (!Number.isInteger(Number(expectedRevision)) || Number(expectedRevision) < 0) {
      const error = new Error("expectedRevision is required for versioned configuration updates.");
      error.code = "EXPECTED_CONFIGURATION_REVISION_REQUIRED";
      throw error;
    }
    const cleanPatch = pickConfigurationPatch(patch);
    const cleanCompanionPatch = pickVersionedCompanionRuntimePatch(companionPatch);
    const expected = Number(expectedRevision);
    const meta = metadata({ actorUserId, source, reason });
    try {
      return await runTransaction(async (session) => {
        let current = plainDocument(await readSettings(settingsModel, guildId, session));
        let actual = normalizeConfigurationRevision(current?.configRevision);
        const legacyExpectedRevision = Boolean(current && actual === 0 && expected === 0);
        if (current && actual === 0) {
          const baseline = await ensureBaselineRevision(guildId, session, current);
          current = baseline.document;
          actual = baseline.revision;
        }
        if (actual !== expected && !legacyExpectedRevision) {
          throw new ConfigurationRevisionConflictError(guildId, expected, actual);
        }
        const nextRevision = actual + 1;
        const filter = {
          guildId,
          $or: [
            { configRevision: actual },
            { configRevision: { $exists: false } },
          ],
        };
        const updated = await updateSettings(
          settingsModel,
          filter,
          {
            $set: {
              ...cleanPatch,
              ...cleanCompanionPatch,
              guildId,
              configRevision: nextRevision,
              configSchemaVersion: CONFIG_SCHEMA_VERSION,
            },
          },
          { upsert: true, returnDocument: "after", new: true, setDefaultsOnInsert: true },
          session,
        );
        if (!updated) throw new ConfigurationRevisionConflictError(guildId, expected, actual + 1);
        const previousSnapshot = canonicalizeConfiguration(current ?? {});
        const snapshot = canonicalizeConfiguration(updated);
        const changes = diffConfiguration(previousSnapshot, snapshot);
        const createdAt = new Date(now());
        const revisionDocument = {
          guildId,
          revision: nextRevision,
          baseRevision: actual,
          schemaVersion: CONFIG_SCHEMA_VERSION,
          snapshot,
          changes,
          actorUserId: meta.actorUserId,
          source: meta.source,
          reason: meta.reason,
          jobType,
          rollbackTargetRevision,
          createdAt,
        };
        await createRevision(revisionModel, revisionDocument, session);
        const applyJob = await createApplyJob(applyJobModel, {
          guildId,
          revision: nextRevision,
          targetRevision: nextRevision,
          jobType,
          changedKeys: changes.keys ?? [],
          status: "pending",
          attemptCount: 0,
          manualRetryCount: 0,
          maxManualRetries: 3,
          nextAttemptAt: createdAt,
          leaseOwner: null,
          leaseExpiresAt: null,
          lastError: null,
          actorUserId: meta.actorUserId,
          source: meta.source,
          reason: meta.reason,
          rollbackTargetRevision,
          createdAt,
          updatedAt: createdAt,
        }, session);
        return {
          ...updated,
          guildId,
          revision: nextRevision,
          baseRevision: actual,
          schemaVersion: CONFIG_SCHEMA_VERSION,
          snapshot,
          changes,
          actorUserId: meta.actorUserId,
          source: meta.source,
          reason: meta.reason,
          jobType,
          rollbackTargetRevision,
          applyJob: plainDocument(applyJob),
          createdAt,
        };
      });
    } catch (error) {
      // A concurrent upsert can surface as a unique-key error before the
      // transaction retry machinery observes the newer revision.  Expose the
      // same safe CAS conflict to callers; the transaction has been aborted.
      if (error?.code === 11000 || error?.codeName === "DuplicateKey") {
        throw new ConfigurationRevisionConflictError(guildId, expected, expected + 1);
      }
      throw error;
    }
  }

  /**
   * Apply a historical configuration snapshot as a new revision.  The
   * historical row is never edited; the target is copied through the same
   * allowlisted CAS path as an ordinary update.  Missing keys are `$unset`
   * so environment fallbacks become effective again, while runtime fields
   * are deliberately never included in either operation.
   */
  async function rollbackConfiguration(guildId, targetRevision, {
    expectedRevision,
    actorUserId = null,
    source = "config/rollback",
    reason = null,
    preflight = null,
  } = {}) {
    if (!guildId) throw new Error("guildId is required.");
    const target = Number(targetRevision);
    const expected = Number(expectedRevision);
    if (!Number.isInteger(target) || target < 0) throw new ConfigurationRevisionNotFoundError(guildId, targetRevision);
    if (!Number.isInteger(expected) || expected < 0) {
      const error = new Error("expectedRevision is required for rollback.");
      error.code = "EXPECTED_CONFIGURATION_REVISION_REQUIRED";
      throw error;
    }
    if (typeof preflight === "function") await preflight({ guildId, targetRevision: target, expectedRevision: expected });
    const meta = metadata({ actorUserId, source, reason });
    try {
      return await runTransaction(async (session) => {
        let current = plainDocument(await readSettings(settingsModel, guildId, session));
        let actual = normalizeConfigurationRevision(current?.configRevision);
        const legacyExpectedRevision = Boolean(current && actual === 0 && expected === 0);
        if (current && actual === 0) {
          const baseline = await ensureBaselineRevision(guildId, session, current);
          current = baseline.document;
          actual = baseline.revision;
        }
        if (actual !== expected && !legacyExpectedRevision) {
          throw new ConfigurationRevisionConflictError(guildId, expected, actual);
        }

        let targetRow = null;
        if (target > 0) targetRow = await findRevision(revisionModel, { guildId, revision: target }, session);
        if (target > 0 && (!targetRow || targetRow.guildId !== guildId)) {
          throw new ConfigurationRevisionNotFoundError(guildId, target);
        }
        const targetSnapshot = canonicalizeConfiguration(targetRow?.snapshot ?? {});
        const previousSnapshot = canonicalizeConfiguration(current ?? {});
        const changes = diffConfiguration(previousSnapshot, targetSnapshot);
        const nextRevision = actual + 1;
        // Re-enabling fukyo during a rollback has the same semantics as a
        // normal false -> true setting change.  Move the runtime activation
        // marker atomically with the historical configuration so startup
        // cannot interpret the rollback as having been enabled in the past
        // and publish a stale weekly theme retroactively.
        const companionPatch = current?.fukyoWeeklyThemeEnabled !== true
          && targetSnapshot.fukyoWeeklyThemeEnabled === true
          ? { fukyoWeeklyThemeEnabledAt: new Date(now()) }
          : {};
        const filter = {
          guildId,
          $or: [
            { configRevision: actual },
            { configRevision: { $exists: false } },
          ],
        };
        const setValues = {
          ...targetSnapshot,
          ...companionPatch,
          guildId,
          configRevision: nextRevision,
          configSchemaVersion: CONFIG_SCHEMA_VERSION,
        };
        const unsetValues = Object.fromEntries(
          Object.keys(previousSnapshot)
            .filter((key) => !Object.prototype.hasOwnProperty.call(targetSnapshot, key))
            .map((key) => [key, 1]),
        );
        const update = { $set: setValues };
        if (Object.keys(unsetValues).length > 0) update.$unset = unsetValues;
        const updated = await updateSettings(
          settingsModel,
          filter,
          update,
          { upsert: true, returnDocument: "after", new: true, setDefaultsOnInsert: true },
          session,
        );
        if (!updated) throw new ConfigurationRevisionConflictError(guildId, expected, actual + 1);
        const createdAt = new Date(now());
        const revisionDocument = {
          guildId,
          revision: nextRevision,
          baseRevision: actual,
          schemaVersion: CONFIG_SCHEMA_VERSION,
          snapshot: targetSnapshot,
          changes,
          actorUserId: meta.actorUserId,
          source: meta.source,
          reason: meta.reason,
          jobType: "rollback",
          rollbackTargetRevision: target,
          createdAt,
        };
        await createRevision(revisionModel, revisionDocument, session);
        const applyJob = await createApplyJob(applyJobModel, {
          guildId,
          revision: nextRevision,
          targetRevision: nextRevision,
          jobType: "rollback",
          changedKeys: changes.keys ?? [],
          status: "pending",
          attemptCount: 0,
          manualRetryCount: 0,
          maxManualRetries: 3,
          nextAttemptAt: createdAt,
          leaseOwner: null,
          leaseExpiresAt: null,
          lastError: null,
          actorUserId: meta.actorUserId,
          source: meta.source,
          reason: meta.reason,
          rollbackTargetRevision: target,
          createdAt,
          updatedAt: createdAt,
        }, session);
        return {
          ...updated,
          guildId,
          revision: nextRevision,
          baseRevision: actual,
          schemaVersion: CONFIG_SCHEMA_VERSION,
          snapshot: targetSnapshot,
          changes,
          actorUserId: meta.actorUserId,
          source: meta.source,
          reason: meta.reason,
          jobType: "rollback",
          rollbackTargetRevision: target,
          applyJob: plainDocument(applyJob),
          createdAt,
        };
      });
    } catch (error) {
      if (error?.code === 11000 || error?.codeName === "DuplicateKey") {
        throw new ConfigurationRevisionConflictError(guildId, expected, expected + 1);
      }
      throw error;
    }
  }

  async function getApplyJobModel() {
    return applyJobModel;
  }

  async function backfillGuildSettings(guildId = null) {
    return runTransaction(async (session) => {
      const rows = guildId
        ? [plainDocument(await readSettings(settingsModel, guildId, session))].filter(Boolean)
        : await readAllSettings(settingsModel, session);
      const result = {
        matchedCount: rows.length,
        modifiedCount: 0,
        baselineCreatedCount: 0,
        baselineExistingCount: 0,
        skippedCount: 0,
      };
      for (const row of rows) {
        if (!isConfigurationRevisionMissingOrZero(row)) {
          result.skippedCount += 1;
          continue;
        }
        const baseline = await ensureBaselineRevision(row.guildId, session, row);
        if (baseline.status === "created") {
          result.modifiedCount += 1;
          result.baselineCreatedCount += 1;
        } else if (baseline.status === "existing") {
          result.modifiedCount += 1;
          result.baselineExistingCount += 1;
        } else {
          result.skippedCount += 1;
        }
      }
      return result;
    });
  }

  async function listHistory(guildId, limit = 10) {
    const boundedLimit = Math.max(1, Math.min(20, Number(limit) || 10));
    let query = revisionModel.find({ guildId }).sort?.({ revision: -1 });
    if (query?.limit) query = query.limit(boundedLimit);
    const rows = await asLean(query ?? []);
    return (Array.isArray(rows) ? rows : []).filter((row) => row?.guildId === guildId).slice(0, boundedLimit);
  }

  async function getRevision(guildId, revision = null) {
    const current = await getCurrentConfiguration(guildId);
    if (revision === null || revision === undefined) return { ...current, revision: current.revision };
    const target = Number(revision);
    if (!Number.isInteger(target) || target < 0) throw new ConfigurationRevisionNotFoundError(guildId, revision);
    if (target === 0) return { guildId, revision: 0, baseRevision: 0, schemaVersion: CONFIG_SCHEMA_VERSION, snapshot: {}, changes: { added: [], changed: [], removed: [], count: 0, keys: [] } };
    const row = await findRevision(revisionModel, { guildId, revision: target });
    if (!row || row.guildId !== guildId) throw new ConfigurationRevisionNotFoundError(guildId, target);
    return {
      ...plainDocument(row),
      guildId,
      revision: target,
      snapshot: snapshotForRevision(row),
      changes: row.changes ?? diffConfiguration({}, row.snapshot ?? {}),
    };
  }

  async function diffRevisions(guildId, fromRevision, toRevision) {
    const from = await getRevision(guildId, fromRevision);
    const to = await getRevision(guildId, toRevision);
    return {
      guildId,
      fromRevision: from.revision,
      toRevision: to.revision,
      changes: diffConfiguration(from.snapshot, to.snapshot),
    };
  }

  return {
    backfillGuildSettings,
    backfill: backfillGuildSettings,
    diffRevisions,
    diff: diffRevisions,
    getCurrentConfiguration,
    current: getCurrentConfiguration,
    getRevision,
    rollbackConfiguration,
    rollback: rollbackConfiguration,
    getApplyJobModel,
    listHistory,
    history: listHistory,
    updateConfiguration,
    updateAdminConfiguration: updateConfiguration,
    applyJobModel,
    catalog: ADMIN_CONFIGURATION_CATALOG,
    logger,
  };
}

export {
  canonicalizeConfiguration,
  diffConfiguration,
  pickConfigurationPatch,
};
