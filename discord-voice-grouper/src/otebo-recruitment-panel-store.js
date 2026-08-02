import { OteboRecruitmentPanel } from "./models/otebo-recruitment-panel.js";

export function getOteboRecruitmentPanel(guildId) {
  return OteboRecruitmentPanel.findOne({ guildId }).lean();
}

export function saveOteboRecruitmentPanel({ guildId, channelId, messageId }) {
  return OteboRecruitmentPanel.findOneAndUpdate(
    { guildId },
    { $set: { guildId, channelId, messageId, updatedAt: new Date() } },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true, lean: true },
  );
}

export function deleteOteboRecruitmentPanel(guildId) {
  return OteboRecruitmentPanel.deleteOne({ guildId });
}

