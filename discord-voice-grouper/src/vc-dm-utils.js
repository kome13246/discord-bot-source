import crypto from "node:crypto";

export const VC_DM_FEATURE_VERSION = 1;
export const VC_DM_TIME_ZONE = "Asia/Tokyo";
export const VC_DM_VALID_VC_MINUTES = 3;
export const VC_DM_NEW_MEMBER_DAYS = 7;
export const VC_DM_INACTIVE_DAYS = 30;
export const VC_DM_REMINDER_LEAD_MINUTES = 30;
export const VC_DM_DAILY_HOUR = 17;
export const VC_DM_DAILY_MINUTE = 0;
export const VC_DM_PANEL_MARKER = "<!-- vc-dm-panel:v1 -->";
export const VC_DM_MAX_MESSAGE_LENGTH = 1900;
export const VC_DM_BUTTON_LABEL = "イベント日にリマインダーを受け取る";
export const VC_DM_REMINDER_CANCEL_LABEL = "リマインダーをキャンセル";
export const VC_DM_PANEL_EXCLUDE_LABEL = "参加済みとして除外";
export const VC_DM_PANEL_UNEXCLUDE_LABEL = "除外を取り消す";
export const VC_DM_PANEL_REFRESH_LABEL = "一覧を更新";
export const VC_DM_DM_PREFIX = "vcdm";

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const JST_WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];
const DAY_MS = 24 * 60 * 60 * 1000;
const TERMINAL_DM_STATUSES = new Set([
  "delivered",
  "dm_unavailable",
  "unconfirmed",
  "skipped_manual",
  "skipped_participated",
  "skipped_legacy",
  "skipped_left",
]);

function toDate(value) {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function getJstParts(value) {
  const date = toDate(value);
  if (!date) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: VC_DM_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type) => Number(parts.find((part) => part.type === type)?.value);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
    weekday: new Date(Date.UTC(get("year"), get("month") - 1, get("day"))).getUTCDay(),
  };
}

function fromJstParts({ year, month, day, hour = 0, minute = 0, second = 0, millisecond = 0 }) {
  return new Date(Date.UTC(year, month - 1, day, hour, minute, second, millisecond) - JST_OFFSET_MS);
}

