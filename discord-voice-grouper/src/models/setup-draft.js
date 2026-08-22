import mongoose from "mongoose";

export const SETUP_DRAFT_STATUSES = Object.freeze([
  "active",
  "committing",
  "completed",
  "cancelled",
  "expired",
]);

export const SETUP_DRAFT_FEATURES = Object.freeze([
  "splitvc",
  "kokuchi",
  "callwait",
  "vc_dm",
  "forms",
  "profile",
  "voice_control",
  "status_board",
  "fukyo",
]);

const schema = new mongoose.Schema(
  {
    sessionId: { type: String, required: true, unique: true },
    guildId: { type: String, required: true },
    actorUserId: { type: String, required: true },
    baseRevision: { type: Number, required: true, min: 0 },
    feature: { type: String, enum: [null, ...SETUP_DRAFT_FEATURES], default: null },
    step: { type: String, required: true, default: "feature" },
    // The setup service validates this object against both the feature schema
    // and ADMIN_CONFIGURATION_CATALOG before every write.  It never contains
    // runtime/lifecycle state or secrets.
    patch: { type: mongoose.Schema.Types.Mixed, default: {}, required: true },
    status: { type: String, enum: SETUP_DRAFT_STATUSES, default: "active", required: true },
    expiresAt: { type: Date, required: true },
    lastError: { type: String, default: null },
    committedRevision: { type: Number, default: null, min: 0 },
    completedAt: { type: Date, default: null },
    cancelledAt: { type: Date, default: null },
  },
  { strict: true, timestamps: true, minimize: false },
);

schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
schema.index(
  { guildId: 1 },
  {
    unique: true,
    partialFilterExpression: { status: { $in: ["active", "committing"] } },
  },
);
schema.index({ guildId: 1, status: 1, expiresAt: 1 });

export const GuildSetupDraft = mongoose.models.GuildSetupDraft
  ?? mongoose.model("GuildSetupDraft", schema);

// Alias kept for callers/tests that use the shorter domain name.
export const SetupDraft = GuildSetupDraft;
