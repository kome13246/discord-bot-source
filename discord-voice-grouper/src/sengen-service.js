import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { randomUUID } from "node:crypto";
import { acquireMongoLease, releaseMongoLease, renewMongoLease } from "./mongo-lease-lock-store.js";
import { createSengenStore } from "./sengen-store.js";
import {
  addJstDaysAt18,
  appendSengenDeclarationMarker,
  buildSengenDeclarationContent,
  buildSengenMessageUrl,
  formatJstDateTime,
  formatJstShortDateTime,
  getJstDateKey,
  hasSengenDeclarationMarker,
  sanitizeSengenText,
  validateSengenInput,
} from "./sengen-utils.js";

const PANEL_PERMISSION_BITS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.ReadMessageHistory,
];
const PROGRESS_LATE_GRACE_MS = 10 * 60 * 1000;
const DEFAULT_TICK_MS = 60 * 1000;
const DRAFT_TTL_MS = 15 * 60 * 1000;
const PANEL_LEASE_MS = 30_000;
const PANEL_LEASE_RENEW_MS = 10_000;
const MISSING_RESOURCE_CODES = new Set([10003, 10008, "10003", "10008"]);

function isMissingDiscordResource(error) {
  return MISSING_RESOURCE_CODES.has(error?.code)
    || MISSING_RESOURCE_CODES.has(error?.rawError?.code)
    || Number(error?.status ?? error?.statusCode) === 404;
}

function date(value) {
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function component(customId, label, style = ButtonStyle.Secondary) {
  return new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(customId).setLabel(label).setStyle(style));
}

function panelPayload(overviewChannelId) {
  return {
    content: [
      "📣 宣言ボタン",
      `この機能の概要は <#${overviewChannelId}> からご確認ください！`,
      "",
      "宣言はチャンネルに公開され、自分では変更・削除できません。",
      "期限にはDMで結果を確認します。途中確認のDMも設定できます。",
      "DMを受け取らない設定の場合、途中確認・結果確認の通知が届かないことがあります。",
    ].join("\n"),
    components: [component("sengen:open", "宣言", ButtonStyle.Primary)],
    allowedMentions: { parse: [] },
  };
}

function isSengenPanelMessage(message, client) {
  return message?.author?.id === client?.user?.id
    && message.components?.some((row) => row.components?.some((item) => item.customId === "sengen:open"));
}

function isCurrentSengenPanel(message, client, overviewChannelId) {
  return isSengenPanelMessage(message, client)
    && message.content === panelPayload(overviewChannelId).content;
}

function hasLegacyDeclarationRecordMarker(message, declarationId) {
  const expected = `sengen:record:${declarationId}`;
  return message?.components?.some((row) => row.components?.some((item) => (item.customId ?? item.custom_id) === expected)) ?? false;
}

function buildPublicComponents(declaration) {
  if (!declaration.result) return [];
  const components = [];
  components.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`sengen:correct:${declaration._id}:achieved`)
      .setLabel("管理者：達成に訂正")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`sengen:correct:${declaration._id}:failed`)
      .setLabel("管理者：失敗に訂正")
      .setStyle(ButtonStyle.Danger),
  ));
  return components;
}

function messageCreatedTimestamp(message) {
  const createdTimestamp = Number(message?.createdTimestamp);
  if (Number.isFinite(createdTimestamp) && createdTimestamp > 0) return createdTimestamp;
  try {
    return Number(BigInt(message.id) >> 22n) + 1_420_070_400_000;
  } catch {
    return null;
  }
}

function isManageGuild(interaction) {
  try {
    return Boolean(interaction.memberPermissions?.has?.(PermissionFlagsBits.ManageGuild));
  } catch {
    return false;
  }
}

function interactionIsButton(interaction) {
  return typeof interaction?.customId === "string" && interaction.customId.startsWith("sengen:");
}

function previewText(draft, registeredAt) {
  const deadlineAt = addJstDaysAt18(registeredAt, draft.termDays);
  return {
    deadlineAt,
    content: [
      "この内容で宣言しますか？",
      `「${draft.content}」`,
      `公開先：<#${draft.postChannelId}>`,
      `期限：${formatJstDateTime(deadlineAt)}（日本時間）`,
      "",
      "登録後、宣言内容と期間は変更・取消できません。",
    ].join("\n"),
  };
}

