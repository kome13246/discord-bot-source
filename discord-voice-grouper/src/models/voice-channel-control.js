import mongoose from "mongoose";

const schema = new mongoose.Schema({
  guildId: { type: String, required: true },
  channelId: { type: String, required: true, unique: true },
  panelMessageId: String,
}, { timestamps: true, minimize: false });

schema.index({ guildId: 1, channelId: 1 }, { unique: true });

export const VoiceChannelControl = mongoose.models.VoiceChannelControl
  ?? mongoose.model("VoiceChannelControl", schema);
