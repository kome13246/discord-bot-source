import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  PermissionFlagsBits,
} from "discord.js";
import {
  deleteOteboRecruitmentPanel,
  getOteboRecruitmentPanel,
  saveOteboRecruitmentPanel,
} from "./otebo-recruitment-panel-store.js";
import { acquireMongoLease, releaseMongoLease } from "./mongo-lease-lock-store.js";

export const OTEBO_PANEL_BUTTON_CUSTOM_ID = "otebo_create";
export const OTEBO_PANEL_TEXT = [
  "下のボタンから募集を作成すると、募集内容と参加ボタンを含む匿名の募集メッセージが送信されます。",
  "参加ボタンが押されると、参加者と募集作成者へ招集メンションが送られます。",
  "成立しなかった募集は自動で削除されます。",
].join("\n");

const TEXT_CHANNEL_TYPES = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement]);
const REQUIRED_PERMISSIONS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.ManageMessages,
];
const MISSING_RESOURCE_CODES = new Set([10003, 10008, "10003", "10008"]);

export function buildOteboRecruitmentPanelPayload() {
  return {
    content: OTEBO_PANEL_TEXT,
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(OTEBO_PANEL_BUTTON_CUSTOM_ID)
        .setLabel("募集を作成")
        .setStyle(ButtonStyle.Primary),
    )],
    allowedMentions: { parse: [] },
  };
}

export function isOteboRecruitmentPanelMessage(message, guild) {
  return Boolean(
    message?.author?.id === guild?.client?.user?.id
      && message.content === OTEBO_PANEL_TEXT
      && message.components?.some((row) => row.components?.some((component) => (
        (component.customId ?? component.custom_id) === OTEBO_PANEL_BUTTON_CUSTOM_ID
        && component.label === "募集を作成"
      ))),
  );
}

