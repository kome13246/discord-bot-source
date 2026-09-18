import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
} from "discord.js";
import { RtcRoom } from "./models/rtc-room.js";
import { RtcPanel } from "./models/rtc-panel.js";

export const RTC_READY_BUTTON_ID = "rtc:ready";
export const RTC_CANCEL_BUTTON_ID = "rtc:cancel";
export const RTC_PANEL_BUTTON_IDS = Object.freeze([RTC_READY_BUTTON_ID, RTC_CANCEL_BUTTON_ID]);
export const RTC_PANEL_CONTENT = [
  "🎙️ VC移動受付",
  "",
  "現在いるチャットルームのメンバーとVCへ移動してもよい場合は、下の「VC行けるよ」を押してください。",
  "",
  "誰が押したか・何人が押しているかは、他のメンバーには表示されません。",
  "",
  "チャットルームにいる全員がVCへ移動可能になった場合のみ、そのルーム内でお知らせします。",
  "",
  "登録を取り消したい場合は「キャンセル」を押してください。",
].join("\n");

const ROOM_NAME_PREFIX = "💬｜チャットルーム-";
const EXIT_RECHECK_MS = 5_000;

function asPlain(value) {
  if (value && typeof value.lean === "function") return value.lean();
  if (value && typeof value.toObject === "function") return value.toObject();
  return value;
}

function isHuman(member) {
  return Boolean(member && member.user?.bot !== true);
}

function voiceMembers(channel) {
  return [...(channel?.members?.values?.() ?? [])].filter(isHuman);
}

function voiceChannel(channel) {
  return Boolean(channel?.isVoiceBased?.() || channel?.type === ChannelType.GuildVoice || channel?.type === ChannelType.GuildStageVoice);
}

function safeId(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function currentVoiceChannelId(member) {
  return safeId(member?.voice?.channelId ?? member?.voice?.channel?.id);
}

function buttonRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(RTC_READY_BUTTON_ID)
      .setLabel("VC行けるよ")
      .setEmoji("✅")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(RTC_CANCEL_BUTTON_ID)
      .setLabel("キャンセル")
      .setEmoji("↩️")
      .setStyle(ButtonStyle.Secondary),
  );
}

function panelPayload() {
  return {
    content: RTC_PANEL_CONTENT,
    components: [buttonRow()],
    allowedMentions: { parse: [] },
  };
}

function isDefinitelyUnknownChannel(error) {
  return error?.code === 10003 || error?.code === "CHANNEL_NOT_FOUND";
}

async function callOrNull(target, method, ...args) {
  if (typeof target?.[method] !== "function") return null;
  try {
    return await target[method](...args);
  } catch {
    return null;
  }
}

/**
 * RTC deliberately owns its room identity and transient state independently
 * from the older voice-monitor feature.  The service is dependency-injected
 * so state transitions can be tested without a Discord connection.
 */
