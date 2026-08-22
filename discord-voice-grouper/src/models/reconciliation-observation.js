import mongoose from "mongoose";

const candidateSchema = new mongoose.Schema({
  key: { type: String, required: true, maxlength: 120 },
  reason: { type: String, required: true, maxlength: 500 },
  evidenceStatus: {
    type: String,
    enum: ["warning", "error"],
    required: true,
  },
  safe: { type: Boolean, default: false },
  requiresApplyJob: { type: Boolean, default: true },
  evidence: {
    source: { type: String, enum: ["validation", "operational"], required: true },
    code: { type: String, default: null, maxlength: 120 },
    checkKey: { type: String, default: null, maxlength: 160 },
  },
}, { _id: false, strict: true, minimize: true });

const countSchema = new mongoose.Schema({
  healthy: { type: Number, min: 0, default: 0 },
  warning: { type: Number, min: 0, default: 0 },
  error: { type: Number, min: 0, default: 0 },
  unknown: { type: Number, min: 0, default: 0 },
}, { _id: false, strict: true, minimize: true });

/**
 * The latest read-only reconciliation result for one guild.  This document
 * intentionally contains aggregate statuses and bounded evidence only: no
 * GuildSettings snapshot, secrets, member identifiers, or message bodies are
 * persisted here.
 */
const schema = new mongoose.Schema({
  guildId: { type: String, required: true, unique: true },
  runId: { type: String, required: true, maxlength: 80 },
  status: {
    type: String,
    enum: ["healthy", "warning", "error", "unknown", "failed"],
    required: true,
  },
  startedAt: { type: Date, required: true },
  completedAt: { type: Date, default: null },
  durationMs: { type: Number, min: 0, default: null },
  validationCounts: { type: countSchema, default: () => ({}) },
  operationalSeverity: {
    type: String,
    enum: ["healthy", "warning", "error", "unknown", "disabled", "info"],
    default: "unknown",
  },
  operationalCounts: { type: countSchema, default: () => ({}) },
  candidates: { type: [candidateSchema], default: [] },
  consecutiveFailures: { type: Number, min: 0, default: 0 },
  lastError: { type: String, default: null, maxlength: 500 },
  nextRunAt: { type: Date, default: null },
  schemaVersion: { type: Number, required: true, min: 1, default: 1 },
}, { strict: true, timestamps: true, minimize: false });

schema.index({ nextRunAt: 1, status: 1 });
schema.index({ status: 1, completedAt: -1 });

export const ReconciliationObservation = mongoose.models.ReconciliationObservation
  ?? mongoose.model("ReconciliationObservation", schema);

export { candidateSchema, countSchema };
