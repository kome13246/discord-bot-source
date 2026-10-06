const TOKYO_TIME_ZONE = "Asia/Tokyo";
const JAPAN_OFFSET_HOURS = 9;

export function sanitizeSengenText(value, maxLength = 300) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/@(everyone|here)/gi, "＠$1")
    .replace(/<(@!?|@&|#)(\d+)>/g, "＜$1$2＞")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

export function getJstDateParts(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError("Invalid date");
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TOKYO_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  return Object.fromEntries(parts.filter((part) => part.type !== "literal").map(({ type, value: partValue }) => [type, Number(partValue)]));
}

export function getJstDateKey(value = new Date()) {
  const { year, month, day } = getJstDateParts(value);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Return 18:00 JST on the date `days` after the JST calendar date of base. */
export function addJstDaysAt18(value, days) {
  const { year, month, day } = getJstDateParts(value);
  const dayCount = Number(days);
  if (!Number.isInteger(dayCount) || dayCount < 0) throw new RangeError("days must be a non-negative integer");
  return new Date(Date.UTC(year, month - 1, day + dayCount, JAPAN_OFFSET_HOURS));
}

export function formatJstDateTime(value) {
  const { year, month, day } = getJstDateParts(value);
  return `${year}/${String(month).padStart(2, "0")}/${String(day).padStart(2, "0")} 18:00`;
}

export function formatJstShortDateTime(value) {
  const { month, day } = getJstDateParts(value);
  return `${month}月${day}日18:00`;
}

export function validateSengenInput({ content, termDays, intervalDays = null } = {}) {
  const cleanContent = sanitizeSengenText(content, 300);
  const days = Number(termDays);
  const interval = intervalDays === null || intervalDays === undefined || intervalDays === ""
    ? null
    : Number(intervalDays);
  if (!cleanContent) return { ok: false, reason: "empty-content" };
  if (!Number.isInteger(days) || days < 1 || days > 90) return { ok: false, reason: "invalid-term" };
  if (interval !== null && (!Number.isInteger(interval) || interval < 1 || interval >= days)) {
    return { ok: false, reason: "invalid-interval" };
  }
  return { ok: true, content: cleanContent, termDays: days, intervalDays: interval };
}

export function buildSengenDeclarationContent(declaration) {
  const lines = [
    `<@${declaration.userId}>の宣言`,
    `「${sanitizeSengenText(declaration.content, 300)}」`,
  ];
  if (declaration.result === "achieved") lines.push("結果：達成");
  else if (declaration.result === "failed") lines.push("結果：失敗");
  else lines.push(`期間：${Number(declaration.termDays)}日間`);
  lines.push(`期限：${formatJstDateTime(declaration.deadlineAt)}（日本時間）`);
  if (declaration.result === "failed" && declaration.failureReason) {
    lines.push(`失敗理由：${sanitizeSengenText(declaration.failureReason, 500)}`);
  }
  return lines.join("\n");
}

/** Append an invisible, self-delimiting declaration ID marker for safe post recovery. */
export function appendSengenDeclarationMarker(content, declarationId) {
  const value = String(declarationId ?? "");
  if (!value) return String(content ?? "");
  const encodedId = Buffer.from(value, "utf8").toString("hex");
  const encodedMarker = [...encodedId]
    .map((digit) => String.fromCodePoint(0xfe00 + Number.parseInt(digit, 16)))
    .join("");
  return `${String(content ?? "")}\u2063${encodedMarker}\u2063`;
}

export function hasSengenDeclarationMarker(content, declarationId) {
  const value = String(declarationId ?? "");
  if (!value) return false;
  const visibleContent = String(content ?? "");
  return visibleContent.endsWith(appendSengenDeclarationMarker("", value));
}

export function buildSengenMessageUrl(guildId, channelId, messageId) {
  if (!guildId || !channelId || !messageId) return null;
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}
