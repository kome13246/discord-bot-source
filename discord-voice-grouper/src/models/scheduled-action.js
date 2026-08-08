import mongoose from "mongoose";

const schema = new mongoose.Schema(
  {
    actionKey: { type: String, required: true, unique: true },
    guildId: { type: String, required: true },
    type: { type: String, required: true },
    executeAt: { type: Date, required: true },
    status: { type: String, enum: ["pending", "running", "completed", "failed", "canceled"], default: "pending" },
    roleId: String,
    memberIds: { type: [String], default: [] },
    payload: { type: mongoose.Schema.Types.Mixed, default: {} },
    attempts: { type: Number, default: 0 },
    lastError: String,
    startedAt: Date,
    completedAt: Date,
  },
  { timestamps: true },
);

schema.index({ status: 1, executeAt: 1 });
schema.index({ guildId: 1, status: 1, executeAt: 1 });
schema.index({ guildId: 1, status: 1, updatedAt: -1 });
// At most one pending/running follow-up is allowed per guild.  Completed
// actions remain as history, while a later successful recruitment can create
// the next follow-up action.
schema.index(
  { guildId: 1, type: 1 },
  {
    unique: true,
    partialFilterExpression: {
      type: "callwait_followup",
      status: { $in: ["pending", "running"] },
    },
  },
);
schema.index({ completedAt: 1 }, { expireAfterSeconds: 7 * 24 * 60 * 60, partialFilterExpression: { status: "completed" } });
schema.index({ updatedAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60, partialFilterExpression: { status: { $in: ["failed", "canceled"] } } });

export const ScheduledAction = mongoose.models.ScheduledAction ?? mongoose.model("ScheduledAction", schema);
