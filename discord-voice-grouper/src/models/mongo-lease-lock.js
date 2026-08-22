import mongoose from "mongoose";

// A short-lived, database-backed ownership record.  It is deliberately kept
// separate from feature documents so a crashed process becomes recoverable
// once its lease expires.
const schema = new mongoose.Schema(
  {
    lockKey: { type: String, required: true, unique: true },
    ownerId: { type: String, default: null },
    leaseId: { type: String, default: null },
    fencingToken: { type: Number, default: 0, min: 0 },
    acquiredAt: { type: Date, default: null },
    leaseUntil: { type: Date, default: null },
  },
  { timestamps: true },
);

schema.index({ leaseUntil: 1 });

export const MongoLeaseLock = mongoose.models.MongoLeaseLock
  ?? mongoose.model("MongoLeaseLock", schema);
