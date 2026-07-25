import mongoose from "mongoose";
import { SplitGroupingState } from "./models/split-grouping-state.js";

function assertMongo() {
  if (mongoose.connection.readyState !== 1) {
    throw new Error("MongoDB is unavailable; split grouping history was not persisted.");
  }
}

export async function getSplitGroupingState(guildId) {
  assertMongo();
  return SplitGroupingState.findOne({ guildId }).lean();
}

export async function startSplitGrouping({ guildId, sessionId, groups }) {
  assertMongo();
  const now = new Date();
  return SplitGroupingState.findOneAndUpdate(
    { guildId },
    [
      {
        $set: {
          guildId: { $ifNull: ["$guildId", guildId] },
          previous: {
            $cond: [
              { $ne: [{ $type: "$current" }, "missing"] },
              {
                finalizedAt: now,
                groups: { $ifNull: ["$current.groups", []] },
              },
              "$previous",
            ],
          },
          current: {
            sessionId,
            startedAt: now,
            updatedAt: now,
            groups: normalizeGroups(groups),
          },
        },
      },
    ],
    { upsert: true, returnDocument: "after", lean: true },
  );
}

export async function addMembersToCurrentGroup({ guildId, sessionId, channelId, memberIds }) {
  assertMongo();
  const uniqueMemberIds = [...new Set(memberIds.filter(Boolean).map(String))];
  const now = new Date();
  const state = await SplitGroupingState.findOneAndUpdate(
    { guildId, "current.sessionId": sessionId },
    [
      {
        $set: {
          "current.groups": {
            $let: {
              vars: {
                groups: { $ifNull: ["$current.groups", []] },
              },
              in: {
                $let: {
                  vars: {
                    hasTarget: {
                      $in: [
                        channelId,
                        {
                          $map: {
                            input: "$$groups",
                            as: "group",
                            in: "$$group.channelId",
                          },
                        },
                      ],
                    },
                  },
                  in: {
                    $concatArrays: [
                      {
                        $map: {
                          input: "$$groups",
                          as: "group",
                          in: {
                            $mergeObjects: [
                              "$$group",
                              {
                                memberIds: {
                                  $cond: [
                                    { $eq: ["$$group.channelId", channelId] },
                                    {
                                      $setUnion: [
                                        {
                                          $filter: {
                                            input: { $ifNull: ["$$group.memberIds", []] },
                                            as: "memberId",
                                            cond: { $not: [{ $in: ["$$memberId", uniqueMemberIds] }] },
                                          },
                                        },
                                        uniqueMemberIds,
                                      ],
                                    },
                                    {
                                      $filter: {
                                        input: { $ifNull: ["$$group.memberIds", []] },
                                        as: "memberId",
                                        cond: { $not: [{ $in: ["$$memberId", uniqueMemberIds] }] },
                                      },
                                    },
                                  ],
                                },
                              },
                            ],
                          },
                        },
                      },
                      {
                        $cond: [
                          "$$hasTarget",
                          [],
                          [{ channelId, memberIds: uniqueMemberIds }],
                        ],
                      },
                    ],
                  },
                },
              },
            },
          },
          "current.updatedAt": now,
        },
      },
    ],
    { returnDocument: "after", lean: true },
  );

  if (!state) {
    throw new Error("Current split grouping session was not found.");
  }

  return state;
}

function normalizeGroups(groups = []) {
  const seen = new Set();

  return groups
    .map((group) => {
      const memberIds = [];
      for (const memberId of group.memberIds ?? []) {
        const normalized = String(memberId);
        if (!seen.has(normalized)) {
          seen.add(normalized);
          memberIds.push(normalized);
        }
      }
      return {
        ...(group.channelId ? { channelId: String(group.channelId) } : {}),
        memberIds,
      };
    })
    .filter((group) => group.memberIds.length > 0);
}
