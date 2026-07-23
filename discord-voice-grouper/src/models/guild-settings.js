import mongoose from "mongoose";

// Keep the schema open so older/newer bot versions can add settings without
// dropping fields that this version does not know about yet.
const schema = new mongoose.Schema(
  { guildId: { type: String, required: true } },
  { strict: false, timestamps: true, minimize: false },
);

schema.index({ guildId: 1 }, { unique: true });

export const GuildSettings =
  mongoose.models.GuildSettings ?? mongoose.model("GuildSettings", schema);
