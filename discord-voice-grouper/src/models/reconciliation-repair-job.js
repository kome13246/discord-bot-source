import mongoose from "mongoose";

export const REPAIR_ACTION_KEYS = Object.freeze([
  "status_board.ensure",
  "profile_panel.ensure",
  "otebo_panel.ensure",
  "voice_control_panels.ensure",
]);

export const REPAIR_JOB_STATUSES = Object.freeze([
  "pending",
  "processing",
  "applied",
  "retry_wait",
  "blocked",
  "superseded",
  "no_longer_needed",
  "circuit_open",
  "failed",
]);

const evidenceSchema = new mongoose.Schema({
  key: { type: String, required: true, maxlength: 120 },
  reason: { type: String, required: true, maxlength: 500 },
  evidenceStatus: { type: String, enum: ["warning", "error"], required: true },
  source: { type: String, enum: ["validation", "operational"], required: true },
  code: { type: String, default: null, maxlength: 120 },
  checkKey: { type: String, default: null, maxlength: 160 },
}, { _id: false, strict: true, minimize: true });

const resultSchema = new mongoose.Schema({
  status: { type: String, maxlength: 80 },
  reason: { type: String, maxlength: 500 },
  detail: { type: String, maxlength: 500, default: null },
}, { _id: false, strict: true, minimize: true });

const schema = new mongoose.Schema({
  guildId: { type: String, required: true },
  observationRunId: { type: String, required: true, maxlength: 100 },
  actionKey: { type: String, enum: REPAIR_ACTION_KEYS, required: true },
  evidence: { type: evidenceSchema, required: true },
  status: { type: String, enum: REPAIR_JOB_STATUSES, required: true, default: "pending" },
  attemptCount: { type: Number, min: 0, default: 0 },
  maxAttempts: { type: Number, min: 1, default: 3 },
  leaseOwner: { type: String, default: null, maxlength: 160 },
  leaseId: { type: String, default: null, maxlength: 160 },
  fencingToken: { type: Number, min: 0, default: 0 },
  leaseExpiresAt: { type: Date, default: null },
  heartbeatAt: { type: Date, default: null },
  nextAttemptAt: { type: Date, default: null },
  lastError: { type: String, default: null, maxlength: 500 },
  result: { type: resultSchema, default: null },
  observedAt: { type: Date, default: null },
  manualRetryCount: { type: Number, min: 0, default: 0 },
  maxManualRetries: { type: Number, min: 0, default: 3 },
  appliedAt: { type: Date, default: null },
  blockedAt: { type: Date, default: null },
}, { strict: true, timestamps: true, minimize: false });

schema.index({ guildId: 1, observationRunId: 1, actionKey: 1 }, { unique: true });
schema.index(
  { guildId: 1, actionKey: 1 },
  {
    unique: true,
    partialFilterExpression: {
      status: { $in: ["pending", "processing", "retry_wait", "blocked", "circuit_open"] },
    },
  },
);
schema.index({ status: 1, nextAttemptAt: 1, leaseExpiresAt: 1 });
schema.index({ guildId: 1, createdAt: -1 });

export const ReconciliationRepairJob = mongoose.models.ReconciliationRepairJob
  ?? mongoose.model("ReconciliationRepairJob", schema);

export { evidenceSchema, resultSchema };
