import test from "node:test";
import assert from "node:assert/strict";
import {
  createCallWaitSlotKey,
  getJstCallWaitSlots,
  getMsUntilNextJstCallWaitSlot,
  isJstCallWaitSlotDue,
  normalizeCallWaitIntervalMinutes,
} from "../src/call-wait-schedule-utils.js";

test("30分・45分・60分の次回スロットはJST 0:00基準で計算される", () => {
  const now = new Date("2026-07-30T14:20:05.000Z"); // 23:20:05 JST

  assert.equal(getJstCallWaitSlots({ now, intervalMinutes: 30 }).nextSlot.toISOString(), "2026-07-30T14:30:00.000Z");
  assert.equal(getJstCallWaitSlots({ now, intervalMinutes: 45 }).nextSlot.toISOString(), "2026-07-30T15:00:00.000Z");
  assert.equal(getJstCallWaitSlots({ now, intervalMinutes: 60 }).nextSlot.toISOString(), "2026-07-30T15:00:00.000Z");
});

test("45分間隔は日付変更後に翌日のJST 0:00へ戻る", () => {
  const now = new Date("2026-07-30T14:50:00.000Z"); // 23:50 JST
  const slots = getJstCallWaitSlots({ now, intervalMinutes: 45 });

  assert.equal(slots.currentSlot.toISOString(), "2026-07-30T14:15:00.000Z");
  assert.equal(slots.nextSlot.toISOString(), "2026-07-30T15:00:00.000Z");
  assert.equal(slots.nextSlotKey, "2026-07-31:0000:45");
});

test("再起動時に同じ設定と現在時刻なら同じ次回スロットとキーになる", () => {
  const now = new Date("2026-07-30T15:01:12.000Z"); // 00:01:12 JST
  const first = getJstCallWaitSlots({ now, intervalMinutes: 45 });
  const restarted = getJstCallWaitSlots({ now, intervalMinutes: 45 });

  assert.equal(first.nextSlot.toISOString(), "2026-07-30T15:45:00.000Z");
  assert.equal(first.nextSlotKey, restarted.nextSlotKey);
  assert.equal(createCallWaitSlotKey(first.nextSlot, 45), restarted.nextSlotKey);
});

test("スロットの数秒後は同じスロットとして扱い、猶予外は処理しない", () => {
  assert.equal(isJstCallWaitSlotDue({ now: new Date("2026-07-30T15:45:05.000Z"), intervalMinutes: 45 }), true);
  assert.equal(isJstCallWaitSlotDue({ now: new Date("2026-07-30T15:47:01.000Z"), intervalMinutes: 45 }), false);
  assert.equal(getMsUntilNextJstCallWaitSlot({ now: new Date("2026-07-30T15:44:59.000Z"), intervalMinutes: 45 }), 1000);
});

test("不正または未設定の間隔は従来どおり30分へ正規化される", () => {
  assert.equal(normalizeCallWaitIntervalMinutes(undefined), 30);
  assert.equal(normalizeCallWaitIntervalMinutes(15), 30);
  assert.equal(normalizeCallWaitIntervalMinutes(60), 60);
});
