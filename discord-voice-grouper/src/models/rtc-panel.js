import mongoose from "mongoose";

const schema = new mongoose.Schema({
  guildId: { type: String, required: true, unique: true },
  channelId: { type: String, required: true },
  messageId: { type: String, required: true },
}, { timestamps: true, minimize: false });

export const RtcPanel = mongoose.models.RtcPanel
  ?? mongoose.model("RtcPanel", schema);

