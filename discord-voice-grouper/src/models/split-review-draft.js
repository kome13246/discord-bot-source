import mongoose from "mongoose";
const schema = new mongoose.Schema({
  guildId: { type: String, required: true }, splitSessionId: { type: String, required: true }, userId: { type: String, required: true },
  talkAmount: String, durationFeeling: String, practiceEffect: String, updatedAt: { type: Date, default: Date.now }, expiresAt: { type: Date, required: true },
}, { timestamps: true });
schema.index({ guildId: 1, splitSessionId: 1, userId: 1 }, { unique: true });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const SplitReviewDraft = mongoose.models.SplitReviewDraft ?? mongoose.model("SplitReviewDraft", schema);
