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
const REFRESH_MIN_INTERVAL_MS = 30_000;
const REFRESH_INTERVAL_MS = 60 * 60 * 1_000;
const BOARD_LEASE_MS = 120_000;
const SNAPSHOT_TIMEOUT_MS = 30_000;
const MAX_BUSY_RETRIES = 6;
const DUPLICATE_SWEEP_INTERVAL_MS = 5 * 60_000;

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

function aggregateSeverity(modules) {
  const ranks = { error: 5, unknown: 4, warning: 3, info: 2, healthy: 1, disabled: 0 };
  return (modules ?? []).filter(Boolean).reduce((worst, module) => (
    (ranks[module?.severity] ?? ranks.unknown) > (ranks[worst] ?? ranks.unknown) ? module.severity : worst
  ), "disabled");
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
    .setColor(severityColor[aggregateSeverity([modules.kokuchi, modules.splitvc, modules.recruitment])] ?? severityColor.unknown)
    .addFields(
      moduleField(modules.kokuchi),
      moduleField(modules.splitvc),
      moduleField(modules.recruitment),
    )
    .setFooter({ text: OPERATIONAL_STATUS_MARKER });

  const operationsEmbed = new EmbedBuilder()
    .setTitle("自動投稿・パネル・VC")
    .setColor(severityColor[aggregateSeverity([modules.automation, modules.panels, modules.voice, modules.vcDm])] ?? severityColor.unknown)
    .addFields(
      moduleField(modules.automation),
      moduleField(modules.panels),
      moduleField(modules.voice),
      ...(modules.vcDm ? [moduleField(modules.vcDm)] : []),
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

async function getBoard(guildId, boardModel = OperationalStatusBoard) {
  const query = boardModel.findOne({ guildId });
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
  if (!guild || !channelId || !messageId) return { status: "absent" };
  let channel = guild?.channels?.cache?.get(channelId) ?? null;
  if (!channel && guild?.channels?.fetch) {
    try {
      channel = await guild.channels.fetch(channelId);
    } catch (error) {
      if (error?.code === 10003 || error?.status === 404) return { status: "absent" };
      return { status: "failed", error };
    }
  }
  if (!isTextChannel(channel) || !channel?.messages?.fetch) return { status: "absent" };
  let message;
  try {
    message = await channel.messages.fetch(messageId);
  } catch (error) {
    if (isUnknownMessageError(error)) return { status: "absent" };
    return { status: "failed", error };
  }
  if (!message) return { status: "absent" };
  try {
    await message.delete();
    return { status: "deleted" };
  } catch (error) {
    if (isUnknownMessageError(error)) return { status: "absent" };
    return { status: "failed", error };
  }
}

async function removeDuplicateMarkedMessages(channel, keepMessageId, beforeDelete = async () => {}) {
  const messages = await channel?.messages?.fetch?.({ limit: 100 }).catch(() => null);
  if (!messages?.values) return { removed: 0, failed: [] };
  let removed = 0;
  const failed = [];
  for (const message of messages.values()) {
    if (message.id === keepMessageId) continue;
    const marked = message.embeds?.some((embed) => embed.footer?.text === OPERATIONAL_STATUS_MARKER);
    if (!marked) continue;
    try {
      await beforeDelete();
      await message.delete();
      removed += 1;
    } catch (error) {
      if (!isUnknownMessageError(error)) failed.push({ channelId: channel.id, messageId: message.id, attempts: 1, lastError: truncate(error?.message ?? error) });
    }
  }
  return { removed, failed };
}

function withTimeout(value, timeoutMs, label) {
  let timer;
  return Promise.race([
    Promise.resolve(value),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

function leaseLostError() {
  const error = new Error("Operational status board lease was lost.");
  error.code = "OPERATIONAL_BOARD_LEASE_LOST";
  return error;
}

function leaseUnavailableResult(reason = "lease-unavailable") {
  // This result is only returned when no Discord operation has started.  The
  // explicit marker lets apply/repair workers retry safely without treating a
  // truthy adapter response as an unknown post-Discord outcome.
  return {
    status: "busy",
    reason,
    retryable: true,
    beforeDiscord: true,
    preMutation: true,
  };
}

function fencedFilter(guildId, lease) {
  if (!Number.isFinite(lease?.fencingToken)) return { guildId };
  return {
    guildId,
    $or: [
      { fencingToken: { $exists: false } },
      { fencingToken: { $lte: lease.fencingToken } },
    ],
  };
}

function fencedPatch(patch, lease) {
  return Number.isFinite(lease?.fencingToken) ? { ...patch, fencingToken: lease.fencingToken } : patch;
}

async function recordBoardHealth(guildId, error, healthModel = OperationalHealthState) {
  await healthModel.findOneAndUpdate(
    { guildId },
    { $set: { lastBoardPublishStatus: "failed", lastBoardPublishAt: new Date(), lastBoardPublishError: truncate(error) }, $setOnInsert: { guildId } },
    { upsert: true, setDefaultsOnInsert: true },
  ).catch(() => {});
}

async function recordBoardSuccess(guildId, healthModel = OperationalHealthState) {
  await healthModel.findOneAndUpdate(
    { guildId },
    { $set: { lastBoardPublishStatus: "success", lastBoardPublishAt: new Date(), lastBoardPublishError: null }, $setOnInsert: { guildId } },
    { upsert: true, setDefaultsOnInsert: true },
  ).catch(() => {});
}

function isUnknownMessageError(error) {
  return error?.code === 10008 || String(error?.code) === "10008" || error?.status === 404;
}

export function createOperationalStatusBoardService({
  getOperationalStatusSnapshot,
  acquireMongoLease = async () => ({ lockKey: "operational-status-board" }),
  renewMongoLease = async () => true,
  releaseMongoLease = async () => {},
  logger = console,
  boardModel = OperationalStatusBoard,
  healthModel = OperationalHealthState,
  debounceMs = REFRESH_DEBOUNCE_MS,
  minRefreshIntervalMs = debounceMs === REFRESH_DEBOUNCE_MS ? REFRESH_MIN_INTERVAL_MS : debounceMs,
} = {}) {
  if (!getOperationalStatusSnapshot) throw new Error("getOperationalStatusSnapshot is required.");
  const refreshStates = new Map();
  const lastRefreshStartedAt = new Map();
  const lastDuplicateSweepAt = new Map();
  const transientPendingDeletions = new Map();
  let hourlyTimer = null;

  function startLeaseHeartbeat(lease, leaseMs = BOARD_LEASE_MS) {
    let lost = false;
    let renewal = null;
    async function renew() {
      if (lost) return false;
      if (renewal) return renewal;
      renewal = Promise.resolve().then(() => renewMongoLease(lease, { leaseMs })).then((renewed) => {
        if (!renewed) {
          lost = true;
          logger.error?.(`Operational status board lease was lost: ${lease?.lockKey ?? "unknown"}`);
        }
        return renewed;
      }).catch((error) => {
        lost = true;
        logger.error?.(`Operational status board lease renewal failed: ${error?.message ?? error}`);
        return false;
      }).finally(() => {
        renewal = null;
      });
      return renewal;
    }
    const timer = setInterval(() => {
      void renew();
    }, Math.max(5_000, Math.floor(leaseMs / 3)));
    timer.unref?.();
    return {
      assertOwned: async () => {
        if (lost || !(await renew())) throw leaseLostError();
      },
      isLost: () => lost,
      stop: () => clearInterval(timer),
    };
  }

  async function saveRefreshState(guildId, patch, lease) {
    const saved = await boardModel.findOneAndUpdate(
      fencedFilter(guildId, lease),
      { $set: fencedPatch(patch, lease) },
      { returnDocument: "after", lean: true },
    );
    if (!saved) throw leaseLostError();
    return saved;
  }

  function queueTransientDeletion(guildId, item) {
    if (!item?.channelId || !item?.messageId) return;
    const pending = transientPendingDeletions.get(guildId) ?? [];
    if (!pending.some((other) => other.channelId === item.channelId && other.messageId === item.messageId)) pending.push(item);
    transientPendingDeletions.set(guildId, pending);
  }

  async function processPendingMessageDeletions(guild, board, lease, leaseGuard) {
    const pending = [
      ...(board?.pendingMessageDeletions ?? []),
      ...(transientPendingDeletions.get(guild.id) ?? []),
    ].filter((item, index, items) => items.findIndex((other) => other.channelId === item.channelId && other.messageId === item.messageId) === index);
    const remaining = [];
    for (const item of pending) {
      await leaseGuard.assertOwned();
      const result = await deleteMessageIfPresent(guild, item.channelId, item.messageId);
      if (result.status === "failed") {
        remaining.push({
          channelId: item.channelId,
          messageId: item.messageId,
          attempts: (item.attempts ?? 0) + 1,
          lastError: truncate(result.error?.message ?? result.error),
        });
      }
    }
    const updateResult = await boardModel.updateOne?.(
      fencedFilter(guild.id, lease),
      { $set: fencedPatch({ pendingMessageDeletions: remaining }, lease) },
    );
    if (updateResult && "matchedCount" in updateResult && updateResult.matchedCount !== 1) throw leaseLostError();
    if (remaining.length) transientPendingDeletions.set(guild.id, remaining);
    else transientPendingDeletions.delete(guild.id);
    return remaining;
  }

  async function sweepDuplicateMessages(guild, channel, keepMessageId, lease, leaseGuard, force = false) {
    const previousSweep = lastDuplicateSweepAt.get(channel.id) ?? 0;
    if (!force && Date.now() - previousSweep < DUPLICATE_SWEEP_INTERVAL_MS) return { removed: 0, failed: [] };
    lastDuplicateSweepAt.set(channel.id, Date.now());
    const result = await removeDuplicateMarkedMessages(channel, keepMessageId, leaseGuard.assertOwned);
    for (const item of result.failed) queueTransientDeletion(guild.id, item);
    if (result.failed.length) {
      const tokenPatch = fencedPatch({}, lease);
      const update = { $addToSet: { pendingMessageDeletions: { $each: result.failed } } };
      if (Object.keys(tokenPatch).length) update.$set = tokenPatch;
      await boardModel.updateOne?.(
        fencedFilter(guild.id, lease),
        update,
      ).catch((error) => logger.error?.(`Failed to persist duplicate board cleanup for ${guild.id}: ${error?.message ?? error}`));
    }
    return result;
  }

  async function recordCleanupOutcome(guildId, remaining, duplicateFailures, lease) {
    const failures = [...(remaining ?? []), ...(duplicateFailures ?? [])];
    if (!failures.length) {
      await recordBoardSuccess(guildId, healthModel);
      return null;
    }
    const error = failures.map((item) => item.lastError).filter(Boolean).join(" / ") || "Status board message cleanup is pending";
    await saveRefreshState(guildId, { lastRefreshError: truncate(error) }, lease).catch(() => {});
    await recordBoardHealth(guildId, error, healthModel);
    return error;
  }

  async function refresh(guild, reason = "state-change") {
    if (!guild?.id) return { status: "ignored", reason: "guild-missing" };
    const lease = await acquireMongoLease(`operational-status-board:${guild.id}`, { leaseMs: BOARD_LEASE_MS });
    if (!lease) return { status: "busy", reason };
    const leaseGuard = startLeaseHeartbeat(lease);
    try {
    const attemptAt = new Date();
    const board = await getBoard(guild.id, boardModel);
    if (!board) return { status: "not-configured" };
    if (board.removalPending) {
      const pending = [
        ...(board.pendingMessageDeletions ?? []),
        { channelId: board.channelId, messageId: board.messageId },
      ].filter((item, index, items) => items.findIndex((other) => other.channelId === item.channelId && other.messageId === item.messageId) === index);
      await leaseGuard.assertOwned();
      const pendingUpdate = await boardModel.updateOne?.(fencedFilter(guild.id, lease), { $set: fencedPatch({ pendingMessageDeletions: pending }, lease) });
      if (pendingUpdate && "matchedCount" in pendingUpdate && pendingUpdate.matchedCount !== 1) throw leaseLostError();
      const remaining = await processPendingMessageDeletions(guild, { ...board, pendingMessageDeletions: pending }, lease, leaseGuard);
      if (remaining.length === 0) {
        await leaseGuard.assertOwned();
        await boardModel.findOneAndDelete({ ...fencedFilter(guild.id, lease), removalPending: true });
        return { status: "removed", reason: "pending-removal-completed" };
      }
      const error = remaining.map((item) => item.lastError).filter(Boolean).join(" / ") || "Status board message deletion is pending";
      await saveRefreshState(guild.id, { lastRefreshAttemptAt: attemptAt, lastRefreshError: error }, lease).catch(() => {});
      await recordBoardHealth(guild.id, error, healthModel);
      return { status: "cleanup-pending", reason: "message-delete-failed" };
    }
    const snapshot = await withTimeout(
      getOperationalStatusSnapshot(guild, { suppressBoardDeliveryIssues: true }),
      SNAPSHOT_TIMEOUT_MS,
      "Operational status snapshot",
    );
    const payload = buildOperationalStatusPayload(snapshot);
    const hash = payloadHash(payload);
    const channel = await resolveChannel(guild, board.channelId);
    if (!channel || !hasBoardPermissions(channel, guild)) {
      const error = !channel ? "Configured status board channel could not be found" : "Bot lacks status board permissions";
      await saveRefreshState(guild.id, { lastRefreshAttemptAt: attemptAt, lastRefreshError: error }, lease).catch(() => {});
      await recordBoardHealth(guild.id, error, healthModel);
      return { status: "unavailable", snapshot, reason: !channel ? "channel-missing" : "permissions" };
    }
    let message = null;
    if (board.messageId) {
      try {
        message = await channel.messages?.fetch?.(board.messageId);
      } catch (error) {
        if (!isUnknownMessageError(error)) {
          const messageError = truncate(error?.message ?? error);
          await saveRefreshState(guild.id, { lastRefreshAttemptAt: attemptAt, lastRefreshError: messageError }, lease).catch(() => {});
          await recordBoardHealth(guild.id, messageError, healthModel);
          return { status: "unavailable", snapshot, reason: "message-fetch-failed", error };
        }
      }
    }
    if (message && board.payloadHash === hash) {
      await saveRefreshState(guild.id, { lastRefreshAttemptAt: attemptAt, lastSuccessfulRefreshAt: attemptAt, lastRefreshError: null }, lease);
      const remaining = await processPendingMessageDeletions(guild, board, lease, leaseGuard);
      const duplicateSweep = await sweepDuplicateMessages(guild, channel, message.id, lease, leaseGuard);
      const cleanupError = await recordCleanupOutcome(guild.id, remaining, duplicateSweep.failed, lease);
      if (cleanupError) return { status: "cleanup-pending", message, snapshot, reason, error: cleanupError };
      return { status: "unchanged", message, snapshot, reason };
    }
    let edit = false;
    let createdMessage = false;
    let boardSaved = false;
    try {
      if (message) {
        try {
          await leaseGuard.assertOwned();
          await message.edit(payload);
          edit = true;
        } catch (error) {
          if (!isUnknownMessageError(error)) throw error;
          await leaseGuard.assertOwned();
          message = await channel.send(payload);
          createdMessage = true;
        }
      } else {
        await leaseGuard.assertOwned();
        message = await channel.send(payload);
        createdMessage = true;
      }
      await leaseGuard.assertOwned();
      const saved = await boardModel.findOneAndUpdate(
        fencedFilter(guild.id, lease),
        { $set: fencedPatch({ channelId: channel.id, messageId: message.id, payloadHash: hash, lastEditAt: attemptAt, lastRefreshAttemptAt: attemptAt, lastSuccessfulRefreshAt: attemptAt, lastRefreshError: null }, lease) },
        { returnDocument: "after" },
      );
      if (!saved) throw leaseLostError();
      boardSaved = true;
      const remaining = await processPendingMessageDeletions(guild, board, lease, leaseGuard);
      const duplicateSweep = await sweepDuplicateMessages(guild, channel, message.id, lease, leaseGuard, true);
      const cleanupError = await recordCleanupOutcome(guild.id, remaining, duplicateSweep.failed, lease);
      if (cleanupError) return { status: "cleanup-pending", message, snapshot, reason, error: cleanupError };
      return { status: edit ? "updated" : "created", message, snapshot, reason };
    } catch (error) {
      if (createdMessage && !boardSaved && message?.id) {
        try {
          await message.delete();
        } catch (rollbackError) {
          if (!isUnknownMessageError(rollbackError)) {
            const pendingDeletion = { channelId: channel.id, messageId: message.id, attempts: 1, lastError: truncate(rollbackError?.message ?? rollbackError) };
            queueTransientDeletion(guild.id, pendingDeletion);
            await boardModel.updateOne?.(
              { guildId: guild.id },
              { $addToSet: { pendingMessageDeletions: pendingDeletion } },
            ).catch(() => {});
            logger.error?.(`Operational status board rollback delete failed for ${guild.id}: ${rollbackError?.message ?? rollbackError}`);
          }
        }
      }
      await saveRefreshState(guild.id, { lastRefreshAttemptAt: attemptAt, lastRefreshError: truncate(error?.message ?? error) }, lease).catch(() => {});
      await recordBoardHealth(guild.id, error?.message ?? error, healthModel);
      logger.error?.(`Operational status board refresh failed for ${guild.id}: ${error?.message ?? error}`);
      return { status: "failed", error, snapshot, reason };
    }
    } catch (error) {
      const message = truncate(error?.message ?? error);
      await recordBoardHealth(guild.id, message, healthModel);
      logger.error?.(`Operational status board refresh failed before Discord operation for ${guild.id}: ${message}`);
      return { status: "failed", error, reason };
    } finally {
      leaseGuard.stop();
      await releaseMongoLease(lease).catch((error) => logger.error?.(`Operational status board lease release failed for ${guild.id}: ${error?.message ?? error}`));
    }
  }

  function scheduleRefresh(state) {
    if (state.stopped || state.running || state.timer || state.reasons.size === 0) return;
    const lastStartedAt = lastRefreshStartedAt.get(state.guild.id) ?? 0;
    const remainingInterval = Math.max(0, minRefreshIntervalMs - (Date.now() - lastStartedAt));
    state.timer = setTimeout(() => {
      state.timer = null;
      void runRefresh(state);
    }, Math.max(debounceMs, remainingInterval));
  }

  async function runRefresh(state) {
    if (state.stopped || state.running || state.reasons.size === 0) return;
    const reasons = [...state.reasons];
    const resolvers = state.resolvers;
    state.reasons.clear();
    state.resolvers = [];
    state.running = true;
    lastRefreshStartedAt.set(state.guild.id, Date.now());
    const result = await refresh(state.guild, reasons.join(",")).catch((error) => ({ status: "failed", error }));
    state.running = false;

    // A direct/manual board operation may still own the Mongo lease. Keep
    // these requests pending so they are executed after that operation ends.
    if (result.status === "busy" && !state.stopped) {
      state.busyAttempts += 1;
      if (state.busyAttempts >= MAX_BUSY_RETRIES) {
        for (const resolve of resolvers) resolve({ status: "busy", reason: "retry-limit" });
        if (state.reasons.size > 0) scheduleRefresh(state);
        else if (refreshStates.get(state.guild.id) === state) refreshStates.delete(state.guild.id);
        return;
      }
      for (const reason of reasons) state.reasons.add(reason);
      state.resolvers.unshift(...resolvers);
      scheduleRefresh(state);
      return;
    }

    state.busyAttempts = 0;
    for (const resolve of resolvers) resolve(result);
    if (state.reasons.size > 0 && !state.stopped) {
      // Requests received while Discord/Mongo work was in progress are run
      // after the current update, with the latest snapshot.
      scheduleRefresh(state);
    } else if (refreshStates.get(state.guild.id) === state) {
      refreshStates.delete(state.guild.id);
    }
  }

  function enqueueRefresh(guild, reason, waitForResult) {
    if (!guild?.id) return Promise.resolve({ status: "ignored", reason: "guild-missing" });
    let state = refreshStates.get(guild.id);
    if (!state) {
      state = { guild, reasons: new Set(), resolvers: [], timer: null, running: false, stopped: false, busyAttempts: 0 };
      refreshStates.set(guild.id, state);
    }
    state.guild = guild;
    state.reasons.add(reason);
    scheduleRefresh(state);
    if (!waitForResult) return Promise.resolve({ status: "queued", reason });
    return new Promise((resolve) => state.resolvers.push(resolve));
  }

  function requestRefresh(guild, reason = "state-change") {
    return enqueueRefresh(guild, reason, true);
  }

  function markDirty(guild, reason = "state-change") {
    return enqueueRefresh(guild, reason, false);
  }

  async function configure(guild, channel) {
    const target = await resolveChannel(guild, channel);
    if (!target) throw new Error("ステータスボードにはテキストチャンネルを指定してください。");
    if (!hasBoardPermissions(target, guild)) throw new Error("Botにステータスボードの閲覧・送信・Embed・履歴閲覧権限がありません。");
    const lease = await acquireMongoLease(`operational-status-board:${guild.id}`, { leaseMs: BOARD_LEASE_MS });
    if (!lease) return leaseUnavailableResult();
    const leaseGuard = startLeaseHeartbeat(lease);
    try {
    const previous = await getBoard(guild.id, boardModel);
    const snapshot = await withTimeout(
      getOperationalStatusSnapshot(guild, { suppressBoardDeliveryIssues: true }),
      SNAPSHOT_TIMEOUT_MS,
      "Operational status snapshot",
    );
    const payload = buildOperationalStatusPayload(snapshot);
    await leaseGuard.assertOwned();
    const message = await target.send(payload);
    try {
      const pendingMessageDeletions = [...(previous?.pendingMessageDeletions ?? [])];
      if (previous && (previous.channelId !== target.id || previous.messageId !== message.id)) {
        pendingMessageDeletions.push({ channelId: previous.channelId, messageId: previous.messageId, attempts: 0, lastError: null });
      }
      await leaseGuard.assertOwned();
      const savedBoard = await boardModel.findOneAndUpdate(
        fencedFilter(guild.id, lease),
        { $set: fencedPatch({ channelId: target.id, messageId: message.id, payloadHash: payloadHash(payload), lastEditAt: new Date(), lastRefreshAttemptAt: new Date(), lastSuccessfulRefreshAt: new Date(), lastRefreshError: null, removalPending: false, pendingMessageDeletions }, lease), $setOnInsert: { guildId: guild.id } },
        { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
      );
      if (!savedBoard) throw leaseLostError();
    } catch (error) {
      await message.delete().catch(async (rollbackError) => {
        if (!isUnknownMessageError(rollbackError)) {
          const pendingDeletion = { channelId: target.id, messageId: message.id, attempts: 1, lastError: truncate(rollbackError?.message ?? rollbackError) };
          queueTransientDeletion(guild.id, pendingDeletion);
          await boardModel.updateOne?.({ guildId: guild.id }, { $addToSet: { pendingMessageDeletions: pendingDeletion } }).catch(() => {});
        }
      });
      throw error;
    }
    const saved = await getBoard(guild.id, boardModel);
    const remaining = await processPendingMessageDeletions(guild, saved, lease, leaseGuard);
    const duplicateSweep = await sweepDuplicateMessages(guild, target, message.id, lease, leaseGuard, true);
    await recordCleanupOutcome(guild.id, remaining, duplicateSweep.failed, lease);
    const pendingDeletionCount = remaining.length + duplicateSweep.failed.length;
    return { status: pendingDeletionCount ? "cleanup-pending" : previous ? "moved" : "created", board: { channelId: target.id, messageId: message.id }, pendingDeletionCount };
    } finally {
      leaseGuard.stop();
      await releaseMongoLease(lease).catch((error) => logger.error?.(`Operational status board lease release failed for ${guild.id}: ${error?.message ?? error}`));
    }
  }

  async function remove(guild) {
    const lease = await acquireMongoLease(`operational-status-board:${guild.id}`, { leaseMs: BOARD_LEASE_MS });
    if (!lease) return leaseUnavailableResult();
    const leaseGuard = startLeaseHeartbeat(lease);
    try {
    const board = await getBoard(guild.id, boardModel);
    if (!board) return { status: "not-configured" };
    const pending = [
      ...(board.pendingMessageDeletions ?? []),
      { channelId: board.channelId, messageId: board.messageId, attempts: 0, lastError: null },
    ].filter((item, index, items) => items.findIndex((other) => other.channelId === item.channelId && other.messageId === item.messageId) === index);
    await leaseGuard.assertOwned();
    const removalUpdate = await boardModel.updateOne?.(
      fencedFilter(guild.id, lease),
      { $set: fencedPatch({ removalPending: true, pendingMessageDeletions: pending, lastRefreshAttemptAt: new Date() }, lease) },
    );
    if (removalUpdate && "matchedCount" in removalUpdate && removalUpdate.matchedCount !== 1) throw leaseLostError();
    const remaining = await processPendingMessageDeletions(guild, { ...board, pendingMessageDeletions: pending }, lease, leaseGuard);
    if (remaining.length > 0) {
      const error = remaining.map((item) => item.lastError).filter(Boolean).join(" / ") || "Status board message deletion is pending";
      await saveRefreshState(guild.id, { lastRefreshError: error }, lease).catch(() => {});
      await recordBoardHealth(guild.id, error, healthModel);
      return { status: "cleanup-pending", pendingDeletionCount: remaining.length };
    }
    await leaseGuard.assertOwned();
    await boardModel.findOneAndDelete({ ...fencedFilter(guild.id, lease), removalPending: true });
    return { status: "removed" };
    } finally {
      leaseGuard.stop();
      await releaseMongoLease(lease).catch((error) => logger.error?.(`Operational status board lease release failed for ${guild.id}: ${error?.message ?? error}`));
    }
  }

  async function restore(client) {
    const results = [];
    for (const guild of client?.guilds?.cache?.values?.() ?? []) {
      results.push(await refresh(guild, "startup").catch((error) => {
        logger.error?.(`Operational status board restore failed for ${guild.id}: ${error?.message ?? error}`);
        return { status: "failed", error };
      }));
    }
    return results;
  }

  function start(client) {
    stop();
    hourlyTimer = setInterval(() => {
      for (const guild of client?.guilds?.cache?.values?.() ?? []) void markDirty(guild, "hourly");
    }, REFRESH_INTERVAL_MS);
    hourlyTimer.unref?.();
  }

  function stop() {
    if (hourlyTimer) clearInterval(hourlyTimer);
    hourlyTimer = null;
    for (const state of refreshStates.values()) {
      state.stopped = true;
      if (state.timer) clearTimeout(state.timer);
      for (const resolve of state.resolvers) resolve({ status: "stopped", reason: "service-stopped" });
      state.resolvers = [];
      state.reasons.clear();
    }
    refreshStates.clear();
    lastRefreshStartedAt.clear();
    lastDuplicateSweepAt.clear();
    transientPendingDeletions.clear();
  }

  return {
    configure,
    remove,
    refresh,
    markDirty,
    requestRefresh,
    restore,
    start,
    stop,
    getBoard: (guildId) => getBoard(guildId, boardModel),
    buildPayload: buildOperationalStatusPayload,
  };
}
