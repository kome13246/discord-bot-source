import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { ScheduledAction } from "../src/models/scheduled-action.js";

test("定時募集フォローアップはギルドごとに未完了アクションを一つに制限する", () => {
  const index = ScheduledAction.schema.indexes().find(([fields, options]) =>
    fields.guildId === 1
      && fields.type === 1
      && options.unique === true
      && options.partialFilterExpression?.type === "callwait_followup"
      && Array.isArray(options.partialFilterExpression?.status?.$in)
      && options.partialFilterExpression.status.$in.includes("pending")
      && options.partialFilterExpression.status.$in.includes("running"),
  );
  assert.ok(index);
});

test("フォローアップは永続化・再起動復元・失敗時再試行を行い、通常の次枠作成を抑制する", async () => {
  const source = await readFile(new URL("../src/bot.js", import.meta.url), "utf8");
  assert.match(source, /scheduleSingleGuildAction\(\{[\s\S]*?type: "callwait_followup"/);
  assert.match(source, /if \(!result\.scheduled \|\| scheduledAction\.status !== "pending"\) return;/);
  assert.match(source, /if \(action\.type === "callwait_followup"\) \{/);
  assert.match(source, /retryAction\(actionKey, \{[\s\S]*?CALL_WAIT_FOLLOWUP_RETRY_MS/);
  assert.match(source, /if \(queued\) \{[\s\S]*?await scheduleCallWaitFollowupCheck\(guild\);\s*return;/);
});

test("フォローアップはVCに2人以上いれば新規募集を作らず、1人以下なら通常作成処理へ戻す", async () => {
  const source = await readFile(new URL("../src/bot.js", import.meta.url), "utf8");
  const followup = source.match(/async function runCallWaitFollowupCheck\(guildId\) \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(followup);
  assert.match(followup, /if \(activeVoiceMemberIds\.length >= CALL_WAIT_MIN_MEMBERS\) \{[\s\S]*?return;/);
  assert.match(followup, /await sendCallWaitPromptForGuild\(guild, settings, \{[\s\S]*?force: false/);
});

test("1サーバーの設定取得失敗で他サーバーの定時募集処理を止めない", async () => {
  const source = await readFile(new URL("../src/bot.js", import.meta.url), "utf8");
  const dispatcher = source.match(/async function processCallWaitForAllGuilds\(\) \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(dispatcher);
  assert.match(dispatcher, /for \(const guild of client\.guilds\.cache\.values\(\)\) \{\s*\/\/ Settings retrieval[\s\S]*?try \{/);
  assert.match(dispatcher, /const settings = await getGuildSettings\(guild\.id\);[\s\S]*?await processCallWaitForGuild\(guild, settings\);[\s\S]*?catch \(error\)/);
});

test("通常メッセージを扱うBotはMessage Content Intentを要求する", async () => {
  const source = await readFile(new URL("../src/bot.js", import.meta.url), "utf8");
  assert.match(source, /GatewayIntentBits\.MessageContent/);
});

test("ヘルスチェックはDiscord・MongoDB・復元・終了状態を反映する", async () => {
  const source = await readFile(new URL("../src/bot.js", import.meta.url), "utf8");
  assert.match(source, /const ok = discordReady && mongoReady && startupRestoreCompleted && !startupRestoreFailed && !shuttingDown;/);
  assert.match(source, /response\.writeHead\(ok \? 200 : 503/);
  assert.match(source, /await Promise\.allSettled\(\[/);
  assert.match(source, /startupRestoreCompleted = true;/);
});

test("終了シグナル時は新規処理を止め、DiscordとMongoDBを閉じる", async () => {
  const source = await readFile(new URL("../src/bot.js", import.meta.url), "utf8");
  assert.match(source, /process\.once\("SIGTERM"/);
  assert.match(source, /process\.once\("SIGINT"/);
  assert.match(source, /process\.once\("unhandledRejection"/);
  assert.match(source, /process\.once\("uncaughtException"/);
  assert.match(source, /shuttingDown = true;/);
  assert.match(source, /client\.destroy\(\);/);
  assert.match(source, /await disconnectFromMongoDB\(\);/);
});

test("call-wait evaluation and notice delivery use claimed MongoDB states", async () => {
  const source = await readFile(new URL("../src/bot.js", import.meta.url), "utf8");
  const store = await readFile(new URL("../src/settings-store.js", import.meta.url), "utf8");
  assert.match(source, /transitionCallWaitPrompt\(\{[\s\S]*?toState: "evaluating"/);
  assert.match(source, /fromStates: \["evaluating"\],[\s\S]*?toState: "role_granting"/);
  assert.match(source, /fromStates: \["role_granting"\],[\s\S]*?toState: "failed"/);
  assert.match(source, /claimCallWaitPendingNotice\(\{ guildId: guild\.id \}\)/);
  assert.match(source, /status: "sent_unconfirmed"/);
  assert.match(store, /"callWaitPendingNotice\.status": "processing"/);
  assert.match(store, /recoverInterruptedCallWaitPendingNotices/);
  assert.match(store, /recoverInterruptedCallWaitPrompts/);
  assert.match(source, /recoverInterruptedCallWaitPrompts\(\)/);
});

test("call-wait evaluation preserves the prompt until its durable outcome is saved", async () => {
  const source = await readFile(new URL("../src/bot.js", import.meta.url), "utf8");
  const start = source.indexOf("async function evaluateCallWaitPrompt");
  const end = source.indexOf("async function deleteCallWaitPrompt", start);
  assert.ok(start >= 0 && end > start);
  const evaluator = source.slice(start, end);
  assert.doesNotMatch(evaluator, /message\.delete\(/);
  assert.match(source, /saveGuildSettingsWithCurrent\(guild\.id, roleGranting, \{[\s\S]*?callWaitPrompt: null/);
  assert.match(source, /deleteCallWaitPrompt\(guild, roleGranting\.callWaitPrompt\)/);
});

test("設定不備でも期限到達済みの既存定時募集は終了する", async () => {
  const source = await readFile(new URL("../src/bot.js", import.meta.url), "utf8");
  const start = source.indexOf("async function processCallWaitForGuild");
  const end = source.indexOf("async function sendCallWaitPromptForGuild", start);
  const processor = source.slice(start, end);

  assert.match(processor, /if \(!configured\.ok\) \{[\s\S]*?const expiredPrompt = settings\.callWaitPrompt/);
  assert.match(processor, /Closing expired prompt because call-wait settings are incomplete/);
  assert.match(processor, /await deleteCallWaitPrompt\(guild, expiredPrompt\)/);
  assert.match(processor, /callWaitPrompt: null/);
  assert.match(processor, /Closing call-wait prompt because the feature is disabled/);
  assert.match(processor, /!Number\.isFinite\(new Date\(expiredPrompt\.targetAt\)\.getTime\(\)\)/);
});

test("incomplete call-wait role grants are rolled back with their source identity", async () => {
  const source = await readFile(new URL("../src/bot.js", import.meta.url), "utf8");
  const start = source.indexOf("async function grantCallWaitRoleAndQueueNotice");
  const end = source.indexOf("async function maybeSendPendingCallWaitStartNotice", start);
  assert.ok(start >= 0 && end > start);
  const grant = source.slice(start, end);
  assert.match(grant, /if \(eligibleMemberIds\.length < CALL_WAIT_MIN_MEMBERS\)/);
  assert.match(grant, /removeCallWaitRoleFromMembers\([\s\S]*?sourceType: "call_wait"/);
  assert.match(grant, /Failed to clear unschedulable call-wait notice/);
  assert.match(grant, /callWaitPendingNotice: null/);
  assert.match(grant, /memberIds: eligibleMemberIds/);
});

test("splitvc acquires and releases a MongoDB lease", async () => {
  const source = await readFile(new URL("../src/bot.js", import.meta.url), "utf8");
  assert.match(source, /acquireMongoLease\(\`splitvc:\$\{interaction\.guildId\}\`/);
  assert.match(source, /activeSplitVoiceLeases\.set\(interaction\.guildId, splitLease\)/);
  assert.match(source, /activeSplitVoiceLeases\.get\(interaction\.guildId\)/);
  assert.match(source, /releaseMongoLease\(splitLease\)/);
});

test("splitvc role recovery only removes the role grant owned by that session", async () => {
  const source = await readFile(new URL("../src/bot.js", import.meta.url), "utf8");
  const scheduledRemoval = source.match(/async function executeScheduledRoleRemoval\([\s\S]*?\n\}/)?.[0];
  assert.ok(scheduledRemoval);
  assert.match(scheduledRemoval, /sourceType: "splitvc"/);
  assert.match(scheduledRemoval, /sourceId: payload\.sessionId/);
  assert.match(scheduledRemoval, /removeVoiceParticipantRole\(member, roleId/);
});

test("restored splitvc waiting-room transfers persist their role grants", async () => {
  const source = await readFile(new URL("../src/bot.js", import.meta.url), "utf8");
  const restored = source.match(/async function createRestoredWaitingGroup\([\s\S]*?\n\}/)?.[0];
  assert.ok(restored);
  assert.match(restored, /VoiceParticipantRoleGrant\.updateOne/);
  assert.match(restored, /sourceType: "splitvc"/);
  assert.match(restored, /sourceId: session\.sessionId/);
});

test("automatic split records and durably schedules cleanup for its temporary roles", async () => {
  const source = await readFile(new URL("../src/bot.js", import.meta.url), "utf8");
  const handler = source.match(/async function handleAutoSplitButton\([\s\S]*?\n\}/)?.[0];
  const transfer = source.match(/async function transferMembersToPbChildChannel\([\s\S]*?\n\}/)?.[0];
  assert.ok(handler);
  assert.ok(transfer);
  assert.match(handler, /acquireMongoLease\(autoSplitLockKey/);
  assert.match(handler, /releaseMongoLease\(autoSplitLease\)/);
  assert.match(handler, /type: "auto_split_role_remove"/);
  assert.match(handler, /sourceType: "auto_split"/);
  assert.match(transfer, /VoiceParticipantRoleGrant\.updateOne/);
  assert.match(transfer, /const waitForPbChildChannel = async/);
});

test("otebo notice publication claims a state and preserves an unconfirmed outcome", async () => {
  const source = await readFile(new URL("../src/bot.js", import.meta.url), "utf8");
  const store = await readFile(new URL("../src/settings-store.js", import.meta.url), "utf8");
  assert.match(source, /fromStatuses: \["active"\],[\s\S]*?toStatus: "publishing"/);
  assert.match(source, /toStatus: "published_unconfirmed"/);
  assert.match(source, /deleteOteboRecruitmentMessage\(guild, recruitment\)/);
  assert.match(store, /export async function transitionOteboRecruitment/);
});

test("one guild failure does not stop otebo startup restoration for other guilds", async () => {
  const source = await readFile(new URL("../src/bot.js", import.meta.url), "utf8");
  const start = source.indexOf("async function restoreOteboRecruitmentTimers");
  const end = source.indexOf("function scheduleOteboRecruitmentTimers", start);
  assert.ok(start >= 0 && end > start);
  const restore = source.slice(start, end);
  assert.match(restore, /for \(const guild of client\.guilds\.cache\.values\(\)\) \{\s*try \{/);
  assert.match(restore, /Failed to restore otebo state for guild/);
});

test("one failed kokuchi reservation does not stop restoring later reservations", async () => {
  const source = await readFile(new URL("../src/bot.js", import.meta.url), "utf8");
  const start = source.indexOf("async function restoreKokuchiReservations");
  const end = source.indexOf("function getGatheringVcUnlockChannelId", start);
  assert.ok(start >= 0 && end > start);
  const restore = source.slice(start, end);
  assert.match(restore, /for \(const reservation of reservations\) \{\s*try \{/);
  assert.match(restore, /Failed to restore kokuchi reservation/);
});

test("one interrupted kokuchi reservation recovery failure does not stop later recoveries", async () => {
  const source = await readFile(new URL("../src/bot.js", import.meta.url), "utf8");
  const start = source.indexOf("async function restoreKokuchiReservations");
  const end = source.indexOf("function getGatheringVcUnlockChannelId", start);
  assert.ok(start >= 0 && end > start);
  const restore = source.slice(start, end);
  assert.match(restore, /for \(const reservation of interrupted\) \{\s*try \{/);
  assert.match(restore, /Failed to recover interrupted kokuchi reservation/);
});

test("kokuchi reservation persists its published message before post-publication work and recovers it without replay", async () => {
  const source = await readFile(new URL("../src/bot.js", import.meta.url), "utf8");
  const model = await readFile(new URL("../src/models/kokuchi-reservation.js", import.meta.url), "utf8");
  const processStart = source.indexOf("async function processKokuchiReservation");
  const processEnd = source.indexOf("async function resumeKokuchiPostProcessing", processStart);
  const restoreStart = source.indexOf("async function restoreKokuchiReservations");
  const restoreEnd = source.indexOf("function getGatheringVcUnlockChannelId", restoreStart);
  assert.ok(processStart >= 0 && processEnd > processStart);
  assert.ok(restoreStart >= 0 && restoreEnd > restoreStart);
  const process = source.slice(processStart, processEnd);
  const restore = source.slice(restoreStart, restoreEnd);
  assert.match(process, /onPublished: async \(\{ postedMessage, postedAt \}\) => \{[\s\S]*?publicationMessageId: postedMessage\.id/);
  assert.match(process, /publicationStatus: "published_unconfirmed"/);
  assert.match(restore, /if \(reservation\.publicationMessageId\) \{[\s\S]*?resumeKokuchiPostProcessing\(reservation\)/);
  assert.match(restore, /status: "published_unconfirmed"/);
  assert.match(model, /publicationStatus:/);
  assert.match(model, /postProcessingStatus:/);
});

test("immediate kokuchi publication is durably keyed by guild and event date", async () => {
  const source = await readFile(new URL("../src/bot.js", import.meta.url), "utf8");
  const model = await readFile(new URL("../src/models/kokuchi-reservation.js", import.meta.url), "utf8");
  const start = source.indexOf("async function publishImmediateKokuchi");
  const end = source.indexOf("async function restoreGatheringVcUnlockSchedules", start);
  assert.ok(start >= 0 && end > start);
  const immediate = source.slice(start, end);
  assert.match(immediate, /publicationKey: `\$\{interaction\.guildId\}:\$\{eventDate\}`/);
  assert.match(immediate, /leaseKey: `kokuchi-publish:\$\{interaction\.guildId\}:\$\{eventDate\}`/);
  assert.match(immediate, /publicationMessageId: postedMessage\.id/);
  assert.match(immediate, /publicationStatus: "published_unconfirmed"/);
  assert.match(model, /publicationKey:/);
  assert.match(model, /schema\.index\(\{ publicationKey: 1 \}, \{ unique: true, sparse: true \}\)/);
});

test("one failed splitvc session does not stop startup recovery of other sessions", async () => {
  const source = await readFile(new URL("../src/bot.js", import.meta.url), "utf8");
  const start = source.indexOf("async function restoreSplitProcessSessions");
  const end = source.indexOf("async function scheduleCallWaitFollowupCheck", start);
  assert.ok(start >= 0 && end > start);
  const restore = source.slice(start, end);
  assert.match(restore, /for \(const session of sessions\) \{\s*try \{/);
  assert.match(restore, /Failed to restore split session/);
});

test("waiting VC and split completion flows use one splitSessionId option name", async () => {
  const source = await readFile(new URL("../src/bot.js", import.meta.url), "utf8");
  const start = source.indexOf("async function runWaitingRoomMonitor");
  const end = source.indexOf("async function removeRoleFromMembers", start);
  assert.ok(start >= 0 && end > start);
  const flows = source.slice(start, end);
  assert.match(flows, /options\.splitSessionId/);
  assert.doesNotMatch(flows, /options\.(groupingSessionId|sessionId)/);
  assert.doesNotMatch(source, /groupingSessionId:/);
});

test("restored waiting monitoring keeps retrying while an old MongoDB lease is valid", async () => {
  const source = await readFile(new URL("../src/bot.js", import.meta.url), "utf8");
  const model = await readFile(new URL("../src/models/split-process-session.js", import.meta.url), "utf8");
  const start = source.indexOf("async function processRestoredWaitingMonitor");
  const end = source.indexOf("function startRestoredWaitingMonitor", start);
  assert.ok(start >= 0 && end > start);
  const monitor = source.slice(start, end);
  assert.match(monitor, /waitingMonitorLeaseUntil/);
  assert.match(monitor, /waitingMonitorLeaseRetryAt/);
  assert.match(monitor, /Keep the interval alive while another process owns the old lease/);
  assert.doesNotMatch(monitor, /if \(!session\) \{ clearRestoredWaitingMonitor\(sessionId\); return; \}/);
  assert.match(model, /waitingMonitorLeaseRetryAt: Date/);
});

test("splitvc never transfers a member when its participant-role grant fails", async () => {
  const source = await readFile(new URL("../src/bot.js", import.meta.url), "utf8");
  const start = source.indexOf("async function moveMemberWithParticipantRole");
  const end = source.indexOf("async function transferGroups", start);
  assert.ok(start >= 0 && end > start);
  const move = source.slice(start, end);
  assert.match(move, /return \{ moved: false, reason: "role_grant_failed"/);
  const failedReturn = move.indexOf('return { moved: false, reason: "role_grant_failed"');
  const transfer = move.indexOf("await member.voice.setChannel");
  assert.ok(failedReturn >= 0 && transfer > failedReturn);
  assert.match(source, /if \(!transfer\.moved\) \{\s*throw new Error\(`Participant role grant failed/);
});

test("waiting transfer persistence failures roll back voice, source-owned roles, and session state", async () => {
  const source = await readFile(new URL("../src/bot.js", import.meta.url), "utf8");
  const start = source.indexOf("async function persistWaitingGroupMembers");
  const end = source.indexOf("async function removeRoleFromMembers", start);
  assert.ok(start >= 0 && end > start);
  const persist = source.slice(start, end);
  assert.match(persist, /Rollback waiting transfer after persistence failure/);
  assert.match(persist, /removeVoiceParticipantRole\(member, options\.participantRole\.id/);
  assert.match(persist, /status: rollbackErrors\.length \? "cleanup_required" : "failed"/);
  assert.match(persist, /status: "active",\s*waitingMonitorStatus: \{ \$in: \["active", "extended"\] \}/);
  assert.match(persist, /childChannelIds: channelId/);
  assert.match(persist, /groupSnapshots: \{ groupNumber, channelId, memberIds \}/);
  assert.match(persist, /persisted: false,\s*reason: error\.persistenceReason/);
  assert.match(persist, /Rollback split waiting child after persistence failure/);
});

test("interest component handlers acknowledge before MongoDB or Discord work", async () => {
  const source = await readFile(new URL("../src/bot.js", import.meta.url), "utf8");
  for (const name of [
    "registerCallWaitInterestFromPublicButton",
    "cancelCallWaitInterestFromDm",
    "handleCallWaitInterestThresholdSelect",
    "joinCallWaitFromInterestDm",
    "enableCallWaitInterestRenotification",
  ]) {
    const start = source.indexOf(`async function ${name}`);
    const end = source.indexOf("\n}", start);
    assert.ok(start >= 0 && end > start);
    assert.match(source.slice(start, end), /await deferComponentResponse\(interaction, "(reply|update)"\)/);
  }
});

test("call-wait logs include the active interest members", async () => {
  const source = await readFile(new URL("../src/bot.js", import.meta.url), "utf8");
  const logStart = source.indexOf("async function sendCallWaitApplicantLog");
  const logEnd = source.indexOf("async function grantCallWaitRoleAndQueueNotice", logStart);
  const interestStart = source.indexOf("async function registerCallWaitInterestFromPublicButton");
  const interestEnd = source.indexOf("async function cancelCallWaitInterestFromPublicButton", interestStart);
  assert.ok(logStart >= 0 && logEnd > logStart && interestStart >= 0 && interestEnd > interestStart);

  const log = source.slice(logStart, logEnd);
  const registration = source.slice(interestStart, interestEnd);
  assert.match(log, /action === "interest"/);
  assert.match(log, /recruitmentId = null/);
  assert.match(log, /現在の興味あり:/);
  assert.match(log, /CallWaitInterest\.find\(\{[\s\S]*?status: "active"/);
  assert.match(log, /・\$\{member\.displayName\}\(\$\{member\.id\}\)/);
  assert.match(registration, /action: "interest"/);
  assert.match(registration, /recruitmentId: prompt\.messageId/);
});

test("failed interest threshold deliveries remain retryable instead of becoming sent", async () => {
  const source = await readFile(new URL("../src/bot.js", import.meta.url), "utf8");
  const start = source.indexOf("async function reconcileCallWaitInterestThresholds");
  const end = source.indexOf("async function enableCallWaitInterestRenotification", start);
  assert.ok(start >= 0 && end > start);
  const reconcile = source.slice(start, end);
  assert.match(reconcile, /thresholdNotificationStatus: "failed"/);
  assert.match(reconcile, /thresholdNotificationRetryCount: 1/);
  assert.match(reconcile, /thresholdNotificationLastTriedAt: new Date\(\)/);
  assert.match(reconcile, /The threshold DM could not be edited or resent\./);
});

test("otebo owner cancellation edits a deferred component response", async () => {
  const source = await readFile(new URL("../src/bot.js", import.meta.url), "utf8");
  const start = source.indexOf("async function handleOteboOwnerCancelConfirmButton");
  const end = source.indexOf("async function cancelOteboParticipation", start);
  assert.ok(start >= 0 && end > start);
  const handler = source.slice(start, end);
  assert.match(handler, /await interaction\.deferUpdate\(\)/);
  assert.match(handler, /response: "editReply"/);
  assert.doesNotMatch(handler, /interaction\.update\(/);
  assert.match(source, /if \(response === "update" \|\| response === "editReply"\) \{\s*await interaction\[response\]/);
});

test("otebo draft submit and interest renotification keep deferred interactions valid", async () => {
  const source = await readFile(new URL("../src/bot.js", import.meta.url), "utf8");
  const submitStart = source.indexOf("async function handleOteboDraftSubmitButton");
  const submitEnd = source.indexOf("async function handleOteboNoteModal", submitStart);
  const renotifyStart = source.indexOf("async function enableCallWaitInterestRenotification");
  const renotifyEnd = source.indexOf("async function refreshCallWaitPromptMessage", renotifyStart);
  assert.ok(submitStart >= 0 && submitEnd > submitStart && renotifyStart >= 0 && renotifyEnd > renotifyStart);
  const submit = source.slice(submitStart, submitEnd);
  const renotify = source.slice(renotifyStart, renotifyEnd);
  assert.match(submit, /await interaction\.deferUpdate\(\)/);
  assert.match(submit, /await interaction\.editReply\(\{/);
  assert.doesNotMatch(submit, /interaction\.update\(/);
  assert.match(renotify, /const recruitmentIsActive = Boolean\(/);
  assert.match(renotify, /if \(!recruitmentIsActive\) \{[\s\S]*?return;/);
  assert.match(renotify, /recruitmentId,\s*status: "active"/);
});

test("public call-wait cancellation atomically cancels a joined interest and disables its DMs", async () => {
  const source = await readFile(new URL("../src/bot.js", import.meta.url), "utf8");
  const helperStart = source.indexOf("async function cancelJoinedCallWaitInterest");
  const helperEnd = source.indexOf("async function editCallWaitInterestMessages", helperStart);
  const handlerStart = source.indexOf("async function handleCallWaitButton");
  const handlerEnd = source.indexOf("async function sendCallWaitApplicantLog", handlerStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart && handlerStart >= 0 && handlerEnd > handlerStart);
  const helper = source.slice(helperStart, helperEnd);
  const handler = source.slice(handlerStart, handlerEnd);
  assert.match(helper, /status: "joined"/);
  assert.match(helper, /status: "canceled"/);
  assert.match(helper, /canceledAt: new Date\(\)/);
  assert.match(helper, /\$unset: \{\s*joinedAt: 1/);
  assert.match(helper, /editCallWaitInterestMessages\(canceledInterest/);
  assert.match(handler, /const joinedInterest = !isJoin/);
  assert.match(handler, /if \(!isJoin && joinedInterest\)/);
  assert.match(handler, /operation: "add"/);
  assert.match(handler, /remainingJoinedInterest/);
});

test("restored waiting transfers verify their database update and roll back on a mismatch", async () => {
  const source = await readFile(new URL("../src/bot.js", import.meta.url), "utf8");
  const start = source.indexOf("async function processRestoredWaitingMonitor");
  const end = source.indexOf("function startRestoredWaitingMonitor", start);
  assert.ok(start >= 0 && end > start);
  const monitor = source.slice(start, end);
  assert.match(monitor, /const persisted = await SplitProcessSession\.updateOne/);
  assert.match(monitor, /persisted\.matchedCount !== 1 \|\| persisted\.modifiedCount !== 1/);
  assert.match(monitor, /Rollback restored waiting transfer after persistence failure/);
  assert.match(monitor, /removeVoiceParticipantRole\(member, session\.participantRoleId/);
});

test("saved split reviews report delivery failures and preserve retry state", async () => {
  const source = await readFile(new URL("../src/bot.js", import.meta.url), "utf8");
  const model = await readFile(new URL("../src/models/split-review.js", import.meta.url), "utf8");
  const delivery = source.match(/async function deliverSplitReview\([\s\S]*?\n\}/)?.[0];
  const submitStart = source.indexOf("async function submitSplitReview");
  const submitEnd = source.indexOf("function jstReviewDate", submitStart);
  assert.ok(delivery);
  assert.ok(submitStart >= 0 && submitEnd > submitStart);
  const submit = source.slice(submitStart, submitEnd);
  assert.match(model, /deliveryRetryCount/);
  assert.match(model, /deliveryLastTriedAt/);
  assert.match(model, /deliveryLastError/);
  assert.match(delivery, /deliveryStatus: "processing"/);
  assert.match(delivery, /deliveryStatus: "failed"/);
  assert.match(source, /async function restoreFailedSplitReviewDeliveries/);
  assert.match(source, /restoreFailedSplitReviewDeliveries\(\)/);
  assert.match(submit, /回答内容は保存しましたが、運営チャンネルへの転送に失敗しました/);
  assert.match(submit, /const delivery = await deliverSplitReview/);
});

test("profile publication uses a guild and user scoped MongoDB lease after acknowledging the button", async () => {
  const source = await readFile(new URL("../src/bot.js", import.meta.url), "utf8");
  const handler = source.match(/async function handleProfilePublishButton\(interaction\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(handler);
  assert.match(handler, /await interaction\.update\(\{ content: "自己紹介を送信しています…", components: \[\] \}\);[\s\S]*?acquireMongoLease\(`profile-publish:\$\{interaction\.guildId\}:\$\{targetUserId\}`/);
  assert.match(handler, /releaseMongoLease\(profileLease\)/);
});

test("profile edit modal loads saved values before it is displayed", async () => {
  const source = await readFile(new URL("../src/bot.js", import.meta.url), "utf8");
  const start = source.indexOf("async function handleProfileOpen");
  const end = source.indexOf("async function handleProfileModal", start);
  assert.ok(start >= 0 && end > start);
  const handler = source.slice(start, end);
  assert.match(handler, /UserProfile\.findOne\(\{ guildId: interaction\.guildId, userId: interaction\.user\.id \}\)\.lean\(\)/);
  assert.match(handler, /await interaction\.showModal\(modal\)/);
  assert.match(handler, /normalizeProfileValue\(profile\?\.nickname, 20\)/);
  const modalStart = source.indexOf("async function handleProfileModal");
  const modalEnd = source.indexOf("async function logProfileFailure", modalStart);
  const modalHandler = source.slice(modalStart, modalEnd);
  assert.match(modalHandler, /status: submittedValues\.status/);
  assert.doesNotMatch(modalHandler, /submittedValues\.status \|\| existing\?\.status/);
});

test("bosyu edit modal uses its restored memory session without a pre-modal MongoDB read", async () => {
  const source = await readFile(new URL("../src/bot.js", import.meta.url), "utf8");
  const start = source.indexOf("async function handleBosyuButton");
  const end = source.indexOf("async function handleBosyuEditModal", start);
  assert.ok(start >= 0 && end > start);
  const handler = source.slice(start, end);
  assert.match(handler, /const session = bosyuEditSessions\.get\(interaction\.message\.id\)/);
  assert.doesNotMatch(handler, /getBosyuEditSession\(/);
  assert.match(handler, /await interaction\.showModal/);
});

test("otebo success claims a durable state and recovery never replays an uncertain notice", async () => {
  const source = await readFile(new URL("../src/bot.js", import.meta.url), "utf8");
  const start = source.indexOf("async function finishOteboRecruitmentSuccess");
  const end = source.indexOf("async function deleteOteboRecruitmentMessage", start);
  const restoreStart = source.indexOf("async function restoreOteboRecruitmentTimers");
  const restoreEnd = source.indexOf("function scheduleOteboRecruitmentTimers", restoreStart);
  assert.ok(start >= 0 && end > start);
  assert.ok(restoreStart >= 0 && restoreEnd > restoreStart);
  const finish = source.slice(start, end);
  const restore = source.slice(restoreStart, restoreEnd);
  assert.match(finish, /acquireMongoLease\(`otebo-success:\$\{guild\.id\}:\$\{recruitment\.id\}`/);
  assert.match(finish, /fromStatuses: \["active"\],[\s\S]*?toStatus: "success_processing"/);
  assert.match(finish, /toStatus: "success_notified"/);
  assert.match(finish, /toStatus: "cleanup_pending"/);
  assert.match(finish, /releaseMongoLease\(successLease\)/);
  assert.match(restore, /\["success_processing", "success_notified", "cleanup_pending"\]/);
  assert.match(restore, /notice replay is disabled/);
  assert.match(source, /const actionKey = `otebo-role-remove:\$\{guild\.id\}:\$\{recruitmentId \?\? roleId\}`/);
});

test("long otebo interactions acknowledge before MongoDB or Discord side effects", async () => {
  const source = await readFile(new URL("../src/bot.js", import.meta.url), "utf8");
  assert.match(source, /async function handleSendOtebo[\s\S]*?await interaction\.deferReply\(\{ flags: MessageFlags\.Ephemeral \}\)/);
  assert.match(source, /async function handleOteboDraftSubmitButton[\s\S]*?await interaction\.deferUpdate\(\)/);
  assert.match(source, /async function handleOteboNoteModal[\s\S]*?await interaction\.deferReply\(\{ flags: MessageFlags\.Ephemeral \}\)/);
});

test("a deferred review summary always edits the original interaction response", async () => {
  const source = await readFile(new URL("../src/bot.js", import.meta.url), "utf8");
  const handler = source.match(/async function handleShowReview\(interaction\) \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(handler);
  assert.match(handler, /await interaction\.deferReply/);
  assert.doesNotMatch(handler, /interaction\.reply\(/);
  assert.match(handler, /interaction\.editReply\(/);
});

test("a deferred settings update never attempts a second initial reply", async () => {
  const source = await readFile(new URL("../src/bot.js", import.meta.url), "utf8");
  const start = source.indexOf("async function handleSetting(interaction)");
  const end = source.indexOf("async function handleCallWaitSetting", start);
  assert.ok(start >= 0 && end > start);
  const handler = source.slice(start, end);
  const deferredPart = handler.slice(handler.indexOf("await interaction.deferReply"));
  assert.ok(deferredPart.includes("await interaction.deferReply"));
  assert.doesNotMatch(deferredPart, /interaction\.reply\(/);
});
