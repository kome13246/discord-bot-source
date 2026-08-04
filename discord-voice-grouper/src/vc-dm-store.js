import mongoose from "mongoose";
import { VcDmDailyRun } from "./models/vc-dm-daily-run.js";
import { VcDmMemberTracking } from "./models/vc-dm-member-tracking.js";
import { VcDmMigration } from "./models/vc-dm-migration.js";
import { VcDmPanel } from "./models/vc-dm-panel.js";
import { VcDmReminder } from "./models/vc-dm-reminder.js";

function requireMongo(message) {
  if (mongoose.connection.readyState !== 1) throw new Error(`MongoDB is unavailable; ${message}.`);
}

function cleanPatch(patch = {}) {
  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
}

function asLean(query) {
  return typeof query?.lean === "function" ? query.lean() : query;
}

export function buildVcDmParticipationUpdatePipeline(timestamp, { joinedAt = timestamp } = {}) {
  const cycleKey = `vc:${timestamp.toISOString()}`;
  return [
    {
      $set: {
        isMember: true,
        leftAt: null,
        joinedAt,
        trackingStartedAt: { $ifNull: ["$trackingStartedAt", joinedAt] },
        // Aggregation-pipeline upserts do not reliably apply Mongoose's
        // setDefaultsOnInsert.  Keep a rejoin-before-guildMemberAdd upsert
        // eligible for the 7-day claim explicitly.
        newDmStatus: { $ifNull: ["$newDmStatus", "pending"] },
        // This is intentionally a single update pipeline.  $ifNull covers
        // both legacy documents where the field is absent and documents
        // where it was explicitly stored as null.
        firstValidVcAt: { $ifNull: ["$firstValidVcAt", timestamp] },
        lastValidVcAt: timestamp,
        inactiveCycleKey: cycleKey,
        inactiveDmStatus: "pending",
        inactiveDmCycleKey: null,
        inactiveDmAttemptedAt: null,
        inactiveDmSentAt: null,
        inactiveDmTargetEventAt: null,
        inactiveDmLastResult: null,
        inactiveDmLastError: null,
        lastError: null,
        lastOperationalAt: timestamp,
      },
    },
    { $unset: ["inactiveDmRecordId"] },
  ];
}

export function buildVcDmParticipationRepairPipeline() {
  return [
    {
      $set: {
        firstValidVcAt: { $ifNull: ["$firstValidVcAt", "$lastValidVcAt"] },
        inactiveCycleKey: {
          $ifNull: [
            "$inactiveCycleKey",
            { $concat: ["vc:", { $toString: "$lastValidVcAt" }] },
          ],
        },
      },
    },
  ];
}

export async function upsertVcDmMember({ guildId, userId, joinedAt, now = new Date(), ...patch }) {
  requireMongo("VC DM member tracking cannot be saved");
  const timestamp = now instanceof Date ? now : new Date(now);
  const update = cleanPatch({
    ...patch,
    joinedAt,
    isMember: patch.isMember ?? true,
    trackingStartedAt: patch.trackingStartedAt ?? timestamp,
    lastOperationalAt: timestamp,
  });
  return asLean(VcDmMemberTracking.findOneAndUpdate(
    { guildId, userId },
    { $set: update, $setOnInsert: { guildId, userId, joinedAt, trackingStartedAt: timestamp, newDmStatus: "pending", inactiveDmStatus: "pending" } },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
  ));
}

