import mongoose from "mongoose";

// A room is considered an RTC room only while this record exists.  The
// category/name are deliberately stored as metadata, never used as the
// authority for target detection.
const schema = new mongoose.Schema({
  guildId: { type: String, required: true },
  channelId: { type: String, required: true, unique: true },
  sourceParentChannelId: { type: String, required: true },
  categoryIdAtCreation: { type: String, default: null },
  name: { type: String, default: null },
  createdAt: { type: Date, default: Date.now },
}, { timestamps: true, minimize: false });

schema.index({ guildId: 1, channelId: 1 }, { unique: true });
schema.index({ guildId: 1, sourceParentChannelId: 1 });

export const RtcRoom = mongoose.models.RtcRoom
  ?? mongoose.model("RtcRoom", schema);
