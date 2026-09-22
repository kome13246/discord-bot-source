import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
} from "discord.js";
import { DiaryParticipant } from "./models/diary-participant.js";
import { DiaryAssignment } from "./models/diary-assignment.js";
import { DiaryPanel } from "./models/diary-panel.js";
import { DiaryDailyRun } from "./models/diary-daily-run.js";

export const DIARY_JOIN_CUSTOM_ID = "diary:join";
export const DIARY_LEAVE_CUSTOM_ID = "diary:leave";
export const DIARY_PANEL_MARKER = "diary-reception-panel:v1";
export const DIARY_TIME_ZONE = "Asia/Tokyo";
export const DIARY_ASSIGNMENT_HOUR = 18;
export const DIARY_DEFAULT_MAX_DAILY = 1;
export const DIARY_DEFAULT_MIN_INTERVAL_DAYS = 5;
export const DIARY_MAX_DAILY_LIMIT = 10;
export const DIARY_MIN_INTERVAL_LIMIT = 30;
export const DIARY_SPECIAL_NO_PENALTY_HOURS = 18;
export const DIARY_DAILY_CLAIM_TIMEOUT_MS = 5 * 60 * 1_000;
export const DIARY_MAX_LEAVE_ATTEMPTS = 3;
export const DIARY_MAX_ROLE_SYNC_ATTEMPTS = 3;
export const DIARY_MAX_OUTCOME_ATTEMPTS = 5;
const DAY_MS = 24 * 60 * 60 * 1_000;
const DIARY_RETRY_BASE_MS = 60 * 1_000;

const textChannelTypes = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement]);

function asDate(value, fallback = null) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value ?? NaN);
  return Number.isFinite(date.getTime()) ? date : fallback;
}

function datePartsInTokyo(value) {
  const date = asDate(value);
  if (!date) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: DIARY_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const result = {};
  for (const part of parts) {
    if (part.type !== "literal") result[part.type] = Number(part.value);
  }
  return result;
}

/** Return the JST calendar date as YYYY-MM-DD. */
export function diaryJstDateKey(value) {
  const parts = datePartsInTokyo(value);
  if (!parts) return null;
  return [parts.year, String(parts.month).padStart(2, "0"), String(parts.day).padStart(2, "0")].join("-");
}

/** Return the UTC Date representing 18:00 JST on the supplied date. */
export function diaryJst18At(value) {
  const parts = datePartsInTokyo(value);
  if (!parts) return null;
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day, DIARY_ASSIGNMENT_HOUR - 9, 0, 0, 0));
}

export function diaryNextJst18At(slotAt) {
  const date = asDate(slotAt);
  return date ? new Date(date.getTime() + DAY_MS) : null;
}

/** Return the latest daily 18:00 slot that has become due. */
export function diaryLatestDueSlot(value = new Date()) {
  const now = asDate(value, new Date());
  let slotAt = diaryJst18At(now);
  if (slotAt.getTime() > now.getTime()) slotAt = new Date(slotAt.getTime() - DAY_MS);
  return { slotAt, slotKey: diaryJstDateKey(slotAt) };
}

export function diaryDaysBetween(later, earlier) {
  const laterDate = asDate(later);
  const earlierDate = asDate(earlier);
  if (!laterDate || !earlierDate) return null;
  return Math.round((laterDate.getTime() - earlierDate.getTime()) / DAY_MS);
}

export function normalizeDiaryMaxDaily(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 1 && number <= DIARY_MAX_DAILY_LIMIT
    ? number
    : DIARY_DEFAULT_MAX_DAILY;
}

export function normalizeDiaryMinIntervalDays(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 1 && number <= DIARY_MIN_INTERVAL_LIMIT
    ? number
    : DIARY_DEFAULT_MIN_INTERVAL_DAYS;
}

export function diaryPeriodDays({ participantCount, maxDaily = DIARY_DEFAULT_MAX_DAILY, minIntervalDays = DIARY_DEFAULT_MIN_INTERVAL_DAYS } = {}) {
  const count = Math.max(0, Number(participantCount) || 0);
  const daily = normalizeDiaryMaxDaily(maxDaily);
  const minimum = normalizeDiaryMinIntervalDays(minIntervalDays);
  return Math.max(minimum, Math.ceil(count / daily));
}

/**
 * Distribute N assignments over the current period without creating a
 * backlog.  The first assignment is deliberately placed on day zero, and
 * the remaining extra slots are rounded across the period.  This yields
 * 3/5 => 1,0,1,0,1; 4/5 => 1,1,0,1,1; and 8/5 at D=2 => 2,1,2,1,2.
 */
export function calculateDiaryDailyQuota({ participantCount, maxDaily = DIARY_DEFAULT_MAX_DAILY, minIntervalDays = DIARY_DEFAULT_MIN_INTERVAL_DAYS, dayIndex = 0 } = {}) {
  const count = Math.max(0, Number(participantCount) || 0);
  if (count === 0) return 0;
  const daily = normalizeDiaryMaxDaily(maxDaily);
  const period = diaryPeriodDays({ participantCount: count, maxDaily: daily, minIntervalDays });
  const index = Math.max(0, Math.min(period - 1, Number(dayIndex) || 0));
  const base = Math.floor(count / period);
  const remainder = count % period;
  if (remainder === 0) return Math.min(daily, base);
  if (index === 0) return Math.min(daily, base + 1);
  // The rounded position is a compact way to spread the remainder.  For
  // positions where it skips a day, use the inverse check so all examples
  // remain deterministic even when period/remainder are small.
  let extras = new Set([0]);
  if (remainder > 1) {
    extras = new Set(Array.from({ length: remainder - 1 }, (_, offset) => (
      Math.round(((offset + 1) * (period - 1)) / (remainder - 1))
    )).concat(0));
  }
  return Math.min(daily, base + (extras.has(index) ? 1 : 0));
}

function candidateDate(value) {
  return asDate(value, new Date(0));
}

function candidateSort(left, right) {
  const leftInitial = !left.lastAssignedAt;
  const rightInitial = !right.lastAssignedAt;
  if (leftInitial !== rightInitial) return leftInitial ? -1 : 1;
  if (leftInitial) {
    const joined = candidateDate(left.joinedAt).getTime() - candidateDate(right.joinedAt).getTime();
    return joined || String(left.userId).localeCompare(String(right.userId));
  }
  const assigned = candidateDate(left.lastAssignedAt).getTime() - candidateDate(right.lastAssignedAt).getTime();
  return assigned
    || candidateDate(left.joinedAt).getTime() - candidateDate(right.joinedAt).getTime()
    || String(left.userId).localeCompare(String(right.userId));
}

/** Select eligible participants for one nominal 18:00 slot. */
export function selectDiaryAssignees({ participants = [], slotAt = new Date(), maxDaily = DIARY_DEFAULT_MAX_DAILY, minIntervalDays = DIARY_DEFAULT_MIN_INTERVAL_DAYS, dayIndex = 0, quota = null } = {}) {
  const nominalAt = asDate(slotAt, new Date());
  const dailyQuota = quota === null
    ? calculateDiaryDailyQuota({ participantCount: participants.length, maxDaily, minIntervalDays, dayIndex })
    : Math.max(0, Math.min(normalizeDiaryMaxDaily(maxDaily), Number(quota) || 0));
  if (dailyQuota <= 0) return [];
  const eligibleAt = nominalAt.getTime() - normalizeDiaryMinIntervalDays(minIntervalDays) * DAY_MS;
  const eligible = participants
    .filter((participant) => participant?.userId && candidateDate(participant.joinedAt).getTime() <= nominalAt.getTime())
    .filter((participant) => !["pending", "failed"].includes(participant.leaveState))
    .filter((participant) => !participant.lastAssignedAt || candidateDate(participant.lastAssignedAt).getTime() <= eligibleAt)
    .sort(candidateSort);
  return eligible.slice(0, dailyQuota);
}

function diaryDeadlineLabel(deadlineAt, now = new Date()) {
  const deadline = asDate(deadlineAt);
  const current = asDate(now, new Date());
  if (!deadline) return "次回18:00";
  const deadlineKey = diaryJstDateKey(deadline);
  const currentKey = diaryJstDateKey(current);
  if (deadlineKey === currentKey) return "今日18:00";
  const nextKey = diaryJstDateKey(new Date(diaryJst18At(current).getTime() + DAY_MS));
  if (deadlineKey === nextKey) return "明日18:00";
  const parts = datePartsInTokyo(deadline);
  return `${parts.month}/${parts.day} 18:00`;
}

export function formatDiaryAssignmentMessage(userIds = [], deadlineAt, { now = new Date(), specialNoPenalty = false } = {}) {
  const mentions = userIds.map((userId) => `<@${userId}> さん`);
  const assignees = mentions.length <= 1
    ? `今日の担当は ${mentions[0] ?? "担当者"}です！`
    : `今日の担当は\n${mentions.join("\n")}\nです！`;
  const lines = [
    "📖 今日の交換日記",
    "",
    assignees,
    "",
    "最近あったことや、食べたもの、ゲーム、学校・仕事のことなど、内容は何でもOKです。",
    "一言だけでも大丈夫なので、気軽に書いてみてください！",
    "",
    `期限：${diaryDeadlineLabel(deadlineAt, now)}まで`,
  ];
  if (specialNoPenalty) {
    lines.push("", "※Botの不具合により、今回の指名が通常より遅れて送信されています。", "今回は投稿できなかった場合でも、連続未投稿回数には加算されません。");
  }
  return lines.join("\n");
}

function isHumanMessage(message) {
  return Boolean(message?.guild && message.author && !message.author.bot && !message.webhookId && !message.system);
}

function isTextChannel(channel) {
  return Boolean(channel && textChannelTypes.has(channel.type) && typeof channel.send === "function");
}

async function resolveQuery(value) {
  if (!value) return value;
  if (typeof value.lean === "function") return value.lean();
  if (typeof value.exec === "function") return value.exec();
  return value;
}

async function findMany(model, filter, sort = null) {
  if (!model?.find) return [];
  let query = model.find(filter);
  if (sort && typeof query?.sort === "function") query = query.sort(sort);
  if (typeof query?.lean === "function") query = query.lean();
  const result = await resolveQuery(query);
  return Array.isArray(result) ? result : result ? [...result] : [];
}

async function findOne(model, filter) {
  if (!model?.findOne) return null;
  let query = model.findOne(filter);
  if (typeof query?.lean === "function") query = query.lean();
  return resolveQuery(query);
}

function modified(result) {
  if (!result) return false;
  if (result.modifiedCount !== undefined) return Number(result.modifiedCount) > 0;
  if (result.matchedCount !== undefined) return Number(result.matchedCount) > 0;
  if (result.deletedCount !== undefined) return Number(result.deletedCount) > 0;
  return true;
}

function matched(result) {
  if (!result) return false;
  if (result.matchedCount !== undefined) return Number(result.matchedCount) > 0;
  if (result.modifiedCount !== undefined) return Number(result.modifiedCount) > 0;
  return true;
}

function safeErrorMessage(error) {
  return String(error?.message ?? error ?? "unknown error").slice(0, 500);
}

function isUnknownMessageError(error) {
  return error?.code === 10008 || String(error?.code) === "10008" || error?.status === 404;
}

function isUnknownChannelError(error) {
  return error?.code === 10003 || String(error?.code) === "10003" || error?.status === 404;
}

function retryAt(currentNow, attempts) {
  const exponent = Math.max(0, Math.min(Number(attempts) - 1, 5));
  return new Date(currentNow.getTime() + DIARY_RETRY_BASE_MS * (2 ** exponent));
}

function diaryAssignmentChannelId(assignment, settings) {
  return assignment?.channelId || settings?.diaryChannelId || null;
}

