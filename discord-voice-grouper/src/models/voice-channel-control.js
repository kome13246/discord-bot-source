import mongoose from "mongoose";

const timerSchema = new mongoose.Schema({
  timerId: String,
  messageId: String,
  createdByUserId: String,
  durationMinutes: Number,
  expiresAt: Date,
}, { _id: false });

const schema = new mongoose.Schema({
  guildId: { type: String, required: true },
  channelId: { type: String, required: true, unique: true },
  panelMessageId: String,
  timer: { type: timerSchema, default: null },
}, { timestamps: true, minimize: false });

schema.index({ guildId: 1, channelId: 1 }, { unique: true });

export const VoiceChannelControl = mongoose.models.VoiceChannelControl
  ?? mongoose.model("VoiceChannelControl", schema);