export function normalizeVcDmEventTime(value) {
  if (typeof value !== "string") return null;
  const match = /^(\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function getJstCalendarDate(value = new Date()) {
  const parts = getJstParts(value);
  if (!parts) return null;
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

export function getJstDateAt(value, hour, minute = 0) {
  const parts = getJstParts(value);
  if (!parts || !Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  return fromJstParts({ ...parts, hour, minute, second: 0, millisecond: 0 });
}

export function getNextJstDaily17At(now = new Date()) {
  const parts = getJstParts(now);
  if (!parts) return null;
  const candidate = fromJstParts({ ...parts, hour: VC_DM_DAILY_HOUR, minute: VC_DM_DAILY_MINUTE, second: 0, millisecond: 0 });
  return candidate.getTime() > new Date(now).getTime()
    ? candidate
    : fromJstParts({ ...parts, day: parts.day + 1, hour: VC_DM_DAILY_HOUR, minute: VC_DM_DAILY_MINUTE, second: 0, millisecond: 0 });
}

export function getNextJstHourAt(now = new Date()) {
  const parts = getJstParts(now);
  if (!parts) return null;
  return fromJstParts({
    ...parts,
    hour: parts.hour + 1,
    minute: 0,
    second: 0,
    millisecond: 0,
  });
}

export function getFirstJstDaily17AtOrAfter(anchor) {
  const date = toDate(anchor);
  if (!date) return null;
  const parts = getJstParts(date);
  const candidate = fromJstParts({ ...parts, hour: VC_DM_DAILY_HOUR, minute: VC_DM_DAILY_MINUTE, second: 0, millisecond: 0 });
  return candidate.getTime() >= date.getTime()
    ? candidate
    : fromJstParts({ ...parts, day: parts.day + 1, hour: VC_DM_DAILY_HOUR, minute: VC_DM_DAILY_MINUTE, second: 0, millisecond: 0 });
}

export function getNewMemberDmDueAt(joinedAt) {
  const joined = toDate(joinedAt);
  if (!joined) return null;
  const threshold = new Date(joined.getTime() + VC_DM_NEW_MEMBER_DAYS * DAY_MS);
  return getFirstJstDaily17AtOrAfter(threshold);
}

export function getInactiveDmDueAt(referenceAt) {
  const reference = toDate(referenceAt);
  if (!reference) return null;
  const threshold = new Date(reference.getTime() + VC_DM_INACTIVE_DAYS * DAY_MS);
  return getFirstJstDaily17AtOrAfter(threshold);
}

export function getNextVcDmEventAt(now = new Date(), eventTime) {
  const normalized = normalizeVcDmEventTime(eventTime);
  const date = toDate(now);
  const parts = getJstParts(date);
  if (!normalized || !parts) return null;
  const [hour, minute] = normalized.split(":").map(Number);
  const candidates = [2, 6].map((weekday) => {
    const delta = (weekday - parts.weekday + 7) % 7;
    return fromJstParts({
      ...parts,
      day: parts.day + delta,
      hour,
      minute,
      second: 0,
      millisecond: 0,
    });
  }).filter((candidate) => candidate.getTime() > date.getTime());
  if (candidates.length) return candidates.sort((left, right) => left - right)[0];
  return fromJstParts({
    ...parts,
    day: parts.day + 7,
    hour,
    minute,
    second: 0,
    millisecond: 0,
  });
}

export function formatJstDateTime(value, { includeWeekday = true } = {}) {
  const parts = getJstParts(value);
  if (!parts) return "日時未設定";
  const weekday = includeWeekday ? `（${JST_WEEKDAYS[parts.weekday]}）` : "";
  return `${parts.month}月${parts.day}日${weekday}${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
}

export function formatJstDateTimeForPanel(value) {
  return formatJstDateTime(value, { includeWeekday: false });
}

export function getInactiveCycleKey(value, prefix = "vc") {
  const date = toDate(value);
  return date ? `${prefix}:${date.toISOString()}` : null;
}

export function hasValidVcParticipation(record) {
  // Presence is authoritative for the 7-day exclusion.  A malformed or
  // partially migrated timestamp must fail closed rather than re-qualifying
  // a member for the new-member DM.
  return record?.firstValidVcAt != null || record?.lastValidVcAt != null;
}

export function getInactivityReference(record) {
  return toDate(record?.lastValidVcAt)
    ?? toDate(record?.firstValidVcAt)
    ?? toDate(record?.inactiveBaselineAt)
    ?? null;
}

export function isTerminalDmStatus(status) {
  return TERMINAL_DM_STATUSES.has(status);
}

export function canAttemptDmStatus(status) {
  return !isTerminalDmStatus(status) && status !== "processing";
}

export function createVcDmRecordId(prefix = "r") {
  return `${prefix}${crypto.randomBytes(8).toString("hex")}`;
}

export function buildNewMemberDmContent(eventAt) {
  return [
    "「会話に慣れるためのサーバー」からのお知らせです。",
    "",
    "あなたがサーバーに参加してから7日間経過しましたがまだVCに参加できていません。",
    "まずはイベントから参加してみませんか？",
    `次回のイベントは${formatJstDateTime(eventAt)}からです。`,
    "ぜひ一度参加してみてください！",
    "",
    "いきなりのDM失礼いたしました。",
  ].join("\n");
}

export function buildInactiveDmContent(eventAt) {
  return [
    "「会話に慣れるためのサーバー」からのお知らせです。",
    "",
    "あなたがサーバーで最後にVCへ参加してから30日間経過しました。",
    "久しぶりにVCへ参加してみませんか？",
    `次回のイベントは${formatJstDateTime(eventAt)}からです。`,
    "ぜひ参加してみてください！",
    "",
    "いきなりのDM失礼いたしました。",
  ].join("\n");
}

export function buildReminderConfirmationContent(eventAt) {
  return `${formatJstDateTime(eventAt)}からのイベントについて、\n開催30分前のリマインダーを設定しました。`;
}

export const REMINDER_MESSAGE = "リマインダーを設定したイベントの開催30分前です！\n時間の都合がよろしければぜひ参加してみてください！";
export const REMINDER_CANCELED_MESSAGE = "イベントのリマインダーをキャンセルしました。";

export function parseVcDmIdList(value) {
  if (typeof value !== "string") return [];
  return [...new Set(value.split(/[\s,、]+/).map((item) => item.trim()).filter((item) => /^\d{5,25}$/.test(item)))];
}

export function isDmUnavailableError(error) {
  const code = Number(error?.code ?? error?.rawError?.code);
  return [50007, 10003, 10013].includes(code)
    || /cannot send messages|dm.*(closed|disabled|blocked)|direct message/i.test(String(error?.message ?? error));
}

export function isTargetVcChannel(channel, settings, guild) {
  if (!channel?.isVoiceBased?.()) return false;
  const excludedCategories = new Set([
    settings?.waitingVcCategoryId,
    settings?.vcControlCategoryId,
    ...(Array.isArray(settings?.vcDmExcludedCategoryIds) ? settings.vcDmExcludedCategoryIds : []),
  ].filter(Boolean));
  if (excludedCategories.has(channel.parentId)) return false;
  const excluded = new Set([
    ...(Array.isArray(settings?.vcDmExcludedChannelIds) ? settings.vcDmExcludedChannelIds : []),
    guild?.afkChannelId,
    settings?.gatheringVoiceChannelId,
    settings?.parentChannelId,
    settings?.voiceReminderParentChannelId,
    ...(Array.isArray(settings?.voiceReminderParentChannelIds) ? settings.voiceReminderParentChannelIds : []),
  ].filter(Boolean));
  if (excluded.has(channel.id)) return false;
  const explicit = Array.isArray(settings?.vcDmTargetChannelIds) ? settings.vcDmTargetChannelIds : [];
  if (explicit.length > 0) return explicit.includes(channel.id);
  return Boolean(settings?.vcDmTargetCategoryId && channel.parentId === settings.vcDmTargetCategoryId);
}

export function hasVcDmConfiguration(settings) {
  return Boolean(
    settings?.vcDmEnabled === true
    && getVcDmConfigurationIssues(settings).length === 0,
  );
}

export function getVcDmConfigurationIssues(settings) {
  const issues = [];
  if (!settings?.vcDmPanelChannelId) {
    issues.push({ code: "panel_channel_missing", message: "VC DM対象確認パネルのチャンネルが未設定です。" });
  }
  if (!settings?.vcDmTargetCategoryId && !(Array.isArray(settings?.vcDmTargetChannelIds) && settings.vcDmTargetChannelIds.length)) {
    issues.push({ code: "target_vc_missing", message: "VC DMの対象VCまたは対象カテゴリが未設定です。" });
  }
  if (settings?.kokuchiEventTimeConfigured === false || !normalizeVcDmEventTime(settings?.kokuchiEventTime)) {
    issues.push({ code: "event_time_missing", message: "VC DMの基準となるkokuchi event_timeが未設定または不正です。" });
  }
  return issues;
}

export function buildDmButtonCustomId(recordId) {
  return `${VC_DM_DM_PREFIX}:reminder:${recordId}`;
}

export function buildReminderCancelCustomId(recordId) {
  return `${VC_DM_DM_PREFIX}:cancel:${recordId}`;
}

export function buildPanelCustomId(action, recordId) {
  return `${VC_DM_DM_PREFIX}:panel:${action}:${recordId}`;
}

export function stableMemberSort(left, right) {
  const leftDue = new Date(left.dueAt ?? 0).getTime();
  const rightDue = new Date(right.dueAt ?? 0).getTime();
  if (leftDue !== rightDue) return leftDue - rightDue;
  const joined = new Date(left.joinedAt ?? 0).getTime() - new Date(right.joinedAt ?? 0).getTime();
  if (joined !== 0) return joined;
  return String(left.userId).localeCompare(String(right.userId));
}

export function getVcDmStatusSeverity({ enabled, configValid, dailyRun, migration, reminders = [], panel, uncertain, results = {} }) {
  if (!enabled) return "disabled";
  if (!configValid) return "error";
  if (dailyRun?.status === "failed" || migration?.status === "failed" || reminders.some((item) => item.status === "failed") || panel?.lastError || uncertain?.total > 0 || results.failed > 0) return "error";
  if (dailyRun?.status === "stopped") return "warning";
  if (dailyRun?.status === "processing" || reminders.some((item) => item.status === "processing")) return "info";
  return "healthy";
}

export function truncateError(error, max = 1000) {
  return String(error?.message ?? error ?? "unknown error").replace(/\s+/g, " ").slice(0, max);
}
