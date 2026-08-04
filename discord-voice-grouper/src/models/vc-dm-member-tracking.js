import mongoose from "mongoose";

const dmStatusValues = [
  "pending",
  "processing",
  "delivered",
  "dm_unavailable",
  "failed",
  "unconfirmed",
  "skipped_manual",
  "skipped_participated",
  "skipped_legacy",
  "skipped_left",
];

const schema = new mongoose.Schema(
  {
    guildId: { type: String, required: true },
    userId: { type: String, required: true },
    joinedAt: { type: Date, required: true },
    isMember: { type: Boolean, default: true },
    leftAt: Date,
    rejoinedAt: Date,
    trackingStartedAt: { type: Date, required: true },
    firstValidVcAt: Date,
    lastValidVcAt: Date,
    inactiveBaselineAt: Date,
    manualValidVcConfirmedAt: Date,
    confirmedBy: String,
    confirmationReason: String,
    newDmStatus: { type: String, enum: dmStatusValues, default: "pending" },
    newDmAttemptedAt: Date,
    newDmSentAt: Date,
    newDmTargetEventAt: Date,
    newDmRecordId: String,
    newDmLastResult: String,
    newDmLastError: String,
    inactiveCycleKey: String,
    inactiveDmStatus: { type: String, enum: dmStatusValues, default: "pending" },
    inactiveDmCycleKey: String,
    inactiveDmAttemptedAt: Date,
    inactiveDmSentAt: Date,
    inactiveDmTargetEventAt: Date,
    inactiveDmRecordId: String,
    inactiveDmLastResult: String,
    inactiveDmLastError: String,
    migrationVersion: Number,
    legacyBaselineAt: Date,
    lastError: String,
    lastOperationalAt: Date,
  },
  { timestamps: true, minimize: false },
);

schema.index({ guildId: 1, userId: 1 }, { unique: true });
schema.index({ guildId: 1, isMember: 1, newDmStatus: 1, manualValidVcConfirmedAt: 1 });
schema.index({ guildId: 1, lastValidVcAt: 1, inactiveDmStatus: 1 });
schema.index({ guildId: 1, inactiveCycleKey: 1 });
schema.index(
  { guildId: 1, newDmRecordId: 1 },
  { unique: true, partialFilterExpression: { newDmRecordId: { $type: "string" } } },
);
schema.index(
  { guildId: 1, inactiveDmRecordId: 1 },
  { unique: true, partialFilterExpression: { inactiveDmRecordId: { $type: "string" } } },
);

export const VcDmMemberTracking = mongoose.models.VcDmMemberTracking
  ?? mongoose.model("VcDmMemberTracking", schema);

export const VcDmMember = VcDmMemberTracking;
