import crypto from "node:crypto";
import { MongoLeaseLock } from "./models/mongo-lease-lock.js";

const processOwnerId = `${process.pid}:${crypto.randomUUID()}`;

export async function acquireMongoLease(lockKey, {
  ownerId = processOwnerId,
  leaseMs = 30_000,
} = {}) {
  const now = new Date();
  try {
    const lock = await MongoLeaseLock.findOneAndUpdate(
      {
        lockKey,
        $or: [
          { ownerId },
          { leaseUntil: null },
          { leaseUntil: { $lte: now } },
        ],
      },
      {
        $set: {
          ownerId,
          acquiredAt: now,
          leaseUntil: new Date(now.getTime() + leaseMs),
        },
        $setOnInsert: { lockKey },
      },
      { upsert: true, returnDocument: "after", lean: true },
    );
    return lock?.ownerId === ownerId ? { lockKey, ownerId } : null;
  } catch (error) {
    // A concurrent upsert can lose on the unique index.  That means another
    // worker owns the lock, not that the caller should retry its side effect.
    if (error?.code === 11000) return null;
    throw error;
  }
}

export async function renewMongoLease(lease, { leaseMs = 30_000 } = {}) {
  if (!lease) return false;
  const now = new Date();
  const result = await MongoLeaseLock.updateOne(
    {
      lockKey: lease.lockKey,
      ownerId: lease.ownerId,
      leaseUntil: { $gt: now },
    },
    { $set: { leaseUntil: new Date(now.getTime() + leaseMs) } },
  );
  return result.matchedCount === 1;
}

export async function releaseMongoLease(lease) {
  if (!lease) return false;
  const result = await MongoLeaseLock.updateOne(
    { lockKey: lease.lockKey, ownerId: lease.ownerId },
    { $set: { ownerId: null, leaseUntil: new Date(0) } },
  );
  return result.matchedCount === 1;
}

export async function withMongoLease(lockKey, callback, options) {
  const lease = await acquireMongoLease(lockKey, options);
  if (!lease) return { acquired: false, value: null };
  try {
    return { acquired: true, value: await callback(lease) };
  } finally {
    await releaseMongoLease(lease);
  }
}
