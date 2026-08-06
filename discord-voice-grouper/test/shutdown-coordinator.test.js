import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createShutdownController, registerProcessShutdownHandlers } from "../src/app/shutdown-coordinator.js";

test("終了処理は一度だけサービス・タイマー・Discord・MongoDBを停止する", async () => {
  const order = [];
  const timer = setTimeout(() => {}, 60_000);
  const timers = new Map([["timer", timer]]);
  const exits = [];
  const controller = createShutdownController({
    stopServices: [async () => order.push("service")],
    clearStandaloneTimers: [() => order.push("standalone")],
    timerCollections: [timers],
    destroyClient: () => order.push("discord"),
    disconnectDatabase: async () => order.push("mongo"),
    exit: (code) => exits.push(code),
    logger: { log: () => {}, error: () => {} },
  });

  await controller.shutdown({ signal: "SIGTERM", exitCode: 0 });
  await controller.shutdown({ signal: "SIGINT", exitCode: 1 });
  assert.equal(controller.isShuttingDown(), true);
  assert.deepEqual(order, ["service", "standalone", "discord", "mongo"]);
  assert.equal(timers.size, 0);
  assert.deepEqual(exits, [0]);
});

test("プロセスシグナルは終了処理へ変換される", async () => {
  const processTarget = new EventEmitter();
  const calls = [];
  registerProcessShutdownHandlers({
    processTarget,
    shutdown: async (payload) => { calls.push(payload); },
    logger: { error: () => {} },
  });
  processTarget.emit("SIGTERM");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [{ signal: "SIGTERM", exitCode: 0 }]);
});