export async function markVcDmMemberJoined({ guildId, userId, joinedAt, now = new Date() }) {
  requireMongo("VC DM member join cannot be saved");
  const timestamp = now instanceof Date ? now : new Date(now);
  const existing = await asLean(VcDmMemberTracking.findOne({ guildId, userId }));
  const resetNewAfterLeft = existing?.isMember === false
    && existing.newDmStatus === "skipped_left"
    && !existing.newDmSentAt;
  const resetInactiveAfterLeft = existing?.isMember === false
    && existing.inactiveDmStatus === "skipped_left"
    && !existing.inactiveDmSentAt;
  const set = {
    joinedAt,
    isMember: true,
    rejoinedAt: timestamp,
    leftAt: null,
    lastOperationalAt: timestamp,
    ...(resetNewAfterLeft ? {
      newDmStatus: "pending",
      newDmAttemptedAt: null,
      newDmTargetEventAt: null,
      newDmLastResult: null,
      newDmLastError: null,
    } : {}),
    ...(resetInactiveAfterLeft ? {
      inactiveDmStatus: "pending",
      inactiveDmAttemptedAt: null,
      inactiveDmTargetEventAt: null,
      inactiveDmLastResult: null,
      inactiveDmLastError: null,
    } : {}),
  };
  const unset = {
    ...(resetNewAfterLeft ? { newDmRecordId: 1 } : {}),
    ...(resetInactiveAfterLeft ? { inactiveDmRecordId: 1 } : {}),
  };
  const filter = { guildId, userId };
  const update = {
    $set: set,
    ...(Object.keys(unset).length ? { $unset: unset } : {}),
    $setOnInsert: {
      guildId,
      userId,
      trackingStartedAt: timestamp,
      newDmStatus: "pending",
      inactiveDmStatus: "pending",
    },
  };
  try {
    return await asLean(VcDmMemberTracking.findOneAndUpdate(
      filter,
      update,
      { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
    ));
  } catch (error) {
    if (error?.code !== 11000) throw error;
    return asLean(VcDmMemberTracking.findOneAndUpdate(
      filter,
      { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}) },
      { returnDocument: "after" },
    ));
  }
}

export async function markVcDmMemberLeft({ guildId, userId, leftAt = new Date() }) {
  requireMongo("VC DM member leave cannot be saved");
  const update = {
    isMember: false,
    leftAt,
    lastOperationalAt: leftAt,
  };
  return asLean(VcDmMemberTracking.findOneAndUpdate(
    { guildId, userId },
    { $set: update },
    { returnDocument: "after" },
  ));
}

