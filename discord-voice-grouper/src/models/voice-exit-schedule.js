import mongoose from "mongoose";

const schema = new mongoose.Schema({
  guildId: { type: String, required: true },
  userId: { type: String, required: true },
  voiceChannelId: { type: String, required: true },
  scheduledAt: { type: Date, required: true },
  durationMinutes: { type: Number, required: true },
  status: { type: String, enum: ["scheduled", "executing"], default: "scheduled" },
  retryCount: { type: Number, default: 0 },
}, { timestamps: true, minimize: false });

schema.index({ guildId: 1, userId: 1 }, { unique: true });
schema.index({ status: 1, scheduledAt: 1 });

export const VoiceExitSchedule = mongoose.models.VoiceExitSchedule
  ?? mongoose.model("VoiceExitSchedule", schema);