export function createRtcService({
  client = null,
  getGuildSettings,
  getVoiceReminderParentChannelIds = () => [],
  ensureVoiceControlPanel = null,
  roomModel = RtcRoom,
  panelModel = RtcPanel,
  now = () => Date.now(),
  setTimeoutFn = (...args) => setTimeout(...args),
  clearTimeoutFn = (timer) => clearTimeout(timer),
  logger = console,
} = {}) {
  const roomRecords = new Map();
  const roomLookupUnknown = new Set();
  const roomListUnknown = new Set();
  const readyStates = new Map();
  const roomTimers = new Map();
  const roomLastExitAt = new Map();
  const roomLocks = new Set();
  const memberCreationLocks = new Set();
  const parentAssignments = new Map();
  const roleLocks = new Map();
  const panelLocks = new Map();
  let stopped = false;

  function roomKey(guildId, channelId) {
    return `${guildId}:${channelId}`;
  }

  function getState(key) {
    let state = readyStates.get(key);
    if (!state) {
      state = { ready: new Set(), readyVersions: new Map(), generation: 0, notifying: false };
      readyStates.set(key, state);
    }
    return state;
  }

  function roomRecord(guildId, channelId) {
    return roomRecords.get(roomKey(guildId, channelId)) ?? null;
  }

  async function findRoom(guildId, channelId) {
    const cached = roomRecord(guildId, channelId);
    if (cached) return cached;
    if (!roomModel?.findOne) return null;
    try {
      const row = await asPlain(roomModel.findOne({ guildId, channelId }));
      roomLookupUnknown.delete(roomKey(guildId, channelId));
      if (row) roomRecords.set(roomKey(guildId, channelId), row);
      return row ?? null;
    } catch (error) {
      roomLookupUnknown.add(roomKey(guildId, channelId));
      logger.warn?.(`RTC room lookup failed guild=${guildId} channel=${channelId}: ${error?.message ?? error}`);
      return null;
    }
  }

  async function listRooms(guildId) {
    const cached = [...roomRecords.values()].filter((row) => row.guildId === guildId);
    if (cached.length > 0 || !roomModel?.find) return cached;
    try {
      const rows = await asPlain(roomModel.find({ guildId }));
      roomListUnknown.delete(guildId);
      for (const row of rows ?? []) {
        if (row?.channelId) roomRecords.set(roomKey(guildId, row.channelId), row);
      }
      return (rows ?? []).filter(Boolean);
    } catch (error) {
      roomListUnknown.add(guildId);
      logger.warn?.(`RTC room list failed guild=${guildId}: ${error?.message ?? error}`);
      return cached;
    }
  }

  async function persistRoom(row) {
    try {
      let saved = row;
      if (roomModel?.create) saved = await asPlain(roomModel.create(row));
      else if (roomModel?.findOneAndUpdate) saved = await asPlain(roomModel.findOneAndUpdate(
        { guildId: row.guildId, channelId: row.channelId },
        { $set: row, $setOnInsert: row },
        { upsert: true, returnDocument: "after" },
      ));
      const normalized = saved ?? row;
      roomRecords.set(roomKey(row.guildId, row.channelId), normalized);
      return normalized;
    } catch (error) {
      logger.error?.(`RTC room record save failed guild=${row.guildId} channel=${row.channelId}: ${error?.message ?? error}`);
      return null;
    }
  }

  async function deleteCreatedRoomIfEmpty(guild, channel, reason, removeRecord = false) {
    // A failed move must never delete a room that already contains somebody
    // else.  A freshly-created Discord voice channel exposes `members`, so an
    // unavailable collection is treated as unverified and retained.
    if (!channel || channel.members?.size !== 0 || typeof channel.delete !== "function") return false;
    try {
      await channel.delete?.(reason);
      if (removeRecord) await deleteRoomRecord(guild.id, channel.id);
      return true;
    } catch (error) {
      logger.warn?.(`RTC failed-room cleanup failed guild=${guild?.id} channel=${channel?.id}: ${error?.message ?? error}`);
      return false;
    }
  }

  async function deleteRoomRecord(guildId, channelId) {
    roomRecords.delete(roomKey(guildId, channelId));
    roomLookupUnknown.delete(roomKey(guildId, channelId));
    clearRoomTimer(guildId, channelId);
    readyStates.delete(roomKey(guildId, channelId));
    roomLastExitAt.delete(roomKey(guildId, channelId));
    for (const [memberKey, assignedChannelId] of parentAssignments) {
      if (memberKey.startsWith(`${guildId}:`) && assignedChannelId === channelId) parentAssignments.delete(memberKey);
    }
    try {
      await roomModel?.deleteOne?.({ guildId, channelId });
    } catch (error) {
      logger.warn?.(`RTC room record delete failed guild=${guildId} channel=${channelId}: ${error?.message ?? error}`);
    }
  }

  function clearRoomTimer(guildId, channelId) {
    const key = roomKey(guildId, channelId);
    const timer = roomTimers.get(key);
    if (timer) clearTimeoutFn(timer);
    roomTimers.delete(key);
  }

  function scheduleRoomCheck(guildId, channelId) {
    const key = roomKey(guildId, channelId);
    const deadline = Number(now()) + EXIT_RECHECK_MS;
    roomLastExitAt.set(key, deadline);
    clearRoomTimer(guildId, channelId);
    let timer;
    timer = setTimeoutFn(() => {
      if (roomTimers.get(key) === timer) roomTimers.delete(key);
      if (stopped || roomLastExitAt.get(key) !== deadline) return;
      void maybeNotify(guildId, channelId, deadline).catch((error) => {
        logger.error?.(`RTC delayed readiness check failed guild=${guildId} channel=${channelId}: ${error?.message ?? error}`);
      });
    }, EXIT_RECHECK_MS);
    timer?.unref?.();
    roomTimers.set(key, timer);
  }

  async function fetchGuildChannelState(guild, channelId) {
    if (!guild || !channelId) return { channel: null, error: null, fetched: false };
    const cached = guild.channels?.cache?.get(channelId);
    if (cached) return { channel: cached, error: null, fetched: false };
    if (typeof guild.channels?.fetch !== "function") return { channel: null, error: null, fetched: false };
    try {
      return { channel: await guild.channels.fetch(channelId), error: null, fetched: true };
    } catch (error) {
      return { channel: null, error, fetched: true };
    }
  }

  async function getGuildChannel(guild, channelId) {
    return (await fetchGuildChannelState(guild, channelId)).channel;
  }

  async function getRtcChannel(guild, channelId) {
    const row = await findRoom(guild?.id, channelId);
    if (!row) return null;
    const channel = await getGuildChannel(guild, channelId);
    return voiceChannel(channel) ? { row, channel } : null;
  }

  function configuredParentIds(settings) {
    try {
      return [...new Set((getVoiceReminderParentChannelIds(settings) ?? [])
        .map(String).filter(Boolean))];
    } catch (error) {
      logger.warn?.(`RTC parent channel settings could not be read: ${error?.message ?? error}`);
      return [];
    }
  }

  async function getMember(guild, memberId) {
    return guild?.members?.cache?.get(memberId)
      ?? await callOrNull(guild?.members, "fetch", memberId);
  }

  async function withRoleLock(memberId, operation) {
    const previous = roleLocks.get(memberId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    roleLocks.set(memberId, current);
    try {
      return await current;
    } finally {
      if (roleLocks.get(memberId) === current) roleLocks.delete(memberId);
    }
  }

  async function withPanelLock(guildId, operation) {
    const previous = panelLocks.get(guildId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    panelLocks.set(guildId, current);
    try {
      return await current;
    } finally {
      if (panelLocks.get(guildId) === current) panelLocks.delete(guildId);
    }
  }

  async function syncMemberRole(member, settings) {
    if (!isHuman(member)) return { status: "skipped" };
    const roleId = safeId(settings?.rtcActiveRoleId);
    if (!roleId || !member.roles) return { status: "not-configured" };
    const guild = member.guild;
    return withRoleLock(member.id, async () => {
      const channelId = currentVoiceChannelId(member);
      const tracked = Boolean(channelId && await findRoom(guild?.id, channelId));
      if (channelId && roomLookupUnknown.has(roomKey(guild?.id, channelId))) return { status: "unknown" };
      const hasRole = Boolean(member.roles.cache?.has?.(roleId));
      if (tracked === hasRole) return { status: "current", tracked };
      try {
        if (tracked) await member.roles.add(roleId, "RTCチャットルーム参加");
        else await member.roles.remove(roleId, "RTCチャットルーム退出");
        return { status: tracked ? "added" : "removed", tracked };
      } catch (error) {
        logger.error?.(`RTC role ${tracked ? "grant" : "remove"} failed guild=${guild?.id} member=${member.id}: ${error?.message ?? error}`);
        return { status: "failed", tracked };
      }
    });
  }

  async function removeRoleMembers(guild, roleId, reason) {
    if (!guild || !roleId) return;
    const role = guild.roles?.cache?.get(roleId)
      ?? await callOrNull(guild.roles, "fetch", roleId);
    if (!role) return;
    for (const member of role.members?.values?.() ?? []) {
      if (!isHuman(member)) continue;
      await withRoleLock(member.id, async () => {
        try { await member.roles?.remove?.(roleId, reason); }
        catch (error) { logger.warn?.(`RTC previous role removal failed guild=${guild.id} member=${member.id}: ${error?.message ?? error}`); }
      });
    }
  }

  async function syncGuildRoles(guild, settings, previousSettings = null) {
    if (!guild) return { status: "guild-unavailable" };
    const activeRoleId = safeId(settings?.rtcActiveRoleId);
    const oldRoleId = safeId(previousSettings?.rtcActiveRoleId);
    // Remove the previous role even when the new setting is cleared or the
    // replacement role cannot currently be fetched.
    if (oldRoleId && oldRoleId !== activeRoleId) {
      await removeRoleMembers(guild, oldRoleId, "RTC利用中ロール設定変更");
    }
    if (!activeRoleId) return { status: "not-configured" };
    const role = guild.roles?.cache?.get(activeRoleId)
      ?? await callOrNull(guild.roles, "fetch", activeRoleId);
    if (!role) return { status: "role-unavailable" };
    const members = new Map();
    let roomLookupFailed = roomListUnknown.has(guild.id);
    for (const channel of guild.channels?.cache?.values?.() ?? []) {
      if (!voiceChannel(channel)) continue;
      const row = await findRoom(guild.id, channel.id);
      if (roomLookupUnknown.has(roomKey(guild.id, channel.id))) roomLookupFailed = true;
      if (!row) continue;
      for (const member of voiceMembers(channel)) members.set(member.id, member);
    }
    for (const member of members.values()) await syncMemberRole(member, settings);
    // Fetch failures must not be treated as absence.  The role member cache is
    // often partial, so stale-role removal is allowed only after a complete
    // member fetch succeeds (or when the adapter has no fetch operation).
    const fetchedMembers = guild.members?.fetch
      ? await callOrNull(guild.members, "fetch")
      : true;
    if (!roomLookupFailed && fetchedMembers !== null) {
      for (const member of role.members?.values?.() ?? []) {
        if (!isHuman(member) || members.has(member.id)) continue;
        await syncMemberRole(member, settings);
      }
    }
    return { status: "applied", activeMembers: members.size };
  }

  function nextRoomName(guildId) {
    const numbers = [...roomRecords.values()]
      .filter((row) => row.guildId === guildId)
      .map((row) => Number(String(row.name ?? "").match(/(?:-|$)(\d+)$/)?.[1] ?? 0))
      .filter(Number.isFinite);
    return `${ROOM_NAME_PREFIX}${Math.max(0, ...numbers) + 1}`;
  }

  async function ensureRoomForMember(oldState, newState, settings) {
    const member = newState?.member;
    const guild = newState?.guild ?? member?.guild;
    const parentId = safeId(settings?.rtcParentChannelId);
    const categoryId = safeId(settings?.rtcCategoryId);
    if (!isHuman(member) || !guild || !parentId || !categoryId || newState.channelId !== parentId) return null;
    const lockKey = `${guild.id}:${member.id}`;
    if (memberCreationLocks.has(lockKey)) return null;
    const assignedChannelId = parentAssignments.get(lockKey);
    if (assignedChannelId) {
      const assigned = await findRoom(guild.id, assignedChannelId);
      if (assigned) return assigned;
      parentAssignments.delete(lockKey);
    }
    memberCreationLocks.add(lockKey);
    try {
      const existingRoom = [...roomRecords.values()].find((row) => row.guildId === guild.id && row.channelId === currentVoiceChannelId(member));
      if (existingRoom) return existingRoom;
      const child = await guild.channels.create({
        name: nextRoomName(guild.id),
        type: ChannelType.GuildVoice,
        parent: categoryId,
        reason: "RTCチャットルーム作成",
      });
      const row = await persistRoom({
        guildId: guild.id,
        channelId: child.id,
        sourceParentChannelId: parentId,
        categoryIdAtCreation: child.parentId ?? categoryId,
        name: child.name,
        createdAt: new Date(now()),
      });
      if (!row) {
        // The write result may be unknown (for example, a timeout after
        // MongoDB accepted the insert), so clean a possible durable record
        // whenever the compensating channel deletion succeeds.
        await deleteCreatedRoomIfEmpty(guild, child, "RTC room record could not be saved", true);
        return null;
      }
      parentAssignments.set(lockKey, child.id);
      let moved = true;
      try {
        await member.voice?.setChannel?.(child, "RTCチャットルームへ移動");
      } catch (error) {
        moved = false;
        logger.error?.(`RTC room member move failed guild=${guild.id} member=${member.id}: ${error?.message ?? error}`);
        await deleteCreatedRoomIfEmpty(guild, child, "RTC member move failed", true);
      }
      if (moved && ensureVoiceControlPanel) {
        try {
          const panel = await ensureVoiceControlPanel(child);
          if (["unknown", "blocked", "send-failed", "save-failed"].includes(panel?.status)) {
            logger.warn?.(`RTC VCコントロールパネル設置を確認できません: guild=${guild.id} channel=${child.id} status=${panel.status}`);
          }
        } catch (error) {
          // Panel setup is recoverable and must not roll back a valid RTC room.
          logger.warn?.(`RTC VCコントロールパネル設置に失敗しました: guild=${guild.id} channel=${child.id} error=${error?.message ?? error}`);
        }
      }
      return row;
    } catch (error) {
      logger.error?.(`RTC room creation failed guild=${guild?.id}: ${error?.message ?? error}`);
      return null;
    } finally {
      memberCreationLocks.delete(lockKey);
    }
  }

  function removeReady(guildId, channelId, memberId) {
    const key = roomKey(guildId, channelId);
    const state = readyStates.get(key);
    if (!state) return false;
    const removed = state.ready.delete(memberId);
    if (removed) {
      state.readyVersions.set(memberId, (state.readyVersions.get(memberId) ?? 0) + 1);
      state.generation += 1;
    }
    return removed;
  }

  function clearReadyState(guildId, channelId, expectedGeneration = null, memberIds = null) {
    const key = roomKey(guildId, channelId);
    const state = readyStates.get(key);
    if (!state || (expectedGeneration !== null && state.generation !== expectedGeneration)) return false;
    if (memberIds) {
      for (const memberId of memberIds) {
        state.ready.delete(memberId);
        state.readyVersions.delete(memberId);
      }
    } else {
      state.ready.clear();
      state.readyVersions.clear();
    }
    state.generation += 1;
    return true;
  }

  async function resolveTextChannel(guild, channelId) {
    const channel = await getGuildChannel(guild, channelId);
    return channel?.isTextBased?.() ? channel : null;
  }

  function notificationRoomName(channel) {
    const number = String(channel?.name ?? "").match(/(\d+)\s*$/)?.[1];
    return number ? `雑談部屋（${number}）` : "雑談部屋";
  }

  async function formatNotification(guild, channel, members, settings) {
    const parentIds = configuredParentIds(settings);
    const mentions = members.map((member) => `<@${member.id}>`).join(" ");
    const moveLines = parentIds.length === 0
      ? ""
      : [
        "",
        "VCへ移動する場合",
        `${parentIds.map((id) => `<#${id}>`).join(" または ")} に1人が参加`,
        "↓",
        `作成された「${notificationRoomName(channel)}」に残りのメンバーが参加`,
      ].join("\n");
    return `${mentions}\n\nチャットルームにいる全員がVCへ移動できる状態になりました！\n\nよければVCへの移動を検討してみてください。${moveLines}\n\n※このお知らせの送信後、「VC行けるよ」の状態は一度リセットされます。`;
  }

  async function maybeNotify(guildId, channelId, minimumExitDeadline = null) {
    const key = roomKey(guildId, channelId);
    const lastExit = roomLastExitAt.get(key) ?? 0;
    if (minimumExitDeadline !== null && lastExit > minimumExitDeadline) return { status: "stale" };
    if (lastExit > Number(now())) {
      const delay = lastExit - Number(now());
      clearRoomTimer(guildId, channelId);
      let timer;
      timer = setTimeoutFn(() => {
        if (roomTimers.get(key) === timer) roomTimers.delete(key);
        void maybeNotify(guildId, channelId, lastExit).catch((error) => logger.error?.("RTC delayed notification failed", error));
      }, delay);
      timer?.unref?.();
      roomTimers.set(key, timer);
      return { status: "waiting" };
    }
    if (roomLocks.has(key)) return { status: "busy" };
    roomLocks.add(key);
    try {
      const guild = client?.guilds?.cache?.get(guildId);
      const resolved = await getRtcChannel(guild, channelId);
      if (!resolved) return { status: "room-unavailable" };
      const members = voiceMembers(resolved.channel);
      const state = getState(key);
      for (const memberId of [...state.ready]) {
        if (!members.some((member) => member.id === memberId)) removeReady(guildId, channelId, memberId);
      }
      // A room created by this service is safe to remove only when the whole
      // Discord voice-channel member collection is empty (including the bot).
      // Re-fetch immediately before deletion so a join racing the timer keeps
      // the room and its durable identity.
      if (resolved.channel.members && resolved.channel.members.size === 0) {
        const rechecked = await getRtcChannel(guild, channelId);
        const stillTracked = rechecked?.row?.guildId === guildId
          && rechecked.row.channelId === channelId
          && rechecked.channel.members
          && rechecked.channel.members.size === 0;
        if (stillTracked) {
          try {
            if (typeof rechecked.channel.delete !== "function") return { status: "delete-failed" };
            await rechecked.channel.delete("RTC空室の自動削除");
            await deleteRoomRecord(guildId, channelId);
            return { status: "deleted" };
          } catch (error) {
            logger.warn?.(`RTC empty room deletion failed guild=${guildId} channel=${channelId}: ${error?.message ?? error}`);
            return { status: "delete-failed" };
          }
        }
      }
      if (members.length < 2 || members.some((member) => !state.ready.has(member.id))) {
        return { status: "not-ready" };
      }

      // Fetch the membership again after the first readiness check.  This
      // closes the window where a join/leave occurs while settings are read,
      // and makes the snapshot used for the message the final one.
      const settings = await getGuildSettings(guildId).catch(() => ({}));
      const latest = await getRtcChannel(guild, channelId);
      if (!latest) return { status: "room-unavailable" };
      const latestMembers = voiceMembers(latest.channel);
      const initialIds = new Set(members.map((member) => member.id));
      const latestIds = new Set(latestMembers.map((member) => member.id));
      const membershipUnchanged = initialIds.size === latestIds.size
        && [...initialIds].every((memberId) => latestIds.has(memberId));
      if (!membershipUnchanged) {
        state.generation += 1;
        return { status: "membership-changed" };
      }
      for (const memberId of [...state.ready]) {
        if (!latestIds.has(memberId)) removeReady(guildId, channelId, memberId);
      }
      if (latestMembers.length < 2 || latestMembers.some((member) => !state.ready.has(member.id))) {
        return { status: "not-ready" };
      }
      const generation = state.generation;
      const memberIds = new Set(latestMembers.map((member) => member.id));
      const readyVersions = new Map([...memberIds].map((memberId) => [
        memberId,
        state.readyVersions.get(memberId) ?? 0,
      ]));
      state.notifying = true;
      try {
        const content = await formatNotification(guild, latest.channel, latestMembers, settings);
        await latest.channel.send({
          content,
          allowedMentions: { users: latestMembers.map((member) => member.id), parse: [] },
        });
        // A new ready/cancel/join event while send was in flight starts the
        // next generation.  Version checks are per user so cancel -> ready
        // for the same member cannot be erased by this older send.
        if (state.generation === generation) clearReadyState(guildId, channelId, generation);
        else {
          const clearIds = [...memberIds].filter((memberId) => (
            state.ready.has(memberId)
            && (state.readyVersions.get(memberId) ?? 0) === readyVersions.get(memberId)
          ));
          if (clearIds.length > 0) clearReadyState(guildId, channelId, null, clearIds);
        }
        return { status: "notified", memberIds: [...memberIds] };
      } catch (error) {
        logger.error?.(`RTC readiness notification failed guild=${guildId} channel=${channelId}: ${error?.message ?? error}`);
        return { status: "send-failed" };
      } finally {
        state.notifying = false;
      }
    } finally {
      roomLocks.delete(key);
    }
  }

  async function replyEphemeral(interaction, content) {
    const payload = { content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } };
    try {
      if (interaction.deferred || interaction.replied) return await interaction.followUp(payload);
      return await interaction.reply(payload);
    } catch (error) {
      logger.warn?.(`RTC interaction reply failed: ${error?.message ?? error}`);
      return null;
    }
  }

  async function isValidPanelInteraction(interaction, settings) {
    if (!interaction?.message || interaction.message.channelId !== settings?.rtcReceptionChannelId) return false;
    if (!panelModel?.findOne) return true;
    try {
      const row = await asPlain(panelModel.findOne({ guildId: interaction.guildId }));
      return Boolean(row?.channelId === interaction.message.channelId && row?.messageId === interaction.message.id);
    } catch {
      return false;
    }
  }

  async function handleInteraction(interaction) {
    if (!interaction?.isButton?.() || !RTC_PANEL_BUTTON_IDS.includes(interaction.customId)) return false;
    if (interaction.user?.bot) return true;
    const settings = await getGuildSettings(interaction.guildId).catch(() => null);
    if (!settings?.rtcReceptionChannelId || !(await isValidPanelInteraction(interaction, settings))) {
      await replyEphemeral(interaction, "この受付パネルは現在利用できません。");
      return true;
    }
    const guild = interaction.guild;
    const member = interaction.member ?? await getMember(guild, interaction.user?.id);
    const channelId = currentVoiceChannelId(member);
    const resolved = channelId ? await getRtcChannel(guild, channelId) : null;
    if (!resolved) {
      await replyEphemeral(interaction, "現在リアルタイムチャットに参加していません。\n\nチャットルームに参加した状態でこのボタンを使用してください。");
      return true;
    }
    const key = roomKey(interaction.guildId, channelId);
    const state = getState(key);
    if (interaction.customId === RTC_CANCEL_BUTTON_ID) {
      if (!state.ready.has(interaction.user.id)) {
        await replyEphemeral(interaction, "現在、VC移動可能状態には登録されていません。");
        return true;
      }
      removeReady(interaction.guildId, channelId, interaction.user.id);
      await replyEphemeral(interaction, `「${resolved.channel.name}」でのVC移動可能状態を解除しました。`);
      return true;
    }
    if (state.ready.has(interaction.user.id)) {
      await replyEphemeral(interaction, `「${resolved.channel.name}」では、すでにVCへ移動可能として受け付けています。\n\n取り消したい場合は「キャンセル」を押してください。`);
      return true;
    }
    state.ready.add(interaction.user.id);
    state.readyVersions.set(interaction.user.id, (state.readyVersions.get(interaction.user.id) ?? 0) + 1);
    state.generation += 1;
    const members = voiceMembers(resolved.channel);
    if (members.length <= 1) {
      await replyEphemeral(interaction, "VCへ移動可能として受け付けました。\n\nほかのメンバーが参加し、そのメンバーもVCへ移動可能になった場合にお知らせします。");
      return true;
    }
    await replyEphemeral(interaction, `「${resolved.channel.name}」でVCへ移動可能として受け付けました！\n\nルーム内の全員がVCへ移動可能になった場合にお知らせします。\n\n「キャンセル」を押すか、チャットルームから退出すると受付を取り消せます。`);
    await maybeNotify(interaction.guildId, channelId);
    return true;
  }

  async function handleVoiceStateUpdate(oldState, newState) {
    const member = newState?.member ?? oldState?.member;
    const guild = newState?.guild ?? oldState?.guild ?? member?.guild;
    if (!guild || !isHuman(member)) return;
    const settings = await getGuildSettings(guild.id).catch(() => ({}));
    const oldId = safeId(oldState?.channelId);
    const newId = safeId(newState?.channelId);
    const assignmentKey = `${guild.id}:${member.id}`;
    const assignedChannelId = parentAssignments.get(assignmentKey);
    if (assignedChannelId && oldId === assignedChannelId && newId !== assignedChannelId) {
      parentAssignments.delete(assignmentKey);
    }
    const oldRtc = oldId ? await findRoom(guild.id, oldId) : null;
    const newRtc = newId ? await findRoom(guild.id, newId) : null;
    if (oldRtc && oldId !== newId) {
      getState(roomKey(guild.id, oldId)).generation += 1;
      removeReady(guild.id, oldId, member.id);
      scheduleRoomCheck(guild.id, oldId);
    }
    if (newRtc && oldId !== newId) {
      // A move into another RTC room starts unready in the destination.  The
      // old role is retained because syncMemberRole sees the current target.
      getState(roomKey(guild.id, newId)).generation += 1;
      removeReady(guild.id, newId, member.id);
    }
    if (newId && newId === safeId(settings?.rtcParentChannelId) && newId !== oldId) {
      await ensureRoomForMember(oldState, newState, settings);
    }
    await syncMemberRole(member, settings);
  }

  async function ensurePanelUnlocked(guild, settings = null) {
    const effective = settings ?? await getGuildSettings(guild.id).catch(() => null);
    const channelId = safeId(effective?.rtcReceptionChannelId);
    if (!channelId) return { status: "not-configured" };
    const channel = await resolveTextChannel(guild, channelId);
    if (!channel) return { status: "channel-unavailable" };
    const botMember = guild.members?.me ?? await callOrNull(guild.members, "fetchMe");
    const permissions = channel.permissionsFor?.(botMember);
    if (permissions && (!permissions.has(PermissionFlagsBits.ViewChannel) || !permissions.has(PermissionFlagsBits.SendMessages) || !permissions.has(PermissionFlagsBits.ReadMessageHistory))) {
      return { status: "blocked", reason: "reception-channel-permissions" };
    }
    let saved = null;
    let panelLookupFailed = false;
    try { saved = await asPlain(panelModel?.findOne?.({ guildId: guild.id })); } catch (error) {
      panelLookupFailed = true;
      logger.warn?.(`RTC panel lookup failed guild=${guild.id}: ${error?.message ?? error}`);
    }
    if (panelLookupFailed) return { status: "unknown", reason: "panel-lookup" };
    const botUserId = safeId(guild.client?.user?.id ?? client?.user?.id ?? botMember?.user?.id);
    if (saved?.channelId === channelId && saved.messageId) {
      const message = await callOrNull(channel.messages, "fetch", saved.messageId);
      if (botUserId && message?.author?.id === botUserId) {
        await message.edit(panelPayload()).catch((error) => logger.warn?.(`RTC panel update failed: ${error?.message ?? error}`));
        return { status: "reused", messageId: saved.messageId };
      }
    }
    // Search recent history before creating anything.  A DB write failure or
    // a restart must not create a second valid panel when one is recoverable.
    if (typeof channel.messages?.fetch !== "function") return { status: "unknown", reason: "history-unavailable" };
    let existing = null;
    try {
      const messages = await channel.messages?.fetch?.({ limit: 100 });
      existing = [...(messages?.values?.() ?? [])].find((message) => (
        botUserId
        && message.author?.id === botUserId
        && message.components?.some?.((row) => row.components?.some?.((component) => RTC_PANEL_BUTTON_IDS.includes(component.customId)))
      ));
    } catch (error) {
      logger.warn?.(`RTC panel history lookup failed guild=${guild.id}: ${error?.message ?? error}`);
      return { status: "unknown", reason: "history-lookup" };
    }
    if (existing) {
      const row = { guildId: guild.id, channelId, messageId: existing.id };
      try { await panelModel?.findOneAndUpdate?.({ guildId: guild.id }, { $set: row }, { upsert: true, returnDocument: "after" }); } catch (error) { logger.warn?.(`RTC panel record recovery failed: ${error?.message ?? error}`); }
      return { status: "recovered", messageId: existing.id };
    }
    let message;
    try { message = await channel.send(panelPayload()); } catch (error) {
      logger.error?.(`RTC panel send failed guild=${guild.id}: ${error?.message ?? error}`);
      return { status: "send-failed" };
    }
    try {
      await panelModel?.findOneAndUpdate?.({ guildId: guild.id }, { $set: { guildId: guild.id, channelId, messageId: message.id } }, { upsert: true, returnDocument: "after" });
    } catch (error) {
      logger.error?.(`RTC panel record save failed guild=${guild.id}: ${error?.message ?? error}`);
      return { status: "save-failed", messageId: message.id };
    }
    return { status: "created", messageId: message.id };
  }

  async function ensurePanel(guild, settings = null) {
    if (!guild?.id) return { status: "guild-unavailable" };
    return withPanelLock(guild.id, () => ensurePanelUnlocked(guild, settings));
  }

  async function onSettingsChanged(guild, settings = null, previousSettings = null) {
    const effective = settings ?? await getGuildSettings(guild.id).catch(() => null);
    const panel = await ensurePanel(guild, effective);
    const roles = await syncGuildRoles(guild, effective, previousSettings);
    const panelStatus = String(panel?.status ?? "applied");
    const status = ["blocked", "send-failed", "save-failed", "channel-unavailable", "unknown"].includes(panelStatus)
      ? panelStatus
      : "applied";
    return { status, panel, roles };
  }

  async function restore(guilds = client?.guilds?.cache?.values?.() ?? []) {
    stopped = false;
    for (const timer of roomTimers.values()) clearTimeoutFn(timer);
    roomTimers.clear();
    roomLastExitAt.clear();
    readyStates.clear();
    for (const guild of guilds) {
      try {
        const rows = await listRooms(guild.id);
        const validRoomChannels = [];
        for (const row of rows) {
          if (!row?.channelId) continue;
          const fetched = await fetchGuildChannelState(guild, row.channelId);
          const definitelyMissing = fetched.fetched
            && (!fetched.channel && (!fetched.error || isDefinitelyUnknownChannel(fetched.error)));
          if (definitelyMissing || (fetched.channel && !voiceChannel(fetched.channel))) {
            // A deleted/replaced channel can never become a valid RTC room;
            // clean its durable identity while restoring the guild.
            await deleteRoomRecord(guild.id, row.channelId);
          } else if (fetched.channel && voiceChannel(fetched.channel)) validRoomChannels.push(fetched.channel);
        }
        const settings = await getGuildSettings(guild.id).catch(() => null);
        if (!settings) continue;
        await syncGuildRoles(guild, settings);
        await ensurePanel(guild, settings);
        if (ensureVoiceControlPanel) {
          for (const channel of validRoomChannels) {
            try {
              const panel = await ensureVoiceControlPanel(channel);
              if (["unknown", "blocked", "send-failed", "save-failed"].includes(panel?.status)) {
                logger.warn?.(`RTC VCコントロールパネル復旧を確認できません: guild=${guild.id} channel=${channel.id} status=${panel.status}`);
              }
            } catch (error) {
              logger.warn?.(`RTC VCコントロールパネル復旧に失敗しました: guild=${guild.id} channel=${channel.id} error=${error?.message ?? error}`);
            }
          }
        }
      } catch (error) {
        logger.error?.(`RTC startup restore failed guild=${guild.id}: ${error?.message ?? error}`);
      }
    }
    return { status: "restored" };
  }

  async function handleChannelDelete(channel) {
    if (!channel?.guildId) return;
    // The gateway event is authoritative even if the preceding DB lookup was
    // unavailable.  deleteOne is idempotent and also clears all transient
    // state associated with the generated room.
    await deleteRoomRecord(channel.guildId, channel.id);
    try {
      const panel = await asPlain(panelModel?.findOne?.({ guildId: channel.guildId, channelId: channel.id }));
      if (panel) await panelModel.deleteOne({ guildId: channel.guildId });
    } catch (error) {
      logger.warn?.(`RTC panel cleanup failed guild=${channel.guildId}: ${error?.message ?? error}`);
    }
  }

  function getReadySnapshot(guildId, channelId) {
    return [...(readyStates.get(roomKey(guildId, channelId))?.ready ?? [])];
  }

  function isRtcChannel(guildId, channelId) {
    return Boolean(roomRecord(guildId, channelId));
  }

  function shutdown() {
    stopped = true;
    for (const timer of roomTimers.values()) clearTimeoutFn(timer);
    roomTimers.clear();
    roomLastExitAt.clear();
    readyStates.clear();
  }

  return {
    ensurePanel,
    getReadySnapshot,
    handleChannelDelete,
    handleInteraction,
    handleVoiceStateUpdate,
    initialize: restore,
    isRtcChannel,
    listRooms,
    maybeNotify,
    onSettingsChanged,
    restore,
    scheduleRoomCheck,
    shutdown,
    syncGuildRoles,
    syncMemberRole,
  };
}
