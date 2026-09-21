import mongoose from "mongoose";

const schema = new mongoose.Schema(
  {
    guildId: { type: String, required: true },
    userId: { type: String, required: true },
    joinedAt: { type: Date, required: true },
    joinToken: { type: String, default: null },
    consecutiveMisses: { type: Number, default: 0, min: 0, max: 3 },
    lastAssignedAt: { type: Date, default: null },
    // Durable reconciliation state. These fields intentionally live on the
    // participant instead of only in process memory so a restart cannot turn
    // a partially applied leave/role operation into an active participant.
    leaveState: { type: String, enum: ["active", "pending", "failed"], default: "active" },
    leaveReason: { type: String, default: null },
    leaveAttempts: { type: Number, default: 0, min: 0, max: 3 },
    leaveRequestedAt: { type: Date, default: null },
    leaveNextRetryAt: { type: Date, default: null },
    leaveLastError: { type: String, default: null },
    roleSyncState: { type: String, enum: ["ready", "pending", "failed"], default: "ready" },
    roleSyncAttempts: { type: Number, default: 0, min: 0, max: 3 },
    roleSyncNextRetryAt: { type: Date, default: null },
    roleSyncLastError: { type: String, default: null },
    // The counter is an ordered projection of assignment outcomes for the
    // current joinedAt session. It prevents an old completed assignment from
    // resetting a newer miss after an out-of-order retry.
    lastDiaryOutcomeAt: { type: Date, default: null },
    lastDiaryOutcomeAssignmentId: { type: String, default: null },
    lastDiaryOutcomeKind: { type: String, default: null },
    lastDiaryMissAssignmentId: { type: String, default: null },
  },
  { timestamps: true, minimize: false },
);

schema.index({ guildId: 1, userId: 1 }, { unique: true });
schema.index({ guildId: 1, joinedAt: 1 });

export const DiaryParticipant = mongoose.models.DiaryParticipant
  ?? mongoose.model("DiaryParticipant", schema);
