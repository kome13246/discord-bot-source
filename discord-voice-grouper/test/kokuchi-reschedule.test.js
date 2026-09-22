import test from "node:test";
import assert from "node:assert/strict";
import { createKokuchiFeature } from "../src/features/kokuchi.js";

function futureEventAt() {
  const future = new Date(Date.now() + 36 * 60 * 60 * 1_000);
  const jst = new Date(future.getTime() + 9 * 60 * 60 * 1_000);
  return new Date(Date.UTC(
    jst.getUTCFullYear(),
    jst.getUTCMonth(),
    jst.getUTCDate(),
    21 - 9,
    0,
    0,
    0,
  ));
}

function makeFeature({ reservation, savedPatches, reservationUpdates, gatheringVcUnlockTimers }) {
  const kokuchiReservation = {
    findOne: () => ({ lean: async () => reservation }),
    updateOne: async (_filter, update) => {
      reservationUpdates.push(update);
      return { matchedCount: 1, modifiedCount: 1 };
    },
  };
  return createKokuchiFeature({
    KokuchiReservation: kokuchiReservation,
    gatheringVcUnlockTimers,
    kokuchiPreNoticeTimers: new Map(),
    kokuchiGatheringReminderTimers: new Map(),
    saveGuildSettingsWithCurrent: async (_guildId, current, patch) => {
      savedPatches.push(patch);
      return { ...current, ...patch };
    },
    sendOperationalLog: async () => {},
  });
}

test("未開放の集合VC予約は設定変更後に新VCへ再予約し、開放済み回は旧VCを維持する", async () => {
  const guild = { id: "guild-1" };
  const previousEventAt = futureEventAt();
  const savedPatches = [];
  const reservationUpdates = [];
  const gatheringVcUnlockTimers = new Map();
  const reservation = { _id: "reservation-1", reservationId: "event-1", status: "sent", eventAt: previousEventAt, gatheringVcUnlockChannelId: "vc-a" };
  const feature = makeFeature({ reservation, savedPatches, reservationUpdates, gatheringVcUnlockTimers });
  const previousSettings = {
    guildId: guild.id,
    kokuchiEventId: "event-1",
    kokuchiEventAt: previousEventAt.toISOString(),
    kokuchiEventTime: "21:00",
    kokuchiAnnouncementChannelId: "announcement",
    gatheringVoiceChannelId: "vc-a",
    gatheringVcStateEventId: "event-1",
    gatheringVcUnlockChannelId: "vc-a",
    gatheringVcUnlockState: "pending",
    kokuchiPreNoticeState: "skipped",
    kokuchiGatheringReminderState: "skipped",
  };
  const nextSettings = {
    ...previousSettings,
    kokuchiEventTime: "22:00",
    gatheringVoiceChannelId: "vc-b",
  };

  assert.equal(await feature.rescheduleCurrentKokuchiEvent(guild, previousSettings, nextSettings), true);
  assert.equal(savedPatches[0].gatheringVcUnlockChannelId, "vc-b");
  assert.equal(savedPatches[0].gatheringVcUnlockState, "pending");
  assert.equal(reservationUpdates[0].$set.gatheringVcUnlockChannelId, "vc-b");
  assert.equal(gatheringVcUnlockTimers.has(guild.id), true);
  feature.clearGatheringVcUnlockTimer(guild.id);

  const openedSavedPatches = [];
  const openedReservationUpdates = [];
  const openedReservation = { ...reservation, _id: "reservation-2", reservationId: "event-2", gatheringVcUnlockChannelId: "vc-a" };
  const openedFeature = makeFeature({
    reservation: openedReservation,
    savedPatches: openedSavedPatches,
    reservationUpdates: openedReservationUpdates,
    gatheringVcUnlockTimers: new Map(),
  });
  const openedPreviousSettings = {
    ...previousSettings,
    kokuchiEventId: "event-2",
    gatheringVcStateEventId: "event-2",
    gatheringVcUnlockState: "opened",
    gatheringVcOpenedAt: new Date(),
  };
  const openedNextSettings = {
    ...openedPreviousSettings,
    gatheringVoiceChannelId: "vc-b",
  };

  assert.equal(await openedFeature.rescheduleCurrentKokuchiEvent(guild, openedPreviousSettings, openedNextSettings), true);
  assert.equal(Object.hasOwn(openedSavedPatches[0], "gatheringVcUnlockChannelId"), false);
  assert.equal(Object.hasOwn(openedReservationUpdates[0].$set, "gatheringVcUnlockChannelId"), false);
});
