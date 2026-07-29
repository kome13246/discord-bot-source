const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

export function getNextJstHalfHour(now = new Date()) {
  const timestamp = now.getTime();
  const jst = new Date(timestamp + JST_OFFSET_MS);
  const next = new Date(Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate(), jst.getUTCHours(), jst.getUTCMinutes() < 30 ? 30 : 60, 0, 0));
  return new Date(next.getTime() - JST_OFFSET_MS);
}

/** Calculates the next JST weekday/time. `24` remains displayed as 24:00. */
export function getNextKokuchiReservationAt({ weekday, hour, now = new Date() }) {
  if (!WEEKDAYS.includes(weekday) || !Number.isInteger(hour) || hour < 0 || hour > 24) return null;
  const jstNow = new Date(now.getTime() + JST_OFFSET_MS);
  const base = new Date(Date.UTC(jstNow.getUTCFullYear(), jstNow.getUTCMonth(), jstNow.getUTCDate(), 0, 0, 0, 0));
  const dayDelta = (WEEKDAYS.indexOf(weekday) - jstNow.getUTCDay() + 7) % 7;
  base.setUTCDate(base.getUTCDate() + dayDelta + (hour === 24 ? 1 : 0));
  base.setUTCHours(hour === 24 ? 0 : hour, 0, 0, 0);
  let candidate = new Date(base.getTime() - JST_OFFSET_MS);
  if (candidate.getTime() <= now.getTime()) candidate = new Date(candidate.getTime() + 7 * 24 * 60 * 60 * 1000);
  return candidate;
}

/** Calculates the next absolute JST event datetime from its weekday and HH:mm. */
export function getNextKokuchiEventAt({ weekday, eventTime, now = new Date() }) {
  if (!WEEKDAYS.includes(weekday) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(eventTime ?? "")) return null;
  const [hour, minute] = eventTime.split(":").map(Number);
  const jstNow = new Date(now.getTime() + JST_OFFSET_MS);
  const candidate = new Date(Date.UTC(
    jstNow.getUTCFullYear(),
    jstNow.getUTCMonth(),
    jstNow.getUTCDate() + (WEEKDAYS.indexOf(weekday) - jstNow.getUTCDay() + 7) % 7,
    hour,
    minute,
    0,
    0,
  ) - JST_OFFSET_MS);
  return candidate.getTime() <= now.getTime()
    ? new Date(candidate.getTime() + 7 * 24 * 60 * 60 * 1000)
    : candidate;
}

export function formatJstReservationTime(date, displayHour) {
  const jst = new Date(date.getTime() + JST_OFFSET_MS);
  const hour = displayHour === 24 ? 24 : jst.getUTCHours();
  return `${hour}:00`;
}

/** Returns the JST calendar date selected by the user, including `set:24`. */
export function getKokuchiEventDate(scheduledAt, displayHour) {
  const jst = new Date(new Date(scheduledAt).getTime() + JST_OFFSET_MS);
  if (displayHour === 24) jst.setUTCDate(jst.getUTCDate() - 1);
  return `${jst.getUTCFullYear()}-${String(jst.getUTCMonth() + 1).padStart(2, "0")}-${String(jst.getUTCDate()).padStart(2, "0")}`;
}

export function getInterestCooldownSeconds(canceledAt, now = new Date()) {
  const elapsed = now.getTime() - new Date(canceledAt).getTime();
  return Math.max(0, Math.ceil((30_000 - elapsed) / 1000));
}

export function getKokuchiReminderStatusOnCancel(reminderStatus) {
  return ["pending", "processing"].includes(reminderStatus)
    ? "canceled"
    : reminderStatus;
}
