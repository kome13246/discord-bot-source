import mongoose from "mongoose";

const schema = new mongoose.Schema({
  guildId: { type: String, required: true },
  channelId: { type: String, required: true },
  messageId: { type: String, required: true },
  deleteAt: { type: Date, required: true },
}, { timestamps: true, minimize: false });

schema.index({ deleteAt: 1 });
schema.index({ guildId: 1, channelId: 1, messageId: 1 }, { unique: true });

export const VoiceExitNoticeDeletion = mongoose.models.VoiceExitNoticeDeletion
  ?? mongoose.model("VoiceExitNoticeDeletion", schema);
