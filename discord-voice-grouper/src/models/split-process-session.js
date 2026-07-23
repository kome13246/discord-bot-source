import mongoose from "mongoose";

const schema = new mongoose.Schema(
  {
    sessionId: { type: String, required: true, unique: true },
    guildId: { type: String, required: true },
    ownerId: String,
    sourceChannelId: String,
    operationChannelId: String,
    parentChannelId: String,
    childCategoryId: String,
    participantRoleId: String,
    participantMemberIds: { type: [String], default: [] },
    childChannelIds: { type: [String], default: [] },
    waitingChannelId: String,
    splitStartMessageChannelId: String,
    splitStartMessageId: String,
    phase: String,
    status: { type: String, default: "active" },
    transferAt: Date,
    waitingMonitorEndsAt: Date,
    finishNoticeAt: Date,
    roleRemoveAt: Date,
    finishMessage: String,
    finishNoticeSent: { type: Boolean, default: false },
    roleRemovalCompleted: { type: Boolean, default: false },
    waitingVcCleanupCompleted: { type: Boolean, default: false },
    completedAt: Date,
    lastError: String,
  },
  { timestamps: true },
);

schema.index({ guildId: 1, status: 1 });
export const SplitProcessSession = mongoose.models.SplitProcessSession ?? mongoose.model("SplitProcessSession", schema);