export function createSengenService({
  client,
  getGuildSettings,
  store = createSengenStore(),
  now = () => new Date(),
  acquireLease = acquireMongoLease,
  renewLease = renewMongoLease,
  releaseLease = releaseMongoLease,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  logger = console,
  tickMs = DEFAULT_TICK_MS,
} = {}) {
  if (!client) throw new Error("client is required");
  if (typeof getGuildSettings !== "function") throw new Error("getGuildSettings is required");

  const panelTimers = new Map();
  const panelQueues = new Map();
  let workerTimer = null;
  let workerRun = null;
  let shuttingDown = false;
  let startupProgressSkipPending = false;

  function nowDate() {
    return date(now()) ?? new Date();
  }

  function enqueuePanel(key, task) {
    if (shuttingDown) return Promise.resolve({ status: "shutdown" });
    const previous = panelQueues.get(key) ?? Promise.resolve();
    const next = previous.catch((error) => logger.error?.("Previous Sengen panel operation failed", error))
      .then(task)
      .finally(() => { if (panelQueues.get(key) === next) panelQueues.delete(key); });
    panelQueues.set(key, next);
    return next;
  }

  async function withPanelLease(guild, task) {
    if (shuttingDown) return { status: "shutdown" };
    const lease = await acquireLease(`sengen-panel:${guild.id}`, { leaseMs: PANEL_LEASE_MS }).catch((error) => {
      logger.error?.("Sengen panel lease acquisition failed", error);
      return null;
    });
    if (!lease) return { status: "lease-unavailable", retryable: true, beforeDiscord: true };
    let leaseLost = false;
    let renewalRun = null;
    const assertLease = async () => {
      if (leaseLost) return false;
      if (!renewalRun) {
        renewalRun = (async () => {
          try {
            leaseLost = !(await renewLease(lease, { leaseMs: PANEL_LEASE_MS }));
            return !leaseLost;
          } catch (error) {
            leaseLost = true;
            logger.error?.("Sengen panel lease renewal failed", error);
            return false;
          }
        })().finally(() => { renewalRun = null; });
      }
      return renewalRun;
    };
    const heartbeat = setIntervalFn(() => { void assertLease(); }, PANEL_LEASE_RENEW_MS);
    heartbeat?.unref?.();
    try {
      return await task(assertLease);
    } finally {
      clearIntervalFn(heartbeat);
      if (renewalRun) await renewalRun;
      await releaseLease(lease).catch((error) => logger.error?.("Failed to release Sengen panel lease", error));
    }
  }

  async function textChannel(guild, channelId) {
    if (!guild || !channelId) return null;
    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (!channel || ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)
      || typeof channel.send !== "function" || !channel.messages?.fetch) return null;
    const botMember = guild.members?.me ?? await guild.members?.fetchMe?.().catch(() => null);
    const permissions = channel.permissionsFor?.(botMember);
    if (!permissions || !PANEL_PERMISSION_BITS.every((permission) => permissions.has(permission))) return null;
    return channel;
  }

  async function logError(context, error, declaration = null) {
    logger.error?.(`[sengen] ${context} guild=${declaration?.guildId ?? "?"} declaration=${declaration?._id ?? "?"}: ${error?.message ?? error}`);
  }

  async function deletePanelMessage(channel, messageId) {
    if (!channel || !messageId) return { status: "absent" };
    let message;
    try {
      message = await channel.messages.fetch(messageId);
    } catch (error) {
      if (isMissingDiscordResource(error)) return { status: "absent" };
      throw error;
    }
    if (!message) return { status: "absent" };
    try {
      await message.delete();
      return { status: "removed" };
    } catch (error) {
      if (isMissingDiscordResource(error)) return { status: "absent" };
      throw error;
    }
  }

  async function findUntrackedDeclarationMessage(channel, declaration) {
    const registeredAt = date(declaration.registeredAt);
    const cutoff = registeredAt ? registeredAt.getTime() - 5 * 60 * 1000 : Number.NEGATIVE_INFINITY;
    const seenBefore = new Set();
    let before;
    while (true) {
      const page = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
      const messages = [...page.values()];
      if (messages.length === 0) return null;
      const match = messages.find((message) => message.author?.id === client.user?.id
        && (hasSengenDeclarationMarker(message.content, declaration._id)
          || hasLegacyDeclarationRecordMarker(message, declaration._id)));
      if (match) return match;
      const oldest = messages.at(-1);
      const oldestTimestamp = messageCreatedTimestamp(oldest);
      if (messages.length < 100 || (oldestTimestamp !== null && oldestTimestamp <= cutoff)) return null;
      if (!oldest?.id || seenBefore.has(oldest.id)) return null;
      seenBefore.add(oldest.id);
      before = oldest.id;
    }
  }

  function samePanelPointer(left, right) {
    return Boolean(left && right && left.channelId === right.channelId && left.messageId === right.messageId);
  }

  async function assertPanelPointer(guildId, expected) {
    const current = await store.getPanel(guildId);
    return samePanelPointer(current, expected);
  }

  async function removeDuplicatePanels(guild, channel, keepMessageId, assertLease) {
    const messages = await channel.messages.fetch({ limit: 100 });
    const duplicates = [...messages.values()].filter((message) => message.id !== keepMessageId && isSengenPanelMessage(message, client));
    let removed = 0;
    for (const message of duplicates) {
      if (!(await assertLease()) || !(await assertPanelPointer(guild.id, { channelId: channel.id, messageId: keepMessageId }))) {
        return { status: "remove-failed", retryable: true, beforeDiscord: true };
      }
      try {
        await message.delete();
        removed += 1;
      } catch (error) {
        if (!isMissingDiscordResource(error)) {
          await logError("duplicate panel delete failed", error);
          return { status: "remove-failed", retryable: true, error };
        }
      }
      if (!(await assertLease()) || !(await assertPanelPointer(guild.id, { channelId: channel.id, messageId: keepMessageId }))) {
        return { status: "remove-failed", retryable: true, beforeDiscord: true };
      }
    }
    return { status: "removed", count: removed };
  }

  async function cleanupStalePanels(guild, state, assertLease) {
    for (const stalePanel of state?.stalePanels ?? []) {
      try {
        if (!(await assertLease()) || !(await assertPanelPointer(guild.id, state))) {
          return { status: "remove-failed", retryable: true, beforeDiscord: true };
        }
        let channel = null;
        try {
          channel = await guild.channels.fetch(stalePanel.channelId);
        } catch (error) {
          if (!isMissingDiscordResource(error)) throw error;
        }
        if (!(await assertLease()) || !(await assertPanelPointer(guild.id, state))) {
          return { status: "remove-failed", retryable: true, beforeDiscord: true };
        }
        await deletePanelMessage(channel, stalePanel.messageId);
        if (!(await assertLease()) || !(await assertPanelPointer(guild.id, state))) {
          return { status: "remove-failed", retryable: true, beforeDiscord: true };
        }
        await store.removeStalePanel(guild.id, stalePanel);
      } catch (error) {
        await logError("stale panel cleanup failed", error);
        return { status: "remove-failed", retryable: true, error };
      }
    }
    return { status: "removed" };
  }

  async function movePanelToBottomLocked(guild, reason, assertLease) {
    const settings = await getGuildSettings(guild.id);
    const channelId = settings?.sengenPanelChannelId;
    if (!channelId || !settings?.sengenPostChannelId || !settings?.sengenOverviewChannelId) return { status: "not-configured" };
    const channel = await textChannel(guild, channelId);
    if (!channel) return { status: "channel-unavailable" };
    const latest = await getGuildSettings(guild.id);
    if (latest?.sengenPanelChannelId !== channel.id) return { status: "configuration-changed" };
    if (!(await assertLease())) return { status: "lease-unavailable", retryable: true, beforeDiscord: true };
    const previous = await store.getPanel(guild.id);
    let message;
    try {
      message = await channel.send(panelPayload(latest.sengenOverviewChannelId));
    } catch (error) {
      await logError("panel send failed", error);
      return { status: "send-failed" };
    }
    if (!(await assertLease())) {
      await deletePanelMessage(channel, message.id).catch((error) => logError("untracked panel rollback delete failed", error));
      return { status: "lease-unavailable", retryable: true };
    }
    let saved;
    try {
      saved = await store.savePanel({
        guildId: guild.id,
        channelId: channel.id,
        messageId: message.id,
        expectedCurrent: previous,
        stalePanel: previous ? { channelId: previous.channelId, messageId: previous.messageId } : null,
      });
    } catch (error) {
      await deletePanelMessage(channel, message.id).catch((deleteError) => logError("new panel rollback delete failed", deleteError));
      await logError("panel state save failed", error);
      return { status: "save-failed" };
    }
    if (!saved) {
      await deletePanelMessage(channel, message.id).catch((deleteError) => logError("new panel conflict rollback delete failed", deleteError));
      return { status: "lease-unavailable", retryable: true, beforeDiscord: true };
    }
    if (previous && (previous.channelId !== channel.id || previous.messageId !== message.id)) {
      if (!(await assertLease()) || !(await assertPanelPointer(guild.id, { channelId: channel.id, messageId: message.id }))) {
        return { status: "remove-failed", retryable: true, beforeDiscord: true };
      }
      let previousChannel = null;
      try {
        previousChannel = previous.channelId === channel.id
          ? channel
          : await guild.channels.fetch(previous.channelId);
      } catch (error) {
        if (!isMissingDiscordResource(error)) return { status: "remove-failed", retryable: true, error };
      }
      try {
        if (!(await assertLease()) || !(await assertPanelPointer(guild.id, { channelId: channel.id, messageId: message.id }))) {
          return { status: "remove-failed", retryable: true, beforeDiscord: true };
        }
        await deletePanelMessage(previousChannel, previous.messageId);
        if (!(await assertLease()) || !(await assertPanelPointer(guild.id, { channelId: channel.id, messageId: message.id }))) {
          return { status: "remove-failed", retryable: true, beforeDiscord: true };
        }
        await store.removeStalePanel(guild.id, { channelId: previous.channelId, messageId: previous.messageId });
      } catch (error) {
        await logError("old panel delete failed", error);
        return { status: "remove-failed", retryable: true, error };
      }
    }
    const duplicates = await removeDuplicatePanels(guild, channel, message.id, assertLease);
    if (duplicates.status === "remove-failed") return duplicates;
    return { status: "moved", reason };
  }

  async function removePanelLocked(guild, assertLease) {
    const state = await store.getPanel(guild.id);
    if (!state) return { status: "absent" };
    const targets = [{ channelId: state.channelId, messageId: state.messageId }, ...(state.stalePanels ?? [])];
    try {
      for (const target of targets) {
        if (!(await assertLease()) || !(await assertPanelPointer(guild.id, state))) {
          return { status: "remove-failed", retryable: true, beforeDiscord: true };
        }
        let channel = null;
        try {
          channel = await guild.channels.fetch(target.channelId);
        } catch (error) {
          if (!isMissingDiscordResource(error)) throw error;
        }
        if (!(await assertLease()) || !(await assertPanelPointer(guild.id, state))) {
          return { status: "remove-failed", retryable: true, beforeDiscord: true };
        }
        await deletePanelMessage(channel, target.messageId);
      }
      if (!(await assertLease()) || !(await assertPanelPointer(guild.id, state))) {
        return { status: "remove-failed", retryable: true, beforeDiscord: true };
      }
      const result = await store.deletePanel(guild.id, { channelId: state.channelId, messageId: state.messageId });
      if (result?.deletedCount === 0) return { status: "remove-failed", retryable: true, beforeDiscord: true };
      return { status: "removed" };
    } catch (error) {
      await logError("panel remove failed", error);
      return { status: "remove-failed", retryable: true, error };
    }
  }

  async function ensurePanelLocked(guild, assertLease) {
    const settings = await getGuildSettings(guild.id);
    if (!settings?.sengenPanelChannelId || !settings?.sengenPostChannelId || !settings?.sengenOverviewChannelId) {
      return removePanelLocked(guild, assertLease);
    }
    const channel = await textChannel(guild, settings.sengenPanelChannelId);
    if (!channel) return { status: "channel-unavailable" };
    const state = await store.getPanel(guild.id);
    if (state?.channelId === channel.id) {
      const panel = await channel.messages.fetch(state.messageId).catch(() => null);
      if (panel && isCurrentSengenPanel(panel, client, settings.sengenOverviewChannelId)) {
        const messages = await channel.messages.fetch({ limit: 100 });
        if (messages.first()?.id === panel.id
          && await assertLease()
          && await assertPanelPointer(guild.id, state)) {
          const staleCleanup = await cleanupStalePanels(guild, state, assertLease);
          if (staleCleanup.status === "remove-failed") return staleCleanup;
          const duplicates = await removeDuplicatePanels(guild, channel, panel.id, assertLease);
          if (duplicates.status === "remove-failed") return duplicates;
          return { status: "current" };
        }
      }
    }
    return movePanelToBottomLocked(guild, "ensure", assertLease);
  }

  function movePanelToBottom(guild, reason = "request") {
    return enqueuePanel(guild.id, () => withPanelLease(guild, (assertLease) => movePanelToBottomLocked(guild, reason, assertLease)));
  }

  function ensurePanel(guild) {
    return enqueuePanel(guild.id, () => withPanelLease(guild, (assertLease) => ensurePanelLocked(guild, assertLease)));
  }

  function removePanel(guild) {
    return enqueuePanel(guild.id, () => withPanelLease(guild, (assertLease) => removePanelLocked(guild, assertLease)));
  }

  async function requestPanelMove(guild, reason = "request") {
    if (shuttingDown) return { status: "shutdown" };
    if (!guild) return { status: "guild-unavailable" };
    const settings = await getGuildSettings(guild.id);
    const channelId = settings?.sengenPanelChannelId;
    if (!channelId) return { status: "not-configured" };
    const key = `${guild.id}:${channelId}`;
    const existing = panelTimers.get(key);
    if (existing) {
      clearTimeout(existing.timer);
      existing.resolve({ status: "debounced" });
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        panelTimers.delete(key);
        resolve(enqueuePanel(guild.id, () => withPanelLease(
          guild,
          (assertLease) => movePanelToBottomLocked(guild, reason, assertLease),
        )));
      }, 1_000);
      panelTimers.set(key, { timer, resolve });
    });
  }

  async function resolveDeclarationGuild(declaration) {
    return client.guilds.cache.get(declaration.guildId)
      ?? await client.guilds.fetch(declaration.guildId).catch(() => null);
  }

  async function syncPublicDeclaration(declaration) {
    const declarationId = typeof declaration === "string" ? declaration : declaration?._id;
    if (!declarationId) return false;
    const lease = await acquireLease(`sengen-public:${declarationId}`, { leaseMs: 30_000 }).catch(() => null);
    if (!lease) return false;
    try {
      const current = await store.getDeclaration(declarationId);
      if (!current?.publicSyncPending) return Boolean(current);
      if (!current.postMessageId) return false;
      const guild = await resolveDeclarationGuild(current);
      const channel = await guild?.channels?.fetch?.(current.postChannelId).catch(() => null);
      if (!channel?.messages?.fetch) {
        await store.setPublicSyncError(current._id, new Error("Public declaration channel is unavailable"), nowDate()).catch(() => null);
        return false;
      }
      const message = await channel.messages.fetch(current.postMessageId).catch(() => null);
      if (!message) {
        await store.setPublicSyncError(current._id, new Error("Public declaration message is unavailable"), nowDate()).catch(() => null);
        return false;
      }
      try {
        await message.edit({
          content: appendSengenDeclarationMarker(buildSengenDeclarationContent(current), current._id),
          components: buildPublicComponents(current),
          allowedMentions: { parse: [] },
        });
        const result = await store.markPublicSynced(current._id, Number(current.publicRevision ?? 0), nowDate());
        return result?.matchedCount === undefined || result.matchedCount === 1;
      } catch (error) {
        await store.setPublicSyncError(current._id, error, nowDate()).catch(() => null);
        await logError("public declaration update failed", error, current);
        return false;
      }
    } finally {
      await releaseLease(lease).catch((error) => logger.error?.("Sengen public update lease release failed", error));
    }
  }

  async function sendDm(userId, payload) {
    try {
      const user = await client.users.fetch(userId);
      await user.send({ ...payload, allowedMentions: { parse: [] } });
      return true;
    } catch (error) {
      logger.warn?.(`[sengen] DM unavailable user=${userId}: ${error?.message ?? error}`);
      return false;
    }
  }

  async function updateProgressSchedule(declaration, current, { skip = false } = {}) {
    const intervalDays = Number(declaration.intervalDays);
    if (!Number.isInteger(intervalDays) || intervalDays < 1) return null;
    let nextAt = date(current);
    if (!nextAt) return null;
    while (nextAt.getTime() <= nowDate().getTime()) nextAt = addJstDaysAt18(nextAt, intervalDays);
    if (nextAt.getTime() >= date(declaration.deadlineAt).getTime()) nextAt = null;
    const claimed = await store.claimProgress(declaration._id, current, nextAt, nowDate());
    if (!claimed || skip) return claimed;
    const latenessMs = nowDate().getTime() - date(current).getTime();
    if (latenessMs > PROGRESS_LATE_GRACE_MS) return claimed;
    const link = buildSengenMessageUrl(declaration.guildId, declaration.postChannelId, declaration.postMessageId);
    const content = [
      `「${sanitizeSengenText(declaration.content, 300)}」`,
      "",
      `期限：${formatJstShortDateTime(declaration.deadlineAt)}（日本時間）`,
      "今の状況を教えてください！回答は任意です。",
      ...(link ? [`\n宣言の投稿：${link}`] : []),
    ].join("\n");
    await sendDm(declaration.userId, {
      content,
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`sengen:progress:${declaration._id}:steady`).setLabel("順調").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`sengen:progress:${declaration._id}:late`).setLabel("遅れ気味").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`sengen:progress:${declaration._id}:low`).setLabel("あんまり").setStyle(ButtonStyle.Secondary),
      )],
    });
    return claimed;
  }

  async function sendResultPrompt(declaration) {
    const claimed = await store.claimResultPrompt(declaration._id, nowDate());
    if (!claimed) return false;
    const link = buildSengenMessageUrl(claimed.guildId, claimed.postChannelId, claimed.postMessageId);
    const sent = await sendDm(claimed.userId, {
      content: [
        "📣 宣言の期限になりました！",
        "",
        `「${sanitizeSengenText(claimed.content, 300)}」`,
        "",
        "目標は達成できましたか？",
        "よければ、結果を教えてください。回答すると、宣言の投稿に結果が反映されます。",
        "失敗した場合は、あとから理由を書くこともできます。",
        ...(link ? [`\n宣言の投稿：${link}`] : []),
      ].join("\n"),
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`sengen:result:${claimed._id}:achieved`).setLabel("達成").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`sengen:result:${claimed._id}:failed`).setLabel("失敗").setStyle(ButtonStyle.Danger),
      )],
    });
    return sent;
  }

  async function processScheduledWork({ startup = false } = {}) {
    if (shuttingDown) return { status: "shutdown" };
    if (startup) startupProgressSkipPending = true;
    if (workerRun) return workerRun;
    workerRun = (async () => {
      const lease = await acquireLease("sengen:scheduler", { leaseMs: 60_000 }).catch((error) => {
        logger.error?.("Sengen scheduler lease acquisition failed", error);
        return null;
      });
      if (!lease) return { status: "lease-unavailable" };
      try {
        const at = nowDate();
        const unpublished = await store.listUnpublished().catch((error) => {
          logger.error?.("Failed to list unpublished Sengen declarations", error);
          return [];
        });
        for (const declaration of unpublished ?? []) {
          try {
            const guild = await resolveDeclarationGuild(declaration);
            const channel = await guild?.channels?.fetch?.(declaration.postChannelId).catch(() => null);
            if (!channel?.messages?.fetch) continue;
            const message = await findUntrackedDeclarationMessage(channel, declaration);
            if (message) await store.setPostMessage(declaration._id, message.id);
          } catch (error) {
            await logError("unpublished declaration recovery failed", error, declaration);
          }
        }
        const dueResults = await store.listDueResultPrompts(at).catch((error) => {
          logger.error?.("Failed to list Sengen result prompts", error);
          return [];
        });
        for (const declaration of dueResults ?? []) {
          await sendResultPrompt(declaration).catch((error) => logError("result DM processing failed", error, declaration));
        }

        let dueProgress = [];
        let progressWorkSucceeded = false;
        try {
          dueProgress = await store.listDueProgress(at);
          progressWorkSucceeded = true;
          for (const declaration of dueProgress ?? []) {
            try {
              await updateProgressSchedule(declaration, declaration.nextProgressAt, { skip: startupProgressSkipPending });
            } catch (error) {
              progressWorkSucceeded = false;
              await logError("progress reminder processing failed", error, declaration);
            }
          }
        } catch (error) {
          logger.error?.("Failed to list Sengen progress reminders", error);
        }
        if (startupProgressSkipPending && progressWorkSucceeded) startupProgressSkipPending = false;

        const pendingPublic = await store.listPublicSyncPending().catch((error) => {
          logger.error?.("Failed to list Sengen public updates", error);
          return [];
        });
        for (const declaration of pendingPublic ?? []) {
          await syncPublicDeclaration(declaration).catch((error) => logError("public update retry failed", error, declaration));
        }
        return { status: "processed", resultCount: dueResults?.length ?? 0, progressCount: dueProgress?.length ?? 0, publicCount: pendingPublic?.length ?? 0 };
      } finally {
        await releaseLease(lease).catch((error) => logger.error?.("Sengen scheduler lease release failed", error));
      }
    })().finally(() => { workerRun = null; });
    return workerRun;
  }

  async function restore(readyClient = client) {
    const guilds = [...(readyClient.guilds?.cache?.values?.() ?? [])];
    await Promise.allSettled(guilds.map(async (guild) => {
      try {
        await ensurePanel(guild);
      } catch (error) {
        await logError("startup panel restore failed", error);
      }
    }));
    await processScheduledWork({ startup: true });
  }

  function start() {
    if (workerTimer || shuttingDown) return;
    workerTimer = setIntervalFn(() => {
      void processScheduledWork().catch((error) => logger.error?.("Sengen scheduler failed", error));
    }, tickMs);
    workerTimer?.unref?.();
  }

  async function shutdown() {
    shuttingDown = true;
    if (workerTimer) clearIntervalFn(workerTimer);
    workerTimer = null;
    for (const pending of panelTimers.values()) {
      clearTimeout(pending.timer);
      pending.resolve?.({ status: "shutdown" });
    }
    panelTimers.clear();
    await Promise.allSettled([
      ...(workerRun ? [workerRun] : []),
      ...panelQueues.values(),
    ]);
  }

  async function replyEphemeral(interaction, content, components = []) {
    const payload = { content, components, allowedMentions: { parse: [] } };
    if (interaction.deferred) return interaction.editReply(payload);
    if (interaction.replied) return interaction.followUp({ ...payload, flags: MessageFlags.Ephemeral });
    return interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
  }

  async function updateInteraction(interaction, content, components = []) {
    const payload = { content, components, allowedMentions: { parse: [] } };
    if (interaction.deferred) return interaction.editReply(payload);
    if (interaction.replied) return interaction.followUp(payload);
    if (typeof interaction.update === "function") return interaction.update(payload);
    return replyEphemeral(interaction, content, components);
  }

  function showPreviewComponents(draftId) {
    return [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`sengen:confirm:${draftId}`).setLabel("この内容で宣言する").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`sengen:discard:${draftId}`).setLabel("やめる").setStyle(ButtonStyle.Secondary),
    )];
  }

  async function showDraftPreview(interaction, draft, { update = false } = {}) {
    const currentDateKey = getJstDateKey(nowDate());
    let visibleDraft = draft;
    if (draft.previewDateKey !== currentDateKey) {
      visibleDraft = await store.refreshDraftDate(draft.draftId, draft.userId, draft.guildId, currentDateKey, nowDate()) ?? draft;
    }
    const preview = previewText(visibleDraft, nowDate());
    const payload = { content: preview.content, components: showPreviewComponents(visibleDraft.draftId), allowedMentions: { parse: [] } };
    if (update || interaction.deferred) return interaction.editReply(payload);
    return interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
  }

  function declarationModal(panelChannelId) {
    const input = (id, label, style, max, required, placeholder = "") => new ActionRowBuilder().addComponents(new TextInputBuilder()
      .setCustomId(id)
      .setLabel(label)
      .setStyle(style)
      .setMaxLength(max)
      .setRequired(required)
      .setPlaceholder(placeholder));
    return new ModalBuilder().setCustomId(`sengen:declaration_modal:${panelChannelId ?? "unknown"}`).setTitle("宣言する")
      .addComponents(
        input("sengen_content", "宣言内容", TextInputStyle.Paragraph, 300, true, "例：3回以上VCで話す"),
        input("sengen_term", "有効期間（日、1〜90）", TextInputStyle.Short, 2, true),
        input("sengen_interval", "途中確認の間隔（日、任意）", TextInputStyle.Short, 2, false),
      );
  }

  async function handleOpen(interaction) {
    if (!interaction.inGuild?.() || !interaction.guildId) {
      return replyEphemeral(interaction, "サーバー内で使用してください。");
    }
    if (interaction.user?.bot) return replyEphemeral(interaction, "Botは宣言を登録できません。");
    return interaction.showModal(declarationModal(interaction.channelId));
  }

  async function handleDeclarationModal(interaction, panelChannelId) {
    const settings = await getGuildSettings(interaction.guildId);
    if (panelChannelId && panelChannelId !== "unknown" && settings?.sengenPanelChannelId !== panelChannelId) {
      return replyEphemeral(interaction, "宣言ボタンの設置先が変更されました。新しいボタンからもう一度お試しください。");
    }
    if (!settings?.sengenPostChannelId || !settings?.sengenOverviewChannelId) {
      return replyEphemeral(interaction, "宣言先が設定されていません。管理者に確認してください。");
    }
    const validation = validateSengenInput({
      content: interaction.fields.getTextInputValue("sengen_content"),
      termDays: interaction.fields.getTextInputValue("sengen_term"),
      intervalDays: interaction.fields.getTextInputValue("sengen_interval"),
    });
    if (!validation.ok) {
      const message = validation.reason === "empty-content" ? "宣言内容を入力してください。"
        : validation.reason === "invalid-term" ? "有効期間は1〜90日の整数で入力してください。"
          : "確認間隔は有効期間より短い1〜89日の整数で入力してください。";
      return replyEphemeral(interaction, message);
    }
    const targetGuild = interaction.guild ?? client.guilds.cache.get(interaction.guildId);
    const postChannel = await textChannel(targetGuild, settings.sengenPostChannelId);
    if (!postChannel) return replyEphemeral(interaction, "宣言の投稿先を利用できません。管理者に確認してください。");
    const createdAt = nowDate();
    const draftId = randomUUID();
    const draft = await store.createDraft({
      draftId,
      guildId: interaction.guildId,
      userId: interaction.user.id,
      ...validation,
      postChannelId: settings.sengenPostChannelId,
      overviewChannelId: settings.sengenOverviewChannelId,
      previewDateKey: getJstDateKey(createdAt),
      expiresAt: new Date(createdAt.getTime() + DRAFT_TTL_MS),
      consumedAt: null,
    });
    return showDraftPreview(interaction, draft);
  }

  async function handleConfirmDraft(interaction, draftId) {
    let draft = await store.getDraft(draftId, interaction.user.id, interaction.guildId);
    if (!draft) return updateInteraction(interaction, "このプレビューは期限切れか、すでに確定済みです。もう一度宣言ボタンから始めてください。");
    const settings = await getGuildSettings(interaction.guildId);
    if (!settings?.sengenPostChannelId || !settings?.sengenOverviewChannelId) {
      return updateInteraction(interaction, "宣言機能の設定が変更されたため、このプレビューは確定できません。管理者に確認してください。", []);
    }
    if (draft.postChannelId !== settings.sengenPostChannelId || draft.overviewChannelId !== settings.sengenOverviewChannelId) {
      draft = await store.refreshDraftConfiguration(draft.draftId, draft.userId, draft.guildId, {
        postChannelId: settings.sengenPostChannelId,
        overviewChannelId: settings.sengenOverviewChannelId,
      }, nowDate()) ?? draft;
      return showDraftPreview(interaction, draft, { update: true });
    }
    if (draft.previewDateKey !== getJstDateKey(nowDate())) return showDraftPreview(interaction, draft, { update: true });
    const lease = await acquireLease(`sengen-register:${draft.guildId}:${draft.userId}`, { leaseMs: 60_000 });
    if (!lease) return updateInteraction(interaction, "宣言の登録処理中です。少し待ってから状態を確認してください。");
    try {
      const at = nowDate();
      if (getJstDateKey(at) !== draft.previewDateKey) return showDraftPreview(interaction, draft, { update: true });
      const guild = interaction.guild ?? client.guilds.cache.get(draft.guildId);
      const channel = await textChannel(guild, draft.postChannelId);
      if (!channel) return updateInteraction(interaction, "宣言の投稿先を利用できないため、登録できませんでした。設定を確認して、もう一度お試しください。");
      const count = await store.countActive(draft.guildId, draft.userId, at);
      if (count >= 3) return updateInteraction(interaction, "同時に進行できる宣言は3件までです。期限を迎えると新しい宣言を登録できます。");
      const claimedDraft = await store.claimDraft(draftId, draft.userId, draft.guildId, at);
      if (!claimedDraft) return updateInteraction(interaction, "このプレビューはすでに確定済みです。二重登録は行っていません。");
      const deadlineAt = addJstDaysAt18(at, claimedDraft.termDays);
      const nextProgressAt = claimedDraft.intervalDays
        ? addJstDaysAt18(at, claimedDraft.intervalDays)
        : null;
      const declaration = await store.createDeclaration({
        guildId: claimedDraft.guildId,
        userId: claimedDraft.userId,
        content: claimedDraft.content,
        termDays: claimedDraft.termDays,
        intervalDays: claimedDraft.intervalDays ?? null,
        registeredAt: at,
        deadlineAt,
        nextProgressAt: nextProgressAt && nextProgressAt < deadlineAt ? nextProgressAt : null,
        postChannelId: claimedDraft.postChannelId,
        postMessageId: null,
        result: null,
        resultPromptSentAt: null,
        resultSubmittedAt: null,
        failureReason: null,
        publicSyncPending: false,
      });
      let message;
      try {
        message = await channel.send({
          content: appendSengenDeclarationMarker(buildSengenDeclarationContent(declaration), declaration._id),
          components: buildPublicComponents(declaration),
          allowedMentions: { parse: [] },
        });
        const tracked = await store.setPostMessage(declaration._id, message.id);
        if (!tracked) throw new Error("Public post was sent but its message ID could not be saved.");
      } catch (error) {
        await logError("public registration failed", error, declaration);
        if (!message) {
          await store.markPublicationOrphaned(declaration._id, error, nowDate()).catch(() => null);
          return updateInteraction(interaction, "宣言の投稿状態を確認できないため、二重登録を防止しました。もう一度投稿せず、管理者に確認してください。");
        }
        const retracked = await store.setPostMessage(declaration._id, message.id).catch(() => null);
        if (!retracked) {
          await store.markPublicationOrphaned(declaration._id, error, nowDate()).catch(() => null);
          return updateInteraction(interaction, "宣言は公開されましたが投稿状態の保存に失敗しました。二重登録を防ぐため、この宣言を再投稿せず管理者に確認してください。");
        }
      }
      if (claimedDraft.postChannelId === (await getGuildSettings(claimedDraft.guildId))?.sengenPanelChannelId) {
        void requestPanelMove(guild, "declaration-published").catch((error) => logError("panel move after declaration failed", error, declaration));
      }
      return updateInteraction(interaction, "宣言を公開しました！\n期限当日にDMで結果を確認します。", []);
    } catch (error) {
      await logError("registration confirmation failed", error);
      return updateInteraction(interaction, "宣言を登録できませんでした。時間をおいて、もう一度お試しください。");
    } finally {
      await releaseLease(lease).catch((error) => logger.error?.("Sengen registration lease release failed", error));
    }
  }

  async function getOwnedDeclaration(interaction, declarationId) {
    const declaration = await store.getDeclaration(declarationId);
    if (!declaration || declaration.userId !== interaction.user?.id) return null;
    if (interaction.guildId && declaration.guildId !== interaction.guildId) return null;
    return declaration;
  }

  async function handleProgress(interaction, declarationId) {
    const declaration = await getOwnedDeclaration(interaction, declarationId);
    if (!declaration || declaration.result || date(declaration.deadlineAt).getTime() <= nowDate().getTime()) {
      return updateInteraction(interaction, "この途中確認は現在回答できません。", []);
    }
    return updateInteraction(interaction, "回答ありがとうございます！", []);
  }

  async function handleResultChoice(interaction, declarationId, result) {
    const declaration = await getOwnedDeclaration(interaction, declarationId);
    if (!declaration || declaration.result || date(declaration.deadlineAt).getTime() > nowDate().getTime()) {
      return updateInteraction(interaction, "この結果確認は現在回答できません。期限を迎えた宣言から回答してください。", []);
    }
    const url = buildSengenMessageUrl(declaration.guildId, declaration.postChannelId, declaration.postMessageId);
    const components = [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`sengen:result-confirm:${declaration._id}:${result}`).setLabel("この結果で確定する").setStyle(result === "achieved" ? ButtonStyle.Success : ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`sengen:result-cancel:${declaration._id}`).setLabel("戻る").setStyle(ButtonStyle.Secondary),
    )];
    return updateInteraction(interaction, [
      `結果を「${result === "achieved" ? "達成" : "失敗"}」で報告します。`,
      "確定後に管理者以外が結果を変更することはできません。",
      ...(url ? [`宣言の投稿：${url}`] : []),
    ].join("\n"), components);
  }

  async function handleResultConfirm(interaction, declarationId, result) {
    const declaration = await getOwnedDeclaration(interaction, declarationId);
    if (!declaration || date(declaration.deadlineAt).getTime() > nowDate().getTime()) {
      return updateInteraction(interaction, "期限後に結果を回答できます。", []);
    }
    const saved = await store.submitResult({
      declarationId,
      guildId: declaration.guildId,
      userId: interaction.user.id,
      result,
      now: nowDate(),
    });
    if (!saved) return updateInteraction(interaction, "この結果はすでに記録されています。", []);
    const synced = await syncPublicDeclaration(saved);
    if (result === "failed") {
      const components = [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`sengen:reason:${declarationId}`).setLabel("失敗理由を書く").setStyle(ButtonStyle.Secondary),
        ...(!synced ? [new ButtonBuilder().setCustomId(`sengen:retry:${declarationId}`).setLabel("投稿を更新").setStyle(ButtonStyle.Primary)] : []),
      )];
      return updateInteraction(interaction, [
        "よければ、失敗した理由を書き残せます。入力は任意です。",
        "入力した理由は、宣言の投稿に公開されます。",
        ...(!synced ? ["結果は保存しましたが、宣言の投稿の更新に失敗しました。Botが再試行します。"] : []),
      ].join("\n"), components);
    }
    return updateInteraction(interaction, synced
      ? "回答ありがとうございます！"
      : "回答を保存しましたが、宣言の投稿を更新できませんでした。Botが再試行します。下のボタンから再試行できます。", synced ? [] : [component(`sengen:retry:${declarationId}`, "投稿を更新", ButtonStyle.Primary)]);
  }

  function failureReasonModal(declarationId, existing = "") {
    const inputBuilder = new TextInputBuilder()
      .setCustomId("sengen_reason")
      .setLabel("失敗した理由（任意）")
      .setStyle(TextInputStyle.Paragraph)
      .setMaxLength(500)
      .setRequired(false);
    if (existing) inputBuilder.setValue(sanitizeSengenText(existing, 500));
    return new ModalBuilder().setCustomId(`sengen:reason-modal:${declarationId}`).setTitle("失敗理由")
      .addComponents(new ActionRowBuilder().addComponents(inputBuilder));
  }

  async function handleReasonOpen(interaction, declarationId) {
    const declaration = await getOwnedDeclaration(interaction, declarationId);
    if (!declaration || declaration.result !== "failed") {
      return replyEphemeral(interaction, "この宣言は失敗結果ではないため、理由を編集できません。", []);
    }
    return interaction.showModal(failureReasonModal(declarationId, declaration.failureReason ?? ""));
  }

  async function handleReasonModal(interaction, declarationId) {
    const declaration = await getOwnedDeclaration(interaction, declarationId);
    if (!declaration || declaration.result !== "failed") return replyEphemeral(interaction, "この宣言は失敗結果ではないため、理由を編集できません。");
    const reason = sanitizeSengenText(interaction.fields.getTextInputValue("sengen_reason"), 500);
    const saved = await store.updateFailureReason({
      declarationId,
      guildId: declaration.guildId,
      userId: interaction.user.id,
      reason,
      now: nowDate(),
    });
    if (!saved) return replyEphemeral(interaction, "失敗理由を保存できませんでした。宣言の結果を確認してください。");
    const synced = await syncPublicDeclaration(saved);
    const editButton = new ButtonBuilder()
      .setCustomId(`sengen:reason:${declarationId}`)
      .setLabel(reason ? "失敗理由を編集" : "失敗理由を書く")
      .setStyle(ButtonStyle.Secondary);
    const retryButton = !synced ? new ButtonBuilder()
      .setCustomId(`sengen:retry:${declarationId}`)
      .setLabel("投稿を更新")
      .setStyle(ButtonStyle.Primary) : null;
    const content = [
      synced ? "失敗理由を宣言の投稿に反映しました。" : "失敗理由を保存しましたが、宣言の投稿を更新できませんでした。Botが再試行します。",
      `現在の失敗理由：${reason}`,
    ].join("\n");
    const messageComponents = [new ActionRowBuilder().addComponents(editButton, ...(retryButton ? [retryButton] : []))];
    if (interaction.deferred) {
      return interaction.editReply({ content, components: messageComponents, allowedMentions: { parse: [] } });
    }
    return interaction.reply({ content, flags: MessageFlags.Ephemeral, components: messageComponents, allowedMentions: { parse: [] } });
  }

  async function handleRetryPublic(interaction, declarationId) {
    const declaration = await store.getDeclaration(declarationId);
    if (!declaration) return updateInteraction(interaction, "この宣言を確認できませんでした。", []);
    const sameGuild = interaction.inGuild?.() && interaction.guildId === declaration.guildId;
    const isOwner = declaration.userId === interaction.user?.id
      && (!interaction.guildId || interaction.guildId === declaration.guildId);
    const isGuildAdmin = sameGuild && isManageGuild(interaction);
    if (!isOwner && !isGuildAdmin) return updateInteraction(interaction, "この公開更新を再試行する権限がありません。", []);
    const synced = declaration.publicSyncPending ? await syncPublicDeclaration(declaration) : true;
    const current = await store.getDeclaration(declarationId).catch(() => declaration);
    const controls = [];
    if (isOwner && current.result === "failed") {
      controls.push(component(
        `sengen:reason:${declarationId}`,
        current.failureReason ? "失敗理由を編集" : "失敗理由を書く",
        ButtonStyle.Secondary,
      ));
    }
    if (!synced || current.publicSyncPending) {
      controls.push(component(`sengen:retry:${declarationId}`, "投稿を更新", ButtonStyle.Primary));
    }
    const status = synced && !current.publicSyncPending
      ? "宣言の投稿を確認しました。"
      : "投稿を更新できませんでした。Botが引き続き再試行します。";
    const body = isOwner && current.result === "failed"
      ? `${status}\n現在の失敗理由：${current.failureReason ?? ""}`
      : status;
    return updateInteraction(interaction, body, controls);
  }

  async function handleAdminCorrection(interaction, declarationId, result) {
    if (!interaction.inGuild?.() || !isManageGuild(interaction)) return replyEphemeral(interaction, "結果を訂正できるのはサーバー管理者だけです。");
    const declaration = await store.getDeclaration(declarationId, interaction.guildId);
    if (!declaration?.result) return replyEphemeral(interaction, "訂正できる結果がまだありません。");
    return replyEphemeral(interaction, `この宣言を「${result === "achieved" ? "達成" : "失敗"}」に訂正しますか？失敗理由はクリアされます。`, [component(`sengen:admin-confirm:${declarationId}:${result}`, "訂正を確定", ButtonStyle.Danger)]);
  }

  async function handleAdminCorrectionConfirm(interaction, declarationId, result) {
    if (!interaction.inGuild?.() || !isManageGuild(interaction)) return replyEphemeral(interaction, "結果を訂正できるのはサーバー管理者だけです。");
    const saved = await store.correctResult({ declarationId, guildId: interaction.guildId, result, now: nowDate() });
    if (!saved) return updateInteraction(interaction, "対象結果が見つからないか、先に訂正されています。", []);
    const synced = await syncPublicDeclaration(saved);
    return updateInteraction(interaction, synced
      ? `結果を「${result === "achieved" ? "達成" : "失敗"}」に訂正しました。`
      : "訂正は保存しましたが、宣言の投稿を更新できませんでした。Botが再試行します。", synced ? [] : [component(`sengen:retry:${declarationId}`, "投稿を更新", ButtonStyle.Primary)]);
  }

  async function handleInteraction(interaction) {
    const customId = interaction?.customId;
    if (!interactionIsButton(interaction) && !String(customId ?? "").startsWith("sengen:")) return false;
    if (customId === "sengen:open") return handleOpen(interaction);
    if (String(customId).startsWith("sengen:declaration_modal:")) {
      if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      return handleDeclarationModal(interaction, String(customId).split(":")[2]);
    }
    if (String(customId).startsWith("sengen:reason-modal:")) {
      if (!interaction.deferred && !interaction.replied) {
        if (interaction.isFromMessage?.() && typeof interaction.deferUpdate === "function") await interaction.deferUpdate();
        else await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      }
      return handleReasonModal(interaction, customId.split(":")[2]);
    }
    const parts = String(customId).split(":");
    const [, action, declarationId, value] = parts;
    if (action === "record") return replyEphemeral(interaction, "このボタンは操作できません。", []);
    if (action === "reason") return handleReasonOpen(interaction, declarationId);
    if (!interaction.deferred && !interaction.replied) {
      if (action === "correct") await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      else if (typeof interaction.deferUpdate === "function") await interaction.deferUpdate();
    }
    if (action === "confirm") return handleConfirmDraft(interaction, declarationId);
    if (action === "discard") return updateInteraction(interaction, "宣言を取りやめました。", []);
    if (action === "progress") return handleProgress(interaction, declarationId);
    if (action === "result") return handleResultChoice(interaction, declarationId, value);
    if (action === "result-confirm") return handleResultConfirm(interaction, declarationId, value);
    if (action === "result-cancel") {
      const declaration = await getOwnedDeclaration(interaction, declarationId);
      if (!declaration || declaration.result || date(declaration.deadlineAt).getTime() > nowDate().getTime()) return updateInteraction(interaction, "この結果確認は終了しています。", []);
      const url = buildSengenMessageUrl(declaration.guildId, declaration.postChannelId, declaration.postMessageId);
      return updateInteraction(interaction, [
        "回答は保留しました。期限後にもう一度回答できます。",
        ...(url ? [`宣言の投稿：${url}`] : []),
      ].join("\n"), [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`sengen:result:${declarationId}:achieved`).setLabel("達成").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`sengen:result:${declarationId}:failed`).setLabel("失敗").setStyle(ButtonStyle.Danger),
      )]);
    }
    if (action === "retry") return handleRetryPublic(interaction, declarationId);
    if (action === "correct") return handleAdminCorrection(interaction, declarationId, value);
    if (action === "admin-confirm") return handleAdminCorrectionConfirm(interaction, declarationId, value);
    return false;
  }

  return {
    ensurePanel,
    movePanelToBottom,
    removePanel,
    requestPanelMove,
    handleInteraction,
    processScheduledWork,
    restore,
    start,
    shutdown,
    syncPublicDeclaration,
    updateProgressSchedule,
  };
}

export { panelPayload, previewText };
