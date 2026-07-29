import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { settingCommand } from "../src/commands.js";

test("20:55集合通知のメンション先はサーバー設定として登録できる", () => {
  const command = settingCommand.toJSON();
  const splitvc = command.options.find((option) => option.name === "splitvc");
  const roleOption = splitvc.options.find(
    (option) => option.name === "kokuchi_gathering_reminder_role",
  );

  assert.equal(roleOption?.type, 8); // Discord application-command role option
});

test("20:55集合通知は固定IDではなく設定値を使い、送信前に原子的に確保する", async () => {
  const source = await readFile(new URL("../src/bot.js", import.meta.url), "utf8");

  assert.doesNotMatch(source, /KOKUCHI_GATHERING_REMINDER_ROLE_IDS/);
  assert.doesNotMatch(source, /KOKUCHI_GATHERING_REMINDER_VOICE_CHANNEL_ID/);
  assert.match(source, /transitionKokuchiGatheringReminder\(\{[\s\S]*toState: "sending"/);
  assert.match(source, /getGatheringVcUnlockChannelId\(claimed\)/);
  assert.match(source, /claimed\.kokuchiGatheringReminderRoleIds/);
});

test("20:30・20:40・20:55の実行中処理は再起動時に未確認として扱い、重複再送しない", async () => {
  const source = await readFile(new URL("../src/settings-store.js", import.meta.url), "utf8");
  const botSource = await readFile(new URL("../src/bot.js", import.meta.url), "utf8");

  assert.match(source, /recoverInterruptedKokuchiGatheringReminders/);
  assert.match(source, /kokuchiGatheringReminderState: "unconfirmed"/);
  assert.match(source, /kokuchiPreNoticeState: "sent_unconfirmed"/);
  assert.match(source, /gatheringVcUnlockState: "sent_unconfirmed"/);
  assert.match(botSource, /stateKey: "kokuchiPreNoticeState"[\s\S]*toState: "processing"/);
  assert.match(botSource, /stateKey: "gatheringVcUnlockState"[\s\S]*toState: "processing"/);
});
