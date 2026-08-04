import crypto from "node:crypto";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
  UserSelectMenuBuilder,
} from "discord.js";
import {
  VC_DM_MAX_MESSAGE_LENGTH,
  VC_DM_PANEL_EXCLUDE_LABEL,
  VC_DM_PANEL_MARKER,
  VC_DM_PANEL_REFRESH_LABEL,
  VC_DM_PANEL_UNEXCLUDE_LABEL,
  buildPanelCustomId,
  formatJstDateTime,
  getNewMemberDmDueAt,
  getVcDmConfigurationIssues,
  stableMemberSort,
} from "./vc-dm-utils.js";
import { deleteVcDmPanel, getVcDmPanel, listVcDmMembers, saveVcDmPanel } from "./vc-dm-store.js";

const PANEL_LEASE_MS = 5 * 60 * 1000;
const PANEL_MAX_ATTEMPTS = 4;
const PANEL_RETRY_DELAYS_MS = [1_000, 3_000, 5_000];
const PANEL_RECOVERY_DELAY_MS = 2 * 60 * 1000;

function createRecordId() {
  return crypto.randomBytes(8).toString("hex");
}

function canUsePanelChannel(channel, guild) {
  if (!channel || typeof channel.send !== "function" || typeof channel.messages?.fetch !== "function") return false;
  const me = guild?.members?.me;
  if (!me || typeof channel.permissionsFor !== "function") return true;
  const permissions = channel.permissionsFor(me);
  return Boolean(
    permissions?.has(PermissionFlagsBits.ViewChannel)
    && permissions?.has(PermissionFlagsBits.SendMessages)
    && permissions?.has(PermissionFlagsBits.ReadMessageHistory),
  );
}

function getPanelBody({ candidates, updatedAt, pageNumber, pageCount, configurationIssues = [], includeUpdatedAt = true }) {
  const pageLabel = pageCount > 1 ? ` ${pageNumber}/${pageCount}` : "";
  const header = [
    `【VC未参加者DM・対象確認】${pageLabel}`,
    "加入後7日間の案内DMの対象候補を表示しています。",
    "対象VCへ3分以上参加すると、自動で一覧から外れます。",
    "",
    "過去にVCへ参加済みと把握しているメンバーは、",
    "「参加済みとして除外」から対象外にしてください。",
    "",
    `対象者：${candidates.totalCount}人`,
  ];
  const body = candidates.pageItems.map((candidate) => [
    `${candidate.number}. <@${candidate.userId}>`,
    `加入日時：${formatJstDateTime(candidate.joinedAt)}`,
    `DM判定予定：${formatJstDateTime(candidate.dueAt)}`,
  ].join("\n"));
  const configurationNotice = configurationIssues.length
    ? [
      "",
      "VC DM STOPPED: target configuration validation failed.",
      ...configurationIssues.slice(0, 5).map((issue) => `- ${issue.code}: ${String(issue.message ?? issue.code).slice(0, 260)}`),
    ]
    : [];
  return [
    ...header,
    ...configurationNotice,
    ...(body.length ? ["", body.join("\n\n")] : ["", "現在、加入後7日間の案内DMの対象候補はいません。"]),
    ...(includeUpdatedAt ? ["", `最終更新：${formatJstDateTime(updatedAt)}`] : []),
    VC_DM_PANEL_MARKER,
  ].join("\n");
}

function getCandidateBlocks(candidates) {
  return candidates.map((candidate, index) => ({
    ...candidate,
    number: index + 1,
    block: [
      `${index + 1}. <@${candidate.userId}>`,
      `加入日時：${formatJstDateTime(candidate.joinedAt)}`,
      `DM判定予定：${formatJstDateTime(candidate.dueAt)}`,
    ].join("\n"),
  }));
}

