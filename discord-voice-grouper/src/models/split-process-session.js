import mongoose from "mongoose";

const schema = new mongoose.Schema(
  {
    sessionId: { type: String, required: true, unique: true },
    guildId: { type: String, required: true },
    // Captured when /splitvc starts. A split may close the gathering VC only
    // when this exact event and lifecycle generation are still valid.
    kokuchiEventId: String,
    kokuchiEventRevision: { type: Number, min: 0 },
    ownerId: String,
    sourceChannelId: String,
    operationChannelId: String,
    parentChannelId: String,
    childCategoryId: String,
    participantRoleId: String,
    participantMemberIds: { type: [String], default: [] },
    participantRoleGrantedMemberIds: { type: [String], default: [] },
    childChannelIds: { type: [String], default: [] },
    waitingChannelId: String,
    waitingMonitorStatus: {
      type: String,
      enum: ["inactive", "active", "extended", "closing", "closed", "failed"],
      default: "inactive",
    },
    waitingMonitorStartedAt: Date,
    splitStartMessageChannelId: String,
    splitStartMessageId: String,
    phase: String,
    status: { type: String, default: "active" },
    transferAt: Date,
    plannedMemberIds: { type: [String], default: [] },
    waitingMonitorEndsAt: Date,
    waitingMonitorExtendedAt: Date,
    waitingMonitorHeartbeatAt: Date,
    waitingMonitorLeaseOwner: String,
    waitingMonitorLeaseUntil: Date,
    waitingMonitorLeaseRetryAt: Date,
    waitingMonitorClosedAt: Date,
    waitingMonitorFailureCount: { type: Number, default: 0 },
    finishNoticeAt: Date,
    reviewDeadlineAt: Date,
    roleRemoveAt: Date,
    finishNoticeChannelId: String,
    finishNoticeMessageId: String,
    reviewButtonShown: { type: Boolean, default: false },
    reviewEligibleMemberIds: { type: [String], default: [] },
    groupSnapshots: { type: [{ groupNumber: Number, channelId: String, memberIds: [String] }], default: [] },
    conversationStartedAt: Date,
    reviewAggregationEligible: { type: Boolean, default: false },
    isTestSession: { type: Boolean, default: false },
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
schema.index({ guildId: 1, status: 1, updatedAt: -1 });
schema.index({ guildId: 1, waitingChannelId: 1, waitingMonitorStatus: 1 });
schema.index({ completedAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60, partialFilterExpression: { status: { $in: ["completed", "canceled"] } } });
export const SplitProcessSession = mongoose.models.SplitProcessSession ?? mongoose.model("SplitProcessSession", schema);
