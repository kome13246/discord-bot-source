import mongoose from "mongoose";

const schema = new mongoose.Schema({
  guildId: { type: String, required: true, unique: true },
  channelId: { type: String, required: true },
  messageId: { type: String, required: true },
  payloadHash: { type: String, default: null },
  lastEditAt: { type: Date, default: null },
  lastSuccessfulRefreshAt: { type: Date, default: null },
  lastRefreshAttemptAt: { type: Date, default: null },
  lastRefreshError: { type: String, default: null },
}, { timestamps: true, minimize: false });

schema.index({ guildId: 1 }, { unique: true });

export const OperationalStatusBoard = mongoose.models.OperationalStatusBoard
  ?? mongoose.model("OperationalStatusBoard", schema);
