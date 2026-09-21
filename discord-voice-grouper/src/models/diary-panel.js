import mongoose from "mongoose";

const schema = new mongoose.Schema(
  {
    guildId: { type: String, required: true, unique: true },
    channelId: { type: String, required: true },
    messageId: { type: String, required: true },
    // Old panels are kept here until Discord confirms deletion. A transient
    // fetch/delete error must never make the old reference unrecoverable.
    pendingMessageDeletions: [{
      channelId: { type: String, required: true },
      messageId: { type: String, required: true },
      attempts: { type: Number, default: 0 },
      nextRetryAt: { type: Date, default: null },
      lastError: { type: String, default: null },
    }],
  },
  { timestamps: true, minimize: false },
);

export const DiaryPanel = mongoose.models.DiaryPanel
  ?? mongoose.model("DiaryPanel", schema);
