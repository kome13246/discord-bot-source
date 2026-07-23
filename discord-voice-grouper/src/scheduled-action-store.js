import mongoose from "mongoose";
import { ScheduledAction } from "./models/scheduled-action.js";

export async function scheduleAction(action) {
  if (mongoose.connection.readyState !== 1) throw new Error("MongoDB is required to schedule persistent actions.");
  return ScheduledAction.findOneAndUpdate(
    { actionKey: action.actionKey },
    { $setOnInsert: { ...action, status: "pending", attempts: 0 } },
    { upsert: true, new: true, setDefaultsOnInsert: true, lean: true },
  );
}

export async function reschedulePendingAction(actionKey, executeAt) {
  if (mongoose.connection.readyState !== 1) throw new Error("MongoDB is required to reschedule persistent actions.");
  return ScheduledAction.findOneAndUpdate(
    { actionKey, status: "pending" },
    { $set: { executeAt } },
    { new: true, lean: true },
  );
}

export async function claimAction(actionKey) {
  return ScheduledAction.findOneAndUpdate(
    { actionKey, status: "pending" },
    { $set: { status: "running", startedAt: new Date() }, $inc: { attempts: 1 } },
    { new: true, lean: true },
  );
}

export async function finishAction(actionKey, status = "completed", lastError) {
  const fields = { status };
  if (status === "completed") fields.completedAt = new Date();
  if (lastError) fields.lastError = lastError;
  return ScheduledAction.findOneAndUpdate(
    { actionKey, status: "running" },
    { $set: fields },
    { new: true, lean: true },
  );
}

export async function failAction(actionKey, lastError) {
  return ScheduledAction.findOneAndUpdate(
    { actionKey, status: { $in: ["pending", "running"] } },
    { $set: { status: "failed", lastError } },
    { new: true, lean: true },
  );
}

export async function getPendingActions() {
  if (mongoose.connection.readyState !== 1) throw new Error("MongoDB is required to restore persistent actions.");
  return ScheduledAction.find({ status: "pending" }).lean();
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
