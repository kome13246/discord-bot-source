import test from "node:test";
import assert from "node:assert/strict";
import { getInterestCooldownSeconds, getKokuchiEventDate, getKokuchiReminderStatusOnCancel, getNextJstHalfHour, getNextKokuchiEventAt, getNextKokuchiReservationAt } from "../src/kokuchi-reservation-utils.js";
import { CallWaitInterest } from "../src/models/call-wait-interest.js";
import { KokuchiReservation } from "../src/models/kokuchi-reservation.js";
import { SplitProcessSession } from "../src/models/split-process-session.js";
import { MongoLeaseLock } from "../src/models/mongo-lease-lock.js";
import { OperationalStatusBoard } from "../src/models/operational-status-board.js";
import { VoiceParticipantRoleGrant } from "../src/models/voice-participant-role-grant.js";
import { toCurrentGroupMemberIds } from "../src/split-waiting-utils.js";

test("次の定時募集はJSTの00分または30分になる", () => {
  assert.equal(getNextJstHalfHour(new Date("2026-07-28T12:10:00.000Z")).toISOString(), "2026-07-28T12:30:00.000Z");
  assert.equal(getNextJstHalfHour(new Date("2026-07-28T12:40:00.000Z")).toISOString(), "2026-07-28T13:00:00.000Z");
  assert.equal(getNextJstHalfHour(new Date("2026-07-28T12:30:00.000Z")).toISOString(), "2026-07-28T13:00:00.000Z");
  assert.equal(getNextJstHalfHour(new Date("2026-07-28T14:45:00.000Z")).toISOString(), "2026-07-28T15:00:00.000Z");
});

test("/kokuchi の指定曜日とsetをJSTで予約し、24時は翌日0時になる", () => {
  const now = new Date("2026-07-27T08:00:00.000Z"); // Monday 17:00 JST
  assert.equal(getNextKokuchiReservationAt({ weekday: "火", hour: 18, now }).toISOString(), "2026-07-28T09:00:00.000Z");
  assert.equal(getNextKokuchiReservationAt({ weekday: "火", hour: 24, now }).toISOString(), "2026-07-28T15:00:00.000Z");
});

test("興味ありの再登録クールダウン残秒を切り上げる", () => {
  const now = new Date("2026-07-28T00:00:12.000Z");
  assert.equal(getInterestCooldownSeconds(new Date("2026-07-28T00:00:00.000Z"), now), 18);
  assert.equal(getInterestCooldownSeconds(new Date("2026-07-27T23:59:00.000Z"), now), 0);
});

test("set:24 treats the selected weekday's following midnight as 24:00", () => {
  // Tuesday 23:30 JST: Tuesday 24:00 is still 30 minutes away.
  const beforeMidnight = new Date("2026-07-28T14:30:00.000Z");
  assert.equal(
    getNextKokuchiReservationAt({ weekday: "火", hour: 24, now: beforeMidnight }).toISOString(),
    "2026-07-28T15:00:00.000Z",
  );

  // Once that midnight has passed, the next occurrence is the following week.
  const afterMidnight = new Date("2026-07-28T15:01:00.000Z");
  assert.equal(
    getNextKokuchiReservationAt({ weekday: "火", hour: 24, now: afterMidnight }).toISOString(),
    "2026-08-04T15:00:00.000Z",
  );
});

test("set:24 keeps the selected JST calendar date as the kokuchi event date", () => {
  const scheduledAt = new Date("2026-07-28T15:00:00.000Z");
  assert.equal(getKokuchiEventDate(scheduledAt, 24), "2026-07-28");
  assert.equal(getKokuchiEventDate(scheduledAt, 0), "2026-07-29");
});

test("同じ曜日の予約は未来なら当日、時刻を過ぎていれば翌週になる", () => {
  const before = new Date("2026-07-28T08:00:00.000Z"); // Tuesday 17:00 JST
  assert.equal(
    getNextKokuchiReservationAt({ weekday: "火", hour: 18, now: before }).toISOString(),
    "2026-07-28T09:00:00.000Z",
  );
  const atTime = new Date("2026-07-28T09:00:00.000Z");
  assert.equal(
    getNextKokuchiReservationAt({ weekday: "火", hour: 18, now: atTime }).toISOString(),
    "2026-08-04T09:00:00.000Z",
  );
});

test("開催日時は投稿日ではなく指定曜日とJST開催時刻から計算する", () => {
  assert.equal(
    getNextKokuchiEventAt({ weekday: "火", eventTime: "00:15", now: new Date("2026-07-27T08:00:00.000Z") }).toISOString(),
    "2026-07-27T15:15:00.000Z",
  );
  assert.equal(
    getNextKokuchiEventAt({ weekday: "火", eventTime: "21:00", now: new Date("2026-07-26T15:00:00.000Z") }).toISOString(),
    "2026-07-28T12:00:00.000Z",
  );
  assert.equal(
    getNextKokuchiEventAt({ weekday: "火", eventTime: "00:15", now: new Date("2026-07-27T15:20:00.000Z") }).toISOString(),
    "2026-08-03T15:15:00.000Z",
  );
});

