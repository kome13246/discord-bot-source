import crypto from "node:crypto";
import { MongoLeaseLock } from "./models/mongo-lease-lock.js";

const processOwnerId = `${process.pid}:${crypto.randomUUID()}`;

export async function acquireMongoLease(lockKey, {
  ownerId = processOwnerId,
  leaseMs = 30_000,
} = {}) {
  const now = new Date();
  const leaseId = crypto.randomUUID();
  try {
    const lock = await MongoLeaseLock.findOneAndUpdate(
      {
        lockKey,
        $or: [
          { ownerId: null },
          { leaseUntil: null },
          { leaseUntil: { $lte: now } },
        ],
      },
      {
        $set: {
          ownerId,
          leaseId,
          acquiredAt: now,
          leaseUntil: new Date(now.getTime() + leaseMs),
        },
        $inc: { fencingToken: 1 },
        $setOnInsert: { lockKey },
      },
      { upsert: true, returnDocument: "after", lean: true },
    );
    return lock?.ownerId === ownerId && lock?.leaseId === leaseId
      ? { lockKey, ownerId, leaseId, fencingToken: lock.fencingToken }
      : null;
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
  const ownership = lease.leaseId
    ? { lockKey: lease.lockKey, ownerId: lease.ownerId, leaseId: lease.leaseId }
    : { lockKey: lease.lockKey, ownerId: lease.ownerId };
  const result = await MongoLeaseLock.updateOne(
    {
      ...ownership,
      leaseUntil: { $gt: now },
    },
    { $set: { leaseUntil: new Date(now.getTime() + leaseMs) } },
  );
  return result.matchedCount === 1;
}

export async function releaseMongoLease(lease) {
  if (!lease) return false;
  const ownership = lease.leaseId
    ? { lockKey: lease.lockKey, ownerId: lease.ownerId, leaseId: lease.leaseId }
    : { lockKey: lease.lockKey, ownerId: lease.ownerId };
  const result = await MongoLeaseLock.updateOne(
    ownership,
    { $set: { ownerId: null, leaseId: null, leaseUntil: new Date(0) } },
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
