import { readBotImplementationSource } from "./source-under-test.js";
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { VoiceExitNoticeDeletion } from "../src/models/voice-exit-notice-deletion.js";
import { VoiceExitSchedule } from "../src/models/voice-exit-schedule.js";
import { normalizeGuildSettings } from "../src/settings-store.js";

test("退出予定はサーバー・利用者単位で一意に永続化し、通知実行状態を持つ", () => {
  assert.equal(VoiceExitSchedule.schema.indexes().some(([key, options]) => key.guildId === 1 && key.userId === 1 && options.unique), true);
  assert.equal(VoiceExitSchedule.schema.path("scheduledAt").instance, "Date");
  assert.deepEqual(VoiceExitSchedule.schema.path("status").enumValues, ["scheduled", "executing"]);
  assert.equal(VoiceExitNoticeDeletion.schema.path("deleteAt").instance, "Date");
});
test("新規の退出予定保存も通常オブジェクトを返す", async () => {
  const store = await readFile(new URL("../src/voice-exit-schedule-store.js", import.meta.url), "utf8");
  assert.match(store, /const created = await VoiceExitSchedule\.create\([\s\S]*?return created\.toObject\(\);/);
  assert.match(store, /returnDocument: "after", lean: true/);
});

test("退出予定の既存設定は通知を残す既定値になる", () => {
  assert.equal(normalizeGuildSettings({}).voiceExitScheduleKeepMessage, true);
  assert.equal(normalizeGuildSettings({ voiceExitScheduleKeepMessage: false }).voiceExitScheduleKeepMessage, false);
});

test("VCパネルは退出予定の固定候補、限定メンション、旧タイマー無効化を実装する", async () => {
  const source = await readFile(new URL("../src/voice-channel-control-service.js", import.meta.url), "utf8");
  assert.match(source, /\[5, "5分後"\][\s\S]*?\[120, "2時間後"\]/);
  assert.match(source, /label: "予定をキャンセル", value: EXIT_CANCEL/);
  assert.match(source, /allowedMentions: \{ parse: \[\], users: \[claimed\.userId\], roles: \[\]/);
  assert.match(source, /claimVoiceExitSchedule/);
  assert.match(source, /clearLegacyVoiceControlTimers/);
  assert.match(source, /この機能は終了しました。最新のVCコントロールパネルをご利用ください。/);
});

test("中断したexecuting予定はscheduledへ戻さず、条件付きで回収する", async () => {
  const store = await readFile(new URL("../src/voice-exit-schedule-store.js", import.meta.url), "utf8");
  const service = await readFile(new URL("../src/voice-channel-control-service.js", import.meta.url), "utf8");
  assert.match(store, /listInterruptedVoiceExitSchedules[\s\S]*?status: "executing"/);
  assert.match(store, /removeInterruptedVoiceExitSchedule[\s\S]*?_id: id, status: "executing"/);
  assert.match(service, /for \(const schedule of await listInterruptedVoiceExitSchedules\(\)\)[\s\S]*?removeInterruptedVoiceExitSchedule/);
  assert.match(service, /中断executing回収/);
});

test("通知送信の成功後処理は再送対象にせず、削除予約の保存済みIDを使う", async () => {
  const source = await readFile(new URL("../src/voice-channel-control-service.js", import.meta.url), "utf8");
  const sendIndex = source.indexOf("message = await channel.send");
  const postProcessIndex = source.indexOf("const settings = await getSettings(activeGuild)", sendIndex);
  assert.ok(sendIndex >= 0 && postProcessIndex > sendIndex);
  assert.match(source, /const persistedNotice = await createVoiceExitNoticeDeletion\(notice\);\s*scheduleNoticeDeletion\(activeGuild, persistedNotice\);/);
  assert.match(source, /if \(notice\._id\) await deleteVoiceExitNoticeDeletion\(notice\._id\)/);
  assert.match(source, /const persistedNotice = await createVoiceExitNoticeDeletion\(notice\);/);
});

test("VC外では有効なscheduled予定のキャンセルメニューだけを開ける", async () => {
  const source = await readFile(new URL("../src/voice-channel-control-service.js", import.meta.url), "utf8");
  assert.match(source, /current\?\.status === "scheduled"\) await showExitScheduleMenu/);
  assert.match(source, /if \(interaction\.member\?\.voice\?\.channelId !== channel\.id\) return replyNotInVoice/);
});

test("退出予定通知の保持設定は未設定でも「残す」と表示する", async () => {
  const source = await readBotImplementationSource();
  assert.match(source, /voiceExitScheduleKeepMessage !== false \? "はい" : "いいえ"/);
  assert.match(source, /category、notify_role、exit_schedule_keep_message のいずれかを指定してください。/);
});

test("退出予定の内部ログはVCをフォールバック送信先にしない", async () => {
  const source = await readFile(new URL("../src/voice-channel-control-service.js", import.meta.url), "utf8");
  const logStart = source.indexOf("const logFailure");
  const logEnd = source.indexOf("const logInfo", logStart);
  const logFailure = source.slice(logStart, logEnd);
  assert.match(logFailure, /fallbackChannel: null/);
  assert.doesNotMatch(logFailure, /guild\.channels/);
  assert.match(logFailure, /if \(!sent\) console\.error/);
});

test("中断executingの正常回収は失敗ログではなく運用情報として記録する", async () => {
  const source = await readFile(new URL("../src/voice-channel-control-service.js", import.meta.url), "utf8");
  const restoreStart = source.indexOf("async function restore");
  const restoreEnd = source.indexOf("async function cleanup", restoreStart);
  const restore = source.slice(restoreStart, restoreEnd);
  assert.match(restore, /退出予定の中断状態を起動時に回収しました。/);
  assert.match(restore, /await logInfo\(content, schedule, guild\)/);
  assert.doesNotMatch(restore, /logFailure\("中断executing回収", schedule, new Error/);
});

test("初回登録の予定もDocumentを正規化し、正しいIDで通知claimする", async () => {
  const source = await readFile(new URL("../src/voice-channel-control-service.js", import.meta.url), "utf8");
  assert.match(source, /typeof schedule\?\.toObject === "function" \? schedule\.toObject\(\) : schedule/);
  assert.match(source, /schedule\?\._id && schedule\.guildId && schedule\.userId && schedule\.voiceChannelId && schedule\.scheduledAt/);
  assert.match(source, /claimVoiceExitSchedule\(normalizedSchedule\._id\)/);
  assert.match(source, /void notify\(\{ \.\.\.normalizedSchedule, guild \}\)/);
  assert.match(source, /console\.error\("退出予定タイマーを登録できません:/);
});
