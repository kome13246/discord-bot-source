import mongoose from "mongoose";

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
  commandUserId: { type: String, required: true },
  commandChannelId: { type: String, required: true },
  targetChannelId: { type: String, required: true },
  overviewChannelId: { type: String, required: true },
  status: { type: String, enum: ["pending", "processing", "canceled", "sent", "failed", "published_unconfirmed"], default: "pending" },
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
  sentAt: Date,
  publishedAt: Date,
  failedAt: Date,
  // Terminal records are kept briefly for audit/debugging and then removed by
  // MongoDB.  Pending/processing reservations never receive this value.
  cleanupAt: Date,
}, { timestamps: true });

schema.index({ guildId: 1, status: 1 });
schema.index({ activeKey: 1 }, { unique: true, sparse: true });
schema.index({ publicationKey: 1 }, { unique: true, sparse: true });
schema.index({ scheduledAt: 1, status: 1 });
schema.index({ cleanupAt: 1 }, { expireAfterSeconds: 0 });

export const KokuchiReservation = mongoose.models.KokuchiReservation
  ?? mongoose.model("KokuchiReservation", schema);
