import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
} from "discord.js";
import {
  deleteProfileRegistrationPanel,
  getProfileRegistrationPanel,
  saveProfileRegistrationPanel,
} from "./profile-registration-panel-store.js";
import { acquireMongoLease, releaseMongoLease } from "./mongo-lease-lock-store.js";

const PANEL_TITLE = "自己紹介登録・編集";
const PANEL_DESCRIPTION = "ここから自己紹介を登録しておくとVC参加時にVCのチャットへ自動で送信されるようになります";
const REQUIRED_PERMISSIONS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.EmbedLinks,
];
const MISSING_RESOURCE_CODES = new Set([10003, 10008, "10003", "10008"]);

export function buildProfileRegistrationPanelPayload() {
  return {
    embeds: [new EmbedBuilder().setTitle(PANEL_TITLE).setDescription(PANEL_DESCRIPTION).setColor(0x5865f2)],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("profile_open").setLabel("登録・編集").setStyle(ButtonStyle.Primary),
    )],
    allowedMentions: { parse: [] },
  };
}

export function createProfileRegistrationPanelService({
  getGuildSettings,
  sendOperationalLog,
  getPanel = getProfileRegistrationPanel,
  savePanel = saveProfileRegistrationPanel,
  deletePanel = deleteProfileRegistrationPanel,
  acquireLease = acquireMongoLease,
  releaseLease = releaseMongoLease,
  logger = console,
  debounceMs = 1_000,
} = {}) {
  const timers = new Map();
  const queues = new Map();

  function enqueue(key, task) {
    const previous = queues.get(key) ?? Promise.resolve();
    const next = previous.catch((error) => logger.error("Previous profile registration panel task failed", error))
      .then(task)
      .finally(() => { if (queues.get(key) === next) queues.delete(key); });
    queues.set(key, next);
    return next;
  }

  async function logFailure(guild, settings, processName, error, details = {}) {
    const message = `[${processName}] guild=${guild?.id ?? "?"} channel=${details.channelId ?? "?"} message=${details.messageId ?? "?"} error=${error?.message ?? error}`;
    logger.error(message, error);
    await sendOperationalLog?.({ guild, settings, fallbackChannel: null, content: message }).catch((logError) => {
      logger.error("Profile registration panel operational log failed", logError);
    });
  }

  async function getCurrentChannel(guild, settings) {
    const channelId = settings?.profileIntroductionChannelId;
    if (!channelId) return null;
    const channel = await guild.channels.fetch(channelId).catch((error) => {
      if (isMissingResourceError(error)) return null;
      throw error;
    });
    if (!channel || channel.type !== ChannelType.GuildText || !channel.messages?.fetch || typeof channel.send !== "function") return null;
    const permissions = channel.permissionsFor(guild.members.me);
    return permissions && REQUIRED_PERMISSIONS.every((permission) => permissions.has(permission)) ? channel : null;
  }

  async function deleteMessage(channel, messageId) {
    if (!channel || !messageId) return;
    const message = await channel.messages.fetch(messageId).catch((error) => {
      if (isMissingResourceError(error)) return null;
      throw error;
    });
    await message?.delete();
  }

  function isPanelMessage(message, guild) {
    return message?.author?.id === guild.client.user?.id
      && message.embeds?.some((embed) => embed.title === PANEL_TITLE)
      && message.components?.some((row) => row.components?.some((component) => component.customId === "profile_open"));
  }

  function isCurrentPanelMessage(message, guild) {
    return isPanelMessage(message, guild)
      && message.embeds?.some((embed) => embed.title === PANEL_TITLE && embed.description === PANEL_DESCRIPTION);
  }

  async function removeDuplicatePanels(guild, channel, keepMessageId, settings) {
    const messages = await channel.messages.fetch({ limit: 100 });
    await Promise.all([...messages.values()].filter((message) => message.id !== keepMessageId && isPanelMessage(message, guild)).map(async (message) => {
      await message.delete().catch((error) => logFailure(guild, settings, "profile registration panel duplicate delete failed", error, { channelId: channel.id, messageId: message.id }));
    }));
  }

  async function moveProfileRegistrationPanelToBottom(guild, reason = "move") {
    const settings = await getGuildSettings(guild.id);
    const channelId = settings?.profileIntroductionChannelId;
    if (!channelId) return { status: "not-configured" };
    const channel = await getCurrentChannel(guild, settings).catch(async (error) => {
      await logFailure(guild, settings, "profile registration panel channel fetch failed", error, { channelId });
      return null;
    });
    if (!channel) return { status: "channel-unavailable" };

    const lease = await acquireLease(`profile-registration-panel:${guild.id}:${channel.id}`, { leaseMs: 30_000 });
    if (!lease) return { status: "lease-unavailable" };
    try {
      const latestSettings = await getGuildSettings(guild.id);
      if (latestSettings?.profileIntroductionChannelId !== channel.id) return { status: "configuration-changed" };
      const previous = await getPanel(guild.id);
      let message;
      try {
        message = await channel.send(buildProfileRegistrationPanelPayload());
      } catch (error) {
        await logFailure(guild, latestSettings, "profile registration panel send failed", error, { channelId: channel.id });
        return { status: "send-failed" };
      }
      try {
        await savePanel({ guildId: guild.id, channelId: channel.id, messageId: message.id });
      } catch (error) {
        await message.delete().catch((deleteError) => logFailure(guild, latestSettings, "profile registration panel rollback delete failed", deleteError, { channelId: channel.id, messageId: message.id }));
        await logFailure(guild, latestSettings, "profile registration panel state save failed", error, { channelId: channel.id, messageId: message.id });
        return { status: "save-failed" };
      }
      if (previous && (previous.channelId !== channel.id || previous.messageId !== message.id)) {
        const previousChannel = previous.channelId === channel.id
          ? channel
          : await guild.channels.fetch(previous.channelId).catch((error) => isMissingResourceError(error) ? null : Promise.reject(error));
        await deleteMessage(previousChannel, previous.messageId).catch((error) => logFailure(guild, latestSettings, "profile registration panel old delete failed", error, previous));
      }
      await removeDuplicatePanels(guild, channel, message.id, latestSettings).catch((error) => logFailure(guild, latestSettings, "profile registration panel duplicate cleanup failed", error, { channelId: channel.id }));
      return { status: "moved", message, reason };
    } finally {
      await releaseLease(lease).catch((error) => logger.error("Failed to release profile registration panel lease", error));
    }
  }

  async function ensureProfileRegistrationPanel(guild) {
    const settings = await getGuildSettings(guild.id);
    const channel = await getCurrentChannel(guild, settings).catch(async (error) => {
      await logFailure(guild, settings, "profile registration panel ensure channel fetch failed", error, { channelId: settings?.profileIntroductionChannelId });
      return null;
    });
    if (!channel) return settings?.profileIntroductionChannelId ? { status: "channel-unavailable" } : { status: "not-configured" };
    const state = await getPanel(guild.id);
    if (state?.channelId === channel.id) {
      const panel = await channel.messages.fetch(state.messageId).catch((error) => isMissingResourceError(error) ? null : Promise.reject(error));
      if (panel && isCurrentPanelMessage(panel, guild)) {
        const messages = await channel.messages.fetch({ limit: 100 });
        const latestMessage = messages.first();
        if (latestMessage?.id === panel.id) {
          await removeDuplicatePanels(guild, channel, panel.id, settings);
          return { status: "current", message: panel };
        }
      }
    }
    return enqueue(`${guild.id}:${channel.id}`, () => moveProfileRegistrationPanelToBottom(guild, "ensure"));
  }

  async function removeProfileRegistrationPanel(guild) {
    const state = await getPanel(guild.id);
    if (!state) return { status: "absent" };
    try {
      const channel = await guild.channels.fetch(state.channelId).catch((error) => isMissingResourceError(error) ? null : Promise.reject(error));
      await deleteMessage(channel, state.messageId);
    } catch (error) {
      await logFailure(guild, null, "profile registration panel remove failed", error, state);
    } finally {
      await deletePanel(guild.id).catch((error) => logFailure(guild, null, "profile registration panel state delete failed", error, state));
    }
    return { status: "removed" };
  }

  async function requestProfileRegistrationPanelMove(guild, reason = "request") {
    const settings = await getGuildSettings(guild.id);
    const channelId = settings?.profileIntroductionChannelId;
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
        resolve(enqueue(key, () => moveProfileRegistrationPanelToBottom(guild, reason)));
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
    const results = await Promise.allSettled([...client.guilds.cache.values()].map((guild) => ensureProfileRegistrationPanel(guild)));
    for (const result of results) {
      if (result.status === "rejected") logger.error("Profile registration panel startup restore failed", result.reason);
    }
  }

  return {
    requestProfileRegistrationPanelMove,
    moveProfileRegistrationPanelToBottom,
    ensureProfileRegistrationPanel,
    removeProfileRegistrationPanel,
    restore,
    shutdown,
  };
}

function isMissingResourceError(error) {
  return MISSING_RESOURCE_CODES.has(error?.code);
}