function splitCandidateBlocks(blocks, maxLength = VC_DM_MAX_MESSAGE_LENGTH - 520) {
  const pages = [];
  let current = [];
  let currentLength = 0;
  for (const block of blocks) {
    const separatorLength = current.length ? 2 : 0;
    if (current.length && currentLength + separatorLength + block.block.length > maxLength) {
      pages.push(current);
      current = [];
      currentLength = 0;
    }
    current.push(block);
    currentLength += (current.length > 1 ? 2 : 0) + block.block.length;
  }
  if (current.length || pages.length === 0) pages.push(current);
  return pages;
}

function pageHash(contents) {
  return crypto.createHash("sha256").update(contents.join("\n\n")).digest("hex");
}

function stripPanelUpdatedAt(content) {
  const lines = String(content ?? "").split("\n");
  const markerIndex = lines.lastIndexOf(VC_DM_PANEL_MARKER);
  // The rendered timestamp is the line immediately before the stable marker.
  // Removing by position keeps this independent of source-file/console
  // encoding and avoids hard-coding a localized timestamp label.
  if (markerIndex > 1 && lines[markerIndex - 2] === "") lines.splice(markerIndex - 2, 2);
  else if (markerIndex > 0) lines.splice(markerIndex - 1, 1);
  return lines.join("\n");
}

export function isCurrentVcDmPanelInteraction(interaction, panel, recordId = null) {
  const channelId = interaction?.channelId ?? interaction?.channel?.id ?? null;
  const messageId = interaction?.message?.id ?? null;
  return Boolean(
    panel?.marker === VC_DM_PANEL_MARKER
    && (!recordId || panel.recordId === recordId)
    && panel.channelId === channelId
    && messageId
    && (panel.messageIds ?? []).includes(messageId),
  );
}

export async function withVcDmPanelLease({ guildId, acquireMongoLease, releaseMongoLease, callback }) {
  const lease = acquireMongoLease
    ? await acquireMongoLease(`vc-dm-panel:${guildId}`, { leaseMs: PANEL_LEASE_MS })
    : { lockKey: `local:vc-dm-panel:${guildId}` };
  if (!lease) return { status: "busy" };
  try {
    return await callback(lease);
  } finally {
    if (acquireMongoLease) await releaseMongoLease?.(lease).catch?.(() => null);
  }
}

function waitForPanelRetry(delayMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    timer.unref?.();
  });
}

export async function withVcDmPanelLeaseRetry({
  guildId,
  acquireMongoLease,
  releaseMongoLease,
  callback,
  maxAttempts = PANEL_MAX_ATTEMPTS,
  retryDelaysMs = PANEL_RETRY_DELAYS_MS,
  sleep = waitForPanelRetry,
  onExhausted,
}) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await withVcDmPanelLease({
      guildId,
      acquireMongoLease,
      releaseMongoLease,
      callback,
    });
    if (result.status !== "busy" || attempt >= maxAttempts) {
      if (result.status === "busy") await onExhausted?.({ attempts: attempt, guildId });
      return result;
    }
    await sleep(retryDelaysMs[Math.min(attempt - 1, retryDelaysMs.length - 1)] ?? 0);
  }
  return { status: "busy" };
}

function buildPanelComponents(recordId, { hasCandidates }) {
  const excludeMenu = new UserSelectMenuBuilder()
    .setCustomId(buildPanelCustomId("exclude", recordId))
    .setPlaceholder("参加済みとして除外するメンバーを選択")
    .setMinValues(1)
    .setMaxValues(1)
    .setDisabled(!hasCandidates);
  const unexcludeMenu = new UserSelectMenuBuilder()
    .setCustomId(buildPanelCustomId("unexclude", recordId))
    .setPlaceholder("除外を取り消すメンバーを選択")
    .setMinValues(1)
    .setMaxValues(1);
  const refreshButton = new ButtonBuilder()
    .setCustomId(buildPanelCustomId("refresh", recordId))
    .setLabel(VC_DM_PANEL_REFRESH_LABEL)
    .setStyle(ButtonStyle.Secondary);
  return [
    new ActionRowBuilder().addComponents(excludeMenu),
    new ActionRowBuilder().addComponents(unexcludeMenu),
    new ActionRowBuilder().addComponents(refreshButton),
  ];
}

