import mongoose from "mongoose";

const schema = new mongoose.Schema(
  {
    guildId: { type: String, required: true },
    weekKey: { type: String, required: true },
    status: { type: String, enum: ["executing", "completed", "skipped", "failed"], required: true },
    themeId: { type: String, default: null },
    themeName: { type: String, default: null },
    messageId: { type: String, default: null },
    channelId: { type: String, default: null },
    reason: { type: String, default: null },
    startedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

schema.index({ guildId: 1, weekKey: 1 }, { unique: true });

export const FukyoWeeklyPost = mongoose.models.FukyoWeeklyPost
  ?? mongoose.model("FukyoWeeklyPost", schema);
