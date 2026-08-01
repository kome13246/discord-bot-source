import mongoose from "mongoose";

const schema = new mongoose.Schema({
  guildId: { type: String, required: true },
  actionType: { type: String, required: true },
  actorUserId: { type: String, default: null },
  targetType: { type: String, default: null },
  targetId: { type: String, default: null },
  before: { type: mongoose.Schema.Types.Mixed, default: null },
  after: { type: mongoose.Schema.Types.Mixed, default: null },
  result: { type: String, enum: ["success", "partial", "failed"], required: true },
  errors: { type: [String], default: [] },
  cleanupAt: { type: Date, default: null },
}, { timestamps: true, minimize: false });

schema.index({ guildId: 1, createdAt: -1 });
schema.index({ cleanupAt: 1 }, { expireAfterSeconds: 0 });

export const OperationalActionLog = mongoose.models.OperationalActionLog
  ?? mongoose.model("OperationalActionLog", schema);
