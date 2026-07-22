import mongoose from "mongoose";

const schema = new mongoose.Schema({
  guildId: { type: String, required: true },
  userId: { type: String, required: true },
  channelId: { type: String, required: true },
  messageId: { type: String, required: true },
}, { timestamps: true });

schema.index({ guildId: 1, userId: 1 }, { unique: true });
export const ActiveProfile = mongoose.models.ActiveProfile ?? mongoose.model("ActiveProfile", schema);
