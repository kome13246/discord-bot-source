import crypto from "node:crypto";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
} from "discord.js";
import { OperationalStatusBoard } from "./models/operational-status-board.js";
import { OperationalHealthState } from "./models/operational-health-state.js";

export const OPERATIONAL_STATUS_MARKER = "operational-status-board:v1";
const TEXT_CHANNEL_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
const REFRESH_DEBOUNCE_MS = 2_000;
const REFRESH_INTERVAL_MS = 60 * 60 * 1_000;

const severityColor = {
  healthy: 0x2ecc71,
  info: 0x3498db,
  warning: 0xf1c40f,
  error: 0xe74c3c,
  unknown: 0x95a5a6,
  disabled: 0x7f8c8d,
};

const severityLabel = {
  healthy: "正常",
  info: "進行中",
  warning: "確認推奨",
  error: "要対応",
  unknown: "不明",
  disabled: "無効・未設定",
};

function truncate(value, max = 850) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function formatTime(value) {
  if (!value) return "未設定";
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? `<t:${Math.floor(timestamp / 1000)}:f>` : "不明";
}

function statusLine(module) {
  return `${severityLabel[module?.severity] ?? "不明"} — ${truncate(module?.summary ?? "状態なし", 600)}`;
}

function moduleField(module) {
  const issueLines = (module?.issues ?? []).slice(0, 3).map((item) => `・${truncate(item.message ?? item, 260)}`);
  return {
    name: `${module?.label ?? module?.key ?? "不明"} [${severityLabel[module?.severity] ?? "不明"}]`,
    value: truncate([statusLine(module), ...issueLines].join("\n"), 1024) || "状態なし",
    inline: false,
  };
}

function createComponents(guildId) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`operational:refresh:${guildId}`).setLabel("今すぐ更新").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`operational:details:${guildId}`).setLabel("問題の詳細").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`operational:manage:${guildId}`).setLabel("管理操作").setStyle(ButtonStyle.Danger),
  )];
}

export function buildOperationalStatusPayload(snapshot) {
  const modules = snapshot?.modules ?? {};
  const system = modules.system ?? snapshot?.system ?? {};
  const systemDetails = system.details ?? {};
  const systemEmbed = new EmbedBuilder()
    .setTitle("Bot運用ステータス")
    .setColor(severityColor[system.severity] ?? severityColor.unknown)
    .setDescription(statusLine(system))
    .addFields(
      { name: "Discord", value: systemDetails.discordReady ? "ready" : "未接続", inline: true },
      { name: "MongoDB", value: systemDetails.databaseStatus ?? "不明", inline: true },
      { name: "起動時復元", value: systemDetails.startupRestoreStatus ?? "不明", inline: true },
      { name: "要対応 / 確認推奨", value: `${snapshot?.attentionCount ?? 0} / ${snapshot?.recommendationCount ?? 0}`, inline: true },
      { name: "Bot起動日時", value: formatTime(systemDetails.botStartedAt), inline: true },
      { name: "最終状態確認", value: formatTime(snapshot?.observedAt), inline: true },
    )
    .setFooter({ text: OPERATIONAL_STATUS_MARKER });

  const recruitmentEmbed = new EmbedBuilder()
    .setTitle("会話練習会・募集")
    .setColor([modules.kokuchi, modules.splitvc, modules.recruitment].some((module) => ["error", "unknown"].includes(module?.severity)) ? severityColor.error : severityColor.info)
    .addFields(
      moduleField(modules.kokuchi),
      moduleField(modules.splitvc),
      moduleField(modules.recruitment),
    )
    .setFooter({ text: OPERATIONAL_STATUS_MARKER });

  const operationsEmbed = new EmbedBuilder()
    .setTitle("自動投稿・パネル・VC")
    .setColor([modules.automation, modules.panels, modules.voice].some((module) => ["error", "unknown"].includes(module?.severity)) ? severityColor.error : severityColor.info)
    .addFields(
      moduleField(modules.automation),
      moduleField(modules.panels),
      moduleField(modules.voice),
    )
    .setFooter({ text: OPERATIONAL_STATUS_MARKER });

  return {
    embeds: [systemEmbed, recruitmentEmbed, operationsEmbed],
    components: createComponents(snapshot.guildId),
    allowedMentions: { parse: [] },
  };
}

function payloadHash(payload) {
  const normalized = {
    embeds: payload.embeds.map((embed) => typeof embed.toJSON === "function" ? embed.toJSON() : embed),
    components: payload.components.map((row) => typeof row.toJSON === "function" ? row.toJSON() : row),
  };
  const stableJson = JSON.stringify(normalized).replace(/<t:\d+:f>/g, "<t:observed:f>");
  return crypto.createHash("sha256").update(stableJson).digest("hex");
}

