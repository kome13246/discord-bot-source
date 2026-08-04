import mongoose from "mongoose";

const schema = new mongoose.Schema(
  {
    guildId: { type: String, required: true },
    jstDate: { type: String, required: true },
    status: { type: String, enum: ["pending", "processing", "completed", "failed", "stopped"], default: "pending" },
    startedAt: Date,
    completedAt: Date,
    lastError: String,
    result: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true, minimize: false },
);

schema.index({ guildId: 1, jstDate: 1 }, { unique: true });
schema.index({ status: 1, updatedAt: 1 });

export const VcDmDailyRun = mongoose.models.VcDmDailyRun
  ?? mongoose.model("VcDmDailyRun", schema);
