import mongoose from "mongoose";

const schema = new mongoose.Schema(
  {
    guildId: { type: String, required: true },
    slotKey: { type: String, required: true },
    status: { type: String, enum: ["claimed", "completed", "failed"], default: "claimed" },
    claimToken: { type: String, default: null },
    claimedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    lastError: { type: String, default: null },
  },
  { timestamps: true, minimize: false },
);

schema.index({ guildId: 1, slotKey: 1 }, { unique: true });

export const DiaryDailyRun = mongoose.models.DiaryDailyRun
  ?? mongoose.model("DiaryDailyRun", schema);
