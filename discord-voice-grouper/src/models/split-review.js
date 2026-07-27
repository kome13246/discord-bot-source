import mongoose from "mongoose";

const schema = new mongoose.Schema({
  guildId: { type: String, required: true }, splitSessionId: { type: String, required: true },
  questionnaireVersion: { type: Number, required: true, default: 1 }, eventStartedAt: Date, eventDate: String,
  userId: { type: String, required: true }, participantRoleId: String, groupNumber: Number,
  groupMemberIds: { type: [String], default: [] }, talkAmount: String, durationFeeling: String,
  practiceEffect: String, comment: String, submittedAt: { type: Date, default: Date.now },
  deliveryStatus: { type: String, default: "pending" }, reviewChannelId: String, reviewMessageId: String,
}, { timestamps: true });
schema.index({ guildId: 1, splitSessionId: 1, userId: 1 }, { unique: true });
export const SplitReview = mongoose.models.SplitReview ?? mongoose.model("SplitReview", schema);
