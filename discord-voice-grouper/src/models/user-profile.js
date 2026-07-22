import mongoose from "mongoose";

const schema = new mongoose.Schema({
  guildId: { type: String, required: true },
  userId: { type: String, required: true },
  nickname: { type: String, required: true },
  status: { type: String, default: "" },
  hobby: { type: String, default: "" },
  comment: { type: String, default: "" },
}, { timestamps: true });

schema.index({ guildId: 1, userId: 1 }, { unique: true });
export const UserProfile = mongoose.models.UserProfile ?? mongoose.model("UserProfile", schema);
