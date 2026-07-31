import { ProfileRegistrationPanel } from "./models/profile-registration-panel.js";

export function getProfileRegistrationPanel(guildId) {
  return ProfileRegistrationPanel.findOne({ guildId }).lean();
}

export function saveProfileRegistrationPanel({ guildId, channelId, messageId }) {
  return ProfileRegistrationPanel.findOneAndUpdate(
    { guildId },
    { $set: { channelId, messageId }, $setOnInsert: { guildId } },
    { upsert: true, returnDocument: "after", lean: true },
  );
}

export function deleteProfileRegistrationPanel(guildId) {
  return ProfileRegistrationPanel.deleteOne({ guildId });
}
