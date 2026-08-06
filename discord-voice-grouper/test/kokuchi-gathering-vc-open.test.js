import { readBotImplementationSource } from "./source-under-test.js";
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { runGatheringVcOpenTransaction } from "../src/kokuchi-gathering-vc-open.js";
import { getRestorePermissionPatch, permissionSnapshotMatches } from "../src/kokuchi-utils.js";

const snapshot = {
  channelId: "gathering-vc",
  guildId: "guild-id",
  viewChannel: true,
  connect: null,
};

test("DB preparation failure prevents the Discord gathering-VC edit", async () => {
  let discordCalls = 0;
  const result = await runGatheringVcOpenTransaction({
    prepare: async () => { throw new Error("MongoDB write failed"); },
    applyDiscord: async () => { discordCalls += 1; return true; },
  });

  assert.equal(result.status, "not_prepared");
  assert.equal(discordCalls, 0);
});
test("a non-single DB match prevents the Discord gathering-VC edit", async () => {
  let discordCalls = 0;
  const result = await runGatheringVcOpenTransaction({
    prepare: async () => false,
    applyDiscord: async () => { discordCalls += 1; return true; },
  });

  assert.equal(result.status, "not_prepared");
  assert.equal(discordCalls, 0);
});

test("an open failure is marked retryable when the saved snapshot cannot be verified", async () => {
  const state = {
    gatheringVcRestoreEventId: "event-a",
    gatheringVcPermissionBeforeOpen: snapshot,
    gatheringVcRestorePending: true,
    gatheringVcRestoreStatus: "pending",
  };
  const marked = [];
  const result = await runGatheringVcOpenTransaction({
    prepare: async () => true,
    applyDiscord: async () => { throw new Error("Discord request failed"); },
    readCurrentPermission: async () => ({ known: false }),
    snapshotMatches: () => false,
    finalizeOpened: async () => {},
    finalizeUnchanged: async () => {},
    compensate: async () => false,
    markPending: async (error, context) => {
      marked.push({ error, context });
      state.gatheringVcRestoreStatus = "retry_wait";
    },
  });

  assert.equal(result.status, "retry_wait");
  assert.equal(marked.length, 1);
  assert.equal(state.gatheringVcRestoreEventId, "event-a");
  assert.equal(state.gatheringVcPermissionBeforeOpen, snapshot);
  assert.equal(state.gatheringVcRestoreStatus, "retry_wait");
});

test("an open failure with an exact snapshot readback becomes not_required and clears the pre-open record", async () => {
  let finalized = 0;
  let marked = 0;
  const result = await runGatheringVcOpenTransaction({
    prepare: async () => true,
    applyDiscord: async () => false,
    readCurrentPermission: async () => ({ known: true, overwrite: null }),
    snapshotMatches: (overwrite) => overwrite === null,
    finalizeOpened: async () => {},
    finalizeUnchanged: async () => { finalized += 1; },
    compensate: async () => false,
    markPending: async () => { marked += 1; },
  });

  assert.equal(result.status, "not_required");
  assert.equal(finalized, 1);
  assert.equal(marked, 0);
});

test("an exception after Discord open keeps the durable pending state when compensation fails", async () => {
  const state = {
    gatheringVcRestoreEventId: "event-a",
    gatheringVcPermissionBeforeOpen: snapshot,
    gatheringVcRestorePending: true,
    gatheringVcRestoreStatus: "pending",
  };
  let markCount = 0;
  const result = await runGatheringVcOpenTransaction({
    prepare: async () => true,
    applyDiscord: async () => true,
    finalizeOpened: async () => { throw new Error("event finalization failed"); },
    compensate: async () => false,
    markPending: async () => {
      markCount += 1;
      state.gatheringVcRestoreStatus = "retry_wait";
    },
  });

  assert.equal(result.status, "retry_wait");
  assert.equal(markCount, 1);
  assert.equal(state.gatheringVcRestorePending, true);
  assert.equal(state.gatheringVcRestoreEventId, "event-a");
  assert.equal(state.gatheringVcPermissionBeforeOpen, snapshot);
  assert.equal(["pending", "restoring", "retry_wait", "failed"].includes(state.gatheringVcRestoreStatus), true);
});

test("an exception after Discord open converges to restored when compensation succeeds", async () => {
  let compensated = 0;
  let marked = 0;
  const result = await runGatheringVcOpenTransaction({
    prepare: async () => true,
    applyDiscord: async () => true,
    finalizeOpened: async () => { throw new Error("event finalization failed"); },
    compensate: async () => { compensated += 1; return true; },
    markPending: async () => { marked += 1; },
  });

  assert.equal(result.status, "restored");
  assert.equal(compensated, 1);
  assert.equal(marked, 0);
});

