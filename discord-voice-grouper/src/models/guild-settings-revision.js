import mongoose from "mongoose";

const schema = new mongoose.Schema(
  {
    guildId: { type: String, required: true },
    revision: { type: Number, required: true, min: 1 },
    baseRevision: { type: Number, required: true, min: 0 },
    schemaVersion: { type: Number, required: true },
    // `snapshot` and `changes` are generated exclusively from the
    // allowlisted configuration catalog.  Runtime/lifecycle state must never
    // be copied here.
    snapshot: { type: mongoose.Schema.Types.Mixed, required: true, default: {} },
    changes: { type: mongoose.Schema.Types.Mixed, required: true, default: {} },
    actorUserId: { type: String, default: null },
    source: { type: String, required: true, default: "unknown" },
    reason: { type: String, default: null },
    jobType: { type: String, enum: ["update", "rollback"], default: "update" },
    rollbackTargetRevision: { type: Number, default: null, min: 0 },
    createdAt: { type: Date, required: true, default: Date.now },
  },
  { strict: true, timestamps: false, minimize: false },
);

schema.index({ guildId: 1, revision: 1 }, { unique: true });
schema.index({ guildId: 1, createdAt: -1 });

export const GuildSettingsRevision =
  mongoose.models.GuildSettingsRevision
  ?? mongoose.model("GuildSettingsRevision", schema);
