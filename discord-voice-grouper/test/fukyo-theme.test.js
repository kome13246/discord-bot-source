import test from "node:test";
import assert from "node:assert/strict";
import { FUKYO_MESSAGE, cleanFukyoThemeName, createFukyoThemeService, getLatestDueFukyoSlot, getNextFukyoSlot, normalizeFukyoThemeName, selectFukyoTheme } from "../src/fukyo-theme-service.js";

test("テーマ名は表示用の安全な一行と重複比較用の正規形に分ける", () => {
  assert.equal(cleanFukyoThemeName("  ゲーム\n\t"), "ゲーム");
  assert.equal(normalizeFukyoThemeName(" ＧＡＭＥ   Test "), "game test");
  assert.equal(normalizeFukyoThemeName("ゲーム"), normalizeFukyoThemeName(" ゲーム "));
});

test("投稿本文は確定文面でメンションなし送信用の本文になる", () => {
  assert.equal(FUKYO_MESSAGE("ゲーム"), "【週替わりテーマ】\n今週のテーマは「ゲーム」です！\nぜひお薦めしていってください！\n\n週替わりテーマ以外の投稿も大歓迎です！");
});

test("ランダム選択は一巡するまで重複せず、次回に一巡を更新する", () => {
  const themes = ["a", "b", "c", "d"].map((id) => ({ id, name: id, normalizedName: id }));
  let state = { usedThemeIds: [], cycleNumber: 0 };
  const selected = [];
  for (let index = 0; index < 4; index += 1) {
    const result = selectFukyoTheme(themes, state, null, () => 0);
    selected.push(result.selected.id);
    state = { ...result.state, usedThemeIds: [...result.state.usedThemeIds, result.selected.id] };
  }
  assert.deepEqual(selected, ["a", "b", "c", "d"]);
  const next = selectFukyoTheme(themes, state, null, () => 0);
  assert.equal(next.selected.id, "a");
  assert.equal(next.state.cycleNumber, 1);
});

test("削除済みテーマは使用済み履歴から除外し、番号指定は一巡をリセットしない", () => {
  const themes = ["a", "c"].map((id) => ({ id, name: id, normalizedName: id }));
  const random = selectFukyoTheme(themes, { usedThemeIds: ["a", "deleted"], cycleNumber: 4 }, null, () => 0);
  assert.equal(random.selected.id, "c");
  assert.deepEqual(random.state.usedThemeIds, ["a"]);
  const explicit = selectFukyoTheme(themes, { usedThemeIds: ["a", "c"], cycleNumber: 4 }, 0, () => 0);
  assert.equal(explicit.selected.id, "a");
  assert.equal(explicit.state.cycleNumber, 4);
});

test("JSTの次回月曜日6時をサーバー時刻に依存せず求める", () => {
  assert.equal(getNextFukyoSlot(new Date("2026-08-02T00:00:00Z")).weekKey, "2026-08-03"); // Sunday JST
  assert.equal(getNextFukyoSlot(new Date("2026-08-02T20:59:00Z")).weekKey, "2026-08-03"); // Monday 05:59 JST
  assert.equal(getNextFukyoSlot(new Date("2026-08-02T21:01:00Z")).weekKey, "2026-08-10"); // Monday 06:01 JST
  assert.equal(getNextFukyoSlot(new Date("2026-12-27T21:01:00Z")).weekKey, "2027-01-04");
});

test("起動時補完の対象は直近で到来済みのJST月曜日6時の週だけ", () => {
  assert.equal(getLatestDueFukyoSlot(new Date("2026-08-02T20:59:00Z")).weekKey, "2026-07-27");
  assert.equal(getLatestDueFukyoSlot(new Date("2026-08-02T21:00:00Z")).weekKey, "2026-08-03");
  assert.equal(getLatestDueFukyoSlot(new Date("2026-08-02T21:01:00Z")).weekKey, "2026-08-03");
});

test("布教設定の有効化は管理設定とenabledAtのcompanion patchを同じversioned writerへ渡す", async () => {
  const writes = [];
  const replies = [];
  const service = createFukyoThemeService({
    getGuildSettings: async () => ({ guildId: "guild1", configRevision: 4, fukyoWeeklyThemeEnabled: false }),
    saveGuildSettings: async () => { throw new Error("runtime writer must not handle enabledAt"); },
    saveVersionedGuildConfiguration: async (...args) => {
      writes.push(args);
      return { guildId: "guild1", configRevision: 5, fukyoWeeklyThemeEnabled: true, fukyoThemeChannelId: null };
    },
    sendOperationalLog: async () => {},
    acquireMongoLease: async () => ({ leaseId: "lease" }),
    releaseMongoLease: async () => {},
  });
  await service.updateSetting({
    guildId: "guild1",
    user: { id: "actor" },
    options: {
      getChannel: () => null,
      getBoolean: () => true,
    },
    reply: async (payload) => replies.push(payload),
  });
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0][0], "guild1");
  assert.deepEqual(writes[0][1], { fukyoWeeklyThemeEnabled: true });
  assert.equal(writes[0][2].expectedRevision, 4);
  assert.equal(writes[0][2].companionPatch.fukyoWeeklyThemeEnabledAt instanceof Date, true);
  assert.equal(replies.length, 1);
});
