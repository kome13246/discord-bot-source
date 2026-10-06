import mongoose from "mongoose";

const schema = new mongoose.Schema({
  draftId: { type: String, required: true, unique: true },
  guildId: { type: String, required: true },
  userId: { type: String, required: true },
  content: { type: String, required: true, maxlength: 300 },
  termDays: { type: Number, required: true, min: 1, max: 90 },
  intervalDays: { type: Number, default: null, min: 1, max: 89 },
  postChannelId: { type: String, required: true },
  overviewChannelId: { type: String, required: true },
  previewDateKey: { type: String, required: true },
  expiresAt: { type: Date, required: true },
  consumedAt: { type: Date, default: null },
}, { timestamps: true });

schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const SengenDraft = mongoose.models.SengenDraft
  ?? mongoose.model("SengenDraft", schema);
