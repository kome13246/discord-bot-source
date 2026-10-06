import mongoose from "mongoose";

const schema = new mongoose.Schema({
  guildId: { type: String, required: true },
  channelId: { type: String, required: true },
  messageId: { type: String, required: true },
  stalePanels: { type: [{ _id: false, channelId: { type: String, required: true }, messageId: { type: String, required: true } }], default: [] },
}, { timestamps: true });

schema.index({ guildId: 1 }, { unique: true });

export const SengenPanel = mongoose.models.SengenPanel
  ?? mongoose.model("SengenPanel", schema);
