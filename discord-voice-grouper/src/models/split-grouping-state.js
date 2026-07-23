import mongoose from "mongoose";

const groupSchema = new mongoose.Schema(
  {
    channelId: String,
    memberIds: { type: [String], default: [] },
  },
  { _id: false },
);

const previousSchema = new mongoose.Schema(
  {
    finalizedAt: Date,
    groups: { type: [groupSchema], default: [] },
  },
  { _id: false },
);

const currentSchema = new mongoose.Schema(
  {
    sessionId: String,
    startedAt: Date,
    updatedAt: Date,
    groups: { type: [groupSchema], default: [] },
  },
  { _id: false },
);

const schema = new mongoose.Schema(
  {
    guildId: { type: String, required: true, unique: true, index: true },
    previous: previousSchema,
    current: currentSchema,
  },
  { timestamps: true },
);

export const SplitGroupingState =
  mongoose.models.SplitGroupingState ?? mongoose.model("SplitGroupingState", schema);
