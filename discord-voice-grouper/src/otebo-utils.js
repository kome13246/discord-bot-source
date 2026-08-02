export const OTEBO_DURATION_NONE = "none";
export const OTEBO_DURATION_30 = "30";
export const OTEBO_DURATION_60 = "60";

export const BUTTON_RECRUITMENT_CONFLICT_MESSAGE =
  "別のボタン募集が掲載されているときは送信できません。現在の募集が終了してから、もう一度お試しください。";

export const OTEBO_MERGED_NOTICE =
  "別の募集またはVCでの雑談が成立したため、このボタン募集は終了しました。\n参加希望の確定処理は行われていません。";

export const OTEBO_VOICE_STARTED_NOTICE =
  "VCが始まったため、このボタン募集は自動で取り消されました。\nぜひ開催中のVCへ参加してみてください。";

export function normalizeOteboDuration(value) {
  return [OTEBO_DURATION_30, OTEBO_DURATION_60].includes(String(value))
    ? String(value)
    : OTEBO_DURATION_NONE;
}

export function getOteboDurationText(value) {
  const duration = normalizeOteboDuration(value);
  if (duration === OTEBO_DURATION_30) return "30分間";
  if (duration === OTEBO_DURATION_60) return "1時間";
  return "";
}

export function normalizeOteboNote(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
}

export function sanitizeOteboMentions(value) {
  return normalizeOteboNote(value).replace(/@/g, "@\u200b");
}

export function formatOteboJstTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return "不明";
  const jst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  return `${String(jst.getUTCHours()).padStart(2, "0")}:${String(jst.getUTCMinutes()).padStart(2, "0")}`;
}

export function formatOteboRecruitmentMessage({
  closingAt,
  duration = OTEBO_DURATION_NONE,
  mentionRoleId = null,
  mentionEnabled = false,
  note = "",
} = {}) {
  const mention = mentionEnabled && mentionRoleId ? ` <@&${mentionRoleId}>` : "";
  const durationText = getOteboDurationText(duration);
  const normalizedNote = sanitizeOteboMentions(note);
  return [
    `【雑談募集】${mention}`,
    `${formatOteboJstTime(closingAt)}まで掲載される雑談の募集です。${durationText ? `(${durationText}予定)` : ""}`,
    "下の参加ボタンが押されたら集合メンションが行われます。",
    normalizedNote ? `ひとこと：${normalizedNote}` : null,
  ].filter((line) => line !== null).join("\n");
}

export function formatOteboSuccessNotice({
  roleId,
  duration = OTEBO_DURATION_NONE,
  note = "",
} = {}) {
  const lines = [`<@&${roleId}> 雑談募集が成立しました！VCへの参加お願いします！`];
  const durationText = getOteboDurationText(duration);
  const normalizedNote = sanitizeOteboMentions(note);
  if (durationText) lines.push(`通話時間：${durationText}`);
  if (normalizedNote) lines.push(`ひとこと：${normalizedNote}`);
  return lines.join("\n");
}

export function formatOteboVoiceStartedNotice() {
  return OTEBO_VOICE_STARTED_NOTICE;
}
