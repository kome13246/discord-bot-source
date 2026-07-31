import mongoose from "mongoose";

const schema = new mongoose.Schema({
  guildId: { type: String, required: true },
  channelId: { type: String, required: true },
  messageId: { type: String, required: true },
}, { timestamps: true });

schema.index({ guildId: 1 }, { unique: true });

export const ProfileRegistrationPanel = mongoose.models.ProfileRegistrationPanel
  ?? mongoose.model("ProfileRegistrationPanel", schema);
