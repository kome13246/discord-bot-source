import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyGatheringVcRestoreBlock,
  getKokuchiReservationCleanupAt,
  getGatheringVcRestoreRetryDelayMs,
  isGatheringVcRestoreBlocking,
  MAX_GATHERING_VC_RESTORE_ATTEMPTS,
  normalizeGatheringVcRestoreStatus,
  normalizeKokuchiStatus,
} from "../src/kokuchi-event-state.js";
import { KokuchiReservation } from "../src/models/kokuchi-reservation.js";

test("kokuchi and gathering-VC restore lifecycle states are independent", () => {
  assert.equal(normalizeKokuchiStatus("cancel_partial"), "canceled");
  assert.equal(normalizeKokuchiStatus("sent"), "completed");
  assert.equal(normalizeGatheringVcRestoreStatus({ gatheringVcRestorePending: true }), "pending");
  assert.equal(normalizeGatheringVcRestoreStatus({ gatheringVcRestorePending: true, gatheringVcRestoreStatus: "restored" }), "pending");
  assert.equal(isGatheringVcRestoreBlocking("pending"), true);
  assert.equal(isGatheringVcRestoreBlocking("restored"), false);
});

test("restore block reasons distinguish normal wait, retry, orphan, snapshot loss, and max retries", () => {
  const base = {
    eventId: "event-a",
    settings: { kokuchiEventId: "event-a", gatheringVcStateEventId: "event-a", gatheringVcRestorePending: true },
    event: {
      reservationId: "event-a",
      gatheringVcRestorePending: true,
      gatheringVcRestoreStatus: "pending",
      gatheringVcPermissionBeforeOpen: { channelId: "vc", guildId: "guild", viewChannel: true, connect: null },
    },
  };
  assert.equal(classifyGatheringVcRestoreBlock(base).code, "restore_waiting");
  assert.equal(classifyGatheringVcRestoreBlock({ ...base, event: { ...base.event, gatheringVcRestoreStatus: "retry_wait", gatheringVcRestoreNextRetryAt: new Date() } }).code, "restore_retrying");
  assert.equal(classifyGatheringVcRestoreBlock({ ...base, eventId: "new-event" }).code, "orphaned_restore_state");
  assert.equal(classifyGatheringVcRestoreBlock({ ...base, event: { ...base.event, gatheringVcPermissionBeforeOpen: null, gatheringVcRestoreFailureCode: "snapshot_missing", gatheringVcRestoreStatus: "failed" } }).code, "restore_snapshot_missing");
  assert.equal(classifyGatheringVcRestoreBlock({ ...base, event: { ...base.event, gatheringVcRestoreFailureCode: "max_attempts", gatheringVcRestoreStatus: "failed" } }).code, "restore_max_attempts_exceeded");
  assert.equal(classifyGatheringVcRestoreBlock({
    eventId: "event-b",
    settings: { kokuchiEventId: "event-b", gatheringVcStateEventId: "event-b", gatheringVcRestorePending: false },
    event: { ...base.event, reservationId: "event-a" },
  }).code, "orphaned_restore_state");
});

test("restore retries use short then progressively longer delays and stop at the configured maximum", () => {
  assert.equal(getGatheringVcRestoreRetryDelayMs(0), 5_000);
  assert.equal(getGatheringVcRestoreRetryDelayMs(1), 15_000);
  assert.equal(getGatheringVcRestoreRetryDelayMs(4), 5 * 60_000);
  assert.equal(getGatheringVcRestoreRetryDelayMs(999), 15 * 60_000);
  assert.equal(MAX_GATHERING_VC_RESTORE_ATTEMPTS, 6);
});

test("incomplete gathering-VC restoration never receives a TTL cleanup date", () => {
  const now = new Date("2026-08-01T00:00:00.000Z");
  for (const status of ["pending", "restoring", "retry_wait", "failed"]) {
    assert.equal(getKokuchiReservationCleanupAt({ restoreStatus: status, now }), null);
  }
  assert.equal(
    getKokuchiReservationCleanupAt({ restoreStatus: "restored", now }).toISOString(),
    "2026-08-31T00:00:00.000Z",
  );
  assert.equal(
    getKokuchiReservationCleanupAt({ restoreStatus: "not_required", now }).toISOString(),
    "2026-08-31T00:00:00.000Z",
  );
});

test("pending=false with a blocking restore status is an operational inconsistency", () => {
  const result = classifyGatheringVcRestoreBlock({
    eventId: "event-a",
    event: {
      reservationId: "event-a",
      gatheringVcRestorePending: false,
      gatheringVcRestoreStatus: "retry_wait",
      gatheringVcPermissionBeforeOpen: { channelId: "vc", guildId: "guild", viewChannel: true, connect: null },
    },
  });
  assert.equal(result.code, "restore_state_inconsistent");
  assert.equal(result.severity, "error");
});

test("reservation retention is a TTL field while restore state remains event-owned", () => {
  const cleanupIndex = KokuchiReservation.schema.indexes().find(([, options]) => options?.expireAfterSeconds === 0);
  assert.ok(cleanupIndex);
  assert.equal(cleanupIndex[0].cleanupAt, 1);
  assert.deepEqual(cleanupIndex[1].partialFilterExpression, {
    gatheringVcRestorePending: false,
    gatheringVcRestoreStatus: { $in: ["not_required", "restored"] },
  });
  assert.equal(KokuchiReservation.schema.path("gatheringVcRestoreStatus").options.default, "not_required");
  assert.equal(KokuchiReservation.schema.path("gatheringVcRestorePending").options.default, false);
});