export function createVcDmPanelService({ getGuildSettings, client, sendOperationalLog, acquireMongoLease, releaseMongoLease, getRuntimeConfigurationIssues, storeOverrides = {}, logger = console, now = () => new Date() } = {}) {
  const inFlight = new Map();
  const pending = new Map();
  const debounceTimers = new Map();
  const followUpReasons = new Map();
  const recoveryTimers = new Map();
  const removalInFlight = new Map();
  let shuttingDown = false;
  const panelStore = {
    deleteVcDmPanel: storeOverrides.deleteVcDmPanel ?? deleteVcDmPanel,
    getVcDmPanel: storeOverrides.getVcDmPanel ?? getVcDmPanel,
    listVcDmMembers: storeOverrides.listVcDmMembers ?? listVcDmMembers,
    saveVcDmPanel: storeOverrides.saveVcDmPanel ?? saveVcDmPanel,
  };

  async function getConfigurationIssues(guild, settings) {
    const issues = [...getVcDmConfigurationIssues(settings)];
    if (settings?.vcDmEnabled !== true || typeof getRuntimeConfigurationIssues !== "function") return issues;
    const runtimeIssues = await getRuntimeConfigurationIssues(guild, settings).catch((error) => [{
      code: "target_validation_failed",
      message: `Target Discord resource validation failed: ${String(error?.message ?? error)}`,
    }]);
    return [...issues, ...runtimeIssues];
  }

  async function getCandidates(guild) {
    const records = await panelStore.listVcDmMembers(guild.id, {
      isMember: true,
      firstValidVcAt: null,
      lastValidVcAt: null,
      manualValidVcConfirmedAt: null,
      newDmStatus: { $in: ["pending", "processing", "failed"] },
    });
    const candidates = [];
    for (const record of records) {
      const member = guild.members.cache?.get(record.userId)
        ?? await guild.members.fetch(record.userId).catch(() => null);
      if (!member || member.user?.bot) continue;
      const joinedAt = new Date(record.joinedAt);
      const dueAt = getNewMemberDmDueAt(joinedAt);
      if (!Number.isFinite(joinedAt.getTime()) || !dueAt) continue;
      candidates.push({
        record,
        userId: record.userId,
        joinedAt,
        dueAt,
      });
    }
    candidates.sort((left, right) => stableMemberSort(left, right));
    return candidates;
  }

  async function buildPanel(guild, configurationIssues = []) {
    const updatedAt = now();
    const rawCandidates = await getCandidates(guild);
    const blocks = getCandidateBlocks(rawCandidates);
    const blockPages = splitCandidateBlocks(blocks);
    const pageCount = blockPages.length;
    const pageContents = blockPages.map((pageItems, index) => getPanelBody({
      candidates: { totalCount: rawCandidates.length, pageItems },
      updatedAt,
      pageNumber: index + 1,
      pageCount,
      configurationIssues,
    }));
    const hashContents = blockPages.map((pageItems, index) => getPanelBody({
      candidates: { totalCount: rawCandidates.length, pageItems },
      updatedAt,
      pageNumber: index + 1,
      pageCount,
      configurationIssues,
      includeUpdatedAt: false,
    }));
    return {
      rawCandidates,
      pageContents,
      semanticPageContents: hashContents,
      renderedHash: pageHash(hashContents),
      updatedAt,
      pageCount,
    };
  }

  async function fetchPanelMessage(channel, messageId) {
    if (!messageId) return null;
    return channel.messages.fetch(messageId).catch(() => null);
  }

  function isOwnedPanelMessage(message) {
    if (!message || !String(message.content ?? "").includes(VC_DM_PANEL_MARKER)) return false;
    const botId = client?.user?.id;
    return !botId || message.author?.id === botId;
  }

  async function fetchPanelChannel(guild, channelId) {
    return guild.channels.cache?.get(channelId)
      ?? await guild.channels.fetch(channelId).catch(() => null);
  }

  async function deletePanelMessages(guild, panel) {
    const errors = [];
    const channel = await fetchPanelChannel(guild, panel?.channelId);
    if (!channel) return [{ messageId: null, error: new Error("Panel channel could not be resolved.") }];
    for (const messageId of panel?.messageIds ?? []) {
      const message = await fetchPanelMessage(channel, messageId);
      if (!isOwnedPanelMessage(message)) continue;
      try {
        await message.delete();
      } catch (error) {
        errors.push({ messageId, error });
      }
    }
    return errors;
  }

  async function deleteDuplicatePanelMessages(channel, keepMessageIds = []) {
    const recent = await channel.messages.fetch({ limit: 100 }).catch(() => null);
    const keep = new Set(keepMessageIds);
    const errors = [];
    for (const message of [...(recent?.values?.() ?? [])]) {
      if (keep.has(message.id) || !isOwnedPanelMessage(message)) continue;
      try {
        await message.delete();
      } catch (error) {
        errors.push({ messageId: message.id, error });
      }
    }
    return errors;
  }

  function scheduleRecoveryUpdate(guild, reason, operation = "update") {
    if (shuttingDown || recoveryTimers.has(guild.id)) return;
    const timer = setTimeout(() => {
      recoveryTimers.delete(guild.id);
      if (shuttingDown) return;
      const recoveryReason = `${reason}-recovery`;
      const task = operation === "remove"
        ? getGuildSettings(guild.id)
          .then((settings) => settings?.vcDmEnabled === true
            ? requestUpdate(guild, `${recoveryReason}-enabled`)
            : removePanel(guild, recoveryReason))
        : requestUpdate(guild, recoveryReason);
      void task.catch((error) => logger.warn?.(`VC DM panel recovery operation failed guild=${guild.id}: ${error.message}`));
    }, PANEL_RECOVERY_DELAY_MS);
    timer.unref?.();
    recoveryTimers.set(guild.id, timer);
  }

  function cancelPendingUpdate(guildId) {
    const timer = debounceTimers.get(guildId);
    if (timer) clearTimeout(timer);
    debounceTimers.delete(guildId);
    const queued = pending.get(guildId);
    if (queued) queued.resolve({ status: "canceled", reason: "panel-removal" });
    pending.delete(guildId);
    followUpReasons.delete(guildId);
  }

  async function waitForPanelUpdate(guildId) {
    const task = inFlight.get(guildId);
    if (task) await task.catch(() => null);
  }

  async function ensurePanel(guild, reason = "state-change") {
    if (!guild?.id) return null;
    if (shuttingDown) return { status: "stopped" };
    const removal = removalInFlight.get(guild.id);
    if (removal) {
      await removal.catch(() => null);
      if (shuttingDown) return { status: "stopped" };
    }
    if (inFlight.has(guild.id)) {
      followUpReasons.set(guild.id, reason);
      return inFlight.get(guild.id);
    }
    const task = (async () => withVcDmPanelLeaseRetry({
      guildId: guild.id,
      acquireMongoLease,
      releaseMongoLease,
      onExhausted: async ({ attempts }) => {
        logger.warn?.(`VC DM panel lease busy after ${attempts} attempts guild=${guild.id} reason=${reason}`);
        scheduleRecoveryUpdate(guild, reason);
      },
      callback: async () => {
      const settings = await getGuildSettings(guild.id);
      if (settings?.vcDmEnabled !== true || !settings?.vcDmPanelChannelId) return { status: "disabled" };
      const configurationIssues = await getConfigurationIssues(guild, settings);
      const current = await panelStore.getVcDmPanel(guild.id);
      const channel = await fetchPanelChannel(guild, settings.vcDmPanelChannelId);
      if (!canUsePanelChannel(channel, guild)) {
        await panelStore.saveVcDmPanel({
          guildId: guild.id,
          channelId: settings.vcDmPanelChannelId,
          messageIds: current?.messageIds ?? [],
          recordId: current?.recordId ?? createRecordId(),
          marker: VC_DM_PANEL_MARKER,
          lastRenderedHash: current?.lastRenderedHash ?? null,
          lastUpdatedAt: now(),
          lastError: "Panel channel is missing or lacks ViewChannel/SendMessages/ReadMessageHistory.",
        }).catch(() => null);
        throw new Error("VC DM panel channel is unavailable or lacks required permissions.");
      }

      const recordId = current?.recordId ?? createRecordId();
      const { rawCandidates, pageContents, semanticPageContents, renderedHash, updatedAt } = await buildPanel(guild, configurationIssues);
      if (
        current
        && current.channelId === channel.id
        && current.lastRenderedHash === renderedHash
        && (current.messageIds?.length ?? 0) === pageContents.length
      ) {
        const currentMessages = await Promise.all((current.messageIds ?? []).map((messageId) => fetchPanelMessage(channel, messageId)));
        if (currentMessages.every((message, index) => (
          isOwnedPanelMessage(message)
          && stripPanelUpdatedAt(message.content) === semanticPageContents[index]
        ))) {
          const duplicateErrors = await deleteDuplicatePanelMessages(channel, current.messageIds ?? []);
          for (const item of duplicateErrors) logger.warn?.(`VC DM duplicate panel deletion failed guild=${guild.id} message=${item.messageId}: ${item.error.message}`);
          const recoveredPanel = current.lastError
            ? await panelStore.saveVcDmPanel({
              guildId: guild.id,
              channelId: current.channelId,
              messageIds: current.messageIds ?? [],
              recordId: current.recordId,
              marker: VC_DM_PANEL_MARKER,
              lastRenderedHash: current.lastRenderedHash,
              lastUpdatedAt: current.lastUpdatedAt,
              lastError: null,
            }).catch((error) => {
              logger.warn?.(`VC DM panel error-state recovery save failed guild=${guild.id}: ${error.message}`);
              return current;
            })
            : current;
          return { status: "unchanged", reason, candidates: rawCandidates.length, pages: pageContents.length, panel: recoveredPanel, duplicateDeletionErrors: duplicateErrors.length };
        }
      }
      let oldMessageIds = current?.channelId === channel.id ? (current.messageIds ?? []) : [];
      if (oldMessageIds.length === 0) {
        const recent = await channel.messages.fetch({ limit: 100 }).catch(() => null);
        const discovered = [...(recent?.values?.() ?? [])]
          .filter((message) => isOwnedPanelMessage(message))
          .sort((left, right) => (left.createdTimestamp ?? 0) - (right.createdTimestamp ?? 0))
          .map((message) => message.id);
        oldMessageIds = [...new Set(discovered)];
      }
      const messageIds = [];
      const createdMessages = [];
      const replacedMessages = [];
      let recreated = false;
      try {
        for (let index = 0; index < pageContents.length; index += 1) {
          const content = pageContents[index];
          const components = index === 0
            ? buildPanelComponents(recordId, { hasCandidates: rawCandidates.length > 0 })
            : [];
          const existingMessage = await fetchPanelMessage(channel, oldMessageIds[index]);
          const existing = isOwnedPanelMessage(existingMessage) ? existingMessage : null;
          if (existing) {
            try {
              await existing.edit({ content, components });
              messageIds.push(existing.id);
              continue;
            } catch (error) {
              logger.warn?.(`VC DM panel edit failed guild=${guild.id} page=${index + 1}: ${error.message}`);
            }
          }
          const created = await channel.send({ content, components, allowedMentions: { parse: [] } });
          recreated = true;
          messageIds.push(created.id);
          createdMessages.push(created);
          if (existing) replacedMessages.push(existing);
        }
      } catch (error) {
        await Promise.all(createdMessages.map((message) => message.delete().catch(() => null)));
        throw error;
      }

      const changed = !current
        || current.channelId !== channel.id
        || current.lastRenderedHash !== renderedHash
        || (current.messageIds?.length ?? 0) !== messageIds.length
        || recreated;
      let saved;
      try {
        saved = await panelStore.saveVcDmPanel({
          guildId: guild.id,
          channelId: channel.id,
          messageIds,
          recordId,
          marker: VC_DM_PANEL_MARKER,
          lastRenderedHash: renderedHash,
          lastUpdatedAt: updatedAt,
          lastError: null,
        });
        if (!saved) throw new Error("VC DM panel state save returned no document.");
      } catch (error) {
        await Promise.all(createdMessages.map((message) => message.delete().catch(() => null)));
        throw error;
      }
      if (current && current.channelId !== channel.id) {
        const errors = await deletePanelMessages(guild, current);
        for (const item of errors) logger.warn?.(`VC DM old panel deletion failed guild=${guild.id} message=${item.messageId ?? "unknown"}: ${item.error.message}`);
        const oldChannel = await fetchPanelChannel(guild, current.channelId);
        const duplicateErrors = oldChannel ? await deleteDuplicatePanelMessages(oldChannel) : [];
        for (const item of duplicateErrors) logger.warn?.(`VC DM old duplicate panel deletion failed guild=${guild.id} message=${item.messageId}: ${item.error.message}`);
      }
      await Promise.all(replacedMessages.map((message) => message.delete().catch(() => null)));
      for (const staleId of oldMessageIds.slice(pageContents.length)) {
        const stale = await fetchPanelMessage(channel, staleId);
        if (isOwnedPanelMessage(stale)) await stale.delete().catch(() => null);
      }
      const duplicateErrors = await deleteDuplicatePanelMessages(channel, messageIds);
      for (const item of duplicateErrors) logger.warn?.(`VC DM duplicate panel deletion failed guild=${guild.id} message=${item.messageId}: ${item.error.message}`);
      if (changed) {
        await sendOperationalLog?.({
          guild,
          settings,
          fallbackChannel: null,
          content: `VC DM: panel updated guildId=${guild.id} reason=${reason} candidates=${rawCandidates.length} pages=${pageContents.length}`,
        }).catch?.(() => null);
      }
      return { status: "updated", reason, candidates: rawCandidates.length, pages: pageContents.length, panel: saved };
      },
    }))().catch(async (error) => {
      const settings = await getGuildSettings(guild.id).catch(() => null);
      const current = await panelStore.getVcDmPanel(guild.id).catch(() => null);
      if (settings?.vcDmPanelChannelId) {
        await panelStore.saveVcDmPanel({
          guildId: guild.id,
          channelId: current?.channelId ?? settings.vcDmPanelChannelId,
          messageIds: current?.messageIds ?? [],
          recordId: current?.recordId ?? createRecordId(),
          marker: VC_DM_PANEL_MARKER,
          lastRenderedHash: current?.lastRenderedHash ?? null,
          lastUpdatedAt: now(),
          lastError: error.message,
        }).catch(() => null);
      }
      logger.error?.(`VC DM panel update failed guild=${guild.id} reason=${reason}: ${error.message}`);
      return { status: "failed", error };
    }).finally(() => {
      inFlight.delete(guild.id);
      const followUpReason = followUpReasons.get(guild.id);
      followUpReasons.delete(guild.id);
      if (followUpReason && !shuttingDown) {
        void requestUpdate(guild, followUpReason).catch((error) => logger.warn?.(`VC DM panel follow-up update failed guild=${guild.id}: ${error.message}`));
      }
    });
    inFlight.set(guild.id, task);
    return task;
  }

  function requestUpdate(guild, reason = "state-change") {
    if (shuttingDown) return Promise.resolve({ status: "stopped" });
    if (pending.has(guild.id)) return pending.get(guild.id).promise;
    let resolvePromise;
    const promise = new Promise((resolve) => { resolvePromise = resolve; });
    const timer = setTimeout(() => {
      debounceTimers.delete(guild.id);
      pending.delete(guild.id);
      if (shuttingDown) {
        resolvePromise({ status: "stopped" });
        return;
      }
      void ensurePanel(guild, reason).then(resolvePromise);
    }, 100);
    debounceTimers.set(guild.id, timer);
    pending.set(guild.id, { promise, resolve: resolvePromise });
    return promise;
  }

  async function removePanel(guild, reason = "disabled") {
    if (!guild?.id || shuttingDown) return { status: "stopped" };
    const existingRemoval = removalInFlight.get(guild.id);
    if (existingRemoval) return existingRemoval;
    const task = (async () => {
      // A disable/channel-change cleanup must be the last local panel
      // operation. Otherwise an already-running ensurePanel could recreate a
      // panel after the durable reference was cleared.
      await waitForPanelUpdate(guild.id);
      cancelPendingUpdate(guild.id);
      await waitForPanelUpdate(guild.id);
      cancelPendingUpdate(guild.id);
      return withVcDmPanelLeaseRetry({
        guildId: guild.id,
        acquireMongoLease,
        releaseMongoLease,
        onExhausted: async ({ attempts }) => {
          logger.warn?.(`VC DM panel removal lease busy after ${attempts} attempts guild=${guild.id} reason=${reason}`);
          scheduleRecoveryUpdate(guild, reason, "remove");
        },
        callback: async () => {
          const current = await panelStore.getVcDmPanel(guild.id);
          if (!current) return { status: "not-found" };
          const errors = await deletePanelMessages(guild, current);
          const channel = await fetchPanelChannel(guild, current.channelId);
          const duplicateErrors = channel ? await deleteDuplicatePanelMessages(channel) : [];
          // Clear the durable reference even when Discord deletion fails. This
          // makes every old component fail the current-panel validation.
          await panelStore.deleteVcDmPanel({ guildId: guild.id });
          for (const item of errors) logger.warn?.(`VC DM panel deletion failed guild=${guild.id} message=${item.messageId ?? "unknown"}: ${item.error.message}`);
          for (const item of duplicateErrors) logger.warn?.(`VC DM duplicate panel deletion failed guild=${guild.id} message=${item.messageId}: ${item.error.message}`);
          await sendOperationalLog?.({
            guild,
            settings: await getGuildSettings(guild.id).catch(() => null),
            fallbackChannel: null,
            content: `VC DM: panel removed guildId=${guild.id} reason=${reason} deletionErrors=${errors.length + duplicateErrors.length}`,
          }).catch?.(() => null);
          return { status: errors.length || duplicateErrors.length ? "removed_with_errors" : "removed", deletionErrors: errors.length + duplicateErrors.length };
        },
      });
    })().finally(() => {
      removalInFlight.delete(guild.id);
    });
    removalInFlight.set(guild.id, task);
    return task;
  }

  async function shutdown() {
    shuttingDown = true;
    for (const timer of debounceTimers.values()) clearTimeout(timer);
    debounceTimers.clear();
    for (const timer of recoveryTimers.values()) clearTimeout(timer);
    recoveryTimers.clear();
    for (const { resolve } of pending.values()) resolve({ status: "stopped" });
    pending.clear();
    followUpReasons.clear();
    await Promise.allSettled([...new Set([...inFlight.values(), ...removalInFlight.values()])]);
    inFlight.clear();
    removalInFlight.clear();
  }

  async function getStatus(guild) {
    const settings = await getGuildSettings(guild.id);
    const panel = await panelStore.getVcDmPanel(guild.id).catch(() => null);
    const candidates = settings?.vcDmEnabled === true ? await getCandidates(guild).catch(() => []) : [];
    const configurationIssues = await getConfigurationIssues(guild, settings);
    const configValid = settings?.vcDmEnabled === true && configurationIssues.length === 0;
    return { panel, candidateCount: candidates.length, configValid, configurationIssues };
  }

  return {
    getCandidates,
    getStatus,
    ensurePanel,
    removePanel,
    requestUpdate,
    shutdown,
  };
}

export { buildPanelComponents, getPanelBody, splitCandidateBlocks };
