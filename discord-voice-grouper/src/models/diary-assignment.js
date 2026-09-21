import mongoose from "mongoose";

const schema = new mongoose.Schema(
  {
    guildId: { type: String, required: true },
    assignmentId: { type: String, required: true },
    slotKey: { type: String, required: true },
    userId: { type: String, required: true },
    channelId: { type: String, default: null },
    assignedAt: { type: Date, required: true },
    nominalAt: { type: Date, required: true },
    deadlineAt: { type: Date, required: true },
    status: {
      type: String,
      enum: ["active", "completed", "missed", "canceled"],
      default: "active",
    },
    specialNoPenalty: { type: Boolean, default: false },
    postDetectedAt: { type: Date, default: null },
    postMessageId: { type: String, default: null },
    // Stable chronological outcome timestamp. For a live message this is
    // the observed message time; for history reconciliation it is the
    // assignment deadline, so a later retry cannot reorder outcomes.
    outcomeAt: { type: Date, default: null },
    checkedAt: { type: Date, default: null },
    cancelReason: { type: String, default: null },
    // `pending` means the expiry was observed but its participant projection
    // is not durable yet. It is deliberately separate from `status` so a
    // crash after marking an assignment missed cannot lose the miss.
    missState: { type: String, enum: ["pending", "applied", "blocked"], default: "pending" },
    missAttempts: { type: Number, default: 0, min: 0, max: 5 },
    missNextRetryAt: { type: Date, default: null },
    missLastError: { type: String, default: null },
    missCounterIgnored: { type: Boolean, default: false },
    // A completed assignment remains pending until its participant counter
    // projection is durably reconciled. This preserves a success even if the
    // public post is deleted before the worker's next history scan.
    completionState: { type: String, enum: ["pending", "applied", "blocked"], default: "pending" },
    completionAttempts: { type: Number, default: 0, min: 0, max: 5 },
    completionNextRetryAt: { type: Date, default: null },
    completionLastError: { type: String, default: null },
    // The assignment is claimed before Discord publication. `sending` is an
    // intentionally durable uncertain state: after a process crash we must
    // never treat it as an unposted assignment or publish a duplicate blindly.
    sendState: { type: String, enum: ["pending", "sending", "sent", "failed"], default: "pending" },
    sendClaimToken: { type: String, default: null },
    sendClaimedAt: { type: Date, default: null },
  },
  { timestamps: true, minimize: false },
);

schema.index({ guildId: 1, assignmentId: 1 }, { unique: true });
schema.index({ guildId: 1, status: 1, deadlineAt: 1 });
schema.index({ guildId: 1, userId: 1, nominalAt: -1 });

export const DiaryAssignment = mongoose.models.DiaryAssignment
  ?? mongoose.model("DiaryAssignment", schema);