export async function recordValidVcParticipation({ guildId, userId, validAt = new Date(), joinedAt = null }) {
  requireMongo("valid VC participation cannot be saved");
  const timestamp = validAt instanceof Date ? validAt : new Date(validAt);
  const joinedTimestamp = joinedAt instanceof Date ? joinedAt : new Date(joinedAt ?? timestamp);
  const safeJoinedAt = Number.isFinite(joinedTimestamp.getTime()) ? joinedTimestamp : timestamp;
  try {
    return await asLean(VcDmMemberTracking.findOneAndUpdate(
      { guildId, userId },
      buildVcDmParticipationUpdatePipeline(timestamp, { joinedAt: safeJoinedAt }),
      { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
    ));
  } catch (error) {
    if (error?.code !== 11000) throw error;
    return await asLean(VcDmMemberTracking.findOneAndUpdate(
      { guildId, userId },
      buildVcDmParticipationUpdatePipeline(timestamp, { joinedAt: safeJoinedAt }),
      { returnDocument: "after" },
    ));
  }
}

export async function repairVcDmParticipationRecords({ guildId } = {}) {
  requireMongo("legacy VC participation records cannot be repaired");
  return VcDmMemberTracking.updateMany(
    {
      ...(guildId ? { guildId } : {}),
      lastValidVcAt: { $type: "date" },
      $or: [
        { firstValidVcAt: { $exists: false } },
        { firstValidVcAt: null },
      ],
    },
    buildVcDmParticipationRepairPipeline(),
  );
}

export async function listVcDmMembers(guildId, filter = {}, sort = null) {
  requireMongo("VC DM member tracking cannot be read");
  let query = VcDmMemberTracking.find({ guildId, ...filter });
  if (sort && typeof query.sort === "function") query = query.sort(sort);
  return asLean(query);
}

export async function getVcDmMember(guildId, userId) {
  requireMongo("VC DM member tracking cannot be read");
  return asLean(VcDmMemberTracking.findOne({ guildId, userId }));
}

export async function getVcDmMemberByDmRecordId(recordId) {
  requireMongo("VC DM member tracking cannot be read");
  return asLean(VcDmMemberTracking.findOne({ $or: [{ newDmRecordId: recordId }, { inactiveDmRecordId: recordId }] }));
}

export async function claimNewVcDm({ guildId, userId, targetEventAt, recordId, now = new Date() }) {
  requireMongo("new-member DM cannot be claimed");
  const timestamp = now instanceof Date ? now : new Date(now);
  return asLean(VcDmMemberTracking.findOneAndUpdate(
    {
      guildId,
      userId,
      isMember: true,
      firstValidVcAt: null,
      lastValidVcAt: null,
      manualValidVcConfirmedAt: null,
      newDmStatus: { $in: ["pending", "failed"] },
    },
    {
      $set: {
        newDmStatus: "processing",
        newDmAttemptedAt: timestamp,
        newDmTargetEventAt: targetEventAt,
        newDmRecordId: recordId,
        newDmLastError: null,
        lastOperationalAt: timestamp,
      },
    },
    { returnDocument: "after" },
  ));
}

export async function claimInactiveVcDm({ guildId, userId, cycleKey, targetEventAt, recordId, now = new Date() }) {
  requireMongo("inactive-member DM cannot be claimed");
  const timestamp = now instanceof Date ? now : new Date(now);
  return asLean(VcDmMemberTracking.findOneAndUpdate(
    {
      guildId,
      userId,
      isMember: true,
      inactiveCycleKey: cycleKey,
      inactiveDmStatus: { $in: ["pending", "failed"] },
    },
    {
      $set: {
        inactiveDmStatus: "processing",
        inactiveDmCycleKey: cycleKey,
        inactiveDmAttemptedAt: timestamp,
        inactiveDmTargetEventAt: targetEventAt,
        inactiveDmRecordId: recordId,
        inactiveDmLastError: null,
        lastOperationalAt: timestamp,
      },
    },
    { returnDocument: "after" },
  ));
}

export async function updateNewVcDmResult({ guildId, userId, recordId, status, now = new Date(), lastError = null, result = status }) {
  requireMongo("new-member DM result cannot be saved");
  const timestamp = now instanceof Date ? now : new Date(now);
  return asLean(VcDmMemberTracking.findOneAndUpdate(
    { guildId, userId, newDmRecordId: recordId, newDmStatus: "processing" },
    {
      $set: cleanPatch({
        newDmStatus: status,
        newDmLastResult: result,
        newDmLastError: lastError,
        lastError,
        lastOperationalAt: timestamp,
        ...(status === "delivered" ? { newDmSentAt: timestamp } : {}),
      }),
    },
    { returnDocument: "after" },
  ));
}

export async function updateInactiveVcDmResult({ guildId, userId, recordId, cycleKey, status, now = new Date(), lastError = null, result = status }) {
  requireMongo("inactive-member DM result cannot be saved");
  const timestamp = now instanceof Date ? now : new Date(now);
  return asLean(VcDmMemberTracking.findOneAndUpdate(
    { guildId, userId, inactiveDmRecordId: recordId, inactiveDmCycleKey: cycleKey, inactiveDmStatus: "processing" },
    {
      $set: cleanPatch({
        inactiveDmStatus: status,
        inactiveDmLastResult: result,
        inactiveDmLastError: lastError,
        lastError,
        lastOperationalAt: timestamp,
        ...(status === "delivered" ? { inactiveDmSentAt: timestamp } : {}),
      }),
    },
    { returnDocument: "after" },
  ));
}

export async function markNewVcDmUncertain({ guildId, userId, recordId, lastError, now = new Date() }) {
  return updateNewVcDmResult({ guildId, userId, recordId, status: "unconfirmed", lastError, result: "unconfirmed", now });
}

export async function markInactiveVcDmUncertain({ guildId, userId, recordId, cycleKey, lastError, now = new Date() }) {
  return updateInactiveVcDmResult({ guildId, userId, recordId, cycleKey, status: "unconfirmed", lastError, result: "unconfirmed", now });
}

export async function setManualVcParticipationConfirmation({ guildId, userId, confirmedBy, confirmedAt = new Date(), confirmed, baselineAt }) {
  requireMongo("manual VC confirmation cannot be saved");
  const timestamp = confirmedAt instanceof Date ? confirmedAt : new Date(confirmedAt);
  const baselineTimestamp = baselineAt ? new Date(baselineAt) : timestamp;
  const safeBaselineTimestamp = Number.isFinite(baselineTimestamp.getTime()) ? baselineTimestamp : timestamp;
  const existing = await asLean(VcDmMemberTracking.findOne({ guildId, userId, isMember: true }));
  const participationTimestamp = [existing?.lastValidVcAt, existing?.firstValidVcAt]
    .map((value) => new Date(value))
    .find((value) => Number.isFinite(value.getTime()))
    ?? new Date(Number.NaN);
  const hasParticipation = Number.isFinite(participationTimestamp.getTime());
  const rebuildInactiveState = hasParticipation
    ? {
      inactiveCycleKey: `vc:${participationTimestamp.toISOString()}`,
      inactiveDmStatus: "pending",
      inactiveDmCycleKey: null,
      inactiveDmAttemptedAt: null,
      inactiveDmSentAt: null,
      inactiveDmTargetEventAt: null,
      inactiveDmLastResult: null,
      inactiveDmLastError: null,
    }
    : {
      inactiveCycleKey: null,
      inactiveDmStatus: "pending",
      inactiveDmCycleKey: null,
      inactiveDmAttemptedAt: null,
      inactiveDmSentAt: null,
      inactiveDmTargetEventAt: null,
      inactiveDmLastResult: null,
      inactiveDmLastError: null,
    };
  const legacyBaseline = !hasParticipation && confirmed && baselineAt
    ? {
      inactiveBaselineAt: safeBaselineTimestamp,
      legacyBaselineAt: safeBaselineTimestamp,
      inactiveCycleKey: `legacy:${safeBaselineTimestamp.toISOString()}`,
    }
    : {};
  const newDmState = confirmed
    ? { newDmStatus: "skipped_manual", newDmLastResult: "admin_confirmation", newDmLastError: null }
    : hasParticipation
      ? { newDmStatus: "skipped_participated", newDmLastResult: "valid_vc_participation", newDmLastError: null }
      : { newDmStatus: "pending", newDmLastResult: null, newDmLastError: null };
  const unset = {
    ...(confirmed && !hasParticipation && baselineAt ? {} : { inactiveBaselineAt: 1, legacyBaselineAt: 1 }),
    inactiveDmRecordId: 1,
  };
  return asLean(VcDmMemberTracking.findOneAndUpdate(
    { guildId, userId, isMember: true },
    {
      $set: confirmed
        ? {
          manualValidVcConfirmedAt: timestamp,
          confirmedBy,
          confirmationReason: "admin_confirmation",
          ...newDmState,
          ...rebuildInactiveState,
          ...legacyBaseline,
          lastOperationalAt: timestamp,
        }
        : {
          manualValidVcConfirmedAt: null,
          confirmedBy: null,
          confirmationReason: null,
          ...newDmState,
          ...rebuildInactiveState,
          lastOperationalAt: timestamp,
        },
      $unset: unset,
    },
    { returnDocument: "after" },
  ));
}

export async function claimVcDmDailyRun({ guildId, jstDate, now = new Date(), takeover = false, retryFailed = false }) {
  requireMongo("daily VC DM run cannot be claimed");
  const timestamp = now instanceof Date ? now : new Date(now);
  const retryableStatuses = retryFailed
    ? ["pending", "failed", "stopped", "completed"]
    : ["pending", "failed", "stopped"];
  try {
    const run = await asLean(VcDmDailyRun.findOneAndUpdate(
      {
        guildId,
        jstDate,
        ...(takeover
          ? { $or: [{ status: { $in: retryableStatuses } }, { status: "processing" }] }
          : { status: { $in: retryableStatuses } }),
      },
      { $set: { status: "processing", startedAt: timestamp, lastError: null } },
      { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
    ));
    if (run) return run;
  } catch (error) {
    if (error?.code !== 11000) throw error;
  }
  return asLean(VcDmDailyRun.findOne({ guildId, jstDate }));
}

export async function recordVcDmDailyRunResult({ guildId, jstDate, status, result = {}, error = null, now = new Date() }) {
  requireMongo("daily VC DM run result cannot be saved");
  const timestamp = now instanceof Date ? now : new Date(now);
  return asLean(VcDmDailyRun.findOneAndUpdate(
    { guildId, jstDate },
    {
      $set: {
        status,
        completedAt: timestamp,
        result,
        lastError: error ? String(error?.message ?? error) : null,
      },
      $setOnInsert: { guildId, jstDate },
    },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
  ));
}

export async function stopVcDmDailyRun({ guildId, jstDate, reason, result = {}, now = new Date() }) {
  requireMongo("daily VC DM run stop result cannot be saved");
  const timestamp = now instanceof Date ? now : new Date(now);
  return asLean(VcDmDailyRun.findOneAndUpdate(
    { guildId, jstDate, status: "processing" },
    {
      $set: {
        status: "stopped",
        completedAt: timestamp,
        result: { ...result, stopped: true, stopReason: reason },
        lastError: reason,
      },
    },
    { returnDocument: "after" },
  ));
}

export async function finishVcDmDailyRun({ guildId, jstDate, result = {}, now = new Date() }) {
  requireMongo("daily VC DM run result cannot be saved");
  return asLean(VcDmDailyRun.findOneAndUpdate(
    { guildId, jstDate, status: "processing" },
    { $set: { status: "completed", completedAt: now, result, lastError: null } },
    { returnDocument: "after" },
  ));
}

export async function failVcDmDailyRun({ guildId, jstDate, error, now = new Date() }) {
  requireMongo("daily VC DM run failure cannot be saved");
  return asLean(VcDmDailyRun.findOneAndUpdate(
    { guildId, jstDate, status: "processing" },
    { $set: { status: "failed", lastError: String(error?.message ?? error), completedAt: now } },
    { returnDocument: "after" },
  ));
}

export async function getVcDmDailyRun(guildId, jstDate) {
  requireMongo("daily VC DM run cannot be read");
  return asLean(VcDmDailyRun.findOne({ guildId, jstDate }));
}

export async function beginVcDmMigration({ guildId, implementationAt = new Date(), version = 1 }) {
  requireMongo("VC DM migration cannot be started");
  const existing = await asLean(VcDmMigration.findOne({ guildId }));
  if (existing?.status === "completed" && existing.version >= version) return { state: existing, started: false };
  const state = await asLean(VcDmMigration.findOneAndUpdate(
    { guildId },
    {
      $set: { version, status: "processing", implementationAt: existing?.implementationAt ?? implementationAt, initializedAt: existing?.initializedAt ?? new Date(), lastError: null },
      $setOnInsert: { guildId, processedCount: 0 },
    },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
  ));
  return { state, started: true };
}

export async function updateVcDmMigrationProgress({ guildId, processedCount, lastUserId }) {
  requireMongo("VC DM migration progress cannot be saved");
  return asLean(VcDmMigration.findOneAndUpdate(
    { guildId },
    { $set: { processedCount, lastUserId } },
    { returnDocument: "after" },
  ));
}

export async function finishVcDmMigration({ guildId, version = 1, completedAt = new Date() }) {
  requireMongo("VC DM migration completion cannot be saved");
  return asLean(VcDmMigration.findOneAndUpdate(
    { guildId },
    { $set: { version, status: "completed", completedAt, lastError: null } },
    { returnDocument: "after" },
  ));
}

export async function failVcDmMigration({ guildId, error }) {
  requireMongo("VC DM migration failure cannot be saved");
  return asLean(VcDmMigration.findOneAndUpdate(
    { guildId },
    { $set: { status: "failed", lastError: String(error?.message ?? error) } },
    { returnDocument: "after" },
  ));
}

export async function getVcDmMigration(guildId) {
  requireMongo("VC DM migration cannot be read");
  return asLean(VcDmMigration.findOne({ guildId }));
}

export async function findOrCreateVcDmReminder({ guildId, userId, targetEventAt, sourceDmType, sourceDmRecordId, remindAt, recordId, now = new Date() }) {
  requireMongo("VC DM reminder cannot be saved");
  const existing = await asLean(VcDmReminder.findOne({ guildId, userId, targetEventAt }));
  if (existing && ["pending", "processing", "sent", "canceled", "dm_unavailable", "unconfirmed"].includes(existing.status)) return existing;
  try {
    return await asLean(VcDmReminder.findOneAndUpdate(
      { guildId, userId, targetEventAt },
      {
        $set: {
          sourceDmType,
          sourceDmRecordId,
          remindAt,
          status: "pending",
          lastError: null,
          canceledAt: null,
          leaseUntil: null,
          processingAt: null,
        },
        $setOnInsert: { recordId, guildId, userId, targetEventAt, attemptCount: 0 },
      },
      { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
    ));
  } catch (error) {
    if (error?.code !== 11000) throw error;
    return asLean(VcDmReminder.findOne({ guildId, userId, targetEventAt }));
  }
}

export async function getVcDmReminderByRecordId(recordId) {
  requireMongo("VC DM reminder cannot be read");
  return asLean(VcDmReminder.findOne({ recordId }));
}

export async function getVcDmReminderBySourceRecordId(sourceDmRecordId) {
  requireMongo("VC DM reminder cannot be read");
  return asLean(VcDmReminder.findOne({ sourceDmRecordId }).sort({ createdAt: -1 }));
}

export async function claimVcDmReminder({ recordId, now = new Date(), leaseMs = 120_000 }) {
  requireMongo("VC DM reminder cannot be claimed");
  const timestamp = now instanceof Date ? now : new Date(now);
  return asLean(VcDmReminder.findOneAndUpdate(
    {
      recordId,
      targetEventAt: { $gt: timestamp },
      $or: [
        { status: { $in: ["pending", "failed"] } },
        { status: "processing", leaseUntil: { $lte: timestamp } },
      ],
    },
    { $set: { status: "processing", processingAt: timestamp, leaseUntil: new Date(timestamp.getTime() + leaseMs) }, $inc: { attemptCount: 1 } },
    { returnDocument: "after" },
  ));
}

export async function claimVcDmReminderConfirmation({ recordId, now = new Date(), leaseMs = 120_000 }) {
  requireMongo("VC DM reminder confirmation cannot be claimed");
  const timestamp = now instanceof Date ? now : new Date(now);
  return asLean(VcDmReminder.findOneAndUpdate(
    {
      recordId,
      status: { $in: ["pending", "failed"] },
      $and: [
        { $or: [{ confirmationMessageId: { $exists: false } }, { confirmationMessageId: null }] },
        { $or: [
          { confirmationLeaseUntil: { $exists: false } },
          { confirmationLeaseUntil: null },
          { confirmationLeaseUntil: { $lte: timestamp } },
        ] },
      ],
    },
    { $set: { confirmationLeaseUntil: new Date(timestamp.getTime() + leaseMs) } },
    { returnDocument: "after" },
  ));
}

export async function recoverVcDmReminders(now = new Date()) {
  requireMongo("VC DM reminder recovery cannot run");
  // A restart is the process-boundary signal: a processing record owned by
  // the previous process is never safe to retry automatically after a DM
  // send may have happened.
  return VcDmReminder.updateMany(
    { status: "processing" },
    { $set: { status: "unconfirmed", leaseUntil: null, lastError: "Reminder send result was uncertain after process restart; automatic retry was disabled." } },
  );
}

export async function recoverVcDmMemberDmProcessing(now = new Date()) {
  requireMongo("VC DM processing recovery cannot run");
  const timestamp = now instanceof Date ? now : new Date(now);
  const lastError = "DM send result was uncertain after process restart; automatic retry was disabled.";
  // Do not wait for a lease timeout here: the current process cannot prove
  // that a previous process did not already send the DM.
  const [newResult, inactiveResult] = await Promise.all([
    VcDmMemberTracking.updateMany(
      { newDmStatus: "processing" },
      { $set: { newDmStatus: "unconfirmed", newDmLastResult: "unconfirmed", newDmLastError: lastError, lastError, lastOperationalAt: timestamp } },
    ),
    VcDmMemberTracking.updateMany(
      { inactiveDmStatus: "processing" },
      { $set: { inactiveDmStatus: "unconfirmed", inactiveDmLastResult: "unconfirmed", inactiveDmLastError: lastError, lastError, lastOperationalAt: timestamp } },
    ),
  ]);
  return { newResult, inactiveResult };
}

export async function getVcDmUnconfirmedSummary(guildId) {
  requireMongo("VC DM uncertain state cannot be read");
  const [memberCount, reminderCount] = await Promise.all([
    VcDmMemberTracking.countDocuments({ guildId, $or: [{ newDmStatus: "unconfirmed" }, { inactiveDmStatus: "unconfirmed" }] }),
    VcDmReminder.countDocuments({ guildId, status: "unconfirmed" }),
  ]);
  return { memberCount, reminderCount, total: memberCount + reminderCount };
}

export async function getVcDmResultSummary(guildId) {
  requireMongo("VC DM result summary cannot be read");
  const [memberRows, reminderRows] = await Promise.all([
    VcDmMemberTracking.aggregate([
      { $match: { guildId } },
      { $project: { statuses: ["$newDmStatus", "$inactiveDmStatus"] } },
      { $unwind: "$statuses" },
      { $group: { _id: "$statuses", count: { $sum: 1 } } },
    ]),
    VcDmReminder.aggregate([
      { $match: { guildId } },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]),
  ]);
  const toCounts = (rows) => Object.fromEntries(rows.map((row) => [row._id, row.count]));
  const member = toCounts(memberRows);
  const reminders = toCounts(reminderRows);
  return {
    member,
    reminders,
    delivered: (member.delivered ?? 0) + (reminders.sent ?? 0),
    dm_unavailable: (member.dm_unavailable ?? 0) + (reminders.dm_unavailable ?? 0),
    failed: (member.failed ?? 0) + (reminders.failed ?? 0),
    unconfirmed: (member.unconfirmed ?? 0) + (reminders.unconfirmed ?? 0),
  };
}

export async function setVcDmReminderStatus({ recordId, status, now = new Date(), lastError = null }) {
  requireMongo("VC DM reminder result cannot be saved");
  return asLean(VcDmReminder.findOneAndUpdate(
    { recordId, status: "processing" },
    {
      $set: cleanPatch({
        status,
        lastError,
        leaseUntil: null,
        sentAt: status === "sent" ? now : undefined,
        canceledAt: status === "canceled" ? now : undefined,
      }),
    },
    { returnDocument: "after" },
  ));
}

export async function rescheduleVcDmReminder({ recordId, remindAt, lastError = null }) {
  requireMongo("VC DM reminder retry schedule cannot be saved");
  return asLean(VcDmReminder.findOneAndUpdate(
    { recordId, status: { $in: ["pending", "failed"] } },
    { $set: cleanPatch({ status: "failed", remindAt, lastError }) },
    { returnDocument: "after" },
  ));
}

export async function rescheduleVcDmReminderTarget({ recordId, targetEventAt, remindAt, lastError = null }) {
  requireMongo("VC DM reminder target update cannot be saved");
  return asLean(VcDmReminder.findOneAndUpdate(
    { recordId, status: { $in: ["pending", "failed"] } },
    { $set: cleanPatch({ targetEventAt, remindAt, lastError }) },
    { returnDocument: "after" },
  ));
}

export async function saveVcDmReminderConfirmation({ recordId, channelId, confirmationMessageId }) {
  requireMongo("VC DM reminder confirmation cannot be saved");
  return asLean(VcDmReminder.findOneAndUpdate(
    { recordId },
    { $set: cleanPatch({ channelId, confirmationMessageId, confirmationLeaseUntil: null }) },
    { returnDocument: "after" },
  ));
}

export async function cancelVcDmReminder({ recordId, userId, now = new Date() }) {
  requireMongo("VC DM reminder cancellation cannot be saved");
  return asLean(VcDmReminder.findOneAndUpdate(
    { recordId, userId, status: { $in: ["pending", "failed"] }, targetEventAt: { $gt: now } },
    { $set: { status: "canceled", canceledAt: now, leaseUntil: null, lastError: null } },
    { returnDocument: "after" },
  ));
}

export async function getVcDmPanel(guildId) {
  requireMongo("VC DM panel cannot be read");
  return asLean(VcDmPanel.findOne({ guildId }));
}

export async function deleteVcDmPanel({ guildId }) {
  requireMongo("VC DM panel reference cannot be cleared");
  return asLean(VcDmPanel.findOneAndDelete({ guildId }));
}

export async function saveVcDmPanel({ guildId, channelId, messageIds, recordId, marker, lastRenderedHash, lastUpdatedAt = new Date(), lastError = null }) {
  requireMongo("VC DM panel cannot be saved");
  return asLean(VcDmPanel.findOneAndUpdate(
    { guildId },
    { $set: cleanPatch({ channelId, messageIds, recordId, marker, lastRenderedHash, lastUpdatedAt, lastError }), $setOnInsert: { guildId } },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
  ));
}

export async function getActiveVcDmReminders(guildId) {
  requireMongo("VC DM reminders cannot be read");
  return asLean(VcDmReminder.find({ guildId, status: { $in: ["pending", "processing", "failed"] } }).sort({ remindAt: 1 }));
}

export {
  VcDmDailyRun,
  VcDmMemberTracking,
  VcDmMigration,
  VcDmPanel,
  VcDmReminder,
};
