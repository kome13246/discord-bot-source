import mongoose from "mongoose";

const schema = new mongoose.Schema(
  {
    recordId: { type: String, required: true, unique: true },
    guildId: { type: String, required: true },
    userId: { type: String, required: true },
    targetEventAt: { type: Date, required: true },
    sourceDmType: { type: String, enum: ["new", "inactive"], required: true },
    sourceDmRecordId: { type: String, required: true },
    remindAt: { type: Date, required: true },
    status: {
      type: String,
      enum: ["pending", "processing", "sent", "canceled", "dm_unavailable", "failed", "unconfirmed"],
      default: "pending",
    },
    confirmationMessageId: String,
    channelId: String,
    confirmationLeaseUntil: Date,
    leaseUntil: Date,
    processingAt: Date,
    attemptCount: { type: Number, default: 0 },
    lastError: String,
    sentAt: Date,
    canceledAt: Date,
  },
  { timestamps: true, minimize: false },
);

schema.index({ guildId: 1, userId: 1, targetEventAt: 1 }, { unique: true });
schema.index({ status: 1, remindAt: 1 });
schema.index({ guildId: 1, status: 1, remindAt: 1 });

export const VcDmReminder = mongoose.models.VcDmReminder
  ?? mongoose.model("VcDmReminder", schema);
