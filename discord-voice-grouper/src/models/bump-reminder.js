import mongoose from "mongoose";

const schema = new mongoose.Schema(
  {
    reminderId: { type: String, required: true, unique: true },
    guildId: String,
    channelId: { type: String, required: true },
    dueAt: { type: Date, required: true },
  },
  { strict: false, timestamps: true },
);

schema.index({ dueAt: 1 }, { expireAfterSeconds: 7 * 24 * 60 * 60 });
export const BumpReminder = mongoose.models.BumpReminder ?? mongoose.model("BumpReminder", schema);
