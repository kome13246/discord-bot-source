import mongoose from "mongoose";

const schema = new mongoose.Schema(
  {
    guildId: { type: String, required: true },
    roleId: { type: String, required: true },
    generationId: { type: String, required: true },
    sourceType: { type: String, required: true },
    sourceId: { type: String, required: true },
    memberIds: { type: [String], default: [] },
    executeAt: { type: Date, required: true },
    status: { type: String, enum: ["scheduled", "executing", "completed", "superseded", "failed"], default: "scheduled" },
    grantedAt: { type: Date, default: Date.now },
    completedAt: { type: Date, default: null },
    supersededAt: { type: Date, default: null },
    lastError: { type: String, default: null },
  },
  { timestamps: true },
);

schema.index({ guildId: 1, roleId: 1, generationId: 1 }, { unique: true });
schema.index({ guildId: 1, roleId: 1, status: 1, executeAt: 1 });
schema.index({ guildId: 1, status: 1, updatedAt: -1 });
schema.index({ completedAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60, partialFilterExpression: { status: "completed" } });
schema.index({ supersededAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60, partialFilterExpression: { status: "superseded" } });
schema.index({ updatedAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60, partialFilterExpression: { status: "failed" } });

export const CallWaitRoleGeneration = mongoose.models.CallWaitRoleGeneration
  ?? mongoose.model("CallWaitRoleGeneration", schema);

