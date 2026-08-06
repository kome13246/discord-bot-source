import { readBotImplementationSource } from "./source-under-test.js";
import test from "node:test";
import assert from "node:assert/strict";
import {
  createEveryonePermissionSnapshot,
  countUniqueParticipantIds,
  editEveryoneConnectPermission,
  formatSplitClosingThanks,
  getJstScheduledTime,
  getRestorePermissionPatch,
  permissionSnapshotMatches,
  isKokuchiCallWaitPause,
  resolveKokuchiGatheringVoiceChannelId,
} from "../src/kokuchi-utils.js";
import { canCloseGatheringVcAfterSplit } from "../src/kokuchi-event-state.js";
import { mergeGuildSettingsWithEnvironmentDefaults, normalizeGuildSettings } from "../src/settings-store.js";
import { readFile } from "node:fs/promises";

test("集合VCの開放時刻は/kokuchi実行日のJST指定時刻を正しく扱う", () => {
  assert.equal(
    getJstScheduledTime(new Date("2026-01-01T14:30:00.000Z"), 20, 40).toISOString(),
    "2026-01-01T11:40:00.000Z",
  );
  assert.equal(
    getJstScheduledTime(new Date("2026-01-01T15:30:00.000Z"), 20, 40).toISOString(),
    "2026-01-02T11:40:00.000Z",
  );
});
test("環境変数の集合VC設定は/kokuchiのスケジュール保存後も維持する", () => {
  const merged = mergeGuildSettingsWithEnvironmentDefaults(
    { gatheringVoiceChannelId: "environment-voice" },
    {
      gatheringVcUnlockAt: "2026-01-01T11:40:00.000Z",
      gatheringVcUnlockState: "pending",
    },
  );

  assert.equal(merged.gatheringVoiceChannelId, "environment-voice");
  assert.equal(merged.gatheringVcUnlockState, "pending");
  assert.equal(
    mergeGuildSettingsWithEnvironmentDefaults(
      { gatheringVoiceChannelId: "environment-voice" },
      { gatheringVoiceChannelId: "stored-voice" },
    ).gatheringVoiceChannelId,
    "stored-voice",
  );
});

test("/kokuchi開始時の集合VC設定を話題選択後もスケジュールへ固定する", () => {
  assert.equal(
    resolveKokuchiGatheringVoiceChannelId(
      { gatheringVoiceChannelId: "environment-voice" },
      { wadaiCurrentTopic: { text: "話題" } },
    ),
    "environment-voice",
  );
});

test("集合VCの@everyoneへViewChannelとConnectを明示的に更新する", async () => {
  const calls = [];
  const channel = {
    permissionOverwrites: {
      edit: async (...args) => {
        calls.push(args);
        return channel;
      },
    },
  };

  const changed = await editEveryoneConnectPermission({
    channel,
    guildId: "guild-id-is-everyone-role-id",
    canConnect: true,
    reason: "会話練習会の集合VCを開放",
  });

  assert.equal(changed, true);
  assert.deepEqual(calls, [[
    "guild-id-is-everyone-role-id",
    { ViewChannel: true, Connect: true },
    { reason: "会話練習会の集合VCを開放" },
  ]]);
});

test("集合VCのViewChannelとConnectは元の許可・拒否・未設定へ正確に復元する", () => {
  const permissions = { ViewChannel: "view", Connect: "connect" };
  const overwrite = (allow = [], deny = []) => ({
    allow: { has: (permission) => allow.includes(permission) },
    deny: { has: (permission) => deny.includes(permission) },
  });
  const snapshot = createEveryonePermissionSnapshot({
    channelId: "vc",
    guildId: "guild",
    overwrite: overwrite(["view"], ["connect"]),
    permissions,
  });
  assert.deepEqual(snapshot, { channelId: "vc", guildId: "guild", viewChannel: true, connect: false });
  assert.deepEqual(
    getRestorePermissionPatch({ snapshot, overwrite: overwrite(["view", "connect"]), permissions }),
    { Connect: false },
  );
  assert.deepEqual(
    getRestorePermissionPatch({
      snapshot: { ...snapshot, viewChannel: null, connect: null },
      overwrite: overwrite(["view", "connect"]),
      permissions,
    }),
    { ViewChannel: null, Connect: null },
  );
  assert.deepEqual(
    getRestorePermissionPatch({ snapshot, overwrite: overwrite([], ["connect"]), permissions }),
    { ViewChannel: true },
  );
});