export function createDiaryService({
  client,
  getGuildSettings,
  saveGuildSettings,
  saveRuntimeGuildSettings = saveGuildSettings,
  participantModel = DiaryParticipant,
  assignmentModel = DiaryAssignment,
  panelModel = DiaryPanel,
  dailyRunModel = DiaryDailyRun,
  sendOperationalLog = async () => null,
  requestOperationalStatusRefresh = () => {},
  logger = console,
  now = () => new Date(),
  panelContent = null,
} = {}) {
  const guildLocks = new Set();
  const participantLocks = new Map();
  const participantRemovalFallback = new Map();
  const outcomeRetryFallback = new Map();
  const counterRetryFallback = new Map();
  const panelLocks = new Map();
  const panelCleanupFallback = new Map();
  const claimToken = `${process.pid}:${Math.random().toString(36).slice(2)}`;
  let workerTimer = null;

  async function withKeyLock(lockMap, key, operation) {
    const previous = lockMap.get(key) ?? Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    lockMap.set(key, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (lockMap.get(key) === current) lockMap.delete(key);
    }
  }

  async function getSettings(guildId) {
    if (typeof getGuildSettings !== "function") return null;
    return getGuildSettings(guildId);
  }

  async function saveRuntime(guildId, patch) {
    if (typeof saveRuntimeGuildSettings !== "function") return null;
    return saveRuntimeGuildSettings(guildId, patch);
  }

  async function operationalLog(guild, settings, content) {
    try {
      return await sendOperationalLog({ guild, settings, fallbackChannel: null, content, allowedMentions: { parse: [] } });
    } catch (error) {
      logger.error?.("Diary operational log failed:", error);
      return null;
    }
  }

  async function resolveChannel(guild, channelId) {
    if (!guild || !channelId) return null;
    let channel = guild.channels?.cache?.get(channelId) ?? null;
    if (!channel && typeof guild.channels?.fetch === "function") channel = await guild.channels.fetch(channelId).catch(() => null);
    return isTextChannel(channel) ? channel : null;
  }

  async function resolveMember(guild, userId) {
    if (!guild || !userId) return null;
    let member = guild.members?.cache?.get(userId) ?? null;
    if (!member && typeof guild.members?.fetch === "function") member = await guild.members.fetch(userId).catch(() => null);
    return member;
  }

  async function resolveRole(guild, roleId) {
    if (!guild || !roleId) return null;
    return guild.roles?.cache?.get(roleId)
      ?? (typeof guild.roles?.fetch === "function" ? guild.roles.fetch(roleId).catch(() => null) : null);
  }

  async function addRole(member, roleId) {
    if (!member || !roleId || typeof member.roles?.add !== "function") return false;
    const role = await resolveRole(member.guild, roleId);
    if (!role || role.managed || role.id === member.guild.id || role.editable === false) return false;
    try {
      const result = await member.roles.add(role, "みんなで交換日記参加");
      // A few adapters return `false` instead of rejecting when Discord did
      // not apply the role. Treat that as a failure; join must not report a
      // participant that is absent from the configured role.
      return result !== false;
    } catch (error) {
      logger.warn?.(`Diary participant role add failed for ${member.id}: ${safeErrorMessage(error)}`);
      return false;
    }
  }

  async function removeRole(member, roleId) {
    if (!member || !roleId || typeof member.roles?.remove !== "function") return false;
    const role = await resolveRole(member.guild, roleId);
    if (!role || role.managed || role.id === member.guild.id || role.editable === false) return false;
    try {
      await member.roles.remove(role, "みんなで交換日記離脱");
      return true;
    } catch (error) {
      logger.warn?.(`Diary participant role remove failed for ${member.id}: ${safeErrorMessage(error)}`);
      return false;
    }
  }

  function panelPayload() {
    return {
      content: panelContent ?? [
        "📖 みんなで交換日記",
        "",
        "参加メンバーで順番に、最近あったことなどを書いていく交換日記です！",
        "",
        "参加すると定期的に日記担当として指名されます。",
        "指名されたら、翌日の18:00までに交換日記チャンネルへ、最近あったことや趣味のことなどを投稿してください。",
        "",
        "長文でなくても、一言だけでもOKです！",
        "",
        "担当になった際の投稿が3回連続で確認できなかった場合は、自動的に参加状態が解除されます。",
        "解除後もいつでも再参加できます。",
      ].join("\n"),
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(DIARY_JOIN_CUSTOM_ID).setLabel("参加する").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(DIARY_LEAVE_CUSTOM_ID).setLabel("離脱する").setStyle(ButtonStyle.Secondary),
      )],
      allowedMentions: { parse: [] },
    };
  }

  async function resolveChannelDetailed(guild, channelId) {
    if (!guild || !channelId) return { status: "absent", channel: null };
    const cached = guild.channels?.cache?.get(channelId);
    if (cached) return isTextChannel(cached)
      ? { status: "found", channel: cached }
      : { status: "absent", channel: null };
    if (typeof guild.channels?.fetch !== "function") return { status: "unknown", channel: null };
    try {
      const channel = await guild.channels.fetch(channelId);
      return isTextChannel(channel)
        ? { status: "found", channel }
        : { status: "absent", channel: null };
    } catch (error) {
      return isUnknownChannelError(error)
        ? { status: "absent", channel: null }
        : { status: "unknown", channel: null, error };
    }
  }

  async function fetchPanelMessage(channel, messageId) {
    if (!channel || !messageId || typeof channel.messages?.fetch !== "function") {
      return { status: "unknown", message: null, error: new Error("panel message fetch is unavailable") };
    }
    try {
      const message = await channel.messages.fetch(messageId);
      return message ? { status: "found", message } : { status: "absent", message: null };
    } catch (error) {
      return isUnknownMessageError(error)
        ? { status: "absent", message: null }
        : { status: "unknown", message: null, error };
    }
  }

  function panelReferences(items = []) {
    const seen = new Set();
    return items.filter((item) => {
      if (!item?.channelId || !item?.messageId) return false;
      const key = `${item.channelId}:${item.messageId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  async function deletePanelMessage(guild, item) {
    const channelResult = await resolveChannelDetailed(guild, item?.channelId);
    if (channelResult.status === "absent") return { status: "absent" };
    if (channelResult.status !== "found") return { status: "unknown", error: channelResult.error };
    const messageResult = await fetchPanelMessage(channelResult.channel, item.messageId);
    if (messageResult.status !== "found") return messageResult;
    try {
      await messageResult.message.delete?.();
      return { status: "deleted" };
    } catch (error) {
      return isUnknownMessageError(error)
        ? { status: "absent" }
        : { status: "unknown", error };
    }
  }

  async function savePanelPending(guildId, pending) {
    const normalized = panelReferences(pending);
    if (panelModel?.updateOne) {
      try {
        await panelModel.updateOne({ guildId }, { $set: { pendingMessageDeletions: normalized } });
        panelCleanupFallback.delete(guildId);
        return normalized;
      } catch (error) {
        logger.warn?.(`Diary panel cleanup state save failed for ${guildId}: ${safeErrorMessage(error)}`);
      }
    }
    if (normalized.length) panelCleanupFallback.set(guildId, normalized);
    else panelCleanupFallback.delete(guildId);
    return normalized;
  }

  async function reconcilePanelCleanup(guild, currentSettings, pending = []) {
    const fallback = panelCleanupFallback.get(guild.id) ?? [];
    const candidates = panelReferences([...(pending ?? []), ...fallback]);
    if (!candidates.length) return [];
    const remaining = [];
    const currentNow = asDate(now(), new Date());
    for (const item of candidates) {
      const nextRetry = asDate(item.nextRetryAt);
      if (nextRetry && nextRetry.getTime() > currentNow.getTime()) {
        remaining.push(item);
        continue;
      }
      const outcome = await deletePanelMessage(guild, item);
      if (outcome.status === "unknown") {
        const attempts = Number(item.attempts) || 0;
        remaining.push({
          ...item,
          attempts: attempts + 1,
          nextRetryAt: retryAt(currentNow, attempts + 1),
          lastError: safeErrorMessage(outcome.error),
        });
      }
    }
    if (remaining.length) {
      await operationalLog(guild, currentSettings, `⚠️ 交換日記の旧受付パネル削除を保留しています。再試行回数=${remaining.map((item) => item.attempts ?? 0).join(",")}`);
    }
    return savePanelPending(guild.id, remaining);
  }

  async function ensurePanelUnlocked(guild, settings = null) {
    const currentSettings = settings ?? await getSettings(guild?.id);
    const channelId = currentSettings?.diaryReceptionChannelId;
    if (!channelId) return { status: "not-configured" };
    const previous = await findOne(panelModel, { guildId: guild.id });
    // Keep an immutable copy because a Mongoose update or a test double may
    // mutate the object returned by findOne in place; old-panel cleanup must
    // still use the pre-apply channel/message identity.
    const previousReference = previous ? { ...previous } : null;
    // Reconcile any old entries before changing the authoritative reference.
    // The returned list is used below so a crash between the reference swap
    // and the old-message delete still has a durable recovery record.
    const pendingBeforeSwap = await reconcilePanelCleanup(
      guild,
      currentSettings,
      previous?.pendingMessageDeletions ?? [],
    );
    const targetResult = await resolveChannelDetailed(guild, channelId);
    if (targetResult.status !== "found") {
      if (targetResult.status === "unknown") {
        await operationalLog(guild, currentSettings, `⚠️ 交換日記受付CHの取得が一時的に失敗したため、受付パネルを変更せず保留しました。channelId=${channelId}`);
        return { status: "channel-unknown", retryable: true };
      }
      await operationalLog(guild, currentSettings, `⚠️ 交換日記受付CHを取得できないため、受付パネルを設置できません。channelId=${channelId}`);
      return { status: "channel-unavailable" };
    }
    const channel = targetResult.channel;
    let message = null;
    let messageWasEdited = false;
    if (previous?.channelId === channel.id && previous.messageId) {
      const fetched = await fetchPanelMessage(channel, previous.messageId);
      if (fetched.status === "unknown") {
        await operationalLog(guild, currentSettings, `⚠️ 交換日記受付パネルの取得が一時的に失敗したため、重複送信せず保留しました。messageId=${previous.messageId}`);
        return { status: "message-unknown", retryable: true };
      }
      if (fetched.status === "found") {
        message = fetched.message;
        if (message?.edit) {
          try {
            await message.edit(panelPayload());
            messageWasEdited = true;
          } catch (error) {
            if (!isUnknownMessageError(error)) {
              await operationalLog(guild, currentSettings, `⚠️ 交換日記受付パネルの更新が一時的に失敗したため、保留しました：${safeErrorMessage(error)}`);
              return { status: "message-unknown", retryable: true };
            }
            message = null;
          }
        }
      }
    }
    if (!message) message = await channel.send(panelPayload());
    const changedReference = !previousReference
      || previousReference.channelId !== channel.id
      || previousReference.messageId !== message.id;
    const pendingForNewReference = changedReference && previousReference
      ? panelReferences([...pendingBeforeSwap, previousReference])
      : panelReferences(pendingBeforeSwap);
    if (panelModel?.findOneAndUpdate) {
      try {
        await panelModel.findOneAndUpdate(
          { guildId: guild.id },
          {
            $set: {
              guildId: guild.id,
              channelId: channel.id,
              messageId: message.id,
              // Persist the new reference and the old reference's cleanup
              // obligation atomically. The old panel is not deleted until
              // this write succeeds.
              pendingMessageDeletions: pendingForNewReference,
            },
          },
          { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
        );
      } catch (error) {
        // The old reference is still authoritative when the new reference
        // cannot be persisted. Remove only the newly published message so a
        // later retry can safely converge without orphaning the old panel.
        if (changedReference) {
          const cleanup = await deletePanelMessage(guild, { channelId: channel.id, messageId: message.id });
          if (cleanup.status === "unknown") {
            panelCleanupFallback.set(guild.id, [{
              channelId: channel.id,
              messageId: message.id,
              attempts: 1,
              nextRetryAt: retryAt(asDate(now(), new Date()), 1),
              lastError: safeErrorMessage(cleanup.error),
            }]);
          }
        }
        throw error;
      }
    }
    if (changedReference && previousReference) {
      const pending = await reconcilePanelCleanup(guild, currentSettings, [
        ...pendingBeforeSwap,
        previousReference,
      ]);
      if (pending.length) return { status: "applied-cleanup-pending", channelId: channel.id, messageId: message.id, pendingDeletionCount: pending.length };
    }
    return { status: messageWasEdited ? "updated" : "applied", channelId: channel.id, messageId: message.id };
  }

  async function ensurePanel(guild, settings = null) {
    if (!guild?.id) return { status: "ignored" };
    return withKeyLock(panelLocks, guild.id, () => ensurePanelUnlocked(guild, settings));
  }

  async function syncParticipantRoles(guild, settings = null, { force = false } = {}) {
    const currentSettings = settings ?? await getSettings(guild?.id);
    const roleId = currentSettings?.diaryParticipantRoleId ?? null;
    if (force) {
      await participantModel.updateMany?.(
        { guildId: guild.id, roleSyncState: { $in: ["pending", "failed"] } },
        { $set: { roleSyncState: "ready", roleSyncAttempts: 0, roleSyncNextRetryAt: null, roleSyncLastError: null } },
      ).catch(() => null);
    }
    const participants = await findMany(participantModel, { guildId: guild.id });
    const botMember = guild.members?.me ?? (typeof guild.members?.fetchMe === "function" ? await guild.members.fetchMe().catch(() => null) : null);
    if (roleId && !botMember?.permissions?.has?.(PermissionFlagsBits.ManageRoles)) {
      await operationalLog(guild, currentSettings, "⚠️ 交換日記参加者ロールを同期できません。Botにロール管理権限がありません。");
      return { status: "blocked", count: participants.length };
    }
    let roleFailures = 0;
    for (const participant of participants) {
      if (["pending", "failed"].includes(participant.leaveState)) continue;
      const member = await resolveMember(guild, participant.userId);
      if (!member) {
        await participantModel.deleteOne?.({ guildId: guild.id, userId: participant.userId }).catch(() => null);
        if (assignmentModel?.updateMany) await assignmentModel.updateMany({ guildId: guild.id, userId: participant.userId, status: "active" }, { $set: { status: "canceled", sendState: "failed", cancelReason: "guild-member-missing" } }).catch(() => null);
        continue;
      }
      if (!roleId) continue;
      if (participant.roleSyncState === "failed") continue;
      const nextRetryAt = asDate(participant.roleSyncNextRetryAt);
      if (nextRetryAt && nextRetryAt.getTime() > new Date(now()).getTime()) continue;
      const added = await addRole(member, roleId);
      if (added) {
        await participantModel.updateOne?.(
          { guildId: guild.id, userId: participant.userId },
          { $set: { roleSyncState: "ready", roleSyncAttempts: 0, roleSyncNextRetryAt: null, roleSyncLastError: null } },
        ).catch(() => null);
        continue;
      }
      roleFailures += 1;
      const attempts = Math.min(DIARY_MAX_ROLE_SYNC_ATTEMPTS, (Number(participant.roleSyncAttempts) || 0) + 1);
      const exhausted = attempts >= DIARY_MAX_ROLE_SYNC_ATTEMPTS;
      await participantModel.updateOne?.(
        { guildId: guild.id, userId: participant.userId },
        { $set: {
          roleSyncState: exhausted ? "failed" : "pending",
          roleSyncAttempts: attempts,
          roleSyncNextRetryAt: exhausted ? null : retryAt(new Date(now()), attempts),
          roleSyncLastError: "role add returned false",
        } },
      ).catch(() => null);
      if (exhausted) {
        await operationalLog(guild, currentSettings, `🚨 交換日記参加者ロール同期の再試行上限に達したため停止しました：<@${participant.userId}> attempts=${attempts}`);
      } else {
        await operationalLog(guild, currentSettings, `⚠️ 交換日記参加者ロール同期を保留しました：<@${participant.userId}> attempts=${attempts}`);
      }
    }
    if (roleId) {
      const role = await resolveRole(guild, roleId);
      const knownParticipants = new Set(
        participants
          .filter((participant) => !["pending", "failed"].includes(participant.leaveState))
          .map((participant) => participant.userId),
      );
      for (const member of role?.members?.values?.() ?? []) {
        if (!member.user?.bot && !knownParticipants.has(member.id)) await removeRole(member, roleId);
      }
    }
    return { status: roleFailures ? "partial" : "applied", count: participants.length, roleFailures };
  }

  async function cancelAssignments(guildId, userId = null, reason = "canceled") {
    const filter = { guildId, status: "active", ...(userId ? { userId } : {}) };
    if (!assignmentModel?.updateMany) return;
    await assignmentModel.updateMany(filter, { $set: { status: "canceled", sendState: "failed", cancelReason: reason, checkedAt: new Date(now()) } });
  }

  async function recordPendingParticipantRemoval(guild, userId, reason, error, currentNow, previous = null) {
    const ownershipToken = previous?.joinToken
      ?? participantRemovalFallback.get(`${guild.id}:${userId}`)?.joinToken
      ?? null;
    const priorAttempts = Math.max(
      Number(previous?.leaveAttempts) || 0,
      Number(participantRemovalFallback.get(`${guild.id}:${userId}`)?.attempts) || 0,
    );
    const attempts = Math.min(DIARY_MAX_LEAVE_ATTEMPTS, priorAttempts + 1);
    const exhausted = attempts >= DIARY_MAX_LEAVE_ATTEMPTS;
    const patch = {
      leaveState: exhausted ? "failed" : "pending",
      leaveReason: reason,
      leaveRequestedAt: previous?.leaveRequestedAt ?? currentNow,
      leaveAttempts: attempts,
      leaveNextRetryAt: exhausted ? null : retryAt(currentNow, attempts),
      leaveLastError: safeErrorMessage(error),
    };
    let persisted = false;
    try {
      const result = await participantModel.updateOne?.(
        { guildId: guild.id, userId, ...(ownershipToken ? { joinToken: ownershipToken } : {}) },
        { $set: patch },
      );
      persisted = matched(result);
      if (!persisted && !await findOne(participantModel, { guildId: guild.id, userId, ...(ownershipToken ? { joinToken: ownershipToken } : {}) })) return null;
    } catch (updateError) {
      logger.error?.(`Diary pending participant removal state save failed for ${userId}: ${safeErrorMessage(updateError)}`);
    }
    const fallbackKey = `${guild.id}:${userId}`;
    if (persisted) participantRemovalFallback.delete(fallbackKey);
    else participantRemovalFallback.set(fallbackKey, {
      attempts,
      nextRetryAt: patch.leaveNextRetryAt,
      reason,
      error: safeErrorMessage(error),
      joinToken: ownershipToken,
      exhausted,
    });
    if (exhausted) {
      const message = reason === "join-role-rollback"
        ? `🚨 交換日記参加ロール失敗後のDB回収を再試行上限で停止しました：<@${userId}> attempts=${attempts}`
        : `🚨 交換日記自動離脱の再試行上限に達したため停止しました：<@${userId}> attempts=${attempts}`;
      await operationalLog(guild, null, message);
    }
    return { status: exhausted ? "failed" : "pending", attempts, nextRetryAt: patch.leaveNextRetryAt, error };
  }

  async function attemptAutomaticParticipantRemoval(guild, userId, settings, { member = null, sendDm = false, currentNow = null, joinToken = null, reason = "automatic-missed" } = {}) {
    const isAutomaticMiss = reason === "automatic-missed";
    const effectiveNow = asDate(currentNow, asDate(now(), new Date()));
    const fallbackKey = `${guild.id}:${userId}`;
    const fallback = participantRemovalFallback.get(fallbackKey);
    const ownershipToken = joinToken ?? fallback?.joinToken ?? null;
    const ownershipFilter = ownershipToken ? { joinToken: ownershipToken } : {};
    const existing = await findOne(participantModel, { guildId: guild.id, userId, ...ownershipFilter });
    if (!existing) {
      if (ownershipToken) participantRemovalFallback.delete(fallbackKey);
      return { status: "removed", count: await getParticipantCount(guild.id), alreadyAbsent: true, staleOwnership: Boolean(ownershipToken) };
    }
    if (fallback?.exhausted) return { status: "failed", attempts: DIARY_MAX_LEAVE_ATTEMPTS };
    const knownAttempts = Math.max(Number(existing.leaveAttempts) || 0, Number(fallback?.attempts) || 0);
    const nextRetryAt = asDate(existing.leaveNextRetryAt ?? fallback?.nextRetryAt);
    if (existing.leaveState === "failed" || knownAttempts >= DIARY_MAX_LEAVE_ATTEMPTS) {
      participantRemovalFallback.set(fallbackKey, { ...fallback, attempts: DIARY_MAX_LEAVE_ATTEMPTS, exhausted: true, joinToken: ownershipToken });
      if (!fallback?.exhausted) {
        const message = isAutomaticMiss
          ? `🚨 交換日記自動離脱を完了できません。参加者DBの回収を停止しました：<@${userId}>`
          : `🚨 交換日記参加ロール失敗後のDB回収を完了できません。参加者DBの回収を停止しました：<@${userId}>`;
        await operationalLog(guild, settings, message);
      }
      return { status: "failed", attempts: Number(existing.leaveAttempts) || DIARY_MAX_LEAVE_ATTEMPTS };
    }
    if (nextRetryAt && nextRetryAt.getTime() > effectiveNow.getTime()) return { status: "pending", nextRetryAt };
    try {
      await cancelAssignments(guild.id, userId, reason);
    } catch (error) {
      return recordPendingParticipantRemoval(guild, userId, reason, error, effectiveNow, existing);
    }
    // Persist the pending marker before the destructive operation. A process
    // crash between the marker and delete is therefore recoverable, while the
    // bounded attempt count prevents a permanent retry storm.
    if (participantModel?.updateOne) {
      try {
        const marker = await participantModel.updateOne(
          { guildId: guild.id, userId, ...ownershipFilter },
          { $set: { leaveState: "pending", leaveReason: reason, leaveRequestedAt: existing.leaveRequestedAt ?? effectiveNow, leaveNextRetryAt: null } },
        );
        if (!matched(marker)) return recordPendingParticipantRemoval(guild, userId, reason, new Error("leave marker update returned no change"), effectiveNow, existing);
      } catch (error) {
        return recordPendingParticipantRemoval(guild, userId, reason, error, effectiveNow, existing);
      }
    }
    let deletion;
    try {
      if (typeof participantModel?.deleteOne !== "function") throw new Error("participant delete is unavailable");
      deletion = await participantModel.deleteOne({ guildId: guild.id, userId, ...ownershipFilter });
    } catch (error) {
      return recordPendingParticipantRemoval(guild, userId, reason, error, effectiveNow, existing);
    }
    const deleted = deletion?.deletedCount === undefined || Number(deletion.deletedCount) > 0;
    if (!deleted && await findOne(participantModel, { guildId: guild.id, userId, ...ownershipFilter })) {
      return recordPendingParticipantRemoval(guild, userId, reason, new Error("participant delete returned no change"), effectiveNow, existing);
    }
    participantRemovalFallback.delete(fallbackKey);
    const resolvedMember = member ?? await resolveMember(guild, userId);
    const roleRemoved = await removeRole(resolvedMember, settings?.diaryParticipantRoleId);
    if (!roleRemoved && settings?.diaryParticipantRoleId) {
      const message = isAutomaticMiss
        ? `⚠️ 交換日記自動離脱後のロール解除を確認できません：<@${userId}>`
        : `⚠️ 交換日記参加ロール失敗後の補償ロール解除を確認できません：<@${userId}>`;
      await operationalLog(guild, settings, message);
    }
    const count = await getParticipantCount(guild.id);
    await Promise.resolve(requestOperationalStatusRefresh(guild.id, `diary:${reason}`)).catch(() => {});
    if (isAutomaticMiss && sendDm && resolvedMember?.send) {
      const text = `${guild.name ?? "このサーバー"}からのお知らせです。\n\n交換日記で担当になった際の投稿が3回連続で確認できなかったため、参加状態が解除されました。\n\nまた参加したくなった場合は、いつでも「参加する」ボタンから再参加できます！`;
      try {
        await resolvedMember.send({ content: text, allowedMentions: { parse: [] } });
        await operationalLog(guild, settings, `📨 交換日記自動離脱DM送信成功：<@${userId}>`);
      } catch (error) {
        await operationalLog(guild, settings, `⚠️ 交換日記自動離脱DM送信失敗：<@${userId}> error=${safeErrorMessage(error)}`);
      }
    }
    const completionLog = isAutomaticMiss
      ? `📖 交換日記自動離脱：<@${userId}> を3回連続未投稿のため参加解除しました。現在参加者：${count}人`
      : `📖 交換日記参加ロール失敗後のDB回収：<@${userId}> の未完了参加登録を回収しました。現在参加者：${count}人`;
    await operationalLog(guild, settings, completionLog);
    return { status: "removed", count };
  }

  async function removeParticipant(guild, userId, settings, { reason = "leave", member = null, sendDm = false, currentNow = null, joinToken = null } = {}) {
    if (["automatic-missed", "join-role-rollback"].includes(reason)) {
      return withKeyLock(participantLocks, `${guild.id}:${userId}`, () => attemptAutomaticParticipantRemoval(guild, userId, settings, { member, sendDm, currentNow, joinToken, reason }));
    }
    return withKeyLock(participantLocks, `${guild.id}:${userId}`, async () => {
      await cancelAssignments(guild.id, userId, reason);
      let deletion;
      try {
        if (typeof participantModel?.deleteOne !== "function") throw new Error("participant delete is unavailable");
        deletion = await participantModel.deleteOne({ guildId: guild.id, userId });
      } catch (error) {
        // Manual leave is user-facing: never claim success after a failed DB
        // mutation. The caller converts this into the generic ephemeral error.
        await operationalLog(guild, settings, `⚠️ 交換日記離脱の保存に失敗しました：<@${userId}> error=${safeErrorMessage(error)}`);
        throw error;
      }
      const deleted = deletion?.deletedCount === undefined || Number(deletion.deletedCount) > 0;
      if (!deleted && await findOne(participantModel, { guildId: guild.id, userId })) {
        const error = new Error("participant delete returned no change");
        await operationalLog(guild, settings, `⚠️ 交換日記離脱の保存に失敗しました：<@${userId}>`);
        throw error;
      }
      const resolvedMember = member ?? await resolveMember(guild, userId);
      const roleRemoved = await removeRole(resolvedMember, settings?.diaryParticipantRoleId);
      if (!roleRemoved && settings?.diaryParticipantRoleId) {
        await operationalLog(guild, settings, `⚠️ 交換日記離脱後のロール解除を確認できません：<@${userId}>`);
      }
      const count = await getParticipantCount(guild.id);
      await Promise.resolve(requestOperationalStatusRefresh(guild.id, `diary:${reason}`)).catch(() => {});
      const logText = reason === "guild-member-remove"
        ? `📖 交換日記サーバー退出による離脱：<@${userId}> が離脱しました。現在参加者：${count}人`
        : `📖 交換日記離脱：<@${userId}> が離脱しました。現在参加者：${count}人`;
      await operationalLog(guild, settings, logText);
      return { status: "removed", count };
    });
  }

  async function processPendingParticipantRemovals(guild, settings, currentNow) {
    const pending = await findMany(participantModel, { guildId: guild.id, leaveState: "pending" });
    const seen = new Set(pending.map((participant) => participant.userId));
    for (const key of participantRemovalFallback.keys()) {
      const [fallbackGuildId, userId] = key.split(":");
      if (fallbackGuildId === guild.id && !seen.has(userId)) {
        const fallback = participantRemovalFallback.get(key);
        pending.push({ guildId: guild.id, userId, leaveState: "pending", joinToken: fallback?.joinToken ?? null, leaveReason: fallback?.reason ?? "automatic-missed", leaveNextRetryAt: fallback?.nextRetryAt, leaveAttempts: fallback?.attempts });
      }
    }
    const results = [];
    for (const participant of pending) {
      const nextRetryAt = asDate(participant.leaveNextRetryAt);
      if (nextRetryAt && nextRetryAt.getTime() > currentNow.getTime()) continue;
      const removalReason = participant.leaveReason === "join-role-rollback" ? "join-role-rollback" : "automatic-missed";
      results.push(await removeParticipant(guild, participant.userId, settings, {
        reason: removalReason,
        sendDm: removalReason === "automatic-missed",
        currentNow,
        joinToken: participant.joinToken ?? null,
      }));
    }
    return results;
  }

  async function getParticipantCount(guildId) {
    if (participantModel?.countDocuments) {
      try {
        return await resolveQuery(participantModel.countDocuments({ guildId, $or: [{ leaveState: "active" }, { leaveState: { $exists: false } }] }));
      } catch {
        return (await findMany(participantModel, { guildId })).filter((participant) => !["pending", "failed"].includes(participant.leaveState)).length;
      }
    }
    return (await findMany(participantModel, { guildId })).filter((participant) => !["pending", "failed"].includes(participant.leaveState)).length;
  }

  /**
   * A claimed daily run may outlive the process that owns it. Reconcile its
   * durable assignment claims before allowing another worker to publish.
   * Pending claims are known not to have reached Discord and can be retried;
   * sending claims are outcome-uncertain, so they are closed without penalty
   * and never replayed blindly. Sent claims complete the run and repair the
   * participant's last-assigned timestamp if the crash happened mid-save.
   */
  async function recoverClaimedDailyRun(guild, slotKey, currentNow, settings = null) {
    if (!dailyRunModel?.findOne || !dailyRunModel?.updateOne) return { status: "not-configured" };
    const run = await findOne(dailyRunModel, { guildId: guild.id, slotKey });
    if (!run || run.status !== "claimed") return { status: "not-claimed" };
    const claimedAt = asDate(run.claimedAt);
    if (claimedAt && currentNow.getTime() - claimedAt.getTime() < DIARY_DAILY_CLAIM_TIMEOUT_MS) {
      return { status: "active", slotKey };
    }

    const assignments = await findMany(assignmentModel, { guildId: guild.id, slotKey });
    const sent = assignments.filter((assignment) => assignment.sendState === "sent");
    const pending = assignments.filter((assignment) => assignment.status === "active" && assignment.sendState === "pending");
    const sending = assignments.filter((assignment) => assignment.status === "active" && assignment.sendState === "sending");
    const claimFilter = { guildId: guild.id, slotKey, status: "claimed", claimToken: run.claimToken ?? null };

    if (pending.length && assignmentModel?.updateMany) {
      await assignmentModel.updateMany(
        { guildId: guild.id, slotKey, status: "active", sendState: "pending" },
        { $set: { status: "canceled", sendState: "failed", cancelReason: "daily-run-recovery-pending", checkedAt: currentNow } },
      );
    }
    if (sending.length && assignmentModel?.updateMany) {
      await assignmentModel.updateMany(
        { guildId: guild.id, slotKey, status: "active", sendState: "sending" },
        { $set: { status: "canceled", sendState: "failed", cancelReason: "daily-run-recovery-uncertain", checkedAt: currentNow } },
      );
    }
    for (const assignment of sent.concat(sending)) {
      if (!assignment.userId || !participantModel?.updateOne) continue;
      const result = await participantModel.updateOne(
        { guildId: guild.id, userId: assignment.userId },
        { $set: { lastAssignedAt: assignment.nominalAt ?? assignment.assignedAt ?? currentNow } },
      ).catch(() => null);
      if (!matched(result)) {
        await operationalLog(guild, settings, `⚠️ 交換日記復旧で最終指名日時を確定できませんでした：<@${assignment.userId}>`);
      }
    }

    if (sent.length || sending.length) {
      const result = await dailyRunModel.updateOne(
        claimFilter,
        { $set: { status: "completed", completedAt: currentNow, lastError: sending.length ? "send-outcome-uncertain" : null } },
      );
      if (matched(result)) {
        await saveRuntime(guild.id, { diaryLastRunSlot: slotKey });
        await operationalLog(guild, settings, sending.length
          ? "⚠️ 交換日記の日次指名を復旧しました。一部の送信結果が不確実なため、重複指名を避けて今回分を終了します。"
          : "✅ 交換日記の日次指名状態を復旧しました。送信済みの指名を再送しません。");
        return { status: "recovered-completed", slotKey, sent: sent.length, uncertain: sending.length };
      }
      return { status: "busy", slotKey };
    }

    const result = await dailyRunModel.updateOne(
      claimFilter,
      { $set: { status: "failed", completedAt: null, lastError: assignments.length ? "pending-claims-recovered" : "claimed-without-assignments" } },
    );
    if (matched(result)) {
      await operationalLog(guild, settings, assignments.length
        ? "⚠️ 交換日記の未送信指名状態を復旧し、同じ日次指名を再試行します。"
        : "⚠️ 交換日記の日次指名記録だけが残っていたため、同じ日次指名を再試行します。");
      return { status: "recovered-failed", slotKey, pending: pending.length };
    }
    return { status: "busy", slotKey };
  }

  async function recoverClaimedDailyRuns(guild, currentNow, settings = null) {
    if (!dailyRunModel?.find) return [];
    const runs = await findMany(dailyRunModel, { guildId: guild.id, status: "claimed" }, { claimedAt: 1 });
    return Promise.all(runs.map((run) => recoverClaimedDailyRun(guild, run.slotKey, currentNow, settings)));
  }

  async function claimDailyRun(guildId, slotKey, currentNow) {
    if (!dailyRunModel?.findOneAndUpdate) return true;
    const existing = await findOne(dailyRunModel, { guildId, slotKey });
    if (existing && ["claimed", "completed"].includes(existing.status)) return false;
    try {
      const result = await dailyRunModel.findOneAndUpdate(
        {
          guildId,
          slotKey,
          $or: [{ status: "failed" }, { status: { $exists: false } }],
        },
        { $set: { status: "claimed", claimToken, claimedAt: currentNow, lastError: null }, $setOnInsert: { guildId, slotKey } },
        { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
      );
      const claimed = await resolveQuery(result);
      return !claimed || !claimed.claimToken || claimed.claimToken === claimToken;
    } catch (error) {
      // A duplicate-key race means another worker claimed the same nominal
      // slot.  It is safer to skip than to publish a duplicate assignment.
      if (error?.code === 11000) return false;
      throw error;
    }
  }

  async function finishDailyRun(guildId, slotKey, status, currentNow, error = null) {
    if (!dailyRunModel?.updateOne) return;
    await dailyRunModel.updateOne(
      { guildId, slotKey, claimToken },
      { $set: { status, completedAt: status === "completed" ? currentNow : null, lastError: error ? safeErrorMessage(error) : null } },
    );
  }

  async function join(interaction) {
    const guild = interaction.guild;
    const settings = await getSettings(interaction.guildId);
    if (settings?.diaryEnabled !== true) return { status: "disabled", message: "現在、交換日記機能は停止中です。" };
    const userId = interaction.user.id;
    return withKeyLock(participantLocks, `${interaction.guildId}:${userId}`, async () => {
      const existing = await findOne(participantModel, { guildId: interaction.guildId, userId });
      if (existing) return { status: "already", message: "すでに交換日記に参加しています！" };
      const joinedAt = new Date(now());
      const joinToken = `${claimToken}:join:${interaction.guildId}:${userId}:${Math.random().toString(36).slice(2)}`;
      let created = false;
      try {
        if (participantModel?.findOneAndUpdate) {
          const result = await participantModel.findOneAndUpdate(
            { guildId: interaction.guildId, userId },
            { $setOnInsert: { guildId: interaction.guildId, userId, joinedAt, joinToken, consecutiveMisses: 0, lastAssignedAt: null, leaveState: "active", roleSyncState: "ready" } },
            { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
          );
          // The token is written only by the upsert owner. Never compensate a
          // role failure by deleting an existing row owned by another worker.
          if (!result) throw new Error("participant upsert returned no document");
          created = Boolean(result?.joinToken && result.joinToken === joinToken);
          if (!created && result) return { status: "already", message: "すでに交換日記に参加しています！" };
        } else if (participantModel?.create) {
          await participantModel.create({ guildId: interaction.guildId, userId, joinedAt, joinToken, consecutiveMisses: 0, lastAssignedAt: null, leaveState: "active", roleSyncState: "ready" });
          created = true;
        }
      } catch (error) {
        const raced = await findOne(participantModel, { guildId: interaction.guildId, userId });
        if (raced) return { status: "already", message: "すでに交換日記に参加しています！" };
        throw error;
      }
      const roleId = settings.diaryParticipantRoleId;
      const member = interaction.member ?? await resolveMember(guild, userId);
      if (roleId && !(await addRole(member, roleId))) {
        let rolledBack = false;
        let rollbackError = new Error("join role add returned false");
        try {
          const rollback = created
            ? await participantModel.deleteOne?.({ guildId: interaction.guildId, userId, joinToken })
            : { deletedCount: 0 };
          rolledBack = rollback?.deletedCount === undefined || Number(rollback.deletedCount) > 0;
          if (!rolledBack && !await findOne(participantModel, { guildId: interaction.guildId, userId })) rolledBack = true;
        } catch (error) {
          rollbackError = error;
        }
        await operationalLog(guild, settings, created
          ? `⚠️ 交換日記参加者ロールを付与できなかったため参加登録を戻しました：<@${userId}>`
          : `⚠️ 交換日記参加者ロールを付与できませんでしたが、別処理の参加登録は削除しませんでした：<@${userId}>`);
        if (!rolledBack && created) {
          await recordPendingParticipantRemoval(
            guild,
            userId,
            "join-role-rollback",
            rollbackError,
            asDate(now(), new Date()),
            { joinToken, leaveAttempts: 0 },
          );
          // The pending leave state deliberately excludes this row from
          // participant selection/counts and from role re-sync. A later
          // worker tick performs the bounded, token-independent delete.
          await operationalLog(guild, settings, `🚨 交換日記参加ロール失敗後のDB回収を保留しています：<@${userId}>`);
        }
        return { status: "role-failed", message: "参加者ロールを付与できなかったため、参加処理を完了できませんでした。Botの権限を確認してから、もう一度お試しください。" };
      }
      const count = await getParticipantCount(interaction.guildId);
      await operationalLog(guild, settings, `📖 交換日記参加：<@${userId}> が参加しました。現在参加者：${count}人`);
      await Promise.resolve(requestOperationalStatusRefresh(interaction.guildId, "diary:join")).catch(() => {});
      return { status: "joined", message: "交換日記に参加しました！\n\nこれから定期的に日記担当として指名されます。\n指名されたら、翌日の18:00までに交換日記チャンネルへ何か投稿してください！" };
    });
  }

  async function leave(interaction) {
    const settings = await getSettings(interaction.guildId);
    const existing = await findOne(participantModel, { guildId: interaction.guildId, userId: interaction.user.id });
    if (!existing) return { status: "not-participant", message: "現在、交換日記には参加していません。" };
    await removeParticipant(interaction.guild, interaction.user.id, settings, { reason: "leave", member: interaction.member });
    return { status: "left", message: "交換日記から離脱しました。\n\nまた参加したくなった場合は、いつでも「参加する」ボタンから再参加できます！" };
  }

  async function validatePanelInteraction(interaction) {
    // Unit/integration adapters may invoke the button handler without the
    // originating message. There is no panel identity to validate in that
    // case; Discord interactions always include it in production.
    if (!interaction?.message?.id) return { status: "not-checkable", valid: true };
    try {
      const panel = await findOne(panelModel, { guildId: interaction.guildId ?? interaction.guild?.id });
      if (!panel) return { status: "valid", valid: false };
      const channelId = interaction.channelId ?? interaction.channel?.id ?? interaction.message.channelId;
      return {
        status: "valid",
        valid: panel.messageId === interaction.message.id && (!channelId || panel.channelId === channelId),
      };
    } catch (error) {
      return { status: "unknown", valid: false, error };
    }
  }

  async function handleButton(interaction) {
    try {
      if (interaction.deferReply) await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const panelCheck = await validatePanelInteraction(interaction);
      if (panelCheck.status === "unknown") throw panelCheck.error;
      const result = !panelCheck.valid
        ? { status: "stale-panel", message: "この受付パネルは古いため利用できません。最新の受付パネルから操作してください。" }
        : interaction.customId === DIARY_JOIN_CUSTOM_ID ? await join(interaction) : await leave(interaction);
      if (interaction.deferred && interaction.editReply) await interaction.editReply({ content: result.message, allowedMentions: { parse: [] } });
      else await interaction.reply({ content: result.message, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    } catch (error) {
      logger.error?.("Diary button processing failed:", error);
      const payload = { content: "処理中にエラーが発生しました。\nしばらくしてからもう一度お試しください。", flags: MessageFlags.Ephemeral };
      if (interaction.deferred && interaction.editReply) await interaction.editReply(payload).catch(() => null);
      else if (interaction.replied || interaction.deferred) await interaction.followUp(payload).catch(() => null);
      else await interaction.reply(payload).catch(() => null);
    }
  }

  async function messagesContainPost(channel, assignment, until) {
    if (!channel?.messages?.fetch) return null;
    const start = asDate(assignment.assignedAt, new Date(0)).getTime();
    const end = asDate(until, new Date()).getTime();
    let before = null;
    const seenCursors = new Set();
    let page = 0;
    for (; page < 50; page += 1) {
      let fetched;
      try {
        fetched = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
      } catch {
        // A partial history cannot establish that a post is absent. The
        // latest page fallback used here previously could skip the missing
        // middle pages and turn an unknown result into a miss.
        return null;
      }
      // Discord returns a Collection for a history request. A null/undefined
      // result from an adapter is an unavailable history, not an empty page.
      if (fetched == null) return null;
      // Test adapters and a few Discord wrappers expose a query-like result
      // with `lean()`. Resolve it before interpreting the page; otherwise an
      // empty result object would look like a page containing its helper
      // methods and become an unknown history.
      try {
        if (typeof fetched.lean === "function") fetched = await fetched.lean();
      } catch {
        return null;
      }
      if (fetched == null) return null;
      const messages = fetched?.values ? [...fetched.values()] : Array.isArray(fetched) ? fetched : fetched ? Object.values(fetched) : [];
      for (const message of messages) {
        const created = Number(message.createdTimestamp ?? asDate(message.createdAt)?.getTime() ?? 0);
        if (message?.author?.id === assignment.userId
          && !message.author.bot
          && !message.webhookId
          && !message.system
          && created >= start
          && created <= end) return true;
      }
      if (!messages.length) break;
      const oldest = messages.reduce((current, message) => {
        const timestamp = Number(message.createdTimestamp ?? asDate(message.createdAt)?.getTime() ?? 0);
        return !current || timestamp < current.timestamp ? { message, timestamp } : current;
      }, null);
      if (!oldest?.message?.id) return null;
      if (oldest.timestamp <= start) break;
      // Re-seeing a cursor means the adapter/API did not advance through the
      // history. Treat it as unknown so a repeated page cannot become a miss.
      if (seenCursors.has(oldest.message.id)) return null;
      seenCursors.add(oldest.message.id);
      before = oldest.message.id;
    }
    // Reaching the safety cap without reaching the assignment start leaves a
    // portion of history unexamined. Keep the assignment pending and retry.
    return page >= 50 ? null : false;
  }

  async function findEarlierUnresolvedOutcome(assignment) {
    const targetAt = assignmentOutcomeAt(assignment, new Date(0));
    const assignments = await findMany(
      assignmentModel,
      { guildId: assignment.guildId, userId: assignment.userId, sendState: "sent" },
      { deadlineAt: 1, assignedAt: 1 },
    );
    return assignments.find((candidate) => {
      if (candidate.assignmentId === assignment.assignmentId) return false;
      const candidateAt = assignmentOutcomeAt(candidate, new Date(0));
      if (candidateAt.getTime() >= targetAt.getTime()) return false;
      if (candidate.status === "active") return true;
      if (candidate.status === "missed") return candidate.missState !== "applied";
      if (candidate.status === "completed") return candidate.completionState !== "applied";
      return false;
    }) ?? null;
  }

  // Completion is recorded on the assignment before its participant counter
  // projection; see reconcileCompletedAssignment below.

  async function blockCompletionReconciliation(assignment, currentNow, error) {
    const fallbackKey = `${assignment.guildId}:${assignment.assignmentId}`;
    const attempts = Math.min(
      DIARY_MAX_OUTCOME_ATTEMPTS,
      Math.max(
        Number(assignment.completionAttempts) || 0,
        Number(counterRetryFallback.get(fallbackKey)?.attempts) || 0,
      ) + 1,
    );
    const exhausted = attempts >= DIARY_MAX_OUTCOME_ATTEMPTS;
    const nextRetryAt = exhausted ? null : retryAt(currentNow, attempts);
    const saved = await assignmentModel.updateOne?.(
      { guildId: assignment.guildId, assignmentId: assignment.assignmentId, status: "completed" },
      { $set: {
        completionState: exhausted ? "blocked" : "pending",
        completionAttempts: attempts,
        completionNextRetryAt: nextRetryAt,
        completionLastError: safeErrorMessage(error),
        checkedAt: currentNow,
      } },
    ).then((result) => matched(result)).catch(() => false);
    if (saved) counterRetryFallback.delete(fallbackKey);
    else counterRetryFallback.set(fallbackKey, { attempts, nextRetryAt });
    const guild = client?.guilds?.cache?.get(assignment.guildId) ?? null;
    const settings = await getSettings(assignment.guildId).catch(() => null);
    await operationalLog(guild, settings, exhausted
      ? `🚨 交換日記達成結果の連続未投稿リセットを再試行上限で停止しました：assignment=${assignment.assignmentId}`
      : `⚠️ 交換日記達成結果の連続未投稿リセットを保留しました：assignment=${assignment.assignmentId} attempts=${attempts}`);
    return { status: exhausted ? "blocked" : "pending", attempts };
  }

  async function reconcileCompletedAssignment(assignment, currentNow, outcomeAtOverride = null) {
    const fallbackKey = `${assignment.guildId}:${assignment.assignmentId}`;
    const fallback = counterRetryFallback.get(fallbackKey);
    const retryAtDate = asDate(assignment.completionNextRetryAt ?? fallback?.nextRetryAt);
    if (retryAtDate && retryAtDate.getTime() > currentNow.getTime()) return { status: "backoff" };
    if (assignment.completionState === "blocked" || Number(fallback?.attempts) >= DIARY_MAX_OUTCOME_ATTEMPTS) return { status: "blocked" };
    const participant = await findOne(participantModel, { guildId: assignment.guildId, userId: assignment.userId });
    if (!participant) {
      const saved = await assignmentModel.updateOne?.(
        { guildId: assignment.guildId, assignmentId: assignment.assignmentId, status: "completed" },
        { $set: { completionState: "applied", completionNextRetryAt: null, completionLastError: null, checkedAt: currentNow } },
      ).then((result) => matched(result)).catch(() => false);
      if (!saved) return blockCompletionReconciliation(assignment, currentNow, new Error("participant missing while completing assignment"));
      counterRetryFallback.delete(fallbackKey);
      return { status: "stale" };
    }
    const joinedAt = asDate(participant.joinedAt);
    const assignmentAt = asDate(assignment.nominalAt ?? assignment.assignedAt);
    if (joinedAt && assignmentAt && assignmentAt.getTime() < joinedAt.getTime()) {
      const saved = await assignmentModel.updateOne?.(
        { guildId: assignment.guildId, assignmentId: assignment.assignmentId, status: "completed" },
        { $set: { completionState: "applied", completionNextRetryAt: null, completionLastError: null, checkedAt: currentNow } },
      ).then((result) => matched(result)).catch(() => false);
      if (!saved) return blockCompletionReconciliation(assignment, currentNow, new Error("stale assignment completion state could not be saved"));
      counterRetryFallback.delete(fallbackKey);
      return { status: "stale" };
    }
    const earlier = await findEarlierUnresolvedOutcome(assignment);
    if (earlier) {
      if (earlier.missState === "blocked" || earlier.completionState === "blocked") {
        return blockCompletionReconciliation(assignment, currentNow, new Error(`earlier assignment reconciliation blocked: ${earlier.assignmentId}`));
      }
      return { status: "waiting-earlier" };
    }
    const outcomeAt = asDate(outcomeAtOverride, assignmentOutcomeAt(assignment, currentNow));
    const currentOutcomeAt = asDate(participant.lastDiaryOutcomeAt);
    const markerIsThisAssignment = participant.lastDiaryOutcomeAssignmentId === assignment.assignmentId;
    let allowSpecialSuccessAfterMiss = false;
    let specialPriorAssignmentId = null;
    if (assignment.specialNoPenalty
      && participant.lastDiaryOutcomeKind === "missed"
      && participant.lastDiaryOutcomeAssignmentId
      && participant.lastDiaryOutcomeAssignmentId !== assignment.assignmentId) {
      const priorAssignment = await findOne(assignmentModel, {
        guildId: assignment.guildId,
        assignmentId: participant.lastDiaryOutcomeAssignmentId,
      });
      allowSpecialSuccessAfterMiss = Boolean(priorAssignment?.slotKey && priorAssignment.slotKey === assignment.slotKey);
      if (allowSpecialSuccessAfterMiss) specialPriorAssignmentId = participant.lastDiaryOutcomeAssignmentId;
    }
    const equalMiss = currentOutcomeAt
      && currentOutcomeAt.getTime() === outcomeAt.getTime()
      && participant.lastDiaryOutcomeKind === "missed";
    const shouldProject = !currentOutcomeAt
      || outcomeAt.getTime() > currentOutcomeAt.getTime()
      || (outcomeAt.getTime() === currentOutcomeAt.getTime() && (!equalMiss || allowSpecialSuccessAfterMiss))
      || allowSpecialSuccessAfterMiss;
    if (shouldProject && !markerIsThisAssignment) {
      let participantResult;
      try {
        participantResult = await participantModel.updateOne?.(
          allowSpecialSuccessAfterMiss
            ? {
              guildId: assignment.guildId,
              userId: assignment.userId,
              lastDiaryOutcomeAssignmentId: specialPriorAssignmentId,
              lastDiaryOutcomeKind: "missed",
            }
            : {
              guildId: assignment.guildId,
              userId: assignment.userId,
              $or: [
                { lastDiaryOutcomeAt: null },
                { lastDiaryOutcomeAt: { $exists: false } },
                { lastDiaryOutcomeAt: { $lte: outcomeAt } },
              ],
            },
          { $set: {
            consecutiveMisses: 0,
            lastDiaryOutcomeAt: outcomeAt,
            lastDiaryOutcomeAssignmentId: assignment.assignmentId,
            lastDiaryOutcomeKind: "completed",
          } },
        );
      } catch (error) {
        return blockCompletionReconciliation(assignment, currentNow, error);
      }
      if (!matched(participantResult)) {
        const latest = await findOne(participantModel, { guildId: assignment.guildId, userId: assignment.userId });
        const latestOutcomeAt = asDate(latest?.lastDiaryOutcomeAt);
        const latestMarker = latest?.lastDiaryOutcomeAssignmentId === assignment.assignmentId;
        if (!latestMarker && !(latestOutcomeAt && latestOutcomeAt.getTime() >= outcomeAt.getTime())) {
          return blockCompletionReconciliation(assignment, currentNow, new Error("participant completion projection returned no change"));
        }
      }
    }
    const saved = await assignmentModel.updateOne?.(
      { guildId: assignment.guildId, assignmentId: assignment.assignmentId, status: "completed" },
      { $set: { completionState: "applied", completionNextRetryAt: null, completionLastError: null, checkedAt: currentNow } },
    ).then((result) => matched(result)).catch(() => false);
    if (!saved) return blockCompletionReconciliation(assignment, currentNow, new Error("assignment completion state save returned no change"));
    counterRetryFallback.delete(fallbackKey);
    return { status: "applied", projected: shouldProject && !markerIsThisAssignment };
  }

  async function completeAssignment(assignment, message = null, detectedAt = new Date(now())) {
    if (!assignmentModel?.updateOne) return false;
    // Live messages carry their observed timestamp; history reconciliation
    // uses the deadline as the stable outcome order. Close the assignment
    // before projecting the participant counter so a deleted post cannot
    // turn a known success back into a miss.
    const outcomeAt = asDate(message ? detectedAt : (assignment.deadlineAt ?? assignment.assignedAt ?? detectedAt), detectedAt);
    const participant = await findOne(participantModel, { guildId: assignment.guildId, userId: assignment.userId });
    if (!participant) return false;
    const joinedAt = asDate(participant.joinedAt);
    const assignmentAt = asDate(assignment.nominalAt ?? assignment.assignedAt ?? outcomeAt, outcomeAt);
    if (joinedAt && assignmentAt && assignmentAt.getTime() < joinedAt.getTime()) {
      await assignmentModel.updateOne(
        { guildId: assignment.guildId, assignmentId: assignment.assignmentId, status: "active" },
        { $set: { status: "canceled", cancelReason: "stale-session", checkedAt: detectedAt } },
      );
      return false;
    }
    let result;
    try {
      result = await assignmentModel.updateOne(
        { guildId: assignment.guildId, assignmentId: assignment.assignmentId, status: "active" },
        { $set: {
          status: "completed",
          postDetectedAt: message ? detectedAt : null,
          postMessageId: message?.id ?? null,
          outcomeAt,
          completionState: "pending",
          completionAttempts: 0,
          completionNextRetryAt: null,
          completionLastError: null,
          checkedAt: detectedAt,
        } },
      );
    } catch (error) {
      await operationalLog(
        client?.guilds?.cache?.get(assignment.guildId) ?? null,
        await getSettings(assignment.guildId).catch(() => null),
        `⚠️ 交換日記達成状態を保存できませんでした：assignment=${assignment.assignmentId} error=${safeErrorMessage(error)}`,
      );
      return false;
    }
    let completedAssignment = { ...assignment };
    if (matched(result)) {
      Object.assign(completedAssignment, {
        status: "completed",
        postDetectedAt: message ? detectedAt : null,
        postMessageId: message?.id ?? null,
        outcomeAt,
        completionState: "pending",
        completionAttempts: 0,
        completionNextRetryAt: null,
        completionLastError: null,
      });
    } else {
      const current = await findOne(assignmentModel, { guildId: assignment.guildId, assignmentId: assignment.assignmentId });
      if (current?.status !== "completed") return false;
      completedAssignment = { ...completedAssignment, ...current };
    }
    const projection = await reconcileCompletedAssignment(completedAssignment, detectedAt, outcomeAt);
    const guild = client?.guilds?.cache?.get(assignment.guildId) ?? null;
    const settings = await getSettings(assignment.guildId).catch(() => null);
    if (projection.status !== "blocked") {
      await operationalLog(guild, settings, `✅ 交換日記投稿確認：<@${assignment.userId}> の今回の投稿を確認しました。`);
    }
    return true;
  }

  async function handleMessage(message) {
    if (!isHumanMessage(message)) return;
    const settings = await getSettings(message.guild.id).catch(() => null);
    const assignments = await findMany(assignmentModel, { guildId: message.guild.id, userId: message.author.id, status: "active", sendState: "sent" }, { assignedAt: 1 });
    const createdAt = new Date(message.createdTimestamp ?? message.createdAt ?? now());
    for (const assignment of assignments) {
      const assignmentChannelId = diaryAssignmentChannelId(assignment, settings);
      if (!assignmentChannelId || assignmentChannelId !== message.channelId) continue;
      if (createdAt.getTime() < asDate(assignment.assignedAt, createdAt).getTime()) continue;
      if (createdAt.getTime() > asDate(assignment.deadlineAt, createdAt).getTime()) continue;
      if (await completeAssignment(assignment, message, createdAt)) break;
    }
  }

  function assignmentOutcomeAt(assignment, fallback) {
    return asDate(
      assignment?.outcomeAt
        ?? (assignment?.postMessageId ? assignment?.postDetectedAt : null)
        ?? assignment?.deadlineAt
        ?? assignment?.nominalAt
        ?? assignment?.assignedAt,
      fallback,
    ) ?? fallback;
  }

  async function blockMissReconciliation(assignment, currentNow, error) {
    const fallbackKey = `${assignment.guildId}:${assignment.assignmentId}`;
    const attempts = Math.min(
      DIARY_MAX_OUTCOME_ATTEMPTS,
      Math.max(Number(assignment.missAttempts) || 0, Number(outcomeRetryFallback.get(fallbackKey)?.attempts) || 0) + 1,
    );
    const exhausted = attempts >= DIARY_MAX_OUTCOME_ATTEMPTS;
    const saved = await assignmentModel.updateOne?.(
      { guildId: assignment.guildId, assignmentId: assignment.assignmentId, status: "missed" },
      { $set: {
        missState: exhausted ? "blocked" : "pending",
        missAttempts: attempts,
        missNextRetryAt: exhausted ? null : retryAt(currentNow, attempts),
        missLastError: safeErrorMessage(error),
        checkedAt: currentNow,
      } },
    ).then((result) => matched(result)).catch(() => false);
    if (saved) outcomeRetryFallback.delete(fallbackKey);
    else outcomeRetryFallback.set(fallbackKey, { attempts, nextRetryAt: exhausted ? null : retryAt(currentNow, attempts) });
    const guild = client?.guilds?.cache?.get(assignment.guildId) ?? null;
    const settings = await getSettings(assignment.guildId).catch(() => null);
    await operationalLog(guild, settings, exhausted
      ? `🚨 交換日記未投稿判定の再試行上限に達したため停止しました：assignment=${assignment.assignmentId}`
      : `⚠️ 交換日記未投稿判定を保留しました：assignment=${assignment.assignmentId} attempts=${attempts}`);
    return { status: exhausted ? "blocked" : "pending", attempts };
  }

  async function markMissPending(assignment, currentNow) {
    if (assignment.status === "missed") return true;
    const result = await assignmentModel.updateOne?.(
      { guildId: assignment.guildId, assignmentId: assignment.assignmentId, status: "active", sendState: "sent" },
      { $set: { status: "missed", missState: "pending", missAttempts: Number(assignment.missAttempts) || 0, missNextRetryAt: null, checkedAt: currentNow } },
    );
    if (modified(result)) {
      assignment.status = "missed";
      assignment.missState = "pending";
      return true;
    }
    const current = await findOne(assignmentModel, { guildId: assignment.guildId, assignmentId: assignment.assignmentId });
    return current?.status === "missed" && current?.missState !== "blocked";
  }

  async function reconcileMissedAssignment(guild, settings, assignment, currentNow) {
    const fallback = outcomeRetryFallback.get(`${assignment.guildId}:${assignment.assignmentId}`);
    const retryAtDate = asDate(assignment.missNextRetryAt ?? fallback?.nextRetryAt);
    if (retryAtDate && retryAtDate.getTime() > currentNow.getTime()) return { status: "backoff" };
    if (assignment.missState === "blocked" || Number(fallback?.attempts) >= DIARY_MAX_OUTCOME_ATTEMPTS) return { status: "blocked" };
    // Preserve chronological counter semantics. If an older assignment is
    // still active/pending, leave this row pending as well; applying the newer
    // miss first would make a later retry of the older miss under-count. Once
    // the older row is permanently blocked, bound this row too and surface the
    // ordering failure instead of retrying forever on every worker tick.
    const earlier = await findEarlierUnresolvedOutcome(assignment);
    if (earlier) {
      if (earlier.missState === "blocked" || earlier.completionState === "blocked") {
        return blockMissReconciliation(assignment, currentNow, new Error(`earlier assignment reconciliation blocked: ${earlier.assignmentId}`));
      }
      return { status: "waiting-earlier" };
    }
    const participant = await findOne(participantModel, { guildId: guild.id, userId: assignment.userId });
    if (!participant) {
      await assignmentModel.updateOne?.(
        { guildId: guild.id, assignmentId: assignment.assignmentId, status: "missed" },
        { $set: { status: "canceled", missState: "applied", cancelReason: "participant-missing", checkedAt: currentNow } },
      );
      outcomeRetryFallback.delete(`${assignment.guildId}:${assignment.assignmentId}`);
      return { status: "stale" };
    }
    const joinedAt = asDate(participant.joinedAt);
    const assignmentAt = asDate(assignment.nominalAt ?? assignment.assignedAt);
    if (joinedAt && assignmentAt && assignmentAt.getTime() < joinedAt.getTime()) {
      await assignmentModel.updateOne?.(
        { guildId: guild.id, assignmentId: assignment.assignmentId, status: "missed" },
        { $set: { status: "canceled", missState: "applied", cancelReason: "stale-session", checkedAt: currentNow } },
      );
      outcomeRetryFallback.delete(`${assignment.guildId}:${assignment.assignmentId}`);
      return { status: "stale" };
    }
    const outcomeAt = assignmentOutcomeAt(assignment, currentNow);
    const currentOutcomeAt = asDate(participant.lastDiaryOutcomeAt);
    const markerIsThisAssignment = participant.lastDiaryOutcomeAssignmentId === assignment.assignmentId
      || participant.lastDiaryMissAssignmentId === assignment.assignmentId;
    if (markerIsThisAssignment || (currentOutcomeAt && currentOutcomeAt.getTime() > outcomeAt.getTime())) {
      await assignmentModel.updateOne?.(
        { guildId: guild.id, assignmentId: assignment.assignmentId, status: "missed" },
        { $set: { missState: "applied", missCounterIgnored: !markerIsThisAssignment, missNextRetryAt: null, checkedAt: currentNow } },
      );
      outcomeRetryFallback.delete(`${assignment.guildId}:${assignment.assignmentId}`);
      return { status: "applied", ignored: !markerIsThisAssignment, nextMisses: Number(participant.consecutiveMisses) || 0 };
    }
    const oldMisses = Number(participant.consecutiveMisses) || 0;
    const nextMisses = assignment.specialNoPenalty ? oldMisses : oldMisses + 1;
    let participantResult = null;
    try {
      participantResult = await participantModel.updateOne?.(
        {
          guildId: guild.id,
          userId: assignment.userId,
          $or: [
            { lastDiaryOutcomeAt: null },
            { lastDiaryOutcomeAt: { $exists: false } },
            { lastDiaryOutcomeAt: { $lte: outcomeAt } },
          ],
        },
        {
          $set: {
            ...(assignment.specialNoPenalty ? {} : { consecutiveMisses: Math.min(3, nextMisses) }),
            lastDiaryOutcomeAt: outcomeAt,
            lastDiaryOutcomeAssignmentId: assignment.assignmentId,
            lastDiaryOutcomeKind: "missed",
            lastDiaryMissAssignmentId: assignment.assignmentId,
          },
        },
      );
    } catch (error) {
      return blockMissReconciliation(assignment, currentNow, error);
    }
    if (!matched(participantResult)) {
      const latest = await findOne(participantModel, { guildId: guild.id, userId: assignment.userId });
      const latestOutcomeAt = asDate(latest?.lastDiaryOutcomeAt);
      const latestMarker = latest?.lastDiaryOutcomeAssignmentId === assignment.assignmentId
        || latest?.lastDiaryMissAssignmentId === assignment.assignmentId;
      if (!latestMarker && !(latestOutcomeAt && latestOutcomeAt.getTime() > outcomeAt.getTime())) {
        return blockMissReconciliation(assignment, currentNow, new Error("participant miss projection returned no change"));
      }
    }
    const assignmentResult = await assignmentModel.updateOne?.(
      { guildId: guild.id, assignmentId: assignment.assignmentId, status: "missed" },
      { $set: { missState: "applied", missNextRetryAt: null, missLastError: null, checkedAt: currentNow } },
    );
    if (!matched(assignmentResult)) return blockMissReconciliation(assignment, currentNow, new Error("assignment miss state save returned no change"));
    outcomeRetryFallback.delete(`${assignment.guildId}:${assignment.assignmentId}`);
    await operationalLog(guild, settings, `⚠️ 交換日記投稿未確認：<@${assignment.userId}> の期限内投稿を確認できませんでした。${assignment.specialNoPenalty ? "今回の遅延指名はペナルティ免除です。" : `連続未投稿：${nextMisses}/3`}`);
    if (!assignment.specialNoPenalty && nextMisses >= 3) {
      await removeParticipant(guild, assignment.userId, settings, { reason: "automatic-missed", sendDm: true, currentNow });
    }
    return { status: "applied", nextMisses };
  }

  async function reconcileCompletedAssignments(guild, currentNow) {
    const assignments = await findMany(assignmentModel, {
      guildId: guild.id,
      status: "completed",
      sendState: "sent",
      $or: [
        { completionState: "pending" },
        { completionState: { $exists: false } },
      ],
    }, { deadlineAt: 1, assignedAt: 1 });
    for (const assignment of assignments) {
      await reconcileCompletedAssignment(assignment, currentNow);
    }
  }

  async function processDueAssignments(guild, settings, currentNow) {
    // Completed rows are the durable success ledger. Reconcile them before
    // examining later active/missed rows so a stale pending success cannot be
    // skipped in favour of a newer miss.
    await reconcileCompletedAssignments(guild, currentNow);
    // Only a durably sent assignment can be inspected. A `missed/pending`
    // row is also loaded: it is the durable recovery point between the miss
    // transition and participant counter projection.
    const assignments = await findMany(assignmentModel, {
      guildId: guild.id,
      $or: [
        { status: "active", sendState: "sent", deadlineAt: { $lte: currentNow } },
        { status: "missed", $or: [{ missState: "pending" }, { missState: { $exists: false } }] },
      ],
    }, { deadlineAt: 1, assignedAt: 1 });
    for (const assignment of assignments) {
      if (assignment.status === "missed") {
        await reconcileMissedAssignment(guild, settings, assignment, currentNow);
        continue;
      }
      const participant = await findOne(participantModel, { guildId: guild.id, userId: assignment.userId });
      const joinedAt = asDate(participant?.joinedAt);
      const assignmentAt = asDate(assignment.nominalAt ?? assignment.assignedAt);
      if (!participant || (joinedAt && assignmentAt && assignmentAt.getTime() < joinedAt.getTime())) {
        await assignmentModel.updateOne?.(
          { guildId: guild.id, assignmentId: assignment.assignmentId, status: "active" },
          { $set: { status: "canceled", cancelReason: participant ? "stale-session" : "participant-missing", checkedAt: currentNow } },
        );
        continue;
      }
      const channel = await resolveChannel(guild, diaryAssignmentChannelId(assignment, settings));
      if (!channel) {
        await operationalLog(guild, settings, `⚠️ 交換日記投稿判定を保留しました。CHを取得できません。assignment=${assignment.assignmentId}`);
        continue;
      }
      const hasPost = await messagesContainPost(channel, assignment, currentNow);
      if (hasPost === null) {
        await operationalLog(guild, settings, `⚠️ 交換日記投稿判定を保留しました。履歴を取得できません。assignment=${assignment.assignmentId}`);
        continue;
      }
      if (hasPost) {
        await completeAssignment(assignment, null, currentNow);
        continue;
      }
      if (!await markMissPending(assignment, currentNow)) continue;
      const current = await findOne(assignmentModel, { guildId: guild.id, assignmentId: assignment.assignmentId }) ?? assignment;
      await reconcileMissedAssignment(guild, settings, current, currentNow);
    }
  }

  async function repairParticipantLastAssignments(guildId, participants, settings = null, guild = null) {
    if (!assignmentModel?.find || !participants.length) return participants;
    const joinedAtByUser = new Map(
      participants
        .filter((participant) => participant?.userId)
        .map((participant) => [participant.userId, asDate(participant.joinedAt)]),
    );
    const assignments = await findMany(assignmentModel, { guildId, sendState: "sent" }, { nominalAt: -1, assignedAt: -1 });
    const latestByUser = new Map();
    for (const assignment of assignments) {
      if (assignment.sendState !== "sent" || !assignment.userId) continue;
      const timestamp = asDate(assignment.nominalAt ?? assignment.assignedAt);
      if (!timestamp) continue;
      const joinedAt = joinedAtByUser.get(assignment.userId);
      if (joinedAt && timestamp.getTime() < joinedAt.getTime()) continue;
      const previous = latestByUser.get(assignment.userId);
      if (!previous || timestamp.getTime() > previous.getTime()) latestByUser.set(assignment.userId, timestamp);
    }
    for (const participant of participants) {
      const latest = latestByUser.get(participant.userId);
      if (!latest) continue;
      const stored = asDate(participant.lastAssignedAt);
      if (stored && stored.getTime() >= latest.getTime()) continue;
      participant.lastAssignedAt = latest;
      const result = await participantModel.updateOne?.(
        { guildId, userId: participant.userId },
        { $set: { lastAssignedAt: latest } },
      ).catch(() => null);
      if (!matched(result) && guild) {
        await operationalLog(guild, settings, `⚠️ 交換日記の指名履歴から最終指名日時を復元できませんでした：<@${participant.userId}>`);
      }
    }
    return participants;
  }

  async function sendAssignments(guild, settings, selected, slotAt, currentNow) {
    const channel = await resolveChannel(guild, settings?.diaryChannelId);
    if (!channel) {
      await operationalLog(guild, settings, `⚠️ 交換日記CHを取得できないため、本日の指名を中止しました。channelId=${settings?.diaryChannelId ?? "未設定"}`);
      return { status: "channel-unavailable", assigned: 0 };
    }
    const deadlineAt = diaryNextJst18At(slotAt);
    const remainingHours = (deadlineAt.getTime() - currentNow.getTime()) / (60 * 60 * 1_000);
    const specialNoPenalty = remainingHours < DIARY_SPECIAL_NO_PENALTY_HOURS;
    const assignmentIds = selected.map((participant) => `${guild.id}:${diaryJstDateKey(slotAt)}:${participant.userId}`);
    const prepared = [];
    let alreadySent = 0;
    let uncertainExisting = 0;
    try {
      for (const [index, participant] of selected.entries()) {
        const assignmentId = assignmentIds[index];
        if (assignmentModel?.findOneAndUpdate) {
          const result = await assignmentModel.findOneAndUpdate(
            {
              guildId: guild.id,
              assignmentId,
              $or: [
                { status: "active", sendState: "pending" },
                { status: "active", sendState: { $exists: false } },
                { status: "canceled", cancelReason: { $in: ["send-failed", "send-claim-failed", "daily-run-recovery-pending"] } },
              ],
            },
            {
              $set: {
                slotKey: diaryJstDateKey(slotAt),
                userId: participant.userId,
                channelId: channel.id,
                assignedAt: currentNow,
                nominalAt: slotAt,
                deadlineAt,
                status: "active",
                specialNoPenalty,
                postMessageId: null,
                sendState: "sending",
                sendClaimToken: claimToken,
                sendClaimedAt: currentNow,
              },
              $setOnInsert: { guildId: guild.id, assignmentId },
            },
            { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
          );
          const resolvedResult = await resolveQuery(result);
          const claimed = resolvedResult?.value ?? resolvedResult;
          // Mongoose returns null when another worker owns the row. Fail
          // closed for an undefined result as well: a caller must receive a
          // concrete claimed document before it can publish publicly.
          if (!claimed) {
            const existing = await findOne(assignmentModel, { guildId: guild.id, assignmentId });
            if (existing?.sendState === "sent") alreadySent += 1;
            if (existing?.status === "active" && existing.sendState === "sending") {
              const result = await assignmentModel.updateOne?.(
                { guildId: guild.id, assignmentId, status: "active", sendState: "sending" },
                { $set: { status: "canceled", sendState: "failed", cancelReason: "send-outcome-uncertain", checkedAt: currentNow } },
              );
              if (matched(result)) {
                await participantModel.updateOne?.(
                  { guildId: guild.id, userId: participant.userId },
                  { $set: { lastAssignedAt: existing.nominalAt ?? existing.assignedAt ?? slotAt } },
                ).catch(() => null);
                uncertainExisting += 1;
              }
            }
            continue;
          }
          if (claimed?.sendClaimToken && claimed.sendClaimToken !== claimToken) continue;
        } else if (assignmentModel?.create) {
          await assignmentModel.create({ guildId: guild.id, assignmentId, slotKey: diaryJstDateKey(slotAt), userId: participant.userId, channelId: channel.id, assignedAt: currentNow, nominalAt: slotAt, deadlineAt, status: "active", specialNoPenalty, postMessageId: null, sendState: "sending", sendClaimToken: claimToken, sendClaimedAt: currentNow });
        }
        prepared.push({ assignmentId, participant });
      }
    } catch (error) {
      if (assignmentModel?.updateMany) await assignmentModel.updateMany({ guildId: guild.id, assignmentId: { $in: assignmentIds }, status: "active", sendClaimToken: claimToken }, { $set: { status: "canceled", sendState: "failed", cancelReason: "send-claim-failed" } }).catch(() => null);
      await operationalLog(guild, settings, `⚠️ 交換日記指名状態の確保に失敗しました：${safeErrorMessage(error)}`);
      return { status: "claim-failed", assigned: 0 };
    }
    if (prepared.length === 0) {
      if (alreadySent > 0 || uncertainExisting > 0) return { status: "already-sent", assigned: 0, alreadySent, uncertain: uncertainExisting, specialNoPenalty };
      return { status: "already-claimed", assigned: 0, specialNoPenalty };
    }
    const userIds = prepared.map(({ participant }) => participant.userId);
    const content = formatDiaryAssignmentMessage(userIds, deadlineAt, { now: currentNow, specialNoPenalty });
    let message;
    try {
      message = await channel.send({ content, allowedMentions: { users: userIds, roles: [], parse: [] } });
    } catch (error) {
      if (assignmentModel?.updateMany) await assignmentModel.updateMany({ guildId: guild.id, assignmentId: { $in: prepared.map(({ assignmentId }) => assignmentId) }, status: "active", sendState: "sending", sendClaimToken: claimToken }, { $set: { status: "canceled", sendState: "failed", cancelReason: "send-failed" } }).catch(() => null);
      await operationalLog(guild, settings, `⚠️ 交換日記指名メッセージ送信失敗：${safeErrorMessage(error)}`);
      return { status: "send-failed", assigned: 0 };
    }
    let assigned = 0;
    let uncertain = 0;
    let unresolved = 0;
    for (const { assignmentId, participant } of prepared) {
      try {
        const stateResult = assignmentModel?.updateOne
          ? await assignmentModel.updateOne(
            { guildId: guild.id, assignmentId, status: "active", sendState: "sending", sendClaimToken: claimToken },
            { $set: { postMessageId: message.id ?? null, sendState: "sent", sendClaimedAt: null } },
          )
          : null;
        if (!matched(stateResult)) {
          const rollback = await assignmentModel.updateOne?.(
            { guildId: guild.id, assignmentId, status: "active", sendState: "sending", sendClaimToken: claimToken },
            { $set: { status: "canceled", sendState: "failed", cancelReason: "send-outcome-uncertain", checkedAt: currentNow } },
          ).catch(() => null);
          if (matched(rollback)) {
            await participantModel.updateOne?.(
              { guildId: guild.id, userId: participant.userId },
              { $set: { lastAssignedAt: slotAt } },
            ).catch(() => null);
            uncertain += 1;
          } else {
            unresolved += 1;
          }
          await operationalLog(guild, settings, `⚠️ 交換日記指名状態を確定できませんでした：<@${participant.userId}>`);
          continue;
        }
        const participantResult = participantModel?.updateOne
          ? await participantModel.updateOne({ guildId: guild.id, userId: participant.userId }, { $set: { lastAssignedAt: slotAt } })
          : null;
        if (!matched(participantResult)) {
          await operationalLog(guild, settings, `⚠️ 交換日記の最終指名日時を保存できませんでした：<@${participant.userId}>`);
        }
        await operationalLog(guild, settings, `📖 交換日記指名：<@${participant.userId}> を今回の担当に指名しました。期限：${diaryJstDateKey(deadlineAt)} 18:00`);
        assigned += 1;
      } catch (error) {
        const rollback = await assignmentModel.updateOne?.(
          { guildId: guild.id, assignmentId, status: "active", sendState: "sending", sendClaimToken: claimToken },
          { $set: { status: "canceled", sendState: "failed", cancelReason: "send-outcome-uncertain", checkedAt: currentNow } },
        ).catch(() => null);
        if (matched(rollback)) {
          await participantModel.updateOne?.(
            { guildId: guild.id, userId: participant.userId },
            { $set: { lastAssignedAt: slotAt } },
          ).catch(() => null);
          uncertain += 1;
        } else {
          unresolved += 1;
        }
        await operationalLog(guild, settings, `⚠️ 交換日記指名状態の保存に失敗：<@${participant.userId}> error=${safeErrorMessage(error)}`);
      }
    }
    return { status: "assigned", assigned, attempted: prepared.length, partial: assigned < prepared.length, uncertain, unresolved, specialNoPenalty };
  }

  async function processGuild(guild, { at = now(), force = false } = {}) {
    if (!guild?.id || guildLocks.has(guild.id)) return { status: "busy" };
    guildLocks.add(guild.id);
    let claimedSlotKey = null;
    try {
      const settings = await getSettings(guild.id);
      if (!settings) return { status: "settings-unavailable" };
      const currentNow = asDate(at, new Date());
      if (settings.diaryEnabled !== true) {
        await cancelAssignments(guild.id, null, "feature-disabled");
        return { status: "disabled" };
      }
      // Cleanup and auto-leave recovery are durable side effects independent
      // of today's assignment claim. Run them on every worker tick, but each
      // item carries its own backoff/attempt ceiling.
      if (settings.diaryReceptionChannelId) {
        try {
          const panel = await findOne(panelModel, { guildId: guild.id });
          await reconcilePanelCleanup(guild, settings, panel?.pendingMessageDeletions ?? []);
        } catch (error) {
          await operationalLog(guild, settings, `⚠️ 交換日記旧受付パネルの回収状態を確認できませんでした：${safeErrorMessage(error)}`);
        }
      }
      await processPendingParticipantRemovals(guild, settings, currentNow);
      await processDueAssignments(guild, settings, currentNow);
      const due = diaryLatestDueSlot(currentNow);
      const recoveredRuns = await recoverClaimedDailyRuns(guild, currentNow, settings);
      const recovered = recoveredRuns.find((item) => item.slotKey === due.slotKey) ?? { status: "not-claimed" };
      if (["active", "busy", "recovered-completed"].includes(recovered.status)) {
        return { ...recovered, slotKey: due.slotKey };
      }
      if (!force && settings.diaryLastRunSlot === due.slotKey) return { status: "already-processed", slotKey: due.slotKey };
      if (!await claimDailyRun(guild.id, due.slotKey, currentNow)) return { status: "already-claimed", slotKey: due.slotKey };
      claimedSlotKey = due.slotKey;
      const participants = (await findMany(participantModel, { guildId: guild.id }, { joinedAt: 1 }))
        .filter((participant) => !["pending", "failed"].includes(participant.leaveState));
      await repairParticipantLastAssignments(guild.id, participants, settings, guild);
      const maxDaily = normalizeDiaryMaxDaily(settings.diaryMaxDaily);
      const minIntervalDays = normalizeDiaryMinIntervalDays(settings.diaryMinIntervalDays);
      const period = diaryPeriodDays({ participantCount: participants.length, maxDaily, minIntervalDays });
      const previousPace = settings.diaryPaceState;
      const sameConfig = previousPace
        && Number(previousPace.participantCount) === participants.length
        && Number(previousPace.maxDaily) === maxDaily
        && Number(previousPace.minIntervalDays) === minIntervalDays
        && asDate(previousPace.periodStartAt);
      let periodStartAt = sameConfig ? asDate(previousPace.periodStartAt) : due.slotAt;
      let dayIndex = sameConfig ? diaryDaysBetween(due.slotAt, periodStartAt) : 0;
      if (!Number.isInteger(dayIndex) || dayIndex < 0 || dayIndex >= period) {
        periodStartAt = due.slotAt;
        dayIndex = 0;
      }
      const quota = calculateDiaryDailyQuota({ participantCount: participants.length, maxDaily, minIntervalDays, dayIndex });
      const selected = selectDiaryAssignees({ participants, slotAt: due.slotAt, maxDaily, minIntervalDays, dayIndex, quota });
      const special = (diaryNextJst18At(due.slotAt).getTime() - currentNow.getTime()) / (60 * 60 * 1_000) < DIARY_SPECIAL_NO_PENALTY_HOURS;
      const paceState = {
        periodStartAt,
        participantCount: participants.length,
        maxDaily,
        minIntervalDays,
        periodDays: period,
        lastDayIndex: dayIndex,
        lastQuota: quota,
        updatedAt: currentNow,
      };
      if (selected.length === 0) {
        await saveRuntime(guild.id, { diaryLastRunSlot: due.slotKey, diaryPaceState: paceState });
        await finishDailyRun(guild.id, due.slotKey, "completed", currentNow);
        return { status: "no-target", slotKey: due.slotKey, quota };
      }
      const result = await sendAssignments(guild, settings, selected, due.slotAt, currentNow);
      if ((result.status === "assigned" && result.assigned > 0 && result.unresolved === 0) || result.status === "already-sent") {
        await saveRuntime(guild.id, { diaryLastRunSlot: due.slotKey, diaryPaceState: paceState });
        await finishDailyRun(guild.id, due.slotKey, "completed", currentNow);
      } else {
        await finishDailyRun(guild.id, due.slotKey, "failed", currentNow, result.status);
      }
      return { ...result, slotKey: due.slotKey, quota, specialNoPenalty: special };
    } catch (error) {
      if (claimedSlotKey) await finishDailyRun(guild.id, claimedSlotKey, "failed", new Date(at), error).catch(() => null);
      await operationalLog(guild, null, `⚠️ 交換日記処理エラー：${safeErrorMessage(error)}`);
      logger.error?.(`Diary daily processing failed for guild ${guild.id}:`, error);
      return { status: "failed", error };
    } finally {
      guildLocks.delete(guild.id);
    }
  }

  async function handleManualAssignment(interaction) {
    if (!interaction?.inGuild?.() || !interaction.guild?.id) {
      await interaction.reply({ content: "このコマンドはサーバー内で使ってください。", flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
      return;
    }
    if (!interaction.memberPermissions?.has?.(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({ content: "このコマンドにはサーバー管理権限が必要です。", flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const result = await processGuild(interaction.guild, { at: now() });
      const messages = {
        assigned: `今日の指名処理を実行しました。指名人数: ${result.assigned}人。`,
        "already-processed": "今日の指名処理はすでに完了しています。重複指名は行いません。",
        "already-claimed": "今日の指名処理は別の実行で確保済みです。重複指名は行いません。",
        "already-sent": "今日の指名は送信済みです。重複指名は行いません。",
        "no-target": "今日の指名対象者はいません。参加時刻・指名間隔・日次枠を確認してください。",
        disabled: "交換日記機能は無効です。指名は行いません。",
        busy: "交換日記の処理が進行中です。完了後に再試行してください。",
      };
      const content = messages[result.status]
        ?? `今日の指名処理は完了していません（状態: ${result.status}）。運用ログを確認してください。`;
      await interaction.editReply({ content, allowedMentions: { parse: [] } });
    } catch (error) {
      logger.error?.("Manual diary assignment failed:", error);
      await interaction.editReply({ content: "指名処理を実行できませんでした。運用ログを確認してください。", allowedMentions: { parse: [] } });
    }
  }

  async function runAll({ at = now(), force = false } = {}) {
    const guilds = client?.guilds?.cache?.values ? [...client.guilds.cache.values()] : [];
    return Promise.all(guilds.map((guild) => processGuild(guild, { at, force })));
  }

  async function onSettingsChanged(guild, nextSettings = null, previousSettings = null) {
    const settings = nextSettings ?? await getSettings(guild.id);
    const wasEnabled = previousSettings?.diaryEnabled === true;
    if (settings?.diaryParticipantRoleId !== previousSettings?.diaryParticipantRoleId) {
      await participantModel.updateMany?.(
        { guildId: guild.id },
        { $set: { roleSyncState: "ready", roleSyncAttempts: 0, roleSyncNextRetryAt: null, roleSyncLastError: null } },
      ).catch(() => null);
      await syncParticipantRoles(guild, settings, { force: true });
      if (previousSettings?.diaryParticipantRoleId) {
        const oldRole = await resolveRole(guild, previousSettings.diaryParticipantRoleId);
        for (const oldMember of oldRole?.members?.values?.() ?? []) {
          if (!oldMember.user?.bot) await removeRole(oldMember, previousSettings.diaryParticipantRoleId);
        }
      }
    } else {
      await syncParticipantRoles(guild, settings, { force: true });
    }
    await ensurePanel(guild, settings);
    if (settings?.diaryEnabled !== true) {
      await cancelAssignments(guild.id, null, "feature-disabled");
    } else if (!wasEnabled) {
      // Enabling at 18:00 or later must wait for the next nominal slot.
      await saveRuntime(guild.id, { diaryLastRunSlot: diaryLatestDueSlot(now()).slotKey, diaryPaceState: null });
    }
    const changed = [];
    for (const key of ["diaryEnabled", "diaryChannelId", "diaryReceptionChannelId", "diaryParticipantRoleId", "diaryMaxDaily", "diaryMinIntervalDays"]) {
      if (previousSettings && JSON.stringify(previousSettings[key] ?? null) !== JSON.stringify(settings?.[key] ?? null)) changed.push(key);
    }
    await operationalLog(guild, settings, `⚙️ 交換日記設定適用：機能=${settings?.diaryEnabled === true ? "有効" : "無効"} / 変更=${changed.length ? changed.join(", ") : "なし"}`);
    await requestOperationalStatusRefresh(guild.id, "diary:settings");
    return { status: "applied" };
  }

  async function handleMemberRemove(member) {
    if (!member?.guild?.id || !member.id) return;
    const participant = await findOne(participantModel, { guildId: member.guild.id, userId: member.id });
    if (!participant) return;
    const settings = await getSettings(member.guild.id).catch(() => null);
    await removeParticipant(member.guild, member.id, settings, { reason: "guild-member-remove", member });
  }

  async function restore() {
    const guilds = client?.guilds?.cache?.values ? [...client.guilds.cache.values()] : [];
    const results = [];
    for (const guild of guilds) {
      try {
        const settings = await getSettings(guild.id);
        if (!settings) continue;
        await syncParticipantRoles(guild, settings, { force: true });
        await ensurePanel(guild, settings);
        await Promise.resolve(requestOperationalStatusRefresh(guild.id, "diary:startup")).catch((error) => logger.warn?.(`Diary startup status refresh failed: ${safeErrorMessage(error)}`));
        results.push(await processGuild(guild));
      } catch (error) {
        logger.error?.(`Diary startup restore failed for guild ${guild.id}:`, error);
        results.push({ status: "failed", error });
      }
    }
    return results;
  }

  function start() {
    if (workerTimer || typeof setInterval !== "function") return;
    workerTimer = setInterval(() => { void runAll().catch((error) => logger.error?.("Diary worker failed:", error)); }, 30_000);
    workerTimer.unref?.();
  }

  function stop() {
    if (workerTimer) clearInterval(workerTimer);
    workerTimer = null;
  }

  async function getStatus(guildId) {
    const count = await getParticipantCount(guildId);
    return { participantCount: Number(count) || 0 };
  }

  return {
    ensurePanel,
    syncParticipantRoles,
    handleButton,
    handleMessage,
    handleMemberRemove,
    recoverClaimedDailyRun,
    recoverClaimedDailyRuns,
    processGuild,
    handleManualAssignment,
    runAll,
    onSettingsChanged,
    restore,
    start,
    stop,
    getStatus,
    getParticipantCount,
    cancelAssignments,
  };
}
