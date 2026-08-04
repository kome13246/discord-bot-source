import mongoose from "mongoose";
import {
  GATHERING_VC_RESTORE_STATUS_VALUES,
  KOKUCHI_STATUS_VALUES,
} from "../kokuchi-event-state.js";

const schema = new mongoose.Schema({
  guildId: { type: String, required: true },
  // Present only while pending/processing; a sparse unique index makes the
  // one-active-reservation rule safe across concurrent bot instances.
  activeKey: { type: String },
  // Retained after a confirmed publication so an immediate command cannot
  // publish the same guild/event-date combination twice.
  publicationKey: { type: String },
  reservationId: { type: String, required: true, unique: true },
  weekday: { type: String, required: true },
  displayHour: { type: Number, required: true, min: 0, max: 24 },
  scheduledAt: { type: Date, required: true },
  // The user-selected JST calendar day.  This intentionally differs from
  // scheduledAt for `set:24`, whose actual timestamp is the following 00:00.
  eventDate: String,
  eventAt: Date,
  commandUserId: { type: String, required: true },
  commandChannelId: { type: String, required: true },
  targetChannelId: { type: String, required: true },
  overviewChannelId: { type: String, required: true },
  status: { type: String, enum: ["pending", "processing", "canceling", "cancel_partial", "canceled", "sent", "failed", "published_unconfirmed"], default: "pending" },
  // New lifecycle state. `status` remains for backward compatibility with
  // existing scheduled-action and publication recovery records.
  kokuchiStatus: { type: String, enum: KOKUCHI_STATUS_VALUES },
  lifecycleRevision: { type: Number, default: 0, min: 0 },
  cancelRequested: { type: Boolean, default: false },
  publicationStatus: {
    type: String,
    enum: ["pending", "processing", "published", "published_unconfirmed", "failed_before_publish"],
    default: "pending",
  },
  publicationChannelId: String,
  publicationMessageId: String,
  publicationStartedAt: Date,
  publicationSentAt: Date,
  publicationConfirmedAt: Date,
  postProcessingStatus: {
    type: String,
    enum: ["pending", "processing", "completed", "failed"],
    default: "pending",
  },
  postProcessingError: String,
  // A reservation and its reminder have independent state machines.  Keeping
  // the processing state in Mongo makes duplicate timer callbacks harmless.
  processingAt: Date,
  reminderStatus: { type: String, enum: ["pending", "processing", "sent", "failed", "skipped", "canceled"], default: "pending" },
  reminderProcessingAt: Date,
  confirmationChannelId: String,
  confirmationMessageId: String,
  canceledAt: Date,
  cancellationStartedAt: Date,
  cancellationError: String,
  cancellationResults: mongoose.Schema.Types.Mixed,
  // Gathering-VC restoration is event-owned state. Keeping it on the event
  // record prevents a later /kokuchi from inheriting a previous event's VC
  // channel or permission snapshot.
  gatheringVcUnlockChannelId: String,
  gatheringVcUnlockState: String,
  gatheringVcPermissionBeforeOpen: mongoose.Schema.Types.Mixed,
  gatheringVcOpenedAt: Date,
  gatheringVcClosedAt: Date,
  gatheringVcClosedBySplitSessionId: String,
  gatheringVcClosingAt: Date,
  gatheringVcRestorePending: { type: Boolean, default: false },
  gatheringVcRestorePendingAt: Date,
  gatheringVcRestoreEventId: String,
  gatheringVcRestoreEventRevision: { type: Number, min: 0 },
  gatheringVcRestoreStatus: { type: String, enum: GATHERING_VC_RESTORE_STATUS_VALUES, default: "not_required" },
  gatheringVcRestoreAttemptCount: { type: Number, default: 0 },
  gatheringVcRestoreFailureCode: String,
  gatheringVcRestoreLastError: String,
  gatheringVcRestoreNextRetryAt: Date,
  sentAt: Date,
  publishedAt: Date,
  failedAt: Date,
  // Terminal records are kept briefly for audit/debugging and then removed by
  // MongoDB.  A reservation with an incomplete gathering-VC restore never
  // receives this value, so its snapshot remains available for recovery.
  cleanupAt: Date,
}, { timestamps: true });

schema.index({ guildId: 1, status: 1 });
schema.index({ activeKey: 1 }, { unique: true, sparse: true });
schema.index({ publicationKey: 1 }, { unique: true, sparse: true });
schema.index({ scheduledAt: 1, status: 1 });
schema.index({ guildId: 1, gatheringVcRestoreStatus: 1, gatheringVcRestoreNextRetryAt: 1 });
// The partial TTL index is a second line of defense: even if an interrupted
// write leaves cleanupAt behind, MongoDB must not delete an event whose
// gathering-VC restoration is incomplete.
schema.index({ cleanupAt: 1 }, {
  name: "kokuchi_reservation_cleanupAt_ttl",
  expireAfterSeconds: 0,
  partialFilterExpression: {
    gatheringVcRestorePending: false,
    gatheringVcRestoreStatus: { $in: ["not_required", "restored"] },
  },
});

export const KokuchiReservation = mongoose.models.KokuchiReservation
  ?? mongoose.model("KokuchiReservation", schema);