async function getBoard(guildId) {
  const query = OperationalStatusBoard.findOne({ guildId });
  return typeof query.lean === "function" ? query.lean() : query;
}

function isTextChannel(channel) {
  return Boolean(channel && TEXT_CHANNEL_TYPES.includes(channel.type) && typeof channel.send === "function");
}

function hasBoardPermissions(channel, guild) {
  const botMember = guild?.members?.me;
  const permissions = botMember && channel?.permissionsFor?.(botMember);
  return Boolean(permissions?.has?.(PermissionFlagsBits.ViewChannel)
    && permissions.has(PermissionFlagsBits.SendMessages)
    && permissions.has(PermissionFlagsBits.EmbedLinks)
    && permissions.has(PermissionFlagsBits.ReadMessageHistory));
}

async function resolveChannel(guild, channelOrId) {
  let channel = channelOrId;
  if (typeof channelOrId === "string") {
    channel = guild?.channels?.cache?.get(channelOrId) ?? null;
    if (!channel && guild?.channels?.fetch) channel = await guild.channels.fetch(channelOrId).catch(() => null);
  }
  return isTextChannel(channel) ? channel : null;
}

async function deleteMessageIfPresent(guild, channelId, messageId) {
  if (!guild || !channelId || !messageId) return false;
  const channel = await resolveChannel(guild, channelId);
  if (!channel?.messages?.fetch) return false;
  const message = await channel.messages.fetch(messageId).catch(() => null);
  if (!message) return false;
  await message.delete().catch(() => {});
  return true;
}

async function removeDuplicateMarkedMessages(channel, keepMessageId) {
  const messages = await channel?.messages?.fetch?.({ limit: 100 }).catch(() => null);
  if (!messages?.values) return 0;
  let removed = 0;
  for (const message of messages.values()) {
    if (message.id === keepMessageId) continue;
    const marked = message.embeds?.some((embed) => embed.footer?.text === OPERATIONAL_STATUS_MARKER);
    if (!marked) continue;
    await message.delete().then(() => { removed += 1; }).catch(() => {});
  }
  return removed;
}

async function recordBoardHealth(guildId, error) {
  await OperationalHealthState.findOneAndUpdate(
    { guildId },
    { $set: { lastSnapshotStatus: "partial", lastSnapshotError: truncate(error) }, $setOnInsert: { guildId } },
    { upsert: true, setDefaultsOnInsert: true },
  ).catch(() => {});
}

