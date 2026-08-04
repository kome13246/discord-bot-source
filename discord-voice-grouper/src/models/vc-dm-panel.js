import mongoose from "mongoose";

const schema = new mongoose.Schema(
  {
    guildId: { type: String, required: true },
    channelId: { type: String, required: true },
    messageIds: { type: [String], default: [] },
    recordId: { type: String, required: true },
    marker: { type: String, required: true },
    lastRenderedHash: String,
    lastUpdatedAt: Date,
    lastError: String,
  },
  { timestamps: true, minimize: false },
);

schema.index({ guildId: 1 }, { unique: true });
schema.index({ channelId: 1 });

export const VcDmPanel = mongoose.models.VcDmPanel
  ?? mongoose.model("VcDmPanel", schema);
