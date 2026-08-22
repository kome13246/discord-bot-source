import test from "node:test";
import assert from "node:assert/strict";
import { createReadyHandler, settleStartupTasks } from "../src/app/startup-coordinator.js";

test("起動復元タスクは名前と成功・失敗を対応付ける", async () => {
  const failure = new Error("restore failed");
  const results = await settleStartupTasks([
    { name: "first", run: async () => "ok" },
    { name: "second", run: async () => { throw failure; } },
  ]);
  assert.equal(results[0].name, "first");
  assert.equal(results[0].status, "fulfilled");
  assert.equal(results[1].name, "second");
  assert.equal(results[1].reason, failure);
});

test("Ready処理は通常復元後に後段復元を行い、状態を確定する", async () => {
  const order = [];
  let restoreState;
  let recorded;
  const handler = createReadyHandler({
    clearReadyWatchdog: () => order.push("watchdog"),
    migrate: async () => order.push("migrate"),
    restoreTasks: [{ name: "main", run: async () => order.push("main") }],
    lateRestoreTasks: [{ name: "panel", run: async () => order.push("panel") }],
    updateRestoreState: (state) => { restoreState = state; },
    recordStartupRestore: async (state) => { recorded = state; },
    statusBoard: {
      start: () => order.push("board-start"),
      restore: async () => order.push("board-restore"),
    },
    shouldSendMongoSuccessLog: () => false,
    clearMongoSuccessLog: () => {},
    sendMongoStartupEmbed: async () => true,
    processCallWait: async () => order.push("call-wait"),
    retryCallWaitNotifications: async () => order.push("call-wait-retry"),
    scheduleCallWait: () => order.push("schedule"),
    startRepair: async () => order.push("repair"),
    startReconciliation: async () => order.push("reconciliation"),
    logger: { log: () => {}, warn: () => {}, error: () => {} },
    now: () => new Date("2026-08-06T00:00:00.000Z"),
  });

  await handler({ user: { tag: "test-bot" } });
  assert.deepEqual(order, [
    "watchdog", "migrate", "main", "panel", "board-start", "board-restore",
    "call-wait", "call-wait-retry", "schedule", "repair", "reconciliation",
  ]);
  assert.deepEqual(restoreState, { completed: true, failed: false, failures: [] });
  assert.deepEqual(recorded.results.map((result) => result.name), ["main", "panel"]);
});
