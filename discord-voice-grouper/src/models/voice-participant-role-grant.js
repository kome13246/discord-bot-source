import mongoose from "mongoose";

// Tracks only roles that this bot added for the voice-monitor feature.  This
// lets startup reconciliation remove stale grants without touching a role
// that was assigned manually or by another integration.
const schema = new mongoose.Schema(
  {
    guildId: { type: String, required: true },
    memberId: { type: String, required: true },
    roleId: { type: String, required: true },
  },
  { timestamps: true },
);

schema.index({ guildId: 1, memberId: 1, roleId: 1 }, { unique: true });

export const VoiceParticipantRoleGrant =
  mongoose.models.VoiceParticipantRoleGrant ??
  mongoose.model("VoiceParticipantRoleGrant", schema);
