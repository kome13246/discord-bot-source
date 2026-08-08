import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
} from "discord.js";
import { createVcDmPanelService, isCurrentVcDmPanelInteraction } from "./vc-dm-panel-service.js";
import {
  VC_DM_BUTTON_LABEL,
  VC_DM_FEATURE_VERSION,
  VC_DM_NEW_MEMBER_DAYS,
  VC_DM_REMINDER_CANCEL_LABEL,
  VC_DM_REMINDER_LEAD_MINUTES,
  VC_DM_VALID_VC_MINUTES,
  REMINDER_CANCELED_MESSAGE,
  REMINDER_MESSAGE,
  buildDmButtonCustomId,
  buildInactiveDmContent,
  buildNewMemberDmContent,
  buildReminderCancelCustomId,
  buildReminderConfirmationContent,
  canAttemptDmStatus,
  createVcDmRecordId,
  formatJstDateTime,
  getInactiveDmDueAt,
  getInactiveCycleKey as getCycleKey,
  getInactivityReference,
  getJstCalendarDate,
  getJstDateAt,
  getNextJstDaily17At,
  getNextJstHourAt,
  getNextVcDmEventAt,
  getNewMemberDmDueAt,
  getVcDmStatusSeverity,
  getVcDmConfigurationIssues,
  hasVcDmConfiguration,
  hasValidVcParticipation,
  isDmUnavailableError,
  isTargetVcChannel,
  normalizeVcDmEventTime,
  truncateError,
} from "./vc-dm-utils.js";
import {
  beginVcDmMigration,
  claimVcDmReminderConfirmation,
  cancelVcDmReminder,
  claimInactiveVcDm,
  claimNewVcDm,
  claimVcDmDailyRun,
  claimVcDmReminder,
  failVcDmDailyRun,
  failVcDmMigration,
  finishVcDmDailyRun,
  finishVcDmMigration,
  findOrCreateVcDmReminder,
  getActiveVcDmReminders,
  getVcDmDailyRun,
  getVcDmMember,
  getVcDmMemberByDmRecordId,
  getVcDmMigration,
  getVcDmPanel,
  getVcDmReminderByRecordId,
  getVcDmReminderBySourceRecordId,
  listVcDmMembers,
  getVcDmResultSummary,
  markInactiveVcDmUncertain,
  markNewVcDmUncertain,
  markVcDmMemberJoined,
  markVcDmMemberLeft,
  recordVcDmDailyRunResult,
  recordValidVcParticipation,
  recoverVcDmReminders,
  recoverVcDmMemberDmProcessing,
  repairVcDmParticipationRecords,
  saveVcDmReminderConfirmation,
  rescheduleVcDmReminder,
  rescheduleVcDmReminderTarget,
  setManualVcParticipationConfirmation,
  setVcDmReminderStatus,
  stopVcDmDailyRun,
  getVcDmUnconfirmedSummary,
  updateInactiveVcDmResult,
  updateNewVcDmResult,
  updateVcDmMigrationProgress,
  upsertVcDmMember,
} from "./vc-dm-store.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const VOICE_SESSION_MS = VC_DM_VALID_VC_MINUTES * 60 * 1000;
const DAILY_LEASE_MS = 5 * 60 * 1000;
const REMINDER_LEASE_MS = 2 * 60 * 1000;
const REMINDER_RETRY_MS = 5 * 60 * 1000;
const PANEL_REFRESH_INTERVAL_MS = 60 * 60 * 1000;
const VALID_TARGET_VC_TYPES = new Set([ChannelType.GuildVoice, ChannelType.GuildStageVoice]);

function makeMemberKey(guildId, userId) {
  return `${guildId}:${userId}`;
}

function getUserIdFromInteraction(interaction) {
  return interaction?.user?.id ?? interaction?.member?.user?.id ?? null;
}

function canManagePanel(interaction) {
  return Boolean(
    interaction?.inGuild?.()
    && (interaction.memberPermissions?.has?.(PermissionFlagsBits.ManageGuild)
      || interaction.memberPermissions?.has?.(PermissionFlagsBits.Administrator)),
  );
}

function replyOptions(interaction, content) {
  return {
    content,
    ...(interaction?.inGuild?.() ? { flags: MessageFlags.Ephemeral } : {}),
  };
}

function createReminderCancelRow(recordId, disabled = false) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(buildReminderCancelCustomId(recordId))
      .setLabel(VC_DM_REMINDER_CANCEL_LABEL)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled),
  )];
}

function getTargetEventForMember(record, recordId) {
  if (record?.newDmRecordId === recordId) return { type: "new", targetEventAt: record.newDmTargetEventAt };
  if (record?.inactiveDmRecordId === recordId) return { type: "inactive", targetEventAt: record.inactiveDmTargetEventAt };
  return null;
}

function isUnknownGuildMemberError(error) {
  const code = Number(error?.code ?? error?.rawError?.code);
  return code === 10007 || /unknown member|unknown user|member not found/i.test(String(error?.message ?? error));
}

function getVcDmMigrationImplementationAt(migration, fallback) {
  const candidate = new Date(migration?.state?.implementationAt ?? fallback);
  return Number.isFinite(candidate.getTime()) ? candidate : new Date(fallback);
}

function getVcDmManualBaselineAt(record, migration) {
  const migrationAt = migration?.implementationAt ?? record?.legacyBaselineAt ?? null;
  const joinedAt = new Date(record?.joinedAt);
  if (
    migration?.version === VC_DM_FEATURE_VERSION
    && record?.migrationVersion === VC_DM_FEATURE_VERSION
    && Number.isFinite(joinedAt.getTime())
    && migrationAt
    && joinedAt.getTime() <= new Date(migrationAt).getTime()
  ) return new Date(migrationAt);
  return undefined;
}

async function fetchGuildMember(guild, userId) {
  try {
    return { member: await guild.members.fetch(userId), error: null };
  } catch (error) {
    return { member: null, error };
  }
}

function channelBelongsToGuild(channel, guild) {
  return channel?.guildId === guild?.id || channel?.guild?.id === guild?.id;
}

function canBotViewChannel(channel, botMember) {
  if (!botMember || typeof channel?.permissionsFor !== "function") return false;
  return Boolean(channel.permissionsFor(botMember)?.has?.(PermissionFlagsBits.ViewChannel));
}

function targetValidationIssue(code, message) {
  return { code, message };
}

async function fetchConfiguredChannel(guild, channelId) {
  // Daily validation must confirm the Discord resource still exists; a
  // stale cache entry after a deletion must not authorize DM processing.
  if (typeof guild?.channels?.fetch === "function") {
    return guild.channels.fetch(channelId).catch(() => null);
  }
  return guild?.channels?.cache?.get(channelId) ?? null;
}

async function fetchGuildChannelsForValidation(guild) {
  if (typeof guild?.channels?.fetch === "function") {
    try {
      const fetched = await guild.channels.fetch();
      if (fetched?.values) return { channels: [...fetched.values()].filter(Boolean), verified: true };
    } catch {
      // A cache-only fallback is useful for transient Discord API failures,
      // but remains marked unverified so the daily run stays fail-closed.
    }
  }
  return {
    channels: [...(guild?.channels?.cache?.values?.() ?? [])].filter(Boolean),
    verified: false,
  };
}

async function fetchBotMemberForValidation(guild) {
  if (guild?.members?.me) return guild.members.me;
  if (typeof guild?.members?.fetchMe === "function") return guild.members.fetchMe().catch(() => null);
  return null;
}

export async function validateVcDmTargetConfiguration(guild, settings) {
  const issues = [];
  const targetChannelIds = Array.isArray(settings?.vcDmTargetChannelIds)
    ? [...new Set(settings.vcDmTargetChannelIds.filter(Boolean))]
    : [];
  const targetCategoryId = settings?.vcDmTargetCategoryId ?? null;
  if (!targetChannelIds.length && !targetCategoryId) return issues;

  const botMember = await fetchBotMemberForValidation(guild);
  if (!botMember) {
    issues.push(targetValidationIssue(
      "target_vc_bot_member_unavailable",
      "The bot member could not be resolved, so target channel visibility could not be verified.",
    ));
  }

  for (const channelId of targetChannelIds) {
    const channel = await fetchConfiguredChannel(guild, channelId);
    if (!channel) {
      issues.push(targetValidationIssue("target_vc_not_found", `Configured target voice channel ${channelId} was not found.`));
      continue;
    }
    if (!channelBelongsToGuild(channel, guild)) {
      issues.push(targetValidationIssue("target_vc_wrong_guild", `Configured target voice channel ${channelId} does not belong to this guild.`));
      continue;
    }
    if (!VALID_TARGET_VC_TYPES.has(channel.type)) {
      issues.push(targetValidationIssue("target_vc_wrong_type", `Configured target channel ${channelId} is not an allowed voice channel.`));
      continue;
    }
    if (botMember && !canBotViewChannel(channel, botMember)) {
      issues.push(targetValidationIssue("target_vc_not_viewable", `The bot cannot view configured target voice channel ${channelId}.`));
      continue;
    }
    if (!isTargetVcChannel(channel, settings, guild)) {
      issues.push(targetValidationIssue("target_vc_excluded", `Configured target voice channel ${channelId} is excluded by the current settings.`));
    }
  }

  if (targetCategoryId) {
    const category = await fetchConfiguredChannel(guild, targetCategoryId);
    if (!category) {
      issues.push(targetValidationIssue("target_category_not_found", `Configured target category ${targetCategoryId} was not found.`));
    } else if (!channelBelongsToGuild(category, guild)) {
      issues.push(targetValidationIssue("target_category_wrong_guild", `Configured target category ${targetCategoryId} does not belong to this guild.`));
    } else if (category.type !== ChannelType.GuildCategory) {
      issues.push(targetValidationIssue("target_category_wrong_type", `Configured target category ${targetCategoryId} is not a category channel.`));
    } else {
      if (botMember && !canBotViewChannel(category, botMember)) {
        issues.push(targetValidationIssue("target_category_not_viewable", `The bot cannot view configured target category ${targetCategoryId}.`));
      }
      const { channels, verified } = await fetchGuildChannelsForValidation(guild);
      if (!verified) {
        issues.push(targetValidationIssue("target_category_children_unverified", `The voice channels under target category ${targetCategoryId} could not be fully verified.`));
      }
      const children = channels.filter((channel) => (
        channelBelongsToGuild(channel, guild)
        && channel.parentId === targetCategoryId
        && VALID_TARGET_VC_TYPES.has(channel.type)
        && isTargetVcChannel(channel, settings, guild)
      ));
      if (!children.length) {
        issues.push(targetValidationIssue("target_category_no_voice", `Target category ${targetCategoryId} has no valid target voice channel.`));
      } else if (botMember) {
        for (const child of children) {
          if (!canBotViewChannel(child, botMember)) {
            issues.push(targetValidationIssue("target_vc_not_viewable", `The bot cannot view target voice channel ${child.id} under category ${targetCategoryId}.`));
          }
        }
      }
    }
  }
  return issues;
}

