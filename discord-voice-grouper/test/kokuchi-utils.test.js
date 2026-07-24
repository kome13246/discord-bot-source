import test from "node:test";
import assert from "node:assert/strict";
import {
  countUniqueParticipantIds,
  editEveryoneConnectPermission,
  formatSplitClosingThanks,
  getJstScheduledTime,
  isKokuchiCallWaitPause,
  resolveKokuchiGatheringVoiceChannelId,
} from "../src/kokuchi-utils.js";
import { mergeGuildSettingsWithEnvironmentDefaults } from "../src/settings-store.js";

test("集合VCの開放時刻は/kokuchi実行日のJST 20:40になる", () => {
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

test("集合VCの@everyoneへConnect許可を明示的に更新する", async () => {
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
    reason: "会話練習会の集合VCを20:40に開放",
  });

  assert.equal(changed, true);
  assert.deepEqual(calls, [[
    "guild-id-is-everyone-role-id",
    { Connect: true },
    { reason: "会話練習会の集合VCを20:40に開放" },
  ]]);
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
