export function createGuildOperationsFeature(dependencies) {
  const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    CALL_WAIT_MODE_BUTTON,
    ChannelType,
    DEFAULT_SPLIT_FEEDBACK_CHANNEL_ID,
    GATHERING_VC_RESTORE_BLOCKING_STATUS_VALUES,
    KokuchiReservation,
    MessageFlags,
    OTEBO_TYPE_SCHEDULED,
    PermissionFlagsBits,
    PermissionsBitField,
    SPLIT_RANDOM_TOPIC,
    VoiceParticipantRoleGrant,
    acquireMongoLease,
    callWaitFollowupTimers,
    classifyGatheringVcRestoreBlock,
    countUniqueParticipantIds,
    createWadaiTopicId,
    deleteCallWaitMessage,
    deleteCallWaitPrompt,
    endCallWaitInterestsForRecruitment,
    formatSettings,
    formatSplitClosingThanks,
    formatSplitStartAnnouncement,
    formatWadaiList,
    fukyoThemeService,
    getCallWaitNoticeChannelId,
    getGuildSettings,
    getOteboRecruitments,
    getWadaiTopics,
    isGatheringVcRestoreBlocking,
    isVoiceChannelMonitored,
    lastTopicIdByChildChannel,
    logRecoverableError,
    normalizeCallWaitIntervalMinutes,
    normalizeGatheringVcRestoreStatus,
    normalizeKokuchiEventTime,
    normalizeKokuchiStatus,
    operationalStatusBoardService,
    oteboRecruitmentPanelService,
    parseVcDmIdList,
    parseWadaiTarget,
    processCallWaitForGuild,
    processOteboDeadline,
    profileFeature,
    profileRegistrationPanelService,
    randomTopicCooldownByChannel,
    reconcilePersistedVoiceParticipantRoleGrants,
    releaseMongoLease,
    replyInChunks,
    replyOrFollowUp,
    requestOperationalStatusRefresh,
    rescheduleCurrentKokuchiEvent,
    restoreGatheringVcPermissionAfterSplit,
    saveGuildSettingsWithCurrent,
    splitReviewFeature,
    stopVoiceMonitorSession,
    validateOteboSettings,
    vcDmService,
    voiceChannelControlService,
    voiceMonitorSessions,
  } = dependencies;

  async function isOteboRecruitmentPanelDisplayAllowed(guild, settings) {
    if (settings?.callWaitEnabled !== true) return false;
    if (!settings?.callWaitRoleId || !settings?.callWaitNoticeChannelId) return false;
    const callWaitRole = guild.roles.cache?.get(settings.callWaitRoleId)
      ?? await guild.roles.fetch(settings.callWaitRoleId).catch(() => null);
    const botMember = guild.members.me
      ?? (typeof guild.members.fetchMe === "function"
        ? await guild.members.fetchMe().catch(() => null)
        : null);
    if (
      !callWaitRole
      || callWaitRole.managed
      || callWaitRole.id === guild.id
      || callWaitRole.editable === false
      || !botMember?.permissions?.has?.(PermissionFlagsBits.ManageRoles)
    ) return false;
    const activeButton = Object.values(settings?.oteboRecruitments ?? {}).some((recruitment) => (
      recruitment
      && recruitment.type !== OTEBO_TYPE_SCHEDULED
      && ["creating", "active", "closing", "merging", "auto_cancel_processing", "success_processing", "success_notified", "cleanup_pending", "published_unconfirmed"].includes(recruitment.status)
    ));
    if (activeButton) return false;
    if (["evaluating", "role_granting", "closing"].includes(settings?.callWaitPrompt?.lifecycleState)) return false;
    if (["pending", "processing", "sent_unconfirmed", "failed"].includes(settings?.callWaitPendingNotice?.status)) return false;
    if (["creating", "active", "closing", "merging", "auto_cancel_processing", "success_processing", "success_notified", "cleanup_pending", "uncertain"].includes(settings?.oteboRecruitmentSlot?.status)) return false;
    if (["active", "scheduled", "executing"].includes(settings?.callWaitRoleGeneration?.status)) return false;
    if (Object.values(settings?.oteboVoiceStatusSessions ?? {}).some(Boolean)) return false;
    if ([...voiceMonitorSessions.values()].some((session) => session.guildId === guild.id)) return false;
    if (settings?.voiceParticipantRoleId) {
      const participantRole = guild.roles.cache?.get(settings.voiceParticipantRoleId)
        ?? await guild.roles.fetch(settings.voiceParticipantRoleId).catch(() => null);
      if ([...(participantRole?.members?.values?.() ?? [])].some((member) => !member.user?.bot)) return false;
    }
    return true;
  }
  
  async function handleProfileRegistrationPanelMessage(message) {
    if (!message.guild || message.author?.bot || message.webhookId || message.system || message.channel?.isThread?.()) return;
    const settings = await getGuildSettings(message.guild.id);
    if (settings?.profileIntroductionChannelId !== message.channelId) return;
    await profileRegistrationPanelService.requestProfileRegistrationPanelMove(message.guild, "human-message");
  }
  
  async function handleOteboRecruitmentPanelMessage(message) {
    if (!message.guild || message.author?.bot || message.webhookId || message.system || message.channel?.isThread?.()) return;
    const settings = await getGuildSettings(message.guild.id);
    if (getCallWaitNoticeChannelId(settings) !== message.channelId) return;
    await oteboRecruitmentPanelService.requestOteboRecruitmentPanelMove(message.guild, "human-message");
  }
  
  
  async function handleSetting(interaction) {
    if (!interaction.inGuild()) {
      await replyOrFollowUp(interaction, {
        content: "このコマンドはサーバー内で使ってください。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  
    if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild)) {
      await replyOrFollowUp(interaction, {
        content: "この設定を変更するには、サーバー管理権限が必要です。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  
    const subcommand = interaction.options.getSubcommand();
  
    if (subcommand === "show") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const settings = await getGuildSettings(interaction.guildId);
      await replyInChunks(interaction, formatSettings(settings), {
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      return;
    }
  
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  
    if (subcommand === "status_board") {
      const channel = interaction.options.getChannel("channel", false);
      const remove = interaction.options.getBoolean("remove", false) === true;
      if (remove && channel) {
        await interaction.editReply("解除時はchannelを指定せずremove=trueにしてください。");
        return;
      }
      if (!remove && !channel) {
        await interaction.editReply("channelを指定するか、remove=trueで既存ボードを解除してください。");
        return;
      }
      let result;
      try {
        result = remove
          ? await operationalStatusBoardService.remove(interaction.guild)
          : await operationalStatusBoardService.configure(interaction.guild, channel);
      } catch (error) {
        await interaction.editReply(`ステータスボード設定に失敗しました: ${error?.message ?? error}`);
        return;
      }
      const message = remove
        ? result.status === "removed"
          ? "ステータスボードを解除しました。"
          : result.status === "cleanup-pending"
            ? "ステータスボードの更新を停止しました。Discordメッセージの削除は再試行中です。"
            : result.status === "busy"
              ? "別のステータスボード操作が進行中です。少し待ってから再実行してください。"
              : "ステータスボードは設定されていません。"
        : result.status === "cleanup-pending"
          ? "ステータスボードを設置しました。旧メッセージの削除は再試行中です。"
          : `ステータスボードを設置しました: ${result.status}`;
      await interaction.editReply(message);
      requestOperationalStatusRefresh(interaction.guildId, "status-board-setting");
      return;
    }
  
    if (subcommand === "fukyo") {
      await fukyoThemeService.updateSetting(interaction);
      return;
    }
  
    if (subcommand === "vc_control") {
      const category = interaction.options.getChannel("category", false);
      const notifyRole = interaction.options.getRole("notify_role", false);
      const exitScheduleKeepMessage = interaction.options.getBoolean("exit_schedule_keep_message", false);
      if (!category && !notifyRole && exitScheduleKeepMessage === null) {
        await replyOrFollowUp(interaction, { content: "category、notify_role、exit_schedule_keep_message のいずれかを指定してください。", flags: MessageFlags.Ephemeral });
        return;
      }
  
      if (interaction.commandName === "show" && interaction.options.getSubcommand() === "review") {
        await splitReviewFeature.handleShowReview(interaction); return;
      }
      const settings = await saveGuildSettingsWithCurrent(interaction.guildId, await getGuildSettings(interaction.guildId), {
        ...(category ? { vcControlCategoryId: category.id } : {}),
        ...(notifyRole ? { vcControlNotifyRoleId: notifyRole.id } : {}),
        ...(exitScheduleKeepMessage === null ? {} : { voiceExitScheduleKeepMessage: exitScheduleKeepMessage }),
      });
      await replyOrFollowUp(interaction, { content: `VCコントロール設定を保存しました。\n対象カテゴリ: ${settings.vcControlCategoryId ? `<#${settings.vcControlCategoryId}>` : "未設定"}\n通知ロール: ${settings.vcControlNotifyRoleId ? `<@&${settings.vcControlNotifyRoleId}>` : "未設定"}\n退出予定通知を残す: ${settings.voiceExitScheduleKeepMessage !== false ? "はい" : "いいえ"}`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
      if (category) {
        for (const channel of interaction.guild.channels.cache.values()) if (channel.type === ChannelType.GuildVoice && channel.parentId === category.id) await voiceChannelControlService.ensurePanel(channel).catch((error) => logRecoverableError("Recoverable asynchronous operation failed", error));
      }
      return;
    }
  
    if (subcommand === "profile") {
      await profileFeature.handleProfileIntroductionSetting(interaction);
      return;
    }
  
    if (subcommand === "callwait") {
      await handleCallWaitSetting(interaction);
      return;
    }
  
    if (subcommand === "zatudan") {
      await handleShugoSetting(interaction);
      return;
    }
  
    if (subcommand === "kokuchi") {
      await handleKokuchiSetting(interaction);
      return;
    }
  
    if (subcommand === "vc_dm") {
      await handleVcDmSetting(interaction);
      return;
    }
  
    const tempRole = interaction.options.getRole("participant_role", false);
    const splitMode = interaction.options.getString("mode", false);
    const parentChannel = interaction.options.getChannel("parent_channel", false);
    const childCategory = interaction.options.getChannel("child_category", false);
    const waitingVcCategory = interaction.options.getChannel("waiting_vc_category", false,);
    const waitingVcName = interaction.options.getString("waiting_vc_name", false);
    const bosyuMentionRole = interaction.options.getRole("bosyu_mention_role", false);
    const splitFeedbackChannel = interaction.options.getChannel("split_feedback_channel", false);
    const logChannel = interaction.options.getChannel("log_channel", false);
    const formChannel = interaction.options.getChannel("form_channel", false);
    const formSendChannel = interaction.options.getChannel("form_send_channel", false);
    const reviewSendChannel = interaction.options.getChannel("review_send_channel", false);
    const formModeratorRole = interaction.options.getRole("moderator_role", false);
    const finishMessage = interaction.options.getString("finish_message", false);
    const transferWaitSeconds = interaction.options.getInteger(
      "transfer_wait_seconds",
      false,
    );
    const noticeWaitMinutes = interaction.options.getInteger(
      "notice_wait_minutes",
      false,
    );
    const roleRemoveWaitMinutes = interaction.options.getInteger(
      "role_remove_wait_minutes",
      false,
    );
    const patch = {};

    if (splitMode !== null && splitMode !== undefined) {
      patch.splitMode = splitMode;
    }
  
    if (tempRole) {
      patch.tempRoleId = tempRole.id;
    }
  
    if (parentChannel) {
      patch.parentChannelId = parentChannel.id;
    }
  
    if (childCategory) {
      patch.childCategoryId = childCategory.id;
    }
  
    if (waitingVcCategory) {
      patch.waitingVcCategoryId = waitingVcCategory.id;
    }
  
    if (waitingVcName?.trim()) {
      patch.waitingVcName = waitingVcName.trim();
    }
  
    if (bosyuMentionRole) {
      patch.bosyuMentionRoleId = bosyuMentionRole.id;
    }
  
    if (splitFeedbackChannel) {
      patch.splitFeedbackChannelId = splitFeedbackChannel.id;
    }
  
    if (logChannel) {
      patch.logChannelId = logChannel.id;
    }
  
    if (formChannel) {
      patch.formChannelId = formChannel.id;
    }
  
    if (formSendChannel) {
      patch.formSendChannelId = formSendChannel.id;
    }
  
    if (reviewSendChannel) {
      const me = interaction.guild.members.me ?? await interaction.guild.members.fetchMe();
      const permissions = reviewSendChannel.permissionsFor(me);
      if (!reviewSendChannel.isTextBased() || !permissions?.has(PermissionFlagsBits.ViewChannel) || !permissions?.has(PermissionFlagsBits.SendMessages)) {
        await interaction.editReply({ content: "感想送信先は、Botが閲覧・送信できるテキストチャンネルを指定してください。" });
        return;
      }
      patch.reviewSendChannelId = reviewSendChannel.id;
    }
  
    if (formModeratorRole) {
      patch.formModeratorRoleId = formModeratorRole.id;
    }
  
    if (finishMessage?.trim()) {
      patch.finishMessage = finishMessage.trim();
    }
  
    if (transferWaitSeconds !== null) {
      patch.transferWaitSeconds = transferWaitSeconds;
    }
  
    if (noticeWaitMinutes !== null) {
      patch.noticeWaitMinutes = noticeWaitMinutes;
    }
  
    if (roleRemoveWaitMinutes !== null) {
      patch.roleRemoveWaitMinutes = roleRemoveWaitMinutes;
    }
  
    if (Object.keys(patch).length === 0) {
      await interaction.editReply({
        content: "変更する項目を1つ以上指定してください。",
      });
      return;
    }
  
    const currentSettings = await getGuildSettings(interaction.guildId);
    const settings = await saveGuildSettingsWithCurrent(
      interaction.guildId,
      currentSettings,
      patch,
    );
    await replyOrFollowUp(interaction, {
      content: `設定を保存しました。\n\n${formatSettings(settings)}`,
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
  }
  
  async function handleRemoveRole(interaction) {
    if (!interaction.inGuild() || interaction.options.getSubcommand() !== "role") return;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageRoles)) {
      await interaction.editReply("この操作にはロールの管理権限が必要です。");
      return;
    }
  
    const guild = interaction.guild;
    const settings = await getGuildSettings(guild.id);
    const roleIds = [...new Set([settings?.tempRoleId, settings?.voiceParticipantRoleId].filter(Boolean))];
    if (roleIds.length === 0) {
      await interaction.editReply("解除対象の参加者ロールが設定されていません。");
      return;
    }
  
    const botMember = guild.members.me ?? await guild.members.fetchMe().catch(() => null);
    if (!botMember?.permissions.has(PermissionFlagsBits.ManageRoles)) {
      await interaction.editReply("Botにロールの管理権限がありません。");
      return;
    }
  
    const fetchedAllMembers = await guild.members.fetch().then(() => true).catch(() => false);
    if (!fetchedAllMembers) {
      await interaction.editReply("メンバー一覧を取得できなかったため、一括解除を実行しませんでした。時間をおいて再試行してください。");
      return;
    }
    const targetMembers = new Map();
    let skipped = 0;
    const reasons = new Set();
    const usableRoleIds = [];
    for (const roleId of roleIds) {
      const role = await guild.roles.fetch(roleId).catch(() => null);
      if (!role) {
        skipped += 1;
        reasons.add("設定済みロールが見つかりません");
        continue;
      }
      if (!role.editable) {
        skipped += 1;
        reasons.add("Botのロール階層が不足しています");
        continue;
      }
      usableRoleIds.push(role.id);
      for (const member of guild.members.cache.filter((item) => item.roles.cache.has(role.id)).values()) {
        if (member.user.bot) {
          skipped += 1;
          reasons.add("Botアカウントは対象外です");
          continue;
        }
        targetMembers.set(member.id, member);
      }
    }
    let fullySucceeded = 0;
    let partiallySucceeded = 0;
    let fullyFailed = 0;
    for (const member of targetMembers.values()) {
      let attemptedRoles = 0;
      let removedRoles = 0;
      let failedRoles = 0;
      for (const roleId of usableRoleIds) {
        if (!member.roles.cache.has(roleId)) continue;
        attemptedRoles += 1;
        const role = guild.roles.cache.get(roleId);
        try {
          await member.roles.remove(role, "一括参加者ロール解除 (/remove role)");
          const removedAt = new Date();
          await VoiceParticipantRoleGrant.updateMany(
            {
              guildId: guild.id,
              memberId: member.id,
              roleId,
              status: { $in: [null, "active", "removing", "failed"] },
            },
            {
              $set: {
                status: "removed",
                removedAt,
                cleanupAt: new Date(removedAt.getTime() + 30 * 24 * 60 * 60 * 1000),
              },
            },
          );
          removedRoles += 1;
        } catch (error) {
          failedRoles += 1;
          reasons.add(error?.code === 50013 ? "権限またはロール階層が不足しています" : "一部メンバーの解除に失敗しました");
        }
      }
      if (attemptedRoles > 0 && removedRoles === attemptedRoles) fullySucceeded += 1;
      else if (removedRoles > 0 && failedRoles > 0) partiallySucceeded += 1;
      else fullyFailed += 1;
    }
    const restoreSettings = await getGuildSettings(guild.id).catch(() => settings);
    const restoreEventId = restoreSettings?.gatheringVcStateEventId ?? restoreSettings?.kokuchiEventId ?? null;
    const restoreEvent = restoreEventId
      ? await KokuchiReservation.findOne({ guildId: guild.id, reservationId: restoreEventId }).lean().catch(() => null)
      : null;
    const restoreStatus = normalizeGatheringVcRestoreStatus(restoreEvent ?? {});
    const permissionRestored = restoreEvent && (
      restoreEvent.gatheringVcUnlockState === "opened"
      || restoreEvent.gatheringVcPermissionBeforeOpen
      || isGatheringVcRestoreBlocking(restoreStatus)
    )
      ? await restoreGatheringVcPermissionAfterSplit(guild, restoreSettings, { eventId: restoreEventId, force: true }).catch(() => false)
      : null;
    await interaction.editReply([
      `完全成功: ${fullySucceeded}人`,
      `一部成功: ${partiallySucceeded}人`,
      `完全失敗: ${fullyFailed}人`,
      "参加者ロールを一括解除しました。",
      `対象ロール: ${roleIds.length}件`,
      `対象メンバー: ${targetMembers.size}人`,
      `スキップ: ${skipped}件`,
      ...(permissionRestored === null ? [] : [`集合VC権限復元: ${permissionRestored ? "成功" : "失敗"}`]),
      ...(reasons.size ? [`理由: ${[...reasons].join("、")}`] : []),
    ].join("\n"));
    await sendOperationalLog({
      guild,
      settings,
      fallbackChannel: interaction.channel,
      content: `/remove role を実行しました。対象 ${targetMembers.size} 人、完全成功 ${fullySucceeded} 人、一部成功 ${partiallySucceeded} 人、完全失敗 ${fullyFailed} 人、スキップ ${skipped} 件。理由: ${[...reasons].join("、") || "なし"}`,
    }).catch((error) => logRecoverableError("Failed to log bulk role removal", error));
  }
  
  async function runOperationalParticipantRoleRemoval(guild) {
    const lease = await acquireMongoLease(`participant-role-cleanup:${guild.id}`, { leaseMs: 5 * 60 * 1000 });
    if (!lease) return { status: "busy", result: "failed", errors: ["Participant role cleanup is already running."] };
    try {
      const settings = await getGuildSettings(guild.id);
      const roleIds = [...new Set([settings?.tempRoleId, settings?.voiceParticipantRoleId].filter(Boolean))];
      if (!roleIds.length) return { status: "not-needed", result: "success", errors: [] };
      const botMember = guild.members.me ?? await guild.members.fetchMe().catch(() => null);
      if (!botMember?.permissions?.has(PermissionFlagsBits.ManageRoles)) return { status: "failed", result: "failed", errors: ["Bot lacks ManageRoles permission."] };
      const roles = new Map();
      const errors = [];
      for (const roleId of roleIds) {
        const role = await guild.roles.fetch(roleId).catch(() => null);
        if (!role || !role.editable) errors.push(`Role ${roleId} is missing or not editable.`);
        else roles.set(roleId, role);
      }
      let grantsQuery = VoiceParticipantRoleGrant.find({
        guildId: guild.id,
        roleId: { $in: [...roles.keys()] },
        grantedByBot: true,
        status: { $in: ["active", "removing", "failed"] },
      });
      const grants = typeof grantsQuery.lean === "function" ? await grantsQuery.lean() : await grantsQuery;
      let removed = 0;
      let skipped = 0;
      let failed = errors.length;
      for (const grant of grants ?? []) {
        const role = roles.get(grant.roleId);
        if (!role) continue;
        const member = await guild.members.fetch(grant.memberId).catch(() => null);
        if (!member || member.user?.bot) {
          skipped += 1;
          continue;
        }
        const grantFilter = grant._id
          ? { _id: grant._id, guildId: guild.id, grantedByBot: true }
          : { guildId: guild.id, memberId: grant.memberId, roleId: grant.roleId, sourceType: grant.sourceType, sourceId: grant.sourceId, grantedByBot: true };
        try {
          if (!member.roles.cache.has(role.id)) {
            await VoiceParticipantRoleGrant.updateOne(grantFilter, { $set: { status: "removed", removedAt: new Date(), cleanupAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), lastError: null } });
            removed += 1;
            continue;
          }
          await VoiceParticipantRoleGrant.updateOne(grantFilter, { $set: { status: "removing", lastError: null } });
          await member.roles.remove(role, "Operational status board role cleanup");
          await VoiceParticipantRoleGrant.updateOne(grantFilter, { $set: { status: "removed", removedAt: new Date(), cleanupAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), lastError: null } });
          removed += 1;
        } catch (error) {
          failed += 1;
          errors.push(`${grant.memberId}/${grant.roleId}: ${error?.message ?? error}`);
          await VoiceParticipantRoleGrant.updateOne(grantFilter, { $set: { status: "failed", lastError: String(error?.message ?? error).slice(0, 1000) } }).catch(() => {});
        }
      }
      const status = failed ? (removed ? "partial" : "failed") : "completed";
      return { status, result: failed ? (removed ? "partial" : "failed") : "success", removed, skipped, failed, errors };
    } finally {
      await releaseMongoLease(lease).catch((error) => logRecoverableError("Failed to release participant role cleanup lease", error));
    }
  }
  
  async function reinstallOperationalPanels(guild) {
    const settings = await getGuildSettings(guild.id);
    let profile = null;
    let otebo = null;
    let voice = 0;
    const errors = [];
    if (settings?.profileIntroductionChannelId) {
      profile = await profileRegistrationPanelService.ensureProfileRegistrationPanel(guild).catch((error) => { errors.push(`profile: ${error.message}`); return null; });
    }
    if (getCallWaitNoticeChannelId(settings)) {
      otebo = await oteboRecruitmentPanelService.ensureOteboRecruitmentPanel(guild).catch((error) => { errors.push(`otebo:${error.message}`); return null; });
    }
    if (settings?.vcControlCategoryId) {
      const category = await guild.channels.fetch(settings.vcControlCategoryId).catch(() => null);
      for (const channel of guild.channels.cache.values()) {
        if (channel.type !== ChannelType.GuildVoice || channel.parentId !== category?.id) continue;
        await voiceChannelControlService.ensurePanel(channel).then(() => { voice += 1; }).catch((error) => errors.push(`voice:${channel.id}: ${error.message}`));
      }
    }
    return { status: errors.length ? (profile || otebo || voice ? "partial" : "failed") : "completed", result: errors.length ? (profile || otebo || voice ? "partial" : "failed") : "success", profile: Boolean(profile), otebo: Boolean(otebo), voice, errors };
  }
  
  async function closeExpiredOperationalRecruitments(guild) {
    const settings = await getGuildSettings(guild.id);
    const now = Date.now();
    const expiredPrompt = settings?.callWaitPrompt
      && new Date(settings.callWaitPrompt.targetAt).getTime() <= now
      && ["active", "open", "pending", "processing", "evaluating", "role_granting", "failed"].includes(settings.callWaitPrompt.lifecycleState ?? "active");
    const expiredOtebo = Object.values(getOteboRecruitments(settings)).filter((recruitment) => (
      recruitment
      && new Date(recruitment.targetAt).getTime() <= now
      && recruitment.status === "active"
    ));
    const results = [];
    const errors = [];
    try {
      if (expiredPrompt) {
        await processCallWaitForGuild(guild, settings);
        results.push(`call-wait:${settings.callWaitPrompt.messageId}`);
      }
      for (const recruitment of expiredOtebo) {
        try {
          const result = await processOteboDeadline(guild.id, recruitment.id);
          if (result?.status === "busy") {
            errors.push(`otebo:${recruitment.id}: deadline processing is already running`);
          } else {
            results.push(`otebo:${recruitment.id}`);
          }
        } catch (error) {
          errors.push(`otebo:${recruitment.id}: ${error?.message ?? error}`);
        }
      }
      return {
        status: errors.length ? (results.length ? "partial" : "failed") : "completed",
        result: errors.length ? (results.length ? "partial" : "failed") : "success",
        processed: results,
        errors,
      };
    } catch (error) {
      return { status: "failed", result: "failed", errors: [error?.message ?? String(error)] };
    }
  }
  
  async function handleKokuchiSetting(interaction) {
    const channel = interaction.options.getChannel("announcement_channel", false);
    const overviewChannel = interaction.options.getChannel("overview_channel", false);
    const gatheringVoiceChannel = interaction.options.getChannel("gathering_voice_channel", false);
    const eventTime = interaction.options.getString("event_time", false);
    const mentionRole = interaction.options.getRole("mention_role", false);
    const removeMentionRole = interaction.options.getRole("remove_mention_role", false);
    const parsedEventTime = eventTime === null ? null : normalizeKokuchiEventTime(eventTime);
  
    if (eventTime !== null && !parsedEventTime) {
      await replyOrFollowUp(interaction, { content: "開催予定時刻は HH:mm（00:00〜23:59）で指定してください。", flags: MessageFlags.Ephemeral });
      return;
    }
  
    if (!channel && !overviewChannel && !gatheringVoiceChannel && !parsedEventTime && !mentionRole && !removeMentionRole) {
      await replyOrFollowUp(interaction, { content: "変更する告知設定を1つ以上指定してください。", flags: MessageFlags.Ephemeral });
      return;
    }
  
    const current = await getGuildSettings(interaction.guildId);
    if (mentionRole) {
      const botMember = interaction.guild.members.me ?? await interaction.guild.members.fetchMe().catch(() => null);
      if (!mentionRole.mentionable && !botMember?.permissions.has(PermissionFlagsBits.MentionEveryone)) {
        await replyOrFollowUp(interaction, {
          content: "そのロールはメンション不可で、Botにロールメンション権限もありません。ロールをメンション可能にするか、Botへ「@everyone、@here、すべてのロールにメンション」権限を付与してください。",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
    }
    const roleIds = new Set(Array.isArray(current?.kokuchiMentionRoleIds)
      ? current.kokuchiMentionRoleIds
      : (Array.isArray(current?.kokuchiGatheringReminderRoleIds) ? current.kokuchiGatheringReminderRoleIds : []));
    if (mentionRole) roleIds.add(mentionRole.id);
    if (removeMentionRole) roleIds.delete(removeMentionRole.id);
  
    const settings = await saveGuildSettingsWithCurrent(interaction.guildId, current, {
      ...(channel ? { kokuchiAnnouncementChannelId: channel.id, wadaiChannelId: channel.id, splitStartChannelId: channel.id } : {}),
      ...(overviewChannel ? { kokuchiOverviewChannelId: overviewChannel.id } : {}),
      ...(gatheringVoiceChannel ? { gatheringVoiceChannelId: gatheringVoiceChannel.id } : {}),
      ...(parsedEventTime ? { kokuchiEventTime: parsedEventTime } : {}),
      ...(mentionRole || removeMentionRole ? { kokuchiMentionRoleIds: [...roleIds] } : {}),
    });
    const rescheduled = await rescheduleCurrentKokuchiEvent(interaction.guild, current, settings);
    await vcDmService.onSettingsChanged(interaction.guild).catch((error) => logRecoverableError("VC DM kokuchi-setting follow-up failed", error));
    await replyOrFollowUp(interaction, {
      content: `設定を保存しました。${rescheduled ? " 未実行の告知後続処理を再計算しました。" : ""}\n\n${formatSettings(settings)}`,
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
  }
  
  async function handleVcDmSetting(interaction) {
    const enabled = interaction.options.getBoolean("enabled", false);
    const panelChannel = interaction.options.getChannel("panel_channel", false);
    const targetCategory = interaction.options.getChannel("target_category", false);
    const targetChannelsText = interaction.options.getString("target_channels", false);
    const excludedChannelsText = interaction.options.getString("excluded_channels", false);
    if (enabled === null && !panelChannel && !targetCategory && targetChannelsText === null && excludedChannelsText === null) {
      await replyOrFollowUp(interaction, { content: "enabled、panel_channel、target_category、target_channels、excluded_channels のいずれかを指定してください。", flags: MessageFlags.Ephemeral });
      return;
    }
  
    const parseIds = (value) => {
      if (value === null) return null;
      const raw = value.split(/[\s,、]+/).map((item) => item.trim()).filter(Boolean);
      const invalid = raw.filter((item) => !/^\d{5,25}$/.test(item));
      return invalid.length ? { invalid } : { ids: parseVcDmIdList(value) };
    };
    const targetChannels = parseIds(targetChannelsText);
    const excludedChannels = parseIds(excludedChannelsText);
    if (targetChannels?.invalid?.length || excludedChannels?.invalid?.length) {
      await replyOrFollowUp(interaction, { content: "VCチャンネルIDはDiscordの数値IDをカンマ区切りで指定してください。", flags: MessageFlags.Ephemeral });
      return;
    }
    if (targetCategory && targetChannelsText !== null) {
      await replyOrFollowUp(interaction, { content: "対象カテゴリ指定と対象VC個別指定は、どちらか一方を指定してください。", flags: MessageFlags.Ephemeral });
      return;
    }
  
    if (panelChannel) {
      const botMember = interaction.guild.members.me ?? await interaction.guild.members.fetchMe().catch(() => null);
      const permissions = panelChannel.permissionsFor?.(botMember);
      if (!panelChannel.isTextBased?.() || !permissions?.has(PermissionFlagsBits.ViewChannel) || !permissions?.has(PermissionFlagsBits.SendMessages) || !permissions?.has(PermissionFlagsBits.ReadMessageHistory)) {
        await replyOrFollowUp(interaction, { content: "対象確認パネルのチャンネルは、Botが閲覧・メッセージ送信・履歴閲覧できるチャンネルを指定してください。", flags: MessageFlags.Ephemeral });
        return;
      }
    }
  
    const current = await getGuildSettings(interaction.guildId);
    const patch = {
      ...(enabled === null ? {} : { vcDmEnabled: enabled }),
      ...(panelChannel ? { vcDmPanelChannelId: panelChannel.id } : {}),
      ...(targetCategory ? { vcDmTargetCategoryId: targetCategory.id, vcDmTargetChannelIds: [] } : {}),
      ...(!targetCategory && targetChannels ? { vcDmTargetCategoryId: null, vcDmTargetChannelIds: targetChannels.ids } : {}),
      ...(excludedChannels ? { vcDmExcludedChannelIds: excludedChannels.ids } : {}),
    };
    const settings = await saveGuildSettingsWithCurrent(interaction.guildId, current, patch);
    await vcDmService.onSettingsChanged(interaction.guild).catch((error) => logRecoverableError("VC DM setting follow-up failed", error));
    const status = settings.vcDmEnabled === true
      ? (settings.vcDmPanelChannelId
        && (settings.vcDmTargetCategoryId || settings.vcDmTargetChannelIds?.length)
        && settings.kokuchiEventTimeConfigured !== false
        ? "有効"
        : "有効（パネル・対象VC・kokuchi event_time の追加設定が必要です）")
      : "無効";
    await replyOrFollowUp(interaction, {
      content: `VC未参加者・長期不参加者向けDM機能を${status}に設定しました。\n\n対象確認パネル: ${settings.vcDmPanelChannelId ? `<#${settings.vcDmPanelChannelId}>` : "未設定"}\n対象VCカテゴリ: ${settings.vcDmTargetCategoryId ? `<#${settings.vcDmTargetCategoryId}>` : "未設定"}\n対象VC個別指定: ${settings.vcDmTargetChannelIds?.length ? settings.vcDmTargetChannelIds.map((id) => `<#${id}>`).join(" ") : "未設定"}\n対象外VC: ${settings.vcDmExcludedChannelIds?.length ? settings.vcDmExcludedChannelIds.map((id) => `<#${id}>`).join(" ") : "なし"}\n\n${formatSettings(settings)}`,
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
  }
  
  async function handleCallWaitSetting(interaction) {
    const callWaitEnabled = interaction.options.getBoolean("call_wait_enabled", false);
    const callWaitRole = interaction.options.getRole("call_wait_role", false);
    const bosyuMentionRole = interaction.options.getRole("bosyu_mention_role", false);
    const callWaitPromptChannel = interaction.options.getChannel(
      "call_wait_prompt_channel",
      false,
    );
    const callWaitNoticeChannel = interaction.options.getChannel(
      "call_wait_notice_channel",
      false,
    );
    const callWaitVoiceCategory = interaction.options.getChannel(
      "call_wait_voice_category",
      false,
    );
    const callWaitIntervalMinutes = interaction.options.getInteger("call_wait_interval_minutes", false);
    const oteboQuickConfirmSeconds = interaction.options.getInteger(
      "otebo_quick_confirm_seconds",
      false,
    );
    const patch = {};
  
    if (callWaitEnabled !== null) {
      patch.callWaitEnabled = callWaitEnabled;
    }
  
    if (callWaitRole) {
      patch.callWaitRoleId = callWaitRole.id;
    }
  
    if (bosyuMentionRole) {
      patch.bosyuMentionRoleId = bosyuMentionRole.id;
    }
  
    if (callWaitPromptChannel) {
      patch.callWaitPromptChannelId = callWaitPromptChannel.id;
    }
  
    if (callWaitNoticeChannel) {
      patch.callWaitNoticeChannelId = callWaitNoticeChannel.id;
    }
  
    if (callWaitVoiceCategory) {
      patch.callWaitVoiceCategoryId = callWaitVoiceCategory.id;
    }
  
    patch.callWaitMode = CALL_WAIT_MODE_BUTTON;
  
    if (callWaitIntervalMinutes !== null) {
      patch.callWaitIntervalMinutes = normalizeCallWaitIntervalMinutes(callWaitIntervalMinutes);
    }
  
  
    if (oteboQuickConfirmSeconds !== null) {
      patch.oteboQuickConfirmSeconds = oteboQuickConfirmSeconds;
    }
  
    if (Object.keys(patch).length === 0) {
      await replyOrFollowUp(interaction, {
        content: "変更する通話待機システム設定を1つ以上指定してください。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  
    const currentSettings = await getGuildSettings(interaction.guildId);
    const prospectiveSettings = { ...currentSettings, ...patch };
    if (
      callWaitEnabled === true
      || ((callWaitNoticeChannel || callWaitRole || bosyuMentionRole)
        && prospectiveSettings.callWaitRoleId
        && getCallWaitNoticeChannelId(prospectiveSettings))
    ) {
      const validation = await validateOteboSettings(interaction.guild, prospectiveSettings, { mentionBosyu: false });
      if (!validation.ok) {
        await replyOrFollowUp(interaction, { content: validation.reason, flags: MessageFlags.Ephemeral });
        return;
      }
    }
    let settings = await saveGuildSettingsWithCurrent(
      interaction.guildId,
      currentSettings,
      patch,
    );
  
    if (
      currentSettings?.callWaitPrompt &&
      (callWaitEnabled === false ||
        callWaitPromptChannel)
    ) {
      await endCallWaitInterestsForRecruitment(interaction.guildId, currentSettings.callWaitPrompt.messageId);
      await deleteCallWaitPrompt(interaction.guild, currentSettings.callWaitPrompt);
      settings = await saveGuildSettingsWithCurrent(interaction.guildId, settings, {
        callWaitPrompt: null,
      });
    }
  
    if (
      currentSettings?.callWaitSkippedNotice &&
      (callWaitEnabled === false || callWaitPromptChannel)
    ) {
      await deleteCallWaitMessage(interaction.guild, currentSettings.callWaitSkippedNotice);
      settings = await saveGuildSettingsWithCurrent(interaction.guildId, settings, {
        callWaitSkippedNotice: null,
      });
    }
  
    if (callWaitEnabled === false) {
      const actionPrefix = `callwait-followup:${interaction.guildId}:`;
      for (const [actionKey, followupTimer] of callWaitFollowupTimers.entries()) {
        if (actionKey.startsWith(actionPrefix)) {
          clearTimeout(followupTimer);
          callWaitFollowupTimers.delete(actionKey);
        }
      }
  
      settings = await saveGuildSettingsWithCurrent(interaction.guildId, settings, {
        callWaitPendingNotice: null,
      });
    }
  
    await oteboRecruitmentPanelService.ensureOteboRecruitmentPanel(interaction.guild).catch((error) => {
      logRecoverableError("Otebo recruitment panel ensure after call-wait setting change failed", error);
    });
  
    await replyOrFollowUp(interaction, {
      content: `通話待機システム設定を保存しました。\n\n${formatSettings(settings)}`,
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
  }
  
  async function handleShugoSetting(interaction) {
    const voiceParticipantRole = interaction.options.getRole("voice_participant_role", false);
    const voiceReminderEnabled = interaction.options.getBoolean("voice_reminder_enabled", false);
    const voiceReminderParentChannel = interaction.options.getChannel(
      "voice_reminder_parent_channel",
      false,
    );
    const voiceReminderParentChannels = [
      voiceReminderParentChannel,
      interaction.options.getChannel("voice_reminder_parent_channel_2", false),
      interaction.options.getChannel("voice_reminder_parent_channel_3", false),
      interaction.options.getChannel("voice_reminder_parent_channel_4", false),
      interaction.options.getChannel("voice_reminder_parent_channel_5", false),
    ].filter(Boolean);
    const voiceReminderChildCategory = interaction.options.getChannel(
      "voice_reminder_child_category",
      false,
    );
    const patch = {};
  
    if (voiceParticipantRole) {
      const roleValidationError = await validateVoiceParticipantRole(interaction.guild, voiceParticipantRole);
      if (roleValidationError) {
        await replyOrFollowUp(interaction, { content: roleValidationError, flags: MessageFlags.Ephemeral });
        return;
      }
      patch.voiceParticipantRoleId = voiceParticipantRole.id;
    }
  
    if (voiceReminderEnabled !== null) {
      patch.voiceReminderEnabled = voiceReminderEnabled;
    }
  
    if (voiceReminderParentChannels.length > 0) {
      const parentChannelIds = [...new Set(voiceReminderParentChannels.map((channel) => channel.id))];
      patch.voiceReminderParentChannelIds = parentChannelIds;
      patch.voiceReminderParentChannelId = parentChannelIds[0];
    }
  
    if (voiceReminderChildCategory) {
      patch.voiceReminderChildCategoryId = voiceReminderChildCategory.id;
    }
  
    if (Object.keys(patch).length === 0) {
      await replyOrFollowUp(interaction, {
        content: "変更するVC集合フォーム設定を1つ以上指定してください。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  
    const currentSettings = await getGuildSettings(interaction.guildId);
    const settings = await saveGuildSettingsWithCurrent(
      interaction.guildId,
      currentSettings,
      patch,
    );
    const roleChangedWithActiveSession = Boolean(
      voiceParticipantRole
        && currentSettings?.voiceParticipantRoleId
        && currentSettings.voiceParticipantRoleId !== voiceParticipantRole.id
        && [...voiceMonitorSessions.values()].some((session) => session.guildId === interaction.guildId),
    );
  
    const sessions = [...voiceMonitorSessions.values()]
      .filter((session) => session.guildId === interaction.guildId);
    for (const session of sessions) {
      const shouldKeepSession = settings.voiceReminderEnabled !== false
        && await isVoiceChannelMonitored(interaction.guild, settings, session.voiceChannelId);
      if (shouldKeepSession) continue;
      const voiceChannel = await interaction.guild.channels.fetch(session.voiceChannelId).catch(() => null);
      await stopVoiceMonitorSession(session, interaction.guild, voiceChannel, settings).catch((error) => {
        logRecoverableError("Failed to clean up invalid voice monitor session", error);
      });
    }
  
    if (patch.voiceReminderEnabled === false) {
      await reconcilePersistedVoiceParticipantRoleGrants(interaction.guild, settings).catch((error) => {
        logRecoverableError("Failed to reconcile disabled voice monitor grants", error);
      });
    }
  
    await replyOrFollowUp(interaction, {
      content: `VC集合フォーム設定を保存しました。\n\n${formatSettings(settings)}${roleChangedWithActiveSession ? "\n\n現在進行中の雑談VCセッションでは、セッション開始時の旧ロールが終了まで使用されます。新しいロールは新規セッションから使用されます。" : ""}`,
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
  }
  
  async function validateVoiceParticipantRole(guild, role) {
    const botMember = guild?.members?.me ?? (guild?.members?.fetchMe
      ? await guild.members.fetchMe().catch(() => null)
      : null);
    if (!botMember?.permissions?.has(PermissionFlagsBits.ManageRoles)) {
      return "Botにロールの管理権限がありません。";
    }
    if (!role || role.id === guild.id || role.managed || !role.editable) {
      return "@everyone、連携管理ロール、またはBotより上位のロールは参加者ロールに設定できません。";
    }
    return null;
  }
  
  async function handleAddWadai(interaction) {
    if (!interaction.inGuild()) {
      await replyOrFollowUp(interaction, {
        content: "このコマンドはサーバー内で使ってください。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  
    if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild)) {
      await replyOrFollowUp(interaction, {
        content: "話題を追加するには、サーバー管理権限が必要です。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  
    const category = "1";
    const content = interaction.options.getString("content", true).trim();
  
    if (!content) {
      await replyOrFollowUp(interaction, {
        content: "追加する話題の内容を入力してください。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  
    const settings = await getGuildSettings(interaction.guildId);
    const topics = getWadaiTopics(settings);
    const nextTopic = {
      id: createWadaiTopicId(category),
      text: content,
    };
  
    topics[category].push(nextTopic);
    await saveGuildSettingsWithCurrent(interaction.guildId, settings, {
      wadaiTopics: topics,
      wadaiTopicsVersion: 2,
      wadaiDaily: null,
    });
  
    await replyOrFollowUp(interaction, {
      content: `話題を追加しました。\n${topics[category].length}. ${content}`,
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
  }
  
  async function handleShowWadai(interaction) {
    if (!interaction.inGuild()) {
      await replyOrFollowUp(interaction, {
        content: "このコマンドはサーバー内で使ってください。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  
    const settings = await getGuildSettings(interaction.guildId);
    await replyInChunks(interaction, formatWadaiList(getWadaiTopics(settings)), {
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
  }
  
  async function handleDelWadai(interaction) {
    if (!interaction.inGuild()) {
      await replyOrFollowUp(interaction, {
        content: "このコマンドはサーバー内で使ってください。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  
    if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild)) {
      await replyOrFollowUp(interaction, {
        content: "話題を削除するには、サーバー管理権限が必要です。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  
    const target = interaction.options.getString("target", true).trim();
    const parsed = parseWadaiTarget(target);
  
    if (!parsed) {
      await replyOrFollowUp(interaction, {
        content: "削除対象は `/showwadai` の番号で指定してください。例: `2`",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  
    const settings = await getGuildSettings(interaction.guildId);
    const topics = getWadaiTopics(settings);
    const categoryTopics = topics[parsed.category];
    const deleteIndex = parsed.index - 1;
  
    if (!categoryTopics[deleteIndex]) {
      await replyOrFollowUp(interaction, {
        content: `${parsed.index} 番目の話題はありません。`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  
    const [deleted] = categoryTopics.splice(deleteIndex, 1);
    await saveGuildSettingsWithCurrent(interaction.guildId, settings, {
      wadaiTopics: topics,
      wadaiTopicsVersion: 2,
      wadaiDaily: null,
    });
  
    await replyOrFollowUp(interaction, {
      content: `話題を削除しました。\n${deleted.text}`,
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
  }
  
  async function sendSplitRandomTopicPanels({ guild, settings, childChannelIds }) {
    for (const childChannelId of childChannelIds) {
      try {
        const childChannel = await guild.channels.fetch(childChannelId);
        if (!childChannel || typeof childChannel.send !== "function") {
          throw new Error("Child voice channel cannot send text messages.");
        }
  
        await childChannel.send({
          content: "下のボタンを押したらランダムに話題が出ます！\n話題に詰まった時などに使ってみてください！",
          components: [
            new ActionRowBuilder().addComponents(
              new ButtonBuilder()
                .setCustomId(`${SPLIT_RANDOM_TOPIC}:${childChannel.id}`)
                .setLabel("ランダムな話題を送信")
                .setStyle(ButtonStyle.Primary),
            ),
          ],
          allowedMentions: { parse: [] },
        });
      } catch (error) {
        console.error(`Failed to send split random topic panel for ${childChannelId}:`, error);
        await sendOperationalLog({
          guild,
          settings,
          fallbackChannel: null,
          content: `子VC話題ボタンの送信に失敗しました。 childChannelId=${childChannelId} error=${error?.message ?? error}`,
        }).catch((logError) => console.error("Failed to log split random topic panel error:", logError));
      }
    }
  }
  
  async function handleSplitRandomTopicButton(interaction) {
    const [, childChannelId] = interaction.customId.split(":");
    const memberVoiceChannelId = interaction.member?.voice?.channelId;
  
    if (!childChannelId || memberVoiceChannelId !== childChannelId) {
      await interaction.reply({
        content: "このボタンは対象のVCに参加している間だけ使用できます。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  
    const cooldownUntil = randomTopicCooldownByChannel.get(childChannelId) ?? 0;
    if (cooldownUntil > Date.now()) {
      await interaction.reply({
        content: "少し待ってからもう一度お試しください。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  
    const settings = await getGuildSettings(interaction.guildId).catch((error) => {
      console.error("Failed to load settings for split random topic:", error);
      return null;
    });
    const topicList = getWadaiTopics(settings)["1"] ?? [];
    if (topicList.length === 0) {
      await interaction.reply({
        content: "現在、使用できる話題が登録されていません。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  
    const previousTopicId = lastTopicIdByChildChannel.get(childChannelId);
    const candidates = topicList.length > 1
      ? topicList.filter((topic) => topic.id !== previousTopicId)
      : topicList;
    const topic = candidates[Math.floor(Math.random() * candidates.length)];
  
    randomTopicCooldownByChannel.set(childChannelId, Date.now() + 10_000);
    await interaction.deferUpdate();
    try {
      const childChannel = await interaction.guild.channels.fetch(childChannelId);
      if (!childChannel || typeof childChannel.send !== "function") {
        throw new Error("Target child voice channel is unavailable.");
      }
      await childChannel.send({
        content: `話題：${topic.text}`,
        allowedMentions: { parse: [] },
      });
      lastTopicIdByChildChannel.set(childChannelId, topic.id);
    } catch (error) {
      randomTopicCooldownByChannel.delete(childChannelId);
      console.error(`Failed to send split random topic for ${childChannelId}:`, error);
      await interaction.followUp({
        content: "話題の送信に失敗しました。時間をおいてもう一度お試しください。",
        flags: MessageFlags.Ephemeral,
      });
    }
  }
  
  async function sendSplitStartAnnouncement({ guild, settings, waitingChannel }) {
    const channelId = getKokuchiAnnouncementChannelId(settings);
    const sendChannel = channelId
      ? await resolveConfiguredTextChannel(guild, channelId)
      : null;
  
    if (!sendChannel) {
      return null;
    }
  
    return sendChannel.send({
      content: formatSplitStartAnnouncement(waitingChannel),
      allowedMentions: { parse: [] },
    }).catch(() => null);
  }
  
  async function sendSplitClosingThanks(guild, settings, participantMemberIds = []) {
    const channelId = getKokuchiAnnouncementChannelId(settings);
  
    if (!channelId) {
      return null;
    }
  
    const sendChannel = await resolveConfiguredTextChannel(
      guild,
      channelId,
    );
  
    if (!sendChannel) {
      return null;
    }
  
    return sendChannel.send({
      content: formatSplitClosingThanksMessage(settings, participantMemberIds),
      allowedMentions: { parse: [] },
    }).catch((error) => {
      console.error(`Failed to send split closing thanks: ${error.message}`);
      return null;
    });
  }
  
  function formatSplitClosingThanksMessage(settings, participantMemberIds) {
    const feedbackChannelId =
      settings?.splitFeedbackChannelId ?? DEFAULT_SPLIT_FEEDBACK_CHANNEL_ID;
    const nextWeekday = settings?.lastKokuchiWeekday === "火" ? "土曜日" : "火曜日";
  
    return formatSplitClosingThanks({
      feedbackChannelId,
      nextWeekday,
      participantCount: countUniqueParticipantIds(participantMemberIds),
    });
  }
  
  function getKokuchiAnnouncementChannelId(settings) {
    return settings?.kokuchiAnnouncementChannelId ?? settings?.wadaiChannelId ?? settings?.splitStartChannelId ?? null;
  }
  
  function getKokuchiOverviewChannelId(settings) {
    return settings?.kokuchiOverviewChannelId ?? null;
  }
  
  async function resolveWadaiSendChannel(guild, settings, fallbackChannel) {
    const textTypes = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
    const channelId = getKokuchiAnnouncementChannelId(settings);
  
    if (channelId) {
      const configured = await guild.channels.fetch(channelId).catch(() => null);
  
      if (
        configured &&
        textTypes.includes(configured.type) &&
        typeof configured.send === "function"
      ) {
        return configured;
      }
    }
  
    return fallbackChannel && typeof fallbackChannel.send === "function"
      ? fallbackChannel
      : null;
  }
  
  async function resolveConfiguredTextChannel(guild, channelId) {
    if (!channelId) {
      return null;
    }
  
    const textTypes = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
    const channel = await guild.channels.fetch(channelId).catch(() => null);
  
    return channel &&
      textTypes.includes(channel.type) &&
      typeof channel.send === "function"
      ? channel
      : null;
  }
  
  async function sendOperationalLog({
    guild,
    settings,
    fallbackChannel,
    content,
    allowedMentions = { parse: [] },
  }) {
    const logChannel = settings?.logChannelId
      ? await resolveConfiguredTextChannel(guild, settings.logChannelId)
      : null;
    const channel =
      logChannel ??
      (fallbackChannel && typeof fallbackChannel.send === "function"
        ? fallbackChannel
        : null);
  
    if (!channel) {
      if (settings?.logChannelId) {
        console.error(`Operational log channel could not be resolved for guild ${guild?.id ?? "unknown"}.`);
      }
      return null;
    }
  
    return channel.send({
      content,
      allowedMentions,
    }).catch((error) => {
      console.error(`Operational log send failed for guild ${guild?.id ?? "unknown"}: ${error?.name ?? "unknown error"}`);
      return null;
    });
  }
  
  async function sendSplitGroupingLog({ guild, settings, content }) {
    return sendOperationalLog({
      guild,
      settings,
      fallbackChannel: null,
      content,
    });
  }
  
  function hasActiveKokuchiEvent(settings) {
    if (settings?.kokuchiEventId) {
      return settings?.gatheringVcRestorePending === true;
    }
    return [
      ["pending", "failed"].includes(settings?.kokuchiPreNoticeState),
      ["pending", "failed", "processing", "opened"].includes(settings?.gatheringVcUnlockState),
      ["pending", "failed"].includes(settings?.kokuchiGatheringReminderState),
      settings?.gatheringVcRestorePending === true,
    ].some(Boolean);
  }
  
  async function getKokuchiExecutionBlockReason(guildId, settings) {
    const currentEvent = settings?.kokuchiEventId
      ? await KokuchiReservation.findOne({ guildId, reservationId: settings.kokuchiEventId }).lean()
      : null;
    const pendingRestoreEvents = await KokuchiReservation.find({
      guildId,
      $or: [
        { gatheringVcRestorePending: true },
        { gatheringVcRestoreStatus: { $in: GATHERING_VC_RESTORE_BLOCKING_STATUS_VALUES } },
      ],
    }).sort({ updatedAt: -1 }).lean();
    const currentRestoreStatus = normalizeGatheringVcRestoreStatus(currentEvent ?? {});
    const settingsRestoreStatus = normalizeGatheringVcRestoreStatus(settings ?? {});
    const restoreEvent = currentEvent
      && (currentEvent.gatheringVcRestorePending === true || isGatheringVcRestoreBlocking(currentRestoreStatus))
      ? currentEvent
      : pendingRestoreEvents.find((event) => event.reservationId === settings?.kokuchiEventId)
        ?? pendingRestoreEvents[0]
        ?? null;
    const restoreBlock = classifyGatheringVcRestoreBlock({
      eventId: settings?.kokuchiEventId,
      event: restoreEvent,
      settings,
    });
    if (restoreBlock) return restoreBlock;
    if (settings?.kokuchiEventId && !currentEvent && hasActiveKokuchiEvent({ ...settings, kokuchiEventId: null })) {
      return {
        code: "orphaned_event",
        severity: "error",
        message: "現在の告知イベント記録が見つからないため、新しいkokuchiを開始できません。管理者の確認が必要です。",
      };
    }
    if (settings?.gatheringVcRestorePending && !restoreEvent) {
      return {
        code: "orphaned_restore_state",
        severity: "error",
        message: "集合VCの復元状態が孤立しているため、管理者の確認が必要です。",
      };
    }
    if (isGatheringVcRestoreBlocking(settingsRestoreStatus) && !restoreEvent) {
      return {
        code: "orphaned_restore_state",
        severity: "error",
        message: "集合VCの復元状態だけが残っており、対象kokuchiイベントを特定できません。管理者による状態確認が必要です。",
      };
    }
    if (!settings?.kokuchiEventId && pendingRestoreEvents.length > 0) {
      return {
        code: "orphaned_restore_state",
        severity: "error",
        message: "告知イベントIDのない集合VC復元待ちが残っているため、管理者の確認が必要です。",
      };
    }
    const eventStatus = normalizeKokuchiStatus(currentEvent?.kokuchiStatus ?? currentEvent?.status);
    if (["scheduled", "running", "canceling"].includes(eventStatus)) {
      return {
        code: "event_in_progress",
        severity: "info",
        message: "前回のkokuchiイベントが進行中です。完了または取消後に実行してください。",
      };
    }
    const cancellationInProgress = await KokuchiReservation.exists({ guildId, status: "canceling" });
    return cancellationInProgress
      ? { code: "event_canceling", severity: "info", message: "kokuchiイベントの取消処理が完了するまでお待ちください。" }
      : null;
  }
  

  return {
    isOteboRecruitmentPanelDisplayAllowed,
    handleProfileRegistrationPanelMessage,
    handleOteboRecruitmentPanelMessage,
    handleSetting,
    handleRemoveRole,
    runOperationalParticipantRoleRemoval,
    reinstallOperationalPanels,
    closeExpiredOperationalRecruitments,
    handleKokuchiSetting,
    handleVcDmSetting,
    handleCallWaitSetting,
    handleShugoSetting,
    validateVoiceParticipantRole,
    handleAddWadai,
    handleShowWadai,
    handleDelWadai,
    sendSplitRandomTopicPanels,
    handleSplitRandomTopicButton,
    sendSplitStartAnnouncement,
    sendSplitClosingThanks,
    formatSplitClosingThanksMessage,
    getKokuchiAnnouncementChannelId,
    getKokuchiOverviewChannelId,
    resolveWadaiSendChannel,
    resolveConfiguredTextChannel,
    sendOperationalLog,
    sendSplitGroupingLog,
    hasActiveKokuchiEvent,
    getKokuchiExecutionBlockReason,
  };
}
