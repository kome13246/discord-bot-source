import mongoose from "mongoose";

const schema = new mongoose.Schema(
  {
    guildId: { type: String, required: true },
    // The revision this job creates/applies. Keeping this separate from
    // targetRevision leaves room for future multi-step jobs, while the
    // unique pair prevents duplicate work for one revision.
    revision: { type: Number, required: true, min: 1 },
    targetRevision: { type: Number, required: true, min: 1 },
    jobType: { type: String, enum: ["update", "rollback"], required: true, default: "update" },
    changedKeys: { type: [String], default: [] },
    status: {
      type: String,
      enum: ["pending", "processing", "applied", "retry_wait", "failed", "superseded", "blocked"],
      default: "pending",
    },
    attemptCount: { type: Number, min: 0, default: 0 },
    // Manual retries are a separate, finite budget.  Resetting attemptCount
    // for a manual request starts a fresh automatic backoff cycle without
    // making the admin retry endpoint an unbounded escape hatch.
    manualRetryCount: { type: Number, min: 0, default: 0 },
    maxManualRetries: { type: Number, min: 0, default: 3 },
    nextAttemptAt: { type: Date, default: Date.now },
    leaseOwner: { type: String, default: null },
    leaseExpiresAt: { type: Date, default: null },
    lastError: { type: String, default: null },
    actorUserId: { type: String, default: null },
    source: { type: String, default: "unknown" },
    reason: { type: String, default: null },
    rollbackTargetRevision: { type: Number, default: null, min: 0 },
    appliedAt: { type: Date, default: null },
    failedAt: { type: Date, default: null },
  },
  { strict: true, timestamps: true, minimize: false },
);

schema.index({ guildId: 1, revision: 1 }, { unique: true });
schema.index({ status: 1, nextAttemptAt: 1, leaseExpiresAt: 1, createdAt: 1 });
schema.index({ guildId: 1, createdAt: -1 });

export const SettingsApplyJob =
  mongoose.models.SettingsApplyJob
  ?? mongoose.model("SettingsApplyJob", schema);
