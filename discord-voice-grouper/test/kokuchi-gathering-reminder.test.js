import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { settingCommand } from "../src/commands.js";

test("告知時刻と集合通知のメンション先は /setting kokuchi で登録できる", () => {
  const command = settingCommand.toJSON();
  const kokuchi = command.options.find((option) => option.name === "kokuchi");
  const roleOption = kokuchi.options.find((option) => option.name === "mention_role");

  assert.equal(roleOption?.type, 8); // Discord application-command role option
  assert.equal(kokuchi.options.find((option) => option.name === "event_time")?.type, 3);
  assert.equal(kokuchi.options.find((option) => option.name === "announcement_channel")?.type, 7);
  assert.equal(kokuchi.options.some((option) => option.name === "wadaich"), false);
});

test("告知後キャンセルは開催回単位でタイマーと永続アクションを停止する", async () => {
  const source = await readFile(new URL("../src/bot.js", import.meta.url), "utf8");
  const store = await readFile(new URL("../src/settings-store.js", import.meta.url), "utf8");
  const actionStore = await readFile(new URL("../src/scheduled-action-store.js", import.meta.url), "utf8");

  const handler = source.slice(source.indexOf("async function handleKokuchiReservationCancel"), source.indexOf("async function restoreKokuchiReservations"));
  assert.match(handler, /status: \{ \$in: \["pending", "sent", "cancel_partial"\] \}/);
  assert.match(handler, /status: "canceling"/);
  assert.match(handler, /status === "canceled" \? "【キャンセル完了】" : "【キャンセル一部完了】"/);
  assert.match(handler, /clearKokuchiPreNoticeTimer/);
  assert.match(handler, /clearGatheringVcUnlockTimer/);
  assert.match(handler, /clearKokuchiGatheringReminderTimer/);
  assert.match(handler, /cancelKokuchiTimedActions/);
  assert.match(handler, /cancelKokuchiScheduledActions/);
  assert.match(store, /async function cancelKokuchiTimedActions/);
  assert.match(actionStore, /async function cancelKokuchiScheduledActions/);
  assert.match(store, /returnDocument: "before"/);
  assert.match(actionStore, /ScheduledAction\.findOneAndUpdate/);
});

test("集合リマインダーは設定値を使い、送信前に原子的に確保する", async () => {
  const source = await readFile(new URL("../src/bot.js", import.meta.url), "utf8");

  assert.doesNotMatch(source, /KOKUCHI_GATHERING_REMINDER_ROLE_IDS/);
  assert.doesNotMatch(source, /KOKUCHI_GATHERING_REMINDER_VOICE_CHANNEL_ID/);
  assert.match(source, /transitionKokuchiGatheringReminder\(\{[\s\S]*toState: "sending"/);
  assert.match(source, /getGatheringVcUnlockChannelId\(claimed\)/);
  assert.match(source, /claimed\.kokuchiMentionRoleIds/);
});

test("告知時刻から算出した処理は再起動時に未確認として扱い、重複再送しない", async () => {
  const source = await readFile(new URL("../src/settings-store.js", import.meta.url), "utf8");
  const botSource = await readFile(new URL("../src/bot.js", import.meta.url), "utf8");

  assert.match(source, /recoverInterruptedKokuchiGatheringReminders/);
  assert.match(source, /kokuchiGatheringReminderState: "unconfirmed"/);
  assert.match(source, /kokuchiPreNoticeState: "sent_unconfirmed"/);
  assert.match(source, /gatheringVcUnlockState: "sent_unconfirmed"/);
  assert.match(botSource, /stateKey: "kokuchiPreNoticeState"[\s\S]*toState: "processing"/);
  assert.match(botSource, /stateKey: "gatheringVcUnlockState"[\s\S]*toState: "processing"/);
});

test("immediate and reserved kokuchi pass their own event identity to publication", async () => {
  const source = await readFile(new URL("../src/bot.js", import.meta.url), "utf8");
  const handle = source.slice(source.indexOf("async function handleKokuchi(interaction)"), source.indexOf("async function publishImmediateKokuchi"));
  const process = source.slice(source.indexOf("async function processKokuchiReservation"), source.indexOf("async function resumeKokuchiPostProcessing"));

  assert.doesNotMatch(handle, /eventAt: reservation\.eventAt/);
  assert.match(process, /Reserved kokuchi has no valid eventAt/);
  assert.match(process, /eventAt,/);
  assert.match(process, /kokuchiEventId: reservation\.reservationId/);
});

test("kokuchi prevents a new event while a prior event still owns timed work", async () => {
  const source = await readFile(new URL("../src/bot.js", import.meta.url), "utf8");
  const handle = source.slice(source.indexOf("function hasActiveKokuchiEvent"), source.indexOf("async function publishImmediateKokuchi"));

  assert.match(handle, /gatheringVcRestorePending === true/);
  assert.match(handle, /status: \{ \$in: \["canceling", "cancel_partial"\] \}/);
  assert.match(handle, /前回のkokuchiに関連する処理がまだ完了していません/);
});

test("split cancellation restores pending gathering VC permissions and remove-role classifies each member once", async () => {
  const source = await readFile(new URL("../src/bot.js", import.meta.url), "utf8");
  const close = source.slice(source.indexOf("async function closeSplitWithoutFeedback"), source.indexOf("async function sendClaimedSplitFinishNotice"));
  const remove = source.slice(source.indexOf("async function handleRemoveRole"), source.indexOf("async function handleKokuchiSetting"));

  assert.match(close, /gatheringVcRestorePending/);
  assert.match(close, /restoreGatheringVcPermissionAfterSplit/);
  assert.match(remove, /fullySucceeded/);
  assert.match(remove, /partiallySucceeded/);
  assert.match(remove, /fullyFailed/);
});
