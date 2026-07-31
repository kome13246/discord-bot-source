import mongoose from "mongoose";
import { FukyoThemeState } from "./models/fukyo-theme-state.js";
import { FukyoWeeklyPost } from "./models/fukyo-weekly-post.js";

function assertMongo() {
  if (mongoose.connection.readyState !== 1) throw new Error("MongoDB is required for fukyo themes.");
}

export async function getFukyoThemeState(guildId) {
  assertMongo();
  return FukyoThemeState.findOne({ guildId }).lean();
}

export async function saveFukyoThemeState(guildId, state) {
  assertMongo();
  return FukyoThemeState.findOneAndUpdate(
    { guildId },
    { $set: { usedThemeIds: state.usedThemeIds, cycleNumber: state.cycleNumber, lastThemeId: state.lastThemeId } },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true, lean: true },
  );
}

/** Claims a week exactly once. Existing records, including interrupted ones, are never reclaimed. */
export async function claimFukyoWeeklyPost({ guildId, weekKey }) {
  assertMongo();
  const now = new Date();
  try {
    const previous = await FukyoWeeklyPost.findOneAndUpdate(
      { guildId, weekKey },
      { $setOnInsert: { guildId, weekKey, status: "executing", startedAt: now } },
      { upsert: true, returnDocument: "before", setDefaultsOnInsert: true, lean: true },
    );
    return { claimed: !previous, record: previous };
  } catch (error) {
    if (error?.code !== 11000) throw error;
    return { claimed: false, record: await FukyoWeeklyPost.findOne({ guildId, weekKey }).lean() };
  }
}

export async function finishFukyoWeeklyPost({ guildId, weekKey, status, patch = {} }) {
  assertMongo();
  return FukyoWeeklyPost.findOneAndUpdate(
    { guildId, weekKey, status: "executing" },
    { $set: { ...patch, status, finishedAt: new Date() } },
    { returnDocument: "after", lean: true },
  );
}
