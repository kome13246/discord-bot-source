import mongoose from "mongoose";

const schema = new mongoose.Schema({
  guildId: { type: String, required: true },
  userId: { type: String, required: true },
  nickname: { type: String, required: true },
  status: { type: String, default: "" },
  hobby: { type: String, default: "" },
  comment: { type: String, default: "" },
  publishedChannelId: { type: String, default: null },
  publishedMessageId: { type: String, default: null },
  publishedAt: { type: Date, default: null },
  publishedUpdatedAt: { type: Date, default: null },
}, { timestamps: true });

schema.index({ guildId: 1, userId: 1 }, { unique: true });
export const UserProfile = mongoose.models.UserProfile ?? mongoose.model("UserProfile", schema);
