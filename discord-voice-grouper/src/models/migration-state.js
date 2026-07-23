import mongoose from "mongoose";

const schema = new mongoose.Schema(
  { key: { type: String, required: true, unique: true }, completedAt: { type: Date, required: true } },
  { timestamps: true },
);

export const MigrationState = mongoose.models.MigrationState ?? mongoose.model("MigrationState", schema);