export function createOperationalStatusBoardService({ getOperationalStatusSnapshot, logger = console } = {}) {
  if (!getOperationalStatusSnapshot) throw new Error("getOperationalStatusSnapshot is required.");
  const refreshStates = new Map();
  let hourlyTimer = null;

  async function saveRefreshState(guildId, patch) {
    return OperationalStatusBoard.findOneAndUpdate(
      { guildId },
      { $set: patch, $setOnInsert: { guildId } },
      { upsert: true, returnDocument: "after", setDefaultsOnInsert: true, lean: true },
    );
  }

  async function refresh(guild, reason = "state-change") {
    if (!guild?.id) return { status: "ignored", reason: "guild-missing" };
    const attemptAt = new Date();
    const board = await getBoard(guild.id);
    if (!board) return { status: "not-configured" };
    const snapshot = await getOperationalStatusSnapshot(guild);
    const payload = buildOperationalStatusPayload(snapshot);
    const hash = payloadHash(payload);
    const channel = await resolveChannel(guild, board.channelId);
    if (!channel || !hasBoardPermissions(channel, guild)) {
      const error = !channel ? "Configured status board channel could not be found" : "Bot lacks status board permissions";
      await saveRefreshState(guild.id, { lastRefreshAttemptAt: attemptAt, lastRefreshError: error }).catch(() => {});
      await recordBoardHealth(guild.id, error);
      return { status: "unavailable", snapshot, reason: !channel ? "channel-missing" : "permissions" };
    }
    let message = board.messageId ? await channel.messages?.fetch?.(board.messageId).catch(() => null) : null;
    if (message && board.payloadHash === hash) {
      await saveRefreshState(guild.id, { lastRefreshAttemptAt: attemptAt, lastSuccessfulRefreshAt: attemptAt, lastRefreshError: null }).catch(() => {});
      return { status: "unchanged", message, snapshot, reason };
    }
    let edit = false;
    try {
      if (message) {
        await message.edit(payload);
        edit = true;
      } else {
        message = await channel.send(payload);
      }
      await OperationalStatusBoard.findOneAndUpdate(
        { guildId: guild.id },
        { $set: { channelId: channel.id, messageId: message.id, payloadHash: hash, lastEditAt: attemptAt, lastRefreshAttemptAt: attemptAt, lastSuccessfulRefreshAt: attemptAt, lastRefreshError: null }, $setOnInsert: { guildId: guild.id } },
        { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
      );
      await removeDuplicateMarkedMessages(channel, message.id);
      return { status: edit ? "updated" : "created", message, snapshot, reason };
    } catch (error) {
      await saveRefreshState(guild.id, { lastRefreshAttemptAt: attemptAt, lastRefreshError: truncate(error?.message ?? error) }).catch(() => {});
      await recordBoardHealth(guild.id, error?.message ?? error);
      logger.error?.(`Operational status board refresh failed for ${guild.id}: ${error?.message ?? error}`);
      return { status: "failed", error, snapshot, reason };
    }
  }

  function requestRefresh(guild, reason = "state-change") {
    if (!guild?.id) return Promise.resolve({ status: "ignored", reason: "guild-missing" });
    let state = refreshStates.get(guild.id);
    if (!state) {
      state = { guild, reasons: new Set(), resolvers: [], timer: null };
      refreshStates.set(guild.id, state);
    }
    state.guild = guild;
    state.reasons.add(reason);
    const promise = new Promise((resolve) => state.resolvers.push(resolve));
    if (!state.timer) {
      state.timer = setTimeout(async () => {
        refreshStates.delete(guild.id);
        const current = state;
        const refreshReason = [...current.reasons].join(",");
        const result = await refresh(current.guild, refreshReason).catch((error) => ({ status: "failed", error }));
        for (const resolve of current.resolvers) resolve(result);
      }, REFRESH_DEBOUNCE_MS);
    }
    return promise;
  }

  async function configure(guild, channel) {
    const target = await resolveChannel(guild, channel);
    if (!target) throw new Error("ステータスボードにはテキストチャンネルを指定してください。");
    if (!hasBoardPermissions(target, guild)) throw new Error("Botにステータスボードの閲覧・送信・Embed・履歴閲覧権限がありません。");
    const previous = await getBoard(guild.id);
    const snapshot = await getOperationalStatusSnapshot(guild);
    const payload = buildOperationalStatusPayload(snapshot);
    const message = await target.send(payload);
    try {
      await OperationalStatusBoard.findOneAndUpdate(
        { guildId: guild.id },
        { $set: { channelId: target.id, messageId: message.id, payloadHash: payloadHash(payload), lastEditAt: new Date(), lastRefreshAttemptAt: new Date(), lastSuccessfulRefreshAt: new Date(), lastRefreshError: null }, $setOnInsert: { guildId: guild.id } },
        { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
      );
    } catch (error) {
      await message.delete().catch(() => {});
      throw error;
    }
    if (previous && (previous.channelId !== target.id || previous.messageId !== message.id)) {
      await deleteMessageIfPresent(guild, previous.channelId, previous.messageId);
    }
    await removeDuplicateMarkedMessages(target, message.id);
    return { status: previous ? "moved" : "created", board: { channelId: target.id, messageId: message.id } };
  }

  async function remove(guild) {
    const query = OperationalStatusBoard.findOneAndDelete({ guildId: guild.id });
    const board = typeof query.lean === "function" ? await query.lean() : await query;
    if (board) await deleteMessageIfPresent(guild, board.channelId, board.messageId);
    return { status: board ? "removed" : "not-configured" };
  }

  async function restore(client) {
    const results = [];
    for (const guild of client?.guilds?.cache?.values?.() ?? []) results.push(await refresh(guild, "startup"));
    return results;
  }

  function start(client) {
    stop();
    hourlyTimer = setInterval(() => {
      for (const guild of client?.guilds?.cache?.values?.() ?? []) void requestRefresh(guild, "hourly");
    }, REFRESH_INTERVAL_MS);
    hourlyTimer.unref?.();
  }

  function stop() {
    if (hourlyTimer) clearInterval(hourlyTimer);
    hourlyTimer = null;
    for (const state of refreshStates.values()) if (state.timer) clearTimeout(state.timer);
    refreshStates.clear();
  }

  return { configure, remove, refresh, requestRefresh, restore, start, stop, getBoard, buildPayload: buildOperationalStatusPayload };
}
