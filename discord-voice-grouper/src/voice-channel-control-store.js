import { VoiceChannelControl } from "./models/voice-channel-control.js";

export const getVoiceControl = (guildId, channelId) => VoiceChannelControl.findOne({ guildId, channelId }).lean();
export const listVoiceControls = (guildId) => VoiceChannelControl.find({ guildId }).lean();
export const upsertVoiceControl = (guildId, channelId, patch = {}) => VoiceChannelControl.findOneAndUpdate(
  { guildId, channelId }, { $set: { guildId, channelId, ...patch } }, { upsert: true, returnDocument: "after", setDefaultsOnInsert: true, lean: true },
);
export const deleteVoiceControl = (guildId, channelId) => VoiceChannelControl.deleteOne({ guildId, channelId });
// Legacy VC-wide timer data is intentionally never restored as an exit schedule.
export const clearLegacyVoiceControlTimers = () => VoiceChannelControl.updateMany(
  { timer: { $exists: true } }, { $unset: { timer: "" } },
);