test("a second restore attempt after restart can reuse the preserved pending record", async () => {
  const state = {
    gatheringVcRestoreEventId: "event-a",
    gatheringVcPermissionBeforeOpen: snapshot,
    gatheringVcRestorePending: true,
    gatheringVcRestoreStatus: "retry_wait",
  };
  let attempts = 0;
  const restoreOnce = () => runGatheringVcOpenTransaction({
    prepare: async () => {
      assert.equal(state.gatheringVcRestoreEventId, "event-a");
      assert.equal(state.gatheringVcPermissionBeforeOpen, snapshot);
      return true;
    },
    applyDiscord: async () => true,
    finalizeOpened: async () => { throw new Error("event finalization failed"); },
    compensate: async () => {
      attempts += 1;
      if (attempts === 1) return false;
      state.gatheringVcRestorePending = false;
      state.gatheringVcRestoreStatus = "restored";
      state.gatheringVcPermissionBeforeOpen = null;
      state.gatheringVcRestoreEventId = null;
      return true;
    },
    markPending: async () => { state.gatheringVcRestoreStatus = "retry_wait"; },
  });

  assert.equal((await restoreOnce()).status, "retry_wait");
  assert.equal(state.gatheringVcRestorePending, true);
  assert.equal((await restoreOnce()).status, "restored");
  assert.equal(state.gatheringVcRestorePending, false);
  assert.equal(state.gatheringVcRestoreStatus, "restored");
});

test("restoring the same snapshot is idempotent and verifies an empty patch before success", () => {
  const permissions = { ViewChannel: "view", Connect: "connect" };
  const state = { view: false, connect: true };
  const overwrite = () => ({
    allow: { has: (permission) => (permission === "view" ? state.view : state.connect) },
    deny: { has: (permission) => (permission === "view" ? state.view === false : state.connect === false) },
  });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const current = overwrite();
    const patch = getRestorePermissionPatch({ snapshot, overwrite: current, permissions });
    if (Object.keys(patch).length) {
      if (Object.hasOwn(patch, "ViewChannel")) state.view = patch.ViewChannel;
      if (Object.hasOwn(patch, "Connect")) state.connect = patch.Connect;
    }
    assert.equal(permissionSnapshotMatches({ snapshot, overwrite: overwrite(), permissions }), true);
  }
});

test("the bot integration persists the recovery record before Discord and separates compensation from finalization", async () => {
  const source = await readBotImplementationSource();
  const open = source.slice(source.indexOf("async function setGatheringVcConnectPermission"), source.indexOf("async function compensateGatheringVcCloseAfterPersistenceMismatch"));

  assert.match(open, /runGatheringVcOpenTransaction/);
  assert.match(open, /gatheringVcRestoreEventId: eventId/);
  assert.match(open, /gatheringVcPermissionBeforeOpen: snapshot/);
  assert.match(open, /gatheringVcRestoreStatus: "pending"/);
  assert.match(open, /gatheringVcRestorePending: true/);
  assert.match(open, /gatheringVcRestoreEventRevision: actionRevision/);
  assert.match(open, /\$unset: \{ cleanupAt: 1 \}/);
  assert.match(open, /prepared\?\.matchedCount !== 1/);
  assert.match(open, /applyDiscord:/);
  assert.match(open, /finalizeOpened:/);
  assert.match(open, /compensate:/);
  assert.match(open, /markPending:/);
});

test("post-processing and cancellation completion preserve snapshot references while restoration is blocking", async () => {
  const source = await readBotImplementationSource();
  const resume = source.slice(source.indexOf("async function resumeKokuchiPostProcessing"), source.indexOf("function createKokuchiCancellationComponents"));
  const cancellation = source.slice(source.indexOf("async function completeKokuchiCancellation"), source.indexOf("async function restoreKokuchiReservations"));

  assert.match(resume, /restoreIncomplete/);
  assert.match(resume, /restoreIncomplete \? \{\} :/);
  assert.match(resume, /restoreIncomplete \? \{\} : \{ cleanupAt/);
  assert.match(resume, /restoreIncomplete \? \{ cleanupAt: 1 \} : \{\}/);
  assert.match(cancellation, /noRestoreStateConfirmed/);
  assert.match(cancellation, /permissionRestored === "not_needed" && noRestoreStateConfirmed/);
  assert.match(cancellation, /gatheringVcRestoreEventId: 1/);
});
