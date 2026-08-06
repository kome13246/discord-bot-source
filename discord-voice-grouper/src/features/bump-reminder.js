const DEFAULT_DISBOARD_BOT_ID = "302050872383242240";
const DEFAULT_WAIT_MS = 2 * 60 * 60 * 1000;

export function createBumpReminderFeature({
  client,
  store,
  disboardBotId = DEFAULT_DISBOARD_BOT_ID,
  waitMs = DEFAULT_WAIT_MS,
  requestOperationalStatusRefresh = () => {},
  logger = console,
  now = () => Date.now(),
}) {
  const timers = new Map();

  function isBumpMessage(message) {
    return message.author?.id === disboardBotId
      && message.interaction?.commandName === "bump"
      && Boolean(message.interactionMetadata?.user ?? message.interaction?.user);
  }

  async function sendReminder(reminder) {
    const channel = await client.channels.fetch(reminder.channelId).catch(() => null);
    if (!channel || typeof channel.send !== "function") {
      await store.deleteReminder(reminder.id);
      return;
    }
    await channel.send({
      content: "前回のbumpから２時間が経過しました",
      allowedMentions: { parse: [] },
    });
    await store.deleteReminder(reminder.id);
  }

  function schedule(reminder) {
    if (timers.has(reminder.id)) clearTimeout(timers.get(reminder.id));
    const delayMs = Math.max(0, new Date(reminder.dueAt).getTime() - now());
    const timer = setTimeout(() => {
      timers.delete(reminder.id);
      void sendReminder(reminder)
        .catch((error) => logger.error(error))
        .finally(() => requestOperationalStatusRefresh(reminder.guildId, "bump-reminder"));
    }, delayMs);
    timers.set(reminder.id, timer);
  }

  async function handleMessage(message) {
    if (!message.inGuild() || !isBumpMessage(message)) return;
    const user = message.interactionMetadata?.user ?? message.interaction?.user;
    if (!user || user.bot) return;
    const reminder = {
      id: message.id,
      guildId: message.guildId,
      channelId: message.channelId,
      userId: user.id,
      dueAt: new Date(now() + waitMs).toISOString(),
      sourceMessageId: message.id,
    };
    await store.saveReminder(reminder);
    schedule(reminder);
  }

  async function restore() {
    const reminders = await store.getReminders();
    for (const reminder of reminders) schedule(reminder);
  }

  function shutdown() {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
  }

  return { handleMessage, isBumpMessage, restore, shutdown };
}
