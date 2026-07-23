import mongoose from "mongoose";

const schema = new mongoose.Schema(
  {
    actionKey: { type: String, required: true, unique: true },
    guildId: { type: String, required: true },
    type: { type: String, required: true },
    executeAt: { type: Date, required: true },
    status: { type: String, enum: ["pending", "running", "completed", "failed"], default: "pending" },
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
schema.index({ completedAt: 1 }, { expireAfterSeconds: 7 * 24 * 60 * 60, partialFilterExpression: { status: "completed" } });

export const ScheduledAction = mongoose.models.ScheduledAction ?? mongoose.model("ScheduledAction", schema);
