export function createKokuchiFeature(dependencies) {
  const {
    ActionRowBuilder,
        ButtonBuilder,
        ButtonStyle,
        GATHERING_VC_RESTORE_BLOCKING_STATUS_VALUES,
        KOKUCHI_RESERVATION_CANCEL_CUSTOM_ID,
        KokuchiReservation,
        MAX_GATHERING_VC_RESTORE_ATTEMPTS,
        MessageFlags,
        PermissionFlagsBits,
        PermissionsBitField,
        SplitProcessSession,
        acquireMongoLease,
        canCloseGatheringVcAfterSplit,
        cancelKokuchiRoleRemovalWait,
        cancelKokuchiScheduledActions,
        cancelKokuchiTimedActions,
        cleanupAtForKokuchiReservation,
        client,
        createEveryonePermissionSnapshot,
        createSessionId,
        editEveryoneConnectPermission,
        formatJstReservationTime,
        formatKokuchiMessage,
        gatheringVcRestoreRetryTimers,
        gatheringVcUnlockTimers,
        getGatheringVcRestoreRetryDelayMs,
        getGuildSettings,
        getKokuchiActionGuard,
        getKokuchiAnnouncementChannelId,
        getKokuchiEventDate,
        getKokuchiExecutionBlockReason,
        getKokuchiReminderStatusOnCancel,
        getKokuchiReservationCleanupAt,
        getNextKokuchiEventAt,
        getNextKokuchiReservationAt,
        getRestorePermissionPatch,
        hasActiveKokuchiEvent,
        isGatheringVcPermissionSnapshotValid,
        isGatheringVcRestoreBlocking,
        isGatheringVcRestoreOwnedByEvent,
        isKokuchiEventActionInvalid,
        kokuchiGatheringReminderTimers,
        kokuchiPreNoticeTimers,
        kokuchiPublishGuildLocks,
        kokuchiReservationTimers,
        logRecoverableError,
        normalizeGatheringVcRestoreStatus,
        normalizeKokuchiStatus,
        patchGuildSettingsForKokuchiEvent,
        permissionSnapshotMatches,
        releaseMongoLease,
        replyOrFollowUp,
        requestOperationalStatusRefresh,
        resolveConfiguredTextChannel,
        resolveKokuchiGatheringVoiceChannelId,
        resolveWadaiSendChannel,
        runGatheringVcOpenTransaction,
        saveGuildSettingsWithCurrent,
        sendOperationalLog,
        transitionKokuchiGatheringReminder,
        transitionKokuchiTimedAction
  } = dependencies;

  async function handleKokuchi(interaction) {
    if (!interaction.inGuild()) {
      await replyOrFollowUp(interaction, {
        content: "このコマンドはサーバー内で使ってください。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  
    if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild)) {
      await replyOrFollowUp(interaction, {
        content: "告知を投稿するには、サーバー管理権限が必要です。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  
    const weekday = interaction.options.getString("weekday", true);
    const overviewChannel = interaction.options.getChannel("overview_channel", false);
    const targetChannel = interaction.options.getChannel("channel", false);
    const settings = await getGuildSettings(interaction.guildId);
    const sendChannel =
      targetChannel && typeof targetChannel.send === "function"
        ? targetChannel
        : await resolveWadaiSendChannel(interaction.guild, settings, null);
  
    if (!sendChannel) {
      await replyOrFollowUp(interaction, {
        content:
          "告知送信先を取得できませんでした。`channel` を指定するか、`/setting kokuchi announcement_channel:送信先` を設定してください。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  
    const resolvedOverviewChannel =
      overviewChannel ??
      (settings?.kokuchiOverviewChannelId
        ? await interaction.guild.channels
            .fetch(settings.kokuchiOverviewChannelId)
            .catch(() => null)
        : null);
  
    if (!resolvedOverviewChannel || typeof resolvedOverviewChannel.send !== "function") {
      await replyOrFollowUp(interaction, {
        content:
          "概要案内チャンネルが未設定です。`/setting kokuchi overview_channel:概要案内チャンネル` を設定してください。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const botMember = interaction.guild.members.me ?? await interaction.guild.members.fetchMe().catch(() => null);
    const sendPermissions = botMember && sendChannel.permissionsFor?.(botMember);
    if (sendPermissions && (!sendPermissions.has(PermissionFlagsBits.ViewChannel) || !sendPermissions.has(PermissionFlagsBits.SendMessages))) {
      await replyOrFollowUp(interaction, {
        content: "告知先チャンネルを閲覧・送信する権限がBotにありません。権限を確認してから再実行してください。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  
    const setHour = interaction.options.getInteger("set", false);
    const activeReservation = await KokuchiReservation.findOne({
      guildId: interaction.guildId,
      status: { $in: ["pending", "processing"] },
    }).lean();
    if (activeReservation) {
      await replyOrFollowUp(interaction, {
        content: "すでに告知の送信予約があります。変更する場合は、現在の予約をキャンセルしてからもう一度実行してください。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  
    const kokuchiBlock = await getKokuchiExecutionBlockReason(interaction.guildId, settings);
    if (kokuchiBlock) {
      await replyOrFollowUp(interaction, {
        content: `${kokuchiBlock.message}${kokuchiBlock.severity === "warning" ? " 自動再試行を継続しています。" : ""}`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (hasActiveKokuchiEvent(settings)) {
      await replyOrFollowUp(interaction, {
        content: "前回のkokuchiに関連する処理がまだ完了していません。前回の後続処理をキャンセルするか、イベント終了後にもう一度実行してください。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  
    if (setHour !== null && setHour !== undefined) {
      const scheduledAt = getNextKokuchiReservationAt({ weekday, hour: setHour });
      if (!scheduledAt) {
        await replyOrFollowUp(interaction, { content: "予約時刻を解釈できませんでした。", flags: MessageFlags.Ephemeral });
        return;
      }
      const reservationId = createSessionId();
      const recoveryLease = await acquireMongoLease(`kokuchi-recovery:${interaction.guildId}`, { leaseMs: 5 * 60 * 1000 }).catch((error) => {
        logRecoverableError("Failed to acquire kokuchi recovery lease", error);
        return null;
      });
      if (!recoveryLease) {
        await replyOrFollowUp(interaction, { content: "kokuchiの復旧処理が実行中です。完了してから再実行してください。", flags: MessageFlags.Ephemeral });
        return;
      }
      try {
      // The reminder is sent only when the reservation is at least exactly
      // thirty minutes away.  A reservation made 29:59 beforehand is skipped.
      const reminderStatus = scheduledAt.getTime() - Date.now() < 30 * 60 * 1000 ? "skipped" : "pending";
      let reservation;
      try {
        reservation = await KokuchiReservation.create({
        guildId: interaction.guildId, reservationId, weekday, displayHour: setHour, scheduledAt,
        eventDate: getKokuchiEventDate(scheduledAt, setHour),
        eventAt: getNextKokuchiEventAt({ weekday, eventTime: normalizeKokuchiEventTime(settings?.kokuchiEventTime) ?? "21:00", now: scheduledAt }),
        activeKey: interaction.guildId,
        publicationKey: `${interaction.guildId}:${getKokuchiEventDate(scheduledAt, setHour)}`,
        commandUserId: interaction.user.id, commandChannelId: interaction.channelId,
        targetChannelId: sendChannel.id, overviewChannelId: resolvedOverviewChannel.id,
         kokuchiStatus: "scheduled",
         gatheringVcRestoreEventId: reservationId,
         gatheringVcRestoreStatus: "not_required",
        gatheringVcRestorePending: false,
        reminderStatus,
        });
      } catch (error) {
        if (error?.code === 11000) {
          await replyOrFollowUp(interaction, { content: "すでに告知の送信予約があります。変更する場合は、現在の予約をキャンセルしてからもう一度実行してください。", flags: MessageFlags.Ephemeral });
          return;
        }
        throw error;
      }
      try {
      const confirmation = await interaction.channel.send({
        content: `告知は${formatJstReservationTime(scheduledAt, setHour)}に送信されます。`,
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`${KOKUCHI_RESERVATION_CANCEL_CUSTOM_ID}:${reservationId}`).setLabel("送信をキャンセル").setStyle(ButtonStyle.Danger),
        )],
      });
      const confirmationSaved = await KokuchiReservation.updateOne(
        { _id: reservation._id, status: "pending" },
        { $set: { confirmationChannelId: confirmation.channelId, confirmationMessageId: confirmation.id } },
      );
      if (confirmationSaved.matchedCount !== 1 || confirmationSaved.modifiedCount !== 1) {
        await confirmation.edit({ content: "【予約失敗】\n\n予約情報を確定できなかったため、送信は行われません。", components: [] }).catch((error) => logRecoverableError("Failed to update rejected kokuchi reservation confirmation", error));
        await KokuchiReservation.updateOne(
          { _id: reservation._id, status: "pending" },
          { $set: { status: "failed", failedAt: new Date(), cleanupAt: cleanupAtForKokuchiReservation(reservation) }, $unset: { activeKey: 1 } },
        );
        throw new Error("Reservation confirmation ID persistence failed");
      }
      await scheduleKokuchiReservation(interaction.guild, { ...reservation.toObject(), confirmationChannelId: confirmation.channelId, confirmationMessageId: confirmation.id });
      } catch (error) {
        // A reservation without its confirmation/cancel control must not remain
        // active.  This also releases the sparse active-key slot.
        clearKokuchiReservationTimers(reservationId);
        await KokuchiReservation.deleteOne({ _id: reservation._id, status: "pending" });
        console.error("Kokuchi reservation confirmation failed:", error);
        await replyOrFollowUp(interaction, {
          content: "予約の確認メッセージを送信できなかったため、予約を取り消しました。",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      await replyOrFollowUp(interaction, { content: "予約を受け付けました。", flags: MessageFlags.Ephemeral });
      } finally {
        await releaseMongoLease(recoveryLease).catch((error) => logRecoverableError("Failed to release kokuchi recovery lease", error));
      }
      return;
    }
  
    const recoveryLease = await acquireMongoLease(`kokuchi-recovery:${interaction.guildId}`, { leaseMs: 5 * 60 * 1000 }).catch((error) => {
      logRecoverableError("Failed to acquire kokuchi recovery lease", error);
      return null;
    });
    if (!recoveryLease) {
      await replyOrFollowUp(interaction, { content: "kokuchiの復旧処理が実行中です。完了してから再実行してください。", flags: MessageFlags.Ephemeral });
      return;
    }
    try {
      await publishImmediateKokuchi({
        interaction,
        weekday,
        sendChannel,
        overviewChannel: resolvedOverviewChannel,
        settings,
      });
    } catch (error) {
      if (error?.code === 11000) {
        await replyOrFollowUp(interaction, {
          content: "この開催日の告知はすでに投稿済み、または送信確認中です。重複投稿を防ぐため再送しません。",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      throw error;
    } finally {
      await releaseMongoLease(recoveryLease).catch((releaseError) => logRecoverableError("Failed to release kokuchi recovery lease", releaseError));
    }
  
    await replyOrFollowUp(interaction, {
      content: `告知を ${sendChannel} に投稿しました。`,
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
  }
  
  async function publishImmediateKokuchi({ interaction, weekday, sendChannel, overviewChannel, settings }) {
    const now = new Date();
    const jstHour = new Date(now.getTime() + 9 * 60 * 60 * 1000).getUTCHours();
    const eventDate = getKokuchiEventDate(now, jstHour);
    const eventAt = getNextKokuchiEventAt({ weekday, eventTime: normalizeKokuchiEventTime(settings?.kokuchiEventTime) ?? "21:00", now });
    const reservationId = createSessionId();
    const reservation = await KokuchiReservation.create({
      guildId: interaction.guildId,
      reservationId,
      weekday,
      displayHour: jstHour,
      scheduledAt: now,
      eventDate,
      eventAt,
      activeKey: interaction.guildId,
      publicationKey: `${interaction.guildId}:${eventDate}`,
      commandUserId: interaction.user.id,
      commandChannelId: interaction.channelId,
      targetChannelId: sendChannel.id,
      overviewChannelId: overviewChannel.id,
      status: "processing",
      kokuchiStatus: "running",
      publicationStatus: "processing",
      publicationStartedAt: now,
      postProcessingStatus: "pending",
       reminderStatus: "skipped",
       gatheringVcRestoreEventId: reservationId,
       gatheringVcRestoreStatus: "not_required",
      gatheringVcRestorePending: false,
    });
  
    try {
      await publishKokuchi({
        guild: interaction.guild,
        weekday,
        sendChannel,
        overviewChannel,
        settings,
        eventAt,
        kokuchiEventId: reservation.reservationId,
        kokuchiEventRevision: reservation.lifecycleRevision ?? 0,
        leaseKey: `kokuchi-publish:${interaction.guildId}:${eventDate}`,
        onPublished: async ({ postedMessage, postedAt }) => {
          const persisted = await KokuchiReservation.updateOne(
            { _id: reservation._id, status: "processing" },
            {
              $set: {
                publicationStatus: "published",
                publicationChannelId: postedMessage.channelId,
                publicationMessageId: postedMessage.id,
                publicationSentAt: postedAt,
                postProcessingStatus: "processing",
              },
            },
          );
          if (persisted.matchedCount !== 1 || persisted.modifiedCount !== 1) {
            throw new Error("Immediate kokuchi publication message ID could not be persisted");
          }
        },
      });
      const completed = await KokuchiReservation.updateOne(
        { _id: reservation._id, status: "processing" },
        {
          $set: {
            status: "sent",
            kokuchiStatus: "completed",
            sentAt: new Date(),
            cleanupAt: cleanupAtForKokuchiReservation(reservation),
            publicationStatus: "published",
            publicationConfirmedAt: new Date(),
            postProcessingStatus: "completed",
          },
          $unset: { activeKey: 1, processingAt: 1, postProcessingError: 1 },
        },
      );
      if (completed.matchedCount !== 1 || completed.modifiedCount !== 1) {
        throw new Error("Immediate kokuchi publication succeeded but confirmation could not be persisted");
      }
      await createKokuchiCancellationControl(interaction.channel, reservation).catch((error) => logRecoverableError("Failed to create immediate kokuchi cancellation control", error));
    } catch (error) {
      const publication = error?.kokuchiPublication ?? null;
      const unconfirmed = Boolean(publication || error?.kokuchiPublicationAttempted === true);
      const failed = await KokuchiReservation.updateOne(
        { _id: reservation._id, status: "processing" },
        {
          $set: unconfirmed
            ? {
              status: "published_unconfirmed",
              kokuchiStatus: "running",
              publicationStatus: "published_unconfirmed",
              publicationChannelId: publication?.channelId,
              publicationMessageId: publication?.messageId,
              publicationSentAt: publication?.sentAt ?? new Date(),
              postProcessingStatus: "failed",
              postProcessingError: error.message,
              publishedAt: new Date(),
              recoveryReason: `Immediate Discord publication may have succeeded: ${error.message}`,
            }
            : {
              status: "failed",
              kokuchiStatus: "scheduled",
              publicationStatus: "failed_before_publish",
              postProcessingStatus: "failed",
              postProcessingError: error.message,
              failedAt: new Date(),
              cleanupAt: cleanupAtForKokuchiReservation(reservation),
            },
          $unset: unconfirmed
            ? { activeKey: 1, processingAt: 1 }
            : { activeKey: 1, processingAt: 1, publicationKey: 1 },
        },
      );
      if (failed.matchedCount !== 1) {
        console.error(`Immediate kokuchi failure state could not be persisted for ${reservation.reservationId}`);
      }
      throw error;
    }
  }
  
  async function restoreGatheringVcUnlockSchedules() {
    for (const guild of client.guilds.cache.values()) {
      const settings = await getGuildSettings(guild.id);
      await scheduleKokuchiPreNotice(guild, settings);
      await scheduleGatheringVcUnlock(guild, settings);
      await scheduleKokuchiGatheringReminder(guild, settings);
    }
  }
  
  async function scheduleKokuchiPreNotice(guild, settings) {
    clearKokuchiPreNoticeTimer(guild.id);
  
    if (
      !settings?.kokuchiEventId ||
      !settings?.kokuchiPreNoticeChannelId ||
      !["pending", "failed"].includes(settings.kokuchiPreNoticeState)
    ) {
      return;
    }
  
    const noticeAt = new Date(settings.kokuchiPreNoticeAt);
  
    if (!Number.isFinite(noticeAt.getTime())) {
      return;
    }
  
    const now = new Date();
  
    if (noticeAt.getTime() <= now.getTime()) {
      await transitionKokuchiTimedAction({
        guildId: guild.id,
        kokuchiEventId: settings?.kokuchiEventId,
        stateKey: "kokuchiPreNoticeState",
        fromStates: ["pending", "failed"],
        toState: "skipped",
      });
      return;
    }
  
    const timer = setTimeout(() => {
      kokuchiPreNoticeTimers.delete(guild.id);
      void sendKokuchiPreNotice(guild.id).catch((error) => {
        console.error(`Failed to send kokuchi pre notice: ${error.message}`, error);
      }).finally(() => requestOperationalStatusRefresh(guild.id, "kokuchi-pre-notice"));
    }, noticeAt.getTime() - now.getTime());
  
    kokuchiPreNoticeTimers.set(guild.id, timer);
  }
  
  function clearKokuchiPreNoticeTimer(guildId) {
    const timer = kokuchiPreNoticeTimers.get(guildId);
  
    if (timer) {
      clearTimeout(timer);
      kokuchiPreNoticeTimers.delete(guildId);
    }
  }
  
  async function sendKokuchiPreNotice(guildId) {
    const guild =
      client.guilds.cache.get(guildId) ??
      (await client.guilds.fetch(guildId).catch(() => null));
  
    if (!guild) {
      return;
    }
  
    const settings = await getGuildSettings(guild.id);
  
    if (
      !settings?.kokuchiEventId ||
      !settings?.kokuchiPreNoticeChannelId ||
      !["pending", "failed"].includes(settings.kokuchiPreNoticeState)
    ) {
      return;
    }
  
    const noticeAt = new Date(settings.kokuchiPreNoticeAt);
  
    const now = new Date();
    if (!Number.isFinite(noticeAt.getTime()) || noticeAt.getTime() + 5_000 < now.getTime()) {
      await transitionKokuchiTimedAction({
        guildId: guild.id,
        kokuchiEventId: settings?.kokuchiEventId,
        stateKey: "kokuchiPreNoticeState",
        fromStates: ["pending", "failed"],
        toState: "skipped",
      });
      return;
    }
  
    const claimed = await transitionKokuchiTimedAction({
      guildId: guild.id,
      kokuchiEventId: settings?.kokuchiEventId,
      stateKey: "kokuchiPreNoticeState",
      fromStates: ["pending", "failed"],
      toState: "processing",
    });
    if (!claimed) return;
  
    const actionGuard = await getKokuchiActionGuard({
      guildId: guild.id,
      eventId: claimed.kokuchiEventId,
    });
    if (!actionGuard.valid) {
      await transitionKokuchiTimedAction({
        guildId: guild.id,
        kokuchiEventId: claimed.kokuchiEventId,
        stateKey: "kokuchiPreNoticeState",
        fromStates: ["processing"],
        toState: "canceled",
        patch: { kokuchiPreNoticeLastError: "Kokuchi event was canceled or its lifecycle revision changed" },
      });
      return;
    }
  
    const channel = await resolveConfiguredTextChannel(
      guild,
      claimed.kokuchiPreNoticeChannelId,
    );
  
    if (!channel) {
      await transitionKokuchiTimedAction({
        guildId: guild.id,
        kokuchiEventId: claimed.kokuchiEventId,
        stateKey: "kokuchiPreNoticeState",
        fromStates: ["processing"],
        toState: "failed",
        patch: { kokuchiPreNoticeLastError: "Configured pre-notice channel could not be resolved" },
      });
      return;
    }
  
    const beforeDiscord = await getKokuchiActionGuard({
      guildId: guild.id,
      eventId: claimed.kokuchiEventId,
      expectedRevision: actionGuard.revision,
    });
    if (!beforeDiscord.valid) {
      await transitionKokuchiTimedAction({
        guildId: guild.id,
        kokuchiEventId: claimed.kokuchiEventId,
        stateKey: "kokuchiPreNoticeState",
        fromStates: ["processing"],
        toState: "canceled",
        patch: { kokuchiPreNoticeLastError: "Kokuchi event was canceled before the pre-notice was sent" },
      });
      return;
    }
  
    const message = await channel.send({
      content: "30分前です！ぜひご参加ください！",
      allowedMentions: { parse: [] },
    }).catch((error) => {
      console.error(`Failed to send kokuchi pre notice: ${error.message}`);
      return null;
    });
  
    if (!message) {
      await transitionKokuchiTimedAction({
        guildId: guild.id,
        kokuchiEventId: claimed.kokuchiEventId,
        stateKey: "kokuchiPreNoticeState",
        fromStates: ["processing"],
        toState: "sent_unconfirmed",
        patch: { kokuchiPreNoticeLastError: "Discord pre-notice send result was not confirmed; automatic retry was disabled to prevent duplicates" },
      });
      return;
    }
  
    const afterDiscord = await getKokuchiActionGuard({
      guildId: guild.id,
      eventId: claimed.kokuchiEventId,
      expectedRevision: actionGuard.revision,
    });
    if (!afterDiscord.valid) {
      if (message?.delete) await message.delete().catch((error) => logRecoverableError("Failed to compensate pre-notice after kokuchi cancellation", error));
      await transitionKokuchiTimedAction({
        guildId: guild.id,
        kokuchiEventId: claimed.kokuchiEventId,
        stateKey: "kokuchiPreNoticeState",
        fromStates: ["processing"],
        toState: "canceled",
        patch: { kokuchiPreNoticeLastError: "Kokuchi event was canceled after the pre-notice was sent" },
      });
      return;
    }
  
    await transitionKokuchiTimedAction({
      guildId: guild.id,
      kokuchiEventId: claimed.kokuchiEventId,
      stateKey: "kokuchiPreNoticeState",
      fromStates: ["processing"],
      toState: "sent",
      patch: {
        kokuchiPreNoticeMessage: {
          channelId: channel.id,
          messageId: message.id,
          sentAt: new Date().toISOString(),
        },
      },
    });
  }
  
  async function migrateKokuchiEventState() {
    // Replace the legacy unconditional cleanup TTL index with the partial index
    // that excludes incomplete gathering-VC restorations.
    const indexSync = KokuchiReservation.syncIndexes?.();
    if (indexSync?.catch) await indexSync.catch((error) => {
      console.error("Failed to synchronize kokuchi reservation indexes:", error);
    });
    const lifecycleMigrations = [
      ["pending", "scheduled"],
      ["processing", "running"],
      ["sent", "completed"],
      ["published", "completed"],
      ["published_unconfirmed", "running"],
      ["failed", "scheduled"],
      ["canceling", "canceling"],
      ["canceled", "canceled"],
      ["cancel_partial", "canceled"],
    ];
    for (const [legacyStatus, kokuchiStatus] of lifecycleMigrations) {
      await KokuchiReservation.updateMany(
        { status: legacyStatus, kokuchiStatus: { $exists: false } },
        { $set: { kokuchiStatus } },
      );
    }
    await KokuchiReservation.updateMany(
      { lifecycleRevision: { $exists: false } },
      { $set: { lifecycleRevision: 0, cancelRequested: false } },
    );
    await KokuchiReservation.updateMany(
      { cancelRequested: { $exists: false } },
      { $set: { cancelRequested: false } },
    );
    await KokuchiReservation.updateMany(
      {
        gatheringVcRestoreEventId: { $exists: false },
        $or: [
          { gatheringVcRestorePending: true },
          { gatheringVcRestoreStatus: { $in: GATHERING_VC_RESTORE_BLOCKING_STATUS_VALUES } },
          { gatheringVcPermissionBeforeOpen: { $exists: true, $ne: null } },
          { gatheringVcUnlockState: { $in: ["opened", "closing", "closed"] } },
        ],
      },
      [
        {
          $set: {
            gatheringVcRestoreEventId: "$reservationId",
            gatheringVcRestoreEventRevision: { $ifNull: ["$gatheringVcRestoreEventRevision", { $ifNull: ["$lifecycleRevision", 0] }] },
          },
        },
      ],
    );
    await KokuchiReservation.updateMany(
      {
        gatheringVcRestorePending: { $exists: false },
        $or: [
          { gatheringVcRestoreStatus: { $in: GATHERING_VC_RESTORE_BLOCKING_STATUS_VALUES } },
          { gatheringVcPermissionBeforeOpen: { $exists: true, $ne: null } },
          { gatheringVcUnlockState: { $in: ["opened", "closing", "closed"] } },
        ],
      },
      { $set: { gatheringVcRestorePending: true } },
    );
    await KokuchiReservation.updateMany(
      {
        gatheringVcRestorePending: { $exists: false },
        gatheringVcRestoreStatus: { $in: ["not_required", "restored"] },
      },
      { $set: { gatheringVcRestorePending: false } },
    );
    await KokuchiReservation.updateMany(
      {
        gatheringVcRestorePending: { $exists: false },
        gatheringVcRestoreStatus: { $exists: false },
        gatheringVcPermissionBeforeOpen: { $exists: false },
        gatheringVcUnlockState: { $nin: ["opened", "closing", "closed"] },
      },
      { $set: { gatheringVcRestorePending: false, gatheringVcRestoreStatus: "not_required" } },
    );
    await KokuchiReservation.updateMany(
      {
        gatheringVcRestorePending: true,
        $or: [
          { gatheringVcRestoreStatus: { $exists: false } },
          { gatheringVcRestoreStatus: { $in: ["not_required", "restored"] } },
        ],
      },
      { $set: { gatheringVcRestoreStatus: "pending" } },
    );
    // A legacy terminal cleanup date must never remove an event that still
    // owns a gathering-VC snapshot.  This also repairs records where the
    // pending boolean was lost but the authoritative restore status survived.
    await KokuchiReservation.updateMany(
      {
        cleanupAt: { $exists: true },
        $or: [
          { gatheringVcRestorePending: true },
          { gatheringVcRestoreStatus: { $in: GATHERING_VC_RESTORE_BLOCKING_STATUS_VALUES } },
          { gatheringVcPermissionBeforeOpen: { $exists: true, $ne: null } },
        ],
      },
      { $unset: { cleanupAt: 1 } },
    );
    for (const guild of client.guilds.cache.values()) {
      const settings = await getGuildSettings(guild.id).catch(() => null);
      const eventId = settings?.kokuchiEventId;
      if (!eventId) continue;
      const event = await KokuchiReservation.findOne({ guildId: guild.id, reservationId: eventId }).lean();
      if (!event) continue;
      const hasLegacyCurrentIdentity = settings.gatheringVcStateEventId === eventId;
      // Without an event identity, a legacy channel/snapshot cannot be proven to
      // belong to the current event. Keep it orphaned for operator review rather
      // than reusing a previous event's gathering-VC state for a new event.
      if (!hasLegacyCurrentIdentity) continue;
      const restoreStatus = normalizeGatheringVcRestoreStatus({
        gatheringVcRestoreStatus: event.gatheringVcRestoreStatus ?? settings.gatheringVcRestoreStatus,
        gatheringVcRestorePending: event.gatheringVcRestorePending ?? settings.gatheringVcRestorePending,
      });
      await KokuchiReservation.updateOne(
        { _id: event._id },
        {
          $set: {
            gatheringVcUnlockChannelId: event.gatheringVcUnlockChannelId ?? settings.gatheringVcUnlockChannelId ?? null,
            gatheringVcRestoreEventId: event.gatheringVcRestoreEventId ?? eventId,
            gatheringVcRestoreEventRevision: event.gatheringVcRestoreEventRevision ?? event.lifecycleRevision ?? 0,
            gatheringVcUnlockState: event.gatheringVcUnlockState ?? settings.gatheringVcUnlockState ?? "skipped",
            gatheringVcPermissionBeforeOpen: event.gatheringVcPermissionBeforeOpen ?? settings.gatheringVcPermissionBeforeOpen ?? null,
            gatheringVcRestorePending: event.gatheringVcRestorePending ?? settings.gatheringVcRestorePending === true,
            gatheringVcRestoreStatus: restoreStatus,
            gatheringVcRestoreFailureCode: event.gatheringVcRestoreFailureCode ?? settings.gatheringVcRestoreFailureCode ?? null,
            gatheringVcRestoreAttemptCount: event.gatheringVcRestoreAttemptCount ?? settings.gatheringVcRestoreAttemptCount ?? 0,
            gatheringVcRestoreLastError: event.gatheringVcRestoreLastError ?? settings.gatheringVcRestoreLastError ?? null,
            gatheringVcRestoreNextRetryAt: event.gatheringVcRestoreNextRetryAt ?? settings.gatheringVcRestoreNextRetryAt ?? null,
            ...(event.gatheringVcOpenedAt || settings.gatheringVcUnlockState !== "opened" ? {} : { gatheringVcOpenedAt: settings.gatheringVcOpenedAt ?? settings.gatheringVcUnlockAt ?? new Date() }),
          },
        },
      );
      if (!hasLegacyCurrentIdentity) {
        await patchGuildSettingsForKokuchiEvent({
          guildId: guild.id,
          kokuchiEventId: eventId,
          set: { gatheringVcStateEventId: eventId },
        });
      }
    }
  }
  
  async function restorePendingGatheringVcPermissions() {
    for (const guild of client.guilds.cache.values()) {
      try {
        const settings = await getGuildSettings(guild.id);
        const pendingEvents = await KokuchiReservation.find({
          guildId: guild.id,
          $or: [
            { gatheringVcRestorePending: true },
            { gatheringVcRestoreStatus: { $in: GATHERING_VC_RESTORE_BLOCKING_STATUS_VALUES } },
          ],
        }).lean();
        for (const event of pendingEvents) {
          const activeSplit = await SplitProcessSession.exists({
            guildId: guild.id,
            kokuchiEventId: event.reservationId,
            status: { $in: ["active", "feedback_open", "role_remove_pending", "cleaning_up"] },
          });
          if (activeSplit) continue;
          const restoreStatus = normalizeGatheringVcRestoreStatus(event);
          if (restoreStatus === "restoring") {
            await KokuchiReservation.updateOne(
              { _id: event._id, reservationId: event.reservationId, gatheringVcRestoreStatus: "restoring" },
              { $set: { gatheringVcRestoreStatus: "retry_wait", gatheringVcRestoreNextRetryAt: new Date() }, $unset: { cleanupAt: 1 } },
            );
            event.gatheringVcRestoreStatus = "retry_wait";
            event.gatheringVcRestoreNextRetryAt = new Date();
          }
          if (normalizeGatheringVcRestoreStatus(event) === "pending") {
            await attemptScheduledGatheringVcRestore(guild, event.reservationId);
          } else if (normalizeGatheringVcRestoreStatus(event) === "retry_wait") {
            if (new Date(event.gatheringVcRestoreNextRetryAt).getTime() <= Date.now()) {
              await attemptScheduledGatheringVcRestore(guild, event.reservationId);
            } else {
              scheduleGatheringVcRestoreRetry(guild, event);
            }
          }
        }
        // Keep legacy settings visible to operators, but never use their old
        // channel/snapshot as a fallback for a different event.
        if (settings?.gatheringVcRestorePending && !pendingEvents.length) {
          requestOperationalStatusRefresh(guild.id, "orphaned-gathering-vc-restore");
        }
      } catch (error) {
        logRecoverableError(`Failed to restore pending gathering VC permission for ${guild.id}`, error);
      }
    }
  }
  
  async function scheduleGatheringVcUnlock(guild, settings) {
    clearGatheringVcUnlockTimer(guild.id);
  
    if (!getGatheringVcUnlockChannelId(settings)) {
      return;
    }
  
    const unlockAt = new Date(settings.gatheringVcUnlockAt);
  
    if (!Number.isFinite(unlockAt.getTime())) {
      return;
    }
  
    const now = new Date();
  
    if (
      settings.gatheringVcUnlockState === "opened" &&
      isSameJstDate(unlockAt, now)
    ) {
      await setGatheringVcConnectPermission({
        guild,
        settings,
        canConnect: true,
        reason: "会話練習会の集合VC設定変更に伴う開放",
      });
      return;
    }
  
    if (!["pending", "failed"].includes(settings.gatheringVcUnlockState)) {
      return;
    }
  
    if (unlockAt.getTime() <= now.getTime()) {
      // A delayed process must never replay an action from earlier today.
      await transitionKokuchiTimedAction({
        guildId: guild.id,
        kokuchiEventId: settings?.kokuchiEventId,
        stateKey: "gatheringVcUnlockState",
        fromStates: ["pending", "failed"],
        toState: "skipped",
      });
      return;
    }
  
    const timer = setTimeout(() => {
      gatheringVcUnlockTimers.delete(guild.id);
      void applyGatheringVcUnlock(guild.id).catch((error) => {
        console.error(`Failed to unlock gathering VC: ${error.message}`, error);
      }).finally(() => requestOperationalStatusRefresh(guild.id, "gathering-vc-unlock"));
    }, unlockAt.getTime() - now.getTime());
  
    gatheringVcUnlockTimers.set(guild.id, timer);
  }
  
  function clearGatheringVcUnlockTimer(guildId) {
    const timer = gatheringVcUnlockTimers.get(guildId);
  
    if (timer) {
      clearTimeout(timer);
      gatheringVcUnlockTimers.delete(guildId);
    }
  }
  
  async function scheduleKokuchiGatheringReminder(guild, settings) {
    clearKokuchiGatheringReminderTimer(guild.id);
  
    if (
      !settings?.kokuchiEventId ||
      !settings?.kokuchiGatheringReminderChannelId ||
      !["pending", "failed"].includes(settings.kokuchiGatheringReminderState)
    ) {
      return;
    }
  
    const remindAt = new Date(settings.kokuchiGatheringReminderAt);
  
    if (!Number.isFinite(remindAt.getTime())) {
      return;
    }
  
    const now = new Date();
  
    if (remindAt.getTime() <= now.getTime()) {
      // A reminder is useful only before its scheduled time.
      await transitionKokuchiGatheringReminder({
        guildId: guild.id,
        kokuchiEventId: settings?.kokuchiEventId,
        fromStates: ["pending", "failed"],
        toState: "skipped",
      });
      return;
    }
  
    const timer = setTimeout(() => {
      kokuchiGatheringReminderTimers.delete(guild.id);
      void sendKokuchiGatheringReminder(guild.id).catch((error) => {
        console.error(
          `Failed to send kokuchi gathering reminder: ${error.message}`,
          error,
        );
      }).finally(() => requestOperationalStatusRefresh(guild.id, "kokuchi-gathering-reminder"));
    }, remindAt.getTime() - now.getTime());
  
    kokuchiGatheringReminderTimers.set(guild.id, timer);
  }
  
  function clearKokuchiGatheringReminderTimer(guildId) {
    const timer = kokuchiGatheringReminderTimers.get(guildId);
  
    if (timer) {
      clearTimeout(timer);
      kokuchiGatheringReminderTimers.delete(guildId);
    }
  }
  
  async function sendKokuchiGatheringReminder(guildId) {
    const guild =
      client.guilds.cache.get(guildId) ??
      (await client.guilds.fetch(guildId).catch(() => null));
  
    if (!guild) {
      return;
    }
  
    const settings = await getGuildSettings(guild.id);
  
    if (
      !settings?.kokuchiEventId ||
      !settings?.kokuchiGatheringReminderChannelId ||
      !["pending", "failed"].includes(settings.kokuchiGatheringReminderState)
    ) {
      return;
    }
  
    const remindAt = new Date(settings.kokuchiGatheringReminderAt);
  
    const now = new Date();
    if (!Number.isFinite(remindAt.getTime()) || remindAt.getTime() + 5_000 < now.getTime()) {
      await transitionKokuchiGatheringReminder({
        guildId: guild.id,
        kokuchiEventId: settings?.kokuchiEventId,
        fromStates: ["pending", "failed"],
        toState: "skipped",
      });
      return;
    }
  
    const claimed = await transitionKokuchiGatheringReminder({
      guildId: guild.id,
      kokuchiEventId: settings?.kokuchiEventId,
      fromStates: ["pending", "failed"],
      toState: "sending",
    });
  
    if (!claimed) {
      return;
    }
  
    const actionGuard = await getKokuchiActionGuard({
      guildId: guild.id,
      eventId: claimed.kokuchiEventId,
    });
    if (!actionGuard.valid) {
      await transitionKokuchiGatheringReminder({
        guildId: guild.id,
        kokuchiEventId: claimed.kokuchiEventId,
        fromStates: ["sending"],
        toState: "canceled",
        patch: { kokuchiGatheringReminderLastError: "Kokuchi event was canceled or its lifecycle revision changed" },
      });
      return;
    }
  
    const channel = await resolveConfiguredTextChannel(
      guild,
      claimed.kokuchiGatheringReminderChannelId,
    );
  
    if (!channel) {
      await transitionKokuchiGatheringReminder({
        guildId: guild.id,
        kokuchiEventId: claimed.kokuchiEventId,
        fromStates: ["sending"],
        toState: "failed",
        patch: { kokuchiGatheringReminderLastError: "Configured reminder channel could not be resolved" },
      });
      return;
    }
  
    const roleIds = Array.isArray(claimed.kokuchiMentionRoleIds)
      ? claimed.kokuchiMentionRoleIds.filter(Boolean)
      : [];
    const gatheringVoiceChannelId = getGatheringVcUnlockChannelId(claimed);
  
    if (!gatheringVoiceChannelId) {
      await transitionKokuchiGatheringReminder({
        guildId: guild.id,
        kokuchiEventId: claimed.kokuchiEventId,
        fromStates: ["sending"],
        toState: "failed",
        patch: { kokuchiGatheringReminderLastError: "Gathering voice channel is not configured" },
      });
      return;
    }
  
    const beforeDiscord = await getKokuchiActionGuard({
      guildId: guild.id,
      eventId: claimed.kokuchiEventId,
      expectedRevision: actionGuard.revision,
    });
    if (!beforeDiscord.valid) {
      await transitionKokuchiGatheringReminder({
        guildId: guild.id,
        kokuchiEventId: claimed.kokuchiEventId,
        fromStates: ["sending"],
        toState: "canceled",
        patch: { kokuchiGatheringReminderLastError: "Kokuchi event was canceled before the gathering reminder was sent" },
      });
      return;
    }
  
    const roleMentions = roleIds
      .map((roleId) => `<@&${roleId}>`)
      .join(" ");
  
    const message = await channel.send({
      content:
        `${roleMentions} 会話練習会の集合が開始しました！ ` +
        `<#${gatheringVoiceChannelId}> からぜひご参加ください！5分後に締め切られます`,
      allowedMentions: { roles: roleIds },
    }).catch((error) => {
      console.error(`Failed to send kokuchi gathering reminder: ${error.message}`);
      return null;
    });
  
    if (!message) {
      await transitionKokuchiGatheringReminder({
        guildId: guild.id,
        kokuchiEventId: claimed.kokuchiEventId,
        fromStates: ["sending"],
        toState: "unconfirmed",
        patch: { kokuchiGatheringReminderLastError: "Discord message send result was not confirmed; automatic retry was disabled to prevent duplicates" },
      });
      return;
    }
  
    const afterDiscord = await getKokuchiActionGuard({
      guildId: guild.id,
      eventId: claimed.kokuchiEventId,
      expectedRevision: actionGuard.revision,
    });
    if (!afterDiscord.valid) {
      if (message?.delete) await message.delete().catch((error) => logRecoverableError("Failed to compensate gathering reminder after kokuchi cancellation", error));
      await transitionKokuchiGatheringReminder({
        guildId: guild.id,
        kokuchiEventId: claimed.kokuchiEventId,
        fromStates: ["sending"],
        toState: "canceled",
        patch: { kokuchiGatheringReminderLastError: "Kokuchi event was canceled after the gathering reminder was sent" },
      });
      return;
    }
  
    await transitionKokuchiGatheringReminder({
      guildId: guild.id,
      kokuchiEventId: claimed.kokuchiEventId,
      fromStates: ["sending"],
      toState: "sent",
      patch: {
        kokuchiGatheringReminderMessage: {
          channelId: channel.id,
          messageId: message.id,
          sentAt: new Date().toISOString(),
        },
      },
    });
  }
  
  async function applyGatheringVcUnlock(guildId) {
    const guild =
      client.guilds.cache.get(guildId) ??
      (await client.guilds.fetch(guildId).catch(() => null));
  
    if (!guild) {
      return;
    }
  
    const settings = await getGuildSettings(guild.id);
  
    if (
      !getGatheringVcUnlockChannelId(settings) ||
      !["pending", "failed"].includes(settings.gatheringVcUnlockState)
    ) {
      return;
    }
  
    const unlockAt = new Date(settings.gatheringVcUnlockAt);
    if (!Number.isFinite(unlockAt.getTime()) || unlockAt.getTime() + 5_000 < Date.now()) {
      await transitionKokuchiTimedAction({
        guildId: guild.id,
        kokuchiEventId: settings?.kokuchiEventId,
        stateKey: "gatheringVcUnlockState",
        fromStates: ["pending", "failed"],
        toState: "skipped",
      });
      return;
    }
  
    const claimed = await transitionKokuchiTimedAction({
      guildId: guild.id,
      kokuchiEventId: settings?.kokuchiEventId,
      stateKey: "gatheringVcUnlockState",
      fromStates: ["pending", "failed"],
      toState: "processing",
    });
    if (!claimed) return;
  
    const actionGuard = await getKokuchiActionGuard({
      guildId: guild.id,
      eventId: claimed.kokuchiEventId,
    });
    if (!actionGuard.valid) {
      await transitionKokuchiTimedAction({
        guildId: guild.id,
        kokuchiEventId: claimed.kokuchiEventId,
        stateKey: "gatheringVcUnlockState",
        fromStates: ["processing"],
        toState: "canceled",
        patch: { gatheringVcUnlockLastError: "Kokuchi event was canceled or its lifecycle revision changed" },
      });
      return;
    }
  
    const changed = await setGatheringVcConnectPermission({
      guild,
      settings: claimed,
      canConnect: true,
      expectedEventRevision: actionGuard.revision,
      reason: "会話練習会の集合VCを開放",
    });
  
    if (changed) {
      const completedGuard = await getKokuchiActionGuard({
        guildId: guild.id,
        eventId: claimed.kokuchiEventId,
        expectedRevision: actionGuard.revision,
      });
      if (!completedGuard.valid) {
        await restoreGatheringVcPermissionAfterSplit(guild, claimed, { eventId: claimed.kokuchiEventId, force: true }).catch((error) => {
          logRecoverableError("Failed to compensate canceled gathering VC unlock", error);
        });
        await transitionKokuchiTimedAction({
          guildId: guild.id,
          kokuchiEventId: claimed.kokuchiEventId,
          stateKey: "gatheringVcUnlockState",
          fromStates: ["processing"],
          toState: "canceled",
          patch: { gatheringVcUnlockLastError: "Kokuchi event was canceled during gathering VC unlock" },
        });
        return;
      }
      await transitionKokuchiTimedAction({
        guildId: guild.id,
        kokuchiEventId: claimed.kokuchiEventId,
        stateKey: "gatheringVcUnlockState",
        fromStates: ["processing"],
        toState: "opened",
      });
    } else {
      await transitionKokuchiTimedAction({
        guildId: guild.id,
        kokuchiEventId: claimed.kokuchiEventId,
        stateKey: "gatheringVcUnlockState",
        fromStates: ["processing"],
        toState: "failed",
        patch: { gatheringVcUnlockLastError: "Gathering VC permission update was not applied" },
      });
    }
  }
  
  async function closeGatheringVcAfterSplit(guild, settings, { splitSessionId = null } = {}) {
    const currentSettings = await getGuildSettings(guild.id).catch(() => null);
    // A split started with an older settings snapshot must never be allowed to
    // close a VC after the current event lookup failed.  Only the freshly read,
    // event-identified settings document is authoritative here.
    const effectiveSettings = currentSettings;
    // gatheringVcRestorePending is event-owned and is set only after the
    // matching split has atomically claimed the close operation.
    if (!effectiveSettings) return false;
    const eventId = effectiveSettings?.kokuchiEventId;
    if (!eventId || effectiveSettings?.gatheringVcStateEventId !== eventId || !splitSessionId) return false;
    const event = await KokuchiReservation.findOne({ guildId: guild.id, reservationId: eventId }).lean();
    const eventStatus = normalizeKokuchiStatus(event?.kokuchiStatus ?? event?.status);
    const snapshot = event?.gatheringVcPermissionBeforeOpen;
    const channelId = event?.gatheringVcUnlockChannelId;
    const targetChannel = channelId ? await guild.channels.fetch(channelId).catch(() => null) : null;
    const session = await SplitProcessSession.findOne({ sessionId: splitSessionId, guildId: guild.id }).lean();
    if (
      !targetChannel?.isVoiceBased?.()
      || !canCloseGatheringVcAfterSplit({
        eventId,
        settings: effectiveSettings,
        event: { ...event, kokuchiStatus: eventStatus },
        session,
        targetChannelId: targetChannel.id,
        guildId: guild.id,
      })
    ) return false;
    clearGatheringVcUnlockTimer(guild.id);
    const closingAt = new Date();
    const closing = await KokuchiReservation.findOneAndUpdate(
      {
        _id: event._id,
        reservationId: eventId,
        gatheringVcUnlockState: "opened",
        gatheringVcRestorePending: false,
        gatheringVcRestoreStatus: "not_required",
        cancelRequested: { $ne: true },
        status: { $nin: ["canceling", "cancel_partial", "canceled"] },
        kokuchiStatus: { $nin: ["canceling", "canceled"] },
      },
      {
        $set: {
          gatheringVcUnlockState: "closing",
          gatheringVcClosingAt: closingAt,
          gatheringVcRestorePending: true,
          gatheringVcRestorePendingAt: closingAt,
          gatheringVcRestoreEventId: eventId,
          gatheringVcRestoreEventRevision: event.lifecycleRevision ?? 0,
          gatheringVcRestoreStatus: "pending",
          gatheringVcRestoreFailureCode: null,
          gatheringVcRestoreLastError: null,
          gatheringVcRestoreNextRetryAt: null,
        },
        $unset: { cleanupAt: 1 },
      },
      { returnDocument: "after", lean: true },
    );
    // Mongoose returns null for a failed findOneAndUpdate, while lightweight
    // stores and adapters may expose a write result instead. Treat every
    // result other than exactly one matched event as a failed claim and do not
    // touch Discord in that case.
    if (!closing || (closing.matchedCount !== undefined && closing.matchedCount !== 1)) return false;
    const closed = await setGatheringVcConnectPermission({
      guild,
      settings: { ...effectiveSettings, gatheringVcUnlockChannelId: channelId },
      event: closing,
      canConnect: false,
      captureSnapshot: false,
      expectedEventRevision: closing.lifecycleRevision ?? null,
      reason: "/splitvc完了に伴う集合VCの閲覧・接続停止",
    });
    if (!closed) {
      await KokuchiReservation.updateOne(
        { _id: closing._id, reservationId: eventId, gatheringVcUnlockState: "closing", gatheringVcRestoreStatus: "pending" },
        {
          $set: {
            gatheringVcUnlockState: "opened",
            gatheringVcRestorePending: false,
            gatheringVcRestorePendingAt: null,
            gatheringVcRestoreStatus: "not_required",
            gatheringVcRestoreFailureCode: null,
            gatheringVcRestoreLastError: null,
            gatheringVcRestoreNextRetryAt: null,
          },
          $unset: { gatheringVcClosingAt: 1 },
        },
      ).catch((error) => logRecoverableError("Failed to roll back gathering VC closing reservation", error));
      return false;
    }
    const now = new Date();
    let finalized;
    try {
      finalized = await KokuchiReservation.updateOne(
        { _id: closing._id, reservationId: eventId, gatheringVcUnlockState: "closing", gatheringVcRestoreStatus: "pending" },
        { $set: {
          gatheringVcUnlockState: "closed",
          gatheringVcClosedAt: now,
          gatheringVcClosedBySplitSessionId: splitSessionId,
          gatheringVcRestorePending: true,
          gatheringVcRestorePendingAt: now,
          gatheringVcRestoreEventId: eventId,
          gatheringVcRestoreEventRevision: closing.lifecycleRevision ?? 0,
          gatheringVcRestoreStatus: "pending",
          gatheringVcRestoreFailureCode: null,
          gatheringVcRestoreLastError: null,
          gatheringVcRestoreNextRetryAt: null,
        }, $unset: { cleanupAt: 1, gatheringVcClosingAt: 1 } },
      );
    } catch (error) {
      await compensateGatheringVcCloseAfterPersistenceMismatch(guild, effectiveSettings, eventId).catch((compensationError) => {
        logRecoverableError("Failed to compensate gathering VC close after event finalization exception", compensationError);
      });
      logRecoverableError("Gathering VC close succeeded but its event finalization failed", error);
      return false;
    }
    if (finalized.matchedCount !== 1) {
      await compensateGatheringVcCloseAfterPersistenceMismatch(guild, effectiveSettings, eventId).catch((error) => {
        logRecoverableError("Failed to compensate gathering VC close after event finalization mismatch", error);
      });
      return false;
    }
    await patchGuildSettingsForKokuchiEvent({
      guildId: guild.id,
      kokuchiEventId: eventId,
      set: {
        gatheringVcUnlockState: "closed",
        gatheringVcRestorePending: true,
        gatheringVcRestorePendingAt: now.toISOString(),
        gatheringVcRestoreStatus: "pending",
        gatheringVcRestoreFailureCode: null,
        gatheringVcRestoreNextRetryAt: null,
        gatheringVcRestoreLastError: null,
      },
    }).catch((error) => {
      logRecoverableError("Gathering VC close persisted on event but settings mirror update failed", error);
    });
    return true;
  }
  
  async function clearCompletedGatheringVcEventState({ guild, eventId, settings = null } = {}) {
    if (!guild?.id || !eventId) return false;
    const event = await KokuchiReservation.findOne({ guildId: guild.id, reservationId: eventId }).lean();
    if (!event || event.gatheringVcOpenedAt || event.gatheringVcRestorePending === true) return false;
    if (!isGatheringVcRestoreOwnedByEvent(event, eventId)) return false;
    if (![
      "completed",
      "canceled",
    ].includes(normalizeKokuchiStatus(event.kokuchiStatus ?? event.status))) return false;
    if (normalizeGatheringVcRestoreStatus(event) !== "not_required") return false;
    await KokuchiReservation.updateOne(
      { _id: event._id, reservationId: eventId, gatheringVcRestoreStatus: "not_required", gatheringVcRestorePending: false },
      {
        $set: {
          cleanupAt: getKokuchiReservationCleanupAt({ restoreStatus: "not_required" }),
          gatheringVcRestoreFailureCode: null,
          gatheringVcRestoreLastError: null,
          gatheringVcRestoreNextRetryAt: null,
          gatheringVcRestoreAttemptCount: 0,
        },
        $unset: {
          gatheringVcUnlockChannelId: 1,
          gatheringVcPermissionBeforeOpen: 1,
          gatheringVcClosedAt: 1,
          gatheringVcClosedBySplitSessionId: 1,
          gatheringVcClosingAt: 1,
          gatheringVcRestorePendingAt: 1,
          gatheringVcRestoreEventId: 1,
          gatheringVcRestoreEventRevision: 1,
        },
      },
    );
    const currentSettings = settings ?? await getGuildSettings(guild.id).catch(() => null);
    if (currentSettings?.kokuchiEventId === eventId || currentSettings?.gatheringVcStateEventId === eventId) {
      await patchGuildSettingsForKokuchiEvent({
        guildId: guild.id,
        kokuchiEventId: eventId,
        set: {
          gatheringVcRestorePending: false,
          gatheringVcRestoreStatus: "not_required",
          gatheringVcRestoreFailureCode: null,
          gatheringVcRestoreLastError: null,
          gatheringVcRestoreNextRetryAt: null,
          gatheringVcRestoreAttemptCount: 0,
        },
        unset: { gatheringVcUnlockChannelId: true, gatheringVcPermissionBeforeOpen: true, gatheringVcRestorePendingAt: true, gatheringVcRestoreEventId: true, gatheringVcRestoreEventRevision: true, gatheringVcStateEventId: true },
      }).catch((error) => {
        logRecoverableError("Gathering VC event cleanup succeeded but settings mirror repair failed", error);
      });
    }
    return true;
  }
  
  async function setGatheringVcConnectPermission({
    guild,
    settings,
    event = null,
    canConnect,
    captureSnapshot = canConnect,
    expectedEventRevision = null,
    reason,
  }) {
    const channelId = getGatheringVcUnlockChannelId(settings);
  
    if (!channelId) {
      return false;
    }
  
    const channel = await guild.channels
      .fetch(channelId)
      .catch(() => null);
  
    if (!channel?.isVoiceBased() || typeof channel.permissionOverwrites?.edit !== "function") {
      return false;
    }
  
    const eventId = settings?.kokuchiEventId;
    // Every gathering-VC permission mutation must be owned by a persisted
    // kokuchi event.  Without an event identity there is no durable snapshot or
    // compensation record to protect a Discord-side change.
    if (!eventId) return false;
    const currentEvent = eventId
      ? await KokuchiReservation.findOne({ guildId: guild.id, reservationId: eventId }).lean()
      : event;
    if (eventId && !currentEvent) return false;
    if (eventId && isKokuchiEventActionInvalid(currentEvent, expectedEventRevision)) return false;
    const actionRevision = eventId ? Number(currentEvent.lifecycleRevision ?? 0) : null;
    if (eventId && !isGatheringVcRestoreOwnedByEvent(currentEvent, eventId)) return false;
    const currentRestoreStatus = normalizeGatheringVcRestoreStatus(currentEvent ?? {});
    if (canConnect && (
      currentEvent.gatheringVcRestorePending === true
      || isGatheringVcRestoreBlocking(currentRestoreStatus)
    )) return false;
    let snapshot = currentEvent?.gatheringVcPermissionBeforeOpen
      ?? (settings?.gatheringVcStateEventId === eventId ? settings?.gatheringVcPermissionBeforeOpen : null);
    if (captureSnapshot && !isGatheringVcPermissionSnapshotValid(snapshot, { channelId: channel.id, guildId: guild.id })) {
      const overwrite = channel.permissionOverwrites.cache.get(guild.id) ?? null;
      snapshot = createEveryonePermissionSnapshot({ channelId: channel.id, guildId: guild.id, overwrite, permissions: PermissionFlagsBits });
    }
  
    if (!canConnect) {
      const beforeDiscord = eventId
        ? await KokuchiReservation.findOne({ guildId: guild.id, reservationId: eventId }).lean()
        : currentEvent;
      if (eventId && (
        isKokuchiEventActionInvalid(beforeDiscord, actionRevision)
        || !isGatheringVcRestoreOwnedByEvent(beforeDiscord, eventId)
      )) return false;
      return editEveryoneConnectPermission({
        channel,
        guildId: guild.id,
        canConnect: false,
        reason,
      }).catch((error) => {
        console.error(`Failed to close gathering VC ${channel.id}: ${error.message}`);
        return false;
      });
    }
  
    if (!eventId || !isGatheringVcPermissionSnapshotValid(snapshot, { channelId: channel.id, guildId: guild.id })) return false;
    const openLease = await acquireMongoLease(`gathering-vc-restore:${guild.id}:${eventId}`, { leaseMs: 2 * 60 * 1000 });
    if (!openLease) return false;
    let preparedEvent = currentEvent;
    try {
      const transaction = await runGatheringVcOpenTransaction({
        prepare: async () => {
          const preparedAt = new Date();
          const prepared = await KokuchiReservation.updateOne(
            {
              guildId: guild.id,
              reservationId: eventId,
              lifecycleRevision: actionRevision,
              cancelRequested: { $ne: true },
              status: { $nin: ["canceling", "cancel_partial", "canceled"] },
              kokuchiStatus: { $nin: ["canceling", "canceled"] },
              gatheringVcRestorePending: { $ne: true },
              $and: [
                { $or: [{ gatheringVcRestoreStatus: { $in: ["not_required", "restored"] } }, { gatheringVcRestoreStatus: { $exists: false } }] },
                { $or: [{ gatheringVcRestoreEventId: eventId }, { gatheringVcRestoreEventId: { $exists: false } }, { gatheringVcRestoreEventId: null }] },
              ],
            },
            {
              $set: {
                gatheringVcRestoreEventId: eventId,
                gatheringVcRestoreEventRevision: actionRevision,
                gatheringVcUnlockChannelId: channel.id,
                gatheringVcPermissionBeforeOpen: snapshot,
                gatheringVcRestorePending: true,
                gatheringVcRestorePendingAt: preparedAt,
                gatheringVcRestoreStatus: "pending",
                gatheringVcRestoreFailureCode: null,
                gatheringVcRestoreLastError: null,
                gatheringVcRestoreNextRetryAt: null,
              },
              $unset: { cleanupAt: 1 },
            },
          );
          if (prepared?.matchedCount !== 1) return false;
          await patchGuildSettingsForKokuchiEvent({
            guildId: guild.id,
            kokuchiEventId: eventId,
            set: {
              gatheringVcRestoreEventId: eventId,
              gatheringVcRestoreEventRevision: actionRevision,
              gatheringVcUnlockChannelId: channel.id,
              gatheringVcPermissionBeforeOpen: snapshot,
              gatheringVcRestorePending: true,
              gatheringVcRestorePendingAt: preparedAt.toISOString(),
              gatheringVcRestoreStatus: "pending",
              gatheringVcRestoreFailureCode: null,
              gatheringVcRestoreLastError: null,
              gatheringVcRestoreNextRetryAt: null,
            },
            unset: { cleanupAt: true },
          }).catch((error) => {
            logRecoverableError("Gathering VC open recovery state saved on event but settings mirror update failed", error);
          });
          preparedEvent = await KokuchiReservation.findOne({ guildId: guild.id, reservationId: eventId }).lean();
          if (!preparedEvent
            || isKokuchiEventActionInvalid(preparedEvent, actionRevision)
            || preparedEvent.gatheringVcRestorePending !== true
            || normalizeGatheringVcRestoreStatus(preparedEvent) !== "pending"
            || !isGatheringVcRestoreOwnedByEvent(preparedEvent, eventId)
            || !isGatheringVcPermissionSnapshotValid(preparedEvent.gatheringVcPermissionBeforeOpen, { channelId: channel.id, guildId: guild.id })) {
            return false;
          }
          return true;
        },
        applyDiscord: () => editEveryoneConnectPermission({
          channel,
          guildId: guild.id,
          canConnect: true,
          reason,
        }),
        readCurrentPermission: async () => {
          const refreshed = await guild.channels.fetch(channel.id, { force: true }).catch(() => null);
          if (!refreshed?.isVoiceBased?.() || !refreshed.permissionOverwrites?.cache) return { known: false };
          return { known: true, overwrite: refreshed.permissionOverwrites.cache.get(guild.id) ?? null };
        },
        snapshotMatches: (overwrite) => permissionSnapshotMatches({ snapshot, overwrite, permissions: PermissionFlagsBits }),
        finalizeUnchanged: async () => {
          const finalized = await KokuchiReservation.updateOne(
            { guildId: guild.id, reservationId: eventId, lifecycleRevision: actionRevision, gatheringVcRestoreEventId: eventId, gatheringVcRestorePending: true, gatheringVcRestoreStatus: "pending" },
            {
              $set: {
                gatheringVcRestorePending: false,
                gatheringVcRestoreStatus: "not_required",
                gatheringVcRestoreFailureCode: null,
                gatheringVcRestoreLastError: null,
                gatheringVcRestoreNextRetryAt: null,
                gatheringVcRestoreAttemptCount: 0,
              },
              $unset: {
                gatheringVcRestorePendingAt: 1,
                gatheringVcRestoreEventId: 1,
                gatheringVcRestoreEventRevision: 1,
                gatheringVcUnlockChannelId: 1,
                gatheringVcPermissionBeforeOpen: 1,
              },
            },
          );
          if (finalized?.matchedCount !== 1) throw new Error("Gathering VC open failure state could not be finalized.");
          await patchGuildSettingsForKokuchiEvent({
            guildId: guild.id,
            kokuchiEventId: eventId,
            set: {
              gatheringVcRestorePending: false,
              gatheringVcRestoreStatus: "not_required",
              gatheringVcRestoreFailureCode: null,
              gatheringVcRestoreLastError: null,
              gatheringVcRestoreNextRetryAt: null,
              gatheringVcRestoreAttemptCount: 0,
            },
            unset: {
              gatheringVcRestorePendingAt: true,
              gatheringVcRestoreEventId: true,
              gatheringVcRestoreEventRevision: true,
              gatheringVcUnlockChannelId: true,
              gatheringVcPermissionBeforeOpen: true,
            },
          }).catch((error) => {
            logRecoverableError("Gathering VC open failure was reconciled on event but settings mirror update failed", error);
          });
        },
        finalizeOpened: async () => {
          const openedAt = new Date();
          const opened = await KokuchiReservation.updateOne(
            { guildId: guild.id, reservationId: eventId, lifecycleRevision: actionRevision, gatheringVcRestoreEventId: eventId, gatheringVcRestorePending: true, gatheringVcRestoreStatus: "pending", cancelRequested: { $ne: true }, status: { $nin: ["canceling", "cancel_partial", "canceled"] }, kokuchiStatus: { $nin: ["canceling", "canceled"] } },
            {
              $set: {
                gatheringVcOpenedAt: openedAt,
                gatheringVcUnlockState: "opened",
                gatheringVcRestorePending: false,
                gatheringVcRestoreStatus: "not_required",
                gatheringVcRestoreFailureCode: null,
                gatheringVcRestoreLastError: null,
                gatheringVcRestoreNextRetryAt: null,
              },
              $unset: { gatheringVcRestorePendingAt: 1, cleanupAt: 1 },
            },
          );
          if (opened?.matchedCount !== 1) throw new Error("Gathering VC open state could not be finalized.");
          await patchGuildSettingsForKokuchiEvent({
            guildId: guild.id,
            kokuchiEventId: eventId,
            set: {
              gatheringVcOpenedAt: openedAt.toISOString(),
              gatheringVcUnlockState: "opened",
              gatheringVcRestorePending: false,
              gatheringVcRestoreStatus: "not_required",
              gatheringVcRestoreFailureCode: null,
              gatheringVcRestoreLastError: null,
              gatheringVcRestoreNextRetryAt: null,
              gatheringVcRestoreEventId: eventId,
              gatheringVcRestoreEventRevision: actionRevision,
            },
            unset: { gatheringVcRestorePendingAt: true, cleanupAt: true },
          }).catch((error) => {
            logRecoverableError("Gathering VC open finalized on event but settings mirror update failed", error);
          });
        },
        compensate: () => restoreGatheringVcPermissionAfterSplit(guild, settings, { eventId, force: true, leaseAlreadyHeld: true }),
        markPending: async (error) => {
          const failureEvent = await KokuchiReservation.findOne({ guildId: guild.id, reservationId: eventId }).lean().catch(() => null) ?? preparedEvent;
          if (!failureEvent) return;
          await markGatheringVcRestoreFailure({ guild, settings, event: failureEvent, eventId, error, terminal: false });
        },
      });
      return transaction.status === "opened";
    } finally {
      await releaseMongoLease(openLease).catch((error) => logRecoverableError("Failed to release gathering VC open lease", error));
    }
  }
  
  async function compensateGatheringVcCloseAfterPersistenceMismatch(guild, settings, eventId) {
    return restoreGatheringVcPermissionAfterSplit(guild, settings, { eventId, force: true });
  }
  
  async function restoreGatheringVcPermissionAfterSplit(guild, settings, options = {}) {
    if (options.leaseAlreadyHeld) return restoreGatheringVcPermissionAfterSplitWithoutLease(guild, settings, options);
    const currentEventId = options.eventId ?? settings?.kokuchiEventId;
    if (!currentEventId) return false;
    const lease = await acquireMongoLease(`gathering-vc-restore:${guild.id}:${currentEventId}`, { leaseMs: 2 * 60 * 1000 });
    if (!lease) return false;
    try {
      return await restoreGatheringVcPermissionAfterSplitWithoutLease(guild, settings, { ...options, leaseAlreadyHeld: true });
    } finally {
      await releaseMongoLease(lease).catch((error) => logRecoverableError("Failed to release gathering VC restore lease", error));
    }
  }
  
  async function restoreGatheringVcPermissionAfterSplitWithoutLease(guild, settings, { eventId = null, force = false } = {}) {
    const currentEventId = eventId ?? settings?.kokuchiEventId;
    if (!currentEventId) return false;
    const event = await KokuchiReservation.findOne({ guildId: guild.id, reservationId: currentEventId }).lean();
    const status = normalizeGatheringVcRestoreStatus(event ?? settings ?? {});
    if (!event || (!force && !["pending", "retry_wait"].includes(status))) return status === "restored";
    if (event && !isGatheringVcRestoreOwnedByEvent(event, currentEventId)) {
      await markGatheringVcRestoreFailure({ guild, settings, event, eventId: currentEventId, error: new Error("Gathering VC restore event identity does not match the reservation."), terminal: true, failureCode: "event_mismatch" });
      return false;
    }
    if (force && ["restored", "not_required"].includes(status)
      && !event.gatheringVcPermissionBeforeOpen
      && !event.gatheringVcUnlockChannelId) return true;
    const snapshot = event.gatheringVcPermissionBeforeOpen;
    const channelId = event.gatheringVcUnlockChannelId;
    if (!channelId || !isGatheringVcPermissionSnapshotValid(snapshot, { channelId, guildId: guild.id })) {
      await markGatheringVcRestoreFailure({ guild, settings, event, eventId: currentEventId, error: new Error("Gathering VC permission snapshot or channel is missing."), terminal: true, failureCode: "snapshot_missing" });
      return false;
    }
    const claimed = await KokuchiReservation.findOneAndUpdate(
      {
        _id: event._id,
        reservationId: currentEventId,
        $or: [{ gatheringVcRestoreEventId: currentEventId }, { gatheringVcRestoreEventId: { $exists: false } }, { gatheringVcRestoreEventId: null }],
        gatheringVcRestoreStatus: { $in: force ? ["pending", "retry_wait", "failed", "not_required", "restored"] : ["pending", "retry_wait"] },
        ...(force ? {} : { gatheringVcRestoreNextRetryAt: { $lte: new Date() } }),
      },
      { $set: { gatheringVcRestoreEventId: currentEventId, gatheringVcRestoreEventRevision: event.gatheringVcRestoreEventRevision ?? event.lifecycleRevision ?? 0, gatheringVcRestoreStatus: "restoring" }, $inc: { gatheringVcRestoreAttemptCount: 1 }, $unset: { cleanupAt: 1 } },
      { returnDocument: "after", lean: true },
    );
    if (!claimed) return false;
    const channel = await guild.channels.fetch(channelId, { force: true }).catch(() => null);
    if (!channel?.isVoiceBased() || typeof channel.permissionOverwrites?.edit !== "function") {
      await markGatheringVcRestoreFailure({ guild, settings, event: claimed, eventId: currentEventId, error: new Error("Gathering VC channel is unavailable."), terminal: false });
      return false;
    }
  
    const overwrite = channel.permissionOverwrites.cache.get(guild.id) ?? null;
    const patch = getRestorePermissionPatch({ snapshot, overwrite, permissions: PermissionFlagsBits });
    try {
      if (Object.keys(patch).length > 0) {
        await channel.permissionOverwrites.edit(guild.id, patch, {
          reason: "/splitvc完了に伴う集合VC権限の復元",
        });
      }
      const refreshed = await guild.channels.fetch(channelId, { force: true }).catch(() => channel);
      const refreshedOverwrite = refreshed?.permissionOverwrites?.cache?.get(guild.id) ?? null;
      if (!permissionSnapshotMatches({ snapshot, overwrite: refreshedOverwrite, permissions: PermissionFlagsBits })) {
        throw new Error("Gathering VC permission restoration did not match the saved snapshot.");
      }
      const restoredRecord = await KokuchiReservation.updateOne(
        { _id: claimed._id, reservationId: currentEventId, gatheringVcRestoreStatus: "restoring" },
        {
          $set: {
            gatheringVcRestoreStatus: "restored",
            gatheringVcRestorePending: false,
            gatheringVcRestoreFailureCode: null,
            gatheringVcRestoreLastError: null,
            gatheringVcRestoreNextRetryAt: null,
            gatheringVcUnlockState: "closed",
            cleanupAt: getKokuchiReservationCleanupAt({ restoreStatus: "restored" }),
          },
          $unset: {
            gatheringVcUnlockChannelId: 1,
            gatheringVcPermissionBeforeOpen: 1,
            gatheringVcOpenedAt: 1,
            gatheringVcClosedAt: 1,
            gatheringVcClosedBySplitSessionId: 1,
            gatheringVcClosingAt: 1,
            gatheringVcRestorePendingAt: 1,
            gatheringVcRestoreEventId: 1,
            gatheringVcRestoreEventRevision: 1,
          },
        },
      );
      if (restoredRecord.matchedCount !== 1) {
        throw new Error("Gathering VC restoration succeeded in Discord but its event state could not be saved.");
      }
      await patchGuildSettingsForKokuchiEvent({
        guildId: guild.id,
        kokuchiEventId: currentEventId,
        set: {
          gatheringVcUnlockState: "closed",
          gatheringVcRestorePending: false,
          gatheringVcRestoreStatus: "restored",
          gatheringVcRestoreFailureCode: null,
          gatheringVcRestoreLastError: null,
          gatheringVcRestoreNextRetryAt: null,
        },
        unset: { gatheringVcUnlockChannelId: true, gatheringVcPermissionBeforeOpen: true, gatheringVcRestorePendingAt: true, gatheringVcRestoreEventId: true, gatheringVcRestoreEventRevision: true, gatheringVcStateEventId: true },
      }).catch((error) => {
        logRecoverableError("Gathering VC event restored but settings mirror repair failed", error);
      });
      clearGatheringVcRestoreRetryTimer(guild.id, currentEventId);
      requestOperationalStatusRefresh(guild.id, "gathering-vc-restored");
      return true;
    } catch (error) {
      const restoredEvent = await KokuchiReservation.findOne({ guildId: guild.id, reservationId: currentEventId }).lean().catch(() => null);
      if (normalizeGatheringVcRestoreStatus(restoredEvent ?? {}) === "restored") {
        logRecoverableError("Gathering VC restore event was already restored before a mirror update error", error);
        clearGatheringVcRestoreRetryTimer(guild.id, currentEventId);
        return true;
      }
      await sendOperationalLog({
        guild,
        settings,
        fallbackChannel: null,
        content: `集合VC権限の復元に失敗しました: ${error.message}`,
      }).catch((logError) => logRecoverableError("Failed to log gathering VC permission restore failure", logError));
      await markGatheringVcRestoreFailure({ guild, settings, event: claimed, eventId: currentEventId, error, terminal: false });
      return false;
    }
  }
  
  function gatheringVcRestoreTimerKey(guildId, eventId) {
    return `${guildId}:${eventId}`;
  }
  
  function clearGatheringVcRestoreRetryTimer(guildId, eventId) {
    const key = gatheringVcRestoreTimerKey(guildId, eventId);
    const timer = gatheringVcRestoreRetryTimers.get(key);
    if (timer) clearTimeout(timer);
    gatheringVcRestoreRetryTimers.delete(key);
  }
  
  function scheduleGatheringVcRestoreRetry(guild, event) {
    const eventId = event?.reservationId;
    if (!event?.gatheringVcRestoreNextRetryAt) return;
    const restoreStatus = normalizeGatheringVcRestoreStatus(event);
    const nextRetryAt = new Date(event?.gatheringVcRestoreNextRetryAt ?? 0);
    if (!guild?.id || !eventId || !["pending", "retry_wait"].includes(restoreStatus) || !Number.isFinite(nextRetryAt.getTime())) return;
    const key = gatheringVcRestoreTimerKey(guild.id, eventId);
    clearGatheringVcRestoreRetryTimer(guild.id, eventId);
    const timer = setTimeout(() => {
      gatheringVcRestoreRetryTimers.delete(key);
      void attemptScheduledGatheringVcRestore(guild, eventId).catch((error) => {
        logRecoverableError(`Failed to retry gathering VC restoration for ${eventId}`, error);
      });
    }, Math.max(0, nextRetryAt.getTime() - Date.now()));
    gatheringVcRestoreRetryTimers.set(key, timer);
  }
  
  async function attemptScheduledGatheringVcRestore(guild, eventId) {
    const lease = await acquireMongoLease(`gathering-vc-restore:${guild.id}:${eventId}`, { leaseMs: 2 * 60 * 1000 });
    if (!lease) {
      const retry = setTimeout(() => {
        gatheringVcRestoreRetryTimers.delete(gatheringVcRestoreTimerKey(guild.id, eventId));
        void attemptScheduledGatheringVcRestore(guild, eventId).catch((error) => logRecoverableError("Gathering VC restore lease retry failed", error));
      }, 5_000);
      gatheringVcRestoreRetryTimers.set(gatheringVcRestoreTimerKey(guild.id, eventId), retry);
      return false;
    }
    try {
      const settings = await getGuildSettings(guild.id);
      const currentBeforeAttempt = await KokuchiReservation.findOne({ guildId: guild.id, reservationId: eventId }).lean();
      const restored = await restoreGatheringVcPermissionAfterSplit(guild, settings, {
        eventId,
        force: normalizeGatheringVcRestoreStatus(currentBeforeAttempt ?? {}) === "pending",
        leaseAlreadyHeld: true,
      });
      const current = await KokuchiReservation.findOne({ guildId: guild.id, reservationId: eventId }).lean();
      if (current) scheduleGatheringVcRestoreRetry(guild, current);
      return restored;
    } finally {
      await releaseMongoLease(lease).catch((error) => logRecoverableError("Failed to release gathering VC restore lease", error));
    }
  }
  
  async function markGatheringVcRestoreFailure({ guild, settings, event, eventId, error, terminal = false, failureCode = null }) {
    const attemptCount = Number(event?.gatheringVcRestoreAttemptCount ?? 0);
    const failedPermanently = terminal || attemptCount >= MAX_GATHERING_VC_RESTORE_ATTEMPTS;
    const status = failedPermanently ? "failed" : "retry_wait";
    const resolvedFailureCode = failureCode ?? (failedPermanently ? "max_attempts" : "retryable");
    const nextRetryAt = failedPermanently
      ? null
      : new Date(Date.now() + getGatheringVcRestoreRetryDelayMs(Math.max(0, attemptCount - 1)));
    const message = String(error?.message ?? error ?? "unknown restore error").slice(0, 1000);
    const restoreIdentityMatches = !event?.gatheringVcRestoreEventId || event.gatheringVcRestoreEventId === eventId;
    await KokuchiReservation.updateOne(
      { _id: event?._id, reservationId: eventId, gatheringVcRestoreStatus: { $in: ["pending", "retry_wait", "restoring", "not_required", "restored"] } },
      {
        $set: {
          gatheringVcRestoreStatus: status,
          gatheringVcRestorePending: true,
          gatheringVcRestoreFailureCode: resolvedFailureCode,
          gatheringVcRestoreLastError: message,
          gatheringVcRestoreNextRetryAt: nextRetryAt,
          ...(restoreIdentityMatches ? {
            gatheringVcRestoreEventId: eventId,
            gatheringVcRestoreEventRevision: event?.gatheringVcRestoreEventRevision ?? event?.lifecycleRevision ?? 0,
          } : {}),
        },
        $unset: { cleanupAt: 1 },
      },
    );
    await patchGuildSettingsForKokuchiEvent({
      guildId: guild.id,
      kokuchiEventId: eventId,
      set: {
        gatheringVcRestoreStatus: status,
        gatheringVcRestorePending: true,
        gatheringVcRestoreFailureCode: resolvedFailureCode,
        gatheringVcRestoreLastError: message,
        gatheringVcRestoreNextRetryAt: nextRetryAt?.toISOString?.() ?? null,
        ...(restoreIdentityMatches ? {
          gatheringVcRestoreEventId: eventId,
          gatheringVcRestoreEventRevision: event?.gatheringVcRestoreEventRevision ?? event?.lifecycleRevision ?? 0,
        } : {}),
      },
    }).catch((mirrorError) => {
      logRecoverableError("Gathering VC restore failure was saved on the event but settings mirror update failed", mirrorError);
    });
    if (nextRetryAt) {
      scheduleGatheringVcRestoreRetry(guild, {
        ...(event ?? {}),
        reservationId: eventId,
        gatheringVcRestoreStatus: status,
        gatheringVcRestoreNextRetryAt: nextRetryAt,
      });
    }
    await sendOperationalLog({
      guild,
      settings,
      fallbackChannel: null,
      content: `集合VC権限の復元に失敗しました。event=${eventId} status=${status} attempt=${attemptCount} error=${message}`,
    }).catch((logError) => logRecoverableError("Failed to log gathering VC permission restore failure", logError));
    requestOperationalStatusRefresh(guild.id, "gathering-vc-restore-failed");
    return status;
  }
  
  /** Shared by immediate and reserved /kokuchi posting. */
  async function publishKokuchi({ guild, weekday, sendChannel, overviewChannel, settings = null, onPublished = null, leaseKey = null, eventAt = null, kokuchiEventId = null, kokuchiEventRevision = null }) {
    if (kokuchiPublishGuildLocks.has(guild.id)) {
      throw new Error("A /kokuchi publication is already in progress for this guild.");
    }
    kokuchiPublishGuildLocks.add(guild.id);
    let lease = null;
    let publicationAttempted = false;
    let postedMessage = null;
    let postedAt = null;
    try {
    lease = await acquireMongoLease(leaseKey ?? `kokuchi:${guild.id}`, { leaseMs: 2 * 60 * 1000 });
    if (!lease) {
      throw new Error("A /kokuchi publication is already in progress for this guild.");
    }
    const currentSettings = settings ?? await getGuildSettings(guild.id);
    const beforeDiscord = await getKokuchiActionGuard({
      guildId: guild.id,
      eventId: kokuchiEventId,
      expectedRevision: kokuchiEventRevision,
    });
    if (!beforeDiscord.valid) throw new Error("Kokuchi event was canceled before publication.");
    postedAt = new Date();
    publicationAttempted = true;
    postedMessage = await sendChannel.send({
      content: formatKokuchiMessage({ weekday, overviewChannelId: overviewChannel.id, eventTime: currentSettings?.kokuchiEventTime }),
      allowedMentions: { roles: ["1506629235438129323"] },
    });
    const afterDiscord = await getKokuchiActionGuard({
      guildId: guild.id,
      eventId: kokuchiEventId,
      expectedRevision: kokuchiEventRevision,
    });
    if (!afterDiscord.valid) {
      if (postedMessage?.delete) await postedMessage.delete().catch((error) => logRecoverableError("Failed to compensate kokuchi publication after cancellation", error));
      throw new Error("Kokuchi event was canceled after publication.");
    }
    if (onPublished) {
      await onPublished({ postedMessage, postedAt });
    }
    const resolvedEventAt = eventAt instanceof Date && Number.isFinite(eventAt.getTime())
      ? eventAt
      : getNextKokuchiEventAt({
        weekday,
        eventTime: normalizeKokuchiEventTime(currentSettings?.kokuchiEventTime) ?? "21:00",
        now: postedAt,
      });
    if (!resolvedEventAt) throw new Error("Kokuchi event time could not be calculated");
    const preNoticeAt = getKokuchiPreNoticeAt(resolvedEventAt);
    const unlockAt = getGatheringVcUnlockAt(resolvedEventAt);
    const reminderAt = getKokuchiGatheringReminderAt(resolvedEventAt);
    const eventGatheringVcChannelId = resolveKokuchiGatheringVoiceChannelId(currentSettings, currentSettings);
    const beforeSettings = await getKokuchiActionGuard({
      guildId: guild.id,
      eventId: kokuchiEventId,
      expectedRevision: kokuchiEventRevision,
    });
    if (!beforeSettings.valid) {
      if (postedMessage?.delete) await postedMessage.delete().catch((error) => logRecoverableError("Failed to compensate kokuchi publication before settings persistence", error));
      throw new Error("Kokuchi event was canceled before its publication settings were persisted.");
    }
    const savedSettings = await saveGuildSettingsWithCurrent(guild.id, currentSettings, {
      lastKokuchiWeekday: weekday,
      lastKokuchiPostedAt: postedAt.toISOString(),
      lastKokuchiMessageId: postedMessage.id,
      lastKokuchiChannelId: postedMessage.channelId,
      kokuchiEventId: kokuchiEventId,
      kokuchiEventAt: resolvedEventAt.toISOString(),
      kokuchiPreNoticeAt: preNoticeAt.toISOString(),
      kokuchiPreNoticeChannelId: sendChannel.id,
      kokuchiPreNoticeState: preNoticeAt.getTime() > postedAt.getTime() ? "pending" : "skipped",
      gatheringVcUnlockAt: unlockAt.toISOString(),
       gatheringVcUnlockChannelId: eventGatheringVcChannelId,
       gatheringVcUnlockState: unlockAt.getTime() > postedAt.getTime() ? "pending" : "skipped",
       gatheringVcStateEventId: kokuchiEventId,
       gatheringVcRestoreEventId: kokuchiEventId,
       gatheringVcRestoreEventRevision: kokuchiEventRevision ?? 0,
       gatheringVcPermissionBeforeOpen: null,
      gatheringVcRestorePending: false,
      gatheringVcRestoreStatus: "not_required",
      gatheringVcRestoreFailureCode: null,
      gatheringVcRestoreAttemptCount: 0,
      gatheringVcRestoreLastError: null,
      gatheringVcRestoreNextRetryAt: null,
      kokuchiGatheringReminderAt: reminderAt.toISOString(),
      kokuchiGatheringReminderChannelId: sendChannel.id,
      kokuchiGatheringReminderState: reminderAt.getTime() > postedAt.getTime() ? "pending" : "skipped",
    });
    const afterSettings = await getKokuchiActionGuard({
      guildId: guild.id,
      eventId: kokuchiEventId,
      expectedRevision: kokuchiEventRevision,
    });
    if (!afterSettings.valid) {
      if (postedMessage?.delete) await postedMessage.delete().catch((error) => logRecoverableError("Failed to compensate kokuchi publication after settings persistence", error));
      throw new Error("Kokuchi event was canceled after its publication settings were persisted.");
    }
    if (kokuchiEventId) {
      await KokuchiReservation.updateOne(
        { guildId: guild.id, reservationId: kokuchiEventId },
        {
          $set: {
           gatheringVcUnlockChannelId: eventGatheringVcChannelId,
            gatheringVcRestoreEventId: kokuchiEventId,
            gatheringVcRestoreEventRevision: kokuchiEventRevision ?? 0,
            gatheringVcUnlockState: unlockAt.getTime() > postedAt.getTime() ? "pending" : "skipped",
            gatheringVcRestorePending: false,
            gatheringVcRestoreStatus: "not_required",
            gatheringVcRestoreFailureCode: null,
            gatheringVcRestoreAttemptCount: 0,
            gatheringVcRestoreLastError: null,
            gatheringVcRestoreNextRetryAt: null,
          },
          $unset: {
            gatheringVcPermissionBeforeOpen: 1,
            gatheringVcOpenedAt: 1,
            gatheringVcClosedAt: 1,
            gatheringVcClosedBySplitSessionId: 1,
          },
        },
      );
    }
    // Each existing scheduler deliberately marks a past event as skipped, so a
    // A late reservation never replays the already-passed timed actions.
    await scheduleKokuchiPreNotice(guild, savedSettings);
    await scheduleGatheringVcUnlock(guild, savedSettings);
    await scheduleKokuchiGatheringReminder(guild, savedSettings);
    return { settings: savedSettings, postedMessage };
    } catch (error) {
      error.kokuchiPublicationAttempted = publicationAttempted;
      if (postedMessage) {
        error.kokuchiPublication = {
          channelId: postedMessage.channelId,
          messageId: postedMessage.id,
          sentAt: postedAt ?? new Date(),
        };
      }
      throw error;
    } finally {
      if (lease) {
        await releaseMongoLease(lease).catch((error) => {
          console.error(`Failed to release /kokuchi lease for ${guild.id}: ${error.message}`);
        });
      }
      kokuchiPublishGuildLocks.delete(guild.id);
    }
  }
  
  async function scheduleKokuchiReservation(guild, reservation) {
    clearKokuchiReservationTimers(reservation.reservationId);
    if (reservation.status !== "pending") return;
    const scheduledAt = new Date(reservation.scheduledAt);
    const sendIn = scheduledAt.getTime() - Date.now();
    if (!Number.isFinite(scheduledAt.getTime())) return;
    const sendTimer = setTimeout(() => {
      void processKokuchiReservation(guild.id, reservation.reservationId)
        .catch((error) => console.error("Reserved /kokuchi failed:", error))
        .finally(() => requestOperationalStatusRefresh(guild.id, "kokuchi-reservation"));
    }, Math.max(0, sendIn));
    kokuchiReservationTimers.set(`${reservation.reservationId}:send`, sendTimer);
    if (reservation.reminderStatus === "pending") {
      const reminderIn = sendIn - 30 * 60 * 1000;
      if (reminderIn >= -5_000) {
        const reminderTimer = setTimeout(() => {
          void sendKokuchiReservationReminder(guild.id, reservation.reservationId)
            .catch((error) => console.error("Reserved /kokuchi reminder failed:", error))
            .finally(() => requestOperationalStatusRefresh(guild.id, "kokuchi-reservation-reminder"));
        }, reminderIn);
        kokuchiReservationTimers.set(`${reservation.reservationId}:reminder`, reminderTimer);
      } else {
        // This can occur when restoring an older reservation which was created
        // inside the 30-minute reminder window.  Do not send a late reminder.
        await KokuchiReservation.updateOne(
          { _id: reservation._id, status: "pending", reminderStatus: "pending" },
          { $set: { reminderStatus: "skipped" } },
        );
      }
    }
  }
  
  function clearKokuchiReservationTimers(reservationId) {
    const prefix = `${reservationId}:`;
    for (const [key, timer] of kokuchiReservationTimers) {
      if (!key.startsWith(prefix)) continue;
      if (timer) clearTimeout(timer);
      kokuchiReservationTimers.delete(key);
    }
  }
  
  async function sendKokuchiReservationReminder(guildId, reservationId) {
    const reservation = await KokuchiReservation.findOneAndUpdate(
      { guildId, reservationId, status: "pending", reminderStatus: "pending" },
      { $set: { reminderStatus: "processing", reminderProcessingAt: new Date() } },
      { returnDocument: "after" },
    ).lean();
    if (!reservation) return;
    const expectedRevision = reservation.lifecycleRevision ?? 0;
    try {
      const currentBeforeSend = await KokuchiReservation.findOne({
        _id: reservation._id,
        status: "pending",
        reminderStatus: "processing",
        lifecycleRevision: expectedRevision,
        cancelRequested: { $ne: true },
      }).lean();
      if (!currentBeforeSend) return;
      const beforeDiscord = await getKokuchiActionGuard({
        guildId,
        eventId: reservation.reservationId,
        expectedRevision,
      });
      if (!beforeDiscord.valid) {
        await KokuchiReservation.updateOne(
          { _id: reservation._id, reminderStatus: "processing" },
          { $set: { reminderStatus: "canceled" }, $unset: { reminderProcessingAt: 1 } },
        );
        return;
      }
      const channel = await client.channels.fetch(reservation.commandChannelId).catch(() => null);
      if (!channel?.send) throw new Error("Reservation command channel is unavailable");
      const message = await channel.send({ content: `<@${reservation.commandUserId}> 予約した告知の送信30分前です。\n告知は${formatJstReservationTime(new Date(reservation.scheduledAt), reservation.displayHour)}に送信されます。`, allowedMentions: { users: [reservation.commandUserId] } });
      const afterDiscord = await getKokuchiActionGuard({
        guildId,
        eventId: reservation.reservationId,
        expectedRevision,
      });
      const current = await KokuchiReservation.findOne({
        _id: reservation._id,
        status: "pending",
        reminderStatus: "processing",
        lifecycleRevision: expectedRevision,
        cancelRequested: { $ne: true },
      }).lean();
      if (!afterDiscord.valid || !current) {
        if (message?.delete) await message.delete().catch((error) => logRecoverableError("Failed to compensate reservation reminder after kokuchi cancellation", error));
        await KokuchiReservation.updateOne(
          { _id: reservation._id, reminderStatus: "processing" },
          { $set: { reminderStatus: "canceled" }, $unset: { reminderProcessingAt: 1 } },
        );
        return;
      }
      await KokuchiReservation.updateOne(
        { _id: reservation._id, status: "pending", reminderStatus: "processing", lifecycleRevision: expectedRevision, cancelRequested: { $ne: true } },
        { $set: { reminderStatus: "sent" }, $unset: { reminderProcessingAt: 1 } },
      );
    } catch (error) {
      await KokuchiReservation.updateOne(
        { _id: reservation._id, status: "pending", reminderStatus: "processing", lifecycleRevision: expectedRevision, cancelRequested: { $ne: true } },
        { $set: { reminderStatus: "failed" }, $unset: { reminderProcessingAt: 1 } },
      );
      console.error("Reserved /kokuchi reminder failed:", error);
    }
  }
  
  async function processKokuchiReservation(guildId, reservationId) {
    const reservation = await KokuchiReservation.findOneAndUpdate(
      { guildId, reservationId, status: "pending" },
      {
        $set: {
          status: "processing",
          kokuchiStatus: "running",
          processingAt: new Date(),
          publicationStatus: "processing",
          publicationStartedAt: new Date(),
          postProcessingStatus: "pending",
        },
      },
      { returnDocument: "after" },
    ).lean();
    if (!reservation) return;
    clearKokuchiReservationTimers(reservationId);
    const guild = client.guilds.cache.get(guildId) ?? await client.guilds.fetch(guildId).catch(() => null);
    let publication = null;
    try {
      const [sendChannel, overviewChannel, settings] = await Promise.all([
        guild?.channels.fetch(reservation.targetChannelId), guild?.channels.fetch(reservation.overviewChannelId), getGuildSettings(guildId),
      ]);
      if (!guild || !sendChannel?.send || !overviewChannel?.send) throw new Error("Configured channel is unavailable");
      let eventAt = new Date(reservation.eventAt);
      if (!Number.isFinite(eventAt.getTime())) {
        eventAt = getNextKokuchiEventAt({
          weekday: reservation.weekday,
          eventTime: normalizeKokuchiEventTime(settings?.kokuchiEventTime) ?? "21:00",
          now: new Date(reservation.scheduledAt),
        });
        if (!Number.isFinite(eventAt?.getTime())) {
          throw new Error("Reserved kokuchi has no valid eventAt");
        }
        const eventAtSaved = await KokuchiReservation.updateOne(
          { _id: reservation._id, status: "processing" },
          { $set: { eventAt } },
        );
        if (eventAtSaved.matchedCount !== 1) {
          throw new Error("Reserved kokuchi eventAt could not be persisted");
        }
      }
      publication = await publishKokuchi({
        guild,
        weekday: reservation.weekday,
        sendChannel,
        overviewChannel,
        settings,
        eventAt,
        kokuchiEventId: reservation.reservationId,
        kokuchiEventRevision: reservation.lifecycleRevision ?? 0,
        leaseKey: `kokuchi-publish:${guild.id}:${reservation.eventDate ?? getKokuchiEventDate(reservation.scheduledAt, reservation.displayHour)}`,
        onPublished: async ({ postedMessage, postedAt }) => {
          const publicationPersisted = await KokuchiReservation.updateOne(
            { _id: reservation._id, status: "processing" },
            {
              $set: {
                publicationStatus: "published",
                publicationChannelId: postedMessage.channelId,
                publicationMessageId: postedMessage.id,
                publicationSentAt: postedAt,
                postProcessingStatus: "processing",
              },
            },
          );
          if (publicationPersisted.matchedCount !== 1 || publicationPersisted.modifiedCount !== 1) {
            throw new Error("Reservation publication succeeded but its message ID could not be persisted.");
          }
        },
      });
      const sentPersisted = await KokuchiReservation.updateOne(
        { _id: reservation._id, status: "processing" },
        {
          $set: {
            status: "sent",
            kokuchiStatus: "completed",
            sentAt: new Date(),
            cleanupAt: cleanupAtForKokuchiReservation(reservation),
            publicationStatus: "published",
            publicationConfirmedAt: new Date(),
            postProcessingStatus: "completed",
          },
          $unset: { activeKey: 1, processingAt: 1, postProcessingError: 1 },
        },
      );
      if (sentPersisted.matchedCount !== 1 || sentPersisted.modifiedCount !== 1) {
        throw new Error("Reservation publication completed but sent status could not be persisted; automatic retry is disabled to prevent duplicates.");
      }
      await editKokuchiReservationConfirmation(
        reservation,
        `【送信済み】\n\n告知を${formatJstReservationTime(new Date(reservation.scheduledAt), reservation.displayHour)}に送信しました。未実行の後続処理は下のボタンでキャンセルできます。`,
        createKokuchiCancellationComponents(reservation),
      );
    } catch (error) {
      const confirmedPublication = publication?.postedMessage ?? error?.kokuchiPublication ?? null;
      const publicationUnconfirmed = Boolean(confirmedPublication || error?.kokuchiPublicationAttempted === true);
      await KokuchiReservation.updateOne(
        { _id: reservation._id, status: "processing" },
        {
          $set: publicationUnconfirmed
            ? {
              status: "published_unconfirmed",
              kokuchiStatus: "running",
              publicationStatus: "published_unconfirmed",
              publicationChannelId: confirmedPublication?.channelId,
              publicationMessageId: confirmedPublication?.messageId,
              publicationSentAt: confirmedPublication?.sentAt ?? new Date(),
              postProcessingStatus: "failed",
              postProcessingError: error.message,
              publishedAt: new Date(),
              failedAt: new Date(),
              recoveryReason: `Discord publication may have succeeded; manual confirmation required: ${error.message}`,
            }
            : {
              status: "failed",
              kokuchiStatus: "scheduled",
              publicationStatus: "failed_before_publish",
              postProcessingStatus: "failed",
              postProcessingError: error.message,
              failedAt: new Date(),
              cleanupAt: cleanupAtForKokuchiReservation(reservation),
            },
          $unset: publicationUnconfirmed
            ? { activeKey: 1, processingAt: 1 }
            : { activeKey: 1, processingAt: 1, publicationKey: 1 },
        },
      );
      await editKokuchiReservationConfirmation(
        reservation,
        publicationUnconfirmed
          ? "【送信状態を確認中】\n\n告知投稿後の確認処理に失敗しました。重複投稿を防ぐため自動再送は行いません。"
          : "【送信失敗】\n\n予約していた告知を送信できませんでした。\n送信先チャンネルやBotの権限をご確認ください。",
      );
      const commandChannel = await client.channels.fetch(reservation.commandChannelId).catch(() => null);
      await commandChannel?.send?.({ content: `<@${reservation.commandUserId}> 予約していた告知を送信できませんでした。`, allowedMentions: { users: [reservation.commandUserId] } }).catch((error) => logRecoverableError("Recoverable asynchronous operation failed", error));
      await sendOperationalLog({ guild, settings: await getGuildSettings(guildId).catch(() => null), fallbackChannel: commandChannel, content: `予約告知送信失敗: ${error.message}` }).catch((error) => logRecoverableError("Recoverable asynchronous operation failed", error));
    }
  }
  
  async function resumeKokuchiPostProcessing(reservation) {
    const guild = client.guilds.cache.get(reservation.guildId)
      ?? await client.guilds.fetch(reservation.guildId).catch(() => null);
    if (!guild) throw new Error("Guild is unavailable for kokuchi post-processing recovery");
  
    // Publication recovery can run after a process restart while a separate
    // gathering-VC operation is still waiting for restoration.  The event
    // record is the durable source of truth; never let publication recovery
    // clear its snapshot, event identity, retry metadata, or cleanup guard.
    const persistedRestoreState = await KokuchiReservation.findOne({
      _id: reservation._id,
      reservationId: reservation.reservationId,
    }).lean();
    if (!persistedRestoreState) throw new Error("Kokuchi reservation disappeared during post-processing recovery");
    const persistedRestoreStatus = normalizeGatheringVcRestoreStatus(persistedRestoreState);
    const restoreIncomplete = persistedRestoreState.gatheringVcRestorePending === true
      || isGatheringVcRestoreBlocking(persistedRestoreStatus);
  
    const postedAt = new Date(reservation.publicationSentAt ?? reservation.publishedAt ?? reservation.scheduledAt);
    if (!Number.isFinite(postedAt.getTime())) throw new Error("Published kokuchi reservation has no valid publication time");
  
    const currentSettings = await getGuildSettings(guild.id);
    const eventAt = new Date(reservation.eventAt ?? getNextKokuchiEventAt({
      weekday: reservation.weekday,
      eventTime: normalizeKokuchiEventTime(currentSettings?.kokuchiEventTime) ?? "21:00",
      now: postedAt,
    }));
    if (!Number.isFinite(eventAt.getTime())) throw new Error("Published kokuchi reservation has no valid event time");
    if (!reservation.eventAt) {
      const eventAtSaved = await KokuchiReservation.updateOne(
        { _id: reservation._id, status: { $in: ["processing", "published_unconfirmed"] } },
        { $set: { eventAt } },
      );
      if (eventAtSaved.matchedCount !== 1) {
        throw new Error("Recovered kokuchi eventAt could not be persisted");
      }
    }
    const preNoticeAt = getKokuchiPreNoticeAt(eventAt);
    const unlockAt = getGatheringVcUnlockAt(eventAt);
    const reminderAt = getKokuchiGatheringReminderAt(eventAt);
    const eventGatheringVcChannelId = resolveKokuchiGatheringVoiceChannelId(currentSettings, currentSettings);
    const restoreStatePatch = restoreIncomplete ? {} : {
      gatheringVcUnlockChannelId: eventGatheringVcChannelId,
      gatheringVcStateEventId: reservation.reservationId,
      gatheringVcRestoreEventId: reservation.reservationId,
      gatheringVcRestoreEventRevision: reservation.lifecycleRevision ?? 0,
      gatheringVcPermissionBeforeOpen: null,
      gatheringVcRestorePending: false,
      gatheringVcRestoreStatus: "not_required",
      gatheringVcRestoreFailureCode: null,
      gatheringVcRestoreAttemptCount: 0,
      gatheringVcRestoreLastError: null,
      gatheringVcRestoreNextRetryAt: null,
    };
    const eventRestoreStatePatch = restoreIncomplete
      ? {}
      : Object.fromEntries(Object.entries(restoreStatePatch).filter(([key]) => key !== "gatheringVcPermissionBeforeOpen"));
    const savedSettings = await saveGuildSettingsWithCurrent(guild.id, currentSettings, {
      lastKokuchiWeekday: reservation.weekday,
      lastKokuchiPostedAt: postedAt.toISOString(),
      lastKokuchiMessageId: reservation.publicationMessageId,
      lastKokuchiChannelId: reservation.publicationChannelId ?? reservation.targetChannelId,
      kokuchiEventId: reservation.reservationId,
      kokuchiEventAt: eventAt.toISOString(),
      kokuchiPreNoticeAt: preNoticeAt.toISOString(),
      kokuchiPreNoticeChannelId: reservation.publicationChannelId ?? reservation.targetChannelId,
      kokuchiPreNoticeState: preNoticeAt.getTime() > postedAt.getTime() ? "pending" : "skipped",
      gatheringVcUnlockAt: unlockAt.toISOString(),
      ...restoreStatePatch,
      gatheringVcUnlockState: unlockAt.getTime() > postedAt.getTime() ? "pending" : "skipped",
      kokuchiGatheringReminderAt: reminderAt.toISOString(),
      kokuchiGatheringReminderChannelId: reservation.publicationChannelId ?? reservation.targetChannelId,
      kokuchiGatheringReminderState: reminderAt.getTime() > postedAt.getTime() ? "pending" : "skipped",
    });
    await KokuchiReservation.updateOne(
      { _id: reservation._id, reservationId: reservation.reservationId },
      {
        $set: {
          gatheringVcUnlockState: unlockAt.getTime() > postedAt.getTime() ? "pending" : "skipped",
          ...eventRestoreStatePatch,
        },
        ...(restoreIncomplete ? {} : {
          $unset: {
            gatheringVcPermissionBeforeOpen: 1,
            gatheringVcOpenedAt: 1,
            gatheringVcClosedAt: 1,
            gatheringVcClosedBySplitSessionId: 1,
          },
        }),
      },
    );
    await scheduleKokuchiPreNotice(guild, savedSettings);
    await scheduleGatheringVcUnlock(guild, savedSettings);
    await scheduleKokuchiGatheringReminder(guild, savedSettings);
  
    const completionUpdate = {
      $set: {
        status: "sent",
        kokuchiStatus: "completed",
        sentAt: new Date(),
        publicationStatus: "published",
        publicationConfirmedAt: new Date(),
        postProcessingStatus: "completed",
        ...(restoreIncomplete ? {} : { cleanupAt: cleanupAtForKokuchiReservation({ ...reservation, gatheringVcRestoreStatus: "not_required", gatheringVcRestorePending: false }) }),
      },
      $unset: {
        activeKey: 1,
        processingAt: 1,
        postProcessingError: 1,
        ...(restoreIncomplete ? { cleanupAt: 1 } : {}),
      },
    };
    const completed = await KokuchiReservation.updateOne(
      { _id: reservation._id, status: { $in: ["processing", "published_unconfirmed"] } },
      completionUpdate,
    );
    if (completed.matchedCount !== 1 || completed.modifiedCount !== 1) {
      throw new Error("Kokuchi post-processing completion could not be persisted");
    }
    await editKokuchiReservationConfirmation(
      reservation,
      `【送信済み】\n\n告知を${formatJstReservationTime(new Date(reservation.scheduledAt), reservation.displayHour)}に送信しました。未実行の後続処理は下のボタンでキャンセルできます。`,
      createKokuchiCancellationComponents(reservation),
    );
  }
  
  function createKokuchiCancellationComponents(reservation) {
    return [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`${KOKUCHI_RESERVATION_CANCEL_CUSTOM_ID}:${reservation.reservationId}`).setLabel("後続処理をキャンセル").setStyle(ButtonStyle.Danger),
    )];
  }
  
  async function editKokuchiReservationConfirmation(reservation, content, components = []) {
    const channel = await client.channels.fetch(reservation.confirmationChannelId).catch(() => null);
    const message = await channel?.messages?.fetch?.(reservation.confirmationMessageId).catch(() => null);
    await message?.edit({ content, components }).catch((error) => logRecoverableError("Failed to update kokuchi reservation confirmation", error));
  }
  
  async function createKokuchiCancellationControl(channel, reservation) {
    if (!channel?.send) return null;
    const confirmation = await channel.send({
      content: "【告知後の操作】\n\n未実行の事前通知・集合VC開放・集合開始通知をキャンセルできます。",
      components: createKokuchiCancellationComponents(reservation),
    });
    const persisted = await KokuchiReservation.updateOne(
      { _id: reservation._id, status: "sent", confirmationMessageId: null },
      { $set: { confirmationChannelId: confirmation.channelId, confirmationMessageId: confirmation.id } },
    );
    if (persisted.matchedCount !== 1) {
      await confirmation.delete().catch(() => null);
      return null;
    }
    return confirmation;
  }
  
  async function handleKokuchiReservationCancel(interaction) {
    // Acknowledge the component before looking up or changing MongoDB state so
    // a slow database cannot make the cancellation button appear to fail.
    await interaction.deferUpdate();
    const reservationId = interaction.customId.slice(`${KOKUCHI_RESERVATION_CANCEL_CUSTOM_ID}:`.length);
    const reservation = await KokuchiReservation.findOne({ reservationId }).lean();
    if (!reservation) {
      await interaction.followUp({ content: "この告知予約は見つかりません。", flags: MessageFlags.Ephemeral });
      return;
    }
    const permitted = reservation.commandUserId === interaction.user.id || interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
    if (!permitted) {
      await interaction.followUp({ content: "この告知予約をキャンセルする権限がありません。", flags: MessageFlags.Ephemeral });
      return;
    }
    const lease = await acquireMongoLease(`kokuchi-recovery:${interaction.guildId}`, { leaseMs: 5 * 60 * 1000 });
    if (!lease) {
      await interaction.followUp({ content: "Kokuchi recovery is already running; please retry shortly.", flags: MessageFlags.Ephemeral });
      return;
    }
    try {
    if (!["pending", "sent", "cancel_partial"].includes(reservation.status)) {
      const content = reservation.status === "canceled"
          ? "この告知予約はすでにキャンセルされています。"
          : reservation.status === "failed"
            ? "この告知予約は送信失敗として終了しています。"
            : "この告知予約は現在送信処理中のため、キャンセルできません。";
      await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
      return;
    }
    const reminderStatus = getKokuchiReminderStatusOnCancel(reservation.reminderStatus);
    const reminderPatch = reminderStatus === reservation.reminderStatus ? {} : { reminderStatus };
    const canceled = await KokuchiReservation.findOneAndUpdate(
      { _id: reservation._id, status: { $in: ["pending", "sent", "cancel_partial"] } },
      {
        $set: {
          status: "canceling",
          kokuchiStatus: "canceling",
          cancelRequested: true,
          cancellationStartedAt: new Date(),
          cancellationError: null,
          ...reminderPatch,
        },
        $inc: { lifecycleRevision: 1 },
      },
      { returnDocument: "after", lean: true },
    );
    if (canceled) {
      const cancellation = await completeKokuchiCancellation({
        reservation: canceled,
        guild: interaction.guild ?? await client.guilds.fetch(canceled.guildId).catch(() => null),
      });
      const completeContent = formatKokuchiCancellationResult(cancellation);
      await interaction.editReply({
        content: completeContent,
        components: cancellation.status === "canceled" ? [] : createKokuchiCancellationComponents(canceled),
      });
      await sendOperationalLog({
        guild: interaction.guild,
        settings: cancellation.settings,
        fallbackChannel: interaction.channel,
        content: `kokuchi cancellation ${canceled.reservationId}: ${cancellation.status}; ${completeContent.replace(/\n/g, " ")}`,
      }).catch((error) => logRecoverableError("Failed to log kokuchi reservation cancellation", error));
      return;
    }
    await interaction.followUp({ content: "この告知予約はすでに処理されています。", flags: MessageFlags.Ephemeral });
    } finally {
      await releaseMongoLease(lease).catch((error) => logRecoverableError("Failed to release kokuchi cancellation lease", error));
    }
  }
  
  function emptyKokuchiCancellationResult() {
    return { canceled: 0, alreadyCompleted: 0, alreadyCanceled: 0, failed: 0, errors: [] };
  }
  
  function addKokuchiCancellationResult(total, next) {
    for (const key of ["canceled", "alreadyCompleted", "alreadyCanceled", "failed"]) {
      total[key] += Number(next?.[key] ?? 0);
    }
    total.errors.push(...(Array.isArray(next?.errors) ? next.errors : []));
  }
  
  function formatKokuchiCancellationResult(result) {
    const heading = result.status === "canceled" ? "【キャンセル完了】" : "【キャンセル一部完了】";
    return [
      heading,
      `キャンセル成功：${result.canceled}件`,
      `すでに実行済み：${result.alreadyCompleted}件`,
      `すでにキャンセル済み：${result.alreadyCanceled}件`,
      `失敗：${result.failed}件`,
      `VC権限復元：${result.permissionRestored === "restored" ? "成功" : result.permissionRestored === "not_needed" ? "不要" : ["pending", "restoring", "retry_wait"].includes(result.permissionRestored) ? "復元待ち" : "失敗"}`,
      ...(result.permissionRestored && !["restored", "not_needed"].includes(result.permissionRestored) ? ["告知処理は終了済みです。集合VCの復元は別状態で再試行されます。"] : []),
    ].join("\n");
  }
  
  async function completeKokuchiCancellation({ reservation, guild }) {
    const result = emptyKokuchiCancellationResult();
    clearKokuchiReservationTimers(reservation.reservationId);
    let settings = null;
    try {
      settings = await getGuildSettings(reservation.guildId);
    } catch (error) {
      result.failed += 1;
      result.errors.push(`GuildSettings could not be read: ${error.message}`);
    }
  
    const isCurrentEvent = settings?.kokuchiEventId === reservation.reservationId;
    if (isCurrentEvent) {
      clearKokuchiPreNoticeTimer(reservation.guildId);
      clearGatheringVcUnlockTimer(reservation.guildId);
      clearKokuchiGatheringReminderTimer(reservation.guildId);
    }
  
    const work = await Promise.allSettled([
      cancelKokuchiTimedActions({ guildId: reservation.guildId, kokuchiEventId: reservation.reservationId }),
      cancelKokuchiScheduledActions({ guildId: reservation.guildId, kokuchiEventId: reservation.reservationId }),
    ]);
    for (const item of work) {
      if (item.status === "fulfilled") addKokuchiCancellationResult(result, item.value);
      else {
        result.failed += 1;
        result.errors.push(item.reason?.message ?? String(item.reason));
      }
    }
  
    const roleRemoval = await cancelKokuchiRoleRemovalWait({ guild, reservation }).catch((error) => ({ errors: [error.message] }));
    result.errors.push(...(roleRemoval.errors ?? []));
  
    let permissionRestored = "not_needed";
    const eventState = await KokuchiReservation.findOne({ guildId: reservation.guildId, reservationId: reservation.reservationId }).lean().catch(() => null);
    const eventRestoreStatus = normalizeGatheringVcRestoreStatus(eventState ?? {});
    // The reservation is the source of truth for restoration. It may no longer
    // be the current GuildSettings event when a newer /kokuchi has been
    // scheduled; the older event must still restore its own snapshot. The
    // settings patch remains guarded by the event id.
    if (eventState && (
      eventState.gatheringVcUnlockState === "opened"
      || eventState.gatheringVcPermissionBeforeOpen
      || isGatheringVcRestoreBlocking(eventRestoreStatus)
    )) {
      if (!guild) {
        permissionRestored = "failed";
        result.failed += 1;
        result.errors.push("Guild was unavailable for gathering VC permission restoration.");
      } else {
        const restored = await restoreGatheringVcPermissionAfterSplit(guild, settings, { eventId: reservation.reservationId, force: true }).catch((error) => {
          result.errors.push(`Gathering VC permission restoration failed: ${error.message}`);
          return false;
        });
        if (restored) permissionRestored = "restored";
        else {
          const afterRestore = await KokuchiReservation.findOne({ _id: reservation._id }).lean().catch(() => null);
          permissionRestored = afterRestore?.gatheringVcRestoreStatus ?? "retry_wait";
          result.failed += 1;
        }
      }
    }
  
    const noRestoreStateConfirmed = Boolean(
      eventState
      && eventState.gatheringVcRestorePending !== true
      && normalizeGatheringVcRestoreStatus(eventState) === "not_required"
      && eventState.gatheringVcUnlockState !== "opened"
      && eventState.gatheringVcUnlockState !== "closing"
      && !eventState.gatheringVcPermissionBeforeOpen,
    );
    if (permissionRestored === "not_needed" && noRestoreStateConfirmed) {
      await KokuchiReservation.updateOne(
        { _id: reservation._id, status: "canceling" },
        {
          $set: {
            gatheringVcRestorePending: false,
            gatheringVcRestoreStatus: "not_required",
            gatheringVcRestoreFailureCode: null,
            gatheringVcRestoreLastError: null,
            gatheringVcRestoreNextRetryAt: null,
          },
          $unset: {
            gatheringVcUnlockChannelId: 1,
            gatheringVcPermissionBeforeOpen: 1,
            gatheringVcOpenedAt: 1,
            gatheringVcClosedAt: 1,
            gatheringVcClosedBySplitSessionId: 1,
            gatheringVcRestorePendingAt: 1,
            gatheringVcRestoreEventId: 1,
            gatheringVcRestoreEventRevision: 1,
          },
        },
      ).catch((error) => result.errors.push(`Failed to clear completed gathering VC event state: ${error.message}`));
      if (settings?.kokuchiEventId === reservation.reservationId || settings?.gatheringVcStateEventId === reservation.reservationId) {
        await patchGuildSettingsForKokuchiEvent({
          guildId: reservation.guildId,
          kokuchiEventId: reservation.reservationId,
          set: {
            gatheringVcRestorePending: false,
            gatheringVcRestoreStatus: "not_required",
            gatheringVcRestoreFailureCode: null,
            gatheringVcRestoreLastError: null,
            gatheringVcRestoreNextRetryAt: null,
          },
          unset: {
            gatheringVcUnlockChannelId: true,
            gatheringVcPermissionBeforeOpen: true,
             gatheringVcRestorePendingAt: true,
             gatheringVcRestoreEventId: true,
             gatheringVcRestoreEventRevision: true,
             gatheringVcStateEventId: true,
          },
        }).catch((error) => result.errors.push(`Failed to clear GuildSettings gathering VC state: ${error.message}`));
      }
    }
  
    const status = "canceled";
    const cleanupAt = getKokuchiReservationCleanupAt({ restoreStatus: permissionRestored === "not_needed" ? "not_required" : permissionRestored });
    const updated = await KokuchiReservation.updateOne(
      { _id: reservation._id, status: "canceling" },
      {
        $set: {
          status,
          kokuchiStatus: "canceled",
          cancelRequested: true,
          reminderStatus: "canceled",
          cancellationResults: { ...result, roleRemoval },
          canceledAt: new Date(),
          cancellationError: null,
          ...(cleanupAt ? { cleanupAt } : {}),
        },
        $unset: { activeKey: 1, cancellationStartedAt: 1, ...(cleanupAt ? {} : { cleanupAt: 1 }) },
      },
    );
    if (updated.matchedCount !== 1) {
      throw new Error("Kokuchi cancellation final state could not be persisted.");
    }
    requestOperationalStatusRefresh(reservation.guildId, "kokuchi-cancellation");
    return { ...result, status, settings, permissionRestored };
  }
  
  async function restoreKokuchiReservations() {
    // Never automatically replay an interrupted publication: it may already
    // have reached Discord before the process stopped.
    const interrupted = await KokuchiReservation.find({ status: "processing" }).lean();
    for (const reservation of interrupted) {
      try {
        if (reservation.publicationMessageId) {
          await resumeKokuchiPostProcessing(reservation);
          continue;
        }
        const failed = await KokuchiReservation.findOneAndUpdate(
          { _id: reservation._id, status: "processing" },
          {
            $set: {
              status: "failed",
              kokuchiStatus: "scheduled",
              failedAt: new Date(),
              cleanupAt: cleanupAtForKokuchiReservation(reservation),
              recoveryReason: "Bot restarted while reservation publication was processing",
            },
            $unset: { activeKey: 1, processingAt: 1 },
          },
          { returnDocument: "after", lean: true },
        );
        if (!failed) continue;
        await editKokuchiReservationConfirmation(failed, "【送信失敗】\n\nBotの再起動中に送信処理が中断されたため、予約していた告知を送信できませんでした。\n重複投稿防止のため、自動再送は行っていません。");
        const commandChannel = await client.channels.fetch(failed.commandChannelId).catch(() => null);
        await commandChannel?.send?.({
          content: `<@${failed.commandUserId}> 予約告知の送信処理がBot再起動により中断されました。`,
          allowedMentions: { users: [failed.commandUserId] },
        }).catch((error) => logRecoverableError("Recoverable asynchronous operation failed", error));
        const guild = client.guilds.cache.get(failed.guildId) ?? await client.guilds.fetch(failed.guildId).catch(() => null);
        await sendOperationalLog({
          guild,
          settings: await getGuildSettings(failed.guildId).catch(() => null),
          fallbackChannel: commandChannel,
          content: `予約告知を再起動中断として失敗にしました。予約ID: ${failed.reservationId}`,
        }).catch((error) => logRecoverableError("Recoverable asynchronous operation failed", error));
      } catch (error) {
        console.error(`Failed to recover interrupted kokuchi reservation ${reservation.reservationId}: ${error.message}`);
      }
    }
    await KokuchiReservation.updateMany(
      { status: "pending", reminderStatus: "processing" },
      { $set: { reminderStatus: "failed" }, $unset: { reminderProcessingAt: 1 } },
    );
    const unconfirmedPublications = await KokuchiReservation.find({
      status: "published_unconfirmed",
      publicationMessageId: { $exists: true, $ne: null },
    }).lean();
    for (const reservation of unconfirmedPublications) {
      try {
        await resumeKokuchiPostProcessing(reservation);
      } catch (error) {
        console.error(`Failed to resume kokuchi post-processing ${reservation.reservationId}: ${error.message}`);
      }
    }
    const unfinishedCancellations = await KokuchiReservation.find({
      status: { $in: ["canceling", "cancel_partial"] },
    }).lean();
    for (const pendingCancellation of unfinishedCancellations) {
      try {
        const canceling = pendingCancellation.status === "canceling"
          ? pendingCancellation
          : await KokuchiReservation.findOneAndUpdate(
            { _id: pendingCancellation._id, status: "cancel_partial" },
            {
              $set: {
                status: "canceling",
                kokuchiStatus: "canceling",
                cancelRequested: true,
                cancellationStartedAt: new Date(),
              },
              $inc: { lifecycleRevision: 1 },
              $unset: { activeKey: 1, cleanupAt: 1 },
            },
            { returnDocument: "after", lean: true },
          );
        if (!canceling) continue;
        const guild = client.guilds.cache.get(canceling.guildId)
          ?? await client.guilds.fetch(canceling.guildId).catch(() => null);
        const result = await completeKokuchiCancellation({ reservation: canceling, guild });
        await editKokuchiReservationConfirmation(
          canceling,
          formatKokuchiCancellationResult(result),
          result.status === "canceled" ? [] : createKokuchiCancellationComponents(canceling),
        );
      } catch (error) {
        console.error(`Failed to resume kokuchi cancellation ${pendingCancellation.reservationId}: ${error.message}`);
      }
    }
    const reservations = await KokuchiReservation.find({ status: "pending" }).lean();
    for (const reservation of reservations) {
      try {
        const guild = client.guilds.cache.get(reservation.guildId) ?? await client.guilds.fetch(reservation.guildId).catch(() => null);
        if (!guild) continue;
        if (new Date(reservation.scheduledAt).getTime() <= Date.now()) await processKokuchiReservation(guild.id, reservation.reservationId);
        else await scheduleKokuchiReservation(guild, reservation);
      } catch (error) {
        console.error(`Failed to restore kokuchi reservation ${reservation.reservationId}: ${error.message}`);
      }
    }
  }
  
  function getGatheringVcUnlockChannelId(settings) {
    if (!settings?.kokuchiEventId || settings?.gatheringVcStateEventId !== settings.kokuchiEventId) return null;
    return settings?.gatheringVcUnlockChannelId ?? null;
  }
  
  function normalizeKokuchiEventTime(value) {
    if (typeof value !== "string") return null;
    const match = /^(\d{2}):(\d{2})$/.exec(value.trim());
    if (!match) return null;
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour > 23 || minute > 59) return null;
    return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  }
  
  function getKokuchiTimedActionAt(eventAt, minutesBefore) {
    return new Date(new Date(eventAt).getTime() - minutesBefore * 60_000);
  }
  
  function formatKokuchiDerivedTime(settings, minutesBefore) {
    const [hour, minute] = (normalizeKokuchiEventTime(settings?.kokuchiEventTime) ?? "21:00")
      .split(":")
      .map(Number);
    const minutes = (hour * 60 + minute - minutesBefore + 24 * 60) % (24 * 60);
    return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
  }
  
  function getKokuchiPreNoticeAt(eventAt) {
    return getKokuchiTimedActionAt(eventAt, 30);
  }
  
  function getGatheringVcUnlockAt(eventAt) {
    return getKokuchiTimedActionAt(eventAt, 20);
  }
  
  function getKokuchiGatheringReminderAt(eventAt) {
    return getKokuchiTimedActionAt(eventAt, 5);
  }
  
  function getKokuchiEventAtOnSameJstDate(previousEventAt, eventTime) {
    const prior = new Date(previousEventAt);
    const [hour, minute] = (normalizeKokuchiEventTime(eventTime) ?? "21:00").split(":").map(Number);
    const jst = new Date(prior.getTime() + 9 * 60 * 60 * 1000);
    return new Date(Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate(), hour - 9, minute, 0, 0));
  }
  
  async function rescheduleCurrentKokuchiEvent(guild, previousSettings, nextSettings) {
    const eventId = previousSettings?.kokuchiEventId;
    if (!eventId || previousSettings?.kokuchiEventId !== nextSettings?.kokuchiEventId) return false;
    const settingsChanged = previousSettings.kokuchiEventTime !== nextSettings.kokuchiEventTime
      || previousSettings.gatheringVoiceChannelId !== nextSettings.gatheringVoiceChannelId
      || getKokuchiAnnouncementChannelId(previousSettings) !== getKokuchiAnnouncementChannelId(nextSettings);
    if (!settingsChanged) return false;
    const reservation = await KokuchiReservation.findOne({ reservationId: eventId, status: "sent" }).lean();
    if (!reservation) return false;
    const eventAt = getKokuchiEventAtOnSameJstDate(previousSettings.kokuchiEventAt ?? reservation.eventAt, nextSettings.kokuchiEventTime);
    if (!Number.isFinite(eventAt.getTime())) return false;
    clearKokuchiPreNoticeTimer(guild.id);
    clearGatheringVcUnlockTimer(guild.id);
    clearKokuchiGatheringReminderTimer(guild.id);
    const now = new Date();
    const stateFor = (previousState, at) => {
      if (!["pending", "failed"].includes(previousState)) return previousState;
      return at.getTime() > now.getTime() ? "pending" : "skipped";
    };
    const preNoticePending = ["pending", "failed"].includes(previousSettings.kokuchiPreNoticeState);
    const unlockPending = ["pending", "failed"].includes(previousSettings.gatheringVcUnlockState);
    const reminderPending = ["pending", "failed"].includes(previousSettings.kokuchiGatheringReminderState);
    const saved = await saveGuildSettingsWithCurrent(guild.id, nextSettings, {
      kokuchiEventAt: eventAt.toISOString(),
      ...(preNoticePending ? {
        kokuchiPreNoticeAt: getKokuchiPreNoticeAt(eventAt).toISOString(),
        kokuchiPreNoticeChannelId: getKokuchiAnnouncementChannelId(nextSettings),
        kokuchiPreNoticeState: stateFor(previousSettings.kokuchiPreNoticeState, getKokuchiPreNoticeAt(eventAt)),
      } : {}),
      ...(unlockPending ? {
        gatheringVcUnlockAt: getGatheringVcUnlockAt(eventAt).toISOString(),
        gatheringVcUnlockChannelId: getGatheringVcUnlockChannelId(nextSettings),
        gatheringVcUnlockState: stateFor(previousSettings.gatheringVcUnlockState, getGatheringVcUnlockAt(eventAt)),
      } : {}),
      ...(reminderPending ? {
        kokuchiGatheringReminderAt: getKokuchiGatheringReminderAt(eventAt).toISOString(),
        kokuchiGatheringReminderChannelId: getKokuchiAnnouncementChannelId(nextSettings),
        kokuchiGatheringReminderState: stateFor(previousSettings.kokuchiGatheringReminderState, getKokuchiGatheringReminderAt(eventAt)),
      } : {}),
    });
    await KokuchiReservation.updateOne(
      { _id: reservation._id, status: "sent" },
      { $set: { eventAt, ...(unlockPending ? { gatheringVcUnlockChannelId: getGatheringVcUnlockChannelId(nextSettings) } : {}) } },
    );
    await Promise.all([
      preNoticePending ? scheduleKokuchiPreNotice(guild, saved) : null,
      unlockPending ? scheduleGatheringVcUnlock(guild, saved) : null,
      reminderPending ? scheduleKokuchiGatheringReminder(guild, saved) : null,
    ]);
    await sendOperationalLog({
      guild,
      settings: saved,
      fallbackChannel: null,
      content: `kokuchi開催設定を変更したため、未実行の後続処理を再スケジュールしました。開催回: ${eventId}`,
    }).catch((error) => logRecoverableError("Failed to log kokuchi rescheduling", error));
    return true;
  }
  
  function isSameJstDate(left, right) {
    const leftJst = new Date(left.getTime() + 9 * 60 * 60 * 1000);
    const rightJst = new Date(right.getTime() + 9 * 60 * 60 * 1000);
  
    return (
      leftJst.getUTCFullYear() === rightJst.getUTCFullYear() &&
      leftJst.getUTCMonth() === rightJst.getUTCMonth() &&
      leftJst.getUTCDate() === rightJst.getUTCDate()
    );
  }
  

  return {
    handleKokuchi,
    publishImmediateKokuchi,
    restoreGatheringVcUnlockSchedules,
    scheduleKokuchiPreNotice,
    clearKokuchiPreNoticeTimer,
    sendKokuchiPreNotice,
    migrateKokuchiEventState,
    restorePendingGatheringVcPermissions,
    scheduleGatheringVcUnlock,
    clearGatheringVcUnlockTimer,
    scheduleKokuchiGatheringReminder,
    clearKokuchiGatheringReminderTimer,
    sendKokuchiGatheringReminder,
    applyGatheringVcUnlock,
    closeGatheringVcAfterSplit,
    clearCompletedGatheringVcEventState,
    setGatheringVcConnectPermission,
    compensateGatheringVcCloseAfterPersistenceMismatch,
    restoreGatheringVcPermissionAfterSplit,
    publishKokuchi,
    scheduleKokuchiReservation,
    clearKokuchiReservationTimers,
    handleKokuchiReservationCancel,
    completeKokuchiCancellation,
    restoreKokuchiReservations,
    getGatheringVcUnlockChannelId,
    normalizeKokuchiEventTime,
    rescheduleCurrentKokuchiEvent,
  };
}
