import mongoose from "mongoose";

const schema = new mongoose.Schema(
  {
    guildId: { type: String, required: true },
    channelId: { type: String, required: true },
    messageId: { type: String, required: true },
    updatedAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

schema.index({ guildId: 1 }, { unique: true });

export const OteboRecruitmentPanel = mongoose.models.OteboRecruitmentPanel
  ?? mongoose.model("OteboRecruitmentPanel", schema);