test("saved true, false, and inherited permissions are restored from the snapshot", () => {
  const permissions = { ViewChannel: "view", Connect: "connect" };
  const overwrite = (allow = [], deny = []) => ({
    allow: { has: (permission) => allow.includes(permission) },
    deny: { has: (permission) => deny.includes(permission) },
  });
  const states = [
    { saved: true, current: false, expected: true },
    { saved: false, current: true, expected: false },
    { saved: null, current: true, expected: null },
  ];
  for (const state of states) {
    const snapshot = { channelId: "vc", guildId: "guild", viewChannel: state.saved, connect: state.saved };
    const current = state.current ? overwrite(["view", "connect"]) : overwrite([], ["view", "connect"]);
    const patch = getRestorePermissionPatch({ snapshot, overwrite: current, permissions });
    assert.equal(patch.ViewChannel, state.expected === state.current ? undefined : state.expected);
    assert.equal(permissionSnapshotMatches({ snapshot, overwrite: current, permissions }), state.saved === state.current);
  }
  assert.equal(
    permissionSnapshotMatches({ snapshot: { channelId: "vc", guildId: "guild", viewChannel: true, connect: true }, overwrite: overwrite([], []), permissions }),
    false,
  );
});

test("only the matching opened kokuchi event and split session may create restore-pending state", () => {
  const base = {
    eventId: "event-a",
    settings: { kokuchiEventId: "event-a", gatheringVcStateEventId: "event-a" },
    event: {
      reservationId: "event-a",
      kokuchiStatus: "running",
      gatheringVcUnlockState: "opened",
      gatheringVcOpenedAt: new Date(),
      gatheringVcUnlockChannelId: "vc-a",
      gatheringVcPermissionBeforeOpen: { channelId: "vc-a", guildId: "guild", viewChannel: true, connect: null },
      gatheringVcRestoreStatus: "not_required",
      gatheringVcRestorePending: false,
    },
    session: { kokuchiEventId: "event-a" },
    targetChannelId: "vc-a",
    guildId: "guild",
  };
  assert.equal(canCloseGatheringVcAfterSplit(base), true);
  assert.equal(canCloseGatheringVcAfterSplit({ ...base, eventId: "event-b", settings: { ...base.settings, kokuchiEventId: "event-b", gatheringVcStateEventId: "event-b" } }), false);
  assert.equal(canCloseGatheringVcAfterSplit({ ...base, event: { ...base.event, reservationId: "event-other" } }), false);
  assert.equal(canCloseGatheringVcAfterSplit({ ...base, event: { ...base.event, gatheringVcPermissionBeforeOpen: { channelId: "vc-a", guildId: "guild" } } }), false);
  assert.equal(canCloseGatheringVcAfterSplit({ ...base, event: { ...base.event, gatheringVcUnlockChannelId: "vc-old" }, targetChannelId: "vc-a" }), false);
  assert.equal(canCloseGatheringVcAfterSplit({ ...base, session: { kokuchiEventId: "event-other" } }), false);
  assert.equal(canCloseGatheringVcAfterSplit({ ...base, event: { ...base.event, gatheringVcRestorePending: true, gatheringVcRestoreStatus: "pending" } }), false);
  assert.equal(canCloseGatheringVcAfterSplit({ ...base, event: { ...base.event, gatheringVcUnlockState: "closed" } }), false);
});

