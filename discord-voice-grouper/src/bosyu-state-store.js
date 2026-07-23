import mongoose from "mongoose";
import { BosyuCooldown, BosyuEditSession } from "./models/bosyu-state.js";

export async function consumeBosyuCooldown({ guildId, userId, now = new Date(), durationMs }) {
  if (mongoose.connection.readyState !== 1) throw new Error("MongoDB is unavailable; /bosyu cooldown cannot be checked.");
  const availableAt = new Date(now.getTime() + durationMs);
  const key = { guildId, userId, commandName: "bosyu" };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const renewed = await BosyuCooldown.findOneAndUpdate(
      { ...key, availableAt: { $lte: now } },
      { $set: { availableAt } },
      { new: true, lean: true },
    );
    if (renewed) return { allowed: true, availableAt };

    try {
      await BosyuCooldown.create({ ...key, availableAt });
      return { allowed: true, availableAt };
    } catch (error) {
      if (error?.code !== 11000) throw error;
      const existing = await BosyuCooldown.findOne(key).lean();
      if (existing && new Date(existing.availableAt).getTime() > now.getTime()) {
        return { allowed: false, availableAt: new Date(existing.availableAt) };
      }
    }
  }
  throw new Error("Unable to atomically consume /bosyu cooldown.");
}

export async function saveBosyuEditSession(session) {
  if (mongoose.connection.readyState !== 1) throw new Error("MongoDB is unavailable; /bosyu edit state cannot be saved.");
  return BosyuEditSession.findOneAndUpdate(
    { messageId: session.messageId },
    { $set: session },
    { upsert: true, new: true, setDefaultsOnInsert: true, lean: true },
  );
}

export async function getBosyuEditSession(messageId) {
  if (mongoose.connection.readyState !== 1) throw new Error("MongoDB is unavailable; /bosyu edit state cannot be read.");
  return BosyuEditSession.findOne({ messageId, expiresAt: { $gt: new Date() } }).lean();
}

export async function getActiveBosyuEditSessions() {
  if (mongoose.connection.readyState !== 1) throw new Error("MongoDB is unavailable; /bosyu edit state cannot be restored.");
  return BosyuEditSession.find({ expiresAt: { $gt: new Date() } }).lean();
}

export async function getExpiredBosyuEditSessions() {
  if (mongoose.connection.readyState !== 1) throw new Error("MongoDB is unavailable; expired /bosyu edit state cannot be read.");
  return BosyuEditSession.find({ expiresAt: { $lte: new Date() } }).lean();
}

export async function deleteBosyuEditSession(messageId) {
  if (mongoose.connection.readyState !== 1) throw new Error("MongoDB is unavailable; /bosyu edit state cannot be deleted.");
  return BosyuEditSession.deleteOne({ messageId });
}
