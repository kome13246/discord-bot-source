import mongoose from "mongoose";

const schema = new mongoose.Schema(
  {
    guildId: { type: String, required: true, unique: true },
    usedThemeIds: { type: [String], default: [] },
    cycleNumber: { type: Number, default: 0 },
    lastThemeId: { type: String, default: null },
  },
  { timestamps: true },
);

export const FukyoThemeState = mongoose.models.FukyoThemeState
  ?? mongoose.model("FukyoThemeState", schema);
