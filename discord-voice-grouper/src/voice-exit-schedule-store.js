import { VoiceExitNoticeDeletion } from "./models/voice-exit-notice-deletion.js";
import { VoiceExitSchedule } from "./models/voice-exit-schedule.js";

export const getVoiceExitSchedule = (guildId, userId) => VoiceExitSchedule.findOne({ guildId, userId }).lean();
export const listVoiceExitSchedules = () => VoiceExitSchedule.find({ status: "scheduled" }).lean();
export const listInterruptedVoiceExitSchedules = () => VoiceExitSchedule.find({ status: "executing" }).lean();

export async function saveVoiceExitSchedule(schedule) {
  const filter = { guildId: schedule.guildId, userId: schedule.userId };
  const update = { $set: { ...schedule, status: "scheduled", retryCount: 0 } };
  const updated = await VoiceExitSchedule.findOneAndUpdate(
    { ...filter, status: "scheduled" }, update, { returnDocument: "after", lean: true },
  );
  if (updated) return updated;
  try {
    return await VoiceExitSchedule.create({ ...schedule, status: "scheduled", retryCount: 0 });
  } catch (error) {
    if (error?.code !== 11000) throw error;
    return VoiceExitSchedule.findOneAndUpdate(
      { ...filter, status: "scheduled" }, update, { returnDocument: "after", lean: true },
    );
  }
}

export const cancelVoiceExitSchedule = (guildId, userId) => VoiceExitSchedule.findOneAndDelete(
  { guildId, userId, status: "scheduled" }, { lean: true },
);
export const cancelVoiceExitSchedulesForChannel = (guildId, voiceChannelId) => VoiceExitSchedule.deleteMany(
  { guildId, voiceChannelId, status: "scheduled" },
);
export const claimVoiceExitSchedule = (id, now = new Date()) => VoiceExitSchedule.findOneAndUpdate(
  { _id: id, status: "scheduled", scheduledAt: { $lte: now } },
  { $set: { status: "executing" } }, { returnDocument: "after", lean: true },
);
export const deleteClaimedVoiceExitSchedule = (id) => VoiceExitSchedule.deleteOne({ _id: id, status: "executing" });
export const removeInterruptedVoiceExitSchedule = (id) => VoiceExitSchedule.findOneAndDelete(
  { _id: id, status: "executing" }, { lean: true },
);
export const incrementVoiceExitScheduleRetry = (id) => VoiceExitSchedule.findOneAndUpdate(
  { _id: id, status: "executing" }, { $inc: { retryCount: 1 } }, { returnDocument: "after", lean: true },
);

export const createVoiceExitNoticeDeletion = (notice) => VoiceExitNoticeDeletion.findOneAndUpdate(
  { guildId: notice.guildId, channelId: notice.channelId, messageId: notice.messageId },
  { $set: notice }, { upsert: true, returnDocument: "after", setDefaultsOnInsert: true, lean: true },
);
export const listVoiceExitNoticeDeletions = () => VoiceExitNoticeDeletion.find({}).lean();
export const deleteVoiceExitNoticeDeletion = (id) => VoiceExitNoticeDeletion.deleteOne({ _id: id });