async function getAllVcDmConfigurationIssues(guild, settings) {
  const issues = [...getVcDmConfigurationIssues(settings)];
  if (settings?.vcDmEnabled !== true) return issues;
  const runtimeIssues = await validateVcDmTargetConfiguration(guild, settings).catch((error) => [
    targetValidationIssue("target_validation_failed", `Target Discord resource validation failed: ${truncateError(error)}`),
  ]);
  return [...issues, ...runtimeIssues];
}

export function createVcDmService({
  client,
  getGuildSettings,
  acquireMongoLease,
  releaseMongoLease,
  sendOperationalLog,
  logger = console,
  now = () => new Date(),
  requestOperationalStatusRefresh = () => {},
  storeOverrides = {},
} = {}) {
  if (!client) throw new Error("VC DM service requires a Discord client.");
  const voiceSessions = new Map();
  const voiceQueues = new Map();
  const reminderTimers = new Map();
  const reminderTimerGuildIds = new Map();
  const dailyRetryTimers = new Map();
  let dailyTimer = null;
  let panelRefreshTimer = null;
  let dailySchedulerStarted = false;
  let shuttingDown = false;
  const enabledGuilds = new Set();
  const activeOperations = new Set();

  function trackOperation(promise) {
    activeOperations.add(promise);
    void promise.finally(() => activeOperations.delete(promise)).catch(() => null);
    return promise;
  }

  const dailyStore = {
    claimInactiveVcDm: storeOverrides.claimInactiveVcDm ?? claimInactiveVcDm,
    claimNewVcDm: storeOverrides.claimNewVcDm ?? claimNewVcDm,
    claimVcDmDailyRun: storeOverrides.claimVcDmDailyRun ?? claimVcDmDailyRun,
    failVcDmDailyRun: storeOverrides.failVcDmDailyRun ?? failVcDmDailyRun,
    finishVcDmDailyRun: storeOverrides.finishVcDmDailyRun ?? finishVcDmDailyRun,
    getVcDmMember: storeOverrides.getVcDmMember ?? getVcDmMember,
    listVcDmMembers: storeOverrides.listVcDmMembers ?? listVcDmMembers,
    markVcDmMemberJoined: storeOverrides.markVcDmMemberJoined ?? markVcDmMemberJoined,
    markVcDmMemberLeft: storeOverrides.markVcDmMemberLeft ?? markVcDmMemberLeft,
    recordVcDmDailyRunResult: storeOverrides.recordVcDmDailyRunResult ?? recordVcDmDailyRunResult,
    recordValidVcParticipation: storeOverrides.recordValidVcParticipation ?? recordValidVcParticipation,
    stopVcDmDailyRun: storeOverrides.stopVcDmDailyRun ?? stopVcDmDailyRun,
    updateInactiveVcDmResult: storeOverrides.updateInactiveVcDmResult ?? updateInactiveVcDmResult,
    updateNewVcDmResult: storeOverrides.updateNewVcDmResult ?? updateNewVcDmResult,
  };

  const panelService = createVcDmPanelService({
    getGuildSettings,
    client,
    sendOperationalLog,
    acquireMongoLease,
    releaseMongoLease,
    getRuntimeConfigurationIssues: validateVcDmTargetConfiguration,
    storeOverrides,
    logger,
    now,
  });

  function queueMember(guildId, userId, task) {
    const key = makeMemberKey(guildId, userId);
    const previous = voiceQueues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(task);
    voiceQueues.set(key, next);
    return next.finally(() => {
      if (voiceQueues.get(key) === next) voiceQueues.delete(key);
    });
  }

  function clearVoiceSession(guildId, userId) {
    const key = makeMemberKey(guildId, userId);
    const session = voiceSessions.get(key);
    if (!session) return;
    clearTimeout(session.timer);
    voiceSessions.delete(key);
  }

  function clearDailyRetry(guildId) {
    const timer = dailyRetryTimers.get(guildId);
    if (timer) clearTimeout(timer);
    dailyRetryTimers.delete(guildId);
  }

  function clearReminderTimersForGuild(guildId) {
    for (const [recordId, timer] of reminderTimers.entries()) {
      if (reminderTimerGuildIds.get(recordId) !== guildId) continue;
      clearTimeout(timer);
      reminderTimers.delete(recordId);
      reminderTimerGuildIds.delete(recordId);
    }
  }

  async function requestDailyStatusRefresh(guild, status, reason = status) {
    try {
      await requestOperationalStatusRefresh?.(guild.id, `vc-dm-daily:${status}:${reason}`);
    } catch (error) {
      logger.warn?.(`VC DM daily operational status refresh request failed guild=${guild.id} status=${status}: ${error.message}`);
    }
  }

  async function recordDailyResultAndRefresh(guild, { jstDate, status, result = {}, error = null, reason = status }) {
    let saved = null;
    try {
      saved = await dailyStore.recordVcDmDailyRunResult({
        guildId: guild.id,
        jstDate,
        status,
        result,
        error,
        now: now(),
      });
    } catch (saveError) {
      logger.error?.(`VC DM daily result save failed guild=${guild.id} status=${status}: ${saveError.message}`);
    } finally {
      await requestDailyStatusRefresh(guild, status, reason);
    }
    return saved;
  }

  async function stopDailyRunAndRefresh(guild, { jstDate, reason, result = {} }) {
    let stopped = null;
    try {
      stopped = await dailyStore.stopVcDmDailyRun({
        guildId: guild.id,
        jstDate,
        reason,
        result,
        now: now(),
      });
    } catch (error) {
      logger.error?.(`VC DM daily stop result save failed guild=${guild.id} reason=${reason}: ${error.message}`);
    } finally {
      await requestDailyStatusRefresh(guild, "stopped", reason);
    }
    return stopped;
  }

  function scheduleDailyRetry(guild, jstDate = getJstCalendarDate(now())) {
    if (!guild?.id || !jstDate || shuttingDown || dailyRetryTimers.has(guild.id)) return;
    const timer = setTimeout(async () => {
      dailyRetryTimers.delete(guild.id);
      if (getJstCalendarDate(now()) !== jstDate) return;
      const outcome = await runDailyForGuild(guild, { reason: "retry" }).catch((error) => {
        logger.error?.(`VC DM daily retry failed guild=${guild.id}: ${error.message}`);
        return { status: "failed" };
      });
      if (outcome?.status === "failed") scheduleDailyRetry(guild, jstDate);
    }, REMINDER_RETRY_MS);
    dailyRetryTimers.set(guild.id, timer);
  }

  async function resolveVoiceChannel(guild, channelId, fallback = null) {
    if (!channelId) return null;
    if (fallback?.id === channelId) return fallback;
    return guild.channels.cache?.get(channelId)
      ?? await guild.channels.fetch(channelId).catch(() => null);
  }

  async function completeVoiceSessionInternal(sessionKey) {
    const session = voiceSessions.get(sessionKey);
    if (!session) return;
    let guild;
    try {
      guild = client.guilds.cache.get(session.guildId)
        ?? await client.guilds.fetch(session.guildId);
    } catch (error) {
      logger.error?.(`VC DM guild resolution failed guild=${session.guildId}: ${error.message}`);
      const current = voiceSessions.get(sessionKey);
      if (current && !shuttingDown) current.timer = setTimeout(() => { void completeVoiceSession(sessionKey).catch((retryError) => logger.error?.(retryError)); }, REMINDER_RETRY_MS);
      return;
    }
    if (!guild) {
      voiceSessions.delete(sessionKey);
      return;
    }
    let settings;
    let member;
    let channel;
    try {
      settings = await getGuildSettings(guild.id);
      member = await guild.members.fetch(session.userId);
      channel = await resolveVoiceChannel(guild, member?.voice?.channelId, member?.voice?.channel);
    } catch (error) {
      if (isUnknownGuildMemberError(error)) {
        clearVoiceSession(guild.id, session.userId);
        await dailyStore.markVcDmMemberLeft({ guildId: guild.id, userId: session.userId, leftAt: now() }).catch(() => null);
        return;
      }
      logger.error?.(`VC DM valid participation precheck failed guild=${guild.id} user=${session.userId}: ${error.message}`);
      const current = voiceSessions.get(sessionKey);
      if (current && !shuttingDown) current.timer = setTimeout(() => { void completeVoiceSession(sessionKey).catch((retryError) => logger.error?.(retryError)); }, REMINDER_RETRY_MS);
      return;
    }
    if (
      settings?.vcDmEnabled !== true
      || !member
      || member.user?.bot
      || !channel
      || !isTargetVcChannel(channel, settings, guild)
    ) {
      clearVoiceSession(guild.id, session.userId);
      return;
    }
    const validAt = new Date(session.startedAt.getTime() + VOICE_SESSION_MS);
    try {
      const saved = await dailyStore.recordValidVcParticipation({
        guildId: guild.id,
        userId: session.userId,
        validAt,
        joinedAt: member.joinedAt ?? session.startedAt,
      });
      if (!saved) throw new Error("valid VC participation state update returned no document");
      clearVoiceSession(guild.id, session.userId);
      if (saved) {
        await sendOperationalLog?.({
          guild,
          settings,
          fallbackChannel: null,
          content: `VC DM: 有効VC参加成立 guildId=${guild.id} userId=${session.userId} at=${validAt.toISOString()} channelId=${channel.id}`,
        }).catch?.(() => null);
        await panelService.requestUpdate(guild, "valid-vc-participation").catch((error) => logger.warn?.(`VC DM panel update after valid participation failed guild=${guild.id}: ${error.message}`));
      }
    } catch (error) {
      logger.error?.(`VC DM valid participation persistence failed guild=${guild.id} user=${session.userId}: ${error.message}`);
      // Keep the timer/session alive for a retry only while the member is still
      // in the target VC. The persisted record is the idempotency boundary.
      const current = voiceSessions.get(sessionKey);
      if (current) {
        current.timer = setTimeout(() => {
          void completeVoiceSession(sessionKey).catch((retryError) => logger.error?.(retryError));
        }, REMINDER_RETRY_MS);
      }
    }
  }

  function completeVoiceSession(sessionKey) {
    return trackOperation(completeVoiceSessionInternal(sessionKey));
  }

  function startVoiceSession(guild, member, channel) {
    const key = makeMemberKey(guild.id, member.id);
    if (voiceSessions.has(key)) {
      voiceSessions.get(key).channelId = channel.id;
      return;
    }
    const startedAt = new Date(now());
    const session = { guildId: guild.id, userId: member.id, channelId: channel.id, startedAt, timer: null };
    session.timer = setTimeout(() => {
      void completeVoiceSession(key).catch((error) => logger.error?.(error));
    }, VOICE_SESSION_MS);
    voiceSessions.set(key, session);
  }

  async function handleVoiceState(oldState, newState) {
    if (shuttingDown) return;
    const guild = newState?.guild ?? oldState?.guild;
    const member = newState?.member ?? oldState?.member;
    if (!guild || !member || member.user?.bot) return;
    if (oldState?.channelId === newState?.channelId) return;
    const settings = await getGuildSettings(guild.id);
    const key = makeMemberKey(guild.id, member.id);
    if (settings?.vcDmEnabled !== true) {
      clearVoiceSession(guild.id, member.id);
      return;
    }
    const existing = await dailyStore.getVcDmMember(guild.id, member.id).catch(() => null);
    if (!existing) {
      await dailyStore.markVcDmMemberJoined({ guildId: guild.id, userId: member.id, joinedAt: member.joinedAt ?? now(), now: now() });
    }
    await queueMember(guild.id, member.id, async () => {
      const freshSettings = await getGuildSettings(guild.id);
      const oldChannel = await resolveVoiceChannel(guild, oldState?.channelId, oldState?.channel);
      const newChannel = await resolveVoiceChannel(guild, newState?.channelId, newState?.channel);
      const wasTarget = isTargetVcChannel(oldChannel, freshSettings, guild);
      const isTarget = isTargetVcChannel(newChannel, freshSettings, guild);
      if (!isTarget) {
        clearVoiceSession(guild.id, member.id);
        if (wasTarget || oldState?.channelId) await panelService.requestUpdate(guild, "voice-leave");
        return;
      }
      startVoiceSession(guild, member, newChannel);
    });
    void key;
  }

  async function handleMemberAdd(member) {
    if (shuttingDown || !member?.guild || member.user?.bot) return;
    const settings = await getGuildSettings(member.guild.id);
    if (settings?.vcDmEnabled !== true) return;
    await dailyStore.markVcDmMemberJoined({
      guildId: member.guild.id,
      userId: member.id,
      joinedAt: member.joinedAt ?? now(),
      now: now(),
    });
    await sendOperationalLog?.({
      guild: member.guild,
      settings,
      fallbackChannel: null,
      content: `VC DM: tracking member joined guildId=${member.guild.id} userId=${member.id}`,
    }).catch?.(() => null);
    await panelService.requestUpdate(member.guild, "member-add");
  }

  async function handleMemberRemove(member) {
    if (shuttingDown || !member?.guild || member.user?.bot) return;
    clearVoiceSession(member.guild.id, member.id);
    await dailyStore.markVcDmMemberLeft({ guildId: member.guild.id, userId: member.id, leftAt: now() }).catch(() => null);
    const settings = await getGuildSettings(member.guild.id).catch(() => null);
    await sendOperationalLog?.({
      guild: member.guild,
      settings,
      fallbackChannel: null,
      content: `VC DM: tracking member left guildId=${member.guild.id} userId=${member.id}`,
    }).catch?.(() => null);
    if (settings?.vcDmEnabled === true) await panelService.requestUpdate(member.guild, "member-remove");
  }

  function restoreVoiceSessions(guild, settings) {
    if (settings?.vcDmEnabled !== true) return 0;
    let restored = 0;
    for (const channel of guild.channels.cache.values()) {
      if (!isTargetVcChannel(channel, settings, guild)) continue;
      for (const member of channel.members?.values?.() ?? []) {
        if (member.user?.bot) continue;
        const key = makeMemberKey(guild.id, member.id);
        const existing = voiceSessions.get(key);
        if (existing && existing.channelId !== channel.id) clearVoiceSession(guild.id, member.id);
        startVoiceSession(guild, member, channel);
        restored += 1;
      }
    }
    return restored;
  }

  async function reconcileGuildMembers(guild) {
    const fetched = await guild.members.fetch();
    const members = [...fetched.values()];
    const records = await listVcDmMembers(guild.id);
    const recordsByUserId = new Map(records.map((record) => [record.userId, record]));
    const activeUserIds = new Set();
    let joined = 0;
    let left = 0;
    for (const member of members) {
      if (member.user?.bot) continue;
      activeUserIds.add(member.id);
      const existing = recordsByUserId.get(member.id);
      if (existing?.isMember) continue;
      try {
        await markVcDmMemberJoined({ guildId: guild.id, userId: member.id, joinedAt: member.joinedAt ?? now(), now: now() });
        joined += 1;
      } catch (error) {
        logger.warn?.(`VC DM startup member reconciliation join failed guild=${guild.id} user=${member.id}: ${error.message}`);
      }
    }
    for (const record of records) {
      if (!record.isMember || activeUserIds.has(record.userId)) continue;
      try {
        await markVcDmMemberLeft({ guildId: guild.id, userId: record.userId, leftAt: now() });
        left += 1;
      } catch (error) {
        logger.warn?.(`VC DM startup member reconciliation leave failed guild=${guild.id} user=${record.userId}: ${error.message}`);
      }
    }
    return { joined, left };
  }

  async function migrateGuild(guild, settings = null) {
    const currentSettings = settings ?? await getGuildSettings(guild.id);
    if (currentSettings?.vcDmEnabled !== true) return null;
    const migrationLease = acquireMongoLease
      ? await acquireMongoLease(`vc-dm-migration:${guild.id}`, { leaseMs: DAILY_LEASE_MS })
      : { lockKey: `local:${guild.id}` };
    if (!migrationLease) return getVcDmMigration(guild.id);
    try {
      const requestedImplementationAt = new Date(now());
      const repaired = await repairVcDmParticipationRecords({ guildId: guild.id });
      if (repaired?.modifiedCount) {
        await sendOperationalLog?.({
          guild,
          settings: currentSettings,
          fallbackChannel: null,
          content: `VC DM: repaired legacy participation records guildId=${guild.id} count=${repaired.modifiedCount}`,
        }).catch?.(() => null);
      }
      const migration = await beginVcDmMigration({ guildId: guild.id, implementationAt: requestedImplementationAt, version: VC_DM_FEATURE_VERSION });
      if (!migration.started) return migration.state;
      const implementationAt = getVcDmMigrationImplementationAt(migration, requestedImplementationAt);
      const fetched = await guild.members.fetch();
      const records = new Map((await listVcDmMembers(guild.id)).map((record) => [record.userId, record]));
      const members = [...fetched.values()].sort((left, right) => String(left.id).localeCompare(String(right.id)));
      let processedCount = Number(migration.state?.processedCount ?? 0);
      const resumeAfter = migration.state?.lastUserId ? String(migration.state.lastUserId) : null;
      for (const member of members) {
        if (resumeAfter && String(member.id).localeCompare(resumeAfter) <= 0) continue;
        if (member.user?.bot) continue;
        const existing = records.get(member.id);
        const joinedAt = member.joinedAt ?? existing?.joinedAt ?? implementationAt;
        const ageMs = implementationAt.getTime() - new Date(joinedAt).getTime();
        const isLegacyAge = Number.isFinite(ageMs) && ageMs >= VC_DM_NEW_MEMBER_DAYS * DAY_MS;
        const hasValidParticipation = hasValidVcParticipation(existing);
        const patch = {
          isMember: true,
          leftAt: null,
          trackingStartedAt: existing?.trackingStartedAt ?? implementationAt,
          migrationVersion: VC_DM_FEATURE_VERSION,
        };
        if (isLegacyAge && !hasValidParticipation && !existing?.manualValidVcConfirmedAt) {
          if (!existing || !["delivered", "dm_unavailable", "unconfirmed", "skipped_manual"].includes(existing.newDmStatus)) {
            patch.newDmStatus = "skipped_legacy";
            patch.newDmLastResult = "legacy_baseline";
          }
          patch.legacyBaselineAt = existing?.legacyBaselineAt ?? implementationAt;
          patch.inactiveBaselineAt = existing?.inactiveBaselineAt ?? implementationAt;
          patch.inactiveCycleKey = existing?.inactiveCycleKey ?? `legacy:${implementationAt.toISOString()}`;
          patch.inactiveDmStatus = existing?.inactiveDmStatus ?? "pending";
        } else if (!existing) {
          patch.newDmStatus = "pending";
          patch.inactiveDmStatus = "pending";
        } else if (hasValidParticipation) {
          const lastValidAt = [existing.lastValidVcAt, existing.firstValidVcAt]
            .map((value) => new Date(value))
            .find((value) => Number.isFinite(value.getTime()));
          patch.inactiveCycleKey = existing.inactiveCycleKey ?? (lastValidAt ? `vc:${lastValidAt.toISOString()}` : undefined);
          patch.inactiveDmStatus = existing.inactiveDmStatus ?? "pending";
        } else if (existing.manualValidVcConfirmedAt) {
          patch.legacyBaselineAt = existing.legacyBaselineAt ?? implementationAt;
          patch.inactiveBaselineAt = existing.inactiveBaselineAt ?? implementationAt;
          patch.inactiveCycleKey = existing.inactiveCycleKey ?? `legacy:${implementationAt.toISOString()}`;
          patch.inactiveDmStatus = existing.inactiveDmStatus ?? "pending";
        }
        if (!patch.newDmStatus && !existing?.newDmStatus) patch.newDmStatus = "pending";
        if (!patch.inactiveDmStatus && !existing?.inactiveDmStatus) patch.inactiveDmStatus = "pending";
        const saved = await upsertVcDmMember({ guildId: guild.id, userId: member.id, joinedAt, now: implementationAt, ...patch });
        records.set(member.id, saved);
        processedCount += 1;
        await updateVcDmMigrationProgress({ guildId: guild.id, processedCount, lastUserId: member.id });
      }
      const completed = await finishVcDmMigration({ guildId: guild.id, version: VC_DM_FEATURE_VERSION, completedAt: now() });
      await sendOperationalLog?.({
        guild,
        settings: currentSettings,
        fallbackChannel: null,
        content: `VC DM: 既存メンバー移行完了 guildId=${guild.id} processed=${processedCount} version=${VC_DM_FEATURE_VERSION}`,
      }).catch?.(() => null);
      return completed;
    } catch (error) {
      await failVcDmMigration({ guildId: guild.id, error }).catch(() => null);
      await sendOperationalLog?.({ guild, settings: currentSettings, fallbackChannel: null, content: `VC DM: migration failed guildId=${guild.id} error=${truncateError(error)}` }).catch?.(() => null);
      throw error;
    } finally {
      if (acquireMongoLease && migrationLease) await releaseMongoLease?.(migrationLease).catch?.(() => null);
    }
  }

  async function completeDueVoiceSessions(guild) {
    const due = [...voiceSessions.values()].filter((session) => session.guildId === guild.id && session.startedAt.getTime() + VOICE_SESSION_MS <= now().getTime());
    for (const session of due) await completeVoiceSession(makeMemberKey(session.guildId, session.userId));
  }

  async function sendNewMemberDm(guild, settings, record, eventAt) {
    const recordId = createVcDmRecordId("n");
    const claimed = await dailyStore.claimNewVcDm({ guildId: guild.id, userId: record.userId, targetEventAt: eventAt, recordId, now: now() });
    if (!claimed) return { status: "skipped", reason: "already-claimed" };
    const { member, error: memberFetchError } = await fetchGuildMember(guild, record.userId);
    if (memberFetchError && !isUnknownGuildMemberError(memberFetchError)) {
      const status = "failed";
      await dailyStore.updateNewVcDmResult({ guildId: guild.id, userId: record.userId, recordId, status, result: status, lastError: truncateError(memberFetchError), now: now() }).catch((saveError) => logger.error?.(`VC DM result save failed guild=${guild.id} user=${record.userId}: ${saveError.message}`));
      return { status, error: memberFetchError };
    }
    if (!member || member.user?.bot) {
      await dailyStore.updateNewVcDmResult({ guildId: guild.id, userId: record.userId, recordId, status: "skipped_left", result: "skipped_left", now: now() }).catch(() => null);
      return { status: "skipped_left" };
    }
    let sent = false;
    try {
      await member.send({
        content: buildNewMemberDmContent(eventAt),
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(buildDmButtonCustomId(recordId)).setLabel(VC_DM_BUTTON_LABEL).setStyle(ButtonStyle.Primary),
        )],
        allowedMentions: { parse: [] },
      });
      sent = true;
      const saved = await dailyStore.updateNewVcDmResult({ guildId: guild.id, userId: record.userId, recordId, status: "delivered", result: "delivered", now: now() });
      if (!saved) throw new Error("new-member DM state update matched no processing record");
      return { status: "delivered" };
    } catch (error) {
      if (sent) {
        await markNewVcDmUncertain({ guildId: guild.id, userId: record.userId, recordId, lastError: `DM sent but save was uncertain: ${truncateError(error)}`, now: now() }).catch((saveError) => logger.error?.(`VC DM uncertain result save failed guild=${guild.id} user=${record.userId}: ${saveError.message}`));
        return { status: "unconfirmed", error };
      }
      const status = isDmUnavailableError(error) ? "dm_unavailable" : "failed";
      await dailyStore.updateNewVcDmResult({ guildId: guild.id, userId: record.userId, recordId, status, result: status, lastError: truncateError(error), now: now() }).catch((saveError) => logger.error?.(`VC DM result save failed guild=${guild.id} user=${record.userId}: ${saveError.message}`));
      return { status, error };
    }
  }

  async function sendInactiveDm(guild, settings, record, eventAt, cycleKey) {
    const recordId = createVcDmRecordId("i");
    const claimed = await dailyStore.claimInactiveVcDm({ guildId: guild.id, userId: record.userId, cycleKey, targetEventAt: eventAt, recordId, now: now() });
    if (!claimed) return { status: "skipped", reason: "already-claimed" };
    const { member, error: memberFetchError } = await fetchGuildMember(guild, record.userId);
    if (memberFetchError && !isUnknownGuildMemberError(memberFetchError)) {
      const status = "failed";
      await dailyStore.updateInactiveVcDmResult({ guildId: guild.id, userId: record.userId, recordId, cycleKey, status, result: status, lastError: truncateError(memberFetchError), now: now() }).catch((saveError) => logger.error?.(`VC DM result save failed guild=${guild.id} user=${record.userId}: ${saveError.message}`));
      return { status, error: memberFetchError };
    }
    if (!member || member.user?.bot) {
      await dailyStore.updateInactiveVcDmResult({ guildId: guild.id, userId: record.userId, recordId, cycleKey, status: "skipped_left", result: "skipped_left", now: now() }).catch(() => null);
      return { status: "skipped_left" };
    }
    let sent = false;
    try {
      await member.send({
        content: buildInactiveDmContent(eventAt),
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(buildDmButtonCustomId(recordId)).setLabel(VC_DM_BUTTON_LABEL).setStyle(ButtonStyle.Primary),
        )],
        allowedMentions: { parse: [] },
      });
      sent = true;
      const saved = await dailyStore.updateInactiveVcDmResult({ guildId: guild.id, userId: record.userId, recordId, cycleKey, status: "delivered", result: "delivered", now: now() });
      if (!saved) throw new Error("inactive DM state update matched no processing record");
      return { status: "delivered" };
    } catch (error) {
      if (sent) {
        await markInactiveVcDmUncertain({ guildId: guild.id, userId: record.userId, recordId, cycleKey, lastError: `DM sent but save was uncertain: ${truncateError(error)}`, now: now() }).catch((saveError) => logger.error?.(`VC DM uncertain result save failed guild=${guild.id} user=${record.userId}: ${saveError.message}`));
        return { status: "unconfirmed", error };
      }
      const status = isDmUnavailableError(error) ? "dm_unavailable" : "failed";
      await dailyStore.updateInactiveVcDmResult({ guildId: guild.id, userId: record.userId, recordId, cycleKey, status, result: status, lastError: truncateError(error), now: now() }).catch((saveError) => logger.error?.(`VC DM result save failed guild=${guild.id} user=${record.userId}: ${saveError.message}`));
      return { status, error };
    }
  }

  async function runDailyForGuildInternal(guild, { reason = "daily", force = false } = {}) {
    if (shuttingDown || !guild?.id) return { status: "stopped" };
    const jstDate = getJstCalendarDate(now());
    if (!jstDate) return { status: "failed", reason: "invalid-date" };
    let settings;
    let lease = null;
    try {
      // Serialize the validation and result write with the daily run lease.
      lease = acquireMongoLease
        ? await acquireMongoLease(`vc-dm-daily:${guild.id}:${jstDate}`, { leaseMs: DAILY_LEASE_MS })
        : { lockKey: `local:${guild.id}:${jstDate}` };
      if (!lease) return { status: "busy" };
      try {
        settings = await getGuildSettings(guild.id);
      } catch (error) {
        logger.error?.(`VC DM daily settings read failed guild=${guild.id}: ${error.message}`);
        await recordDailyResultAndRefresh(guild, {
          jstDate,
          status: "failed",
          result: { stopped: false, stopReason: "settings_read_failed" },
          error,
          reason: "settings-read-failed",
        });
        scheduleDailyRetry(guild, jstDate);
        return { status: "failed", error };
      }
      if (settings?.vcDmEnabled !== true) {
        clearDailyRetry(guild.id);
        return { status: "disabled" };
      }
      const run = await dailyStore.claimVcDmDailyRun({
        guildId: guild.id,
        jstDate,
        now: now(),
        takeover: Boolean(acquireMongoLease && lease),
        retryFailed: reason === "retry",
      });
      if (!run || run.status !== "processing") {
        if (run?.status === "completed") clearDailyRetry(guild.id);
        return { status: run?.status ?? "not-claimed" };
      }
      // Settings may have changed between the initial read and lease
      // acquisition. Re-read before target validation and before any send.
      settings = await getGuildSettings(guild.id);
      if (settings?.vcDmEnabled !== true) {
        const stoppedResult = {
          stopped: true,
          stopReason: "feature_disabled_before_daily_validation",
          settingsChanged: true,
          delivered: 0,
          failed: 0,
        };
        await stopDailyRunAndRefresh(guild, { jstDate, reason: stoppedResult.stopReason, result: stoppedResult });
        await sendOperationalLog?.({
          guild,
          settings,
          fallbackChannel: null,
          content: `VC DM: daily run stopped guildId=${guild.id} reason=${stoppedResult.stopReason} settingsChanged=true`,
        }).catch?.(() => null);
        return { status: "stopped", reason: stoppedResult.stopReason, result: stoppedResult };
      }
      const configurationIssues = await getAllVcDmConfigurationIssues(guild, settings);
      if (configurationIssues.length > 0) {
        clearDailyRetry(guild.id);
        const issueReason = configurationIssues.map((issue) => issue.code).join(",");
        const detail = configurationIssues.map((issue) => issue.message).join(" / ");
        const stopReason = configurationIssues.some((issue) => String(issue.code).startsWith("target_"))
          ? "target_validation_failed"
          : "configuration_invalid";
        const stoppedResult = {
          stopped: true,
          stopReason,
          configurationIssues: configurationIssues.map((issue) => issue.code),
          delivered: 0,
          failed: 0,
          skipped_config: 1,
        };
        await stopDailyRunAndRefresh(guild, { jstDate, reason: stopReason, result: stoppedResult });
        await sendOperationalLog?.({
          guild,
          settings,
          fallbackChannel: null,
          content: `VC DM: skipped_config guildId=${guild.id} reason=${issueReason} stopReason=${stopReason} detail=${detail}`,
        }).catch?.(() => null);
        await panelService.ensurePanel(guild, "daily-config-error").catch((error) => logger.warn?.(`VC DM configuration panel update failed guild=${guild.id}: ${error.message}`));
        return { status: "skipped_config", reason: issueReason, stopReason, issues: configurationIssues };
      }
      await completeDueVoiceSessions(guild);
      const eventTime = settings.kokuchiEventTimeConfigured === false
        ? null
        : normalizeVcDmEventTime(settings.kokuchiEventTime);
      const eventAt = eventTime ? getNextVcDmEventAt(now(), eventTime) : null;
      if (!eventAt) {
        const eventError = "kokuchiEventTime is missing or invalid";
        const stoppedResult = { stopped: true, stopReason: "event_time_invalid", skipped_config: 1, delivered: 0, failed: 0 };
        await stopDailyRunAndRefresh(guild, { jstDate, reason: "event_time_invalid", result: stoppedResult });
        await panelService.ensurePanel(guild, "daily-config-error");
        await sendOperationalLog?.({ guild, settings, fallbackChannel: null, content: `VC DM: skipped_config guildId=${guild.id} reason=event_time stopReason=event_time_invalid` }).catch?.(() => null);
        return { status: "skipped_config", reason: "event_time", stopReason: "event_time_invalid" };
      }
      const records = await dailyStore.listVcDmMembers(guild.id, { isMember: true });
      const result = { delivered: 0, dm_unavailable: 0, failed: 0, unconfirmed: 0, skipped: 0, skipped_config: 0, skipped_left: 0 };
      let interruption = null;
      const getSettingsBeforeClaim = async () => {
        try {
          const latestSettingsForClaim = await getGuildSettings(guild.id);
          if (latestSettingsForClaim?.vcDmEnabled !== true) {
            return { allowed: false, settings: latestSettingsForClaim, reason: "feature_disabled_during_daily" };
          }
          return { allowed: true, settings: latestSettingsForClaim };
        } catch (error) {
          return { allowed: false, reason: "settings_unavailable_before_claim", error };
        }
      };
      for (const record of records) {
        if (shuttingDown) {
          interruption = { reason: "shutdown", message: "Daily VC DM run stopped during graceful shutdown" };
          break;
        }
        // Observe a disable before doing any more per-member work. The due
        // branches below repeat this read immediately before their atomic
        // claim, closing the window opened by member fetching.
        const currentSettings = await getSettingsBeforeClaim();
        if (!currentSettings.allowed) {
          interruption = currentSettings;
          break;
        }
        const { member, error: memberFetchError } = await fetchGuildMember(guild, record.userId);
        if (memberFetchError && !isUnknownGuildMemberError(memberFetchError)) throw memberFetchError;
        if (!member || member.user?.bot) {
          if (record.isMember) await dailyStore.markVcDmMemberLeft({ guildId: guild.id, userId: record.userId, leftAt: now() }).catch(() => null);
          result.skipped_left += 1;
          continue;
        }
        if (
          !hasValidVcParticipation(record)
          && !record.manualValidVcConfirmedAt
          && canAttemptDmStatus(record.newDmStatus)
          && (getNewMemberDmDueAt(record.joinedAt)?.getTime() ?? Number.POSITIVE_INFINITY) <= now().getTime()
        ) {
          const claimSettings = await getSettingsBeforeClaim();
          if (!claimSettings.allowed) {
            interruption = claimSettings;
            break;
          }
          const outcome = await sendNewMemberDm(guild, claimSettings.settings, record, eventAt);
          result[outcome.status] = (result[outcome.status] ?? 0) + 1;
          continue;
        }
        const reference = getInactivityReference(record);
        const inactiveDue = getInactiveDmDueAt(reference);
        const cycleKey = record.inactiveCycleKey ?? getCycleKey(reference, record.legacyBaselineAt ? "legacy" : "vc");
        if (
          reference
          && inactiveDue
          && inactiveDue.getTime() <= now().getTime()
          && cycleKey
          && canAttemptDmStatus(record.inactiveDmStatus)
          && (record.inactiveDmCycleKey !== cycleKey || record.inactiveDmStatus === "failed")
        ) {
          const claimSettings = await getSettingsBeforeClaim();
          if (!claimSettings.allowed) {
            interruption = claimSettings;
            break;
          }
          const outcome = await sendInactiveDm(guild, claimSettings.settings, record, eventAt, cycleKey);
          result[outcome.status] = (result[outcome.status] ?? 0) + 1;
        }
      }
      if (interruption) {
        const stoppedResult = {
          ...result,
          stopped: true,
          stopReason: interruption.reason,
          settingsChanged: interruption.reason === "feature_disabled_during_daily",
        };
        await stopDailyRunAndRefresh(guild, { jstDate, reason: interruption.reason, result: stoppedResult });
        await sendOperationalLog?.({
          guild,
          settings,
          fallbackChannel: null,
          content: `VC DM: daily run stopped guildId=${guild.id} reason=${interruption.reason} settingsChanged=${Boolean(stoppedResult.settingsChanged)} delivered=${result.delivered} failed=${result.failed}`,
        }).catch?.(() => null);
        return { status: "stopped", reason: interruption.reason, result: stoppedResult, forced: force };
      }
      await dailyStore.finishVcDmDailyRun({ guildId: guild.id, jstDate, result, now: now() });
      await requestDailyStatusRefresh(guild, "completed", reason);
      clearDailyRetry(guild.id);
      if (result.failed > 0) scheduleDailyRetry(guild, jstDate);
      await panelService.ensurePanel(guild, "daily-17:00");
      await sendOperationalLog?.({
        guild,
        settings,
        fallbackChannel: null,
        content: `VC DM: daily run ${jstDate} reason=${reason} delivered=${result.delivered} dm_unavailable=${result.dm_unavailable} failed=${result.failed} unconfirmed=${result.unconfirmed} skipped_left=${result.skipped_left}`,
      }).catch?.(() => null);
      return { status: "completed", result, forced: force };
    } catch (error) {
      const failed = await dailyStore.failVcDmDailyRun({ guildId: guild.id, jstDate, error, now: now() }).catch(() => null);
      if (failed) await requestDailyStatusRefresh(guild, "failed", "exception");
      else await recordDailyResultAndRefresh(guild, {
        jstDate,
        status: "failed",
        result: { stopped: false, stopReason: "exception" },
        error,
        reason: "exception",
      });
      await sendOperationalLog?.({ guild, settings, fallbackChannel: null, content: `VC DM: daily run failed guildId=${guild.id} error=${truncateError(error)}` }).catch?.(() => null);
      scheduleDailyRetry(guild, jstDate);
      return { status: "failed", error };
    } finally {
      if (acquireMongoLease && lease) await releaseMongoLease?.(lease).catch?.(() => null);
    }
  }

  function runDailyForGuild(guild, options = {}) {
    return trackOperation(runDailyForGuildInternal(guild, options));
  }

  function scheduleReminder(reminder) {
    if (!reminder?.recordId || shuttingDown) return;
    const current = reminderTimers.get(reminder.recordId);
    if (current) clearTimeout(current);
    reminderTimerGuildIds.delete(reminder.recordId);
    const target = new Date(reminder.targetEventAt);
    if (!Number.isFinite(target.getTime()) || target.getTime() <= now().getTime()) return;
    const remindAt = new Date(reminder.remindAt).getTime();
    const leaseUntil = new Date(reminder.leaseUntil).getTime();
    const triggerAt = reminder.status === "processing"
      && Number.isFinite(leaseUntil)
      && leaseUntil > now().getTime()
      ? leaseUntil
      : remindAt;
    const delay = Math.max(1000, triggerAt - now().getTime());
    const timer = setTimeout(() => {
      reminderTimers.delete(reminder.recordId);
      reminderTimerGuildIds.delete(reminder.recordId);
      void processReminder(reminder.recordId, reminder).catch((error) => logger.error?.(`VC DM reminder processing failed: ${error.message}`));
    }, delay);
    reminderTimers.set(reminder.recordId, timer);
    reminderTimerGuildIds.set(reminder.recordId, reminder.guildId);
  }

  async function editReminderConfirmation(reminder, content, disabled, interaction = null) {
    const components = disabled ? createReminderCancelRow(reminder.recordId, true) : createReminderCancelRow(reminder.recordId, false);
    if (interaction?.update) {
      await interaction.update({ content, components });
      return;
    }
    if (!reminder.channelId || !reminder.confirmationMessageId) return;
    const channel = client.channels.fetch(reminder.channelId).catch(() => null);
    const resolved = await channel;
    const message = await resolved?.messages?.fetch(reminder.confirmationMessageId).catch(() => null);
    if (message) await message.edit({ content, components }).catch((error) => logger.warn?.(`VC DM reminder confirmation edit failed: ${error.message}`));
  }

  async function logReminderResult(reminder, status) {
    const guild = client.guilds.cache.get(reminder.guildId);
    if (!guild) return;
    await sendOperationalLog?.({
      guild,
      settings: await getGuildSettings(reminder.guildId).catch(() => null),
      fallbackChannel: null,
      content: `VC DM: reminder result recordId=${reminder.recordId} status=${status}`,
    }).catch?.(() => null);
  }

  async function logReminderLifecycle(guildId, content) {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return;
    await sendOperationalLog?.({
      guild,
      settings: await getGuildSettings(guildId).catch(() => null),
      fallbackChannel: null,
      content,
    }).catch?.(() => null);
  }

  async function scheduleFailedReminderRetry(reminder, error) {
    const retryAt = new Date(now().getTime() + REMINDER_RETRY_MS);
    let retry = reminder;
    try {
      retry = await getVcDmReminderByRecordId(reminder.recordId) ?? reminder;
    } catch (readError) {
      logger.warn?.(`VC DM reminder retry state read failed record=${reminder.recordId}: ${readError.message}`);
    }
    const saved = await rescheduleVcDmReminder({
      recordId: reminder.recordId,
      remindAt: retryAt,
      lastError: truncateError(error),
    }).catch((saveError) => {
      logger.error?.(`VC DM reminder retry schedule save failed record=${reminder.recordId}: ${saveError.message}`);
      return null;
    });
    // Keep a best-effort in-memory retry if the result read or save itself
    // was unavailable. The next claim will re-check MongoDB before sending.
    scheduleReminder({ ...(saved ?? retry), remindAt: retryAt, status: "failed" });
  }

  async function processReminderInternal(recordId, scheduledReminder = null) {
    let existing;
    try {
      existing = await getVcDmReminderByRecordId(recordId);
    } catch (error) {
      logger.error?.(`VC DM reminder state read failed record=${recordId}: ${error.message}`);
      if (scheduledReminder) await scheduleFailedReminderRetry(scheduledReminder, error);
      if (scheduledReminder) await logReminderResult(scheduledReminder, "failed");
      return { status: "failed", error };
    }
    if (!existing) return { status: "skipped" };
    let settings;
    try {
      settings = await getGuildSettings(existing.guildId);
    } catch (error) {
      await scheduleFailedReminderRetry(existing, error);
      await logReminderResult(existing, "failed");
      return { status: "failed", error };
    }
    // Disabling VC DM pauses durable reminders. They remain pending so that
    // enabling the feature can restore them without losing the registration.
    if (settings?.vcDmEnabled !== true) return { status: "disabled" };
    if (existing && ["pending", "failed"].includes(existing.status) && new Date(existing.targetEventAt).getTime() <= now().getTime()) {
      const canceled = await cancelVcDmReminder({ recordId, userId: existing.userId, now: now() }).catch(() => null);
      if (canceled) await editReminderConfirmation(existing, REMINDER_CANCELED_MESSAGE, true).catch(() => null);
      return { status: canceled ? "canceled" : "skipped" };
    }
    let reminder;
    try {
      reminder = await claimVcDmReminder({ recordId, now: now(), leaseMs: REMINDER_LEASE_MS });
    } catch (error) {
      await scheduleFailedReminderRetry(existing, error);
      await logReminderResult(existing, "failed");
      return { status: "failed", error };
    }
    if (!reminder) return { status: "skipped" };
    let user = null;
    let fetchError = null;
    try {
      user = await client.users.fetch(reminder.userId);
    } catch (error) {
      fetchError = error;
    }
    if (!user) {
      const status = fetchError && !isDmUnavailableError(fetchError) ? "failed" : "dm_unavailable";
      await setVcDmReminderStatus({ recordId, status, lastError: fetchError ? truncateError(fetchError) : "Discord user could not be fetched", now: now() }).catch(() => null);
      await logReminderResult(reminder, status);
      if (status === "failed") await scheduleFailedReminderRetry(reminder, fetchError);
      else await editReminderConfirmation(reminder, buildReminderConfirmationContent(reminder.targetEventAt), true).catch(() => null);
      return { status, error: fetchError };
    }
    let sent = false;
    try {
      await user.send({ content: REMINDER_MESSAGE, allowedMentions: { parse: [] } });
      sent = true;
      const saved = await setVcDmReminderStatus({ recordId, status: "sent", now: now() });
      if (!saved) throw new Error("reminder state update matched no processing record");
      await editReminderConfirmation(reminder, buildReminderConfirmationContent(reminder.targetEventAt), true).catch((error) => logger.warn?.(`VC DM reminder confirmation edit failed record=${recordId}: ${error.message}`));
      await logReminderResult(reminder, "sent");
      return { status: "sent" };
    } catch (error) {
      if (sent) {
        await setVcDmReminderStatus({ recordId, status: "unconfirmed", lastError: `Reminder sent but save was uncertain: ${truncateError(error)}`, now: now() }).catch((saveError) => logger.error?.(`VC DM reminder uncertain result save failed record=${recordId}: ${saveError.message}`));
        await logReminderResult(reminder, "unconfirmed");
        return { status: "unconfirmed", error };
      }
      const status = isDmUnavailableError(error) ? "dm_unavailable" : "failed";
      await setVcDmReminderStatus({ recordId, status, lastError: truncateError(error), now: now() }).catch((saveError) => logger.error?.(`VC DM reminder result save failed record=${recordId}: ${saveError.message}`));
      await logReminderResult(reminder, status);
      if (status === "failed") {
        await scheduleFailedReminderRetry(reminder, error);
      } else {
        await editReminderConfirmation(reminder, buildReminderConfirmationContent(reminder.targetEventAt), true).catch(() => null);
      }
      return { status, error };
    }
  }

  function processReminder(recordId, scheduledReminder = null) {
    return trackOperation(processReminderInternal(recordId, scheduledReminder));
  }

  async function restoreReminders() {
    const recovered = await recoverVcDmReminders(now()).catch((error) => {
      logger.error?.(`VC DM reminder recovery failed: ${error.message}`);
      return null;
    });
    if (recovered?.modifiedCount) logger.warn?.(`VC DM reminder recovery left ${recovered.modifiedCount} uncertain reminder(s) without automatic retry.`);
    for (const guild of client.guilds.cache.values()) {
      if ((await getGuildSettings(guild.id).catch(() => null))?.vcDmEnabled !== true) {
        clearReminderTimersForGuild(guild.id);
        continue;
      }
      const reminders = await getActiveVcDmReminders(guild.id).catch(() => []);
      for (const reminder of reminders) {
      if (new Date(reminder.targetEventAt).getTime() <= now().getTime()) {
          const canceled = await cancelVcDmReminder({ recordId: reminder.recordId, userId: reminder.userId, now: now() }).catch(() => null);
          if (canceled) await editReminderConfirmation(reminder, REMINDER_CANCELED_MESSAGE, true).catch(() => null);
        } else if (reminder.status === "processing" || reminder.status === "pending" || reminder.status === "failed") {
          scheduleReminder(reminder);
        }
      }
    }
  }

  async function reschedulePendingRemindersForEventTime(guild, eventTime) {
    const normalized = normalizeVcDmEventTime(eventTime);
    if (!normalized) return 0;
    const [hour, minute] = normalized.split(":").map(Number);
    const reminders = await getActiveVcDmReminders(guild.id);
    const current = now();
    let changed = 0;
    for (const reminder of reminders) {
      if (!["pending", "failed"].includes(reminder.status)) continue;
      const targetEventAt = getJstDateAt(reminder.targetEventAt, hour, minute);
      const remindAt = targetEventAt ? new Date(targetEventAt.getTime() - VC_DM_REMINDER_LEAD_MINUTES * 60 * 1000) : null;
      if (!targetEventAt || targetEventAt.getTime() <= current.getTime() || remindAt.getTime() <= current.getTime()) {
        // Settings changes must not turn a pending/failed send into a
        // canceled result.  Startup recovery owns terminalization of stale
        // reminders; here we only update future scheduling information.
        continue;
      }
      const saved = await rescheduleVcDmReminderTarget({ recordId: reminder.recordId, targetEventAt, remindAt, lastError: reminder.lastError ?? null }).catch((error) => {
        logger.error?.(`VC DM reminder event-time update failed record=${reminder.recordId}: ${error.message}`);
        return null;
      });
      if (!saved) continue;
      scheduleReminder(saved);
      await editReminderConfirmation(reminder, buildReminderConfirmationContent(targetEventAt), false).catch((error) => logger.warn?.(`VC DM reminder confirmation target update failed record=${reminder.recordId}: ${error.message}`));
      changed += 1;
      await sendOperationalLog?.({
        guild,
        settings: await getGuildSettings(guild.id).catch(() => null),
        fallbackChannel: null,
        content: `VC DM: reminder target updated recordId=${reminder.recordId} targetEventAt=${targetEventAt.toISOString()} remindAt=${remindAt.toISOString()}`,
      }).catch?.(() => null);
    }
    return changed;
  }

  async function syncReminderTimersForGuild(guild) {
    const reminders = await getActiveVcDmReminders(guild.id).catch((error) => {
      logger.warn?.(`VC DM reminder timer sync read failed guild=${guild.id}: ${error.message}`);
      return [];
    });
    for (const reminder of reminders) {
      if (["pending", "processing", "failed"].includes(reminder.status)) scheduleReminder(reminder);
    }
    return reminders.length;
  }

  async function startDailyScheduler() {
    if (dailySchedulerStarted || shuttingDown) return;
    dailySchedulerStarted = true;
    const scheduleNext = () => {
      if (shuttingDown) return;
      const next = getNextJstDaily17At(now());
      const delay = Math.max(1000, next.getTime() - now().getTime());
      dailyTimer = setTimeout(async () => {
        dailyTimer = null;
        await processAllGuildsDaily("scheduled");
        scheduleNext();
      }, delay);
    };
    scheduleNext();
  }

  function startPanelRefreshScheduler() {
    if (panelRefreshTimer || shuttingDown) return;
    const refresh = async () => {
      panelRefreshTimer = null;
      if (shuttingDown) return;
      try {
        for (const guild of client.guilds.cache.values()) {
          const settings = await getGuildSettings(guild.id).catch(() => null);
          if (settings?.vcDmEnabled !== true) continue;
          await panelService.ensurePanel(guild, "hourly-reconcile");
        }
      } finally {
        if (!shuttingDown) {
          const next = getNextJstHourAt(now());
          const delay = next ? Math.max(1000, next.getTime() - now().getTime()) : PANEL_REFRESH_INTERVAL_MS;
          panelRefreshTimer = setTimeout(() => { void refresh().catch((error) => logger.error?.(`VC DM hourly panel refresh failed: ${error.message}`)); }, delay);
        }
      }
    };
    const next = getNextJstHourAt(now());
    const delay = next ? Math.max(1000, next.getTime() - now().getTime()) : PANEL_REFRESH_INTERVAL_MS;
    panelRefreshTimer = setTimeout(() => { void refresh().catch((error) => logger.error?.(`VC DM hourly panel refresh failed: ${error.message}`)); }, delay);
  }

  async function processAllGuildsDaily(reason = "catch-up") {
    for (const guild of client.guilds.cache.values()) {
      await runDailyForGuild(guild, { reason }).catch((error) => logger.error?.(`VC DM daily guild processing failed guild=${guild.id}: ${error.message}`));
    }
  }

  async function restore(readyClient = client) {
    if (shuttingDown) return;
    const recoveredDm = await recoverVcDmMemberDmProcessing(now()).catch((error) => {
      logger.error?.(`VC DM DM-processing recovery failed: ${error.message}`);
      return null;
    });
    const recoveredNew = recoveredDm?.newResult?.modifiedCount ?? 0;
    const recoveredInactive = recoveredDm?.inactiveResult?.modifiedCount ?? 0;
    if (recoveredNew || recoveredInactive) logger.warn?.(`VC DM recovery marked ${recoveredNew + recoveredInactive} interrupted DM result(s) as unconfirmed.`);
    for (const guild of readyClient.guilds.cache.values()) {
      let settings;
      try {
        settings = await getGuildSettings(guild.id);
      } catch (error) {
        // A settings read failure is not evidence that the feature is
        // disabled. Preserve the panel reference and let the status board
        // report the startup read failure instead of deleting user-visible
        // state.
        logger.error?.(`VC DM startup settings read failed guild=${guild.id}: ${error.message}`);
        await requestDailyStatusRefresh(guild, "startup-settings-read-failed", "startup");
        continue;
      }
      if (settings?.vcDmEnabled !== true) {
        // A restart can happen after the feature was disabled but before the
        // settings-change cleanup completed. Recover the durable panel
        // reference during startup as well.
        await panelService.removePanel(guild, "startup-disabled").catch((error) => {
          logger.warn?.(`VC DM startup disabled-panel cleanup failed guild=${guild.id}: ${error.message}`);
        });
        await requestDailyStatusRefresh(guild, "startup-disabled", "startup");
        enabledGuilds.delete(guild.id);
        continue;
      }
      let startupReady = true;
      await migrateGuild(guild, settings).catch((error) => {
        startupReady = false;
        logger.error?.(`VC DM migration failed guild=${guild.id}: ${error.message}`);
      });
      let reconciliation = { joined: 0, left: 0 };
      try {
        reconciliation = await reconcileGuildMembers(guild);
      } catch (error) {
        startupReady = false;
        logger.error?.(`VC DM startup member reconciliation failed guild=${guild.id}: ${error.message}`);
      }
      let restoredSessions = 0;
      try {
        restoredSessions = restoreVoiceSessions(guild, settings);
      } catch (error) {
        logger.error?.(`VC DM startup voice-session restore failed guild=${guild.id}: ${error.message}`);
      }
      if (reconciliation.joined || reconciliation.left || restoredSessions) logger.info?.(`VC DM startup reconciliation guild=${guild.id} joined=${reconciliation.joined} left=${reconciliation.left} voiceSessions=${restoredSessions}`);
      await panelService.ensurePanel(guild, "startup");
      if (startupReady) enabledGuilds.add(guild.id);
    }
    await restoreReminders();
    const current = now();
    const jst = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(current);
    const hour = Number(jst.find((item) => item.type === "hour")?.value);
    if (hour >= 17) await processAllGuildsDaily("startup-catch-up");
    await startDailyScheduler();
    startPanelRefreshScheduler();
  }

  async function onSettingsChanged(guild) {
    const settings = await getGuildSettings(guild.id);
    if (settings?.vcDmEnabled !== true) {
      enabledGuilds.delete(guild.id);
      for (const session of [...voiceSessions.values()].filter((item) => item.guildId === guild.id)) clearVoiceSession(guild.id, session.userId);
      clearDailyRetry(guild.id);
      clearReminderTimersForGuild(guild.id);
      const panel = await panelService.removePanel(guild, "settings-disabled").catch((error) => {
        logger.warn?.(`VC DM panel removal after disable failed guild=${guild.id}: ${error.message}`);
        return { status: "failed", error };
      });
      await requestDailyStatusRefresh(guild, "settings-disabled", "settings-changed");
      return { status: "disabled", panel };
    }
    const wasEnabled = enabledGuilds.has(guild.id);
    if (!wasEnabled) {
      // Re-enable recovery is needed only when crossing disabled -> enabled.
      // Ordinary settings changes must not rewrite durable send outcomes.
      await migrateGuild(guild, settings);
      await reconcileGuildMembers(guild);
    }
    // Re-evaluate currently occupied target VCs after a target-setting
    // change, while preserving send-state documents.
    for (const session of [...voiceSessions.values()].filter((item) => item.guildId === guild.id)) {
      clearVoiceSession(guild.id, session.userId);
    }
    restoreVoiceSessions(guild, settings);
    enabledGuilds.add(guild.id);
    const configurationIssues = await getAllVcDmConfigurationIssues(guild, settings);
    if (configurationIssues.length) {
      await sendOperationalLog?.({
        guild,
        settings,
        fallbackChannel: null,
        content: `VC DM: settings-change configuration validation stopped daily processing guildId=${guild.id} reason=${configurationIssues.map((issue) => issue.code).join(",")}`,
      }).catch?.(() => null);
    }
    const panel = await panelService.ensurePanel(guild, "settings-change");
    await requestDailyStatusRefresh(guild, "settings-changed", "settings-changed");
    const eventTime = settings.kokuchiEventTimeConfigured === false
      ? null
      : normalizeVcDmEventTime(settings.kokuchiEventTime);
    if (eventTime) await reschedulePendingRemindersForEventTime(guild, eventTime).catch((error) => logger.error?.(`VC DM pending reminder event-time reschedule failed guild=${guild.id}: ${error.message}`));
    await syncReminderTimersForGuild(guild);
    return panel;
  }

  async function handleReminderRegistration(interaction, recordId) {
    const userId = getUserIdFromInteraction(interaction);
    const source = await getVcDmMemberByDmRecordId(recordId);
    const existingReminder = await getVcDmReminderBySourceRecordId(recordId).catch(() => null);
    const target = existingReminder
      ? { type: existingReminder.sourceDmType, targetEventAt: existingReminder.targetEventAt }
      : getTargetEventForMember(source, recordId);
    if (!source || !target || source.userId !== userId || !source.isMember) {
      await interaction.reply(replyOptions(interaction, "この案内DMは現在操作できません。"));
      return;
    }
    const settings = await getGuildSettings(source.guildId).catch((error) => {
      logger.error?.(`VC DM reminder registration settings read failed guild=${source.guildId}: ${error.message}`);
      return null;
    });
    if (settings?.vcDmEnabled !== true) {
      await interaction.reply(replyOptions(interaction, "VC DM機能は現在停止中です。"));
      return;
    }
    const targetEventAt = new Date(target.targetEventAt);
    const deadline = targetEventAt.getTime() - VC_DM_REMINDER_LEAD_MINUTES * 60 * 1000;
    if (!Number.isFinite(targetEventAt.getTime()) || now().getTime() >= deadline) {
      await interaction.reply(replyOptions(interaction, `このイベントのリマインダー登録期限を過ぎています。\n開催日時：${formatJstDateTime(targetEventAt)}`));
      return;
    }
    const reminder = await findOrCreateVcDmReminder({
      guildId: source.guildId,
      userId,
      targetEventAt,
      sourceDmType: target.type,
      sourceDmRecordId: recordId,
      remindAt: new Date(targetEventAt.getTime() - VC_DM_REMINDER_LEAD_MINUTES * 60 * 1000),
      recordId: createVcDmRecordId("m"),
      now: now(),
    });
    if (!reminder) {
      await interaction.reply(replyOptions(interaction, "リマインダーを登録できませんでした。しばらくしてから再度お試しください。"));
      return;
    }
    if (reminder.status === "sent") {
      await interaction.reply(replyOptions(interaction, "このイベントのリマインダーはすでに送信済みです。"));
      return;
    }
    if (reminder.status === "dm_unavailable") {
      await interaction.reply(replyOptions(interaction, "このイベントのリマインダーは送信できない状態です。"));
      return;
    }
    if (reminder.status === "canceled") {
      await interaction.reply(replyOptions(interaction, "このイベントのリマインダーはキャンセル済みです。"));
      return;
    }
    if (reminder.status === "unconfirmed") {
      await interaction.reply(replyOptions(interaction, "このイベントのリマインダーは送信結果を確認できないため、重複登録を防止しています。"));
      return;
    }
    if (existingReminder?.confirmationMessageId && existingReminder.channelId) {
      // A stale click on the original invitation must not create a second DM.
      if (interaction.update) {
        try {
          await interaction.update({ content: interaction.message?.content ?? "", components: [] });
        } catch (error) {
          logger.warn?.(`VC DM stale reminder message update failed record=${reminder.recordId}: ${error.message}`);
          if (!interaction.replied && !interaction.deferred) await interaction.deferUpdate?.().catch(() => null);
        }
      } else {
        await interaction.reply(replyOptions(interaction, "Reminder already registered."));
      }
      return;
    }
    const confirmationClaim = await claimVcDmReminderConfirmation({ recordId: reminder.recordId, now: now() }).catch((error) => {
      logger.error?.(`VC DM reminder confirmation claim failed record=${reminder.recordId}: ${error.message}`);
      return null;
    });
    if (!confirmationClaim) {
      if (interaction.update) {
        await interaction.deferUpdate?.().catch(() => null);
      } else {
        await interaction.reply(replyOptions(interaction, "Reminder registration is already in progress."));
      }
      return;
    }
    const content = buildReminderConfirmationContent(targetEventAt);
    const cancelComponents = createReminderCancelRow(reminder.recordId, false);
    let confirmationMessage;
    try {
      confirmationMessage = await interaction.channel.send({
        content,
        components: cancelComponents,
        allowedMentions: { parse: [] },
      });
    } catch (error) {
      await interaction.reply(replyOptions(interaction, "リマインダー登録用DMの送信に失敗しました。しばらくしてから再度お試しください。"));
      return;
    }
    const savedConfirmation = await saveVcDmReminderConfirmation({
      recordId: reminder.recordId,
      channelId: confirmationMessage.channelId ?? interaction.channelId,
      confirmationMessageId: confirmationMessage.id,
    }).catch((error) => {
      logger.error?.(`VC DM reminder confirmation save failed record=${reminder.recordId}: ${error.message}`);
      return null;
    });
    if (!savedConfirmation) {
      await confirmationMessage.delete?.().catch?.(() => null);
      await interaction.reply(replyOptions(interaction, "リマインダー登録結果を保存できませんでした。しばらくしてから再度お試しください。"));
      return;
    }
    reminder.channelId = confirmationMessage.channelId ?? interaction.channelId;
    reminder.confirmationMessageId = confirmationMessage.id;
    scheduleReminder(reminder);
    await logReminderLifecycle(source.guildId, `VC DM: reminder registered recordId=${reminder.recordId} userId=${userId} targetEventAt=${targetEventAt.toISOString()} duplicate=${Boolean(existingReminder)}`);
    if (interaction.update) {
      try {
        await interaction.update({ content: interaction.message?.content ?? "", components: [] });
      } catch (error) {
        logger.warn?.(`VC DM original reminder message update failed record=${reminder.recordId}: ${error.message}`);
        if (!interaction.replied && !interaction.deferred) await interaction.deferUpdate?.().catch(() => null);
      }
    } else {
      await interaction.reply(replyOptions(interaction, content));
    }
  }

  async function handleReminderCancellation(interaction, recordId) {
    const reminder = await getVcDmReminderByRecordId(recordId);
    const userId = getUserIdFromInteraction(interaction);
    if (!reminder || reminder.userId !== userId) {
      await interaction.reply(replyOptions(interaction, "このリマインダーは現在操作できません。"));
      return;
    }
    if (["sent", "canceled", "dm_unavailable"].includes(reminder.status) || new Date(reminder.targetEventAt).getTime() <= now().getTime()) {
      await interaction.reply(replyOptions(interaction, reminder.status === "sent" ? "このリマインダーはすでに送信済みです。" : "このリマインダーは現在操作できません。"));
      return;
    }
    const canceled = await cancelVcDmReminder({ recordId, userId, now: now() });
    if (!canceled) {
      await interaction.reply(replyOptions(interaction, "このリマインダーは現在操作できません。"));
      return;
    }
    const timer = reminderTimers.get(recordId);
    if (timer) clearTimeout(timer);
    reminderTimers.delete(recordId);
    reminderTimerGuildIds.delete(recordId);
    await logReminderLifecycle(reminder.guildId, `VC DM: reminder canceled recordId=${recordId} userId=${userId}`);
    if (interaction.update) await interaction.update({ content: REMINDER_CANCELED_MESSAGE, components: [] });
    else await interaction.reply(replyOptions(interaction, REMINDER_CANCELED_MESSAGE));
  }

  async function handlePanelInteraction(interaction, action, recordId) {
    const panel = interaction.guildId
      ? await getVcDmPanel(interaction.guildId).catch(() => null)
      : null;
    if (!isCurrentVcDmPanelInteraction(interaction, panel, recordId)) {
      await interaction.reply(replyOptions(interaction, "この操作パネルは古いため利用できません"));
      return;
    }
    if (!canManagePanel(interaction)) {
      await interaction.reply(replyOptions(interaction, "この操作にはサーバー管理権限が必要です。"));
      return;
    }
    if (action === "refresh") {
      await panelService.ensurePanel(interaction.guild, "manual-refresh");
      await interaction.reply(replyOptions(interaction, "VC未参加者DMの対象一覧を更新しました。"));
      return;
    }
    const userId = interaction.values?.[0];
    if (!userId) {
      await interaction.reply(replyOptions(interaction, "対象ユーザーを選択してください。"));
      return;
    }
    const record = await getVcDmMember(interaction.guildId, userId);
    if (!record || !record.isMember) {
      await interaction.reply(replyOptions(interaction, "対象ユーザーが在籍していないか、追跡レコードがありません。"));
      return;
    }
    if (action === "exclude") {
      if (hasValidVcParticipation(record) || record.manualValidVcConfirmedAt || !canAttemptDmStatus(record.newDmStatus)) {
        await interaction.reply(replyOptions(interaction, "このユーザーは現在の新規7日候補ではありません。"));
        return;
      }
      const confirmedAt = now();
      const migration = await getVcDmMigration(interaction.guildId).catch(() => null);
      const baselineAt = getVcDmManualBaselineAt(record, migration);
      const saved = await setManualVcParticipationConfirmation({ guildId: interaction.guildId, userId, confirmedBy: getUserIdFromInteraction(interaction), confirmed: true, confirmedAt, baselineAt });
      if (!saved) {
        await interaction.reply(replyOptions(interaction, "対象ユーザーの除外状態を更新できませんでした。"));
        return;
      }
      await panelService.ensurePanel(interaction.guild, "admin-exclude");
      await sendOperationalLog?.({ guild: interaction.guild, settings: await getGuildSettings(interaction.guildId).catch(() => null), fallbackChannel: null, content: `VC DM: 管理者が参加済みとして除外 guildId=${interaction.guildId} userId=${userId} confirmedBy=${getUserIdFromInteraction(interaction)}` }).catch?.(() => null);
      await interaction.reply(replyOptions(interaction, `<@${userId}> を参加済みとして除外しました。DM判定予定：${formatJstDateTime(getNewMemberDmDueAt(record.joinedAt))}`));
      return;
    }
    if (action === "unexclude") {
      if (!record.manualValidVcConfirmedAt) {
        await interaction.reply(replyOptions(interaction, "このユーザーには管理者による参加済み除外がありません。"));
        return;
      }
      const saved = await setManualVcParticipationConfirmation({ guildId: interaction.guildId, userId, confirmedBy: null, confirmed: false, confirmedAt: now() });
      if (!saved) {
        await interaction.reply(replyOptions(interaction, "対象ユーザーの除外状態を更新できませんでした。"));
        return;
      }
      await panelService.ensurePanel(interaction.guild, "admin-unexclude");
      await sendOperationalLog?.({ guild: interaction.guild, settings: await getGuildSettings(interaction.guildId).catch(() => null), fallbackChannel: null, content: `VC DM: 管理者による参加済み除外を取消 guildId=${interaction.guildId} userId=${userId} confirmedBy=${getUserIdFromInteraction(interaction)}` }).catch?.(() => null);
      const dueAt = getNewMemberDmDueAt(record.joinedAt);
      const resultText = hasValidVcParticipation(record)
        ? "実際の有効VC参加履歴があるため、新規候補には戻りません。"
        : `DM判定予定：${formatJstDateTime(dueAt)}`;
      await interaction.reply(replyOptions(interaction, `<@${userId}> の参加済み除外を取り消しました。${resultText}`));
    }
  }

  async function handleInteraction(interaction) {
    const customId = interaction?.customId;
    if (typeof customId !== "string" || !customId.startsWith("vcdm:")) return false;
    const parts = customId.split(":");
    if (parts[1] === "reminder" && parts[2]) {
      await handleReminderRegistration(interaction, parts[2]);
      return true;
    }
    if (parts[1] === "cancel" && parts[2]) {
      await handleReminderCancellation(interaction, parts[2]);
      return true;
    }
    if (parts[1] === "panel" && parts[2] && parts[3]) {
      await handlePanelInteraction(interaction, parts[2], parts[3]);
      return true;
    }
    return false;
  }

  async function getOperationalStatus(guild, { settings: providedSettings } = {}) {
    const settings = providedSettings ?? await getGuildSettings(guild.id);
    const reads = await Promise.allSettled([
      getVcDmPanel(guild.id),
      getVcDmDailyRun(guild.id, getJstCalendarDate(now())),
      getVcDmMigration(guild.id),
      getActiveVcDmReminders(guild.id),
      getVcDmUnconfirmedSummary(guild.id),
      getVcDmResultSummary(guild.id),
      panelService.getStatus(guild),
    ]);
    const readErrors = reads
      .filter((result) => result.status === "rejected")
      .map((result) => truncateError(result.reason));
    const value = (index, fallback) => reads[index]?.status === "fulfilled" ? reads[index].value : fallback;
    const panel = value(0, null);
    const currentRun = value(1, null);
    const migration = value(2, null);
    const activeReminders = value(3, []);
    const uncertain = value(4, { memberCount: 0, reminderCount: 0, total: 0 });
    const results = value(5, { member: {}, reminders: {}, delivered: 0, dm_unavailable: 0, failed: 0, unconfirmed: 0 });
    const panelState = value(6, { candidateCount: 0, configValid: false });
    const enabled = settings?.vcDmEnabled === true;
    const configurationIssues = enabled ? await getAllVcDmConfigurationIssues(guild, settings) : [];
    const configValid = enabled && hasVcDmConfiguration(settings) && configurationIssues.length === 0;
    const issues = [];
    if (readErrors.length) issues.push({ code: "read_failed", message: `VC DMの状態を取得できません: ${readErrors.join(" / ").slice(0, 1000)}`, blocking: true });
    for (const issue of configurationIssues) issues.push({ ...issue, blocking: true });
    if (currentRun?.status === "failed") issues.push({ code: "daily_run_failed", message: currentRun.lastError ?? "17:00の日次判定に失敗しています。", blocking: true });
    if (enabled && currentRun?.status === "stopped") {
      const stopReason = currentRun.result?.stopReason ?? currentRun.lastError ?? "unknown";
      issues.push({ code: "daily_run_stopped", message: `17:00の日次判定は停止しました（理由: ${stopReason}）。`, blocking: false });
    }
    if (enabled && migration?.status === "failed") issues.push({ code: "migration_failed", message: migration.lastError ?? "VC DM移行処理に失敗しています。", blocking: true });
    if (panel?.lastError) issues.push({ code: "panel_error", message: panel.lastError, blocking: true });
    if (activeReminders.some((item) => item.status === "failed")) issues.push({ code: "reminder_failed", message: "送信待ちリマインダーに失敗状態があります。", blocking: true });
    if (enabled && results.failed > 0) issues.push({ code: "dm_failed", message: `VC DMまたはリマインダーに再試行待ちの失敗が${results.failed}件あります。`, blocking: true });
    if (enabled && uncertain.total > 0) issues.push({ code: "dm_unconfirmed", message: `DM送信後の保存結果を確認できない状態が${uncertain.total}件あります。`, blocking: true });
    const severity = readErrors.length
      ? "unknown"
      : getVcDmStatusSeverity({ enabled, configValid, dailyRun: currentRun, migration, reminders: activeReminders, panel, uncertain, results });
    return {
      key: "vcDm",
      label: "VC未参加者DM",
      severity,
        summary: !enabled ? "VC未参加者DMは無効です。" : `${panelState.candidateCount ?? 0}人を対象確認中 / リマインダー${activeReminders.length}件 / 不確定${uncertain.total}件`,
      details: {
        enabled,
        configValid,
        configurationIssues,
        panel: panel ? { channelId: panel.channelId, messageIds: panel.messageIds, lastUpdatedAt: panel.lastUpdatedAt, lastError: panel.lastError } : null,
        candidateCount: panelState.candidateCount ?? 0,
        migration: migration ? { status: migration.status, version: migration.version, implementationAt: migration.implementationAt, processedCount: migration.processedCount, lastUserId: migration.lastUserId, completedAt: migration.completedAt, lastError: migration.lastError } : null,
        dailyRun: currentRun ? { jstDate: currentRun.jstDate, status: currentRun.status, startedAt: currentRun.startedAt, completedAt: currentRun.completedAt, lastError: currentRun.lastError, result: currentRun.result } : null,
        activeReminderCount: activeReminders.length,
        results,
        uncertain,
        voiceSessionCount: [...voiceSessions.values()].filter((item) => item.guildId === guild.id).length,
      },
      issues,
      blocking: issues.some((issue) => issue.blocking),
      availableActions: [],
      observedAt: now().toISOString(),
      inProgress: migration?.status === "processing"
        || currentRun?.status === "processing"
        || (results.member?.processing ?? 0) > 0
        || (results.reminders?.processing ?? 0) > 0
        || [...voiceSessions.values()].some((item) => item.guildId === guild.id),
    };
  }

  async function shutdown() {
    if (shuttingDown) {
      await Promise.allSettled([...activeOperations]);
      await panelService.shutdown();
      return;
    }
    shuttingDown = true;
    if (dailyTimer) clearTimeout(dailyTimer);
    if (panelRefreshTimer) clearTimeout(panelRefreshTimer);
    dailyTimer = null;
    panelRefreshTimer = null;
    for (const timer of reminderTimers.values()) clearTimeout(timer);
    reminderTimers.clear();
    reminderTimerGuildIds.clear();
    for (const timer of dailyRetryTimers.values()) clearTimeout(timer);
    dailyRetryTimers.clear();
    for (const session of voiceSessions.values()) clearTimeout(session.timer);
    voiceSessions.clear();
    voiceQueues.clear();
    await Promise.allSettled([...activeOperations]);
    await panelService.shutdown();
  }

  return {
    getOperationalStatus,
    handleInteraction,
    handleMemberAdd,
    handleMemberRemove,
    handleVoiceState,
    completeDueVoiceSessions,
    migrateGuild,
    onSettingsChanged,
    panelService,
    processAllGuildsDaily,
    restore,
    runDailyForGuild,
    scheduleReminder,
    shutdown,
    startDailyScheduler,
  };
}

export {
  createReminderCancelRow,
  getTargetEventForMember,
  getVcDmManualBaselineAt,
  getVcDmMigrationImplementationAt,
};
