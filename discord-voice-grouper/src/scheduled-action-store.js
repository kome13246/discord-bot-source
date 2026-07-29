import mongoose from "mongoose";
import { ScheduledAction } from "./models/scheduled-action.js";

export async function scheduleAction(action) {
  if (mongoose.connection.readyState !== 1) throw new Error("MongoDB is required to schedule persistent actions.");
  return ScheduledAction.findOneAndUpdate(
    { actionKey: action.actionKey },
    { $setOnInsert: { ...action, status: "pending", attempts: 0 } },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true, lean: true },
  );
}

/**
 * Schedule a single durable action for a guild/type pair.  A pending action
 * is moved to the new time; a running one is left alone because its owner is
 * already evaluating the same follow-up.  The partial unique index makes the
 * create branch safe across bot processes.
 */
export async function scheduleSingleGuildAction(action) {
  if (mongoose.connection.readyState !== 1) throw new Error("MongoDB is required to schedule persistent actions.");

  const pending = await ScheduledAction.findOneAndUpdate(
    { guildId: action.guildId, type: action.type, status: "pending" },
    { $set: { executeAt: action.executeAt, payload: action.payload ?? {} } },
    { returnDocument: "after", lean: true },
  );
  if (pending) return { action: pending, scheduled: true };

  const running = await ScheduledAction.findOne({
    guildId: action.guildId,
    type: action.type,
    status: "running",
  }).lean();
  if (running) return { action: running, scheduled: false };

  try {
    const created = await ScheduledAction.create({
      ...action,
      status: "pending",
      attempts: 0,
    });
    return { action: created.toObject(), scheduled: true };
  } catch (error) {
    // A competing process may have created the partial-unique action between
    // the query and create.  Re-read it instead of creating a second timer.
    if (error?.code !== 11000) throw error;
    const existing = await ScheduledAction.findOne({
      guildId: action.guildId,
      type: action.type,
      status: { $in: ["pending", "running"] },
    }).lean();
    if (!existing) throw error;
    return { action: existing, scheduled: existing.status === "pending" };
  }
}

export async function reschedulePendingAction(actionKey, executeAt) {
  if (mongoose.connection.readyState !== 1) throw new Error("MongoDB is required to reschedule persistent actions.");
  return ScheduledAction.findOneAndUpdate(
    { actionKey, status: "pending" },
    { $set: { executeAt } },
    { returnDocument: "after", lean: true },
  );
}

export async function claimAction(actionKey) {
  return ScheduledAction.findOneAndUpdate(
    { actionKey, status: "pending" },
    { $set: { status: "running", startedAt: new Date() }, $inc: { attempts: 1 } },
    { returnDocument: "after", lean: true },
  );
}

export async function finishAction(actionKey, status = "completed", lastError) {
  const fields = { status };
  if (status === "completed") fields.completedAt = new Date();
  if (lastError) fields.lastError = lastError;
  return ScheduledAction.findOneAndUpdate(
    { actionKey, status: "running" },
    { $set: fields },
    { returnDocument: "after", lean: true },
  );
}

export async function failAction(actionKey, lastError) {
  return ScheduledAction.findOneAndUpdate(
    { actionKey, status: { $in: ["pending", "running"] } },
    { $set: { status: "failed", lastError } },
    { returnDocument: "after", lean: true },
  );
}

/**
 * Return a claimed action to the durable queue after a transient failure.
 * Keeping it pending, rather than failed, lets startup restoration and the
 * caller's retry timer continue the workflow after a Discord/Mongo outage.
 */
export async function retryAction(actionKey, { executeAt, lastError }) {
  if (mongoose.connection.readyState !== 1) throw new Error("MongoDB is required to retry persistent actions.");
  return ScheduledAction.findOneAndUpdate(
    { actionKey, status: "running" },
    {
      $set: { status: "pending", executeAt, lastError },
      $unset: { startedAt: 1 },
    },
    { returnDocument: "after", lean: true },
  );
}

export async function getPendingActions() {
  if (mongoose.connection.readyState !== 1) throw new Error("MongoDB is required to restore persistent actions.");
  return ScheduledAction.find({ status: "pending" }).lean();
}

/** Cancels only pending/failed actions belonging to one kokuchi event. */
export async function cancelKokuchiScheduledActions({ guildId, kokuchiEventId }) {
  if (mongoose.connection.readyState !== 1) throw new Error("MongoDB is required to cancel persistent actions.");
  const actions = await ScheduledAction.find({ guildId, "payload.kokuchiEventId": kokuchiEventId }).lean();
  const result = { canceled: 0, alreadyCompleted: 0, alreadyCanceled: 0, failed: 0, errors: [] };

  for (const action of actions) {
    if (action.status === "canceled") {
      result.alreadyCanceled += 1;
      continue;
    }
    if (!["pending", "failed"].includes(action.status)) {
      result.alreadyCompleted += 1;
      continue;
    }
    const canceled = await ScheduledAction.findOneAndUpdate(
      { _id: action._id, status: { $in: ["pending", "failed"] } },
      { $set: { status: "canceled", completedAt: new Date() } },
      { returnDocument: "before", lean: true },
    );
    if (canceled) {
      result.canceled += 1;
      continue;
    }
    const current = await ScheduledAction.findById(action._id).lean();
    if (current?.status === "canceled") result.alreadyCanceled += 1;
    else if (current && !["pending", "failed"].includes(current.status)) result.alreadyCompleted += 1;
    else {
      result.failed += 1;
      result.errors.push(`ScheduledAction ${action.actionKey} could not be canceled.`);
    }
  }
  return result;
}

/**
 * The previous bot process is no longer alive when this runs during startup.
 * Return actions claimed by that process to the queue so they are not lost.
 */
export async function recoverInterruptedActions() {
  if (mongoose.connection.readyState !== 1) throw new Error("MongoDB is required to recover persistent actions.");
  return ScheduledAction.updateMany(
    { status: "running" },
    {
      $set: { status: "pending", lastError: "Recovered after process restart" },
      $unset: { startedAt: 1 },
    },
  );
}
