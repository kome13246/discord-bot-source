import mongoose from "mongoose";

const schema = new mongoose.Schema({
  guildId: { type: String, required: true },
  recruitmentId: { type: String, required: true },
  userId: { type: String, required: true },
  status: { type: String, enum: ["pending", "active", "joining", "canceled", "joined", "ended", "failed"], required: true, default: "pending" },
  notificationThreshold: { type: Number, min: 1, max: 3, default: 1 },
  // Keep the scheduled time with the interest record so DM text remains
  // meaningful after the public prompt has been replaced or removed.
  targetAt: { type: Date, default: null },
  receiptDmChannelId: String,
  receiptDmMessageId: String,
  latestThresholdDmChannelId: String,
  latestThresholdDmMessageId: String,
  thresholdNotificationSent: { type: Boolean, default: false },
  // The receipt itself can satisfy the initial threshold.  Keep this distinct
  // from a normal threshold DM so it is never sent twice.
  thresholdSatisfiedInReceipt: { type: Boolean, default: false },
  thresholdNotificationStatus: {
    type: String,
    enum: ["idle", "processing", "sent", "failed"],
    default: "idle",
  },
  thresholdNotificationRetryCount: { type: Number, default: 0 },
  thresholdNotificationLastTriedAt: { type: Date, default: null },
  thresholdNotificationLastError: { type: String, default: null },
  renotificationEnabled: { type: Boolean, default: false },
  hadOtherInterestAtRegistration: { type: Boolean, default: false },
  registeredAt: Date,
  canceledAt: Date,
  failedAt: Date,
  joinedAt: Date,
  endedAt: Date,
  endNotificationSentAt: Date,
  endNotificationAttemptCount: { type: Number, default: 0 },
  endNotificationLastAttemptAt: { type: Date, default: null },
  endNotificationStatus: {
    type: String,
    enum: ["pending", "sent", "failed"],
    default: "pending",
  },
  receiptMessageEditedAt: Date,
}, { timestamps: true });

schema.index({ guildId: 1, recruitmentId: 1, userId: 1 }, { unique: true });
schema.index({ guildId: 1, recruitmentId: 1, status: 1 });
schema.index({ status: 1, thresholdNotificationStatus: 1, thresholdNotificationLastTriedAt: 1 });

export const CallWaitInterest = mongoose.models.CallWaitInterest
  ?? mongoose.model("CallWaitInterest", schema);
