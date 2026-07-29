const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

export const CALL_WAIT_INTERVAL_MINUTES = [30, 45, 60];
export const DEFAULT_CALL_WAIT_INTERVAL_MINUTES = 30;

export function normalizeCallWaitIntervalMinutes(value) {
  const interval = Number(value);
  return CALL_WAIT_INTERVAL_MINUTES.includes(interval)
    ? interval
    : DEFAULT_CALL_WAIT_INTERVAL_MINUTES;
}

/**
 * Calculates the current and next recurring call-wait slots from JST midnight.
 * The key is stable across restarts and can be persisted with a prompt to make
 * a slot's identity explicit.
 */
export function getJstCallWaitSlots({
  now = new Date(),
  intervalMinutes = DEFAULT_CALL_WAIT_INTERVAL_MINUTES,
} = {}) {
  const interval = normalizeCallWaitIntervalMinutes(intervalMinutes);
  const nowMs = now.getTime();
  const jstNow = new Date(nowMs + JST_OFFSET_MS);
  const jstMidnightMs = Date.UTC(
    jstNow.getUTCFullYear(),
    jstNow.getUTCMonth(),
    jstNow.getUTCDate(),
  );
  const elapsedMinutes = (
    jstNow.getUTCHours() * 60
    + jstNow.getUTCMinutes()
  );
  const currentSlotMinutes = Math.floor(elapsedMinutes / interval) * interval;
  const currentSlot = new Date(jstMidnightMs + currentSlotMinutes * 60_000 - JST_OFFSET_MS);
  const nextSlot = new Date(currentSlot.getTime() + interval * 60_000);

  return {
    intervalMinutes: interval,
    currentSlot,
    nextSlot,
    currentSlotKey: createCallWaitSlotKey(currentSlot, interval),
    nextSlotKey: createCallWaitSlotKey(nextSlot, interval),
  };
}

export function getNextJstCallWaitSlot(options) {
  return getJstCallWaitSlots(options).nextSlot;
}

export function getMsUntilNextJstCallWaitSlot(options = {}) {
  const now = options.now ?? new Date();
  return Math.max(1000, getNextJstCallWaitSlot({ ...options, now }).getTime() - now.getTime());
}

/** A scheduled tick is accepted for a short grace period after its slot. */
export function isJstCallWaitSlotDue({
  now = new Date(),
  intervalMinutes = DEFAULT_CALL_WAIT_INTERVAL_MINUTES,
  graceMs = 120_000,
} = {}) {
  const { currentSlot } = getJstCallWaitSlots({ now, intervalMinutes });
  const elapsedMs = now.getTime() - currentSlot.getTime();
  return elapsedMs >= 0 && elapsedMs <= graceMs;
}

export function createCallWaitSlotKey(slotAt, intervalMinutes) {
  const interval = normalizeCallWaitIntervalMinutes(intervalMinutes);
  const jst = new Date(new Date(slotAt).getTime() + JST_OFFSET_MS);
  const date = `${jst.getUTCFullYear()}-${String(jst.getUTCMonth() + 1).padStart(2, "0")}-${String(jst.getUTCDate()).padStart(2, "0")}`;
  const minuteOfDay = jst.getUTCHours() * 60 + jst.getUTCMinutes();
  return `${date}:${String(minuteOfDay).padStart(4, "0")}:${interval}`;
}
