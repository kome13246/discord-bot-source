import mongoose from "mongoose";

const cooldownSchema = new mongoose.Schema({
  guildId: { type: String, required: true }, userId: { type: String, required: true },
  commandName: { type: String, required: true }, availableAt: { type: Date, required: true },
}, { timestamps: true });
cooldownSchema.index({ guildId: 1, userId: 1, commandName: 1 }, { unique: true });
cooldownSchema.index({ availableAt: 1 }, { expireAfterSeconds: 24 * 60 * 60 });

const editSchema = new mongoose.Schema({
  guildId: { type: String, required: true }, channelId: { type: String, required: true },
  messageId: { type: String, required: true, unique: true }, ownerId: { type: String, required: true },
  expiresAt: { type: Date, required: true }, bosyuMentionRoleId: String, anonymous: Boolean, voiceChannelId: String,
}, { timestamps: true });
editSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const BosyuCooldown = mongoose.models.BosyuCooldown ?? mongoose.model("BosyuCooldown", cooldownSchema);
export const BosyuEditSession = mongoose.models.BosyuEditSession ?? mongoose.model("BosyuEditSession", editSchema);
