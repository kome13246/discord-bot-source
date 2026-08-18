export function createVoiceSplitFeature(dependencies) {
  const {
    AUTO_SPLIT_THRESHOLD,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    CALL_WAIT_CANCEL_CUSTOM_ID,
    CALL_WAIT_INTEREST_CUSTOM_ID,
    CALL_WAIT_JOIN_CUSTOM_ID,
    COUNTDOWN_UPDATE_MS,
    ChannelType,
    DEFAULT_FINISH_MESSAGE,
    DEFAULT_NOTICE_WAIT_MINUTES,
    DEFAULT_ROLE_REMOVE_WAIT_MINUTES,
    DEFAULT_TRANSFER_WAIT_SECONDS,
    DEFAULT_WAITING_VC_NAME,
    KokuchiReservation,
    MESSAGE_LIMIT,
    MessageFlags,
    ModalBuilder,
    OTEBO_BUTTON_LIFECYCLE_LEASE_PREFIX,
    OTEBO_ROLE_REMOVE_MS,
    OTEBO_VOICE_STARTED_NOTICE,
    PB_CHILD_WAIT_MS,
    PermissionFlagsBits,
    PermissionsBitField,
    SPLIT_REVIEW_OPEN,
    SUGGESTED_TOPICS,
    SplitProcessSession,
    TextInputBuilder,
    TextInputStyle,
    VOICE_MONITOR_FORM_DELETE_DELAY_MS,
    VOICE_MONITOR_MIN_MEMBERS,
    VOICE_MONITOR_STOP_DELAY_MS,
    VOICE_PARTICIPANT_ROLE_MAX_RETRIES,
    VOICE_PARTICIPANT_ROLE_RETRY_DELAYS_MS,
    VoiceParticipantRoleGrant,
    WADAI_CATEGORIES,
    WAITING_MONITOR_LEASE_MS,
    WAITING_ROOM_MONITOR_MS,
    WAITING_ROOM_POLL_MS,
    acquireMongoLease,
    activeSessions,
    activeSplitVoiceLeases,
    autoSplitLocks,
    autoSplitSuggestionMessages,
    buildGroups,
    callWaitRoleRemovalTimers,
    callWaitRoleService,
    chooseBestGroupForMember,
    chooseBestMemberSubset,
    chooseGroupsWithHistory,
    claimAction,
    clearCompletedGatheringVcEventState,
    clearOteboRecruitmentTimers,
    client,
    closeGatheringVcAfterSplit,
    countRepeatedPairs,
    createPairKey,
    deferCommandResponse,
    deleteOteboRecruitmentMessage,
    deleteOteboRecruitmentState,
    describeGroups,
    editOteboRecruitmentMessageClosed,
    failAction,
    findActiveButtonOteboRecruitment,
    finishAction,
    getCallWaitIntervalMinutes,
    getCallWaitNoticeChannelId,
    getCallWaitPromptChannelId,
    getGuildSettings,
    getKokuchiAnnouncementChannelId,
    getOteboQuickConfirmSeconds,
    getOteboRecruitment,
    getPairKeysFromGroups,
    getSplitGroupingState,
    isGatheringVcRestoreBlocking,
    isKokuchiCallWaitPause,
    isKokuchiEventActionInvalid,
    localWaitingMonitorSessions,
    logRecoverableError,
    maybeSendPendingCallWaitStartNotice,
    mongoose,
    normalizeCallWaitMemberIds,
    normalizeGatheringVcRestoreStatus,
    normalizeKokuchiEventTime,
    oteboRecruitmentPanelService,
    processOteboVoiceStatusSessions,
    releaseMongoLease,
    releaseOteboRecruitmentSlot,
    removeCallWaitRoleFromMembers,
    retryAction,
    replaceNestedObject,
    requestOperationalStatusRefresh,
    resolveConfiguredTextChannel,
    restoreGatheringVcPermissionAfterSplit,
    restoredWaitingMonitorLocks,
    restoredWaitingMonitorTimers,
    saveGuildSettings,
    scheduleAction,
    schedulePersistentRoleRemoval,
    scheduleWaitingVcCleanup,
    sendOperationalLog,
    sendSplitClosingThanks,
    sendSplitGroupingLog,
    sendSplitRandomTopicPanels,
    sendSplitStartAnnouncement,
    shuffle,
    splitCountdownSessions,
    splitVoiceGuildLocks,
    startSplitGrouping,
    toCurrentGroupMemberIds,
    topicFormSessions,
    transitionOteboRecruitment,
    unsetNestedObject,
    validateVoiceParticipantRole,
    voiceMonitorPendingFormDeletions,
    voiceMonitorSessions,
    voiceParticipantRoleFinalFailureLogs,
    voiceParticipantRoleQueues,
    voiceParticipantRoleRetryTimers,
    waitingMemberRetryAfter,
    waitingMonitorLeaseOwner,
  } = dependencies;

  const WAITING_CHILD_TARGET_SIZE = 4;
  const WAITING_EXTENSION_MAX_MEMBERS = 2;
  const DIRECT_CHILD_USER_LIMIT = 5;
  const DIRECT_EMPTY_GRACE_MS = 5 * 60 * 1000;
  const DIRECT_CHILD_MONITOR_POLL_MS = 5 * 1000;
  const directChildMonitorTimers = new Map();
  const directChildMonitorLocks = new Set();
  const waitingRollbackLocks = new Set();

  function shutdownDirectChildMonitors() {
    for (const sessionId of directChildMonitorTimers.keys()) {
      clearDirectChildMonitor(sessionId);
    }
    directChildMonitorLocks.clear();
    waitingRollbackLocks.clear();
  }

  function normalizeSplitMode(settings) {
    return settings?.splitMode === "partybeast" ? "partybeast" : "direct";
  }

  function normalizeSessionSplitMode(session) {
    // Sessions written before splitMode was introduced were PB sessions.
    return session?.splitMode === "direct" ? "direct" : "partybeast";
  }

  async function queueWaitingRollbackTask({
    sessionId,
    channelId,
    sourceChannelId,
    memberIds = [],
    roleMemberIds = [],
    deleteChannel = false,
    lastError,
  }) {
    const task = {
      taskId: createSessionId(),
      channelId,
      sourceChannelId,
      memberIds: [...new Set(memberIds)],
      roleMemberIds: [...new Set(roleMemberIds)],
      deleteChannel,
      createdAt: new Date(),
      lastError,
    };
    const queued = await SplitProcessSession.updateOne(
      { sessionId },
      {
        $push: { waitingRollbackTasks: task },
        $set: { lastError },
        $inc: { waitingMonitorFailureCount: 1 },
      },
    );
    return queued.matchedCount === 1 ? task : null;
  }

  async function processWaitingRollbackTasks(sessionId, guild) {
    if (waitingRollbackLocks.has(sessionId)) return;
    waitingRollbackLocks.add(sessionId);
    try {
      const session = await SplitProcessSession.findOne({ sessionId }).lean();
      const tasks = session?.waitingRollbackTasks ?? [];
      for (const task of tasks) {
        const errors = [];
        let sourceChannel = null;
        try {
          sourceChannel = task.sourceChannelId
            ? await guild.channels.fetch(task.sourceChannelId)
            : null;
        } catch (error) {
          if (error?.code !== 10003) errors.push(`source channel: ${error.message}`);
        }

        for (const memberId of task.memberIds ?? []) {
          try {
            const member = await guild.members.fetch(memberId);
            if (member.voice.channelId === task.channelId) {
              if (!sourceChannel?.isVoiceBased?.()) {
                throw new Error("waiting voice channel is unavailable");
              }
              await member.voice.setChannel(sourceChannel, "Retry waiting transfer rollback");
            }
          } catch (error) {
            errors.push(`${memberId} voice: ${error.message}`);
          }
        }

        for (const memberId of task.roleMemberIds ?? []) {
          try {
            const member = await guild.members.fetch(memberId);
            await removeVoiceParticipantRole(member, session.participantRoleId, {
              sourceType: "splitvc",
              sourceId: sessionId,
            });
          } catch (error) {
            errors.push(`${memberId} role: ${error.message}`);
          }
        }

        if (task.deleteChannel && errors.length === 0) {
          try {
            const channel = await guild.channels.fetch(task.channelId);
            if (channel) await channel.delete("Retry waiting transfer rollback cleanup");
          } catch (error) {
            if (error?.code !== 10003) errors.push(`child channel ${task.channelId}: ${error.message}`);
          }
        }

        if (errors.length > 0) {
          const lastError = `Waiting transfer rollback is still pending: ${errors.join(" | ")}`;
          await SplitProcessSession.updateOne(
            { sessionId, "waitingRollbackTasks.taskId": task.taskId },
            { $set: { "waitingRollbackTasks.$.lastError": lastError, lastError } },
          ).catch((error) => logRecoverableError(`Failed to persist waiting rollback retry ${task.taskId}`, error));
          continue;
        }

        const pull = {
          waitingRollbackTasks: { taskId: task.taskId },
          participantMemberIds: { $in: task.memberIds ?? [] },
          participantRoleGrantedMemberIds: { $in: task.roleMemberIds ?? [] },
        };
        if (task.deleteChannel) {
          pull.childChannelIds = task.channelId;
          pull.childChannelStates = { channelId: task.channelId };
          pull.groupSnapshots = { channelId: task.channelId };
        } else {
          pull["groupSnapshots.$[].memberIds"] = { $in: task.memberIds ?? [] };
        }
        await SplitProcessSession.updateOne(
          { sessionId, "waitingRollbackTasks.taskId": task.taskId },
          { $pull: pull },
        );
      }
    } finally {
      waitingRollbackLocks.delete(sessionId);
    }
  }

  async function getKokuchiActionGuard({ guildId, eventId = null, expectedRevision = null } = {}) {
    if (!eventId) return { valid: true, event: null, eventId: null, revision: null };
    const event = await KokuchiReservation.findOne({ guildId, reservationId: eventId }).lean().catch(() => null);
    return {
      valid: Boolean(event && !isKokuchiEventActionInvalid(event, expectedRevision)),
      event,
      eventId,
      revision: event?.lifecycleRevision ?? null,
    };
  }
  
  async function stopInvalidKokuchiAction({ actionKey, guild, sessionId = null, guard } = {}) {
    if (guard?.event && (
      guard.event.gatheringVcUnlockState === "opened"
      || guard.event.gatheringVcPermissionBeforeOpen
      || isGatheringVcRestoreBlocking(normalizeGatheringVcRestoreStatus(guard.event))
    )) {
      const settings = await getGuildSettings(guild.id).catch(() => null);
      await restoreGatheringVcPermissionAfterSplit(guild, settings, { eventId: guard.eventId, force: true }).catch((error) => {
        logRecoverableError("Failed to compensate an invalidated kokuchi action", error);
      });
    }
    if (sessionId) {
      await SplitProcessSession.updateOne(
        { sessionId },
        { $set: { roleRemovalCompleted: true, phase: "completed", status: "completed", completedAt: new Date(), lastError: "Kokuchi event was canceled before the action could complete" } },
      ).catch((error) => logRecoverableError("Failed to close split session after kokuchi cancellation", error));
    }
    await finishAction(actionKey, "canceled", "Kokuchi event was canceled or its lifecycle revision changed").catch((error) => logRecoverableError("Failed to cancel invalidated kokuchi action", error));
  }
  
  async function persistSplitProcessSession(sessionId, patch) {
    if (!sessionId) return null;
    if (mongoose.connection.readyState !== 1) {
      throw new Error("MongoDB is unavailable; split process state was not persisted.");
    }
    const { guildId, ...setFields } = patch;
    const insertFields = {
      sessionId,
      ...(guildId ? { guildId } : {}),
    };
    return SplitProcessSession.findOneAndUpdate(
      { sessionId },
      { $set: setFields, $setOnInsert: insertFields },
      { upsert: true, returnDocument: "after", setDefaultsOnInsert: true, lean: true },
    );
  }
  
  function createCallWaitInterestRow() {
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(CALL_WAIT_JOIN_CUSTOM_ID).setLabel("参加予定").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(CALL_WAIT_INTEREST_CUSTOM_ID).setLabel("興味あり").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(CALL_WAIT_CANCEL_CUSTOM_ID).setLabel("キャンセル").setStyle(ButtonStyle.Danger),
    );
  }
  
  async function isKokuchiCallWaitPaused(settings, guildId, now) {
    if (isKokuchiCallWaitPause(settings, now)) return true;
    const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
    if (jst.getUTCHours() < 20 || jst.getUTCHours() >= 22) return false;
    const start = new Date(Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate() - 1, 15, 0, 0));
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
    return Boolean(await KokuchiReservation.exists({ guildId, status: { $in: ["pending", "processing"] }, scheduledAt: { $gte: start, $lt: end } }));
  }
  
  async function sendSplitFinishNotice({ guild, session, channelId }) {
    const initialGuard = await getKokuchiActionGuard({
      guildId: guild.id,
      eventId: session?.kokuchiEventId ?? null,
      expectedRevision: session?.kokuchiEventRevision ?? null,
    });
    if (!initialGuard.valid) return false;
    const settings = await getGuildSettings(guild.id);
    const channel = await guild.channels.fetch(channelId ?? session.operationChannelId).catch(() => null);
    if (!channel?.send) throw new Error("終了通知先チャンネルへ送信できません。");
    const reviewChannelId = settings?.reviewSendChannelId ?? null;
    let canReview = false;
    if (reviewChannelId) {
      const reviewChannel = await guild.channels.fetch(reviewChannelId).catch(() => null);
      const me = guild.members.me ?? await guild.members.fetchMe().catch(() => null);
      const permissions = reviewChannel?.permissionsFor?.(me);
      canReview = Boolean(reviewChannel?.isTextBased?.() && permissions?.has(PermissionFlagsBits.ViewChannel) && permissions?.has(PermissionFlagsBits.SendMessages));
      if (!canReview) await sendOperationalLog({ guild, settings, fallbackChannel: channel, content: "感想ボタンを付けられませんでした：感想送信先が未設定、削除済み、またはBotに閲覧・送信権限がありません。" });
    } else await sendOperationalLog({ guild, settings, fallbackChannel: channel, content: "感想ボタンを付けられませんでした：感想送信先が未設定です。" });
    const now = new Date(); const waitMs = minutesToMs(getNonNegativeInteger(settings?.roleRemoveWaitMinutes, DEFAULT_ROLE_REMOVE_WAIT_MINUTES));
    await guild.members.fetch().catch(() => null);
    const eligible = session.participantRoleId ? [...(guild.roles.cache.get(session.participantRoleId)?.members?.keys() ?? [])].filter((id) => id !== guild.client.user.id) : [];
    const snapshots = await Promise.all((session.childChannelIds ?? []).map(async (id, index) => { const vc = await guild.channels.fetch(id).catch(() => null); const ids = vc?.members ? [...vc.members.keys()].filter((memberId) => memberId !== guild.client.user.id) : (session.groupSnapshots?.[index]?.memberIds ?? []); return { groupNumber: session.groupSnapshots?.[index]?.groupNumber ?? index + 1, channelId: id, memberIds: ids }; }));
    const finishContent = canReview
      ? `<@&${session.participantRoleId}> 30分が経過しました！各々のちょうどいいタイミングで解散してください\n\nお時間があれば下のボタンから今回の感想をお聞かせください！\n３０秒ほどで完了するので今後に活かすためにぜひお願いします 🙏`
      : `<@&${session.participantRoleId}> 30分が経過しました！各々のちょうどいいタイミングで解散してください`;
    const message = await channel.send({
      content: finishContent,
      components: canReview ? [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`${SPLIT_REVIEW_OPEN}:${session.sessionId}`).setLabel("感想を送る").setStyle(ButtonStyle.Primary))] : [],
      allowedMentions: { roles: session.participantRoleId ? [session.participantRoleId] : [] },
    });
    const afterDiscord = await getKokuchiActionGuard({
      guildId: guild.id,
      eventId: session?.kokuchiEventId ?? null,
      expectedRevision: session?.kokuchiEventRevision ?? null,
    });
    if (!afterDiscord.valid) {
      await message?.delete?.().catch((error) => logRecoverableError("Failed to compensate finish notice after kokuchi cancellation", error));
      return false;
    }
    await sendSplitClosingThanks(guild, settings, session.participantMemberIds).catch((error) => logRecoverableError("Recoverable asynchronous operation failed", error));
    const deadline = new Date(now.getTime() + waitMs);
    const conversationStarted = Boolean(session.conversationStartedAt && (session.groupSnapshots ?? []).some((group) => group.memberIds?.length));
    const beforePersist = await getKokuchiActionGuard({
      guildId: guild.id,
      eventId: session?.kokuchiEventId ?? null,
      expectedRevision: session?.kokuchiEventRevision ?? null,
    });
    if (!beforePersist.valid) {
      await message?.delete?.().catch((error) => logRecoverableError("Failed to compensate finish notice before session persistence", error));
      return false;
    }
    const persisted = await SplitProcessSession.updateOne({ sessionId: session.sessionId, status: { $in: ["active", "finish_notice_pending"] } }, { $set: { finishNoticeSent: true, finishNoticeAt: now, reviewDeadlineAt: deadline, roleRemoveAt: deadline, finishNoticeChannelId: channel.id, finishNoticeMessageId: message.id, reviewButtonShown: canReview, reviewEligibleMemberIds: eligible, groupSnapshots: snapshots, status: "feedback_open", phase: "feedback_open", reviewAggregationEligible: canReview && eligible.length > 0 && conversationStarted, conversationStartedAt: session.conversationStartedAt ?? null } });
    if (persisted.matchedCount !== undefined && persisted.matchedCount !== 1) {
      await message?.delete?.().catch((error) => logRecoverableError("Failed to compensate finish notice after session persistence mismatch", error));
      return false;
    }
    await schedulePersistentRoleRemoval({ actionKey: `split-role-remove:${session.sessionId}`, type: "split_role_remove", guild, roleId: session.participantRoleId, memberIds: eligible, delayMs: waitMs, timers: callWaitRoleRemovalTimers, payload: { sessionId: session.sessionId, kokuchiEventId: session.kokuchiEventId ?? null, kokuchiEventRevision: session.kokuchiEventRevision ?? null, reviewClose: true } });
    return true;
  }
  
  function clearRestoredWaitingMonitor(sessionId) {
    const timer = restoredWaitingMonitorTimers.get(sessionId);
    if (timer) clearInterval(timer);
    restoredWaitingMonitorTimers.delete(sessionId);
  }
  
  async function claimWaitingMonitorLease(sessionId) {
    const now = new Date();
    return SplitProcessSession.findOneAndUpdate(
      {
        sessionId,
        status: "active",
        waitingMonitorStatus: { $in: ["active", "extended"] },
        $or: [
          { waitingMonitorLeaseOwner: waitingMonitorLeaseOwner },
          { waitingMonitorLeaseUntil: { $lte: now } },
          { waitingMonitorLeaseUntil: { $exists: false } },
        ],
      },
      {
        $set: {
          waitingMonitorLeaseOwner: waitingMonitorLeaseOwner,
          waitingMonitorLeaseUntil: new Date(now.getTime() + WAITING_MONITOR_LEASE_MS),
          waitingMonitorHeartbeatAt: now,
        },
      },
      { returnDocument: "after", lean: true },
    );
  }
  
  async function releaseWaitingMonitorLease(sessionId) {
    await SplitProcessSession.updateOne(
      { sessionId, waitingMonitorLeaseOwner: waitingMonitorLeaseOwner },
      { $unset: { waitingMonitorLeaseOwner: 1, waitingMonitorLeaseUntil: 1 } },
    );
  }
  
  async function recordWaitingMonitorFailure(sessionId, error) {
    const session = await SplitProcessSession.findOneAndUpdate(
      { sessionId, status: "active", waitingMonitorStatus: { $in: ["active", "extended"] } },
      {
        $set: {
          waitingMonitorHeartbeatAt: new Date(),
          lastError: `Waiting monitor iteration failed: ${error?.message ?? error}`,
        },
        $inc: { waitingMonitorFailureCount: 1 },
      },
      { returnDocument: "after", lean: true },
    );
    if (!session || session.waitingMonitorFailureCount < 3) return false;
    await SplitProcessSession.updateOne(
      { sessionId, status: "active", waitingMonitorStatus: { $in: ["active", "extended"] } },
      { $set: { waitingMonitorStatus: "failed" } },
    );
    return true;
  }
  
  async function createRestoredWaitingGroup({ session, guild, waitingChannel, waitingMembers }) {
    if (waitingMembers.length < 3 || !session.parentChannelId) return false;
    const parentChannel = await guild.channels.fetch(session.parentChannelId).catch(() => null);
    if (!parentChannel?.isVoiceBased?.()) return false;
    const members = waitingMembers.slice(0, 3);
    const addedRoleIds = new Set();
    const addRoleIfNeeded = async (member) => {
      if (!session.participantRoleId || member.roles.cache.has(session.participantRoleId)) return;
      await member.roles.add(session.participantRoleId, "Restored split waiting-room group creation");
      try {
        await VoiceParticipantRoleGrant.updateOne(
          {
            guildId: guild.id,
            memberId: member.id,
            roleId: session.participantRoleId,
            sourceType: "splitvc",
            sourceId: session.sessionId,
          },
          {
            $set: {
              grantedByBot: true,
              grantedAt: new Date(),
              status: "active",
              removedAt: null,
              cleanupAt: null,
            },
            $setOnInsert: {
              guildId: guild.id,
              memberId: member.id,
              roleId: session.participantRoleId,
              sourceType: "splitvc",
              sourceId: session.sessionId,
            },
          },
          { upsert: true },
        );
      } catch (error) {
        await member.roles.remove(session.participantRoleId, "Rollback untracked restored split role").catch((rollbackError) => {
          console.error(`Failed to roll back untracked restored split role for ${member.id}: ${rollbackError.message}`);
        });
        throw error;
      }
      addedRoleIds.add(member.id);
    };
    const rollbackAddedRoles = async () => Promise.all(
      [...addedRoleIds].map((memberId) => guild.members.fetch(memberId)
        .then((member) => removeVoiceParticipantRole(member, session.participantRoleId, {
          sourceType: "splitvc",
          sourceId: session.sessionId,
        }))
        .catch((error) => logRecoverableError("Recoverable asynchronous operation failed", error))),
    );
    let createdChildChannelId = null;
  
    try {
      const seedMember = members[0];
      await addRoleIfNeeded(seedMember);
      await seedMember.voice.setChannel(parentChannel, "Restored split waiting-room group seed");
      const startedAt = Date.now();
      let childChannel = null;
      while (Date.now() - startedAt < PB_CHILD_WAIT_MS) {
        const candidate = seedMember.voice.channel;
        const expectedCategoryId = session.childCategoryId ?? parentChannel.parentId;
        if (
          candidate?.isVoiceBased?.()
          && candidate.id !== parentChannel.id
          && candidate.id !== waitingChannel.id
          && (!expectedCategoryId || candidate.parentId === expectedCategoryId)
        ) {
          childChannel = candidate;
          break;
        }
        await sleep(750);
      }
      if (!childChannel) {
        await seedMember.voice.setChannel(waitingChannel, "Restore waiting-room after PB child detection failed").catch((error) => logRecoverableError("Failed to restore member to waiting VC", error));
        await rollbackAddedRoles();
        return false;
      }
      createdChildChannelId = childChannel.id;
  
      const movedMemberIds = [seedMember.id];
      for (const member of members.slice(1)) {
        try {
          await addRoleIfNeeded(member);
          await member.voice.setChannel(childChannel, "Restored split waiting-room group member");
          movedMemberIds.push(member.id);
        } catch (error) {
          if (addedRoleIds.has(member.id)) {
            await removeVoiceParticipantRole(member, session.participantRoleId, {
              sourceType: "splitvc",
              sourceId: session.sessionId,
            }).catch((rollbackError) => {
              console.error(`Failed to roll back restored split role for ${member.id}: ${rollbackError.message}`);
            });
            addedRoleIds.delete(member.id);
          }
          waitingMemberRetryAfter.set(`${guild.id}:${member.id}`, Date.now() + 15_000);
          console.error(`Failed to move restored split waiting member ${member.id}: ${error.message}`);
        }
      }
      const persisted = await SplitProcessSession.updateOne(
        { sessionId: session.sessionId, status: "active", waitingMonitorStatus: { $in: ["active", "extended"] }, waitingMonitorLeaseOwner: waitingMonitorLeaseOwner },
        {
          $addToSet: {
            participantMemberIds: { $each: movedMemberIds },
            participantRoleGrantedMemberIds: { $each: movedMemberIds.filter((memberId) => addedRoleIds.has(memberId)) },
            childChannelIds: childChannel.id,
          },
          $push: {
            groupSnapshots: {
              groupNumber: (session.groupSnapshots?.length ?? 0) + 1,
              channelId: childChannel.id,
              memberIds: movedMemberIds,
            },
          },
          $set: { waitingMonitorHeartbeatAt: new Date(), waitingMonitorFailureCount: 0 },
        },
      );
      if (persisted.matchedCount !== 1 || persisted.modifiedCount !== 1) {
        throw new Error("Restored waiting-group persistence did not update the active session.");
      }
      return true;
    } catch (error) {
      if (createdChildChannelId) {
        await Promise.all(members.map(async (member) => {
          if (member.voice.channelId === createdChildChannelId) {
            await member.voice.setChannel(waitingChannel, "Rollback restored waiting group after persistence failure");
          }
        })).catch((rollbackError) => logRecoverableError("Failed to return restored waiting members", rollbackError));
        await guild.channels.fetch(createdChildChannelId)
          .then((channel) => channel?.delete("Rollback restored waiting child after persistence failure"))
          .catch((rollbackError) => logRecoverableError("Failed to delete restored waiting child", rollbackError));
      }
      await rollbackAddedRoles();
      await sendOperationalLog({
        guild,
        settings: await getGuildSettings(guild.id).catch(() => null),
        fallbackChannel: null,
        content: `復元した途中参加の新規グループ作成に失敗しました。セッション: ${session.sessionId}、エラー: ${error?.message ?? error}`,
      }).catch((error) => logRecoverableError("Recoverable asynchronous operation failed", error));
      return false;
    }
  }
  
  async function processRestoredWaitingMonitor(sessionId, guild) {
    if (restoredWaitingMonitorLocks.has(sessionId)) return;
    restoredWaitingMonitorLocks.add(sessionId);
    try {
      const session = await claimWaitingMonitorLease(sessionId);
      if (!session) {
        const current = await SplitProcessSession.findOne({
          sessionId,
          status: "active",
          waitingMonitorStatus: { $in: ["active", "extended"] },
        }).lean();
        const leaseUntil = current?.waitingMonitorLeaseUntil
          ? new Date(current.waitingMonitorLeaseUntil)
          : null;
        if (leaseUntil && Number.isFinite(leaseUntil.getTime()) && leaseUntil.getTime() > Date.now()) {
          // Keep the interval alive while another process owns the old lease.
          // The next interval after this timestamp acquires it if the owner is gone.
          await SplitProcessSession.updateOne(
            { sessionId, waitingMonitorLeaseUntil: current.waitingMonitorLeaseUntil },
            { $set: { waitingMonitorLeaseRetryAt: leaseUntil } },
          );
          return;
        }
        if (current) {
          // Another process may have renewed or released the lease between the
          // claim and this read.  Keep monitoring and try again next interval.
          return;
        }
        clearRestoredWaitingMonitor(sessionId);
        return;
      }
      const waitingChannel = await guild.channels.fetch(session.waitingChannelId).catch(() => null);
      if (!waitingChannel?.isVoiceBased?.()) {
        const splitStartMessage = await fetchSplitStartAnnouncement(guild, session);
        await editSplitStartAnnouncementClosed(splitStartMessage);
        await SplitProcessSession.updateOne({ sessionId }, { $set: { waitingMonitorStatus: "closed", waitingMonitorClosedAt: new Date(), waitingVcCleanupCompleted: true } });
        clearRestoredWaitingMonitor(sessionId);
        return;
      }
      const hasWaitingExtensionChildChannel = await shouldKeepWaitingRoomAlive({
        guild,
        childChannelIds: session.childChannelIds ?? [],
      });
      const monitorEndsAt = new Date(session.waitingMonitorEndsAt).getTime();
      if (Number.isFinite(monitorEndsAt) && Date.now() >= monitorEndsAt) {
        if (hasWaitingExtensionChildChannel) {
          const extended = await SplitProcessSession.updateOne(
            { sessionId, waitingMonitorLeaseOwner: waitingMonitorLeaseOwner, waitingMonitorStatus: "active" },
            { $set: { waitingMonitorStatus: "extended", waitingMonitorExtendedAt: new Date() } },
          );
          if (extended.matchedCount === 1) {
            const splitStartMessage = await fetchSplitStartAnnouncement(guild, session);
            await editSplitStartAnnouncementExtended(splitStartMessage, waitingChannel);
          }
        } else {
          const closing = await SplitProcessSession.findOneAndUpdate(
            { sessionId, status: "active", waitingMonitorStatus: { $in: ["active", "extended"] }, waitingMonitorLeaseOwner: waitingMonitorLeaseOwner },
            { $set: { waitingMonitorStatus: "closing" }, $unset: { waitingMonitorLeaseOwner: 1, waitingMonitorLeaseUntil: 1 } },
            { returnDocument: "after", lean: true },
          );
          if (closing) {
            const operationChannel = await guild.channels.fetch(session.operationChannelId).catch(() => null);
            const splitStartMessage = await fetchSplitStartAnnouncement(guild, session);
            await notifyWaitingVcClosure(operationChannel, waitingChannel).catch((error) => logRecoverableError("Recoverable asynchronous operation failed", error));
            await editSplitStartAnnouncementClosed(splitStartMessage);
            try {
              await waitingChannel.delete();
            } catch (error) {
              await SplitProcessSession.updateOne(
                { sessionId, waitingMonitorStatus: "closing" },
                {
                  $set: {
                    waitingMonitorStatus: "failed",
                    waitingVcCleanupCompleted: false,
                    lastError: `Restored waiting VC cleanup failed: ${error?.message ?? error}`,
                  },
                },
              );
              await sendOperationalLog({
                guild,
                settings: await getGuildSettings(guild.id).catch(() => null),
                fallbackChannel: operationChannel,
                content: `再開した途中参加監視の待機VC削除に失敗しました: ${error?.message ?? error}`,
              }).catch((error) => logRecoverableError("Recoverable asynchronous operation failed", error));
              clearRestoredWaitingMonitor(sessionId);
              return;
            }
            await SplitProcessSession.updateOne(
              { sessionId, waitingMonitorStatus: "closing" },
              { $set: { waitingMonitorStatus: "closed", waitingMonitorClosedAt: new Date(), waitingVcCleanupCompleted: true } },
            );
          }
          clearRestoredWaitingMonitor(sessionId);
          return;
        }
      }
      const settings = await getGuildSettings(guild.id);
      const splitMode = normalizeSessionSplitMode(session);
      const parentChannel = session.parentChannelId
        ? await guild.channels.fetch(session.parentChannelId).catch(() => null)
        : null;
      const childCategory = session.childCategoryId
        ? await guild.channels.fetch(session.childCategoryId).catch(() => null)
        : null;
      const participantRole = session.participantRoleId
        ? guild.roles.cache.get(session.participantRoleId) ?? await guild.roles.fetch(session.participantRoleId).catch(() => null)
        : null;
      if ((splitMode === "partybeast" && !parentChannel?.isVoiceBased?.()) || (splitMode === "direct" && childCategory?.type !== ChannelType.GuildCategory) || !participantRole) {
        throw new Error("Restored waiting monitor configuration is no longer available.");
      }
      const groupingState = await getSplitGroupingState(guild.id).catch(() => null);
      const previousGroups = groupingState?.current?.sessionId === session.sessionId
        ? groupingState?.previous?.groups ?? []
        : groupingState?.current?.groups ?? groupingState?.previous?.groups ?? [];
      const nextDirectGroupNumber = [...(session.groupSnapshots ?? []), ...(session.childChannelStates ?? [])].reduce(
        (max, group) => Math.max(max, Number(group.groupNumber) || 0),
        0,
      ) + 1;
      await processWaitingRoom({
        channel: await guild.channels.fetch(session.operationChannelId).catch(() => null),
        guild,
        waitingChannel,
        parentChannel,
        splitMode,
        participantRole,
        childCategoryId: session.childCategoryId ?? null,
        childChannelIds: new Set(session.childChannelIds ?? []),
        participantMemberIds: new Set(session.participantMemberIds ?? []),
        participantRoleGrantedMemberIds: new Set(session.participantRoleGrantedMemberIds ?? []),
        state: { ended: false },
        settings,
        previousPairKeys: getPairKeysFromGroups(previousGroups),
        splitSessionId: session.sessionId,
        currentGroupMembers: new Map(
          (session.groupSnapshots ?? []).map((group) => [group.channelId, new Set(group.memberIds ?? [])]),
        ),
        nextDirectGroupNumber,
      });
      await SplitProcessSession.updateOne({ sessionId }, { $set: { waitingMonitorHeartbeatAt: new Date() } });
    } finally {
      restoredWaitingMonitorLocks.delete(sessionId);
    }
  }
  
  function startRestoredWaitingMonitor(session, guild) {
    clearRestoredWaitingMonitor(session.sessionId);
    const timer = setInterval(() => {
      void processRestoredWaitingMonitor(session.sessionId, guild).catch((error) => {
        console.error(`Restored waiting monitor failed for ${session.sessionId}:`, error);
      }).finally(() => requestOperationalStatusRefresh(guild.id, "split-waiting-monitor"));
    }, WAITING_ROOM_POLL_MS);
    restoredWaitingMonitorTimers.set(session.sessionId, timer);
    void processRestoredWaitingMonitor(session.sessionId, guild).finally(() => requestOperationalStatusRefresh(guild.id, "split-waiting-monitor"));
  }
  
  async function restoreSplitProcessSessions() {
    if (mongoose.connection.readyState !== 1) return;
    const sessions = await SplitProcessSession.find({
      $or: [
        { status: { $in: ["active", "finish_notice_pending", "role_remove_pending", "cleaning_up", "feedback_open"] } },
        { splitMode: "direct", status: "cleanup_required" },
        { splitMode: "direct", status: { $in: ["completed", "canceled"] }, childChannelsCleanupCompleted: { $ne: true } },
      ],
    }).lean();
    let restored = 0;
    for (const session of sessions) {
      try {
        const guild = client.guilds.cache.get(session.guildId) ?? await client.guilds.fetch(session.guildId).catch(() => null);
        if (!guild) continue;
        if (session.waitingRollbackTasks?.length) {
          await processWaitingRollbackTasks(session.sessionId, guild);
        }
        if (session.phase === "transfer_waiting" && normalizeSessionSplitMode(session) === "direct" && session.childChannelIds?.length) {
          let cleanupFailed = false;
          for (const channelId of session.childChannelIds) {
            let channel = null;
            try {
              channel = await guild.channels.fetch(channelId);
            } catch (error) {
              if (error?.code !== 10003) {
                cleanupFailed = true;
                logRecoverableError(`Failed to fetch interrupted direct splitvc channel ${channelId}`, error);
              }
            }
            if (channel) {
              await channel.delete("Remove direct splitvc channels left by interrupted transfer").catch((error) => {
                cleanupFailed = true;
                logRecoverableError(`Failed to remove interrupted direct splitvc channel ${channelId}`, error);
              });
            }
          }
          const grantedRows = await VoiceParticipantRoleGrant.find({
            guildId: session.guildId,
            sourceType: "splitvc",
            sourceId: session.sessionId,
            status: "active",
          }).lean().catch((error) => {
            cleanupFailed = true;
            logRecoverableError(`Failed to find interrupted direct splitvc role grants ${session.sessionId}`, error);
            return [];
          });
          if (grantedRows.length > 0) {
            const roleRemoval = await removeRoleFromMembers(
              guild,
              session.participantRoleId,
              grantedRows.map((row) => row.memberId),
              { sourceType: "splitvc", sourceId: session.sessionId },
            ).catch((error) => {
              cleanupFailed = true;
              logRecoverableError(`Failed to remove interrupted direct splitvc participant roles ${session.sessionId}`, error);
              return { failed: grantedRows.length };
            });
            if (roleRemoval.failed > 0) cleanupFailed = true;
          }
          await SplitProcessSession.updateOne(
            { sessionId: session.sessionId, status: "active" },
            {
              $set: {
                status: cleanupFailed ? "cleanup_required" : "canceled",
                phase: cleanupFailed ? "cleanup_required" : "canceled",
                ...(cleanupFailed ? {} : {
                  childChannelIds: [],
                  childChannelStates: [],
                  childChannelsCleanupCompleted: true,
                }),
                completedAt: new Date(),
                lastError: cleanupFailed
                  ? "Bot restarted before direct transfer completed; direct VC cleanup is still required"
                  : "Bot restarted before direct transfer completed",
              },
            },
          );
          if (cleanupFailed && normalizeSessionSplitMode(session) === "direct") {
            startDirectChildMonitor({ sessionId: session.sessionId }, guild);
          }
          continue;
        }
        if (session.phase === "transfer_waiting" && !(session.childChannelIds?.length)) {
          await SplitProcessSession.updateOne(
            { sessionId: session.sessionId, status: "active" },
            { $set: { status: "canceled", phase: "canceled", lastError: "Bot restarted before transfer completed" } },
          );
          continue;
        }
        if (session.status === "cleanup_required" && normalizeSessionSplitMode(session) === "direct") {
          startDirectChildMonitor(session, guild);
          restored += 1;
          continue;
        }
        if (
          session.status === "active"
          && session.waitingChannelId
          && ["active", "extended"].includes(session.waitingMonitorStatus)
        ) {
          startRestoredWaitingMonitor(session, guild);
        }
        if (normalizeSessionSplitMode(session) === "direct" && session.childChannelIds?.length && !session.childChannelsCleanupCompleted) {
          startDirectChildMonitor(session, guild);
        }
        if (
          normalizeSessionSplitMode(session) === "direct"
          && ["active", "finish_notice_pending"].includes(session.status)
          && !session.finishNoticeSent
          && session.finishNoticeAt
          && new Date(session.finishNoticeAt).getTime() <= Date.now()
        ) {
          void recoverOverdueDirectFinishNotice(session, guild).catch((error) => {
            console.error(`Failed to recover overdue direct splitvc finish notice ${session.sessionId}: ${error.message}`);
          });
        }
        if (["completed", "canceled"].includes(session.status)) {
          restored += 1;
          continue;
        }
        if (session.status === "active" && !session.finishNoticeSent) { restored += 1; continue; }
        const roleRemoveAt = session.roleRemoveAt ? new Date(session.roleRemoveAt).getTime() : Date.now();
        const roleId = session.participantRoleId;
        const memberIds = session.reviewEligibleMemberIds ?? session.participantMemberIds ?? [];
        if (roleId && memberIds.length) {
          await schedulePersistentRoleRemoval({
            actionKey: `split-role-remove:${session.sessionId}`,
            type: "split_role_remove",
            guild,
            roleId,
            memberIds,
            delayMs: Math.max(0, roleRemoveAt - Date.now()),
            timers: callWaitRoleRemovalTimers,
            payload: { sessionId: session.sessionId, kokuchiEventId: session.kokuchiEventId ?? null, kokuchiEventRevision: session.kokuchiEventRevision ?? null },
          }).catch((error) => console.error(`Failed to restore split role removal: ${error.message}`));
        }
        restored += 1;
      } catch (error) {
        console.error(`Failed to restore split session ${session.sessionId}: ${error.message}`);
      }
    }
    console.log(`Startup split sessions restored: ${restored}`);
  }
  
  function formatKokuchiMessage({ weekday, overviewChannelId }) {
    const eventTime = normalizeKokuchiEventTime(arguments[0]?.eventTime) ?? "21:00";
    const weekdayLabel = weekday === "土" ? "土曜日" : "火曜日";
    const lines = [
      `<@&1506629235438129323> 本日は${weekdayLabel}！`,
      `${normalizeKokuchiEventTime(eventTime) ?? "21:00"}から会話練習会です！`,
      `（概要は <#${overviewChannelId}> から）`,
    ];
  
    lines.push(
      "",
      "ただ雑談したい方はもちろん、少しずつ会話に慣れていきたいという方にも参加していただきたいです！",
      "時間の都合が合う方はぜひご参加ください！！",
    );
  
    return lines.join("\n");
  }
  
  function formatSplitStartAnnouncement(waitingChannel) {
    return [
      "集合開始から5分経ったのでスタートします",
      `スタート後も10分までなら途中参加を受け付けているのでぜひ${waitingChannel}からご参加ください！`,
    ].join("\n");
  }
  
  function formatSplitStartExtendedAnnouncement(waitingChannel) {
    return `まだ途中参加可能です。ぜひ${waitingChannel}からご参加ください。`;
  }
  
  function formatSplitStartClosedAnnouncement() {
    return [
      "集合開始から５分経ったのでスタートします",
      "人数が集まったので途中参加は締め切られました。",
    ].join("\n");
  }
  
  async function editSplitStartAnnouncementExtended(message, waitingChannel) {
    if (!message) {
      return;
    }
  
    await editSafely(message, {
      content: formatSplitStartExtendedAnnouncement(waitingChannel),
      allowedMentions: { parse: [] },
    });
  }
  
  async function editSplitStartAnnouncementClosed(message) {
    if (!message) {
      return;
    }
  
    await editSafely(message, {
      content: formatSplitStartClosedAnnouncement(),
      allowedMentions: { parse: [] },
    });
  }
  
  async function fetchSplitStartAnnouncement(guild, session) {
    if (!guild || !session?.splitStartMessageChannelId || !session?.splitStartMessageId) {
      return null;
    }
  
    const channel = await guild.channels.fetch(session.splitStartMessageChannelId).catch(() => null);
    if (!channel?.messages?.fetch) {
      return null;
    }
  
    return channel.messages.fetch(session.splitStartMessageId).catch(() => null);
  }
  
  function getWadaiTopics(settings) {
    const useSavedTopics = settings?.wadaiTopicsVersion === 2;
    const savedTopics =
      useSavedTopics && settings?.wadaiTopics && typeof settings.wadaiTopics === "object"
        ? settings.wadaiTopics
        : {};
    const topics = {};
  
    for (const category of Object.keys(WADAI_CATEGORIES)) {
      const hasSavedCategory = Object.prototype.hasOwnProperty.call(
        savedTopics,
        category,
      );
      const rawTopics =
        hasSavedCategory && Array.isArray(savedTopics[category])
          ? savedTopics[category]
          : getDefaultWadaiTopicsForCategory(category);
  
      topics[category] = rawTopics
        .map((topic, index) => normalizeWadaiTopic(topic, category, index))
        .filter(Boolean);
    }
  
    return topics;
  }
  
  function getDefaultWadaiTopicsForCategory(category) {
    return WADAI_CATEGORIES[category].defaults.map((text, index) => ({
      id: `default-${category}-${index + 1}`,
      text,
    }));
  }
  
  function normalizeWadaiTopic(topic, category, index) {
    const text =
      typeof topic === "string"
        ? topic
        : typeof topic?.text === "string"
          ? topic.text
          : "";
    const trimmedText = text.trim();
  
    if (!trimmedText) {
      return null;
    }
  
    const id =
      typeof topic?.id === "string" && topic.id.trim()
        ? topic.id.trim()
        : `topic-${category}-${index + 1}-${trimmedText}`;
  
    return {
      id,
      text: trimmedText,
    };
  }
  
  function formatWadaiList(topics) {
    const lines = [];
  
    for (const category of Object.keys(WADAI_CATEGORIES)) {
      lines.push(WADAI_CATEGORIES[category].heading);
  
      if ((topics[category] ?? []).length === 0) {
        lines.push("（未登録）");
      } else {
        topics[category].forEach((topic, index) => {
          lines.push(`${index + 1}. ${topic.text}`);
        });
      }
  
      lines.push("");
    }
  
    return lines.join("\n").trim();
  }
  
  function parseWadaiTarget(target) {
    const normalized = normalizeWadaiTarget(target);
    const plainMatch = /^(\d+)$/.exec(normalized);
  
    if (plainMatch) {
      return {
        category: "1",
        index: Number(plainMatch[1]),
      };
    }
  
    const match = /^1-(\d+)$/.exec(normalized);
  
    if (!match) {
      return null;
    }
  
    return {
      category: "1",
      index: Number(match[1]),
    };
  }
  
  function normalizeWadaiTarget(target) {
    return target
      .replace(/[０-９]/g, (char) =>
        String.fromCharCode(char.charCodeAt(0) - 0xfee0),
      )
      .replace(/[－ー―]/g, "-")
      .replace(/\s+/g, "");
  }
  
  function createWadaiTopicId(category) {
    return `custom-${category}-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
  }
  
  async function saveGuildSettingsWithCurrent(guildId, currentSettings, patch) {
    // The store performs an atomic $set. Do not merge a stale snapshot here:
    // concurrent /setting operations must not overwrite each other.
    return saveGuildSettings(guildId, patch);
  }
  
  
  
  async function handleTopicRequestMessage(message) {
    if (!message.inGuild() || message.author.bot) {
      return;
    }
  
    if (!message.content.includes("話題を出して")) {
      return;
    }
  
    const session = [...voiceMonitorSessions.values()].find(
      (session) => session.guildId === message.guildId && session.reminderChannelId === message.channelId,
    );
  
    if (!session) {
      return;
    }
  
    const topic = SUGGESTED_TOPICS[Math.floor(Math.random() * SUGGESTED_TOPICS.length)];
    await message.channel.send({ content: `話題の提案です：${topic}` });
  }
  
  async function handleVoiceStateUpdate(oldState, newState) {
    const guild = newState.guild ?? oldState.guild;
    if (!guild) {
      return;
    }
  
    const settings = await getGuildSettings(guild.id);
    const channelChanged = oldState.channelId !== newState.channelId;
    // Mute/deafen/stream/camera changes are not joins or leaves.
    if (!channelChanged) return;
    const changedChannelIds = new Set();
  
    await maybeSendPendingCallWaitStartNotice(guild, settings).catch((error) => logRecoverableError("Pending call-wait notice failed", error));
    await processOteboVoiceStatusSessions(guild, settings).catch((error) => logRecoverableError("Otebo voice status processing failed", error));
  
    if (oldState.channelId) {
      changedChannelIds.add(oldState.channelId);
    }
  
    if (newState.channelId) {
      changedChannelIds.add(newState.channelId);
      const waitingSession = await SplitProcessSession.findOne({
        guildId: guild.id,
        status: "active",
        waitingChannelId: newState.channelId,
        waitingMonitorStatus: { $in: ["active", "extended"] },
      }).lean().catch(() => null);
      if (waitingSession && !localWaitingMonitorSessions.has(waitingSession.sessionId)) {
        startRestoredWaitingMonitor(waitingSession, guild);
      }
    }
  
    const monitoredChannelIds = [];
  
    for (const channelId of changedChannelIds) {
      if (await isVoiceChannelMonitored(guild, settings, channelId)) {
        monitoredChannelIds.push(channelId);
      }
  
      await maybeSendAutoSplitSuggestion(guild, settings, channelId).catch((error) => {
        logRecoverableError("Auto split suggestion processing failed", error);
      });
    }
  
    if (monitoredChannelIds.length > 0 && settings?.voiceReminderEnabled !== false) {
      await Promise.all(
        monitoredChannelIds.map((channelId) =>
          updateVoiceMonitorSession(guild, settings, channelId),
        ),
      );
    }
  
    if (
      oldState.member &&
      oldState.member.user &&
      !oldState.member.user.bot &&
      oldState.channelId &&
      settings?.voiceParticipantRoleId &&
      (await isVoiceChannelMonitored(guild, settings, oldState.channelId))
    ) {
      const memberId = oldState.member.id;
      await queueVoiceParticipantRoleUpdate(guild.id, memberId, async () => {
        const member = await guild.members.fetch(memberId).catch(() => null);
        if (!member) return;
        const ignoredSessionKey = getVoiceMonitorSessionKey(guild.id, oldState.channelId);
        const participantRoleId = voiceMonitorSessions.get(ignoredSessionKey)?.participantRoleId ?? settings.voiceParticipantRoleId;
          await removeVoiceParticipantRole(member, participantRoleId, {
            sourceType: "voice_monitor",
            sourceId: ignoredSessionKey,
          });
      });
    }
  }
  
  function queueVoiceParticipantRoleUpdate(guildId, memberId, task) {
    const key = `${guildId}:${memberId}`;
    const previous = voiceParticipantRoleQueues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(task);
    voiceParticipantRoleQueues.set(key, next);
    return next.finally(() => {
      if (voiceParticipantRoleQueues.get(key) === next) voiceParticipantRoleQueues.delete(key);
    });
  }
  
  async function isMemberCurrentlyInMonitoredVoiceChannel(guild, settings, member) {
    const channelId = member?.voice?.channelId;
    if (!channelId || settings?.voiceReminderEnabled === false) return false;
    const channel = member.voice.channel ?? await guild.channels.fetch(channelId).catch(() => null);
    return Boolean(channel?.isVoiceBased() && getNonBotVoiceMembers(channel).length >= VOICE_MONITOR_MIN_MEMBERS && await isVoiceChannelMonitored(guild, settings, channelId));
  }
  
  function getVoiceMonitorRoleRetryKey({ guildId, memberId, roleId, sourceId }) {
    return `${guildId}:${memberId}:${roleId}:${sourceId}`;
  }
  
  function clearVoiceMonitorRoleRetryState({ guildId, memberId, roleId, sourceId }) {
    const key = getVoiceMonitorRoleRetryKey({ guildId, memberId, roleId, sourceId });
    const timer = voiceParticipantRoleRetryTimers.get(key);
    if (timer) clearTimeout(timer);
    voiceParticipantRoleRetryTimers.delete(key);
    clearVoiceMonitorFinalFailureLogs({ guildId, memberId, roleId, sourceId });
  }
  
  function isDiscordUnknownMemberError(error) {
    return error?.code === 10007 || error?.rawError?.code === 10007;
  }
  
  function getVoiceMonitorRetryOperation(grant) {
    return grant?.status === "removing" ? "解除" : "付与";
  }
  
  async function markExactVoiceMonitorGrantRemoved({ guildId, memberId, roleId, sourceId }) {
    const removedAt = new Date();
    await VoiceParticipantRoleGrant.updateOne(
      { guildId, memberId, roleId, sourceType: "voice_monitor", sourceId },
      {
        $set: {
          status: "removed",
          removedAt,
          cleanupAt: new Date(removedAt.getTime() + 30 * 24 * 60 * 60 * 1000),
          retryCount: 0,
          nextRetryAt: null,
          lastError: null,
        },
      },
    );
    clearVoiceMonitorRoleRetryState({ guildId, memberId, roleId, sourceId });
  }
  
  async function recordVoiceMonitorRoleFailure({ guild, memberId, roleId, sourceId, operation, error, isRetryAttempt = false, ownershipConfirmed }) {
    const now = new Date();
    const filter = { guildId: guild.id, memberId, roleId, sourceType: "voice_monitor", sourceId };
    const existing = await VoiceParticipantRoleGrant.findOne(filter).lean().catch((persistenceError) => {
      logRecoverableError("Failed to read voice participant role failure state", persistenceError);
      return null;
    });
    const isRetryFailure = isRetryAttempt
      && existing?.status === "failed"
      && Number.isInteger(existing?.retryCount);
    // retryCount represents the number of failed retry attempts.  A normal
    // first failure is 0, then retry failures are 1, 2, and the final 3.
    const retryCount = isRetryFailure
      ? Math.min(existing.retryCount + 1, VOICE_PARTICIPANT_ROLE_MAX_RETRIES)
      : 0;
    if (!isRetryFailure) {
      clearVoiceMonitorFinalFailureLogs({ guildId: guild.id, memberId, roleId, sourceId });
      const retryTimerKey = getVoiceMonitorRoleRetryKey({ guildId: guild.id, memberId, roleId, sourceId });
      const pendingTimer = voiceParticipantRoleRetryTimers.get(retryTimerKey);
      if (pendingTimer) {
        clearTimeout(pendingTimer);
        voiceParticipantRoleRetryTimers.delete(retryTimerKey);
      }
    }
    const failureState = {
      status: "failed",
      lastError: error?.message ?? String(error),
      removedAt: null,
      cleanupAt: null,
      retryCount,
      nextRetryAt: null,
    };
    // Never downgrade an already-confirmed bot ownership record merely because
    // this caller could not determine ownership.  A false value is only used
    // for a newly-created failure record.
    if (ownershipConfirmed === true) failureState.grantedByBot = true;
    const result = await VoiceParticipantRoleGrant.findOneAndUpdate(
      filter,
      {
        $set: failureState,
        $setOnInsert: { guildId: guild.id, memberId, roleId, grantedByBot: ownershipConfirmed === true, sourceType: "voice_monitor", sourceId },
      },
      { upsert: true, new: true },
    ).catch((persistenceError) => {
      logRecoverableError("Failed to persist voice participant role failure", persistenceError);
      return null;
    });
    if (!result) return;
    if (result.retryCount >= VOICE_PARTICIPANT_ROLE_MAX_RETRIES) {
      await sendVoiceMonitorFinalFailureLog({ guild, memberId, roleId, sourceId, operation, retryCount: VOICE_PARTICIPANT_ROLE_MAX_RETRIES, error: result.lastError });
      return;
    }
    const delayMs = VOICE_PARTICIPANT_ROLE_RETRY_DELAYS_MS[result.retryCount];
    const retryAt = new Date(now.getTime() + delayMs);
    await VoiceParticipantRoleGrant.updateOne({ _id: result._id }, { $set: { nextRetryAt: retryAt } }).catch(() => {});
    const key = getVoiceMonitorRoleRetryKey({ guildId: guild.id, memberId, roleId, sourceId });
    if (voiceParticipantRoleRetryTimers.has(key)) return;
    const timer = setTimeout(() => {
      voiceParticipantRoleRetryTimers.delete(key);
      void queueVoiceParticipantRoleUpdate(guild.id, memberId, () => retryVoiceMonitorRoleGrant({ guildId: guild.id, memberId, roleId, sourceId })).catch((retryError) => {
        logRecoverableError("Voice participant role retry failed", retryError);
      });
    }, delayMs);
    voiceParticipantRoleRetryTimers.set(key, timer);
  }
  
  function getVoiceMonitorFinalFailureLogKey({ guildId, memberId, roleId, sourceId, operation, retryCount }) {
    return `${guildId}:${memberId}:${roleId}:${sourceId}:${operation}:${retryCount}`;
  }
  
  function clearVoiceMonitorFinalFailureLogs({ guildId, memberId, roleId, sourceId }) {
    const prefix = `${guildId}:${memberId}:${roleId}:${sourceId}:`;
    for (const key of voiceParticipantRoleFinalFailureLogs) {
      if (key.startsWith(prefix)) voiceParticipantRoleFinalFailureLogs.delete(key);
    }
  }
  
  async function sendVoiceMonitorFinalFailureLog({ guild, memberId, roleId, sourceId, operation, retryCount, error }) {
    if (retryCount < VOICE_PARTICIPANT_ROLE_MAX_RETRIES) return;
    const key = getVoiceMonitorFinalFailureLogKey({ guildId: guild.id, memberId, roleId, sourceId, operation, retryCount });
    if (voiceParticipantRoleFinalFailureLogs.has(key)) return;
    const settings = await getGuildSettings(guild.id).catch(() => null);
    const sent = await sendOperationalLog({
      guild,
      settings,
      fallbackChannel: null,
      content: `雑談中ロールの${retryCount >= VOICE_PARTICIPANT_ROLE_MAX_RETRIES ? "最終失敗" : "処理不能"}: guildId=${guild.id} memberId=${memberId} roleId=${roleId} sourceId=${sourceId} 操作=${operation ?? "不明"} retryCount=${retryCount} error=${error ?? "不明"}`,
    }).catch((logError) => logRecoverableError("Failed to send voice monitor final failure log", logError));
    if (sent) voiceParticipantRoleFinalFailureLogs.add(key);
  }
  
  async function sendVoiceMonitorOperationalFailureLog({ guild, memberId, roleId, sourceId, operation, stage = null, error }) {
    const settings = await getGuildSettings(guild.id).catch(() => null);
    await sendOperationalLog({
      guild,
      settings,
      fallbackChannel: null,
      content: `雑談中ロールの処理失敗: guildId=${guild.id} memberId=${memberId} roleId=${roleId} sourceId=${sourceId} 操作=${operation}${stage ? ` stage=${stage}` : ""} error=${error ?? "不明"}`,
    }).catch((logError) => logRecoverableError("Failed to send voice monitor operational failure log", logError));
  }
  
  async function retryVoiceMonitorRoleGrant({ guildId, memberId, roleId, sourceId }) {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return;
    const grant = await VoiceParticipantRoleGrant.findOne({ guildId, memberId, roleId, sourceType: "voice_monitor", sourceId }).lean().catch(() => null);
    if (!grant) {
      clearVoiceMonitorRoleRetryState({ guildId, memberId, roleId, sourceId });
      return;
    }
    let settings;
    try {
      settings = await getGuildSettings(guildId);
    } catch (error) {
      await recordVoiceMonitorRoleFailure({
        guild,
        memberId,
        roleId,
        sourceId,
        operation: "状態取得",
        error,
        isRetryAttempt: true,
        ownershipConfirmed: grant.grantedByBot === true,
      });
      return;
    }
    let member;
    try {
      member = await guild.members.fetch(memberId);
    } catch (error) {
      if (isDiscordUnknownMemberError(error)) {
        await markExactVoiceMonitorGrantRemoved({ guildId, memberId, roleId, sourceId }).catch((persistenceError) => {
          logRecoverableError("Failed to retire departed member voice participant role grant", persistenceError);
        });
        return;
      }
      await recordVoiceMonitorRoleFailure({
        guild,
        memberId,
        roleId,
        sourceId,
        operation: getVoiceMonitorRetryOperation(grant),
        error,
        isRetryAttempt: true,
        ownershipConfirmed: grant.grantedByBot === true,
      });
      return;
    }
    const channelId = sourceId.split(":").at(-1);
    let shouldHaveRole;
    try {
      shouldHaveRole = settings?.voiceReminderEnabled !== false
        && member.voice?.channelId === channelId
        && await isMemberCurrentlyInMonitoredVoiceChannel(guild, settings, member);
    } catch (error) {
      await recordVoiceMonitorRoleFailure({
        guild,
        memberId,
        roleId,
        sourceId,
        operation: "状態取得",
        error,
        isRetryAttempt: true,
        ownershipConfirmed: grant.grantedByBot === true,
      });
      return;
    }
    if (!shouldHaveRole) {
      // A failed add that was rolled back never established bot ownership, so
      // an inactive source can be retired without a Discord role API call.
      if (grant.grantedByBot !== true) {
        await markExactVoiceMonitorGrantRemoved({ guildId, memberId, roleId, sourceId }).catch((error) => {
          logRecoverableError("Failed to retire unowned voice participant role failure", error);
        });
        return;
      }
      await removeVoiceParticipantRole(member, roleId, { sourceType: "voice_monitor", sourceId, isRetryAttempt: true });
      return;
    }
  
    const role = await guild.roles.fetch(roleId).catch(() => null);
    if (!role) {
      await recordVoiceMonitorRoleFailure({ guild, memberId, roleId, sourceId, operation: "付与", error: new Error("参加者ロールが見つかりません"), isRetryAttempt: true, ownershipConfirmed: grant.grantedByBot === true });
      return;
    }
    const roleValidationError = await validateVoiceParticipantRole(guild, role);
    if (roleValidationError) {
      await recordVoiceMonitorRoleFailure({ guild, memberId, roleId, sourceId, operation: "付与", error: new Error(roleValidationError), isRetryAttempt: true, ownershipConfirmed: grant.grantedByBot === true });
      return;
    }
  
    const hadRole = member.roles.cache.has(role.id);
    // A retry record created by a failed add does not establish ownership of a
    // role that someone assigned manually while the retry was waiting.
    if (hadRole && grant?.grantedByBot !== true) {
      await markExactVoiceMonitorGrantRemoved({ guildId, memberId, roleId, sourceId }).catch((error) => logRecoverableError("Failed to clear manual participant role retry", error));
      return;
    }
    try {
      if (!hadRole) await member.roles.add(role, "VC参加者ロールの再試行付与");
      await VoiceParticipantRoleGrant.updateOne(
        { guildId, memberId, roleId, sourceType: "voice_monitor", sourceId },
        {
          $set: {
            grantedByBot: true,
            grantedAt: new Date(),
            status: "active",
            removedAt: null,
            cleanupAt: null,
            retryCount: 0,
            nextRetryAt: null,
            lastError: null,
          },
          $setOnInsert: { guildId, memberId, roleId, sourceType: "voice_monitor", sourceId },
        },
        { upsert: true },
      );
      clearVoiceMonitorRoleRetryState({ guildId, memberId, roleId, sourceId });
    } catch (error) {
      let rollbackFailed = false;
      if (!hadRole) {
        try {
          await member.roles.remove(role, "VC参加者ロール再試行の記録失敗に伴うロール解除");
        } catch (rollbackError) {
          rollbackFailed = true;
          logRecoverableError(`Failed to roll back retried participant role for ${memberId}`, rollbackError);
        }
      }
      await recordVoiceMonitorRoleFailure({ guild, memberId, roleId, sourceId, operation: "付与", error, isRetryAttempt: true, ownershipConfirmed: hadRole || rollbackFailed });
    }
  }
  
  async function findAssociatedTextChannel(guild, voiceChannel, settings) {
    const textTypes = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
  
    if (settings?.voiceReminderChannelId) {
      const configured = await guild.channels.fetch(settings.voiceReminderChannelId).catch(() => null);
      return configured && textTypes.includes(configured.type) ? configured : null;
    }
  
    const channels = [...guild.channels.cache.values()].filter((c) => textTypes.includes(c.type));
  
    // 1) exact name match
    let ch = channels.find((c) => c.name === voiceChannel.name);
    if (ch) return ch;
  
    // 2) same parent + name contains
    if (voiceChannel.parentId) {
      ch = channels.find((c) => c.parentId === voiceChannel.parentId && c.name.includes(voiceChannel.name));
      if (ch) return ch;
    }
  
    // 3) topic contains voice channel id
    ch = channels.find((c) => typeof c.topic === "string" && c.topic.includes(voiceChannel.id));
    if (ch) return ch;
  
    // 4) name starts with
    ch = channels.find((c) => c.name.startsWith(voiceChannel.name));
    if (ch) return ch;
  
    return null;
  }
  
  function createAutoSplitRow(channelId, disabled = false) {
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`auto_split:${channelId}`)
        .setLabel("自動振り分け")
        .setStyle(ButtonStyle.Primary)
        .setDisabled(disabled),
    );
  }
  
  async function maybeSendAutoSplitSuggestion(guild, settings, channelId) {
    const voiceChannel = await guild.channels.fetch(channelId).catch(() => null);
  
    if (!voiceChannel?.isVoiceBased()) {
      return;
    }
  
    const parentChannelIds = getVoiceReminderParentChannelIds(settings);
    if (parentChannelIds.includes(channelId)) {
      return;
    }
  
    const persistedSuggestion = settings?.autoSplitSuggestions?.[channelId];
    const existingMessageId = autoSplitSuggestionMessages.get(channelId) ?? persistedSuggestion?.messageId;
    if (existingMessageId && !autoSplitSuggestionMessages.has(channelId)) {
      autoSplitSuggestionMessages.set(channelId, existingMessageId);
    }
    const isTargetCategory = await isPbChildVoiceChannel(
      guild,
      settings,
      voiceChannel,
    );
  
    if (!isTargetCategory) {
      if (existingMessageId) {
        await deleteAutoSplitSuggestionMessage(
          guild,
          settings,
          voiceChannel,
          existingMessageId,
        );
        autoSplitSuggestionMessages.delete(channelId);
        await clearAutoSplitSuggestion(guild.id, channelId);
      }
  
      return;
    }
  
    const members = getNonBotVoiceMembers(voiceChannel);
  
    if (members.length >= AUTO_SPLIT_THRESHOLD) {
      if (existingMessageId) {
        return;
      }
  
      const reminderChannel = await findAssociatedTextChannel(guild, voiceChannel, settings);
  
      if (!reminderChannel || typeof reminderChannel.send !== "function") {
        return;
      }
  
      const canAutoSplit = Boolean(parentChannelIds.length && settings?.tempRoleId);
      const components = [createAutoSplitRow(channelId, !canAutoSplit)];
      const mentionRoleId = settings?.voiceParticipantRoleId;
      const mentionText = mentionRoleId ? `<@&${mentionRoleId}> ` : "";
      const content =
        `${mentionText}1つのvcに６人以上集まると喋れない人が出てきがちなので当チャンネルでは振り分けを推奨しています。\nまた、振り分け方が決まらないときは下の自動振り分けボタンをご活用ください！` +
        (canAutoSplit
          ? ""
          : "\n※リマインダー対象PB親チャンネルまたは参加者ロールが設定されていないため、自動振り分けは無効です。");
  
      const suggestionMessage = await reminderChannel.send({
        content,
        components,
        allowedMentions: mentionRoleId ? { roles: [mentionRoleId] } : { parse: [] },
      });
  
      autoSplitSuggestionMessages.set(channelId, suggestionMessage.id);
      await persistAutoSplitSuggestion(guild.id, channelId, suggestionMessage);
      return;
    }
  
    if (existingMessageId && members.length < AUTO_SPLIT_THRESHOLD) {
      await deleteAutoSplitSuggestionMessage(
        guild,
        settings,
        voiceChannel,
        existingMessageId,
      );
      autoSplitSuggestionMessages.delete(channelId);
      await clearAutoSplitSuggestion(guild.id, channelId);
    }
  }
  
  async function deleteAutoSplitSuggestionMessage(
    guild,
    settings,
    voiceChannel,
    messageId,
  ) {
    const reminderChannel = await findAssociatedTextChannel(
      guild,
      voiceChannel,
      settings,
    );
  
    if (!reminderChannel || typeof reminderChannel.messages?.fetch !== "function") {
      return;
    }
  
    const message = await reminderChannel.messages.fetch(messageId).catch(() => null);
    if (message) {
      await message.delete().catch(() => null);
    }
  }
  
  async function isVoiceChannelMonitored(guild, settings, channelId) {
    if (!channelId) {
      return false;
    }
  
    const voiceChannel =
      guild.channels.cache.get(channelId) ??
      (await guild.channels.fetch(channelId).catch(() => null));
  
    if (!voiceChannel?.isVoiceBased()) {
      return false;
    }
  
    if (Array.isArray(settings?.voiceMonitorVoiceChannelIds) && settings.voiceMonitorVoiceChannelIds.includes(channelId)) {
      return true;
    }
    return isPbChildVoiceChannel(guild, settings, voiceChannel);
  }
  
  function getVoiceReminderParentChannelIds(settings) {
    const configured = settings?.voiceReminderParentChannelIds
      ?? settings?.voiceReminderParentChannelId;
    return [...new Set(
      (Array.isArray(configured) ? configured : [configured])
        .filter((channelId) => typeof channelId === "string" && channelId.length > 0),
    )];
  }
  
  async function resolveVoiceReminderParentChannel(guild, settings, sourceChannel = null) {
    const parentChannels = (await Promise.all(
      getVoiceReminderParentChannelIds(settings).map((channelId) =>
        guild.channels.fetch(channelId).catch(() => null),
      ),
    )).filter((channel) => channel?.isVoiceBased());
  
    return parentChannels.find((channel) =>
      sourceChannel?.parentId && channel.parentId === sourceChannel.parentId,
    ) ?? parentChannels[0] ?? null;
  }
  
  async function isPbChildVoiceChannel(guild, settings, voiceChannel) {
    if (!voiceChannel?.isVoiceBased()) {
      return false;
    }
  
    const parentChannelIds = getVoiceReminderParentChannelIds(settings);
    if (!parentChannelIds.length || parentChannelIds.includes(voiceChannel.id)) {
      return false;
    }
  
    const parentChannels = (await Promise.all(
      parentChannelIds.map((channelId) => guild.channels.fetch(channelId).catch(() => null)),
    )).filter((channel) => channel?.isVoiceBased());
    if (parentChannels.length === 0) {
      return false;
    }
  
    const targetCategoryId = settings.voiceReminderChildCategoryId ?? settings.childCategoryId;
    if (targetCategoryId) {
      return voiceChannel.parentId === targetCategoryId;
    }
  
    const parentCategoryIds = new Set(
      parentChannels.map((channel) => channel.parentId).filter(Boolean),
    );
    return parentCategoryIds.has(voiceChannel.parentId);
  }
  
  function getNonBotVoiceMembers(voiceChannel) {
    return [...voiceChannel.members.values()].filter((member) => !member.user.bot);
  }
  
  function getVoiceMonitorSessionKey(guildId, channelId) {
    return `${guildId}:${channelId}`;
  }
  
  async function isMemberInActiveVoiceMonitorContext(
    guild,
    settings,
    memberId,
    ignoredSessionKey = null,
  ) {
    for (const session of voiceMonitorSessions.values()) {
      const sessionKey = getVoiceMonitorSessionKey(session.guildId, session.voiceChannelId);
  
      if (
        session.guildId === guild.id &&
        sessionKey !== ignoredSessionKey &&
        session.memberIds.has(memberId)
      ) {
        return true;
      }
    }
  
    for (const voiceState of guild.voiceStates.cache.values()) {
      if (voiceState.member?.id !== memberId || !voiceState.channelId) {
        continue;
      }
  
      const sessionKey = getVoiceMonitorSessionKey(guild.id, voiceState.channelId);
  
      if (sessionKey === ignoredSessionKey) {
        continue;
      }
  
      if (voiceMonitorSessions.has(sessionKey)) {
        return true;
      }
  
      const voiceChannel =
        guild.channels.cache.get(voiceState.channelId) ??
        (await guild.channels.fetch(voiceState.channelId).catch(() => null));
  
      if (
        voiceChannel?.isVoiceBased() &&
        getNonBotVoiceMembers(voiceChannel).length >= VOICE_MONITOR_MIN_MEMBERS &&
        (await isVoiceChannelMonitored(guild, settings, voiceState.channelId))
      ) {
        return true;
      }
    }
  
    return false;
  }
  
  async function updateVoiceMonitorSession(guild, settings, channelId, options = {}) {
    const voiceChannel = await guild.channels.fetch(channelId).catch(() => null);
  
    if (!voiceChannel?.isVoiceBased()) {
      return;
    }
  
    const members = getNonBotVoiceMembers(voiceChannel);
  
    const sessionKey = getVoiceMonitorSessionKey(guild.id, channelId);
    const existingSession = voiceMonitorSessions.get(sessionKey);
  
    if (members.length >= VOICE_MONITOR_MIN_MEMBERS) {
      if (!existingSession) {
        const pendingDeletion = voiceMonitorPendingFormDeletions.get(sessionKey);
  
        if (pendingDeletion) {
          clearTimeout(pendingDeletion.timer);
          voiceMonitorPendingFormDeletions.delete(sessionKey);
          const resumedSession = pendingDeletion.session;
          resumedSession.stopTimer = null;
          voiceMonitorSessions.set(sessionKey, resumedSession);
          await ensureSessionMembersHaveRole(resumedSession, voiceChannel, members);
          return;
        }
  
        const session = {
          guildId: guild.id,
          voiceChannelId: channelId,
          participantRoleId: settings.voiceParticipantRoleId,
          memberIds: new Set(),
          topicForms: new Map(),
          stopTimer: null,
        };
  
        voiceMonitorSessions.set(sessionKey, session);
        await startVoiceMonitorSession(session, voiceChannel, members, settings, options);
        return;
      }
  
      if (existingSession.stopTimer) {
        clearTimeout(existingSession.stopTimer);
        existingSession.stopTimer = null;
      }
  
      const pendingDeletion = voiceMonitorPendingFormDeletions.get(sessionKey);
      if (pendingDeletion) {
        clearTimeout(pendingDeletion.timer);
        voiceMonitorPendingFormDeletions.delete(sessionKey);
      }
  
      await ensureSessionMembersHaveRole(existingSession, voiceChannel, members);
  
      return;
    }
  
    if (existingSession && !existingSession.stopTimer) {
      scheduleVoiceMonitorTopicFormDeletion(existingSession);
  
      existingSession.stopTimer = setTimeout(() => {
        void stopVoiceMonitorSessionIfStillUnderfilled(
          existingSession,
          guild,
          channelId,
          settings,
        ).catch((error) => {
          console.error(error);
        });
      }, VOICE_MONITOR_STOP_DELAY_MS);
    }
  }
  
  async function stopVoiceMonitorSessionIfStillUnderfilled(
    session,
    guild,
    channelId,
    settings,
  ) {
    const sessionKey = getVoiceMonitorSessionKey(guild.id, channelId);
  
    if (voiceMonitorSessions.get(sessionKey) !== session) {
      return;
    }
  
    const voiceChannel = await guild.channels.fetch(channelId).catch(() => null);
  
    if (
      voiceChannel?.isVoiceBased() &&
      getNonBotVoiceMembers(voiceChannel).length >= VOICE_MONITOR_MIN_MEMBERS
    ) {
      session.stopTimer = null;
      return;
    }
  
    await stopVoiceMonitorSession(session, guild, voiceChannel, settings);
  }
  
  async function startVoiceMonitorSession(session, voiceChannel, members, settings, options = {}) {
    await ensureSessionMembersHaveRole(session, voiceChannel, members);
    await handleOteboVoiceStartedRecruitment(voiceChannel.guild, settings).catch((error) => {
      logRecoverableError("Button recruitment auto-cancel on VC start failed", error);
    });
    if (!options.suppressStartNotice) {
      await sendVoiceMonitorStartNotice(voiceChannel, settings).catch((error) => {
        logRecoverableError("Voice monitor start notice failed", error);
      });
    }
  }
  
  async function handleOteboVoiceStartedRecruitment(guild, settings) {
    const lease = await acquireMongoLease(`${OTEBO_BUTTON_LIFECYCLE_LEASE_PREFIX}:${guild.id}`, { leaseMs: 120_000 });
    if (!lease) return false;
    try {
      settings = await getGuildSettings(guild.id);
      const recruitment = findActiveButtonOteboRecruitment(settings);
      if (!recruitment) return false;
      const claimedSettings = await transitionOteboRecruitment({
        guildId: guild.id,
        recruitmentId: recruitment.id,
        fromStatuses: ["active"],
        toStatus: "auto_cancel_processing",
        patch: { closedReason: "voice_started" },
      });
      if (!claimedSettings) return false;
      const claimedRecruitment = getOteboRecruitment(claimedSettings, recruitment.id) ?? recruitment;
      clearOteboRecruitmentTimers(guild.id, recruitment.id);
      await oteboRecruitmentPanelService.removeOteboRecruitmentPanel(guild).catch((error) => logRecoverableError("Failed to hide Otebo panel during VC-start cancellation", error));
      await deleteOteboRecruitmentMessage(guild, claimedRecruitment).catch(async (error) => {
        logRecoverableError("Failed to delete button recruitment after VC start", error);
        await editOteboRecruitmentMessageClosed(guild, claimedRecruitment, OTEBO_VOICE_STARTED_NOTICE);
      });
      for (const memberId of Object.keys(claimedRecruitment.pendingConfirmations ?? {})) {
        const member = await guild.members.fetch(memberId).catch(() => null);
        await member?.send({ content: OTEBO_VOICE_STARTED_NOTICE, allowedMentions: { parse: [] } }).catch(() => null);
      }
      const roleResult = await callWaitRoleService.replaceRole({
        guild,
        roleId: claimedSettings.callWaitRoleId,
        memberIds: [claimedRecruitment.ownerId],
        sourceType: "voice_started_invite",
        sourceId: claimedRecruitment.id,
        reason: "VC開始によるボタン募集自動取消",
        removalDelayMs: OTEBO_ROLE_REMOVE_MS,
        requiredMemberCount: 1,
      });
      if (!roleResult.ok) {
        await sendOperationalLog({ guild, settings: claimedSettings, fallbackChannel: null, content: `button recruitment auto-cancel role replacement failed guild=${guild.id} recruitment=${claimedRecruitment.id} error=${roleResult.reason ?? "unknown"}` });
        await transitionOteboRecruitment({
          guildId: guild.id,
          recruitmentId: claimedRecruitment.id,
          fromStatuses: ["auto_cancel_processing"],
          toStatus: "auto_cancelled",
          patch: { lastError: roleResult.reason ?? "call_wait_role replacement failed" },
        }).catch(() => null);
        await deleteOteboRecruitmentState(guild.id, claimedSettings, claimedRecruitment.id).catch(() => null);
        const slotId = claimedSettings?.oteboRecruitmentSlot?.slotId;
        if (slotId) await releaseOteboRecruitmentSlot({ guildId: guild.id, slotId, status: "closed", patch: { closedReason: "voice_started_role_failed" } }).catch(() => null);
        await oteboRecruitmentPanelService.ensureOteboRecruitmentPanel(guild).catch(() => null);
        return false;
      }
      try {
        const noticeChannel = await resolveConfiguredTextChannel(guild, getCallWaitNoticeChannelId(claimedSettings));
        if (!noticeChannel) throw new Error("call_wait_notice_channel is unavailable");
        await noticeChannel.send({
          content: `<@&${claimedSettings.callWaitRoleId}> ${OTEBO_VOICE_STARTED_NOTICE}`,
          allowedMentions: { roles: [claimedSettings.callWaitRoleId] },
        });
      } catch (error) {
        await callWaitRoleService.rollbackGeneration({ guild, generationId: roleResult.generation.generationId, reason: "VC開始通知の送信失敗" }).catch(() => null);
        await transitionOteboRecruitment({ guildId: guild.id, recruitmentId: claimedRecruitment.id, fromStatuses: ["auto_cancel_processing"], toStatus: "auto_cancelled", patch: { lastError: `VC開始通知送信失敗: ${error.message}` } }).catch(() => null);
        await deleteOteboRecruitmentState(guild.id, claimedSettings, claimedRecruitment.id).catch(() => null);
        const slotId = claimedSettings?.oteboRecruitmentSlot?.slotId;
        if (slotId) await releaseOteboRecruitmentSlot({ guildId: guild.id, slotId, status: "closed", patch: { closedReason: "voice_started_notice_failed" } }).catch(() => null);
        await oteboRecruitmentPanelService.ensureOteboRecruitmentPanel(guild).catch(() => null);
        await sendOperationalLog({ guild, settings: claimedSettings, fallbackChannel: null, content: `button recruitment VC auto-cancel notice failed guild=${guild.id} recruitment=${claimedRecruitment.id} error=${error.message}` });
        return false;
      }
      const notifiedSettings = await transitionOteboRecruitment({
        guildId: guild.id,
        recruitmentId: claimedRecruitment.id,
        fromStatuses: ["auto_cancel_processing"],
        toStatus: "voice_started_notified",
        patch: {
          roleGenerationId: roleResult.generation.generationId,
          participantRoleGrantedMemberIds: roleResult.grantedMemberIds,
          successNoticeSentAt: new Date().toISOString(),
        },
      });
      if (!notifiedSettings) {
        console.error(`Button recruitment VC auto-cancel state is uncertain: ${claimedRecruitment.id}`);
        return false;
      }
      await saveGuildSettingsWithCurrent(guild.id, notifiedSettings, {
        oteboRecruitmentSlot: {
          ...(notifiedSettings.oteboRecruitmentSlot ?? {}),
          status: "success_notified",
          recruitmentId: claimedRecruitment.id,
          generationId: roleResult.generation.generationId,
        },
      });
      await sendOperationalLog({ guild, settings: notifiedSettings, fallbackChannel: null, content: `button recruitment auto-canceled because VC started guild=${guild.id} recruitment=${claimedRecruitment.id}` });
      await oteboRecruitmentPanelService.removeOteboRecruitmentPanel(guild).catch((error) => logRecoverableError("Failed to hide Otebo panel after VC auto-cancel", error));
      return true;
    } finally {
      await releaseMongoLease(lease).catch((error) => logRecoverableError("Failed to release VC auto-cancel lease", error));
    }
  }
  
  async function persistAutoSplitSuggestion(guildId, channelId, message) {
    await replaceNestedObject({
      guildId,
      path: `autoSplitSuggestions.${channelId}`,
      value: {
        messageId: message.id,
        reminderChannelId: message.channelId,
        createdAt: new Date().toISOString(),
      },
    });
  }
  
  async function clearAutoSplitSuggestion(guildId, channelId) {
    await unsetNestedObject({ guildId, path: `autoSplitSuggestions.${channelId}` });
  }
  
  async function restoreVoiceMonitorSessions() {
    let rebuilt = 0;
    for (const guild of client.guilds.cache.values()) {
      try {
        const settings = await getGuildSettings(guild.id).catch(() => null);
        if (!settings) continue;
        for (const [channelId, suggestion] of Object.entries(settings.autoSplitSuggestions ?? {})) {
          if (suggestion?.messageId) autoSplitSuggestionMessages.set(channelId, suggestion.messageId);
        }
        // Disabling the feature stops new sessions but still cleans up the
        // voice_monitor grants the bot already owns.
        if (settings.voiceReminderEnabled === false) {
          await reconcilePersistedVoiceParticipantRoleGrants(guild, settings);
          continue;
        }
        const candidates = [...guild.channels.cache.values()].filter((channel) => channel.isVoiceBased());
        for (const channel of candidates) {
          try {
            if (getNonBotVoiceMembers(channel).length < VOICE_MONITOR_MIN_MEMBERS) continue;
            if (!(await isVoiceChannelMonitored(guild, settings, channel.id))) continue;
            await updateVoiceMonitorSession(guild, settings, channel.id, { suppressStartNotice: true });
            rebuilt += 1;
          } catch (error) {
            console.error(`Voice monitor restore failed guild=${guild.id} channel=${channel.id}: ${error.message}`);
          }
        }
        await reconcilePersistedVoiceParticipantRoleGrants(guild, settings);
      } catch (error) {
        console.error(`Voice monitor guild restore failed guild=${guild.id}: ${error.message}`);
      }
    }
    console.log(`Startup voice monitor sessions rebuilt: ${rebuilt}`);
  }
  
  async function isPersistedVoiceMonitorGrantInCurrentContext(guild, settings, member, grant) {
    if (
      grant.guildId !== guild.id ||
      grant.sourceType !== "voice_monitor" ||
      settings?.voiceReminderEnabled === false ||
      grant.roleId !== settings?.voiceParticipantRoleId ||
      member?.guild?.id !== guild.id
    ) {
      return false;
    }
  
    const sourcePrefix = `${guild.id}:`;
    if (typeof grant.sourceId !== "string" || !grant.sourceId.startsWith(sourcePrefix)) {
      return false;
    }
  
    const channelId = grant.sourceId.slice(sourcePrefix.length);
    if (
      !channelId ||
      channelId.includes(":") ||
      grant.sourceId !== getVoiceMonitorSessionKey(guild.id, channelId) ||
      member.voice?.channelId !== channelId
    ) {
      return false;
    }
  
    try {
      const voiceChannel =
        guild.channels.cache.get(channelId) ??
        (await guild.channels.fetch(channelId).catch(() => null));
      if (!voiceChannel?.isVoiceBased()) {
        return false;
      }
  
      return (
        await isVoiceChannelMonitored(guild, settings, channelId)
      ) && getNonBotVoiceMembers(voiceChannel).length >= VOICE_MONITOR_MIN_MEMBERS;
    } catch {
      return false;
    }
  }
  
  async function reconcilePersistedVoiceParticipantRoleGrants(guild, settings) {
    const grants = await VoiceParticipantRoleGrant.find({ guildId: guild.id, sourceType: "voice_monitor", status: { $in: [null, "active", "removing", "failed"] } }).lean();
  
    for (const grant of grants) {
      const logStartupFailure = async (stage, error) => sendVoiceMonitorOperationalFailureLog({
        guild,
        memberId: grant.memberId,
        roleId: grant.roleId,
        sourceId: grant.sourceId,
        operation: "起動時整合",
        stage,
        error: error?.message ?? String(error),
      });
  
      try {
        let member;
        try {
          member = await guild.members.fetch(grant.memberId);
        } catch (error) {
          if (isDiscordUnknownMemberError(error)) {
            try {
              await markExactVoiceMonitorGrantRemoved({ guildId: guild.id, memberId: grant.memberId, roleId: grant.roleId, sourceId: grant.sourceId });
            } catch (persistenceError) {
              await logStartupFailure("DB不明メンバー解除", persistenceError);
            }
            continue;
          }
          await recordVoiceMonitorRoleFailure({
            guild,
            memberId: grant.memberId,
            roleId: grant.roleId,
            sourceId: grant.sourceId,
            operation: getVoiceMonitorRetryOperation(grant),
            error,
            isRetryAttempt: grant.status === "failed",
            ownershipConfirmed: true,
          });
          await logStartupFailure("メンバー取得", error);
          continue;
        }
  
        const shouldKeepGrant = await isPersistedVoiceMonitorGrantInCurrentContext(
          guild,
          settings,
          member,
          grant,
        );
  
        if (grant.grantedByBot !== true) {
          try {
            if (shouldKeepGrant) {
              await recordVoiceMonitorRoleFailure({
                guild,
                memberId: grant.memberId,
                roleId: grant.roleId,
                sourceId: grant.sourceId,
                operation: "付与",
                error: new Error("起動時整合で未所有の付与失敗記録を再試行"),
                ownershipConfirmed: false,
              });
            } else {
              await markExactVoiceMonitorGrantRemoved({ guildId: guild.id, memberId: grant.memberId, roleId: grant.roleId, sourceId: grant.sourceId });
            }
          } catch (error) {
            await logStartupFailure(shouldKeepGrant ? "未所有記録再試行登録" : "DB未所有記録解除", error);
          }
          continue;
        }
  
        if (!shouldKeepGrant) {
          try {
            await removeVoiceParticipantRole(member, grant.roleId, {
              sourceType: grant.sourceType,
              sourceId: grant.sourceId,
            });
          } catch (error) {
            await logStartupFailure("ロール解除", error);
          }
          continue;
        }
  
        try {
          await VoiceParticipantRoleGrant.updateOne(
            { _id: grant._id },
            { $set: { status: "active", removedAt: null, cleanupAt: null, retryCount: 0, nextRetryAt: null, lastError: null } },
          );
          clearVoiceMonitorRoleRetryState({ guildId: guild.id, memberId: grant.memberId, roleId: grant.roleId, sourceId: grant.sourceId });
        } catch (error) {
          await logStartupFailure("DB有効化", error);
        }
      } catch (error) {
        await logStartupFailure("予期しない整合処理", error);
      }
    }
  }
  
  async function sendVoiceMonitorStartNotice(voiceChannel, settings) {
    if (settings?.voiceReminderEnabled === false) {
      return;
    }
  
    const noticeChannel = await resolveConfiguredTextChannel(voiceChannel.guild, getCallWaitNoticeChannelId(settings));
    if (!noticeChannel) return;
    const mentionRoleId = settings?.bosyuMentionRoleId;
    await noticeChannel.send({
      content: `${mentionRoleId ? `<@&${mentionRoleId}> ` : ""}<#${voiceChannel.id}> でVCが始まりました。`,
      allowedMentions: mentionRoleId ? { roles: [mentionRoleId] } : { parse: [] },
    });
    return;
  
  }
    /* legacy bosyu-channel fallback retained below only for old source compatibility
  
    const bosyuChannel = await resolveConfiguredTextChannel(
      voiceChannel.guild,
      settings?.bosyuChannelId,
    );
  
    if (!bosyuChannel) {
      return;
    }
  
    const mentionText = settings?.bosyuMentionRoleId
      ? `<@&${settings.bosyuMentionRoleId}> `
      : "";
  
    await bosyuChannel.send({
      content: `${mentionText}<#${voiceChannel.id}> にて通話が始まりました！`,
      allowedMentions: settings?.bosyuMentionRoleId
        ? { roles: [settings.bosyuMentionRoleId] }
        : { parse: [] },
    });
  }
  
  */
  async function deleteVoiceMonitorTopicForms(session) {
    for (const [formId, topicForm] of session.topicForms.entries()) {
      if (topicForm.disableTimer) {
        clearTimeout(topicForm.disableTimer);
      }
  
      const reminderChannel = await client.channels
        .fetch(topicForm.reminderChannelId)
        .catch(() => null);
  
      if (reminderChannel && typeof reminderChannel.messages?.fetch === "function") {
        const formMessage = await reminderChannel.messages
          .fetch(topicForm.messageId)
          .catch(() => null);
  
        if (formMessage) {
          await formMessage.delete().catch(() => null);
        }
      }
  
      topicFormSessions.delete(formId);
    }
  
    session.topicForms.clear();
  }
  
  function scheduleVoiceMonitorTopicFormDeletion(session) {
    const sessionKey = getVoiceMonitorSessionKey(
      session.guildId,
      session.voiceChannelId,
    );
  
    if (voiceMonitorPendingFormDeletions.has(sessionKey)) {
      return;
    }
  
    const timer = setTimeout(() => {
      voiceMonitorPendingFormDeletions.delete(sessionKey);
      void deleteVoiceMonitorTopicForms(session).catch((error) => {
        console.error(`Failed to delete voice topic forms: ${error.message}`, error);
      });
    }, VOICE_MONITOR_FORM_DELETE_DELAY_MS);
  
    voiceMonitorPendingFormDeletions.set(sessionKey, {
      session,
      timer,
    });
  }
  
  async function ensureSessionMembersHaveRole(session, voiceChannel, members) {
    session.memberIds = new Set(members.map((member) => member.id));
  
    if (!session.participantRoleId || members.length < VOICE_MONITOR_MIN_MEMBERS) {
      return;
    }
  
    const role = await voiceChannel.guild.roles
      .fetch(session.participantRoleId)
      .catch(() => null);
  
    if (!role) {
      console.warn(`Voice participant role is missing guild=${voiceChannel.guild.id} role=${session.participantRoleId}`);
      await sendVoiceMonitorOperationalFailureLog({ guild: voiceChannel.guild, memberId: "-", roleId: session.participantRoleId, sourceId: getVoiceMonitorSessionKey(session.guildId, session.voiceChannelId), operation: "設定検証", error: "参加者ロールが見つかりません" });
      return;
    }
  
    const roleValidationError = await validateVoiceParticipantRole(voiceChannel.guild, role);
    if (roleValidationError) {
      console.warn(`Voice participant role is not usable guild=${voiceChannel.guild.id}: ${roleValidationError}`);
      await sendVoiceMonitorOperationalFailureLog({ guild: voiceChannel.guild, memberId: "-", roleId: role.id, sourceId: getVoiceMonitorSessionKey(session.guildId, session.voiceChannelId), operation: "設定検証", error: roleValidationError });
      return;
    }
  
    for (const member of members) {
      await queueVoiceParticipantRoleUpdate(voiceChannel.guild.id, member.id, async () => {
        const currentMember = await voiceChannel.guild.members.fetch(member.id).catch(() => null);
        if (!currentMember || currentMember.voice.channelId !== voiceChannel.id) return;
        if (getNonBotVoiceMembers(voiceChannel).length < VOICE_MONITOR_MIN_MEMBERS) return;
        const hadRole = currentMember.roles.cache.has(role.id);
        // Do not claim a manually assigned role. A role already owned by this
        // bot for another active source may safely gain this session's record.
        const hasBotOwnedGrant = hadRole && await VoiceParticipantRoleGrant.exists({
          guildId: voiceChannel.guild.id,
          memberId: member.id,
          roleId: role.id,
          grantedByBot: true,
          status: { $in: [null, "active", "removing", "failed"] },
        });
        if (hadRole && !hasBotOwnedGrant) {
          // The member acquired this role outside a bot-owned active grant.
          // Retire only this stale failed record and leave the manual role alone.
          await markExactVoiceMonitorGrantRemoved({
            guildId: voiceChannel.guild.id,
            memberId: member.id,
            roleId: role.id,
            sourceId: getVoiceMonitorSessionKey(session.guildId, session.voiceChannelId),
          }).catch((error) => logRecoverableError("Failed to retire manual voice participant role record", error));
          return;
        }
      if (!hadRole) {
        try {
          await member.roles.add(role, "VC参加者ロールを付与");
          try {
            await VoiceParticipantRoleGrant.updateOne(
              {
                guildId: voiceChannel.guild.id,
                memberId: member.id,
                roleId: role.id,
                sourceType: "voice_monitor",
                sourceId: getVoiceMonitorSessionKey(session.guildId, session.voiceChannelId),
              },
              {
                $set: {
                  sourceType: "voice_monitor",
                  sourceId: getVoiceMonitorSessionKey(session.guildId, session.voiceChannelId),
                  grantedByBot: true,
                  grantedAt: new Date(),
                  status: "active",
                  removedAt: null,
                  cleanupAt: null,
                },
                $setOnInsert: { guildId: voiceChannel.guild.id, memberId: member.id, roleId: role.id },
              },
              { upsert: true },
            );
          } catch (error) {
            // A grant without a durable ownership record cannot be reconciled
            // after a restart, so roll it back instead of leaving it untracked.
            let rollbackFailed = false;
            try {
              await member.roles.remove(role, "VC参加者ロール記録の保存失敗に伴うロール解除");
            } catch (rollbackError) {
              rollbackFailed = true;
              logRecoverableError(`Failed to roll back participant role for ${member.id}`, rollbackError);
            }
            console.error(`Failed to persist voice participant role grant for ${member.id}: ${error.message}`);
            await recordVoiceMonitorRoleFailure({ guild: voiceChannel.guild, memberId: member.id, roleId: role.id, sourceId: getVoiceMonitorSessionKey(session.guildId, session.voiceChannelId), operation: "付与", error, ownershipConfirmed: rollbackFailed });
            return;
          }
        } catch (error) {
          console.error(`Failed to add voice participant role to ${member.id}: ${error.message}`);
          await recordVoiceMonitorRoleFailure({ guild: voiceChannel.guild, memberId: member.id, roleId: role.id, sourceId: getVoiceMonitorSessionKey(session.guildId, session.voiceChannelId), operation: "付与", error, ownershipConfirmed: false });
          return;
        }
      }
      // A member moving directly between monitored VCs already has the role,
      // but still needs an ownership record for this session.
      if (!hadRole || hasBotOwnedGrant) {
        const sourceId = getVoiceMonitorSessionKey(session.guildId, session.voiceChannelId);
        await VoiceParticipantRoleGrant.updateOne(
          { guildId: voiceChannel.guild.id, memberId: member.id, roleId: role.id, sourceType: "voice_monitor", sourceId },
          { $set: { sourceType: "voice_monitor", sourceId, grantedByBot: true, grantedAt: new Date(), status: "active", removedAt: null, cleanupAt: null, retryCount: 0, nextRetryAt: null, lastError: null }, $setOnInsert: { guildId: voiceChannel.guild.id, memberId: member.id, roleId: role.id } },
          { upsert: true },
        );
        clearVoiceMonitorRoleRetryState({ guildId: voiceChannel.guild.id, memberId: member.id, roleId: role.id, sourceId });
      }
      });
    }
  }
  
  async function stopVoiceMonitorSession(session, guild, voiceChannel, settings) {
    if (session.stopTimer) {
      clearTimeout(session.stopTimer);
      session.stopTimer = null;
    }
  
    const sessionKey = getVoiceMonitorSessionKey(session.guildId, session.voiceChannelId);
  
    voiceMonitorSessions.delete(sessionKey);
  
    const memberIds = new Set(
      [
        ...session.memberIds,
        ...(voiceChannel?.isVoiceBased()
          ? getNonBotVoiceMembers(voiceChannel).map((member) => member.id)
          : []),
      ],
    );
  
    const participantRoleId = session.participantRoleId ?? settings.voiceParticipantRoleId;
  
    for (const memberId of memberIds) {
      if (!participantRoleId) {
        continue;
      }
  
      const stillInActiveSession = await isMemberInActiveVoiceMonitorContext(
        guild,
        settings,
        memberId,
        sessionKey,
      );
  
      if (!stillInActiveSession) {
        const member = await guild.members.fetch(memberId).catch(() => null);
        if (!member) {
          continue;
        }
  
        await removeVoiceParticipantRole(member, participantRoleId, {
          sourceType: "voice_monitor",
          sourceId: sessionKey,
        });
      }
    }
  
    await oteboRecruitmentPanelService.ensureOteboRecruitmentPanel(guild).catch((error) => {
      logRecoverableError("Failed to reconcile Otebo panel after voice monitor cleanup", error);
    });
  
    // ノーティフィケーションは不要のため送信しない
  }
  
  function createTopicFormRow(formId, disabled = false) {
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`topic_form_button:${formId}`)
        .setLabel(disabled ? "フォーム期限切れ" : "話題フォームを開く")
        .setStyle(ButtonStyle.Primary)
        .setDisabled(disabled),
    );
  }
  
  function createVoiceTopicModal(formId) {
    return new ModalBuilder()
      .setCustomId(`topic_form:${formId}`)
      .setTitle("今の話題を投稿")
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId("voice_topic_input")
            .setLabel("今話している話題を入力してください")
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
            .setMaxLength(400)
            .setPlaceholder("例：ゲームについてしゃべってます！"),
        ),
      );
  }
  
  async function handleTopicFormButton(interaction) {
    const formId = interaction.customId.slice("topic_form_button:".length);
    const topicForm = topicFormSessions.get(formId);
  
    if (!topicForm || Date.now() > topicForm.expiresAt) {
      await interaction.reply({
        content: "このフォームの有効期限が切れました。次のリマインダーをお待ちください。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  
    await interaction.showModal(createVoiceTopicModal(formId));
  }
  
  async function handleAutoSplitButton(interaction) {
    if (!interaction.inGuild()) {
      await replyOrFollowUp(interaction, {
        content: "この操作はサーバー内で実行してください。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  
    const channelId = interaction.customId.slice("auto_split:".length);
    const settings = await getGuildSettings(interaction.guildId);
    const guild = interaction.guild;
    const voiceChannel = await guild.channels.fetch(channelId).catch(() => null);
  
    if (!voiceChannel?.isVoiceBased()) {
      await interaction.reply({
        content: "対象のボイスチャンネルが見つかりませんでした。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  
    const members = [...voiceChannel.members.values()].filter((member) => !member.user.bot);
  
    if (members.length < AUTO_SPLIT_THRESHOLD) {
      await interaction.reply({
        content: "参加人数が6人未満になったため、自動振り分けは実行できませんでした。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  
      const parentChannel = await resolveVoiceReminderParentChannel(
        guild,
        settings,
        voiceChannel,
      );
      const parentChannelId = parentChannel?.id ?? null;
      const participantRole = settings?.tempRoleId
        ? await guild.roles.fetch(settings.tempRoleId).catch(() => null)
        : null;
  
      if (!parentChannelId || !parentChannel?.isVoiceBased() || !participantRole) {
        await interaction.reply({
          content:
            "リマインダー対象PB親チャンネルまたは参加者ロールが未設定のため、自動振り分けを実行できませんでした。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  
    await interaction.update({
      content: "自動振り分けを実行します。少々お待ちください…",
      components: [],
    });
  
    const autoSplitLockKey = `auto-split:${guild.id}:${voiceChannel.id}`;
    if (autoSplitLocks.has(autoSplitLockKey)) {
      await interaction.editReply({ content: "このVCでは、すでに自動分割を処理中です。", components: [] });
      return;
    }
    autoSplitLocks.add(autoSplitLockKey);
    const autoSplitLease = await acquireMongoLease(autoSplitLockKey, { leaseMs: 5 * 60 * 1000 })
      .catch((error) => {
        autoSplitLocks.delete(autoSplitLockKey);
        throw error;
      });
    if (!autoSplitLease) {
      autoSplitLocks.delete(autoSplitLockKey);
      await interaction.editReply({ content: "このVCでは、別のBotプロセスが自動分割を処理中です。", components: [] });
      return;
    }
  
    try {
    const [stayGroup, moveGroup] = splitIntoTwoRandomGroups(members);
    const roleGrantSourceId = `auto-split:${createSessionId()}`;
  
    const transferResult = await transferMembersToPbChildChannel(moveGroup, {
      guild,
      parentChannel,
      childCategoryId: settings.childCategoryId,
      participantRole,
      sourceChannelId: voiceChannel.id,
      roleGrantSourceId,
    });
  
    if (transferResult.participantRoleGrantedMemberIds.length > 0) {
      try {
        await schedulePersistentRoleRemoval({
          actionKey: `auto-split-role-remove:${guild.id}:${roleGrantSourceId}`,
          type: "auto_split_role_remove",
          guild,
          roleId: participantRole.id,
          memberIds: transferResult.participantRoleGrantedMemberIds,
          delayMs: minutesToMs(getNonNegativeInteger(
            settings?.roleRemoveWaitMinutes,
            DEFAULT_ROLE_REMOVE_WAIT_MINUTES,
          )),
          timers: callWaitRoleRemovalTimers,
          payload: { sourceType: "auto_split", sourceId: roleGrantSourceId },
        });
      } catch (error) {
        await removeCallWaitRoleFromMembers(
          guild,
          participantRole.id,
          transferResult.participantRoleGrantedMemberIds,
          { sourceType: "auto_split", sourceId: roleGrantSourceId },
        ).catch((rollbackError) => {
          console.error(`Failed to roll back auto-split participant roles: ${rollbackError.message}`);
        });
        throw error;
      }
    }
  
    const moved = moveGroup.length - transferResult.failed.length;
    const roleFailedText = transferResult.roleFailures.length
      ? ` 参加者ロール付与失敗: ${transferResult.roleFailures.join("、")}`
      : "";
    const failedText = transferResult.failed.length
      ? ` 転送失敗: ${transferResult.failed.join("、")}`
      : "";
  
    await interaction.followUp({
      content: `自動振り分けを完了しました。
  ${transferResult.childChannel ? `<#${transferResult.childChannel.id}>` : "PB子VCの検出に失敗しました。"} へ ${moved}/${moveGroup.length} 人を転送しました。${failedText}${roleFailedText}`,
      allowedMentions: { parse: [] },
    });
  
    autoSplitSuggestionMessages.delete(channelId);
    await clearAutoSplitSuggestion(interaction.guildId, channelId);
    } finally {
      autoSplitLocks.delete(autoSplitLockKey);
      await releaseMongoLease(autoSplitLease).catch((error) => {
        console.error(`Failed to release auto-split lease for ${autoSplitLockKey}: ${error.message}`);
      });
    }
  }
  
  function splitIntoTwoRandomGroups(members) {
    const shuffled = shuffle(members);
    const firstGroupSize = Math.ceil(shuffled.length / 2);
    return [
      shuffled.slice(0, firstGroupSize),
      shuffled.slice(firstGroupSize),
    ];
  }
  
  async function transferMembersToPbChildChannel(members, config) {
    const failures = [];
    const roleFailures = [];
    const participantMemberIds = new Set();
    const participantRoleGrantedMemberIds = new Set();
  
    const addRoleForTransfer = async (member) => {
      if (member.roles.cache.has(config.participantRole.id)) {
        participantMemberIds.add(member.id);
        return null;
      }
  
      try {
        await member.roles.add(config.participantRole, "Participant role for automatic voice grouping");
        try {
          await VoiceParticipantRoleGrant.updateOne(
            {
              guildId: config.guild.id,
              memberId: member.id,
              roleId: config.participantRole.id,
              sourceType: "auto_split",
              sourceId: config.roleGrantSourceId,
            },
            {
              $set: {
                grantedByBot: true,
                grantedAt: new Date(),
                status: "active",
                removedAt: null,
                cleanupAt: null,
              },
              $setOnInsert: {
                guildId: config.guild.id,
                memberId: member.id,
                roleId: config.participantRole.id,
                sourceType: "auto_split",
                sourceId: config.roleGrantSourceId,
              },
            },
            { upsert: true },
          );
        } catch (error) {
          await member.roles.remove(config.participantRole, "Rollback untracked automatic grouping role").catch((rollbackError) => {
            console.error(`Failed to roll back untracked automatic grouping role for ${member.id}: ${rollbackError.message}`);
          });
          throw error;
        }
        participantMemberIds.add(member.id);
        participantRoleGrantedMemberIds.add(member.id);
        return null;
      } catch (error) {
        console.error(`Failed to add automatic grouping role to ${member.id}: ${error.message}`);
        return member.displayName;
      }
    };
  
    const waitForPbChildChannel = async (member) => {
      const startedAt = Date.now();
      while (Date.now() - startedAt < PB_CHILD_WAIT_MS) {
        const channel = member.voice.channel;
        const expectedCategoryId = config.childCategoryId ?? config.parentChannel.parentId;
        if (
          channel?.isVoiceBased?.()
          && channel.id !== config.parentChannel.id
          && channel.id !== config.sourceChannelId
          && (!expectedCategoryId || channel.parentId === expectedCategoryId)
        ) {
          return channel;
        }
        await sleep(750);
      }
      return null;
    };
  
    const rollbackGrantedRoles = async () => Promise.all(
      [...participantRoleGrantedMemberIds].map(async (memberId) => {
        const member = await config.guild.members.fetch(memberId).catch(() => null);
        if (!member) return;
        await removeVoiceParticipantRole(member, config.participantRole.id, {
          sourceType: "auto_split",
          sourceId: config.roleGrantSourceId,
        });
      }),
    );
  
    if (members.length === 0) {
      return { childChannel: null, failed: [], roleFailures, participantRoleGrantedMemberIds: [] };
    }
  
    const seedMember = members[0];
  
    try {
      await seedMember.voice.setChannel(
        config.parentChannel,
        "Move split group seed to PB parent channel",
      );
    } catch {
      failures.push(seedMember.displayName);
    }
  
    const seedRoleFailure = await addRoleForTransfer(
      seedMember,
    );
  
    if (seedRoleFailure) {
      roleFailures.push(seedRoleFailure);
    }
  
    const childChannel = await waitForPbChildChannel(seedMember);
  
    if (!childChannel) {
      await rollbackGrantedRoles();
      return { childChannel: null, failed: [seedMember.displayName], roleFailures, participantRoleGrantedMemberIds: [] };
    }
  
    let movedCount = failures.length === 0 ? 1 : 0;
  
    for (const member of members.slice(1)) {
      try {
        await member.voice.setChannel(
          childChannel,
          "Move group member to PB child channel",
        );
        const roleFailure = await addRoleForTransfer(
          member,
        );
  
        if (roleFailure) {
          roleFailures.push(roleFailure);
        }
  
        movedCount += 1;
      } catch {
        failures.push(member.displayName);
      }
    }
  
    return {
      childChannel,
      failed: failures,
      roleFailures,
      participantMemberIds: [...participantMemberIds],
      participantRoleGrantedMemberIds: [...participantRoleGrantedMemberIds],
    };
  }
  
  async function handleSuggestTopicButton(interaction) {
    const session = [...voiceMonitorSessions.values()].find(
      (session) =>
        interaction.customId === `suggest_topic:${session.voiceChannelId}` &&
        session.guildId === interaction.guildId,
    );
  
    if (!session) {
      await interaction.reply({
        content: "現在、話題提案を行えるセッションがありません。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  
    const topic = SUGGESTED_TOPICS[Math.floor(Math.random() * SUGGESTED_TOPICS.length)];
  
    await interaction.reply({
      content: `話題の提案です：${topic}`,
      flags: MessageFlags.Ephemeral,
    });
  }
  
  async function handleTopicFormModal(interaction) {
    const formId = interaction.customId.slice("topic_form:".length);
    const topicForm = topicFormSessions.get(formId);
  
    if (!topicForm || Date.now() > topicForm.expiresAt) {
      await interaction.reply({
        content: "このフォームの有効期限が切れました。次のリマインダーをお待ちください。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  
    const topicText = interaction.fields.getTextInputValue("voice_topic_input").trim();
    const statusText = formatVoiceTopicStatus(topicText);
  
    if (!statusText) {
      await replyOrFollowUp(interaction, {
        content: "話題を入力してください。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  
    // Require the submitter to be in a VC. If not, reject the submission.
    const posterVoiceChannel = interaction.member?.voice?.channel;
    if (!posterVoiceChannel?.isVoiceBased()) {
      await replyOrFollowUp(interaction, {
        content: "VC参加者のみが使えます",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  
    const voiceChannel = posterVoiceChannel;
  
    try {
      await setVoiceChannelStatus(
        voiceChannel,
        statusText,
        "Update VC status from reminder topic form",
      );
    } catch (error) {
      console.error(`Failed to update voice channel status: ${error?.message ?? error}`);
      await replyOrFollowUp(interaction, {
        content:
          "VCのチャンネルステータス更新に失敗しました。Botに Set Voice Channel Status 権限があるか確認してください。BotがそのVCに入っていない場合は Manage Channels 権限も必要です。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  
    await interaction.reply({
      content: "VCのチャンネルステータスを更新しました。",
      flags: MessageFlags.Ephemeral,
    });
  }
  
  async function removeVoiceParticipantRole(member, roleId, source = null) {
    const clearRetryState = () => {
      if (source?.sourceType === "voice_monitor" && source.sourceId) {
        clearVoiceMonitorRoleRetryState({
          guildId: member.guild.id,
          memberId: member.id,
          roleId,
          sourceId: source.sourceId,
        });
      }
    };
    const activeGrantStatuses = [null, "active", "removing", "failed"];
    const ownershipFilter = {
      guildId: member.guild.id,
      memberId: member.id,
      roleId,
      grantedByBot: true,
      status: { $in: activeGrantStatuses },
      ...(source?.sourceType ? { sourceType: source.sourceType } : {}),
      ...(source?.sourceId != null ? { sourceId: source.sourceId } : {}),
    };
    const grant = await VoiceParticipantRoleGrant.exists(ownershipFilter);
  
    // Only revoke a role that this bot recorded as its own grant.  The same
    // role may also be assigned manually or by another feature.
    if (!grant) {
      clearRetryState();
      return;
    }
  
    const marked = await VoiceParticipantRoleGrant.updateMany(ownershipFilter, {
      $set: {
        status: "removing",
        removedAt: null,
        cleanupAt: null,
      },
    });
    if (!marked || marked.matchedCount < 1) {
      clearRetryState();
      return;
    }
  
    const otherActiveGrant = source?.sourceType
      ? await VoiceParticipantRoleGrant.exists({
        guildId: member.guild.id,
        memberId: member.id,
        roleId,
        grantedByBot: true,
        status: { $in: activeGrantStatuses },
        $nor: [{
          sourceType: source.sourceType,
          ...(source.sourceId != null ? { sourceId: source.sourceId } : {}),
        }],
      })
      : false;
  
    const markRemoved = async () => {
      const removedAt = new Date();
      await VoiceParticipantRoleGrant.updateMany(
        { ...ownershipFilter, status: "removing" },
        {
          $set: {
            status: "removed",
            removedAt,
            cleanupAt: new Date(removedAt.getTime() + 30 * 24 * 60 * 60 * 1000),
            retryCount: 0,
            nextRetryAt: null,
            lastError: null,
          },
        },
      );
    };
  
    if (otherActiveGrant || !member.roles.cache.has(roleId)) {
      await markRemoved();
      clearRetryState();
      return;
    }
  
    try {
      await member.roles.remove(roleId, "VC離脱に伴う参加者ロール解除");
    } catch (error) {
      await VoiceParticipantRoleGrant.updateMany(
        {
          ...ownershipFilter,
          status: "removing",
        },
        { $set: { status: "failed", cleanupAt: null } },
      );
      if (source?.sourceType === "voice_monitor" && source.sourceId) {
        await recordVoiceMonitorRoleFailure({ guild: member.guild, memberId: member.id, roleId, sourceId: source.sourceId, operation: "解除", error, isRetryAttempt: source.isRetryAttempt === true, ownershipConfirmed: true });
      }
      throw error;
    }
  
    await markRemoved();
    clearRetryState();
  }
  
  
  function directChildStateMap(session) {
    return new Map((session?.childChannelStates ?? []).map((state) => [state.channelId, { ...state }]));
  }

  async function persistDirectChildStates(sessionId, states, completed = false) {
    await SplitProcessSession.updateOne(
      { sessionId },
      {
        $set: {
          childChannelStates: [...states.values()],
          childChannelsCleanupCompleted: completed,
        },
      },
    );
  }

  async function markDirectSplitCleanupRequired(sessionId, lastError, guild = null) {
    await SplitProcessSession.updateOne(
      {
        sessionId,
        status: { $in: ["active", "finish_notice_pending", "completed", "canceled", "failed", "cleanup_required"] },
      },
      {
        $set: {
          status: "cleanup_required",
          phase: "cleanup_required",
          lastError,
          completedAt: new Date(),
        },
      },
    ).catch((error) => logRecoverableError(`Failed to mark direct splitvc cleanup required for ${sessionId}`, error));
    if (guild) startDirectChildMonitor({ sessionId }, guild);
  }

  async function deleteDirectChildChannel(channel, reason, logMessage) {
    if (!channel) return true;
    try {
      await channel.delete(reason);
      return true;
    } catch (error) {
      logRecoverableError(logMessage, error);
      return false;
    }
  }

  async function createDirectChildChannels(groups, config) {
    const created = [];
    try {
      for (const [index, group] of groups.entries()) {
        if (!group?.length) continue;
        const channel = await config.guild.channels.create({
          name: `会話練習会(${index + 1})`,
          type: ChannelType.GuildVoice,
          parent: config.childCategoryId,
          userLimit: DIRECT_CHILD_USER_LIMIT,
          reason: "Create direct splitvc conversation channel",
        });
        created.push({ channel, groupNumber: index + 1 });
        await SplitProcessSession.updateOne(
          { sessionId: config.splitSessionId },
          {
            $addToSet: { childChannelIds: channel.id },
            $push: { childChannelStates: { channelId: channel.id, groupNumber: index + 1 } },
          },
        );
        // Explicitly synchronize overwrites with the category.  userLimit is
        // independent from permission overwrites and remains five after this.
        if (typeof channel.lockPermissions === "function") {
          await channel.lockPermissions();
        }
      }
      return created;
    } catch (error) {
      const deletedChannelIds = [];
      await Promise.all(created.map(async ({ channel }) => {
        if (await deleteDirectChildChannel(
          channel,
          "Rollback direct splitvc channel creation",
          `Failed to roll back direct splitvc channel ${channel.id}`,
        )) {
          deletedChannelIds.push(channel.id);
        }
      }));
      if (deletedChannelIds.length > 0) {
        await SplitProcessSession.updateOne(
          { sessionId: config.splitSessionId },
          {
            $pull: {
              childChannelIds: { $in: deletedChannelIds },
              childChannelStates: { channelId: { $in: deletedChannelIds } },
            },
          },
        ).catch((cleanupError) => logRecoverableError(`Failed to remove rolled-back direct splitvc channels from session ${config.splitSessionId}`, cleanupError));
      }
      const failedChannelIds = created
        .map(({ channel }) => channel.id)
        .filter((channelId) => !deletedChannelIds.includes(channelId));
      if (failedChannelIds.length > 0) {
        await markDirectSplitCleanupRequired(
          config.splitSessionId,
          `Direct splitvc channel creation rollback failed for: ${failedChannelIds.join(", ")}`,
          config.guild,
        );
      }
      throw error;
    }
  }

  async function transferDirectGroups(groups, config) {
    const lines = [];
    const childChannelIds = new Set();
    const participantMemberIds = new Set();
    const participantRoleGrantedMemberIds = new Set();
    const groupSummaries = [];
    const channels = await createDirectChildChannels(groups, config);

    for (const [index, group] of groups.entries()) {
      const entry = channels[index];
      if (!entry) continue;
      const movedMemberIds = [];
      const failed = [];
      const roleFailures = [];
      for (const member of group) {
        if (!member.voice?.channelId) {
          failed.push(member.displayName);
          continue;
        }
        try {
          const transfer = await moveMemberWithParticipantRole(
            member,
            entry.channel,
            "Move group member to direct splitvc channel",
            config.participantRole,
            participantMemberIds,
            participantRoleGrantedMemberIds,
            config.splitSessionId,
          );
          if (!transfer.moved) {
            roleFailures.push(transfer.memberName);
            failed.push(member.displayName);
            continue;
          }
          movedMemberIds.push(member.id);
          await SplitProcessSession.updateOne(
            { sessionId: config.splitSessionId },
            {
              $addToSet: {
                participantMemberIds: member.id,
                ...(transfer.roleGranted ? { participantRoleGrantedMemberIds: member.id } : {}),
              },
            },
          ).catch((error) => logRecoverableError(`Failed to persist direct splitvc member ${member.id}`, error));
        } catch (error) {
          failed.push(member.displayName);
          logRecoverableError(`Failed to move direct splitvc member ${member.id}`, error);
        }
      }

      if (movedMemberIds.length === 0) {
        const deleted = await deleteDirectChildChannel(
          entry.channel,
          "Remove empty direct splitvc channel after transfer failure",
          `Failed to delete empty direct splitvc channel ${entry.channel.id}`,
        );
        if (deleted) {
          await SplitProcessSession.updateOne(
            { sessionId: config.splitSessionId },
            { $pull: { childChannelIds: entry.channel.id, childChannelStates: { channelId: entry.channel.id } } },
          ).catch((error) => logRecoverableError(`Failed to remove deleted direct splitvc channel ${entry.channel.id} from session`, error));
        } else {
          // Keep the channel tracked so the direct-child monitor can retry the
          // deletion.  It may be one of several groups, so do not fail the
          // groups that transferred successfully.
          childChannelIds.add(entry.channel.id);
        }
        lines.push(`グループ ${index + 1}: 転送できたメンバーがいませんでした。`);
        continue;
      }

      childChannelIds.add(entry.channel.id);
      groupSummaries.push({
        groupNumber: entry.groupNumber,
        channelId: entry.channel.id,
        channelName: entry.channel.name,
        memberNames: shuffle(group).map((member) => member.displayName),
        memberIds: movedMemberIds,
      });
      const failedText = failed.length > 0 ? ` 転送失敗: ${failed.join("、")}` : "";
      const roleFailedText = roleFailures.length > 0 ? ` 参加者ロール付与失敗: ${roleFailures.join("、")}` : "";
      lines.push(`グループ ${index + 1}: ${entry.channel.name} へ ${movedMemberIds.length}/${group.length} 人を転送しました。${failedText}${roleFailedText}`);
    }

    return {
      lines,
      childChannelIds: [...childChannelIds],
      groupSummaries,
      participantMemberIds: [...participantMemberIds],
      participantRoleGrantedMemberIds: [...participantRoleGrantedMemberIds],
    };
  }

  function clearDirectChildMonitor(sessionId) {
    const timer = directChildMonitorTimers.get(sessionId);
    if (timer) clearInterval(timer);
    directChildMonitorTimers.delete(sessionId);
  }

  async function processDirectCleanupRequiredSession(session, guild) {
    const remainingChannelIds = [];
    const stateMap = directChildStateMap(session);
    for (const channelId of session.childChannelIds ?? []) {
      let channel;
      try {
        channel = await guild.channels.fetch(channelId);
      } catch (error) {
        if (error?.code === 10003) continue;
        remainingChannelIds.push(channelId);
        logRecoverableError(`Failed to fetch direct splitvc cleanup channel ${channelId}`, error);
        continue;
      }
      if (!channel?.isVoiceBased?.()) continue;
      const deleted = await deleteDirectChildChannel(
        channel,
        "Retry direct splitvc cleanup",
        `Failed to retry direct splitvc channel cleanup ${channelId}`,
      );
      if (!deleted) remainingChannelIds.push(channelId);
    }

    let roleCleanupFailed = false;
    const grantedRows = await VoiceParticipantRoleGrant.find({
      guildId: session.guildId,
      sourceType: "splitvc",
      sourceId: session.sessionId,
      status: "active",
    }).lean().catch((error) => {
      roleCleanupFailed = true;
      logRecoverableError(`Failed to find direct splitvc cleanup role grants ${session.sessionId}`, error);
      return [];
    });
    if (grantedRows.length > 0) {
      const roleRemoval = await removeRoleFromMembers(
        guild,
        session.participantRoleId,
        grantedRows.map((row) => row.memberId),
        { sourceType: "splitvc", sourceId: session.sessionId },
      ).catch((error) => {
        roleCleanupFailed = true;
        logRecoverableError(`Failed to retry direct splitvc participant-role cleanup ${session.sessionId}`, error);
        return { failed: grantedRows.length };
      });
      if (roleRemoval.failed > 0) roleCleanupFailed = true;
    }

    const cleanupCompleted = remainingChannelIds.length === 0 && !roleCleanupFailed;
    const remainingStates = [...stateMap.values()].filter((state) => remainingChannelIds.includes(state.channelId));
    await SplitProcessSession.updateOne(
      { sessionId: session.sessionId, status: "cleanup_required" },
      {
        $set: cleanupCompleted
          ? {
            status: "failed",
            phase: "failed",
            childChannelIds: [],
            childChannelStates: [],
            childChannelsCleanupCompleted: true,
            roleRemovalCompleted: true,
            completedAt: new Date(),
            lastError: "Direct splitvc cleanup completed after retry",
          }
          : {
            status: "cleanup_required",
            phase: "cleanup_required",
            childChannelIds: remainingChannelIds,
            childChannelStates: remainingStates,
            childChannelsCleanupCompleted: false,
            lastError: "Direct splitvc cleanup is still pending; automatic retry will continue",
          },
      },
    ).catch((error) => logRecoverableError(`Failed to persist direct splitvc cleanup retry state ${session.sessionId}`, error));
    if (cleanupCompleted) clearDirectChildMonitor(session.sessionId);
  }

  async function processDirectChildMonitor(sessionId, guild) {
    if (directChildMonitorLocks.has(sessionId)) return;
    directChildMonitorLocks.add(sessionId);
    try {
      const sessionFilter = {
        sessionId,
        splitMode: "direct",
        status: { $in: ["active", "feedback_open", "role_remove_pending", "cleaning_up", "completed", "canceled", "cleanup_required"] },
      };
      let session = await SplitProcessSession.findOne(sessionFilter).lean();
      if (!session) {
        clearDirectChildMonitor(sessionId);
        return;
      }
      if (session.waitingRollbackTasks?.length) {
        await processWaitingRollbackTasks(sessionId, guild);
        session = await SplitProcessSession.findOne(sessionFilter).lean();
        if (!session) {
          clearDirectChildMonitor(sessionId);
          return;
        }
      }
      if (session.status === "cleanup_required") {
        await processDirectCleanupRequiredSession(session, guild);
        return;
      }

      const states = directChildStateMap(session);
      let changed = false;
      let remainingChannels = 0;
      const now = Date.now();
      const finishAt = session.finishNoticeAt ? new Date(session.finishNoticeAt).getTime() : null;
      const finishSent = session.finishNoticeSent === true;

      for (const channelId of session.childChannelIds ?? []) {
        const current = states.get(channelId) ?? { channelId };
        let channel;
        try {
          channel = await guild.channels.fetch(channelId);
        } catch (error) {
          // A transient Discord/API failure must not be interpreted as a
          // deleted channel.  Only Discord's explicit unknown-channel error
          // is terminal; the next poll will retry all other failures.
          if (error?.code === 10003) {
            channel = null;
          } else {
            remainingChannels += 1;
            logRecoverableError(`Failed to fetch direct splitvc channel ${channelId}`, error);
            continue;
          }
        }
        if (!channel?.isVoiceBased?.()) {
          if (!current.deletedAt) {
            current.deletedAt = new Date();
            current.emptySince = null;
            current.cleanupAt = null;
            states.set(channelId, current);
            changed = true;
          }
          continue;
        }

        remainingChannels += 1;
        const humanCount = [...channel.members.values()].filter((member) => !member.user?.bot).length;
        if (humanCount > 0) {
          if (current.emptySince || current.cleanupAt || current.deletedAt) {
            current.emptySince = null;
            current.cleanupAt = null;
            current.deletedAt = null;
            states.set(channelId, current);
            changed = true;
          }
          continue;
        }

        if (current.deletedAt) {
          current.deletedAt = null;
          changed = true;
        }
        if (!current.emptySince) {
          current.emptySince = new Date();
          changed = true;
        }

        if (!current.cleanupAt) {
          if (finishSent) current.cleanupAt = new Date(now);
          else if (finishAt && finishAt > now) current.cleanupAt = new Date(Math.min(now + DIRECT_EMPTY_GRACE_MS, finishAt));
          if (current.cleanupAt) changed = true;
        }
        if (current.cleanupAt && new Date(current.cleanupAt).getTime() <= now && (finishSent || !finishAt || finishAt > now)) {
          const deleted = await channel.delete("Remove empty direct splitvc channel").then(() => true).catch((error) => {
            logRecoverableError(`Failed to delete empty direct splitvc channel ${channelId}`, error);
            return false;
          });
          if (deleted) {
            current.deletedAt = new Date();
            current.cleanupAt = null;
            states.set(channelId, current);
            remainingChannels -= 1;
            changed = true;
          }
        }
      }

      const completed = remainingChannels === 0 && (session.childChannelIds ?? []).length > 0;
      if (changed || completed !== session.childChannelsCleanupCompleted) {
        await persistDirectChildStates(sessionId, states, completed);
      }
      if (completed && session.roleRemovalCompleted) clearDirectChildMonitor(sessionId);
    } finally {
      directChildMonitorLocks.delete(sessionId);
    }
  }

  function startDirectChildMonitor(session, guild) {
    clearDirectChildMonitor(session.sessionId);
    const timer = setInterval(() => {
      void processDirectChildMonitor(session.sessionId, guild).catch((error) => {
        console.error(`Direct splitvc channel monitor failed for ${session.sessionId}:`, error);
      }).finally(() => requestOperationalStatusRefresh(guild.id, "split-direct-child-monitor"));
    }, DIRECT_CHILD_MONITOR_POLL_MS);
    directChildMonitorTimers.set(session.sessionId, timer);
    void processDirectChildMonitor(session.sessionId, guild).catch((error) => {
      console.error(`Direct splitvc channel monitor failed for ${session.sessionId}:`, error);
    });
  }

  async function recoverOverdueDirectFinishNotice(session, guild) {
    const channel = await guild.channels.fetch(session.operationChannelId).catch(() => null);
    if (!channel?.send) return;
    const actionKey = `split-finish-notice:${session.sessionId}`;
    const existingAction = await scheduleAction({
      actionKey,
      guildId: guild.id,
      type: "split_finish_notice",
      executeAt: new Date(),
      roleId: session.participantRoleId,
      memberIds: session.participantMemberIds ?? [],
      payload: {
        sessionId: session.sessionId,
        kokuchiEventId: session.kokuchiEventId ?? null,
        kokuchiEventRevision: session.kokuchiEventRevision ?? null,
        channelId: channel.id,
        finishMessage: session.finishMessage ?? DEFAULT_FINISH_MESSAGE,
      },
    });
    if (existingAction?.status === "failed") {
      await retryAction(actionKey, {
        executeAt: new Date(),
        lastError: "Recovered overdue direct splitvc finish notice after restart",
      }).catch((error) => logRecoverableError(`Failed to requeue overdue direct splitvc finish notice ${session.sessionId}`, error));
    }
    await sendClaimedSplitFinishNotice({
      channel,
      guild,
      ownerId: session.ownerId,
      roleId: session.participantRoleId,
      memberIds: new Set(session.participantMemberIds ?? []),
      roleGrantedMemberIds: new Set(session.participantRoleGrantedMemberIds ?? []),
      finishMessage: session.finishMessage ?? DEFAULT_FINISH_MESSAGE,
      noticeWaitMs: 0,
      roleRemoveWaitMs: 0,
      childChannelIds: new Set(session.childChannelIds ?? []),
      state: { ended: false },
      splitSessionId: session.sessionId,
      kokuchiEventId: session.kokuchiEventId ?? null,
      kokuchiEventRevision: session.kokuchiEventRevision ?? null,
      settings: await getGuildSettings(guild.id).catch(() => null),
      splitMode: "direct",
    });
  }

  async function handleSplitVoice(interaction) {
    if (!interaction.inGuild()) {
      await interaction.reply({
        content: "このコマンドはサーバー内で使ってください。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  
    const selectedChannel = interaction.options.getChannel("channel", false);
    const fallbackChannel = interaction.member?.voice?.channel ?? null;
    const sourceChannel = selectedChannel ?? fallbackChannel;
    const privateResult = interaction.options.getBoolean("private") ?? false;
  
    if (!sourceChannel?.isVoiceBased()) {
      await interaction.reply({
        content: "対象のボイスチャンネルを指定するか、自分がボイスチャンネルに入ってから実行してください。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  
    interaction = await deferCommandResponse(
      interaction,
      privateResult ? MessageFlags.Ephemeral : undefined,
    );
  
    const botMember = interaction.guild.members.me
      ?? await interaction.guild.members.fetch(interaction.client.user.id);
    const sourcePermissions = sourceChannel.permissionsFor(botMember);
  
    if (!sourcePermissions?.has(PermissionsBitField.Flags.ViewChannel)) {
      await interaction.editReply({
        content: "Botが対象のボイスチャンネルを見る権限を持っていません。",
      });
      return;
    }
  
    if (splitVoiceGuildLocks.has(interaction.guildId)) {
      await interaction.reply({
        content: "このサーバーでは、すでに /splitvc を処理中です。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  
    splitVoiceGuildLocks.add(interaction.guildId);
    const splitLease = await acquireMongoLease(`splitvc:${interaction.guildId}`, {
      leaseMs: 5 * 60 * 1000,
    }).catch((error) => {
      splitVoiceGuildLocks.delete(interaction.guildId);
      throw error;
    });
    if (!splitLease) {
      splitVoiceGuildLocks.delete(interaction.guildId);
      await interaction.reply({
        content: "このサーバーでは、別のBotプロセスが /splitvc を処理中です。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    activeSplitVoiceLeases.set(interaction.guildId, splitLease);
    let splitLeaseReleased = false;
    const releaseSplitVoiceLock = () => {
      splitVoiceGuildLocks.delete(interaction.guildId);
      if (splitLeaseReleased) return;
      splitLeaseReleased = true;
      if (activeSplitVoiceLeases.get(interaction.guildId) === splitLease) {
        activeSplitVoiceLeases.delete(interaction.guildId);
      }
      void releaseMongoLease(splitLease).catch((error) => {
        console.error(`Failed to release splitvc lease for ${interaction.guildId}: ${error.message}`);
      });
    };
  
    const activeSplitSession = await SplitProcessSession.exists({
      guildId: interaction.guildId,
      status: { $in: ["active", "finish_notice_pending", "feedback_open", "role_remove_pending", "cleaning_up"] },
    });
    if (activeSplitSession) {
      releaseSplitVoiceLock();
      await interaction.reply({
        content: "このサーバーでは、進行中の /splitvc セッションがあります。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  
    const includeBots = interaction.options.getBoolean("include_bots") ?? false;
    const splitSessionId = createSessionId();
    interaction.__splitSessionId = splitSessionId;
    const members = [...sourceChannel.members.values()]
      .filter((member) => includeBots || !member.user.bot)
      .sort((left, right) =>
        left.displayName.localeCompare(right.displayName, "ja"),
      );
  
    let groupingState = null;
    let groupingHistoryError = null;
    try {
      groupingState = await getSplitGroupingState(interaction.guildId);
    } catch (error) {
      groupingHistoryError = error;
    }
  
    const previousGroups = groupingState?.current?.groups ?? groupingState?.previous?.groups ?? [];
    const targetMembers = members;
    const groupingSelection = groupingHistoryError
      ? {
          groups: buildGroups(shuffle(targetMembers)),
          score: null,
          candidateCount: 1,
          evaluatedCandidateCount: 1,
        }
      : chooseGroupsWithHistory(targetMembers, previousGroups);
    const groups = groupingSelection.groups;
  
    if (targetMembers.length === 0) {
      releaseSplitVoiceLock();
      await interaction.editReply({
        content: `${sourceChannel} に対象メンバーがいません。`,
      });
      return;
    }
  
    await replyInChunks(interaction, formatResult(sourceChannel, targetMembers.length, groups), {
      flags: privateResult ? MessageFlags.Ephemeral : undefined,
      allowedMentions: { parse: [] },
    });
  
    const settings = await getGuildSettings(interaction.guildId);
    const config = await resolveProcessConfig(interaction, settings, botMember);
    const transferWaitMs = secondsToMs(
      getNonNegativeInteger(
        settings?.transferWaitSeconds,
        DEFAULT_TRANSFER_WAIT_SECONDS,
      ),
    );
    const noticeWaitMs = minutesToMs(
      getNonNegativeInteger(settings?.noticeWaitMinutes, DEFAULT_NOTICE_WAIT_MINUTES),
    );
    const roleRemoveWaitMs = minutesToMs(
      getNonNegativeInteger(
        settings?.roleRemoveWaitMinutes,
        DEFAULT_ROLE_REMOVE_WAIT_MINUTES,
      ),
    );
  
    if (config.errors.length > 0) {
      releaseSplitVoiceLock();
      await interaction.followUp({
        content: `PB連携プロセスは実行できません。\n${config.errors.map((error) => `- ${error}`).join("\n")}`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  
    const operationChannel = getSendableChannel(interaction);
  
    if (!operationChannel) {
      releaseSplitVoiceLock();
      await interaction.followUp({
        content: "結果や待機メッセージを送信できるテキストチャンネルが見つかりません。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  
    await sendOperationalLog({
      guild: interaction.guild,
      settings,
      fallbackChannel: operationChannel,
      content: `${config.tempRole} は、各メンバーをVCへ転送したタイミングで付与します。`,
      allowedMentions: { roles: [] },
    });
  
    const previousPairCount = getPairKeysFromGroups(previousGroups).size;
    await sendSplitGroupingLog({
      guild: interaction.guild,
      settings,
      content: [
        `[splitvc-history] guild=${interaction.guildId} session=${splitSessionId}`,
        `source=${groupingState?.current ? "current" : groupingState?.previous ? "previous" : "none"}`,
        `previousPairCount=${previousPairCount}`,
        `candidateCount=${groupingSelection.candidateCount}`,
        `evaluatedCandidateCount=${groupingSelection.evaluatedCandidateCount}`,
        `selectedRepeatedPairCount=${groupingSelection.score ?? "fallback"}`,
        groupingHistoryError
          ? `historyError=${groupingHistoryError.name ?? "Error"}: ${groupingHistoryError.message ?? groupingHistoryError}`
          : "historyError=none",
      ].join("\n"),
    });
  
    const childChannelIds = new Set();
    const participantMemberIds = new Set();
    const participantRoleGrantedMemberIds = new Set();
    const kokuchiEvent = settings?.kokuchiEventId
      ? await KokuchiReservation.findOne({ guildId: interaction.guildId, reservationId: settings.kokuchiEventId }).lean()
      : null;
    const kokuchiEventRevision = kokuchiEvent?.lifecycleRevision ?? null;
    const processState = { ended: false };
    let temporaryWaitingVc = null;
    let temporaryWaitingVcDeleteTimer = null;
    let splitStartMessage = null;
    const transferAt = new Date(Date.now() + transferWaitMs);
    let nextDirectGroupNumber = 1;
  
    // Persist the intent before displaying the cancellable countdown.  A
    // restart during this window can now restore or cancel the same session
    // instead of losing the planned transfer entirely.
    await persistSplitProcessSession(splitSessionId, {
      guildId: interaction.guildId,
      ownerId: interaction.user.id,
      splitMode: config.splitMode,
      sourceChannelId: sourceChannel.id,
      operationChannelId: operationChannel.id,
      parentChannelId: config.parentChannel?.id ?? null,
      childCategoryId: config.childCategoryId,
      participantRoleId: config.tempRole.id,
      kokuchiEventId: settings?.kokuchiEventId ?? null,
      kokuchiEventRevision,
      phase: "transfer_waiting",
      status: "active",
      transferAt,
      plannedMemberIds: targetMembers.map((member) => member.id),
      finishMessage: settings?.finishMessage || DEFAULT_FINISH_MESSAGE,
    });
  
    const transferCanceled = await runCountdown({
      channel: operationChannel,
      ownerId: interaction.user.id,
      totalMs: transferWaitMs,
      updateEveryMs: COUNTDOWN_UPDATE_MS,
      cancellationKey: splitSessionId,
      buttonLabel: "転送キャンセル",
      cancelText: "転送はキャンセルされました。終了通知の待機は続行します。",
      render: (remainingMs) =>
        `${config.splitMode === "direct" ? "VC作成後のメンバー転送" : "PB親チャンネルへの転送"}開始まで残り ${formatDuration(remainingMs)} です。\nキャンセルできるのはコマンド実行者のみです。`,
    });
  
    if (transferCanceled) {
      await persistSplitProcessSession(splitSessionId, {
        status: "canceled",
        phase: "canceled",
        ...(config.splitMode === "direct" ? { childChannelStates: [], childChannelsCleanupCompleted: true } : {}),
        completedAt: new Date(),
      });
      releaseSplitVoiceLock();
      await operationChannel.send("転送をキャンセルしました。");
    } else {
      const transferResult = config.splitMode === "direct"
        ? await transferDirectGroups(groups, {
          splitSessionId,
          childCategoryId: config.childCategoryId,
          participantRole: config.tempRole,
          sourceChannelId: sourceChannel.id,
          guild: interaction.guild,
          settings,
        })
        : await transferGroups(groups, {
          splitSessionId,
          parentChannel: config.parentChannel,
          childCategoryId: config.childCategoryId,
          participantRole: config.tempRole,
          sourceChannelId: sourceChannel.id,
          guild: interaction.guild,
          settings,
        });
      addMany(childChannelIds, transferResult.childChannelIds);
      addMany(participantMemberIds, transferResult.participantMemberIds);
      addMany(participantRoleGrantedMemberIds, transferResult.participantRoleGrantedMemberIds);
  
      if (transferResult.groupSummaries.length === 0) {
        const cleanupErrors = [];
        const sessionBeforeCleanup = await SplitProcessSession.findOne({ sessionId: splitSessionId }).lean().catch((error) => {
          cleanupErrors.push(`session lookup: ${error.message}`);
          return null;
        });
        const source = await interaction.guild.channels.fetch(sourceChannel.id).catch((error) => {
          cleanupErrors.push(`source VC lookup: ${error.message}`);
          return null;
        });
        for (const memberId of participantMemberIds) {
          try {
            const member = await interaction.guild.members.fetch(memberId);
            if (source?.isVoiceBased?.() && member.voice.channelId !== source.id) {
              await member.voice.setChannel(source, "Rollback splitvc after every group transfer failed");
            }
          } catch (error) {
            cleanupErrors.push(`member ${memberId} rollback: ${error.message}`);
          }
        }
        try {
          const roleRemoval = await removeRoleFromMembers(
            interaction.guild,
            config.tempRole.id,
            [...participantRoleGrantedMemberIds],
            { sourceType: "splitvc", sourceId: splitSessionId },
          );
          if (roleRemoval.failed > 0) {
            cleanupErrors.push(`participant role rollback failed for ${roleRemoval.failed} member(s)`);
          }
        } catch (error) {
          cleanupErrors.push(`participant role rollback: ${error.message}`);
        }
        for (const channelId of [...childChannelIds]) {
          let channel;
          try {
            channel = await interaction.guild.channels.fetch(channelId);
          } catch (error) {
            if (error?.code === 10003) {
              childChannelIds.delete(channelId);
              continue;
            }
            cleanupErrors.push(`child VC ${channelId} lookup: ${error.message}`);
            continue;
          }
          if (await deleteDirectChildChannel(
            channel,
            "Remove empty splitvc child after all transfers failed",
            `Failed to clean up splitvc child ${channelId} after all transfers failed`,
          )) {
            childChannelIds.delete(channelId);
          } else {
            cleanupErrors.push(`child VC ${channelId} cleanup failed`);
          }
        }
        const lastError = cleanupErrors.length > 0
          ? `No group was transferred successfully. Cleanup required: ${cleanupErrors.join(" | ")}`
          : "No group was transferred successfully.";
        const cleanupPatch = {
          status: cleanupErrors.length > 0 ? "cleanup_required" : "failed",
          phase: "failed",
          completedAt: new Date(),
          lastError,
          childChannelIds: [...childChannelIds],
        };
        if (config.splitMode === "direct") {
          cleanupPatch.childChannelStates = (sessionBeforeCleanup?.childChannelStates ?? [])
            .filter((state) => childChannelIds.has(state.channelId));
          cleanupPatch.childChannelsCleanupCompleted = childChannelIds.size === 0;
        }
        await persistSplitProcessSession(splitSessionId, cleanupPatch);
        if (cleanupErrors.length > 0 && config.splitMode === "direct") {
          startDirectChildMonitor({ sessionId: splitSessionId }, interaction.guild);
        }
        releaseSplitVoiceLock();
        await operationChannel.send(cleanupErrors.length > 0
          ? "グループ転送に成功したグループがないため、処理を終了しました。参加者ロールまたは作成済みVCの回収が完了していません。運用ログを確認してください。"
          : "グループ転送に成功したグループがないため、処理を終了しました。参加者ロールと作成済みVCは回収しました。");
        await sendOperationalLog({
          guild: interaction.guild,
          settings,
          fallbackChannel: operationChannel,
          content: `splitvcを失敗として終了しました。セッション: ${splitSessionId}。${lastError}`,
        });
        return;
      }
  
      if (transferResult.groupSummaries.length > 0) {
        nextDirectGroupNumber = transferResult.groupSummaries.reduce(
          (max, summary) => Math.max(max, Number(summary.groupNumber) || 0),
          0,
        ) + 1;
        try {
          await startSplitGrouping({
            guildId: interaction.guildId,
            sessionId: splitSessionId,
            groups: transferResult.groupSummaries.map((summary) => ({
              channelId: summary.channelId,
              memberIds: summary.memberIds,
            })),
          });
          await sendSplitGroupingLog({
            guild: interaction.guild,
            settings,
            content: `[splitvc-history] current saved guild=${interaction.guildId} session=${splitSessionId} groups=${transferResult.groupSummaries.length} successfulMembers=${transferResult.groupSummaries.reduce((total, summary) => total + summary.memberIds.length, 0)}`,
          });
        } catch (error) {
          await sendSplitGroupingLog({
            guild: interaction.guild,
            settings,
            content: `[splitvc-history] current save failed guild=${interaction.guildId} session=${splitSessionId} process=initial-transfer error=${error.name ?? "Error"}: ${error.message ?? error}`,
          });
        }
      }
      try {
        const finishNoticeAt = new Date(Date.now() + noticeWaitMs);
        const roleRemoveAt = new Date(finishNoticeAt.getTime() + roleRemoveWaitMs);
        await persistSplitProcessSession(splitSessionId, {
          phase: "active",
          status: "active",
          splitMode: config.splitMode,
          participantMemberIds: [...participantMemberIds],
          participantRoleGrantedMemberIds: [...participantRoleGrantedMemberIds],
          childChannelIds: [...childChannelIds],
          groupSnapshots: transferResult.groupSummaries.map((summary, index) => ({
            groupNumber: summary.groupNumber ?? index + 1,
            channelId: summary.channelId,
            memberIds: summary.memberIds,
          })),
          childChannelStates: config.splitMode === "direct"
            ? transferResult.groupSummaries.map((summary) => ({ channelId: summary.channelId, groupNumber: summary.groupNumber }))
            : [],
          childChannelsCleanupCompleted: false,
          conversationStartedAt: new Date(),
          finishNoticeAt,
          roleRemoveAt,
        });
        await scheduleAction({
          actionKey: `split-finish-notice:${splitSessionId}`,
          guildId: interaction.guildId,
          type: "split_finish_notice",
          executeAt: finishNoticeAt,
          roleId: config.tempRole.id,
          memberIds: [...participantMemberIds],
          payload: { sessionId: splitSessionId, kokuchiEventId: settings?.kokuchiEventId ?? null, kokuchiEventRevision, channelId: operationChannel.id, finishMessage: settings?.finishMessage || DEFAULT_FINISH_MESSAGE },
        });
      } catch (error) {
        await removeRoleFromMembers(
          interaction.guild,
          config.tempRole.id,
          [...participantRoleGrantedMemberIds],
          { sourceType: "splitvc", sourceId: splitSessionId },
        ).catch((rollbackError) => {
          console.error(`Failed to roll back splitvc participant roles: ${rollbackError.message}`);
        });
        for (const channelId of childChannelIds) {
          const channel = await interaction.guild.channels.fetch(channelId).catch(() => null);
          await channel?.delete().catch((cleanupError) => logRecoverableError(`Failed to delete rolled-back splitvc child ${channelId}`, cleanupError));
        }
        throw error;
      }
      releaseSplitVoiceLock();
      if (config.splitMode === "direct") startDirectChildMonitor({ sessionId: splitSessionId }, interaction.guild);
  
      await sendOperationalLog({
        guild: interaction.guild,
        settings,
        fallbackChannel: operationChannel,
        content: `転送結果\n${transferResult.lines.join("\n")}`,
      });
  
      const gatheringClosed = await closeGatheringVcAfterSplit(
        interaction.guild,
        settings,
        { splitSessionId },
      );
  
      if (gatheringClosed) {
        await sendOperationalLog({
          guild: interaction.guild,
          settings,
          fallbackChannel: operationChannel,
          content: "集合VCのeveryone接続権限を不可にしました。",
        });
      }
  
      if (config.waitingVcCategoryId) {
  
        temporaryWaitingVc = await operationChannel.guild.channels.create({
          name: config.waitingVcName,
          type: ChannelType.GuildVoice,
          parent: config.waitingVcCategoryId,
  
          permissionOverwrites: [
            {
              id: operationChannel.guild.roles.everyone.id,
  
              allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.Connect,
              ],
  
              deny: [
                PermissionFlagsBits.Speak,
              ],
            },
          ],
        });
  
        await sendOperationalLog({
          guild: interaction.guild,
          settings,
          fallbackChannel: operationChannel,
          content: `待機用VC ${temporaryWaitingVc} を作成しました。10分後に自動削除されます。`,
        });
  
        splitStartMessage = await sendSplitStartAnnouncement({
          guild: interaction.guild,
          settings,
          waitingChannel: temporaryWaitingVc,
        });
        await persistSplitProcessSession(splitSessionId, {
          waitingChannelId: temporaryWaitingVc.id,
          waitingMonitorStatus: "active",
          waitingMonitorStartedAt: new Date(),
          splitStartMessageChannelId: splitStartMessage?.channel?.id ?? operationChannel.id,
          splitStartMessageId: splitStartMessage?.id,
          waitingMonitorEndsAt: new Date(Date.now() + WAITING_ROOM_MONITOR_MS),
          waitingMonitorHeartbeatAt: new Date(),
          finishNoticeAt: new Date(Date.now() + noticeWaitMs),
          phase: "active",
        });
        await scheduleWaitingVcCleanup({
          actionKey: `split-waiting-vc-cleanup:${splitSessionId}`,
          guild: interaction.guild,
          channelId: temporaryWaitingVc.id,
          delayMs: noticeWaitMs,
          sessionId: splitSessionId,
        });
  
        temporaryWaitingVcDeleteTimer = setTimeout(async () => {
  
          try {
            const session = await SplitProcessSession.findOne({ sessionId: splitSessionId }).lean().catch(() => null);
            if (session?.status === "active" && ["active", "extended"].includes(session.waitingMonitorStatus)) {
              return;
            }
  
            const fetchedChannel =
              await operationChannel.guild.channels.fetch(
                temporaryWaitingVc.id,
              ).catch(() => null);
  
            if (fetchedChannel) {
              const keepMonitoring = await shouldKeepWaitingRoomAlive({
                guild: interaction.guild,
                childChannelIds,
              });
  
              if (keepMonitoring) {
                await editSplitStartAnnouncementExtended(splitStartMessage, fetchedChannel);
  
                await sendOperationalLog({
                  guild: interaction.guild,
                  settings,
                  fallbackChannel: operationChannel,
                  content: "2人以下の子VCが残っているため、待機用VCの自動削除を延長しました。",
                });
  
                return;
              }
  
              await notifyWaitingVcClosure(operationChannel, fetchedChannel);
              await editSplitStartAnnouncementClosed(splitStartMessage);
              await fetchedChannel.delete();
  
              await sendOperationalLog({
                guild: interaction.guild,
                settings,
                fallbackChannel: operationChannel,
                content: "待機用VCを自動削除しました。",
              });
            }
  
          } catch (error) {
  
            console.error(error);
  
          }
  
        }, 10 * 60 * 1000);
  
        void runWaitingRoomMonitor({
          channel: operationChannel,
          guild: interaction.guild,
          waitingChannel: temporaryWaitingVc,
          parentChannel: config.parentChannel,
          splitMode: config.splitMode,
          participantRole: config.tempRole,
          childCategoryId: config.childCategoryId,
          childChannelIds,
          participantMemberIds,
          participantRoleGrantedMemberIds,
          nextDirectGroupNumber,
          state: processState,
          settings,
          previousPairKeys: getPairKeysFromGroups(previousGroups),
          splitSessionId,
          splitStartMessage,
          currentGroupMembers: new Map(
            transferResult.groupSummaries.map((summary) => [summary.channelId, new Set(summary.memberIds)]),
          ),
        }).catch((error) => {
          console.error(error);
        });
      }
  
  
      void runEndNotificationFlow({
        channel: operationChannel,
        guild: interaction.guild,
        ownerId: interaction.user.id,
        roleId: config.tempRole.id,
        memberIds: participantMemberIds,
        roleGrantedMemberIds: participantRoleGrantedMemberIds,
        finishMessage: settings?.finishMessage || DEFAULT_FINISH_MESSAGE,
        noticeWaitMs,
        roleRemoveWaitMs,
        childChannelIds,
        state: processState,
        splitSessionId,
        kokuchiEventId: settings?.kokuchiEventId ?? null,
        kokuchiEventRevision,
        temporaryWaitingVc,
        temporaryWaitingVcDeleteTimer,
        splitStartMessage,
        settings,
        splitMode: config.splitMode,
      }).catch((error) => {
        console.error(error);
      });
    }
  }
  
  async function getPbChildChannelName(voiceChannel, settings, guild) {
    if (!voiceChannel?.isVoiceBased() || !settings?.parentChannelId || !guild) {
      return null;
    }
  
    if (voiceChannel.id === settings.parentChannelId) {
      return null;
    }
  
    if (settings.childCategoryId) {
      if (voiceChannel.parentId !== settings.childCategoryId) {
        return null;
      }
      return voiceChannel.name;
    }
  
    const parentChannel = await guild.channels
      .fetch(settings.parentChannelId)
      .catch(() => null);
  
    if (!parentChannel?.isVoiceBased()) {
      return null;
    }
  
    if (voiceChannel.parentId !== parentChannel.parentId) {
      return null;
    }
  
    return voiceChannel.name;
  }
  
    async function resolveProcessConfig(interaction, settings, botMember) {
      const errors = [];
      const splitMode = normalizeSplitMode(settings);
  
      if (!settings?.tempRoleId) {
        errors.push("/setting splitvc で参加者ロールを設定してください。");
      }
  
      if (splitMode === "partybeast" && !settings?.parentChannelId) {
        errors.push("/setting splitvc でPB親ボイスチャンネルを設定してください。");
      }

      if (splitMode === "direct" && !settings?.childCategoryId) {
        errors.push("直接作成モードでは、/setting splitvc で作成先カテゴリを設定してください。");
      }
  
      const tempRole = settings?.tempRoleId
        ? await interaction.guild.roles.fetch(settings.tempRoleId).catch(() => null)
        : null;
      const parentChannel = settings?.parentChannelId
        ? await interaction.guild.channels.fetch(settings.parentChannelId).catch(() => null)
        : null;
      const childCategory = settings?.childCategoryId
        ? await interaction.guild.channels.fetch(settings.childCategoryId).catch(() => null)
        : null;
      const waitingVcCategory = settings?.waitingVcCategoryId
        ? await interaction.guild.channels.fetch(settings.waitingVcCategoryId,).catch(() => null)
        : null;
  
      if (settings?.tempRoleId && !tempRole) {
        errors.push("設定済みの参加者ロールが見つかりません。");
      }
  
      if (splitMode === "partybeast" && settings?.parentChannelId && !parentChannel?.isVoiceBased()) {
        errors.push("設定済みのPB親チャンネルがボイスチャンネルではありません。");
      }
  
      if (settings?.childCategoryId && !childCategory) {
        errors.push("設定済みの子VCカテゴリが見つかりません。");
      } else if (settings?.childCategoryId && childCategory.type !== ChannelType.GuildCategory) {
        errors.push("設定済みの子VCカテゴリがカテゴリチャンネルではありません。");
      }

      if (splitMode === "direct" && childCategory) {
        const categoryPermissions = childCategory.permissionsFor(botMember);
        if (!categoryPermissions?.has(PermissionFlagsBits.ViewChannel)) {
          errors.push("Botが直接作成VCのカテゴリを閲覧する権限を持っていません。");
        }
        if (!categoryPermissions?.has(PermissionFlagsBits.ManageChannels)) {
          errors.push("Botに直接作成VCのManage Channels権限がありません。");
        }
        if (!categoryPermissions?.has(PermissionFlagsBits.Connect)) {
          errors.push("Botに直接作成VCへ接続する権限がありません。");
        }
      }
  
      if (settings?.waitingVcCategoryId && !waitingVcCategory) {
        errors.push("設定済みの待機VCカテゴリが見つかりません。");
      } else if (
        settings?.waitingVcCategoryId &&
        waitingVcCategory.type !== ChannelType.GuildCategory
      ) {
        errors.push("待機VCカテゴリがカテゴリチャンネルではありません。");
      }
  
      if (tempRole) {
        if (tempRole.managed || tempRole.id === interaction.guild.id) {
          errors.push("その参加者ロールはBotから付与できません。");
        }
  
        if (tempRole.position >= botMember.roles.highest.position) {
          errors.push("参加者ロールはBotの最上位ロールより下に置いてください。");
        }
      }
  
      if (!botMember.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
        errors.push("Botに Manage Roles 権限がありません。");
      }
  
      if (!botMember.permissions.has(PermissionsBitField.Flags.MoveMembers)) {
        errors.push("Botに Move Members 権限がありません。");
      }
  
      if (splitMode === "partybeast" && parentChannel?.isVoiceBased()) {
        const parentPermissions = parentChannel.permissionsFor(botMember);
  
        if (!parentPermissions?.has(PermissionsBitField.Flags.ViewChannel)) {
          errors.push("BotがPB親チャンネルを見る権限を持っていません。");
        }
  
        if (!parentPermissions?.has(PermissionsBitField.Flags.Connect)) {
          errors.push("BotがPB親チャンネルへ接続する権限を持っていません。");
        }
      }
  
  
      const sendableChannel = getSendableChannel(interaction);
      const textPermissions = sendableChannel?.permissionsFor(botMember);
  
      if (!textPermissions?.has(PermissionsBitField.Flags.SendMessages)) {
        errors.push("Botがこのチャンネルにメッセージを送信できません。");
      }
  
      return {
        splitMode,
        errors,
        tempRole,
        parentChannel,
        childCategory,
        waitingVcCategory,
        childCategoryId: childCategory?.id ?? null,
        waitingVcCategoryId: waitingVcCategory?.id ?? null,
        waitingVcName: settings?.waitingVcName || DEFAULT_WAITING_VC_NAME,
      };
    }
  
    async function moveMemberWithParticipantRole(
      member,
      targetChannel,
      reason,
      participantRole,
      participantMemberIds,
      participantRoleGrantedMemberIds = null,
      splitSessionId,
    ) {
      const alreadyHasRole = member.roles.cache.has(participantRole.id);
      if (!alreadyHasRole) {
        try {
          await member.roles.add(
            participantRole,
            "Participant role for voice grouping session",
          );
          await VoiceParticipantRoleGrant.updateOne(
            {
              guildId: member.guild.id,
              memberId: member.id,
              roleId: participantRole.id,
              sourceType: "splitvc",
              sourceId: splitSessionId,
            },
            {
              $set: {
                sourceType: "splitvc",
                sourceId: splitSessionId,
                grantedByBot: true,
                grantedAt: new Date(),
                status: "active",
                removedAt: null,
                cleanupAt: null,
              },
              $setOnInsert: {
                guildId: member.guild.id,
                memberId: member.id,
                roleId: participantRole.id,
              },
            },
            { upsert: true },
          );
          participantRoleGrantedMemberIds?.add(member.id);
        } catch (error) {
          await member.roles.remove(
            participantRole,
            "Rollback untracked participant role grant",
          ).catch((rollbackError) => {
            console.error(`Failed to rollback participant role for ${member.id}: ${rollbackError.message}`);
          });
          participantRoleGrantedMemberIds?.delete(member.id);
          console.error(`Failed to persist split participant role grant for ${member.id}: ${error.message}`);
          return { moved: false, reason: "role_grant_failed", memberName: member.displayName };
        }
      }
  
      try {
        await member.voice.setChannel(targetChannel, reason);
      } catch (error) {
        if (!alreadyHasRole) {
          await member.roles.remove(
            participantRole,
            "Revert participant role because voice transfer failed",
          ).catch((rollbackError) => {
            console.error(
              `Failed to revert participant role for ${member.id}: ${rollbackError.message}`,
            );
          });
          await VoiceParticipantRoleGrant.updateOne(
            {
              guildId: member.guild.id,
              memberId: member.id,
              roleId: participantRole.id,
              sourceType: "splitvc",
              sourceId: splitSessionId,
              status: "active",
            },
            { $set: { status: "removed", removedAt: new Date(), cleanupAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) } },
          ).catch((rollbackError) => {
            console.error(`Failed to record split participant role rollback for ${member.id}: ${rollbackError.message}`);
          });
          participantRoleGrantedMemberIds?.delete(member.id);
        }
        throw error;
      }
  
      participantMemberIds.add(member.id);
      return { moved: true, reason: null, memberName: member.displayName, roleGranted: !alreadyHasRole };
    }
  
    async function transferGroups(groups, config) {
      const lines = [];
      const childChannelIds = new Set();
      const participantMemberIds = new Set();
      const participantRoleGrantedMemberIds = new Set();
      const groupSummaries = [];
  
      for (const [index, group] of groups.entries()) {
        const groupNumber = index + 1;
        const seedMember = group[0];
  
        if (!seedMember?.voice?.channelId) {
          lines.push(`グループ ${groupNumber}: 代表メンバーがVCにいないため転送できませんでした。`);
          continue;
        }
  
        try {
          const roleFailures = [];
          const seedHadParticipantRole = seedMember.roles.cache.has(config.participantRole.id);
          const seedTransfer = await moveMemberWithParticipantRole(
            seedMember,
            config.parentChannel,
            "Move one group member to PB parent channel",
            config.participantRole,
            participantMemberIds,
            participantRoleGrantedMemberIds,
            config.splitSessionId,
          );
  
          if (!seedTransfer.moved) {
            lines.push(`グループ ${groupNumber}: ${seedTransfer.memberName} の参加者ロール付与に失敗しました。`);
            continue;
          }
  
          const childChannel = await waitForPbChildChannel(seedMember, config);
  
          if (!childChannel) {
            const sourceChannel = await config.guild.channels.fetch(config.sourceChannelId).catch(() => null);
            if (sourceChannel?.isVoiceBased?.()) await seedMember.voice.setChannel(sourceChannel, "Rollback PB child channel creation failure").catch((error) => logRecoverableError(`Failed to return ${seedMember.id} to the source VC`, error));
            if (!seedHadParticipantRole) {
              await removeVoiceParticipantRole(seedMember, config.participantRole.id, {
                sourceType: "splitvc",
                sourceId: config.splitSessionId,
              }).catch((rollbackError) => {
                console.error(`Failed to roll back split participant role for ${seedMember.id}: ${rollbackError.message}`);
              });
              participantMemberIds.delete(seedMember.id);
              participantRoleGrantedMemberIds.delete(seedMember.id);
            }
            lines.push(`グループ ${groupNumber}: PBの子VCを検出できませんでした。`);
            continue;
          }
  
          childChannelIds.add(childChannel.id);
          await sendSplitRandomTopicPanels({
            guild: config.guild,
            settings: config.settings,
            childChannelIds: [childChannel.id],
          });
          let movedCount = 1;
          const failed = [];
          const movedMemberIds = [seedMember.id];
  
          for (const member of group.slice(1)) {
            if (!member.voice?.channelId) {
              failed.push(member.displayName);
              continue;
            }
  
            try {
              const transfer = await moveMemberWithParticipantRole(
                member,
                childChannel,
                "Move remaining group members to PB child channel",
                config.participantRole,
                participantMemberIds,
                participantRoleGrantedMemberIds,
                config.splitSessionId,
              );
  
              if (!transfer.moved) {
                roleFailures.push(transfer.memberName);
                failed.push(member.displayName);
                continue;
              }
  
              movedCount += 1;
              movedMemberIds.push(member.id);
            } catch {
              failed.push(member.displayName);
            }
          }
  
          groupSummaries.push({
            groupNumber,
            channelId: childChannel.id,
            channelName: childChannel.name,
            memberNames: shuffle(group).map((member) => member.displayName),
            memberIds: movedMemberIds,
          });
  
          const failedText =
            failed.length > 0 ? ` 転送失敗: ${failed.join("、")}` : "";
          const roleFailedText =
            roleFailures.length > 0
              ? ` 参加者ロール付与失敗: ${roleFailures.join("、")}`
              : "";
          lines.push(
            `グループ ${groupNumber}: ${childChannel.name} へ ${movedCount}/${group.length} 人を転送しました。${failedText}${roleFailedText}`,
          );
        } catch (error) {
          lines.push(`グループ ${groupNumber}: 転送中に失敗しました。${error.message}`);
        }
      }
  
      return {
        lines,
        childChannelIds: [...childChannelIds],
        groupSummaries,
        participantMemberIds: [...participantMemberIds],
        participantRoleGrantedMemberIds: [...participantRoleGrantedMemberIds],
      };
    }
  
    async function waitForPbChildChannel(member, config) {
      const startedAt = Date.now();
  
      while (Date.now() - startedAt < PB_CHILD_WAIT_MS) {
        const channel = member.voice.channel;
  
        if (isExpectedPbChildChannel(channel, config)) {
          return channel;
        }
  
        await sleep(750);
      }
  
      return null;
    }
  
    function isExpectedPbChildChannel(channel, config) {
      if (
        !channel?.isVoiceBased() ||
        channel.id === config.parentChannel.id ||
        channel.id === config.sourceChannelId
      ) {
        return false;
      }
  
      if (config.childCategoryId) {
        return channel.parentId === config.childCategoryId;
      }
  
      if (config.parentChannel.parentId) {
        return channel.parentId === config.parentChannel.parentId;
      }
  
      return true;
    }
  
    async function runWaitingRoomMonitor(options) {
      localWaitingMonitorSessions.add(options.splitSessionId);
      clearRestoredWaitingMonitor(options.splitSessionId);
      try {
      const initialLease = await claimWaitingMonitorLease(options.splitSessionId);
      if (!initialLease) {
        localWaitingMonitorSessions.delete(options.splitSessionId);
        return;
      }
      await persistSplitProcessSession(options.splitSessionId, {
        waitingMonitorStatus: "active",
        waitingMonitorStartedAt: new Date(),
        waitingMonitorHeartbeatAt: new Date(),
      }).catch((error) => logRecoverableError("Recoverable asynchronous operation failed", error));
      await sendOperationalLog({
        guild: options.guild,
        settings: options.settings,
        fallbackChannel: options.channel,
        content: `${options.waitingChannel} の途中参加監視を10分間開始します。`,
      });
  
      const endsAt = Date.now() + WAITING_ROOM_MONITOR_MS;
  
      while (Date.now() < endsAt && !options.state.ended) {
        try {
          if (!await claimWaitingMonitorLease(options.splitSessionId)) {
            options.state.ended = true;
            break;
          }
          await processWaitingRoom(options);
          await persistSplitProcessSession(options.splitSessionId, {
            waitingMonitorHeartbeatAt: new Date(),
            waitingMonitorFailureCount: 0,
          });
        } catch (error) {
          await recordWaitingMonitorFailure(options.splitSessionId, error).catch((error) => logRecoverableError("Recoverable asynchronous operation failed", error));
          await sendOperationalLog({ guild: options.guild, settings: options.settings, fallbackChannel: options.channel, content: `途中参加監視でエラーが発生しました: ${error?.message ?? error}` }).catch((error) => logRecoverableError("Recoverable asynchronous operation failed", error));
        }
        await sleep(WAITING_ROOM_POLL_MS);
      }
  
      if (options.state.ended) {
        localWaitingMonitorSessions.delete(options.splitSessionId);
        return;
      }
  
      const shouldExtendMonitoring = await shouldKeepWaitingRoomAlive(options);
  
      if (shouldExtendMonitoring) {
        await persistSplitProcessSession(options.splitSessionId, {
          waitingMonitorStatus: "extended",
          waitingMonitorExtendedAt: new Date(),
          waitingMonitorHeartbeatAt: new Date(),
        }).catch((error) => logRecoverableError("Recoverable asynchronous operation failed", error));
        await editSplitStartAnnouncementExtended(options.splitStartMessage, options.waitingChannel);
        await sendOperationalLog({
          guild: options.guild,
          settings: options.settings,
          fallbackChannel: options.channel,
          content: "2人以下の子VCが残っているため、途中参加監視を延長します。",
        });
  
        while (!options.state.ended && (await shouldKeepWaitingRoomAlive(options))) {
          try {
            if (!await claimWaitingMonitorLease(options.splitSessionId)) {
              options.state.ended = true;
              break;
            }
            await processWaitingRoom(options);
            await persistSplitProcessSession(options.splitSessionId, { waitingMonitorHeartbeatAt: new Date(), waitingMonitorFailureCount: 0 });
          } catch (error) {
            await recordWaitingMonitorFailure(options.splitSessionId, error).catch((error) => logRecoverableError("Recoverable asynchronous operation failed", error));
            await sendOperationalLog({ guild: options.guild, settings: options.settings, fallbackChannel: options.channel, content: `延長中の途中参加監視でエラーが発生しました: ${error?.message ?? error}` }).catch((error) => logRecoverableError("Recoverable asynchronous operation failed", error));
          }
          await sleep(WAITING_ROOM_POLL_MS);
        }
      }
  
      if (!options.state.ended) {
        const closing = await SplitProcessSession.findOneAndUpdate(
          {
            sessionId: options.splitSessionId,
            status: "active",
            waitingMonitorStatus: { $in: ["active", "extended"] },
            waitingMonitorLeaseOwner: waitingMonitorLeaseOwner,
          },
          { $set: { waitingMonitorStatus: "closing" }, $unset: { waitingMonitorLeaseOwner: 1, waitingMonitorLeaseUntil: 1 } },
          { returnDocument: "after", lean: true },
        ).catch(() => null);
        if (closing) {
          await notifyWaitingVcClosure(options.channel, options.waitingChannel).catch((error) => logRecoverableError("Recoverable asynchronous operation failed", error));
          await editSplitStartAnnouncementClosed(options.splitStartMessage);
          try {
            await options.waitingChannel.delete();
          } catch (error) {
            await SplitProcessSession.updateOne(
              { sessionId: options.splitSessionId, waitingMonitorStatus: "closing" },
              {
                $set: {
                  waitingMonitorStatus: "failed",
                  waitingVcCleanupCompleted: false,
                  lastError: `Waiting VC cleanup failed: ${error?.message ?? error}`,
                },
              },
            );
            await sendOperationalLog({
              guild: options.guild,
              settings: options.settings,
              fallbackChannel: options.channel,
              content: `途中参加監視終了時の待機VC削除に失敗しました: ${error?.message ?? error}`,
            }).catch((error) => logRecoverableError("Recoverable asynchronous operation failed", error));
            return;
          }
          await persistSplitProcessSession(options.splitSessionId, {
            waitingMonitorStatus: "closed",
            waitingMonitorClosedAt: new Date(),
            waitingVcCleanupCompleted: true,
          }).catch((error) => logRecoverableError("Recoverable asynchronous operation failed", error));
        }
        await sendOperationalLog({
          guild: options.guild,
          settings: options.settings,
          fallbackChannel: options.channel,
          content: "途中参加監視を終了しました。",
        });
      }
      localWaitingMonitorSessions.delete(options.splitSessionId);
      } finally {
        localWaitingMonitorSessions.delete(options.splitSessionId);
        await releaseWaitingMonitorLease(options.splitSessionId).catch((error) => {
          console.error(`Failed to release waiting monitor lease for ${options.splitSessionId}: ${error.message}`);
        });
      }
    }
  
    async function processWaitingRoom(options) {
      await processWaitingRollbackTasks(options.splitSessionId, options.guild);
      const waitingMembers = getWaitingMembers(options.waitingChannel);
  
      if (waitingMembers.length === 0) {
        return;
      }
  
      let movedToExistingGroup = false;
      for (const member of waitingMembers) {
        const underfilledChildChannel = await findUnderfilledChildChannel(
          options.guild,
          options.childChannelIds,
          member.id,
          options.previousPairKeys,
          options.currentGroupMembers,
        );
        if (!underfilledChildChannel) break;
        const currentMemberIds = toCurrentGroupMemberIds(
          options.currentGroupMembers,
          underfilledChildChannel.id,
          underfilledChildChannel,
        );
        const repeatedPairCount = currentMemberIds.reduce(
          (count, currentMemberId) =>
            count + (options.previousPairKeys.has(createPairKey(member.id, currentMemberId)) ? 1 : 0),
          0,
        );
        await sendSplitGroupingLog({
          guild: options.guild,
          settings: options.settings,
          content: `[splitvc-history] waiting placement guild=${options.guild.id} session=${options.splitSessionId} user=${member.id} channel=${underfilledChildChannel.id} process=existing-group repeatedPairCount=${repeatedPairCount} memberCount=${currentMemberIds.length}`,
        });
        try {
          const transfer = await moveMemberToChildChannel(
            member,
            underfilledChildChannel,
            options.participantRole,
            options.participantMemberIds,
            options.participantRoleGrantedMemberIds,
            options.splitSessionId,
          );
          if (!transfer.moved) {
            throw new Error(`Participant role grant failed for ${transfer.memberName}`);
          }
          const persistence = await persistWaitingGroupMembers(
            options,
            underfilledChildChannel.id,
            [member.id],
            "existing-group",
            transfer.roleGranted ? [member.id] : [],
          );
          if (!persistence.persisted) continue;
        } catch (error) {
          waitingMemberRetryAfter.set(`${options.guild.id}:${member.id}`, Date.now() + 15_000);
          await sendSplitGroupingLog({
            guild: options.guild,
            settings: options.settings,
            content: `[splitvc-history] waiting transfer failed guild=${options.guild.id} session=${options.splitSessionId} user=${member.id} channel=${underfilledChildChannel.id} process=existing-group error=${error.name ?? "Error"}: ${error.message ?? error}`,
          });
          continue;
        }
        await sendOperationalLog({
          guild: options.guild,
          settings: options.settings,
          fallbackChannel: options.channel,
          content: `途中参加: ${member.displayName} を ${underfilledChildChannel.name} へ転送しました。`,
        });
        movedToExistingGroup = true;
      }
  
      if (movedToExistingGroup) return;
  
      if (waitingMembers.length >= 3) {
        const newGroupMembers = chooseBestMemberSubset(
          waitingMembers,
          3,
          options.previousPairKeys,
        );
        await sendSplitGroupingLog({
          guild: options.guild,
          settings: options.settings,
          content: `[splitvc-history] waiting placement guild=${options.guild.id} session=${options.splitSessionId} users=${newGroupMembers.map((member) => member.id).join(",")} process=new-group repeatedPairCount=${countRepeatedPairs([newGroupMembers], options.previousPairKeys)} candidateCount=100`,
        });
        const result = await transferWaitingGroupToNewChild(newGroupMembers, {
          parentChannel: options.parentChannel,
          participantRole: options.participantRole,
          sourceChannelId: options.waitingChannel.id,
          childCategoryId: options.childCategoryId,
          participantMemberIds: options.participantMemberIds,
          participantRoleGrantedMemberIds: options.participantRoleGrantedMemberIds,
          guild: options.guild,
          settings: options.settings,
          splitSessionId: options.splitSessionId,
          splitMode: options.splitMode,
          childChannelIds: options.childChannelIds,
          nextDirectGroupNumber: options.nextDirectGroupNumber,
        });

        if (result.childChannelId) {
          options.childChannelIds.add(result.childChannelId);
          if (options.splitMode === "direct") options.nextDirectGroupNumber = (options.nextDirectGroupNumber ?? 1) + 1;
          options.currentGroupMembers.set(result.childChannelId, new Set(result.movedMemberIds));
          const persistence = await persistWaitingGroupMembers(
            options,
            result.childChannelId,
            result.movedMemberIds,
            "new-group",
            result.newlyGrantedRoleMemberIds,
          );
          if (!persistence.persisted) return;
        }
        await sendOperationalLog({
          guild: options.guild,
          settings: options.settings,
          fallbackChannel: options.channel,
          content: `途中参加の新規グループ\n${result.lines.join("\n")}`,
        });
      }
    }
  
    function getWaitingMembers(waitingChannel) {
      return [...waitingChannel.members.values()]
        .filter((member) => !member.user.bot)
        .filter((member) => {
          const retryAt = waitingMemberRetryAfter.get(`${waitingChannel.guild.id}:${member.id}`);
          return !retryAt || retryAt <= Date.now();
        })
        .sort((left, right) =>
          left.displayName.localeCompare(right.displayName, "ja"),
        );
    }
  
    async function findUnderfilledChildChannel(
      guild,
      childChannelIds,
      memberId = null,
      previousPairKeys = new Set(),
      currentGroupMembers = null,
    ) {
      let bestChannel = null;
      let bestCount = Infinity;
      const candidates = [];
  
      for (const channelId of childChannelIds) {
        const channel =
          guild.channels.cache.get(channelId) ??
          (await guild.channels.fetch(channelId).catch(() => null));
  
        if (!channel?.isVoiceBased()) {
          continue;
        }
  
        const memberCount = [...channel.members.values()].filter(
          (member) => !member.user.bot,
        ).length;
  
        if (memberCount < WAITING_CHILD_TARGET_SIZE) {
          candidates.push({
            channel,
            memberIds: currentGroupMembers?.get(channel.id)
              ? [...currentGroupMembers.get(channel.id)]
              : [...channel.members.values()]
                  .filter((member) => !member.user.bot)
                  .map((member) => member.id),
          });
          if (memberCount < bestCount) {
            bestChannel = channel;
            bestCount = memberCount;
          }
        }
      }
  
      if (!memberId || candidates.length === 0) {
        return bestChannel;
      }
  
      const selected = chooseBestGroupForMember(memberId, candidates, previousPairKeys);
      return selected ? selected.channel : bestChannel;
    }
  
    async function shouldKeepWaitingRoomAlive(options) {
      for (const channelId of options.childChannelIds) {
        const channel = options.guild.channels.cache.get(channelId)
          ?? await options.guild.channels.fetch(channelId).catch(() => null);
        if (
          channel?.isVoiceBased?.()
          && getNonBotVoiceMembers(channel).length <= WAITING_EXTENSION_MAX_MEMBERS
        ) {
          return true;
        }
      }
      return false;
    }
  
    async function moveMemberToChildChannel(
      member,
      childChannel,
      participantRole,
      participantMemberIds,
      participantRoleGrantedMemberIds,
      splitSessionId,
    ) {
      return moveMemberWithParticipantRole(
        member,
        childChannel,
        "Move waiting participant to PB child channel",
        participantRole,
        participantMemberIds,
        participantRoleGrantedMemberIds,
        splitSessionId,
      );
    }
  
    async function transferWaitingGroupToNewChild(members, config) {
      if (config.splitMode === "direct") {
        return transferWaitingGroupToDirectChild(members, config);
      }
      const lines = [];
      const seedMember = members[0];
  
      try {
        const roleFailures = [];
        const seedHadParticipantRole = seedMember.roles.cache.has(config.participantRole.id);
        const seedTransfer = await moveMemberWithParticipantRole(
          seedMember,
          config.parentChannel,
          "Move waiting group seed to PB parent channel",
          config.participantRole,
          config.participantMemberIds,
          config.participantRoleGrantedMemberIds,
          config.splitSessionId,
        );
  
        if (!seedTransfer.moved) {
          return {
            childChannelId: null,
            lines: [`${seedTransfer.memberName} の参加者ロール付与に失敗しました。`],
          };
        }
  
        const childChannel = await waitForPbChildChannel(seedMember, config);
  
        if (!childChannel) {
          const sourceChannel = await config.guild.channels.fetch(config.sourceChannelId).catch(() => null);
          if (sourceChannel?.isVoiceBased?.()) await seedMember.voice.setChannel(sourceChannel, "Rollback waiting PB child channel creation failure").catch((error) => logRecoverableError(`Failed to return ${seedMember.id} to the source VC`, error));
          if (!seedHadParticipantRole) {
            await removeVoiceParticipantRole(seedMember, config.participantRole.id, {
              sourceType: "splitvc",
              sourceId: config.splitSessionId,
            }).catch((rollbackError) => {
              console.error(`Failed to roll back waiting split participant role for ${seedMember.id}: ${rollbackError.message}`);
            });
            config.participantMemberIds.delete(seedMember.id);
            config.participantRoleGrantedMemberIds?.delete(seedMember.id);
          }
          return {
            childChannelId: null,
            lines: ["PBの子VCを検出できませんでした。"],
          };
        }
  
        await sendSplitRandomTopicPanels({
          guild: config.guild,
          settings: config.settings,
          childChannelIds: [childChannel.id],
        });
  
        let movedCount = 1;
        const movedMemberIds = [seedMember.id];
        const newlyGrantedRoleMemberIds = seedTransfer.roleGranted ? [seedMember.id] : [];
        const failed = [];
  
        for (const member of members.slice(1)) {
          try {
            const transfer = await moveMemberWithParticipantRole(
              member,
              childChannel,
              "Move waiting group members to PB child channel",
              config.participantRole,
              config.participantMemberIds,
              config.participantRoleGrantedMemberIds,
              config.splitSessionId,
            );
  
            if (!transfer.moved) {
              roleFailures.push(transfer.memberName);
              failed.push(member.displayName);
              continue;
            }
  
            movedCount += 1;
            movedMemberIds.push(member.id);
            if (transfer.roleGranted) newlyGrantedRoleMemberIds.push(member.id);
          } catch {
            failed.push(member.displayName);
          }
        }
  
        const failedText =
          failed.length > 0 ? ` 転送失敗: ${failed.join("、")}` : "";
        const roleFailedText =
          roleFailures.length > 0
            ? ` 参加者ロール付与失敗: ${roleFailures.join("、")}`
            : "";
        lines.push(
          `${childChannel.name} へ ${movedCount}/${members.length} 人を転送しました。${failedText}${roleFailedText}`,
        );
  
        return {
          childChannelId: childChannel.id,
          movedMemberIds,
          newlyGrantedRoleMemberIds,
          lines,
        };
      } catch (error) {
        return {
          childChannelId: null,
          lines: [`転送中に失敗しました。${error.message}`],
        };
      }
    }

    async function transferWaitingGroupToDirectChild(members, config) {
      const lines = [];
      const movedMemberIds = [];
      const newlyGrantedRoleMemberIds = [];
      const failed = [];
      const roleFailures = [];
      let childChannel = null;
      try {
        childChannel = await config.guild.channels.create({
          name: `会話練習会(${config.nextDirectGroupNumber ?? (config.childChannelIds?.size ?? 0) + 1})`,
          type: ChannelType.GuildVoice,
          parent: config.childCategoryId,
          userLimit: DIRECT_CHILD_USER_LIMIT,
          reason: "Create direct splitvc waiting-room channel",
        });
        await SplitProcessSession.updateOne(
          { sessionId: config.splitSessionId },
          {
            $addToSet: { childChannelIds: childChannel.id },
            $push: { childChannelStates: { channelId: childChannel.id, groupNumber: config.nextDirectGroupNumber ?? (config.childChannelIds?.size ?? 0) + 1 } },
          },
        );
        if (typeof childChannel.lockPermissions === "function") await childChannel.lockPermissions();
        await sendSplitRandomTopicPanels({
          guild: config.guild,
          settings: config.settings,
          childChannelIds: [childChannel.id],
        });
        for (const member of members) {
          try {
            const transfer = await moveMemberWithParticipantRole(
              member,
              childChannel,
              "Move waiting group member to direct splitvc channel",
              config.participantRole,
              config.participantMemberIds,
              config.participantRoleGrantedMemberIds,
              config.splitSessionId,
            );
            if (!transfer.moved) {
              roleFailures.push(transfer.memberName);
              failed.push(member.displayName);
              continue;
            }
            movedMemberIds.push(member.id);
            if (transfer.roleGranted) newlyGrantedRoleMemberIds.push(member.id);
            await SplitProcessSession.updateOne(
              { sessionId: config.splitSessionId },
              {
                $addToSet: {
                  participantMemberIds: member.id,
                  ...(transfer.roleGranted ? { participantRoleGrantedMemberIds: member.id } : {}),
                },
              },
            ).catch((error) => logRecoverableError(`Failed to persist direct splitvc waiting member ${member.id}`, error));
          } catch (error) {
            failed.push(member.displayName);
            logRecoverableError(`Failed to move waiting member ${member.id} to direct splitvc channel`, error);
          }
        }
        if (movedMemberIds.length === 0) {
          const deleted = await deleteDirectChildChannel(
            childChannel,
            "Remove empty direct splitvc waiting channel",
            `Failed to delete empty direct splitvc waiting channel ${childChannel.id}`,
          );
          if (deleted) {
            await SplitProcessSession.updateOne(
              { sessionId: config.splitSessionId },
              { $pull: { childChannelIds: childChannel.id, childChannelStates: { channelId: childChannel.id } } },
            ).catch((error) => logRecoverableError(`Failed to remove deleted direct splitvc waiting channel ${childChannel.id} from session`, error));
          } else {
            await queueWaitingRollbackTask({
              sessionId: config.splitSessionId,
              channelId: childChannel.id,
              sourceChannelId: config.sourceChannelId,
              deleteChannel: true,
              lastError: `Direct splitvc empty waiting channel rollback is pending for ${childChannel.id}`,
            }).catch((error) => logRecoverableError(`Failed to queue direct splitvc waiting channel rollback ${childChannel.id}`, error));
          }
          return {
            childChannelId: null,
            movedMemberIds: [],
            newlyGrantedRoleMemberIds: [],
            lines: ["転送できたメンバーがいませんでした。"],
          };
        }
        const failedText = failed.length > 0 ? ` 転送失敗: ${failed.join("、")}` : "";
        const roleFailedText = roleFailures.length > 0 ? ` 参加者ロール付与失敗: ${roleFailures.join("、")}` : "";
        lines.push(`${childChannel.name} へ ${movedMemberIds.length}/${members.length} 人を転送しました。${failedText}${roleFailedText}`);
        return { childChannelId: childChannel.id, movedMemberIds, newlyGrantedRoleMemberIds, lines };
      } catch (error) {
        if (childChannel) {
          await queueWaitingRollbackTask({
            sessionId: config.splitSessionId,
            channelId: childChannel.id,
            sourceChannelId: config.sourceChannelId,
            memberIds: movedMemberIds,
            roleMemberIds: newlyGrantedRoleMemberIds,
            deleteChannel: true,
            lastError: `Direct splitvc waiting channel rollback is pending for ${childChannel.id}: ${error.message}`,
          }).then(() => processWaitingRollbackTasks(config.splitSessionId, config.guild))
            .catch((cleanupError) => logRecoverableError(`Failed to queue direct splitvc waiting rollback ${childChannel.id}`, cleanupError));
        }
        return {
          childChannelId: null,
          movedMemberIds: [],
          newlyGrantedRoleMemberIds: [],
          lines: [`転送中に失敗しました。${error.message}`],
        };
      }
    }
  
    async function closeSplitWithoutFeedback(options, reason) {
      // gatheringVcRestorePending is read from the session-owned kokuchi event.
      const finishActionKey = `split-finish-notice:${options.splitSessionId}`;
      const finishClaimed = await claimAction(finishActionKey);
      if (finishClaimed) {
        await finishAction(finishActionKey, "completed", "Feedback window canceled");
      }
      const actionKey = `split-role-remove:${options.splitSessionId}`;
      const claimed = await claimAction(actionKey);
      // Before the finish notice is sent, the durable role-removal action has
      // not been created yet.  Both modes therefore perform the same
      // immediate cancellation cleanup when there is nothing to claim.
      const actionGuard = await getKokuchiActionGuard({
        guildId: options.guild.id,
        eventId: options.kokuchiEventId ?? null,
        expectedRevision: options.kokuchiEventRevision ?? null,
      });
      if (!actionGuard.valid) {
        await stopInvalidKokuchiAction({ actionKey, guild: options.guild, sessionId: options.splitSessionId, guard: actionGuard });
        return;
      }
      const members = normalizeCallWaitMemberIds(options.roleGrantedMemberIds);
      const result = await removeRoleFromMembers(options.guild, options.roleId, members, {
        sourceType: "splitvc",
        sourceId: options.splitSessionId,
      });
      if (result.failed) {
        if (claimed) await failAction(actionKey, `Failed to remove role from ${result.failed} member(s)`).catch((error) => logRecoverableError("Recoverable asynchronous operation failed", error));
        await persistSplitProcessSession(options.splitSessionId, { status: "role_remove_pending", phase: "role_remove_pending", roleRemovalCompleted: false, lastError: `Failed to remove role from ${result.failed} member(s)` });
        throw new Error(`Failed to remove role from ${result.failed} member(s)`);
      }
      const afterRoleRemovalGuard = await getKokuchiActionGuard({
        guildId: options.guild.id,
        eventId: actionGuard.eventId,
        expectedRevision: options.kokuchiEventRevision ?? null,
      });
      if (!afterRoleRemovalGuard.valid) {
        await stopInvalidKokuchiAction({ actionKey, guild: options.guild, sessionId: options.splitSessionId, guard: afterRoleRemovalGuard });
        return;
      }
      const settings = await getGuildSettings(options.guild.id);
      const sessionEventId = options.kokuchiEventId ?? (await SplitProcessSession.findOne({ sessionId: options.splitSessionId }).lean().catch(() => null))?.kokuchiEventId ?? null;
      const sessionEvent = sessionEventId
        ? await KokuchiReservation.findOne({ guildId: options.guild.id, reservationId: sessionEventId }).lean().catch(() => null)
        : null;
      if (sessionEvent && (
        sessionEvent.gatheringVcUnlockState === "opened"
        || sessionEvent.gatheringVcPermissionBeforeOpen
        || isGatheringVcRestoreBlocking(normalizeGatheringVcRestoreStatus(sessionEvent))
      )) {
        const restored = await restoreGatheringVcPermissionAfterSplit(options.guild, settings, { eventId: sessionEventId, force: true })
          .catch((error) => {
            logRecoverableError("Failed to restore gathering VC permission after split cancellation", error);
            return false;
          });
        if (!restored) {
          await sendOperationalLog({
            guild: options.guild,
            settings,
            fallbackChannel: options.channel,
            content: `集合VC権限を復元できませんでした。再起動時に再試行します。session=${options.splitSessionId}`,
          }).catch((error) => logRecoverableError("Failed to log gathering VC restore pending state", error));
        }
      }
      if (sessionEventId) await clearCompletedGatheringVcEventState({ guild: options.guild, eventId: sessionEventId, settings }).catch((error) => logRecoverableError("Failed to clear completed gathering VC event state after split cancellation", error));
      if (claimed) await finishAction(actionKey);
      if (options.temporaryWaitingVcDeleteTimer) clearTimeout(options.temporaryWaitingVcDeleteTimer);
      const waiting = options.temporaryWaitingVc && await options.guild.channels.fetch(options.temporaryWaitingVc.id).catch(() => null);
      if (waiting) {
        await notifyWaitingVcClosure(options.channel, waiting).catch((error) => logRecoverableError("Recoverable asynchronous operation failed", error));
        await waiting.delete().catch((error) => logRecoverableError("Failed to delete temporary waiting VC", error));
        await editSplitStartAnnouncementClosed(options.splitStartMessage).catch((error) => logRecoverableError("Recoverable asynchronous operation failed", error));
      }
      await persistSplitProcessSession(options.splitSessionId, { status: "canceled", phase: "canceled", roleRemovalCompleted: true, waitingVcCleanupCompleted: true, reviewAggregationEligible: false, completedAt: new Date(), lastError: reason });
      options.state.ended = true;
    }
  
    async function sendClaimedSplitFinishNotice(options) {
      const actionKey = `split-finish-notice:${options.splitSessionId}`;
      const claimed = await claimAction(actionKey);
      if (!claimed) return false;
    try {
      const session = await SplitProcessSession.findOne({ sessionId: options.splitSessionId }).lean();
        if (session && !session.finishNoticeSent) {
          const sent = await sendSplitFinishNotice({ guild: options.guild, session, channelId: options.channel.id });
          if (!sent) {
            await finishAction(actionKey, "canceled", "Kokuchi event was canceled or its lifecycle revision changed");
            return false;
          }
        }
        await finishAction(actionKey);
        return true;
      } catch (error) {
        await failAction(actionKey, error.message).catch((error) => logRecoverableError("Recoverable asynchronous operation failed", error));
        throw error;
      }
    }
  
    async function runEndNotificationFlow(options) {
      const notificationCanceled = await runCountdown({
        channel: options.channel, ownerId: options.ownerId, totalMs: options.noticeWaitMs, updateEveryMs: COUNTDOWN_UPDATE_MS,
        cancellationKey: options.splitSessionId,
        buttonLabel: "終了通知キャンセル", cancelText: "終了通知はキャンセルされました。参加者ロールをすぐ解除します。",
        // Direct-created VC cleanup is independent from the finish-notice
        // schedule.  Empty rooms may be removed before this deadline, but the
        // notice itself must never be sent early just because every room is
        // empty.
        autoCancelWhen: options.splitMode === "direct"
          ? null
          : () => areAllChannelsGone(options.guild, options.childChannelIds),
        render: (remainingMs) => `終了通知まで残り ${formatDuration(remainingMs)} です。\nキャンセルできるのはコマンド実行者のみです。`,
      });
      if (notificationCanceled === "external") {
        options.state.ended = true;
        return;
      }
      if (notificationCanceled === false) {
        await sendClaimedSplitFinishNotice(options);
        options.state.ended = true;
        return;
      }
      const session = await SplitProcessSession.findOne({ sessionId: options.splitSessionId }).lean();
      const conversationStarted = Boolean(session?.conversationStartedAt && (session.groupSnapshots ?? []).some((group) => group.memberIds?.length));
      if (notificationCanceled === "auto" && conversationStarted) {
        await sendClaimedSplitFinishNotice(options);
        if (options.temporaryWaitingVcDeleteTimer) clearTimeout(options.temporaryWaitingVcDeleteTimer);
        try {
          const waiting = options.temporaryWaitingVc
            ? await options.guild.channels.fetch(options.temporaryWaitingVc.id).catch(() => null)
            : null;
          if (waiting) {
            await notifyWaitingVcClosure(options.channel, waiting).catch((error) => logRecoverableError("Recoverable asynchronous operation failed", error));
            await waiting.delete();
            await editSplitStartAnnouncementClosed(options.splitStartMessage).catch((error) => logRecoverableError("Recoverable asynchronous operation failed", error));
          }
        } catch (error) {
          await sendOperationalLog({
            guild: options.guild,
            settings: options.settings,
            fallbackChannel: options.channel,
            content: `早期終了時の待機VC削除に失敗しました: ${error.message}`,
          }).catch((error) => logRecoverableError("Recoverable asynchronous operation failed", error));
        }
        options.state.ended = true;
        return;
      }
      await closeSplitWithoutFeedback(options, notificationCanceled === "auto" ? "All child channels disappeared before conversation started" : "Finish notification canceled manually");
    }
  
    async function persistWaitingGroupMembers(options, channelId, memberIds, processName, newlyGrantedRoleMemberIds = []) {
      const groupMembers = options.currentGroupMembers.get(channelId) ?? new Set();
      for (const memberId of memberIds) {
        groupMembers.add(memberId);
      }
      options.currentGroupMembers.set(channelId, groupMembers);
  
      try {
        const session = await SplitProcessSession.findOne({ sessionId: options.splitSessionId }).lean();
        const existingGroupIndex = (session?.groupSnapshots ?? []).findIndex((group) => group.channelId === channelId);
        const groupNumber = existingGroupIndex >= 0
          ? session.groupSnapshots[existingGroupIndex].groupNumber
          : (session?.groupSnapshots?.length ?? 0) + 1;
        const update = {
          $addToSet: {
            childChannelIds: channelId,
            participantMemberIds: { $each: memberIds },
            participantRoleGrantedMemberIds: { $each: newlyGrantedRoleMemberIds },
          },
          $set: {
            waitingMonitorHeartbeatAt: new Date(),
            waitingMonitorFailureCount: 0,
          },
        };
        if (existingGroupIndex >= 0) {
          update.$addToSet[`groupSnapshots.${existingGroupIndex}.memberIds`] = { $each: memberIds };
        } else {
          update.$push = {
            groupSnapshots: { groupNumber, channelId, memberIds },
          };
        }
        const persisted = await SplitProcessSession.updateOne(
          {
            sessionId: options.splitSessionId,
            status: "active",
            waitingMonitorStatus: { $in: ["active", "extended"] },
          },
          update,
        );
        if (persisted.matchedCount !== 1 || persisted.modifiedCount !== 1) {
          const error = new Error("Split waiting-session persistence did not update the active session.");
          error.persistenceReason = persisted.matchedCount !== 1 ? "session_not_found" : "persistence_not_modified";
          throw error;
        }
        return { persisted: true, groupCreated: existingGroupIndex < 0 };
      } catch (error) {
        const rollbackErrors = [];
        let childChannelDeleted = false;
        for (const memberId of memberIds) {
          try {
            const member = await options.guild.members.fetch(memberId);
            if (member.voice.channelId === channelId && options.waitingChannel?.isVoiceBased?.()) {
              await member.voice.setChannel(options.waitingChannel, "Rollback waiting transfer after persistence failure");
            }
            if (newlyGrantedRoleMemberIds.includes(memberId) && options.participantRole?.id) {
              await removeVoiceParticipantRole(member, options.participantRole.id, {
                sourceType: "splitvc",
                sourceId: options.splitSessionId,
              });
              options.participantRoleGrantedMemberIds?.delete(memberId);
            }
            options.participantMemberIds?.delete(memberId);
            groupMembers.delete(memberId);
          } catch (rollbackError) {
            rollbackErrors.push(`${memberId}: ${rollbackError.message}`);
          }
        }
        if (processName === "new-group") {
          options.childChannelIds?.delete(channelId);
          options.currentGroupMembers.delete(channelId);
          try {
            const childChannel = await options.guild.channels.fetch(channelId);
            await childChannel?.delete("Rollback split waiting child after persistence failure");
            childChannelDeleted = true;
          } catch (rollbackError) {
            if (rollbackError?.code === 10003) childChannelDeleted = true;
            else rollbackErrors.push(`child channel ${channelId}: ${rollbackError.message}`);
          }
        }
        const lastError = `Waiting transfer persistence failed: ${error.message}${rollbackErrors.length ? `; rollback failures: ${rollbackErrors.join(" | ")}` : ""}`;
        let marked;
        if (rollbackErrors.length > 0) {
          marked = await queueWaitingRollbackTask({
            sessionId: options.splitSessionId,
            channelId,
            sourceChannelId: options.waitingChannel?.id,
            memberIds,
            roleMemberIds: newlyGrantedRoleMemberIds,
            deleteChannel: processName === "new-group",
            lastError,
          }).then((task) => ({ matchedCount: task ? 1 : 0 })).catch((stateError) => {
            console.error(`Failed to queue split waiting rollback: ${stateError.message}`);
            return null;
          });
        } else {
          const pull = {
            participantMemberIds: { $in: memberIds },
            participantRoleGrantedMemberIds: { $in: newlyGrantedRoleMemberIds },
          };
          if (processName === "new-group" && childChannelDeleted) {
            pull.childChannelIds = channelId;
            pull.childChannelStates = { channelId };
            pull.groupSnapshots = { channelId };
          } else {
            pull["groupSnapshots.$[].memberIds"] = { $in: memberIds };
          }
          marked = await SplitProcessSession.updateOne(
            { sessionId: options.splitSessionId },
            {
              $pull: pull,
              $set: { lastError },
              $inc: { waitingMonitorFailureCount: 1 },
            },
          ).catch((stateError) => {
            console.error(`Failed to persist split waiting rollback: ${stateError.message}`);
            return null;
          });
        }
        if (!marked || marked.matchedCount !== 1) {
          console.error(`Split waiting persistence failure state could not be confirmed for ${options.splitSessionId}`);
        }
        await sendSplitGroupingLog({
          guild: options.guild,
          settings: options.settings,
          content: `[splitvc-history] current update failed guild=${options.guild.id} session=${options.splitSessionId} users=${memberIds.join(",")} channel=${channelId} process=${processName} error=${error.name ?? "Error"}: ${error.message ?? error}`,
        });
        return {
          persisted: false,
          reason: error.persistenceReason ?? "persistence_failed",
        };
      }
    }
  
    async function removeRoleFromMembers(guild, roleId, memberIds, source) {
      let removed = 0;
      let failed = 0;
  
      for (const memberId of memberIds) {
        try {
          const member = await guild.members.fetch(memberId);
          await removeVoiceParticipantRole(member, roleId, source);
          removed += 1;
        } catch (error) {
          console.error(`Failed to remove split participant role from ${memberId}: ${error.message}`);
          failed += 1;
        }
      }
  
      return { removed, failed };
    }
  
    async function areAllChannelsGone(guild, channelIds) {
      const ids = [...channelIds];
  
      if (ids.length === 0) {
        return false;
      }
  
      for (const channelId of ids) {
        const cachedChannel = guild.channels.cache.get(channelId);
  
        if (cachedChannel) {
          return false;
        }
  
        const fetchedChannel = await guild.channels
          .fetch(channelId)
          .catch(() => null);
  
        if (fetchedChannel) {
          return false;
        }
      }
  
      return true;
    }
  
    function cancelSplitCountdown(splitSessionId) {
      const session = splitCountdownSessions.get(splitSessionId);
      if (!session) return false;
      session.externallyCanceled = true;
      session.canceled = true;
      return true;
    }
  
    async function runCountdown(options) {
      if (options.totalMs <= 0) {
        return false;
      }
  
      const sessionId = createSessionId();
      const session = {
        ownerId: options.ownerId,
        canceled: false,
        externallyCanceled: false,
        cancelText: options.cancelText,
      };
      const cancellationKey = options.cancellationKey ?? null;
      const cleanupCountdown = () => {
        activeSessions.delete(sessionId);
        if (cancellationKey && splitCountdownSessions.get(cancellationKey) === session) {
          splitCountdownSessions.delete(cancellationKey);
        }
      };
  
      activeSessions.set(sessionId, session);
      if (cancellationKey) splitCountdownSessions.set(cancellationKey, session);
  
      const message = await options.channel.send({
        content: options.render(options.totalMs),
        components: [createCancelRow(sessionId, options.buttonLabel)],
      });
  
      const startedAt = Date.now();
  
      while (Date.now() - startedAt < options.totalMs) {
        if (session.canceled) {
          cleanupCountdown();
          await deleteLater(message);
          return session.externallyCanceled ? "external" : true;
        }
  
        const elapsedMs = Date.now() - startedAt;
        const remainingMs = Math.max(0, options.totalMs - elapsedMs);
        await sleep(Math.min(options.updateEveryMs, remainingMs));
  
        if (!session.canceled && options.autoCancelWhen) {
          const shouldAutoCancel = await options.autoCancelWhen();
  
          if (shouldAutoCancel) {
            cleanupCountdown();
            await editSafely(message, {
              content: "PBの子VCがすべて削除されたため、終了通知を自動キャンセルします。",
              components: [],
            });
            await deleteLater(message);
            return "auto";
          }
        }
  
        if (!session.canceled) {
          await editSafely(message, {
            content: options.render(Math.max(0, options.totalMs - (Date.now() - startedAt))),
            components: [createCancelRow(sessionId, options.buttonLabel)],
          });
        }
      }
  
      cleanupCountdown();
      await deleteLater(message);
      return false;
    }
  
    async function handleSessionButton(interaction) {
      if (!interaction.customId.startsWith("session_cancel:")) {
        return;
      }
  
      const sessionId = interaction.customId.slice("session_cancel:".length);
      const session = activeSessions.get(sessionId);
  
      if (!session) {
        await interaction.reply({
          content: "この待機操作はすでに終了しています。",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
  
      if (interaction.user.id !== session.ownerId) {
        await interaction.reply({
          content: "このボタンを押せるのは、コマンドを実行した人だけです。",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
  
      session.canceled = true;
      await interaction.update({
        content: session.cancelText,
        components: [],
      });
    }
  
    function createCancelRow(sessionId, label) {
      return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`session_cancel:${sessionId}`)
          .setLabel(label)
          .setStyle(ButtonStyle.Danger),
      );
    }
  
    function formatCurrentSettings(settings) {
      if (!settings) return "設定はまだ保存されていません。";
      return [
        "VC未参加者・長期不参加者向けDM",
        `有効: ${settings.vcDmEnabled === true ? "有効" : "無効"}`,
        `対象確認パネル: ${settings.vcDmPanelChannelId ? `<#${settings.vcDmPanelChannelId}>` : "未設定"}`,
        `対象VCカテゴリ: ${settings.vcDmTargetCategoryId ? `<#${settings.vcDmTargetCategoryId}>` : "未設定"}`,
        `対象VC個別指定: ${settings.vcDmTargetChannelIds?.length ? settings.vcDmTargetChannelIds.map((id) => `<#${id}>`).join(" ") : "未設定"}`,
        `対象外VC: ${settings.vcDmExcludedChannelIds?.length ? settings.vcDmExcludedChannelIds.map((id) => `<#${id}>`).join(" ") : "なし"}`,
        "",
        "【splitvc】",
        `VC作成方式: ${normalizeSplitMode(settings) === "direct" ? "Bot直接作成" : "PB互換モード"}`,
        `参加者ロール: ${settings.tempRoleId ? `<@&${settings.tempRoleId}>` : "未設定"}`,
        `直接作成先カテゴリ: ${settings.childCategoryId ? `<#${settings.childCategoryId}>` : "未設定"}`,
        `PB親VC: ${settings.parentChannelId ? `<#${settings.parentChannelId}>` : "未設定"}`,
        `待機VCカテゴリ: ${settings.waitingVcCategoryId ? `<#${settings.waitingVcCategoryId}>` : "未設定"}`,
        `待機VC名: ${settings.waitingVcName || DEFAULT_WAITING_VC_NAME}`,
        `転送待機: ${getNonNegativeInteger(settings.transferWaitSeconds, DEFAULT_TRANSFER_WAIT_SECONDS)}秒`,
        `終了通知待機: ${getNonNegativeInteger(settings.noticeWaitMinutes, DEFAULT_NOTICE_WAIT_MINUTES)}分`,
        `ロール解除待機: ${getNonNegativeInteger(settings.roleRemoveWaitMinutes, DEFAULT_ROLE_REMOVE_WAIT_MINUTES)}分`,
        "",
        "【VC集合】",
        `有効: ${settings.voiceReminderEnabled === false ? "無効" : "有効"}`,
        `対象VC親: ${getVoiceReminderParentChannelIds(settings).length ? getVoiceReminderParentChannelIds(settings).map((id) => `<#${id}>`).join(" ") : "未設定"}`,
        `参加者ロール: ${settings.voiceParticipantRoleId ? `<@&${settings.voiceParticipantRoleId}>` : "未設定"}`,
        "",
        "【kokuchi】",
        `開催時刻: ${normalizeKokuchiEventTime(settings.kokuchiEventTime) ?? "21:00"}`,
        `告知・スタート案内: ${getKokuchiAnnouncementChannelId(settings) ? `<#${getKokuchiAnnouncementChannelId(settings)}>` : "未設定"}`,
        `集合VC: ${settings.gatheringVoiceChannelId ? `<#${settings.gatheringVoiceChannelId}>` : "未設定"}`,
        "",
        "【フォーム・運用】",
        `フォーム設置先: ${settings.formChannelId ? `<#${settings.formChannelId}>` : "未設定"}`,
        `フォーム転送先: ${settings.formSendChannelId ? `<#${settings.formSendChannelId}>` : "未設定"}`,
        `運用ログ: ${settings.logChannelId ? `<#${settings.logChannelId}>` : "未設定"}`,
        "",
        "【定時募集・ボタン募集】",
        `有効: ${settings.callWaitEnabled === true ? "有効" : "無効"}`,
        `募集方式: ボタン式`,
        `通話希望者ロール: ${settings.callWaitRoleId ? `<@&${settings.callWaitRoleId}>` : "未設定"}`,
        `募集作成用チャンネル: ${getCallWaitPromptChannelId(settings) ? `<#${getCallWaitPromptChannelId(settings)}>` : "未設定"}`,
        `常設パネル・集合通知: ${getCallWaitNoticeChannelId(settings) ? `<#${getCallWaitNoticeChannelId(settings)}>` : "未設定"}`,
        `募集通知ロール: ${settings.bosyuMentionRoleId ? `<@&${settings.bosyuMentionRoleId}>` : "未設定"}`,
        `定時募集間隔: ${getCallWaitIntervalMinutes(settings)}分（JST 0:00基準）`,
        `参加確認キャンセル猶予: ${getOteboQuickConfirmSeconds(settings)}秒`,
      ].join("\n");
    }
  
    function formatLegacySettings(settings) {
      return formatCurrentSettings(settings);
      /*
      if (!settings) {
        return "PB連携設定はまだ保存されていません。";
      }
  
      return [
        "【splitvc】",
        `参加者ロール: ${settings.tempRoleId ? `<@&${settings.tempRoleId}>` : "未設定"}`,
        `PB親チャンネル: ${settings.parentChannelId ? `<#${settings.parentChannelId}>` : "未設定"}`,
        `子VCカテゴリ: ${settings.childCategoryId ? `<#${settings.childCategoryId}>` : "未設定"}`,
        `待機VCカテゴリ: ${settings.waitingVcCategoryId ? `<#${settings.waitingVcCategoryId}>` : "未設定"}`,
        `待機VC名: ${settings.waitingVcName || DEFAULT_WAITING_VC_NAME}`,
        `転送前待機: ${getNonNegativeInteger(settings.transferWaitSeconds, DEFAULT_TRANSFER_WAIT_SECONDS)}秒`,
        `終了通知前待機: ${getNonNegativeInteger(settings.noticeWaitMinutes, DEFAULT_NOTICE_WAIT_MINUTES)}分`,
        `通知後ロール解除待機: ${getNonNegativeInteger(settings.roleRemoveWaitMinutes, DEFAULT_ROLE_REMOVE_WAIT_MINUTES)}分`,
        `終了通知文: ${settings.finishMessage || DEFAULT_FINISH_MESSAGE}`,
        "",
        "【通常募集】",
        `使用チャンネル: ${settings.bosyuChannelId ? `<#${settings.bosyuChannelId}>` : "制限なし"}`,
        `メンションロール: ${settings.bosyuMentionRoleId ? `<@&${settings.bosyuMentionRoleId}>` : "未設定"}`,
        "",
        "【雑談・VC集合】",
        `機能: ${settings.voiceReminderEnabled === false ? "無効" : "有効"}`,
        `対象PB親VC: ${getVoiceReminderParentChannelIds(settings).length ? getVoiceReminderParentChannelIds(settings).map((id) => `<#${id}>`).join(" ") : "未設定"}`,
        `対象子VCカテゴリ: ${settings.voiceReminderChildCategoryId ? `<#${settings.voiceReminderChildCategoryId}>` : "未設定"}`,
        `明示的な監視VC: ${Array.isArray(settings.voiceMonitorVoiceChannelIds) && settings.voiceMonitorVoiceChannelIds.length ? settings.voiceMonitorVoiceChannelIds.map((id) => `<#${id}>`).join(" ") : "未設定（子VCカテゴリ判定を使用）"}`,
        `参加者ロール: ${settings.voiceParticipantRoleId ? `<@&${settings.voiceParticipantRoleId}>` : "未設定"}`,
        "",
        "【kokuchi】",
        `開催予定時刻: ${normalizeKokuchiEventTime(settings.kokuchiEventTime) ?? "21:00"}`,
        `30分前通知時刻: ${formatKokuchiDerivedTime(settings, 30)}`,
        `VC開放時刻: ${formatKokuchiDerivedTime(settings, 20)}`,
        `募集開始通知時刻: ${formatKokuchiDerivedTime(settings, 5)}`,
        `/kokuchi告知・スタート案内送信先: ${getKokuchiAnnouncementChannelId(settings) ? `<#${getKokuchiAnnouncementChannelId(settings)}>` : "未設定"}`,
        `概要チャンネル: ${getKokuchiOverviewChannelId(settings) ? `<#${getKokuchiOverviewChannelId(settings)}>` : "未設定"}`,
        `集合VC: ${settings.gatheringVoiceChannelId ? `<#${settings.gatheringVoiceChannelId}>` : "未設定"}`,
        `告知メンションロール: ${Array.isArray(settings.kokuchiMentionRoleIds) && settings.kokuchiMentionRoleIds.length > 0 ? settings.kokuchiMentionRoleIds.map((roleId) => `<@&${roleId}>`).join(" ") : "未設定"}`,
        `終了後意見・苦情チャンネル: ${settings.splitFeedbackChannelId ? `<#${settings.splitFeedbackChannelId}>` : `<#${DEFAULT_SPLIT_FEEDBACK_CHANNEL_ID}>`}`,
        "",
        "【フォーム・感想】",
        `フォーム設置先: ${settings.formChannelId ? `<#${settings.formChannelId}>` : "未設定"}`,
        `フォーム転送先: ${settings.formSendChannelId ? `<#${settings.formSendChannelId}>` : "未設定"}`,
        `感想送信先: ${settings.reviewSendChannelId ? `<#${settings.reviewSendChannelId}>` : "未設定"}`,
        `モデレーターロール: ${settings.formModeratorRoleId ? `<@&${settings.formModeratorRoleId}>` : "未設定"}`,
        "",
        "【運用ログ】",
        `送信先: ${settings.logChannelId ? `<#${settings.logChannelId}>` : "未設定"}`,
        "",
        "【定時募集・通話待機】",
        `機能: ${settings.callWaitEnabled === true ? "有効" : "無効"}`,
        "募集方式: ボタン式",
        `参加希望者ロール: ${settings.callWaitRoleId ? `<@&${settings.callWaitRoleId}>` : "未設定"}`,
        `募集メッセージ送信先: ${getCallWaitPromptChannelId(settings) ? `<#${getCallWaitPromptChannelId(settings)}>` : "未設定"}`,
        `集合通知送信先: ${getCallWaitNoticeChannelId(settings) ? `<#${getCallWaitNoticeChannelId(settings)}>` : "未設定"}`,
        `定時募集メッセージ送信先: ${getCallWaitPromptChannelId(settings) ? `<#${getCallWaitPromptChannelId(settings)}>` : "未設定"}`,
        `参加確認VCカテゴリ: ${settings.callWaitVoiceCategoryId ? `<#${settings.callWaitVoiceCategoryId}>` : "未設定"}`,
        `募集間隔: ${getCallWaitIntervalMinutes(settings)}分（JST 0:00基準）`,
        `ボタン募集の参加確認キャンセル猶予: ${getOteboQuickConfirmSeconds(settings)}秒`,
      ].join("\n");
      */
    }
  
    function formatSettings(settings) {
      const text = formatLegacySettings(settings);
      if (!settings) return text;
      return `${text}\n\n【布教テーマ】\n投稿先: ${settings.fukyoThemeChannelId ? `<#${settings.fukyoThemeChannelId}>` : "未設定"}\n自動投稿: ${settings.fukyoWeeklyThemeEnabled ? "有効" : "無効"}\n登録数: ${settings.fukyoThemes?.length ?? 0}\n\n【プロフィール】\n自己紹介チャンネル: ${settings.profileIntroductionChannelId ? `<#${settings.profileIntroductionChannelId}>` : "未設定"}\n\n【VCコントロール】\n対象カテゴリ: ${settings.vcControlCategoryId ? `<#${settings.vcControlCategoryId}>` : "未設定"}\n通知ロール: ${settings.vcControlNotifyRoleId ? `<@&${settings.vcControlNotifyRoleId}>` : "未設定"}\n退出予定通知を残す: ${settings.voiceExitScheduleKeepMessage !== false ? "はい" : "いいえ"}`;
    }
  
    async function persistSplitParticipantMemberIds(sessionId, participantMemberIds) {
      if (!sessionId || participantMemberIds.size === 0) {
        return;
      }
  
      await SplitProcessSession.updateOne(
        { sessionId },
        { $addToSet: { participantMemberIds: { $each: [...participantMemberIds] } } },
      );
    }
  
    function formatResult(channel, total, groups) {
      const lines = [
        `**${channel.name} のグループ分け**`,
        describeGroups(total, groups),
        "",
      ];
  
      groups.forEach((group, index) => {
        const members = group
          .map((member) => `- ${escapeMarkdown(member.displayName)}`)
          .join("\n");
  
        lines.push(`**グループ ${index + 1} (${group.length}人)**`);
        lines.push(members);
        lines.push("");
      });
  
      return lines.join("\n").trim();
    }
  
    function escapeMarkdown(text) {
      return text.replace(/([\\`*_{}[\]()#+\-.!|>])/g, "\\$1");
    }
  
    function splitMessage(content, maxLength = MESSAGE_LIMIT) {
      const chunks = [];
      let current = "";
  
      for (const line of content.split("\n")) {
        if (line.length > maxLength) {
          if (current) {
            chunks.push(current);
            current = "";
          }
  
          for (let index = 0; index < line.length; index += maxLength) {
            chunks.push(line.slice(index, index + maxLength));
          }
  
          continue;
        }
  
        const next = current ? `${current}\n${line}` : line;
  
        if (next.length > maxLength) {
          chunks.push(current);
          current = line;
        } else {
          current = next;
        }
      }
  
      if (current) {
        chunks.push(current);
      }
  
      return chunks.length > 0 ? chunks : [content];
    }
  
    async function replyInChunks(interaction, content, options) {
      const chunks = splitMessage(content);
      const [firstChunk, ...restChunks] = chunks;
  
      if (interaction.deferred) {
        await interaction.editReply({ content: firstChunk, allowedMentions: options.allowedMentions, components: options.components });
      } else {
        await interaction.reply({ ...options, content: firstChunk });
      }
  
      for (const chunk of restChunks) {
        await interaction.followUp({
          ...options,
          content: chunk,
        });
      }
    }
  
    async function sendChunked(channel, content, options = {}) {
      for (const chunk of splitMessage(content)) {
        await channel.send({
          ...options,
          content: chunk,
        });
      }
    }
  
    async function replySafely(interaction, content) {
      const payload = {
        content,
        flags: MessageFlags.Ephemeral,
      };
  
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(payload).catch(() => null);
      } else {
        await interaction.reply(payload).catch(() => null);
      }
    }
  
    async function replyOrFollowUp(interaction, payload) {
      if (!payload || typeof payload !== "object") {
        payload = { content: String(payload ?? ""), flags: MessageFlags.Ephemeral };
      }
  
      try {
        if (interaction.deferred && !interaction.__initialResponseSent) {
          await interaction.editReply(payload);
          interaction.__initialResponseSent = true;
        } else if (interaction.replied || interaction.deferred) {
          await interaction.followUp(payload);
        } else {
          await interaction.reply(payload);
        }
      } catch (error) {
        console.error("Interaction response failed", {
          guildId: interaction.guildId ?? null,
          channelId: interaction.channelId ?? null,
          userId: interaction.user?.id ?? null,
          interactionId: interaction.id ?? null,
          commandName: interaction.commandName ?? interaction.customId ?? null,
          deferred: Boolean(interaction.deferred),
          replied: Boolean(interaction.replied),
          discordErrorCode: error?.code ?? null,
          error: error?.stack ?? error?.message ?? String(error),
        });
      }
    }
  
    async function editSafely(message, payload) {
      await message.edit(payload).catch(() => null);
    }
  
    function formatVoiceTopicStatus(topicText) {
      const normalizedTopicText = String(topicText ?? "")
        .replace(/\s+/g, " ")
        .trim();
  
      return normalizedTopicText ? `今の話題：${normalizedTopicText}` : "";
    }
  
    async function setVoiceChannelStatus(voiceChannel, status, reason) {
      if (!voiceChannel?.isVoiceBased()) {
        throw new Error("Target channel is not a voice channel.");
      }
  
      await client.rest.put(`/channels/${voiceChannel.id}/voice-status`, {
        body: { status },
        reason,
      });
    }
  
    async function deleteLater(message) {
      await sleep(1500);
      await message.delete().catch(() => null);
    }
  
    async function notifyWaitingVcClosure(operationChannel, waitingVc) {
      const waitingMembers = [...waitingVc.members.values()].filter(
        (member) => !member.user.bot,
      );
  
      if (waitingMembers.length === 0) {
        return;
      }
  
      await operationChannel.send(
        "誠に申し訳ございませんが、途中参加の条件がそろわなかったため途中参加部屋が削除されました。次の機会があればぜひまたご参加ください",
      );
    }
  
    function getSendableChannel(interaction) {
      const channel = interaction.channel;
      return channel && typeof channel.send === "function" ? channel : null;
    }
  
    function createSessionId() {
      return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    }
  
    function addMany(set, values) {
      for (const value of values) {
        set.add(value);
      }
    }
  
    function formatDuration(ms) {
      const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
      const minutes = Math.floor(totalSeconds / 60);
      const seconds = totalSeconds % 60;
  
      return `${minutes}分${seconds.toString().padStart(2, "0")}秒`;
    }
  
    function getNonNegativeInteger(value, fallback) {
      return Number.isInteger(value) && value >= 0 ? value : fallback;
    }
  
    function secondsToMs(seconds) {
      return seconds * 1000;
    }
  
    function minutesToMs(minutes) {
      return minutes * 60 * 1000;
    }
  
    function sleep(ms) {
      return new Promise((resolve) => {
        setTimeout(resolve, ms);
      });
    }
  

  return {
    getKokuchiActionGuard,
    stopInvalidKokuchiAction,
    persistSplitProcessSession,
    createCallWaitInterestRow,
    isKokuchiCallWaitPaused,
    sendSplitFinishNotice,
    clearRestoredWaitingMonitor,
    claimWaitingMonitorLease,
    releaseWaitingMonitorLease,
    recordWaitingMonitorFailure,
    createRestoredWaitingGroup,
    processRestoredWaitingMonitor,
    startRestoredWaitingMonitor,
    restoreSplitProcessSessions,
    formatKokuchiMessage,
    formatSplitStartAnnouncement,
    formatSplitStartExtendedAnnouncement,
    formatSplitStartClosedAnnouncement,
    editSplitStartAnnouncementExtended,
    editSplitStartAnnouncementClosed,
    fetchSplitStartAnnouncement,
    getWadaiTopics,
    getDefaultWadaiTopicsForCategory,
    normalizeWadaiTopic,
    formatWadaiList,
    parseWadaiTarget,
    normalizeWadaiTarget,
    createWadaiTopicId,
    saveGuildSettingsWithCurrent,
    handleTopicRequestMessage,
    handleVoiceStateUpdate,
    queueVoiceParticipantRoleUpdate,
    isMemberCurrentlyInMonitoredVoiceChannel,
    getVoiceMonitorRoleRetryKey,
    clearVoiceMonitorRoleRetryState,
    isDiscordUnknownMemberError,
    getVoiceMonitorRetryOperation,
    markExactVoiceMonitorGrantRemoved,
    recordVoiceMonitorRoleFailure,
    getVoiceMonitorFinalFailureLogKey,
    clearVoiceMonitorFinalFailureLogs,
    sendVoiceMonitorFinalFailureLog,
    sendVoiceMonitorOperationalFailureLog,
    retryVoiceMonitorRoleGrant,
    findAssociatedTextChannel,
    createAutoSplitRow,
    maybeSendAutoSplitSuggestion,
    deleteAutoSplitSuggestionMessage,
    isVoiceChannelMonitored,
    getVoiceReminderParentChannelIds,
    resolveVoiceReminderParentChannel,
    isPbChildVoiceChannel,
    getNonBotVoiceMembers,
    getVoiceMonitorSessionKey,
    isMemberInActiveVoiceMonitorContext,
    updateVoiceMonitorSession,
    stopVoiceMonitorSessionIfStillUnderfilled,
    startVoiceMonitorSession,
    handleOteboVoiceStartedRecruitment,
    persistAutoSplitSuggestion,
    clearAutoSplitSuggestion,
    restoreVoiceMonitorSessions,
    shutdown: shutdownDirectChildMonitors,
    isPersistedVoiceMonitorGrantInCurrentContext,
    reconcilePersistedVoiceParticipantRoleGrants,
    sendVoiceMonitorStartNotice,
    deleteVoiceMonitorTopicForms,
    scheduleVoiceMonitorTopicFormDeletion,
    ensureSessionMembersHaveRole,
    stopVoiceMonitorSession,
    createTopicFormRow,
    createVoiceTopicModal,
    handleTopicFormButton,
    handleAutoSplitButton,
    splitIntoTwoRandomGroups,
    transferMembersToPbChildChannel,
    handleSuggestTopicButton,
    handleTopicFormModal,
    removeVoiceParticipantRole,
    handleSplitVoice,
    getPbChildChannelName,
    resolveProcessConfig,
    moveMemberWithParticipantRole,
    transferGroups,
    waitForPbChildChannel,
    isExpectedPbChildChannel,
    runWaitingRoomMonitor,
    processWaitingRoom,
    getWaitingMembers,
    findUnderfilledChildChannel,
    shouldKeepWaitingRoomAlive,
    moveMemberToChildChannel,
    transferWaitingGroupToNewChild,
    closeSplitWithoutFeedback,
    sendClaimedSplitFinishNotice,
    runEndNotificationFlow,
    persistWaitingGroupMembers,
    removeRoleFromMembers,
    areAllChannelsGone,
    cancelSplitCountdown,
    runCountdown,
    handleSessionButton,
    createCancelRow,
    formatCurrentSettings,
    formatLegacySettings,
    formatSettings,
    persistSplitParticipantMemberIds,
    formatResult,
    escapeMarkdown,
    splitMessage,
    replyInChunks,
    sendChunked,
    replySafely,
    replyOrFollowUp,
    editSafely,
    formatVoiceTopicStatus,
    setVoiceChannelStatus,
    deleteLater,
    notifyWaitingVcClosure,
    getSendableChannel,
    createSessionId,
    addMany,
    formatDuration,
    getNonNegativeInteger,
    secondsToMs,
    minutesToMs,
    sleep,
  };
}