test("興味ありモデルは受付時到達状態と終了通知再試行状態を保持する", () => {
  const interest = new CallWaitInterest({ guildId: "g", recruitmentId: "r", userId: "u" });
  assert.equal(interest.thresholdSatisfiedInReceipt, false);
  assert.equal(interest.hadOtherInterestAtRegistration, false);
  assert.equal(interest.endNotificationAttemptCount, 0);
  assert.equal(interest.endNotificationStatus, "pending");
  assert.equal(interest.thresholdNotificationRetryCount, 0);
  assert.equal(CallWaitInterest.schema.path("thresholdNotificationLastTriedAt").instance, "Date");
  assert.equal(CallWaitInterest.schema.path("status").enumValues.includes("joined"), true);
});

test("MongoDBリースロックはキーの一意性とリース期限を永続化する", () => {
  assert.equal(MongoLeaseLock.schema.path("lockKey").options.unique, true);
  assert.equal(MongoLeaseLock.schema.path("leaseId").instance, "String");
  assert.equal(MongoLeaseLock.schema.path("fencingToken").instance, "Number");
  assert.equal(OperationalStatusBoard.schema.path("fencingToken").instance, "Number");
  assert.equal(MongoLeaseLock.schema.path("leaseUntil").instance, "Date");
  assert.equal(MongoLeaseLock.schema.indexes().some(([key]) => key.lockKey === 1), true);
});

test("一時VCロール付与はBot所有者・発生源・回収状態を記録する", () => {
  const grant = new VoiceParticipantRoleGrant({ guildId: "g", memberId: "m", roleId: "r" });
  assert.equal(grant.grantedByBot, true);
  assert.equal(grant.sourceType, "voice_monitor");
  assert.equal(grant.status, "active");
  assert.equal(VoiceParticipantRoleGrant.schema.path("cleanupAt").instance, "Date");
  assert.equal(
    VoiceParticipantRoleGrant.schema.indexes().some(([key, options]) => key.cleanupAt === 1 && options.expireAfterSeconds === 0),
    true,
  );
  assert.equal(
    VoiceParticipantRoleGrant.schema.indexes().some(
      ([key, options]) => key.guildId === 1
        && key.memberId === 1
        && key.roleId === 1
        && key.sourceType === 1
        && key.sourceId === 1
        && options.unique === true,
    ),
    true,
  );
});

test("予約モデルはキャンセル済みリマインダー状態を表現できる", () => {
  assert.equal(KokuchiReservation.schema.path("reminderStatus").enumValues.includes("canceled"), true);
  assert.equal(KokuchiReservation.schema.path("status").enumValues.includes("published_unconfirmed"), true);
  assert.equal(KokuchiReservation.schema.path("publishedAt").instance, "Date");
  assert.equal(KokuchiReservation.schema.path("cleanupAt").instance, "Date");
  assert.equal(KokuchiReservation.schema.indexes().some(([key, options]) => key.cleanupAt === 1 && options.expireAfterSeconds === 0), true);
});

test("予約キャンセルは未送信または処理中のリマインダーだけをキャンセル扱いにする", () => {
  assert.equal(getKokuchiReminderStatusOnCancel("pending"), "canceled");
  assert.equal(getKokuchiReminderStatusOnCancel("processing"), "canceled");
  assert.equal(getKokuchiReminderStatusOnCancel("sent"), "sent");
  assert.equal(getKokuchiReminderStatusOnCancel("failed"), "failed");
  assert.equal(getKokuchiReminderStatusOnCancel("skipped"), "skipped");
});

test("途中参加監視セッションは復元に必要な状態と子VCスナップショットを保持する", () => {
  const session = new SplitProcessSession({ sessionId: "s", guildId: "g" });
  assert.equal(session.waitingMonitorStatus, "inactive");
  assert.equal(SplitProcessSession.schema.path("groupSnapshots").schema.path("channelId").instance, "String");
  assert.equal(SplitProcessSession.schema.path("waitingMonitorStatus").enumValues.includes("extended"), true);
  assert.equal(SplitProcessSession.schema.path("waitingMonitorLeaseUntil").instance, "Date");
  assert.equal(SplitProcessSession.schema.path("participantRoleGrantedMemberIds").instance, "Array");
});

test("途中参加の既存グループ評価はSetと復元後の配列を配列として扱う", () => {
  const childChannel = { members: new Map([
    ["a", { id: "a", user: { bot: false } }],
    ["bot", { id: "bot", user: { bot: true } }],
  ]) };
  assert.deepEqual(toCurrentGroupMemberIds(new Map([["c", new Set(["a", "b"])]]), "c", childChannel), ["a", "b"]);
  assert.deepEqual(toCurrentGroupMemberIds(new Map([["c", ["a", "b"]]]), "c", childChannel), ["a", "b"]);
  assert.deepEqual(toCurrentGroupMemberIds(new Map(), "c", childChannel), ["a"]);
});
