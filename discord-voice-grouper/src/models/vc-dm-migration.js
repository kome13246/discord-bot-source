import mongoose from "mongoose";

const schema = new mongoose.Schema(
  {
    guildId: { type: String, required: true },
    version: { type: Number, required: true, default: 1 },
    status: { type: String, enum: ["pending", "processing", "completed", "failed"], default: "pending" },
    implementationAt: { type: Date, required: true },
    initializedAt: Date,
    completedAt: Date,
    processedCount: { type: Number, default: 0 },
    lastUserId: String,
    lastError: String,
  },
  { timestamps: true, minimize: false },
);

schema.index({ guildId: 1 }, { unique: true });

export const VcDmMigration = mongoose.models.VcDmMigration
  ?? mongoose.model("VcDmMigration", schema);