test("集合VCは分割直後に拒否し、ロール解除後または再起動復元で復元する", async () => {
  const source = await readBotImplementationSource();
  const close = source.slice(source.indexOf("async function closeGatheringVcAfterSplit"), source.indexOf("async function setGatheringVcConnectPermission"));

  assert.match(close, /canConnect: false/);
  assert.doesNotMatch(close, /restoreGatheringVcPermissionAfterSplit/);
  assert.match(close, /findOneAndUpdate\(/);
  assert.match(close, /gatheringVcUnlockState: "closing"/);
  assert.match(close, /gatheringVcRestoreStatus: "pending"/);
  assert.match(close, /finalized\.matchedCount !== 1/);
  assert.match(source, /gatheringVcRestorePending: true/);
  assert.match(source, /restoreGatheringVcPermissionAfterSplit\(guild, settings,/);
  assert.match(source, /async function restorePendingGatheringVcPermissions/);
  assert.match(source, /expectedEventRevision/);
  assert.match(source, /beforePersist/);
  assert.match(source, /afterDiscord/);
  assert.match(source, /eventState = await KokuchiReservation\.findOne/);
  assert.match(source, /reservation\.reservationId, force: true/);
});

test("旧設定は安全にkokuchi・ボタン式・定時募集間隔の現在形式へ正規化する", () => {
  const old = normalizeGuildSettings({
    callWaitMode: "reaction",
    kokuchiGatheringReminderRoleIds: ["role-a", "role-a", "role-b"],
  });
  assert.equal(old.callWaitMode, "button");
  assert.equal(old.callWaitIntervalMinutes, 30);
  assert.equal(old.kokuchiEventTime, "21:00");
  assert.deepEqual(old.kokuchiMentionRoleIds, ["role-a", "role-b"]);
  assert.deepEqual(normalizeGuildSettings(old), old);
});

test("定時募集はJST 20:00から21:59まで停止する", () => {
  const settings = { lastKokuchiPostedAt: "2026-01-01T05:00:00.000Z" };

  assert.equal(isKokuchiCallWaitPause(settings, new Date("2026-01-01T10:59:59.999Z")), false);
  assert.equal(isKokuchiCallWaitPause(settings, new Date("2026-01-01T11:00:00.000Z")), true);
  assert.equal(isKokuchiCallWaitPause(settings, new Date("2026-01-01T12:59:59.999Z")), true);
  assert.equal(isKokuchiCallWaitPause(settings, new Date("2026-01-01T13:00:00.000Z")), false);
});

test("/kokuchiを実行していない日には定時募集を停止しない", () => {
  const settings = { lastKokuchiPostedAt: "2025-12-31T05:00:00.000Z" };

  assert.equal(
    isKokuchiCallWaitPause(settings, new Date("2026-01-01T11:00:00.000Z")),
    false,
  );
});

test("終了お礼は途中参加を含むユニーク参加人数を表示できる", () => {
  const participantCount = countUniqueParticipantIds([
    "initial-member",
    "midway-member",
    "initial-member",
  ]);

  assert.equal(
    formatSplitClosingThanks({
      feedbackChannelId: "1513457664041160765",
      nextWeekday: "土曜日",
      participantCount,
    }),
    [
      "ご参加いただきありがとうございました！！",
      "今回の参加人数は2人でした！",
      "",
      "やってみての意見や苦情等があれば",
      " <#1513457664041160765> からお願いします！",
      "",
      "次回(土曜日)もぜひご参加ください！",
    ].join("\n"),
  );
});

test("/remove role marks removed temporary-role grants as removed", async () => {
  const source = await readBotImplementationSource();
  const handler = source.slice(source.indexOf("async function handleRemoveRole"), source.indexOf("async function handleKokuchiSetting"));

  assert.match(handler, /VoiceParticipantRoleGrant\.updateMany/);
  assert.match(handler, /status: "removed"/);
  assert.match(handler, /cleanupAt:/);
});

test("role-removal wait defaults are 150 minutes and explicit saved values are preserved", async () => {
  const source = await readBotImplementationSource();
  const env = await readFile(new URL("../.env.example", import.meta.url), "utf8");
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  const commands = await readFile(new URL("../src/commands.js", import.meta.url), "utf8");
  assert.match(source, /DEFAULT_ROLE_REMOVE_WAIT_MINUTES = 150/);
  assert.match(env, /PB_ROLE_REMOVE_WAIT_MINUTES=150/);
  assert.match(readme, /role_remove_wait_minutes:150/);
  assert.match(readme, /`role_remove_wait_minutes` \| 分 \| 150/);
  assert.match(commands, /省略時は150分/);
  assert.equal(normalizeGuildSettings({}).roleRemoveWaitMinutes, 150);
  assert.equal(normalizeGuildSettings({ roleRemoveWaitMinutes: 150 }).roleRemoveWaitMinutes, 150);
  assert.equal(normalizeGuildSettings({ roleRemoveWaitMinutes: 17 }).roleRemoveWaitMinutes, 17);
  assert.equal(normalizeGuildSettings({ roleRemoveWaitMinutes: 0 }).roleRemoveWaitMinutes, 0);
});
