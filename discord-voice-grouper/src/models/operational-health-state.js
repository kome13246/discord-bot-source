import mongoose from "mongoose";

const schema = new mongoose.Schema({
  guildId: { type: String, required: true, unique: true },
  startupRestoreStatus: {
    type: String,
    enum: ["pending", "success", "partial", "failed", "unknown"],
    default: "pending",
  },
  startupRestoreFailures: { type: [mongoose.Schema.Types.Mixed], default: [] },
  startupRestoreCompletedAt: { type: Date, default: null },
  databaseStatus: {
    type: String,
    enum: ["connected", "degraded", "disconnected", "unknown"],
    default: "unknown",
  },
  lastDatabaseCheckAt: { type: Date, default: null },
  lastDatabaseError: { type: String, default: null },
  lastSnapshotStatus: {
    type: String,
    enum: ["success", "partial", "failed", "unknown"],
    default: "unknown",
  },
  lastSnapshotError: { type: String, default: null },
  lastBoardPublishStatus: {
    type: String,
    enum: ["success", "partial", "failed", "unknown"],
    default: "unknown",
  },
  lastBoardPublishAt: { type: Date, default: null },
  lastBoardPublishError: { type: String, default: null },
  lastRecoveryFailureAt: { type: Date, default: null },
  lastRecoveryFailureAction: { type: String, default: null },
  lastRecoveryFailureReason: { type: String, default: null },
}, { timestamps: true, minimize: false });

export const OperationalHealthState = mongoose.models.OperationalHealthState
  ?? mongoose.model("OperationalHealthState", schema);
