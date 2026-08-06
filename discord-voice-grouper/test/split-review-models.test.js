import { readBotImplementationSource } from "./source-under-test.js";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { commands } from "../src/commands.js";
import { SplitReview } from "../src/models/split-review.js";
import { SplitReviewDraft } from "../src/models/split-review-draft.js";
import { SplitProcessSession } from "../src/models/split-process-session.js";

async function readSplitSources() {
  const sources = await Promise.all([
    readBotImplementationSource(),
    readFile(new URL("../src/features/split-review.js", import.meta.url), "utf8"),
  ]);
  return sources.join("\n");
}

test("感想コマンドと送信先オプションが登録されている", () => {
  const show = commands.find((command) => command.name === "show");
  const setting = commands.find((command) => command.name === "setting");
  assert.ok(show?.options?.some((option) => option.name === "review"));
  const forms = setting?.options?.find((option) => option.name === "forms");
  assert.ok(forms?.options?.some((option) => option.name === "review_send_channel"));
});

test("感想回答はセッションごとに一人一回答", () => {
  const index = SplitReview.schema.indexes().find(([fields, options]) => fields.guildId === 1 && fields.splitSessionId === 1 && fields.userId === 1 && options.unique);
  assert.ok(index);
});

test("感想下書きは一意かつ期限でTTL削除される", () => {
  const indexes = SplitReviewDraft.schema.indexes();
  assert.ok(indexes.some(([fields, options]) => fields.guildId === 1 && fields.splitSessionId === 1 && fields.userId === 1 && options.unique));
  assert.ok(indexes.some(([fields, options]) => fields.expiresAt === 1 && options.expireAfterSeconds === 0));
});

test("感想の表示ラベルは質問ごとに分離され、未知の値は安全に表示する", async () => {
  const source = await readSplitSources();
  assert.match(source, /const TALK_AMOUNT_LABELS = \{/);
  assert.match(source, /const DURATION_FEELING_LABELS = \{/);
  assert.match(source, /const PRACTICE_EFFECT_LABELS = \{/);
  assert.match(source, /TALK_AMOUNT_LABELS\[claimed\.talkAmount\] \?\? "不明"/);
  assert.match(source, /DURATION_FEELING_LABELS\[claimed\.durationFeeling\] \?\? "不明"/);
  assert.match(source, /PRACTICE_EFFECT_LABELS\[claimed\.practiceEffect\] \?\? "不明"/);
});

test("全質問集計と終了通知は感想可否を安全に分岐する", async () => {
  const source = await readSplitSources();
  assert.match(source, /const renderedQuestions = \["1", "2", "3"\][\s\S]*?\.join\("\\n\\n"\)/);
  assert.doesNotMatch(source, /\.\.\.\["1", "2", "3"\]\.map\(\(key\) => renderQuestion\(fields\[key\]\)\)\.join/);
  assert.match(source, /question !== "all" && !fields\[question\]/);
  assert.match(source, /const finishContent = canReview/);
});

test("感想フォームは下書きが null でも未選択状態を表示できる", async () => {
  const source = await readSplitSources();
  assert.match(source, /function splitReviewRows\(sessionId, draft = \{\}\) \{\s*draft \?\?= \{\};/);
});

test("/splitvc はカウントダウン開始前に転送予定セッションを保存する", async () => {
  const source = await readBotImplementationSource();
  const persistAt = source.indexOf("await persistSplitProcessSession(splitSessionId, {");
  const countdownAt = source.indexOf("const transferCanceled = await runCountdown({");

  assert.ok(persistAt >= 0 && persistAt < countdownAt);
  assert.match(source.slice(persistAt, countdownAt), /plannedMemberIds: targetMembers\.map\(\(member\) => member\.id\)/);
  assert.ok(SplitProcessSession.schema.path("plannedMemberIds"));
});

test("splitvcの通常・途中参加転送は渡されたsplitSessionIdをロール付与の発生源に使う", async () => {
  const source = await readBotImplementationSource();
  const transfer = source.slice(source.indexOf("async function moveMemberWithParticipantRole"), source.indexOf("async function runWaitingRoomMonitor"));

  assert.match(transfer, /participantRoleGrantedMemberIds = null,\s*splitSessionId/);
  assert.match(transfer, /sourceId: config\.splitSessionId/);
  assert.match(source, /splitSessionId: options\.splitSessionId/);
  assert.match(transfer, /config\.splitSessionId/);
});

test("/splitvc は成功グループが0件なら後続処理を予約せず回収して失敗終了する", async () => {
  const source = await readBotImplementationSource();
  const start = source.indexOf("const transferResult = await transferGroups(groups");
  const end = source.indexOf("if (transferResult.groupSummaries.length > 0)", start);
  const failurePath = source.slice(start, end);

  assert.match(failurePath, /if \(transferResult\.groupSummaries\.length === 0\)/);
  assert.match(failurePath, /status: cleanupErrors\.length > 0 \? "cleanup_required" : "failed"/);
  assert.match(failurePath, /await removeRoleFromMembers\(/);
  assert.match(failurePath, /await channel\.delete\(/);
});

test("splitvc snapshots always retain their child channel identity", async () => {
  const source = await readBotImplementationSource();
  const start = source.indexOf("groupSnapshots: transferResult.groupSummaries.map");
  const end = source.indexOf("await scheduleAction", start);
  assert.ok(start >= 0 && end > start);
  const initialPersistence = source.slice(start, end);
  assert.match(initialPersistence, /groupNumber: summary\.groupNumber \?\? index \+ 1/);
  assert.match(initialPersistence, /channelId: summary\.channelId/);
  assert.match(initialPersistence, /memberIds: summary\.memberIds/);
});

test("splitvc acknowledges before taking its MongoDB lease", async () => {
  const source = await readFile(new URL("../src/features/voice-split.js", import.meta.url), "utf8");
  const start = source.indexOf("async function handleSplitVoice");
  const end = source.indexOf("\n  async function ", start + 1);
  assert.ok(start >= 0 && end > start);
  const handler = source.slice(start, end);
  const deferredAt = handler.indexOf("await deferCommandResponse");
  const leaseAt = handler.indexOf("await acquireMongoLease");
  const sessionCheckAt = handler.indexOf("await SplitProcessSession.exists");
  assert.ok(deferredAt >= 0 && deferredAt < leaseAt && deferredAt < sessionCheckAt);
});

test("splitvc acknowledges before fetching the bot member and keeps cancellation terminal", async () => {
  const source = await readFile(new URL("../src/features/voice-split.js", import.meta.url), "utf8");
  const start = source.indexOf("async function handleSplitVoice");
  const end = source.indexOf("\n  async function ", start + 1);
  const handler = source.slice(start, end);
  assert.ok(handler.indexOf("await deferCommandResponse") < handler.indexOf("members.fetch(interaction.client.user.id)"));
  assert.match(source, /cancelText: "転送はキャンセルされました。終了通知の待機は続行します。"/);
});
