import mongoose from "mongoose";

const schema = new mongoose.Schema({
  guildId: { type: String, required: true },
  userId: { type: String, required: true },
  content: { type: String, required: true, maxlength: 300 },
  termDays: { type: Number, required: true, min: 1, max: 90 },
  intervalDays: { type: Number, default: null, min: 1, max: 89 },
  registeredAt: { type: Date, required: true },
  deadlineAt: { type: Date, required: true },
  nextProgressAt: { type: Date, default: null },
  postChannelId: { type: String, required: true },
  postMessageId: { type: String, default: null },
  publicationStatus: { type: String, enum: ["posting", "published", "orphaned"], default: "posting" },
  result: { type: String, enum: [null, "achieved", "failed"], default: null },
  resultPromptSentAt: { type: Date, default: null },
  resultSubmittedAt: { type: Date, default: null },
  failureReason: { type: String, maxlength: 500, default: null },
  publicSyncPending: { type: Boolean, default: false },
  publicRevision: { type: Number, default: 0, min: 0 },
  publicSyncedRevision: { type: Number, default: 0, min: 0 },
  lastProgressNoticeAt: { type: Date, default: null },
  lastError: { type: String, default: null },
}, { timestamps: true });

schema.index({ guildId: 1, userId: 1, deadlineAt: 1 });
schema.index({ deadlineAt: 1, resultPromptSentAt: 1 });
schema.index({ publicSyncPending: 1, updatedAt: 1 });

export const SengenDeclaration = mongoose.models.SengenDeclaration
  ?? mongoose.model("SengenDeclaration", schema);
