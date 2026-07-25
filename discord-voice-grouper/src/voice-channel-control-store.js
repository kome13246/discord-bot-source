import { VoiceChannelControl } from "./models/voice-channel-control.js";

export const getVoiceControl = (guildId, channelId) => VoiceChannelControl.findOne({ guildId, channelId }).lean();
export const listVoiceControls = (guildId) => VoiceChannelControl.find({ guildId }).lean();
export const upsertVoiceControl = (guildId, channelId, patch = {}) => VoiceChannelControl.findOneAndUpdate(
  { guildId, channelId }, { $set: { guildId, channelId, ...patch } }, { upsert: true, returnDocument: "after", setDefaultsOnInsert: true, lean: true },
);
export const deleteVoiceControl = (guildId, channelId) => VoiceChannelControl.deleteOne({ guildId, channelId });
export const setVoiceControlTimer = (guildId, channelId, timer) => VoiceChannelControl.findOneAndUpdate(
  { guildId, channelId }, { $set: { timer } }, { returnDocument: "after", lean: true },
);
export const clearVoiceControlTimer = (guildId, channelId, timerId) => VoiceChannelControl.findOneAndUpdate(
  { guildId, channelId, "timer.timerId": timerId }, { $set: { timer: null } }, { returnDocument: "after", lean: true },
);