export function createOteboRecruitmentPanelService({
  getGuildSettings,
  sendOperationalLog,
  canShowPanel = async () => true,
  getPanel = getOteboRecruitmentPanel,
  savePanel = saveOteboRecruitmentPanel,
  deletePanel = deleteOteboRecruitmentPanel,
  acquireLease = acquireMongoLease,
  releaseLease = releaseMongoLease,
  logger = console,
  debounceMs = 7_000,
} = {}) {
  if (!getGuildSettings) throw new Error("getGuildSettings is required.");
  const timers = new Map();
  const queues = new Map();

  function enqueue(key, task) {
    const previous = queues.get(key) ?? Promise.resolve();
    const next = previous
      .catch((error) => logger.error?.("Previous Otebo panel task failed", error))
      .then(task)
      .finally(() => {
        if (queues.get(key) === next) queues.delete(key);
      });
    queues.set(key, next);
    return next;
  }

  async function logFailure(guild, settings, processName, error, details = {}) {
    const message = `[${processName}] guild=${guild?.id ?? "?"} channel=${details.channelId ?? "?"} message=${details.messageId ?? "?"} error=${error?.message ?? error}`;
    logger.error?.(message, error);
    await sendOperationalLog?.({ guild, settings, fallbackChannel: null, content: message }).catch((logError) => {
      logger.error?.("Otebo panel operational log failed", logError);
    });
  }

  function noticeChannelId(settings) {
    return settings?.callWaitNoticeChannelId ?? null;
  }

  async function getCurrentChannel(guild, settings) {
    const channelId = noticeChannelId(settings);
    if (!channelId) return null;
    const channel = guild.channels.cache?.get(channelId)
      ?? await guild.channels.fetch(channelId).catch((error) => {
        if (isMissingResourceError(error)) return null;
        throw error;
      });
    if (!channel || !TEXT_CHANNEL_TYPES.has(channel.type) || typeof channel.send !== "function" || !channel.messages?.fetch) return null;
    const botMember = guild.members.me
      ?? (typeof guild.members.fetchMe === "function"
        ? await guild.members.fetchMe().catch(() => null)
        : null);
    const permissions = channel.permissionsFor?.(botMember);
    if (!permissions || !REQUIRED_PERMISSIONS.every((permission) => permissions.has(permission))) return null;
    return channel;
  }

  async function deleteMessage(channel, messageId) {
    if (!channel || !messageId) return;
    const message = await channel.messages.fetch(messageId).catch((error) => {
      if (isMissingResourceError(error)) return null;
      throw error;
    });
    await message?.delete();
  }

  async function removeDuplicatePanels(guild, channel, keepMessageId, settings) {
    const messages = await channel.messages.fetch({ limit: 100 });
    await Promise.all([...messages.values()]
      .filter((message) => message.id !== keepMessageId && isOteboRecruitmentPanelMessage(message, guild))
      .map((message) => message.delete().catch((error) => logFailure(
        guild,
        settings,
        "otebo panel duplicate delete failed",
        error,
        { channelId: channel.id, messageId: message.id },
      ))));
  }

  async function moveOteboRecruitmentPanelToBottom(guild, reason = "move") {
    const settings = await getGuildSettings(guild.id);
    const channel = await getCurrentChannel(guild, settings).catch(async (error) => {
      await logFailure(guild, settings, "otebo panel channel fetch failed", error);
      return null;
    });
    if (!channel) return { status: noticeChannelId(settings) ? "channel-unavailable" : "not-configured" };
    if (!await canShowPanel(guild, settings)) {
      await removeOteboRecruitmentPanel(guild).catch(() => null);
      return { status: "hidden" };
    }

    const lease = await acquireLease(`otebo-panel:${guild.id}:${channel.id}`, { leaseMs: 30_000 });
    if (!lease) return { status: "lease-unavailable", reason: "lease-unavailable", retryable: true, beforeDiscord: true, preMutation: true };
    try {
      const latestSettings = await getGuildSettings(guild.id);
      if (noticeChannelId(latestSettings) !== channel.id || !await canShowPanel(guild, latestSettings)) {
        await removeOteboRecruitmentPanel(guild).catch(() => null);
        return { status: "hidden" };
      }
      const previous = await getPanel(guild.id);
      let message;
      try {
        message = await channel.send(buildOteboRecruitmentPanelPayload());
      } catch (error) {
        await logFailure(guild, latestSettings, "otebo panel send failed", error, { channelId: channel.id });
        return { status: "send-failed" };
      }
      try {
        await savePanel({ guildId: guild.id, channelId: channel.id, messageId: message.id });
      } catch (error) {
        await message.delete().catch((deleteError) => logFailure(guild, latestSettings, "otebo panel rollback delete failed", deleteError, { channelId: channel.id, messageId: message.id }));
        await logFailure(guild, latestSettings, "otebo panel state save failed", error, { channelId: channel.id, messageId: message.id });
        return { status: "save-failed" };
      }
      if (previous && (previous.channelId !== channel.id || previous.messageId !== message.id)) {
        const previousChannel = previous.channelId === channel.id
          ? channel
          : await guild.channels.fetch(previous.channelId).catch((error) => isMissingResourceError(error) ? null : Promise.reject(error));
        await deleteMessage(previousChannel, previous.messageId).catch((error) => logFailure(guild, latestSettings, "otebo panel old delete failed", error, previous));
      }
      await removeDuplicatePanels(guild, channel, message.id, latestSettings).catch((error) => logFailure(guild, latestSettings, "otebo panel duplicate cleanup failed", error, { channelId: channel.id }));
      return { status: "moved", message, reason };
    } finally {
      await releaseLease(lease).catch((error) => logger.error?.("Failed to release Otebo panel lease", error));
    }
  }

  async function ensureOteboRecruitmentPanel(guild) {
    const settings = await getGuildSettings(guild.id);
    const state = await getPanel(guild.id);
    if (!await canShowPanel(guild, settings)) {
      if (state) await removeOteboRecruitmentPanel(guild).catch(() => null);
      return { status: "hidden" };
    }
    const channel = await getCurrentChannel(guild, settings).catch(async (error) => {
      await logFailure(guild, settings, "otebo panel ensure channel fetch failed", error);
      return null;
    });
    if (!channel) return { status: noticeChannelId(settings) ? "channel-unavailable" : "not-configured" };
    if (state?.channelId === channel.id) {
      const panel = await channel.messages.fetch(state.messageId).catch((error) => isMissingResourceError(error) ? null : Promise.reject(error));
      if (panel && isOteboRecruitmentPanelMessage(panel, guild)) {
        const messages = await channel.messages.fetch({ limit: 100 });
        if (messages.first()?.id === panel.id) {
          await removeDuplicatePanels(guild, channel, panel.id, settings);
          return { status: "current", message: panel };
        }
      }
    }
    return enqueue(`${guild.id}:${channel.id}`, () => moveOteboRecruitmentPanelToBottom(guild, "ensure"));
  }

  async function removeOteboRecruitmentPanel(guild) {
    const state = await getPanel(guild.id);
    const settings = await getGuildSettings(guild.id).catch(() => null);
    const channelIds = [...new Set([state?.channelId, noticeChannelId(settings)].filter(Boolean))];
    if (!state && channelIds.length === 0) return { status: "absent" };
    let removalComplete = true;
    try {
      const channel = state
        ? await guild.channels.fetch(state.channelId).catch((error) => isMissingResourceError(error) ? null : Promise.reject(error))
        : null;
      if (state) {
        await deleteMessage(channel, state.messageId).catch(async (error) => {
          removalComplete = false;
          await logFailure(guild, settings, "otebo panel target delete failed", error, state);
        });
      }
      for (const channelId of channelIds) {
        const duplicateChannel = channelId === state?.channelId
          ? channel
          : await guild.channels.fetch(channelId).catch((error) => isMissingResourceError(error) ? null : Promise.reject(error));
        if (!duplicateChannel?.messages?.fetch) continue;
        const messages = await duplicateChannel.messages.fetch({ limit: 100 });
        await Promise.all([...messages.values()]
          .filter((message) => isOteboRecruitmentPanelMessage(message, guild))
          .map(async (message) => {
            try {
              await message.delete();
            } catch (error) {
              removalComplete = false;
              await logFailure(
                guild,
                settings,
                "otebo panel hidden duplicate delete failed",
                error,
                { channelId, messageId: message.id },
              );
            }
          }));
      }
    } catch (error) {
      removalComplete = false;
      await logFailure(guild, settings, "otebo panel remove failed", error, state ?? {});
    }
    if (state && removalComplete) {
      try {
        await deletePanel(guild.id);
      } catch (error) {
        removalComplete = false;
        await logFailure(guild, settings, "otebo panel state delete failed", error, state);
      }
    }
    return { status: removalComplete ? (state ? "removed" : "duplicates-removed") : "remove-failed" };
  }

  async function requestOteboRecruitmentPanelMove(guild, reason = "request") {
    const settings = await getGuildSettings(guild.id);
    const channelId = noticeChannelId(settings);
    if (!channelId) return { status: "not-configured" };
    const key = `${guild.id}:${channelId}`;
    if (timers.has(key)) {
      const pending = timers.get(key);
      clearTimeout(pending.timer);
      pending.resolve({ status: "debounced" });
    }
    const promise = new Promise((resolve) => {
      const timer = setTimeout(() => {
        timers.delete(key);
        resolve(enqueue(key, () => moveOteboRecruitmentPanelToBottom(guild, reason)));
      }, debounceMs);
      timers.set(key, { timer, resolve });
    });
    return promise;
  }

  function shutdown() {
    for (const { timer, resolve } of timers.values()) {
      clearTimeout(timer);
      resolve?.({ status: "shutdown" });
    }
    timers.clear();
  }

  async function restore(client) {
    const results = await Promise.allSettled([...client.guilds.cache.values()].map((guild) => ensureOteboRecruitmentPanel(guild)));
    for (const result of results) if (result.status === "rejected") logger.error?.("Otebo panel startup restore failed", result.reason);
  }

  return {
    requestOteboRecruitmentPanelMove,
    moveOteboRecruitmentPanelToBottom,
    ensureOteboRecruitmentPanel,
    removeOteboRecruitmentPanel,
    restore,
    shutdown,
  };
}

function isMissingResourceError(error) {
  return MISSING_RESOURCE_CODES.has(error?.code);
}
