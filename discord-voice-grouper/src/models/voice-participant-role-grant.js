import mongoose from "mongoose";

// Tracks only roles that this bot added for the voice-monitor feature.  This
// lets startup reconciliation remove stale grants without touching a role
// that was assigned manually or by another integration.
const schema = new mongoose.Schema(
  {
    guildId: { type: String, required: true },
    memberId: { type: String, required: true },
    roleId: { type: String, required: true },
    sourceType: { type: String, default: "voice_monitor" },
    sourceId: { type: String, default: null },
    grantedByBot: { type: Boolean, default: true },
    grantedAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, default: null },
    status: { type: String, enum: ["active", "removing", "removed", "failed"], default: "active" },
    removedAt: { type: Date, default: null },
    cleanupAt: { type: Date, default: null },
  },
  { timestamps: true },
);

schema.index(
  { guildId: 1, memberId: 1, roleId: 1, sourceType: 1, sourceId: 1 },
  { unique: true },
);
schema.index({ guildId: 1, status: 1, expiresAt: 1 });
schema.index({ cleanupAt: 1 }, { expireAfterSeconds: 0 });

export const VoiceParticipantRoleGrant =
  mongoose.models.VoiceParticipantRoleGrant ??
  mongoose.model("VoiceParticipantRoleGrant", schema);

export async function ensureVoiceParticipantRoleGrantIndexes() {
  try {
    await VoiceParticipantRoleGrant.collection.dropIndex("guildId_1_memberId_1_roleId_1");
    console.log("Dropped legacy voice participant role grant index.");
  } catch (error) {
    // MongoDB reports IndexNotFound on fresh installations; every other
    // failure is actionable because it can leave ownership tracking unsafe.
    const isMissingIndex = error?.codeName === "IndexNotFound" || error?.code === 27;
    if (!isMissingIndex) throw error;
  }
  await VoiceParticipantRoleGrant.createIndexes();
}
