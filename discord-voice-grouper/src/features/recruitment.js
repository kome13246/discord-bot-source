export function createRecruitmentFeature(dependencies) {
  const {
    ActionRowBuilder,
    BUTTON_RECRUITMENT_CONFLICT_MESSAGE,
    ButtonBuilder,
    ButtonStyle,
    CALL_WAIT_CANCEL_CUSTOM_ID,
    CALL_WAIT_FOLLOWUP_CHECK_MS,
    CALL_WAIT_FOLLOWUP_RETRY_MS,
    CALL_WAIT_INTEREST_CUSTOM_ID,
    CALL_WAIT_INTEREST_SELECT_CUSTOM_ID,
    CALL_WAIT_INTERVAL_MINUTES,
    CALL_WAIT_JOIN_CUSTOM_ID,
    CALL_WAIT_MIN_MEMBERS,
    CALL_WAIT_MODE_BUTTON,
    CALL_WAIT_ROLE_REMOVE_MS,
    CallWaitInterest,
    ChannelType,
    KokuchiReservation,
    MessageFlags,
    ModalBuilder,
    OTEBO_BUTTON_LIFECYCLE_LEASE_PREFIX,
    OTEBO_CREATE_CUSTOM_ID,
    OTEBO_DEFAULT_QUICK_CONFIRM_SECONDS,
    OTEBO_DRAFT_CANCEL_CUSTOM_ID,
    OTEBO_DRAFT_NOTE_CUSTOM_ID,
    OTEBO_DRAFT_SELECT_CUSTOM_ID,
    OTEBO_DRAFT_SUBMIT_CUSTOM_ID,
    OTEBO_DURATION_30,
    OTEBO_DURATION_60,
    OTEBO_DURATION_NONE,
    OTEBO_JOIN_CUSTOM_ID,
    OTEBO_MEMBER_CANCEL_CUSTOM_ID,
    OTEBO_MERGED_NOTICE,
    OTEBO_NOTE_MODAL_CUSTOM_ID,
    OTEBO_OWNER_CANCEL_CONFIRM_CUSTOM_ID,
    OTEBO_OWNER_CANCEL_CUSTOM_ID,
    OTEBO_ROLE_REMOVE_MS,
    OTEBO_SCHEDULED_NOTICE_LEAD_MS,
    OTEBO_TYPE_IMMEDIATE,
    OTEBO_TYPE_SCHEDULED,
    OTEBO_VOICE_STATUS_DEADLINE_MS,
    OTEBO_VOICE_STATUS_EXTRA_MS,
    PermissionFlagsBits,
    PermissionsBitField,
    Routes,
    ScheduledAction,
    SplitProcessSession,
    SplitReviewDraft,
    StringSelectMenuBuilder,
    TextInputBuilder,
    TextInputStyle,
    VoiceParticipantRoleGrant,
    WAITING_ROOM_POLL_MS,
    acquireMongoLease,
    callWaitFollowupTimers,
    callWaitGuildLocks,
    callWaitRoleRemovalTimers,
    callWaitRoleService,
    cancelSplitCountdown,
    claimAction,
    claimCallWaitPendingNotice,
    claimOteboRecruitmentSlot,
    clearCompletedGatheringVcEventState,
    clearOteboRecruitmentConfirmation,
    client,
    createCallWaitInterestRow,
    createCallWaitSlotKey,
    createSessionId,
    deleteOteboRecruitmentIfOnlyMember,
    failAction,
    failCallWaitPendingNotice,
    finishAction,
    formatButtonRecruitmentMessage,
    formatButtonSuccessNotice,
    getGuildSettings,
    getInterestCooldownSeconds,
    getKokuchiActionGuard,
    getMsUntilNextJstCallWaitSlot,
    getNextJstCallWaitSlot,
    getNonNegativeInteger,
    getPendingActions,
    isGatheringVcRestoreBlocking,
    isJstCallWaitSlotDue,
    isKokuchiCallWaitPaused,
    isOteboRecruitmentPanelDisplayAllowed,
    isShuttingDown,
    logRecoverableError,
    minutesToMs,
    normalizeButtonDuration,
    normalizeButtonNote,
    normalizeCallWaitIntervalMinutes,
    normalizeGatheringVcRestoreStatus,
    oteboDrafts,
    oteboRecruitmentPanelService,
    oteboRecruitmentTimers,
    recoverInterruptedActions,
    releaseMongoLease,
    releaseOteboRecruitmentSlot,
    removeVoiceParticipantRole,
    replaceNestedObject,
    replyOrFollowUp,
    requestOperationalStatusRefresh,
    resolveConfiguredTextChannel,
    restoreGatheringVcPermissionAfterSplit,
    retryAction,
    saveGuildSettingsWithCurrent,
    scheduleAction,
    scheduleSingleGuildAction,
    secondsToMs,
    sendOperationalLog,
    sendSplitFinishNotice,
    setVoiceChannelStatus,
    stopInvalidKokuchiAction,
    transitionCallWaitPrompt,
    transitionOteboRecruitment,
    transitionOteboRecruitmentSlot,
    unsetNestedObject,
    updateCallWaitPromptMember,
    updateOteboRecruitmentParticipant,
  } = dependencies;
  let callWaitTimer = null;
  let processingScheduledCallWaitTick = false;

  async function handleSendCallWait(interaction) {
    if (!interaction.inGuild()) {
      await replyOrFollowUp(interaction, {
        content: "このコマンドはサーバー内で使ってください。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  
    if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild)) {
      await replyOrFollowUp(interaction, {
        content: "通話待機システムの募集メッセージを送るには、サーバー管理権限が必要です。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  
    const settings = await getGuildSettings(interaction.guildId);
    const result = await sendCallWaitPromptForGuild(interaction.guild, settings, {
      force: true,
    });
  
    await replyOrFollowUp(interaction, {
      content: result.sent
        ? `通話待機システムの募集メッセージを ${result.channel} に送信しました。${formatJstTime(result.targetAt)} に希望者を確認します。`
        : `通話待機システムの募集メッセージを送信できませんでした。${result.reason}`,
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
  }
  
  async function handleSendOtebo(interaction) {
    if (!interaction.inGuild()) {
      await replyOrFollowUp(interaction, {
        content: "このコマンドはサーバー内で使ってください。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await interaction.editReply({
      content: "このコマンドは廃止されました。call_wait_notice_channel の常設パネルから「募集を作成」を押してください。",
      allowedMentions: { parse: [] },
    });
  }
  
  async function handleOteboButton(interaction) {
    if (!interaction.inGuild()) {
      await interaction.reply({
        content: "このボタンはサーバー内で使ってください。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  
    if (interaction.customId === OTEBO_CREATE_CUSTOM_ID) {
      if (interaction.user?.bot) {
        await interaction.reply({
          content: "Botユーザーはボタン募集を作成できません。",
          flags: MessageFlags.Ephemeral,
          allowedMentions: { parse: [] },
        });
        return;
      }
      await handleOteboCreateButton(interaction);
      return;
    }
  
    if (interaction.customId === OTEBO_DRAFT_NOTE_CUSTOM_ID) {
      await handleOteboDraftNoteButton(interaction);
      return;
    }
  
    if (interaction.customId === OTEBO_DRAFT_SUBMIT_CUSTOM_ID) {
      await handleOteboDraftSubmitButton(interaction);
      return;
    }
  
    if (interaction.customId === OTEBO_DRAFT_CANCEL_CUSTOM_ID) {
      oteboDrafts.delete(getOteboDraftKey(interaction.guildId, interaction.user.id));
      await interaction.update({
        content: "ボタン募集の作成をキャンセルしました。",
        components: [],
      });
      return;
    }
  
    if (interaction.customId.startsWith(`${OTEBO_JOIN_CUSTOM_ID}:`)) {
      await handleOteboJoinButton(
        interaction,
        interaction.customId.slice(`${OTEBO_JOIN_CUSTOM_ID}:`.length),
      );
      return;
    }
  
    if (interaction.customId.startsWith(`${OTEBO_MEMBER_CANCEL_CUSTOM_ID}:`)) {
      await handleOteboMemberCancelButton(
        interaction,
        interaction.customId.slice(`${OTEBO_MEMBER_CANCEL_CUSTOM_ID}:`.length),
      );
      return;
    }
  
    if (interaction.customId.startsWith(`${OTEBO_OWNER_CANCEL_CUSTOM_ID}:`)) {
      await handleOteboOwnerCancelButton(
        interaction,
        interaction.customId.slice(`${OTEBO_OWNER_CANCEL_CUSTOM_ID}:`.length),
      );
      return;
    }
  
    if (interaction.customId.startsWith(`${OTEBO_OWNER_CANCEL_CONFIRM_CUSTOM_ID}:`)) {
      await handleOteboOwnerCancelConfirmButton(
        interaction,
        interaction.customId.slice(`${OTEBO_OWNER_CANCEL_CONFIRM_CUSTOM_ID}:`.length),
      );
    }
  }
  
  async function handleOteboCreateButton(interaction) {
    const settings = await getGuildSettings(interaction.guildId);
    const existing = findActiveButtonOteboRecruitment(settings);
  
    if (existing) {
      await interaction.reply({
        content: BUTTON_RECRUITMENT_CONFLICT_MESSAGE,
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      return;
    }
  
    if (settings?.oteboRecruitmentSlot?.status && ["creating", "active", "closing", "merging", "auto_cancel_processing", "success_processing", "success_notified", "cleanup_pending", "uncertain"].includes(settings.oteboRecruitmentSlot.status)) {
      await interaction.reply({
        content: BUTTON_RECRUITMENT_CONFLICT_MESSAGE,
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      return;
    }
  
    if (!await isOteboRecruitmentPanelDisplayAllowed(interaction.guild, settings)) {
      await interaction.reply({
        content: "現在はボタン募集を作成できません。進行中の募集・VC・ロール処理が終了してから、もう一度お試しください。",
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      return;
    }
  
    const draft = createDefaultOteboDraft(interaction.guildId, interaction.user.id);
    oteboDrafts.set(getOteboDraftKey(interaction.guildId, interaction.user.id), draft);
  
    await interaction.reply({
      content: formatButtonOteboDraftContent(draft),
      components: createButtonOteboDraftRows(draft),
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
  }
  
  async function handleOteboDraftSelect(interaction) {
    if (!interaction.inGuild()) {
      await interaction.reply({
        content: "この選択メニューはサーバー内で使ってください。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  
    const field = interaction.customId.slice(`${OTEBO_DRAFT_SELECT_CUSTOM_ID}:`.length);
    const key = getOteboDraftKey(interaction.guildId, interaction.user.id);
    const draft = oteboDrafts.get(key);
  
    if (!draft) {
      await interaction.update({
        content: "入力中のボタン募集が見つかりません。もう一度、募集作成ボタンから作り直してください。",
        components: [],
      });
      return;
    }
  
    const [value] = interaction.values;
  
    if (field === "type") {
      draft.type = value === OTEBO_TYPE_IMMEDIATE ? OTEBO_TYPE_IMMEDIATE : OTEBO_TYPE_SCHEDULED;
    } else if (field === "target_at") {
      draft.targetAt = value;
    } else if (field === "duration") {
      draft.duration = normalizeOteboDuration(value);
    } else if (field === "mention") {
      draft.mentionBosyu = value === "yes";
    }
  
    oteboDrafts.set(key, draft);
  
    await interaction.update({
      content: formatButtonOteboDraftContent(draft),
      components: createButtonOteboDraftRows(draft),
      allowedMentions: { parse: [] },
    });
  }
  
  async function handleOteboDraftNoteButton(interaction) {
    const draft = oteboDrafts.get(getOteboDraftKey(interaction.guildId, interaction.user.id));
  
    if (!draft) {
      await interaction.reply({
        content: "入力中のボタン募集が見つかりません。もう一度、募集作成ボタンから作り直してください。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  
    draft.menuMessageId = interaction.message?.id ?? null;
    draft.menuInteractionToken = interaction.token;
    draft.menuApplicationId = interaction.applicationId;
    oteboDrafts.set(getOteboDraftKey(interaction.guildId, interaction.user.id), draft);
  
    const modal = new ModalBuilder()
      .setCustomId(OTEBO_NOTE_MODAL_CUSTOM_ID)
      .setTitle("ボタン募集");
    const noteInput = new TextInputBuilder()
      .setCustomId("note")
      .setLabel("ひとこと（任意）")
      .setPlaceholder("例）お暇でしたらぜひ")
      .setStyle(TextInputStyle.Paragraph)
      .setMaxLength(300)
      .setRequired(false);
  
    modal.addComponents(new ActionRowBuilder().addComponents(noteInput));
    await interaction.showModal(modal);
  }
  
  async function handleOteboDraftSubmitButton(interaction) {
    await interaction.deferUpdate();
    const result = await createButtonOteboRecruitmentFromDraft(interaction, "");
  
    if (!result.ok) {
      await interaction.editReply({
        content: result.reason,
        components: result.keepDraft
          ? createButtonOteboDraftRows(result.draft)
          : [],
        allowedMentions: { parse: [] },
      });
      return;
    }
  
    await interaction.editReply({
      content: formatOteboOwnerCancelMessage(),
      components: [],
      allowedMentions: { parse: [] },
    });
  }
  
  async function handleOteboNoteModal(interaction) {
    const note = interaction.fields.getTextInputValue("note") ?? "";
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const result = await createButtonOteboRecruitmentFromDraft(interaction, note);
  
    if (!result.ok) {
      await interaction.editReply({
        content: result.reason,
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      return;
    }
  
    await updateOteboDraftMenuAfterModal(result.draftMenu);
  
    await interaction.editReply({
      content: formatOteboOwnerCancelMessage(),
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
  }
  
  async function createOteboRecruitmentFromDraft(interaction, note) {
    const key = getOteboDraftKey(interaction.guildId, interaction.user.id);
    const draft = oteboDrafts.get(key);
  
    if (!draft) {
      return {
        ok: false,
        keepDraft: false,
        reason: "入力中のボタン募集が見つかりません。もう一度、募集作成ボタンから作り直してください。",
      };
    }
  
    const targetAt = new Date(draft.targetAt);
    if (!Number.isFinite(targetAt.getTime()) || targetAt.getTime() <= Date.now()) {
      return {
        ok: false,
        keepDraft: true,
        draft,
        reason: "掲載終了時刻にすでに経過した時刻を指定しています。時刻を選び直してください。",
      };
    }
  
    const settings = await getGuildSettings(interaction.guildId);
    const existing = findActiveOteboRecruitmentByOwner(settings, interaction.user.id);
  
    if (existing) {
      return {
        ok: false,
        keepDraft: false,
        reason: BUTTON_RECRUITMENT_CONFLICT_MESSAGE,
      };
    }
  
    const configured = await validateOteboSettings(interaction.guild, settings, draft);
  
    if (!configured.ok) {
      return {
        ok: false,
        keepDraft: true,
        draft,
        reason: configured.reason,
      };
    }
  
    const shouldUsePreviewChannel =
      draft.type !== OTEBO_TYPE_IMMEDIATE &&
      configured.previewChannel &&
      targetAt.getTime() - OTEBO_SCHEDULED_NOTICE_LEAD_MS > Date.now();
    const sendChannel = shouldUsePreviewChannel
      ? configured.previewChannel
      : configured.noticeChannel;
    const recruitment = {
      id: createOteboRecruitmentId(),
      ownerId: interaction.user.id,
      type: draft.type === OTEBO_TYPE_IMMEDIATE ? OTEBO_TYPE_IMMEDIATE : OTEBO_TYPE_SCHEDULED,
      targetAt: targetAt.toISOString(),
      duration: normalizeOteboDuration(draft.duration),
      mentionBosyu: draft.mentionBosyu === true,
      note: normalizeOteboNote(note),
      channelId: sendChannel.id,
      messageId: null,
      noticeChannelId: configured.noticeChannel.id,
      previewChannelId: shouldUsePreviewChannel ? configured.previewChannel.id : null,
      publishedToNotice: !shouldUsePreviewChannel,
      memberIds: [interaction.user.id],
      pendingConfirmations: {},
      status: "active",
      createdAt: new Date().toISOString(),
      quickConfirmSeconds: getOteboQuickConfirmSeconds(settings),
    };
    const draftMenu = {
      applicationId: draft.menuApplicationId,
      token: draft.menuInteractionToken,
      messageId: draft.menuMessageId,
    };
    const message = await sendChannel.send({
      content: formatOteboRecruitmentMessage(recruitment, settings),
      components: [createButtonOteboJoinRow(recruitment)],
      allowedMentions: getOteboRecruitmentAllowedMentions(recruitment, settings),
    });
  
    recruitment.messageId = message.id;
  
    const nextSettings = await saveOteboRecruitmentState(
      interaction.guildId,
      settings,
      recruitment,
    );
  
    oteboDrafts.delete(key);
    scheduleOteboRecruitmentTimers(interaction.guild, recruitment);
    await sendOteboApplicantLog({
      guild: interaction.guild,
      settings: nextSettings,
      action: "create",
      userId: interaction.user.id,
      memberIds: recruitment.memberIds,
    });
  
    return {
      ok: true,
      recruitment,
      draftMenu,
    };
  }
  
  async function createButtonOteboRecruitmentFromDraft(interaction, note) {
    const key = getOteboDraftKey(interaction.guildId, interaction.user.id);
    const draft = oteboDrafts.get(key);
    if (!draft) {
      return { ok: false, keepDraft: false, reason: "募集フォームの有効期限が切れています。もう一度「募集を作成」からお試しください。" };
    }
  
    const targetAt = new Date(draft.targetAt);
    const availableTimeOptions = createOteboTimeOptions(new Date());
    if (
      !Number.isFinite(targetAt.getTime())
      || targetAt.getTime() <= Date.now()
      || !availableTimeOptions.some((option) => option.value === draft.targetAt)
    ) {
      return { ok: false, keepDraft: true, draft, reason: "掲載終了時刻は現在より後の時刻を選択してください。" };
    }
  
    let settings = await getGuildSettings(interaction.guildId);
    if (settings?.callWaitEnabled !== true) {
      return { ok: false, keepDraft: true, draft, reason: "通話待機システムが無効です。管理者に有効化を依頼してください。" };
    }
    if (findActiveButtonOteboRecruitment(settings)) {
      return { ok: false, keepDraft: false, reason: BUTTON_RECRUITMENT_CONFLICT_MESSAGE };
    }
  
    const lease = await acquireMongoLease(`${OTEBO_BUTTON_LIFECYCLE_LEASE_PREFIX}:${interaction.guildId}`, { leaseMs: 120_000 });
    if (!lease) return { ok: false, keepDraft: true, draft, reason: BUTTON_RECRUITMENT_CONFLICT_MESSAGE };
  
    const slotId = createOteboRecruitmentId();
    let claimedSlot = null;
    try {
      settings = await getGuildSettings(interaction.guildId);
      if (settings?.callWaitEnabled !== true || findActiveButtonOteboRecruitment(settings)) {
        return { ok: false, keepDraft: false, reason: BUTTON_RECRUITMENT_CONFLICT_MESSAGE };
      }
      const configured = await validateOteboSettings(interaction.guild, settings, draft);
      if (!configured.ok) return { ok: false, keepDraft: true, draft, reason: configured.reason };
  
      try {
        claimedSlot = await claimOteboRecruitmentSlot({
          guildId: interaction.guildId,
          slot: {
            slotId,
            status: "creating",
            ownerId: interaction.user.id,
            sourceType: "button",
            createdAt: new Date().toISOString(),
          },
        });
      } catch (error) {
        await sendOperationalLog({ guild: interaction.guild, settings, fallbackChannel: null, content: `button recruitment slot claim failed guild=${interaction.guildId} error=${error.message}` }).catch(() => null);
        return { ok: false, keepDraft: true, draft, reason: BUTTON_RECRUITMENT_CONFLICT_MESSAGE };
      }
      if (!claimedSlot) return { ok: false, keepDraft: true, draft, reason: BUTTON_RECRUITMENT_CONFLICT_MESSAGE };
  
      const recruitment = {
        id: createOteboRecruitmentId(),
        ownerId: interaction.user.id,
        sourceType: "button",
        type: OTEBO_TYPE_IMMEDIATE,
        targetAt: targetAt.toISOString(),
        duration: normalizeButtonDuration(draft.duration),
        mentionBosyu: draft.mentionBosyu === true,
        note: normalizeButtonNote(note),
        channelId: configured.noticeChannel.id,
        messageId: null,
        noticeChannelId: configured.noticeChannel.id,
        previewChannelId: null,
        publishedToNotice: true,
        memberIds: [interaction.user.id],
        pendingConfirmations: {},
        status: "active",
        createdAt: new Date().toISOString(),
        quickConfirmSeconds: getOteboQuickConfirmSeconds(settings),
      };
      const draftMenu = {
        applicationId: draft.menuApplicationId,
        token: draft.menuInteractionToken,
        messageId: draft.menuMessageId,
      };
      let message;
      try {
        message = await configured.noticeChannel.send({
          content: formatOteboRecruitmentMessage(recruitment, settings),
          components: [createButtonOteboJoinRow(recruitment)],
          allowedMentions: getOteboRecruitmentAllowedMentions(recruitment, settings),
        });
      } catch (error) {
        await releaseOteboRecruitmentSlot({ guildId: interaction.guildId, slotId, status: "closed", patch: { lastError: `募集メッセージ送信失敗: ${error.message}` } }).catch(() => null);
        return { ok: false, keepDraft: true, draft, reason: "募集メッセージを送信できませんでした。設定と権限を確認してください。" };
      }
  
      recruitment.messageId = message.id;
      const recruitments = { ...getOteboRecruitments(settings), [recruitment.id]: recruitment };
      const activeSlot = {
        ...claimedSlot.oteboRecruitmentSlot,
        slotId,
        recruitmentId: recruitment.id,
        messageId: message.id,
        channelId: configured.noticeChannel.id,
        endAt: recruitment.targetAt,
        status: "active",
        updatedAt: new Date().toISOString(),
      };
      let nextSettings;
      try {
        nextSettings = await saveGuildSettingsWithCurrent(interaction.guildId, settings, {
          oteboRecruitments: recruitments,
          oteboRecruitmentSlot: activeSlot,
        });
      } catch (error) {
        await message.edit({
          content: "この募集は保存に失敗したため無効です。管理者が状態を確認してください。",
          components: [],
          allowedMentions: { parse: [] },
        }).catch(() => null);
        await transitionOteboRecruitmentSlot({ guildId: interaction.guildId, slotId, fromStatuses: ["creating", "active"], toStatus: "cleanup_pending", patch: { lastError: `募集状態保存失敗: ${error.message}`, messageId: message.id } }).catch(() => null);
        return { ok: false, keepDraft: false, reason: "募集状態の保存に失敗したため、募集は無効化しました。管理者に確認を依頼してください。" };
      }
  
      oteboDrafts.delete(key);
      scheduleOteboRecruitmentTimers(interaction.guild, recruitment);
      await oteboRecruitmentPanelService.removeOteboRecruitmentPanel(interaction.guild).catch((error) => logRecoverableError("Otebo panel removal after recruitment creation failed", error));
      await sendOteboApplicantLog({
        guild: interaction.guild,
        settings: nextSettings,
        action: "create",
        userId: interaction.user.id,
        memberIds: recruitment.memberIds,
      });
      return { ok: true, recruitment, draftMenu };
    } finally {
      await releaseMongoLease(lease).catch((error) => logRecoverableError("Failed to release button recruitment create lease", error));
    }
  }
  
  async function handleOteboJoinButton(interaction, recruitmentId) {
    const settings = await getGuildSettings(interaction.guildId);
    const recruitment = getOteboRecruitment(settings, recruitmentId);
  
    if (!isActiveOteboRecruitment(recruitment, interaction.message?.id)) {
      await interaction.reply({
        content: "この募集は現在有効ではありません。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  
    if (interaction.user?.bot) {
      await interaction.reply({
        content: "Botユーザーはボタン募集へ参加できません。",
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      return;
    }
  
    if (recruitment.type !== OTEBO_TYPE_IMMEDIATE) {
      await interaction.reply({
        content: "この募集形式は現在利用できません。常設パネルからボタン募集を作成してください。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  
    const targetAt = new Date(recruitment.targetAt);
    if (!Number.isFinite(targetAt.getTime()) || targetAt.getTime() <= Date.now()) {
      await interaction.reply({
        content: "この募集は締め切られています。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  
    if (normalizeCallWaitMemberIds(recruitment.memberIds).includes(interaction.user.id)) {
      await interaction.reply({
        content: "すでに参加希望を受け付けています。キャンセルする場合はメッセージ下のキャンセルボタンから行えます。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  
    if (recruitment.type === OTEBO_TYPE_IMMEDIATE) {
      await handleOteboImmediateJoin(interaction, settings, recruitment);
      return;
    }
  
    const memberIds = addUniqueMemberId(recruitment.memberIds, interaction.user.id);
    const updated = await updateOteboRecruitmentParticipant({
      guildId: interaction.guildId,
      recruitmentId,
      messageId: interaction.message.id,
      userId: interaction.user.id,
      operation: "add",
    });
    if (!updated) {
      await interaction.reply({ content: "この募集はすでに更新されています。", flags: MessageFlags.Ephemeral });
      return;
    }
  
    const nextSettings = await getGuildSettings(interaction.guildId);
    const nextRecruitment = getOteboRecruitment(nextSettings, recruitmentId) ?? { ...recruitment, memberIds };
  
    await sendOteboApplicantLog({
      guild: interaction.guild,
      settings: nextSettings,
      action: "join",
      userId: interaction.user.id,
      memberIds,
    });
    await editOteboRecruitmentMessage(interaction.guild, nextSettings, nextRecruitment);
  
    await interaction.reply({
      content: "参加希望を受け付けました。キャンセルする場合はメッセージ下のキャンセルボタンから行えます。",
      flags: MessageFlags.Ephemeral,
    });
  }
  
  async function handleOteboImmediateJoin(interaction, settings, recruitment) {
    const confirmSeconds = getOteboQuickConfirmSeconds(settings, recruitment);
    const confirmExpiresAt = new Date(Date.now() + secondsToMs(confirmSeconds));
    const pendingConfirmations = {
      ...(recruitment.pendingConfirmations ?? {}),
      [interaction.user.id]: confirmExpiresAt.toISOString(),
    };
    const memberIds = addUniqueMemberId(recruitment.memberIds, interaction.user.id);
    const updated = await updateOteboRecruitmentParticipant({
      guildId: interaction.guildId,
      recruitmentId: recruitment.id,
      messageId: recruitment.messageId,
      userId: interaction.user.id,
      operation: "add",
      pendingConfirmation: confirmExpiresAt.toISOString(),
    });
    if (!updated) {
      await interaction.reply({ content: "この募集はすでに更新されています。", flags: MessageFlags.Ephemeral });
      return;
    }
    const nextSettings = await getGuildSettings(interaction.guildId);
    const nextRecruitment = getOteboRecruitment(nextSettings, recruitment.id) ?? { ...recruitment, memberIds, pendingConfirmations };
  
    scheduleOteboImmediateConfirmation(
      interaction.guild,
      nextRecruitment,
      interaction.user.id,
    );
  
    await sendOteboApplicantLog({
      guild: interaction.guild,
      settings: nextSettings,
      action: "join",
      userId: interaction.user.id,
      memberIds,
    });
  
    await interaction.reply({
      content: formatOteboImmediateJoinReply(confirmSeconds),
      components: [createButtonOteboMemberCancelRow(recruitment.id)],
      flags: MessageFlags.Ephemeral,
    });
  
    startOteboImmediateReplyCountdown({
      interaction,
      guildId: interaction.guildId,
      recruitmentId: recruitment.id,
      userId: interaction.user.id,
      confirmSeconds,
    });
  }
  
  function formatOteboImmediateJoinReply(remainingSeconds) {
    return [
      "参加希望を受け付けました。キャンセルはメッセージ下のキャンセルボタンから行えます。",
      `あと${Math.max(0, remainingSeconds)}秒間キャンセルがなかったら集合メンションが送られます。`,
    ].join("\n");
  }
  
  function startOteboImmediateReplyCountdown({
    interaction,
    guildId,
    recruitmentId,
    userId,
    confirmSeconds,
  }) {
    let remainingSeconds = Number(confirmSeconds);
  
    if (!Number.isInteger(remainingSeconds) || remainingSeconds <= 0) {
      return;
    }
  
    const timer = setInterval(() => {
      remainingSeconds -= 1;
  
      void (async () => {
        const settings = await getGuildSettings(guildId);
        const recruitment = getOteboRecruitment(settings, recruitmentId);
  
        if (!recruitment?.pendingConfirmations?.[userId]) {
          clearInterval(timer);
          return;
        }
  
        await interaction.editReply({
          content: formatOteboImmediateJoinReply(remainingSeconds),
          components: [createButtonOteboMemberCancelRow(recruitmentId)],
        }).catch(() => null);
  
        if (remainingSeconds <= 0) {
          clearInterval(timer);
        }
      })().catch(() => {
        clearInterval(timer);
      });
    }, 1000);
  }
  
  async function handleOteboMemberCancelButton(interaction, recruitmentId) {
    const settings = await getGuildSettings(interaction.guildId);
    const recruitment = getOteboRecruitment(settings, recruitmentId);
  
    // This button is sent in an ephemeral response, so its message ID is not
    // the public recruitment message ID. Validate the durable recruitment
    // state instead of comparing unrelated ephemeral IDs.
    if (!isActiveOteboRecruitment(recruitment)) {
      await interaction.reply({
        content: "この募集は現在有効ではありません。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  
    const memberIds = normalizeCallWaitMemberIds(recruitment.memberIds);
  
    if (!memberIds.includes(interaction.user.id)) {
      await interaction.reply({
        content: "この募集への参加の予定はありません。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  
    if (interaction.user.id === recruitment.ownerId) {
      await interaction.reply({
        content: "自身が作成した募集ですがキャンセルしてもよろしいですか？",
        components: [createOteboOwnerCancelConfirmRow(recruitment.id)],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  
    await cancelOteboParticipation({
      interaction,
      settings,
      recruitment,
      userId: interaction.user.id,
      response: "update",
    });
  }
  
  async function handleOteboOwnerCancelButton(interaction, recruitmentId) {
    const settings = await getGuildSettings(interaction.guildId);
    const recruitment = getOteboRecruitment(settings, recruitmentId);
  
    if (!isActiveOteboRecruitment(recruitment, interaction.message?.id)) {
      await interaction.reply({
        content: "この募集は現在有効ではありません。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  
    if (interaction.user.id !== recruitment.ownerId) {
      await interaction.reply({ content: "募集を取り消せるのは募集作成者だけです。", flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
      return;
    }
  
    if (false) {
      await interaction.reply({
        content: "この募集をキャンセルできるのは作成者だけです。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  
    await interaction.reply({
      content: "自身が作成した募集ですがキャンセルしてもよろしいですか？",
      components: [createOteboOwnerCancelConfirmRow(recruitment.id)],
      flags: MessageFlags.Ephemeral,
    });
  }
  
  async function handleOteboOwnerCancelConfirmButton(interaction, recruitmentId) {
    await interaction.deferUpdate();
    const settings = await getGuildSettings(interaction.guildId);
    const recruitment = getOteboRecruitment(settings, recruitmentId);
  
    if (!isActiveOteboRecruitment(recruitment)) {
      await interaction.editReply({
        content: "この募集は現在有効ではありません。",
        components: [],
      });
      return;
    }
  
    if (interaction.user.id !== recruitment.ownerId) {
      await interaction.editReply({
        content: "この確認ボタンを使えるのは募集作成者だけです。",
        components: [],
      });
      return;
    }
  
    if (!normalizeCallWaitMemberIds(recruitment.memberIds).includes(interaction.user.id)) {
      await interaction.editReply({
        content: "この募集への参加の予定はありません。",
        components: [],
      });
      return;
    }
  
    await cancelOteboParticipation({
      interaction,
      settings,
      recruitment,
      userId: interaction.user.id,
      response: "editReply",
    });
  }
  
  async function cancelOteboParticipation({
    interaction,
    settings,
    recruitment,
    userId,
    response,
  }) {
    if (recruitment?.type === OTEBO_TYPE_IMMEDIATE && recruitment.ownerId === userId && response === "editReply") {
      await cancelButtonOteboRecruitment({ interaction, settings, recruitment });
      return;
    }
    const pendingConfirmations = { ...(recruitment.pendingConfirmations ?? {}) };
    delete pendingConfirmations[userId];
    clearOteboConfirmationTimer(interaction.guildId, recruitment.id, userId);
  
    const memberIds = normalizeCallWaitMemberIds(recruitment.memberIds).filter(
      (memberId) => memberId !== userId,
    );
  
    if (memberIds.length === 0) {
      const deleted = await deleteOteboRecruitmentIfOnlyMember({
        guildId: interaction.guildId,
        recruitmentId: recruitment.id,
        messageId: recruitment.messageId,
        userId,
      });
      if (deleted) {
        await deleteOteboRecruitmentMessage(interaction.guild, recruitment).catch((error) => {
          logRecoverableError("Failed to delete empty button recruitment", error);
          return editOteboRecruitmentMessageClosed(interaction.guild, recruitment);
        });
        clearOteboRecruitmentTimers(interaction.guildId, recruitment.id);
        await sendOteboApplicantLog({
          guild: interaction.guild,
          settings: await getGuildSettings(interaction.guildId),
          action: "cancel",
          userId,
          memberIds: [],
        });
        await respondOteboCancel(interaction, response);
        return;
      }
    }
  
    const updated = await updateOteboRecruitmentParticipant({
      guildId: interaction.guildId,
      recruitmentId: recruitment.id,
      messageId: recruitment.messageId,
      userId,
      operation: "remove",
    });
    if (!updated) {
      await respondOteboCancel(interaction, response);
      return;
    }
    const nextSettings = await getGuildSettings(interaction.guildId);
    const nextRecruitment = getOteboRecruitment(nextSettings, recruitment.id) ?? { ...recruitment, memberIds, pendingConfirmations };
  
    await editOteboRecruitmentMessage(interaction.guild, nextSettings, nextRecruitment);
    await sendOteboApplicantLog({
      guild: interaction.guild,
      settings: nextSettings,
      action: "cancel",
      userId,
      memberIds,
    });
  
    await respondOteboCancel(interaction, response);
  }
  
  async function cancelButtonOteboRecruitment({ interaction, settings, recruitment }) {
    const lease = await acquireMongoLease(`otebo-button-lifecycle:${interaction.guildId}:${recruitment.id}`, { leaseMs: 120_000 });
    if (!lease) {
      await interaction.editReply({ content: "募集の処理中です。少し待ってから再度お試しください。", components: [] });
      return;
    }
    try {
      const claimedSettings = await transitionOteboRecruitment({
        guildId: interaction.guildId,
        recruitmentId: recruitment.id,
        fromStatuses: ["active"],
        toStatus: "closing",
        patch: { closedReason: "owner_cancelled" },
      });
      if (!claimedSettings) {
        await interaction.editReply({ content: "募集はすでに終了しています。", components: [] });
        return;
      }
      const claimedRecruitment = getOteboRecruitment(claimedSettings, recruitment.id) ?? recruitment;
      clearOteboRecruitmentTimers(interaction.guildId, recruitment.id);
      await deleteOteboRecruitmentMessage(interaction.guild, claimedRecruitment).catch((error) => {
        logRecoverableError("Failed to delete owner-cancelled button recruitment", error);
        return editOteboRecruitmentMessageClosed(interaction.guild, claimedRecruitment);
      });
      const nextSettings = await deleteOteboRecruitmentState(interaction.guildId, claimedSettings, recruitment.id);
      const slot = nextSettings?.oteboRecruitmentSlot ?? claimedSettings?.oteboRecruitmentSlot;
      if (slot?.slotId) {
        await releaseOteboRecruitmentSlot({ guildId: interaction.guildId, slotId: slot.slotId, status: "closed", patch: { closedReason: "owner_cancelled" } }).catch((error) => logRecoverableError("Failed to release cancelled button recruitment slot", error));
      }
      await oteboRecruitmentPanelService.ensureOteboRecruitmentPanel(interaction.guild).catch((error) => logRecoverableError("Failed to restore Otebo panel after owner cancellation", error));
      await sendOteboApplicantLog({ guild: interaction.guild, settings: nextSettings, action: "cancel", userId: recruitment.ownerId, memberIds: normalizeCallWaitMemberIds(recruitment.memberIds) });
      await interaction.editReply({ content: "募集を取り消しました。", components: [] });
    } finally {
      await releaseMongoLease(lease).catch((error) => logRecoverableError("Failed to release button lifecycle lease", error));
    }
  }
  
  async function respondOteboCancel(interaction, response) {
    if (response === "update" || response === "editReply") {
      await interaction[response]({
        content: "参加をキャンセルしました。",
        components: [],
        allowedMentions: { parse: [] },
      });
      return;
    }
  
    if (response === "reply") {
      await interaction.reply({ content: "参加をキャンセルしました。", flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
      return;
    }
  
    if (response === "update" || response === "editReply") {
      await interaction[response]({
        content: "参加の希望をキャンセルしました。",
        components: [],
      });
      return;
    }
  
    await interaction.reply({
      content: "参加の希望をキャンセルしました。",
      flags: MessageFlags.Ephemeral,
    });
  }
  
  function scheduleNextCallWaitTick() {
    if (isShuttingDown()) return;
    if (callWaitTimer) {
      clearTimeout(callWaitTimer);
    }
  
    const now = new Date();
    const delayMs = Math.min(...CALL_WAIT_INTERVAL_MINUTES.map((intervalMinutes) =>
      getMsUntilNextJstCallWaitSlot({ now, intervalMinutes }),
    ));
    callWaitTimer = setTimeout(() => {
      processingScheduledCallWaitTick = true;
      void processCallWaitForAllGuilds()
        .catch((error) => {
          console.error(error);
        })
        .finally(() => {
          processingScheduledCallWaitTick = false;
          scheduleNextCallWaitTick();
        });
    }, delayMs);
  }
  
  async function processCallWaitForAllGuilds() {
    if (isShuttingDown()) return;
    for (const guild of client.guilds.cache.values()) {
      // Settings retrieval is also an external MongoDB operation.  Keep it in
      // the per-guild boundary so one unavailable document cannot prevent every
      // other guild from receiving its scheduled evaluation.
      try {
        const settings = await getGuildSettings(guild.id);
        await processCallWaitForGuild(guild, settings);
      } catch (error) {
        console.error(`Failed to process call wait for ${guild.id}: ${error.message}`, error);
      }
    }
    await retryPendingCallWaitEndNotifications().catch((error) => {
      console.error("Call-wait end notification retry failed:", error);
    });
  }
  
  async function processCallWaitForGuild(guild, settings) {
    if (callWaitGuildLocks.has(guild.id)) return;
    callWaitGuildLocks.add(guild.id);
    let lease = null;
    try {
      lease = await acquireMongoLease(`callwait:${guild.id}`, { leaseMs: 5 * 60 * 1000 });
      if (!lease) return;
      await endOrphanedCallWaitInterests(guild.id, settings?.callWaitPrompt?.messageId);
      if (settings?.callWaitEnabled !== true) {
        const prompt = settings?.callWaitPrompt;
        if (prompt?.messageId) {
          const closing = await transitionCallWaitPrompt({
            guildId: guild.id,
            messageId: prompt.messageId,
            fromStates: ["open", "evaluating", "role_granting", "failed"],
            toState: "closing",
            patch: { lastError: "Closing call-wait prompt because the feature is disabled" },
          });
          if (closing) {
            await endCallWaitInterestsForRecruitment(guild.id, prompt.messageId);
            await deleteCallWaitPrompt(guild, prompt).catch((error) => {
              console.error(`Failed to delete disabled call-wait prompt ${prompt.messageId}: ${error.message}`);
            });
            await saveGuildSettingsWithCurrent(guild.id, closing, { callWaitPrompt: null });
          }
        }
        return;
      }
  
    const configured = await validateCallWaitSettings(guild, settings);
    const now = new Date();
  
    if (!configured.ok) {
      const expiredPrompt = settings.callWaitPrompt;
      if (
        expiredPrompt?.messageId
        && (
          !Number.isFinite(new Date(expiredPrompt.targetAt).getTime())
          || new Date(expiredPrompt.targetAt).getTime() <= now.getTime()
        )
      ) {
        const closing = await transitionCallWaitPrompt({
          guildId: guild.id,
          messageId: expiredPrompt.messageId,
          fromStates: ["open", "evaluating", "role_granting", "failed"],
          toState: "closing",
          patch: { lastError: `Closing expired prompt because call-wait settings are incomplete: ${configured.reason}` },
        });
        if (closing) {
          await endCallWaitInterestsForRecruitment(guild.id, expiredPrompt.messageId);
          await deleteCallWaitPrompt(guild, expiredPrompt).catch((error) => {
            console.error(`Failed to delete expired call-wait prompt ${expiredPrompt.messageId}: ${error.message}`);
          });
          await saveGuildSettingsWithCurrent(guild.id, closing, { callWaitPrompt: null });
          await sendOperationalLog({
            guild,
            settings: closing,
            fallbackChannel: null,
            content: `設定不備のため、期限到達済みの定時募集を終了しました。募集ID: ${expiredPrompt.messageId}`,
          });
        }
      }
      return;
    }
  
    if (
      settings.callWaitPrompt?.messageId
      && new Date(settings.callWaitPrompt.targetAt).getTime() <= now.getTime()
    ) {
      const transitioned = await transitionCallWaitPrompt({
        guildId: guild.id,
        messageId: settings.callWaitPrompt.messageId,
        fromStates: ["open", "evaluating", "failed"],
        toState: "evaluating",
      });
      if (!transitioned) return;
      settings = transitioned;
    }
    const promptResult = await evaluateCallWaitPrompt(guild, settings, now);
  
    if (promptResult.evaluated) {
      const evaluatedRecruitmentId = settings.callWaitPrompt?.messageId;
      const evaluatedPrompt = settings.callWaitPrompt;
  
      if (promptResult.memberIds.length >= CALL_WAIT_MIN_MEMBERS) {
        const roleGranting = await transitionCallWaitPrompt({
          guildId: guild.id,
          messageId: evaluatedRecruitmentId,
          fromStates: ["evaluating"],
          toState: "role_granting",
        });
        if (!roleGranting) return;
        const queued = await grantCallWaitRoleAndQueueNotice({
          guild,
          settings: roleGranting,
          memberIds: promptResult.memberIds,
          sourceId: evaluatedRecruitmentId,
        });
  
        if (queued) {
          await endCallWaitInterestsForRecruitment(guild.id, evaluatedRecruitmentId);
          settings = await saveGuildSettingsWithCurrent(guild.id, roleGranting, {
            callWaitPrompt: null,
          });
          await deleteCallWaitPrompt(guild, roleGranting.callWaitPrompt).catch((error) => {
            console.error(`Failed to delete completed call-wait prompt ${evaluatedRecruitmentId}: ${error.message}`);
          });
          await scheduleCallWaitFollowupCheck(guild);
          return;
        }
        await transitionCallWaitPrompt({
          guildId: guild.id,
          messageId: evaluatedRecruitmentId,
          fromStates: ["role_granting"],
          toState: "failed",
        });
        return;
      }
  
      await endCallWaitInterestsForRecruitment(guild.id, evaluatedRecruitmentId);
      settings = await saveGuildSettingsWithCurrent(guild.id, settings, {
        callWaitPrompt: null,
      });
      await deleteCallWaitPrompt(guild, evaluatedPrompt).catch((error) => {
        console.error(`Failed to delete evaluated call-wait prompt ${evaluatedRecruitmentId}: ${error.message}`);
      });
      if (promptResult.mode === CALL_WAIT_MODE_BUTTON) {
        await sendCallWaitApplicantLog({
          guild,
          settings,
          action: "reset",
          memberIds: [],
          recruitmentId: evaluatedRecruitmentId,
        });
      }
    }
  
    const activeVoiceMemberIds = getCallWaitActiveVoiceMemberIds(
      guild,
      settings.callWaitVoiceCategoryId,
    );
  
    if (await maybeSendPendingCallWaitStartNotice(guild, settings)) {
      return;
    }
  
    // /kokuchi 当日は、21時・22時向けの定時募集を出さない。
    if (await isKokuchiCallWaitPaused(settings, guild.id, now)) {
      return;
    }
  
    if (activeVoiceMemberIds.length >= CALL_WAIT_MIN_MEMBERS) {
      if (settings.callWaitPrompt) {
        await endCallWaitInterestsForRecruitment(guild.id, settings.callWaitPrompt.messageId);
        await deleteCallWaitPrompt(guild, settings.callWaitPrompt);
        settings = await saveGuildSettingsWithCurrent(guild.id, settings, {
          callWaitPrompt: null,
        });
      }
  
      settings = await sendCallWaitSkippedNotice({
        guild,
        settings,
        channel: configured.promptChannel,
        now,
      });
  
      return;
    }
  
    if (settings.callWaitPrompt) {
      return;
    }
  
      if (
        !processingScheduledCallWaitTick
        || isJstCallWaitSlotDue({
          now,
          intervalMinutes: getCallWaitIntervalMinutes(settings),
        })
      ) {
        await sendCallWaitPromptForGuild(guild, settings, { force: false, now });
      }
    } finally {
      if (lease) {
        await releaseMongoLease(lease).catch((error) => {
          console.error(`Failed to release call-wait lease for ${guild.id}: ${error.message}`);
        });
      }
      callWaitGuildLocks.delete(guild.id);
      requestOperationalStatusRefresh(guild.id, "call-wait-processing");
    }
  }
  
  async function sendCallWaitPromptForGuild(guild, settings, { force = false, now = new Date() } = {}) {
    if (settings?.callWaitEnabled !== true) {
      return {
        sent: false,
        reason: "`/setting callwait call_wait_enabled:true` を設定してください。",
      };
    }
  
    const configured = await validateCallWaitSettings(guild, settings);
  
    if (!configured.ok) {
      return configured;
    }
  
    if (force && settings.callWaitPrompt) {
      await endCallWaitInterestsForRecruitment(guild.id, settings.callWaitPrompt.messageId);
      await deleteCallWaitPrompt(guild, settings.callWaitPrompt);
      settings = await saveGuildSettingsWithCurrent(guild.id, settings, {
        callWaitPrompt: null,
      });
    }
  
    if (settings.callWaitSkippedNotice) {
      await deleteCallWaitMessage(guild, settings.callWaitSkippedNotice);
      settings = await saveGuildSettingsWithCurrent(guild.id, settings, {
        callWaitSkippedNotice: null,
      });
    }
  
    if (!force && settings.callWaitPrompt) {
      return {
        sent: false,
        reason: "既に有効な募集メッセージがあります。",
      };
    }
  
    const targetAt = getNextJstCallWaitSlot({
      now,
      intervalMinutes: getCallWaitIntervalMinutes(settings),
    });
    const message = await configured.promptChannel.send({
      content: formatCallWaitPromptV2(targetAt),
      allowedMentions: { parse: [] },
      components: [createCallWaitInterestRow()],
    });
  
    try {
      await saveGuildSettingsWithCurrent(guild.id, settings, {
        callWaitPrompt: {
          channelId: configured.promptChannel.id,
          messageId: message.id,
          targetAt: targetAt.toISOString(),
          slotKey: getCallWaitSlotKey(targetAt, settings),
          mode: CALL_WAIT_MODE_BUTTON,
          memberIds: [],
          lifecycleState: "open",
          lifecycleUpdatedAt: new Date().toISOString(),
        },
        callWaitPendingNotice: null,
        callWaitSkippedNotice: null,
      });
    } catch (error) {
      // A visible prompt without a persisted identity cannot be evaluated or
      // closed safely on a later tick, so remove that orphan before surfacing
      // the failure to the scheduler.
      await message.delete().catch((error) => logRecoverableError("Failed to delete call-wait prompt", error));
      throw error;
    }
  
    return {
      sent: true,
      channel: configured.promptChannel,
      message,
      targetAt,
    };
  }
  
  async function validateCallWaitSettings(guild, settings) {
    const promptChannelId = getCallWaitPromptChannelId(settings);
    const noticeChannelId = getCallWaitNoticeChannelId(settings);
  
    if (!settings?.callWaitRoleId || !promptChannelId || !noticeChannelId) {
      return {
        ok: false,
        sent: false,
        reason: "`/setting callwait call_wait_role:ロール call_wait_prompt_channel:募集先 call_wait_notice_channel:通知先` を設定してください。",
      };
    }
  
    const promptChannel = await resolveConfiguredTextChannel(guild, promptChannelId);
    const noticeChannel = await resolveConfiguredTextChannel(guild, noticeChannelId);
    const role = await guild.roles.fetch(settings.callWaitRoleId).catch(() => null);
  
    if (!promptChannel) {
      return {
        ok: false,
        sent: false,
        reason: "通話待機システムの募集メッセージ送信先チャンネルを取得できません。",
      };
    }
  
    if (!noticeChannel) {
      return {
        ok: false,
        sent: false,
        reason: "通話待機システムの集合通知送信先チャンネルを取得できません。",
      };
    }
  
    if (!role) {
      return {
        ok: false,
        sent: false,
        reason: "通話待機システムのロールを取得できません。",
      };
    }
  
    return {
      ok: true,
      promptChannel,
      noticeChannel,
      role,
    };
  }
  
  async function evaluateCallWaitPrompt(guild, settings, now) {
    const prompt = settings?.callWaitPrompt;
  
    if (!prompt?.channelId || !prompt?.messageId || !prompt?.targetAt) {
      return { evaluated: false, memberIds: [] };
    }
  
    const targetAt = new Date(prompt.targetAt);
    if (!Number.isFinite(targetAt.getTime()) || targetAt.getTime() > now.getTime()) {
      return { evaluated: false, memberIds: [] };
    }
  
    const channel = await resolveConfiguredTextChannel(guild, prompt.channelId);
  
    if (!channel || typeof channel.messages?.fetch !== "function") {
      return { evaluated: true, memberIds: [] };
    }
  
    const message = await channel.messages.fetch(prompt.messageId).catch(() => null);
  
    if (!message) {
      return { evaluated: true, memberIds: [] };
    }
  
    const memberIds = normalizeCallWaitMemberIds(prompt.memberIds);
    return { evaluated: true, memberIds, mode: CALL_WAIT_MODE_BUTTON };
  }
  
  async function deleteCallWaitPrompt(guild, prompt) {
    await deleteCallWaitMessage(guild, prompt);
  }
  
  async function deleteCallWaitMessage(guild, messageRef) {
    if (!messageRef?.channelId || !messageRef?.messageId) {
      return;
    }
  
    const channel = await resolveConfiguredTextChannel(guild, messageRef.channelId);
  
    if (!channel || typeof channel.messages?.fetch !== "function") {
      return;
    }
  
    const message = await channel.messages.fetch(messageRef.messageId).catch(() => null);
    if (message) {
      await message.delete().catch(() => null);
    }
  }
  
  function getCallWaitInterestComponents(recruitmentId, {
    includeJoin = false,
    showThreshold = false,
    threshold = 1,
    linkUrl = null,
    allowRenotification = false,
    disabled = false,
  } = {}) {
    const rows = [];
    if (showThreshold) {
      rows.push(new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`${CALL_WAIT_INTEREST_SELECT_CUSTOM_ID}:${recruitmentId}`)
          .setPlaceholder(`通知条件：参加予定者${threshold}人以上`)
          .setDisabled(disabled)
          .addOptions(
            { label: "参加予定者が1人以上になったら通知", description: "自分が参加すると2人以上になります", value: "1", default: threshold === 1 },
            { label: "参加予定者が2人以上になったら通知", description: "自分が参加すると3人以上になります", value: "2", default: threshold === 2 },
            { label: "参加予定者が3人以上になったら通知", description: "自分が参加すると4人以上になります", value: "3", default: threshold === 3 },
          ),
      ));
    }
    const buttons = [];
    if (allowRenotification) buttons.push(new ButtonBuilder().setCustomId(`call_wait_interest_renotify:${recruitmentId}`).setLabel("再び集まったら通知する").setStyle(ButtonStyle.Primary).setDisabled(disabled));
    if (includeJoin) buttons.push(new ButtonBuilder().setCustomId(`call_wait_interest_join:${recruitmentId}`).setLabel("参加予定").setStyle(ButtonStyle.Success).setDisabled(disabled));
    if (linkUrl) buttons.push(new ButtonBuilder().setLabel("現在の募集を開く").setStyle(ButtonStyle.Link).setURL(linkUrl));
    buttons.push(new ButtonBuilder().setCustomId(`call_wait_interest_cancel:${recruitmentId}`).setLabel("興味ありを解除").setStyle(ButtonStyle.Danger).setDisabled(disabled));
    rows.push(new ActionRowBuilder().addComponents(buttons));
    return rows;
  }
  
  function buildCallWaitInterestReceiptContent({
    targetAt,
    participantCount,
    notificationThreshold,
    hasOtherInterest,
  }) {
    const target = targetAt ? formatJstTime(new Date(targetAt)) : "今回";
    const currentCount = Math.max(0, Number(participantCount) || 0);
    const threshold = Math.min(3, Math.max(1, Number(notificationThreshold) || 1));
    const otherInterestNote = currentCount === 0 && hasOtherInterest
      ? "\n\n受付時点では、あなた以外にもこの募集に興味を持っている方がいます。"
      : "";
    if (currentCount === 0) {
      return `【興味ありを受け付けました】\n\n${target}からの定時募集に、興味ありとして登録しました。${otherInterestNote}\n\n参加予定者が指定した人数以上になった際に、DMでお知らせします。\n\n現在の通知条件：\n参加予定者が${threshold}人以上になったら通知\n\n通知条件は、下のメニューから変更できます。`;
    }
    return `【興味ありを受け付けました】\n\n${target}からの定時募集に、興味ありとして登録しました。\n\n現在の参加予定者数：${currentCount}人\nあなたが参加すると${currentCount + 1}人になります。\n\n参加する場合は、下の「参加予定」を押してください。\n通知条件の変更も可能です。`;
  }
  
  function formatCallWaitInterestEndedContent(interest) {
    return `【終了済み】\n\n${interest.targetAt ? formatJstTime(new Date(interest.targetAt)) : "今回"}からの定時募集は終了しました。\n今回の興味あり登録は自動的に解除されています。\n\n設定していた通知条件：\n参加予定者が${interest.notificationThreshold}人以上になったら通知`;
  }
  
  function formatCallWaitInterestCanceledContent(interest) {
    return `【解除済み】\n\n${interest.targetAt ? formatJstTime(new Date(interest.targetAt)) : "今回"}からの定時募集に対する興味ありを解除しました。\n\nこの募集についてのDM通知は送信されません。`;
  }
  
  function formatCallWaitInterestJoinedContent(interest) {
    return `【参加予定へ変更済み】\n\n${interest.targetAt ? formatJstTime(new Date(interest.targetAt)) : "今回"}からの定時募集に、参加予定として登録しました。\n\nこれにより興味あり登録が解除されました。`;
  }
  
  function getCallWaitPromptUrl(guildId, prompt) {
    if (!guildId || !prompt?.channelId || !prompt?.messageId) return null;
    return `https://discord.com/channels/${guildId}/${prompt.channelId}/${prompt.messageId}`;
  }
  
  function formatCallWaitInterestEndNotificationContent(interest) {
    const target = interest.targetAt ? formatJstTime(new Date(interest.targetAt)) : "今回";
    return `${target}からの定時募集は終了しました。\n\n今回の興味あり登録は自動的に解除されました。\n次回の募集に興味がある場合は、新しい募集から改めて「興味あり」を押してください。`;
  }
  
  async function endCallWaitInterestsForRecruitment(guildId, recruitmentId) {
    if (!recruitmentId) return;
    const interests = await CallWaitInterest.find({ guildId, recruitmentId, status: { $in: ["pending", "active", "joining"] } }).lean();
    for (const interest of interests) {
      const ended = await CallWaitInterest.findOneAndUpdate({ _id: interest._id, status: { $in: ["pending", "active", "joining"] } }, { $set: { status: "ended", endedAt: new Date() } }, { returnDocument: "after" }).lean();
      if (!ended) continue;
      await editCallWaitInterestMessages(ended, {
        content: formatCallWaitInterestEndedContent(ended),
        components: [],
      });
      const channel = await client.channels.fetch(ended.receiptDmChannelId).catch(() => null);
      if (!ended.endNotificationSentAt) {
        await CallWaitInterest.updateOne(
          { _id: ended._id, status: "ended", endNotificationSentAt: null },
          { $inc: { endNotificationAttemptCount: 1 }, $set: { endNotificationLastAttemptAt: new Date() } },
        );
        const sent = await channel?.send?.({ content: formatCallWaitInterestEndNotificationContent(ended) }).catch(() => null);
        if (sent) await CallWaitInterest.updateOne(
          { _id: ended._id, endNotificationSentAt: null },
          { $set: { endNotificationSentAt: new Date(), endNotificationStatus: "sent" } },
        );
      }
    }
    await retryPendingCallWaitEndNotifications();
  }
  
  async function retryPendingCallWaitEndNotifications() {
    const retryBefore = new Date(Date.now() - 5 * 60 * 1000);
    const interests = await CallWaitInterest.find({
      status: "ended",
      endNotificationSentAt: null,
      endNotificationStatus: { $ne: "failed" },
      endNotificationAttemptCount: { $lt: 3 },
      $or: [
        { endNotificationLastAttemptAt: null },
        { endNotificationLastAttemptAt: { $lte: retryBefore } },
      ],
    }).lean();
    for (const interest of interests) {
      const claimed = await CallWaitInterest.findOneAndUpdate(
        {
          _id: interest._id,
          status: "ended",
          endNotificationSentAt: null,
          endNotificationStatus: { $ne: "failed" },
          endNotificationAttemptCount: { $lt: 3 },
          $or: [
            { endNotificationLastAttemptAt: null },
            { endNotificationLastAttemptAt: { $lte: retryBefore } },
          ],
        },
        {
          $inc: { endNotificationAttemptCount: 1 },
          $set: { endNotificationLastAttemptAt: new Date() },
        },
        { returnDocument: "after", lean: true },
      );
      if (!claimed) continue;
      const channel = await client.channels.fetch(claimed.receiptDmChannelId).catch(() => null);
      const message = await channel?.send?.({
        content: formatCallWaitInterestEndNotificationContent(claimed),
      }).catch(() => null);
      if (message) {
        await CallWaitInterest.updateOne(
          { _id: claimed._id, status: "ended", endNotificationSentAt: null },
          { $set: { endNotificationSentAt: new Date(), endNotificationStatus: "sent" } },
        );
      } else if (claimed.endNotificationAttemptCount >= 3) {
        await CallWaitInterest.updateOne(
          { _id: claimed._id, status: "ended", endNotificationSentAt: null },
          { $set: { endNotificationStatus: "failed" } },
        );
      }
    }
  }
  
  async function endOrphanedCallWaitInterests(guildId, promptMessageId) {
    const activeRecruitments = promptMessageId ? [promptMessageId] : [];
    const orphaned = await CallWaitInterest.find({
      guildId,
      status: { $in: ["pending", "active", "joining"] },
      ...(activeRecruitments.length ? { recruitmentId: { $nin: activeRecruitments } } : {}),
    }).distinct("recruitmentId");
    for (const recruitmentId of orphaned) {
      await endCallWaitInterestsForRecruitment(guildId, recruitmentId);
    }
  }
  
  function isCallWaitDmFailure(error) {
    return [50007, 50013, 10003, 10013].includes(Number(error?.code))
      || /DM|direct message|cannot send messages/i.test(String(error?.message ?? ""));
  }
  
  async function editDeferredEphemeralReply(interaction, payload) {
    const { flags: _flags, ...reply } = payload;
    return interaction.editReply(reply);
  }
  
  // Acknowledge a component before touching MongoDB or Discord.  The adapted
  // interaction also keeps legacy reply/update call sites on the acknowledged
  // interaction path, where Discord requires editReply instead.
  async function deferComponentResponse(interaction, responseType) {
    if (responseType === "update") {
      await interaction.deferUpdate();
    } else {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    }
    const editReply = (payload = {}) => {
      const { flags: _flags, ...reply } = payload;
      return interaction.editReply(reply);
    };
    return new Proxy(interaction, {
      get(target, property, receiver) {
        if (["reply", "update", "editReply"].includes(property)) return editReply;
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }
  
  async function deferCommandResponse(interaction, flags) {
    await interaction.deferReply({ flags });
    const editReply = (payload = {}) => {
      const { flags: _flags, ...reply } = payload;
      return interaction.editReply(reply);
    };
    return new Proxy(interaction, {
      get(target, property, receiver) {
        if (["reply", "update", "editReply"].includes(property)) return editReply;
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }
  
  // Claims the unique interest row before any DM side effect.  A stale terminal
  // row is reusable, but active workflow states can never be overwritten.
  async function registerCallWaitInterestFromPublicButton(interaction) {
    interaction = await deferComponentResponse(interaction, "reply");
    if (!interaction.inGuild()) {
      await editDeferredEphemeralReply(interaction, { content: "この操作はサーバー内の募集から行ってください。", flags: MessageFlags.Ephemeral });
      return;
    }
    const settings = await getGuildSettings(interaction.guildId);
    const prompt = settings?.callWaitPrompt;
    if (!prompt || prompt.mode !== CALL_WAIT_MODE_BUTTON || prompt.messageId !== interaction.message?.id || new Date(prompt.targetAt).getTime() <= Date.now()) {
      await editDeferredEphemeralReply(interaction, { content: "この募集は現在受け付けていません。", flags: MessageFlags.Ephemeral });
      return;
    }
    if (normalizeCallWaitMemberIds(prompt.memberIds).includes(interaction.user.id)) {
      await editDeferredEphemeralReply(interaction, { content: "すでに参加予定として登録されています。", flags: MessageFlags.Ephemeral });
      return;
    }
  
    const identity = { guildId: interaction.guildId, recruitmentId: prompt.messageId, userId: interaction.user.id };
    const now = new Date();
    const cooldownCutoff = new Date(now.getTime() - 30_000);
    const existing = await CallWaitInterest.findOne(identity).lean();
    if (["pending", "active", "joining", "joined"].includes(existing?.status)) {
      await editDeferredEphemeralReply(interaction, { content: "この募集にはすでに興味ありとして登録されています。", flags: MessageFlags.Ephemeral });
      return;
    }
    if (existing?.status === "canceled") {
      const seconds = getInterestCooldownSeconds(existing.canceledAt, now);
      if (seconds > 0) {
        await editDeferredEphemeralReply(interaction, { content: `興味ありを解除した直後です。あと${seconds}秒ほど待ってからもう一度お試しください。`, flags: MessageFlags.Ephemeral });
        return;
      }
    }
  
    const reset = {
      status: "pending", notificationThreshold: 1, targetAt: new Date(prompt.targetAt), registeredAt: now,
      canceledAt: null, endedAt: null, failedAt: null, thresholdNotificationSent: false,
      thresholdNotificationStatus: "idle", thresholdSatisfiedInReceipt: false,
      thresholdNotificationRetryCount: 0, thresholdNotificationLastTriedAt: null, thresholdNotificationLastError: null,
      renotificationEnabled: false, hadOtherInterestAtRegistration: false,
      receiptDmChannelId: null, receiptDmMessageId: null, latestThresholdDmChannelId: null, latestThresholdDmMessageId: null,
    };
    let claimed = await CallWaitInterest.findOneAndUpdate(
      {
        ...identity,
        $or: [
          { status: { $in: ["ended", "failed"] } },
          { status: "canceled", canceledAt: { $lte: cooldownCutoff } },
        ],
      },
      { $set: reset },
      { returnDocument: "after", lean: true },
    );
    if (!claimed && !existing) {
      try {
        claimed = (await CallWaitInterest.create({ ...identity, ...reset })).toObject();
      } catch (error) {
        if (error?.code !== 11000) throw error;
      }
    }
    if (!claimed) {
      const winner = await CallWaitInterest.findOne(identity).lean();
      const seconds = winner?.status === "canceled" ? getInterestCooldownSeconds(winner.canceledAt, now) : 0;
      await editDeferredEphemeralReply(interaction, {
        content: seconds > 0
          ? `興味ありを解除した直後です。あと${seconds}秒ほど待ってからもう一度お試しください。`
          : "この募集にはすでに興味ありとして登録されています。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  
    let receipt = null;
    let activeInterest = null;
    try {
      const participantCount = normalizeCallWaitMemberIds(prompt.memberIds).length;
      const hadOtherInterest = Boolean(await CallWaitInterest.exists({ ...identity, userId: { $ne: interaction.user.id }, status: "active" }));
      const thresholdSatisfiedInReceipt = participantCount >= reset.notificationThreshold;
      const dm = await interaction.user.createDM();
      receipt = await dm.send({
        content: buildCallWaitInterestReceiptContent({ targetAt: prompt.targetAt, participantCount, notificationThreshold: 1, hasOtherInterest: hadOtherInterest }),
        components: getCallWaitInterestComponents(prompt.messageId, {
          includeJoin: participantCount > 0, showThreshold: true, threshold: 1,
          linkUrl: getCallWaitPromptUrl(interaction.guildId, prompt),
        }),
      });
      const activated = await CallWaitInterest.updateOne(
        { _id: claimed._id, status: "pending" },
        { $set: { status: "active", receiptDmChannelId: dm.id, receiptDmMessageId: receipt.id, thresholdSatisfiedInReceipt, hadOtherInterestAtRegistration: hadOtherInterest } },
      );
      if (activated.matchedCount !== 1 || activated.modifiedCount !== 1) {
        throw new Error("CALL_WAIT_INTEREST_ACTIVATION_FAILED");
      }
      activeInterest = {
        ...claimed,
        status: "active",
        receiptDmChannelId: dm.id,
        receiptDmMessageId: receipt.id,
        thresholdSatisfiedInReceipt,
        hadOtherInterestAtRegistration: hadOtherInterest,
      };
    } catch (error) {
      await receipt?.edit({ content: "【登録失敗】\n\n興味ありの登録を完了できませんでした。", components: [] }).catch((error) => logRecoverableError("Failed to update failed call-wait interest receipt", error));
      await CallWaitInterest.updateOne({ _id: claimed._id, status: "pending" }, { $set: { status: "failed", failedAt: new Date() } }).catch((error) => logRecoverableError("Failed to persist failed call-wait interest", error));
      await editDeferredEphemeralReply(interaction, {
        content: isCallWaitDmFailure(error)
          ? "DMを送信できなかったため、興味ありとして登録できませんでした。"
          : "興味ありの登録処理中にエラーが発生しました。時間を空けて、もう一度お試しください。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  
    // Stage 2: notification/log/reply failures must never revoke a confirmed
    // interest registration or replace its successful receipt.
    try {
      if (!activeInterest.thresholdSatisfiedInReceipt) {
        await notifyCallWaitInterests(interaction.guildId, prompt.messageId);
      }
    } catch (error) {
      await sendOperationalLog({
        guild: interaction.guild,
        settings,
        fallbackChannel: null,
        content: `興味あり登録後の付随処理に失敗しました。募集ID: ${prompt.messageId}、ユーザーID: ${interaction.user.id}、エラー: ${error?.stack ?? error}`,
      }).catch((error) => logRecoverableError("Recoverable asynchronous operation failed", error));
    }
    await sendCallWaitApplicantLog({
      guild: interaction.guild,
      settings,
      action: "interest",
      userId: interaction.user.id,
      memberIds: prompt.memberIds,
      recruitmentId: prompt.messageId,
    });
    await interaction.editReply({
      content: "興味ありとして登録しました。\n通知条件の確認や変更は、Botから届いたDMで行えます。",
      flags: MessageFlags.Ephemeral,
    }).catch((error) => sendOperationalLog({
      guild: interaction.guild,
      settings,
      fallbackChannel: null,
      content: `興味あり登録の成功応答に失敗しました。募集ID: ${prompt.messageId}、ユーザーID: ${interaction.user.id}、エラー: ${error?.stack ?? error}`,
    }).catch((error) => logRecoverableError("Recoverable asynchronous operation failed", error)));
  }
  
  async function cancelCallWaitInterestFromPublicButton(interaction) {
    if (!interaction.inGuild()) return false;
    const interest = await CallWaitInterest.findOne({ guildId: interaction.guildId, recruitmentId: interaction.message?.id, userId: interaction.user.id, status: "active" }).lean();
    if (!interest) return false;
    await endCallWaitInterest(interest, "canceled");
    await sendCallWaitInterestStateLog({
      guildId: interaction.guildId,
      recruitmentId: interest.recruitmentId,
      userId: interaction.user.id,
      action: "interest_cancel",
    }).catch((error) => logRecoverableError("Failed to log call-wait interest cancellation", error));
    await interaction.reply({ content: "興味ありを解除しました。\nこの募集についてのDM通知は送信されません。", flags: MessageFlags.Ephemeral });
    return true;
  }
  
  async function cancelCallWaitInterestFromDm(interaction) {
    interaction = await deferComponentResponse(interaction, "update");
    const recruitmentId = interaction.customId.slice("call_wait_interest_cancel:".length);
    const interest = await CallWaitInterest.findOne({ recruitmentId, userId: interaction.user.id, status: "active" }).lean();
    if (!interest) { await interaction.reply({ content: "この募集の興味あり登録は、すでに解除されています。", flags: MessageFlags.Ephemeral }); return; }
    await endCallWaitInterest(interest, "canceled");
    await sendCallWaitInterestStateLog({
      guildId: interest.guildId,
      recruitmentId,
      userId: interaction.user.id,
      action: "interest_cancel",
    }).catch((error) => logRecoverableError("Failed to log call-wait interest cancellation", error));
    await interaction.update({ content: formatCallWaitInterestCanceledContent(interest), components: [] });
  }
  
  async function endCallWaitInterest(interest, status) {
    const update = status === "joined" ? { status, joinedAt: new Date() } : status === "ended" ? { status, endedAt: new Date() } : { status, canceledAt: new Date() };
    const changed = await CallWaitInterest.findOneAndUpdate(
      { _id: interest._id, status: "active" },
      { $set: update },
      { returnDocument: "after", lean: true },
    );
    if (!changed) return;
    if (status === "canceled") {
      await editCallWaitInterestMessages(changed, { content: formatCallWaitInterestCanceledContent(changed), components: [] });
    }
    if (status === "joined") {
      await editCallWaitInterestMessages(changed, { content: formatCallWaitInterestJoinedContent(changed), components: [] });
    }
  }
  
  async function cancelJoinedCallWaitInterest({ guildId, recruitmentId, userId }) {
    const canceledInterest = await CallWaitInterest.findOneAndUpdate(
      {
        guildId,
        recruitmentId,
        userId,
        status: "joined",
      },
      {
        $set: {
          status: "canceled",
          canceledAt: new Date(),
        },
        $unset: {
          joinedAt: 1,
        },
      },
      { returnDocument: "after", lean: true },
    );
    if (canceledInterest) {
      await editCallWaitInterestMessages(canceledInterest, {
        content: formatCallWaitInterestCanceledContent(canceledInterest),
        components: [],
      });
    }
    return canceledInterest;
  }
  
  async function editCallWaitInterestMessages(interest, payload) {
    const refs = new Map();
    for (const [channelId, messageId] of [
      [interest.receiptDmChannelId, interest.receiptDmMessageId],
      [interest.latestThresholdDmChannelId, interest.latestThresholdDmMessageId],
    ]) {
      if (channelId && messageId) refs.set(`${channelId}:${messageId}`, { channelId, messageId });
    }
    await Promise.all([...refs.values()].map(async ({ channelId, messageId }) => {
      const channel = await client.channels.fetch(channelId).catch(() => null);
      const message = await channel?.messages?.fetch?.(messageId).catch(() => null);
      await message?.edit(payload).catch((error) => logRecoverableError("Failed to update call-wait interest receipt", error));
    }));
  }
  
  async function handleCallWaitInterestThresholdSelect(interaction) {
    interaction = await deferComponentResponse(interaction, "update");
    const recruitmentId = interaction.customId.slice(`${CALL_WAIT_INTEREST_SELECT_CUSTOM_ID}:`.length);
    const threshold = Number(interaction.values[0]);
    if (![1, 2, 3].includes(threshold)) {
      await interaction.reply({ content: "通知条件が不正です。", flags: MessageFlags.Ephemeral });
      return;
    }
    const current = await CallWaitInterest.findOne({ recruitmentId, userId: interaction.user.id, status: "active" }).lean();
    if (!current) {
      await interaction.reply({ content: "この募集の興味あり登録は、すでに終了しています。", flags: MessageFlags.Ephemeral });
      return;
    }
    if (current.thresholdNotificationStatus === "processing") {
      await interaction.reply({ content: "通知処理中のため、現在は通知条件を変更できません。少し待ってからもう一度お試しください。", flags: MessageFlags.Ephemeral });
      return;
    }
    const interest = await CallWaitInterest.findOneAndUpdate(
      {
        _id: current._id,
        status: "active",
        $or: [
          { thresholdNotificationSent: false, thresholdNotificationStatus: { $in: [null, "idle", "failed"] } },
          { thresholdSatisfiedInReceipt: true, thresholdNotificationStatus: { $ne: "processing" } },
        ],
      },
      {
        $set: {
          notificationThreshold: threshold,
          thresholdNotificationSent: false,
          thresholdNotificationStatus: "idle",
          thresholdSatisfiedInReceipt: false,
          renotificationEnabled: false,
        },
      },
      { returnDocument: "after", lean: true },
    );
    if (!interest) {
      await interaction.reply({ content: "通知処理中のため、現在は通知条件を変更できません。少し待ってからもう一度お試しください。", flags: MessageFlags.Ephemeral });
      return;
    }
    const settings = await getGuildSettings(interest.guildId);
    const prompt = settings?.callWaitPrompt;
    const count = prompt?.messageId === recruitmentId ? normalizeCallWaitMemberIds(prompt.memberIds).length : 0;
    await interaction.editReply({
      content: buildCallWaitInterestReceiptContent({
        targetAt: prompt?.targetAt ?? interest.targetAt,
        participantCount: count,
        notificationThreshold: interest.notificationThreshold,
        hasOtherInterest: interest.hadOtherInterestAtRegistration,
      }),
      components: getCallWaitInterestComponents(recruitmentId, {
        includeJoin: count > 0,
        showThreshold: true,
        threshold: interest.notificationThreshold,
        linkUrl: getCallWaitPromptUrl(interest.guildId, prompt),
      }),
    });
    await notifyCallWaitInterests(interest.guildId, recruitmentId);
  }
  
  /**
   * Registers a participant exactly once across the public prompt and an interest DM.
   * The interest document is used as a short-lived, unique join lock before changing
   * the recruitment document, so two simultaneous component clicks cannot both win.
   */
  async function registerCallWaitParticipant({ guildId, recruitmentId, userId, source }) {
    const settings = await getGuildSettings(guildId);
    const prompt = settings?.callWaitPrompt;
    if (!prompt || prompt.messageId !== recruitmentId || new Date(prompt.targetAt).getTime() <= Date.now()) {
      return { ok: false, reason: "expired" };
    }
    if (normalizeCallWaitMemberIds(prompt.memberIds).includes(userId)) {
      return { ok: false, reason: "already_joined" };
    }
  
    let lock = await CallWaitInterest.findOneAndUpdate(
      { guildId, recruitmentId, userId, status: "active" },
      { $set: { status: "joining" } },
      { returnDocument: "before", lean: true },
    );
    let restoreStatus = lock ? "active" : "canceled";
    if (!lock) {
      try {
        lock = await CallWaitInterest.findOneAndUpdate(
          { guildId, recruitmentId, userId, status: { $nin: ["pending", "active", "joining", "joined"] } },
          { $set: { status: "joining", registeredAt: new Date(), canceledAt: null, notificationThreshold: 1, thresholdNotificationSent: false, renotificationEnabled: false } },
          { upsert: true, returnDocument: "before", setDefaultsOnInsert: true, lean: true },
        );
      } catch (error) {
        if (error?.code === 11000) return { ok: false, reason: "in_progress" };
        throw error;
      }
    }
  
    const updatedSettings = await updateCallWaitPromptMember({
      guildId,
      messageId: recruitmentId,
      userId,
      operation: "add",
    });
    if (!updatedSettings) {
      await CallWaitInterest.updateOne(
        { guildId, recruitmentId, userId, status: "joining" },
        { $set: { status: restoreStatus, ...(restoreStatus === "canceled" ? { canceledAt: new Date() } : {}) } },
      ).catch((error) => logRecoverableError("Recoverable asynchronous operation failed", error));
      return { ok: false, reason: "expired" };
    }
  
    const joined = await CallWaitInterest.findOneAndUpdate(
      { guildId, recruitmentId, userId, status: "joining" },
      { $set: { status: "joined", joinedAt: new Date() } },
      { returnDocument: "before", lean: true },
    );
    if (!joined) {
      // The participant list was already updated, so compensate before
      // reporting failure; never treat a missing joining -> joined transition as
      // a successful registration.
      await updateCallWaitPromptMember({ guildId, messageId: recruitmentId, userId, operation: "remove" }).catch((error) => logRecoverableError("Recoverable asynchronous operation failed", error));
      await CallWaitInterest.updateOne(
        { guildId, recruitmentId, userId, status: "joining" },
        { $set: { status: restoreStatus, ...(restoreStatus === "canceled" ? { canceledAt: new Date() } : {}) } },
      ).catch((error) => logRecoverableError("Recoverable asynchronous operation failed", error));
      return { ok: false, reason: "finalization_failed" };
    }
    if (joined) {
      await editCallWaitInterestMessages(joined ?? lock, {
        content: formatCallWaitInterestJoinedContent(joined ?? lock),
        components: [],
      });
    }
    return { ok: true, settings: updatedSettings, interest: joined ?? lock, source };
  }
  
  /** Applies every externally visible consequence of a successful participant add.
   * Both the public prompt and an interest DM call this so their state cannot
   * diverge after the shared atomic registration succeeds. */
  async function finalizeCallWaitParticipantRegistration({ guild, settings, recruitmentId, userId, source }) {
    const latestSettings = await getGuildSettings(guild.id);
    const prompt = latestSettings?.callWaitPrompt;
    if (!prompt || prompt.messageId !== recruitmentId) return latestSettings;
    const memberIds = normalizeCallWaitMemberIds(prompt.memberIds);
    await refreshCallWaitPromptMessage(guild, prompt);
    await sendCallWaitApplicantLog({
      guild,
      settings: latestSettings ?? settings,
      action: "join",
      userId,
      memberIds,
      recruitmentId,
      source,
    });
    await notifyCallWaitInterests(guild.id, recruitmentId);
    return latestSettings;
  }
  
  async function joinCallWaitFromInterestDm(interaction) {
    interaction = await deferComponentResponse(interaction, "update");
    const recruitmentId = interaction.customId.slice("call_wait_interest_join:".length);
    const interest = await CallWaitInterest.findOne({ recruitmentId, userId: interaction.user.id, status: "active" }).lean();
    if (!interest) { await interaction.reply({ content: "この募集の興味あり登録は、すでに解除されています。", flags: MessageFlags.Ephemeral }); return; }
    const guild = client.guilds.cache.get(interest.guildId) ?? await client.guilds.fetch(interest.guildId).catch(() => null);
    const member = await guild?.members.fetch(interaction.user.id).catch(() => null);
    if (!member) { await interaction.reply({ content: "対象のサーバーに参加していないため、参加予定として登録できませんでした。", flags: MessageFlags.Ephemeral }); return; }
    const result = await registerCallWaitParticipant({ guildId: interest.guildId, recruitmentId, userId: interaction.user.id, source: "interest_dm" });
    if (!result.ok) { await interaction.reply({ content: result.reason === "already_joined" ? "すでに参加予定として登録されています。" : "募集がすでに終了または更新されているため、操作を受け付けることができませんでした。", flags: MessageFlags.Ephemeral }); return; }
    await finalizeCallWaitParticipantRegistration({
      guild,
      settings: result.settings,
      recruitmentId,
      userId: interaction.user.id,
      source: "interest_dm",
    });
    await interaction.update({ content: `【参加予定へ変更済み】\n\n${formatJstTime(new Date(result.settings.callWaitPrompt.targetAt))}からの定時募集に、参加予定として登録しました。\n\nこれにより興味あり登録が解除されました。`, components: [] });
  }
  
  async function reconcileCallWaitInterestThresholds(guildId, recruitmentId) {
    const settings = await getGuildSettings(guildId); const prompt = settings?.callWaitPrompt;
    if (!prompt || prompt.messageId !== recruitmentId) return;
    const count = normalizeCallWaitMemberIds(prompt.memberIds).length;
    const linkUrl = getCallWaitPromptUrl(guildId, prompt);
    const interests = await CallWaitInterest.find({
      guildId,
      recruitmentId,
      status: "active",
      renotificationEnabled: false,
      notificationThreshold: { $gt: count },
      $or: [
        { thresholdNotificationSent: true, thresholdNotificationStatus: "sent" },
        { thresholdSatisfiedInReceipt: true, thresholdNotificationSent: false, thresholdNotificationStatus: "idle" },
      ],
    }).lean();
    for (const interest of interests) {
      let claimed = null;
      try {
      const receiptBacked = interest.thresholdSatisfiedInReceipt === true && interest.thresholdNotificationSent === false;
      claimed = await CallWaitInterest.findOneAndUpdate(
        receiptBacked
          ? {
            _id: interest._id,
            status: "active",
            thresholdSatisfiedInReceipt: true,
            thresholdNotificationSent: false,
            thresholdNotificationStatus: "idle",
            renotificationEnabled: false,
            notificationThreshold: { $gt: count },
          }
          : {
            _id: interest._id,
            status: "active",
            thresholdNotificationSent: true,
            thresholdNotificationStatus: "sent",
            renotificationEnabled: false,
            notificationThreshold: { $gt: count },
          },
        {
          $set: {
            thresholdSatisfiedInReceipt: false,
            thresholdNotificationSent: true,
            thresholdNotificationStatus: "processing",
            thresholdNotificationLastTriedAt: new Date(),
            thresholdNotificationLastError: null,
          },
          $inc: { thresholdNotificationRetryCount: 1 },
        },
        { returnDocument: "after", lean: true },
      );
      if (!claimed) continue;
      const sourceChannelId = receiptBacked ? claimed.receiptDmChannelId : claimed.latestThresholdDmChannelId;
      const sourceMessageId = receiptBacked ? claimed.receiptDmMessageId : claimed.latestThresholdDmMessageId;
      const channel = await client.channels.fetch(sourceChannelId).catch(() => null);
      const message = await channel?.messages?.fetch?.(sourceMessageId).catch(() => null);
      const payload = {
        content: `【参加予定者数が条件を下回りました】\n\n${formatJstTime(new Date(prompt.targetAt))}からの定時募集は、一度通知条件を満たしましたが、その後参加予定者が減少しました。\n\n現在の参加予定者数：${count}人\n\n再び通知条件を満たした際にお知らせを受け取りたい場合は、下の「再び集まったら通知する」を押してください。`,
        components: getCallWaitInterestComponents(recruitmentId, { linkUrl, allowRenotification: true }),
      };
      let edited = false;
      if (message) edited = await message.edit(payload).then(() => true).catch(() => false);
      if (!edited) {
        const replacement = channel?.send
          ? await channel.send(payload).catch(() => null)
          : null;
        if (replacement) {
          const persisted = await CallWaitInterest.updateOne({ _id: claimed._id, status: "active", thresholdNotificationStatus: "processing" }, {
            $set: {
              thresholdNotificationStatus: "sent",
              ...(receiptBacked ? { receiptDmChannelId: replacement.channelId, receiptDmMessageId: replacement.id } : { latestThresholdDmChannelId: replacement.channelId, latestThresholdDmMessageId: replacement.id }),
            },
          });
          if (persisted.matchedCount !== 1) {
            throw new Error("CALL_WAIT_THRESHOLD_NOTIFICATION_STATE_CHANGED");
          }
        } else {
          const failed = await CallWaitInterest.updateOne(
            { _id: claimed._id, status: "active", thresholdNotificationStatus: "processing" },
            {
              $set: {
                thresholdNotificationStatus: "failed",
                thresholdNotificationLastTriedAt: new Date(),
                thresholdNotificationLastError: "The threshold DM could not be edited or resent.",
              },
            },
          );
          if (failed.matchedCount !== 1) {
            throw new Error("CALL_WAIT_THRESHOLD_NOTIFICATION_STATE_CHANGED");
          }
          const guild = client.guilds.cache.get(guildId) ?? await client.guilds.fetch(guildId).catch(() => null);
          await sendOperationalLog({
            guild,
            settings: await getGuildSettings(guildId).catch(() => null),
            fallbackChannel: null,
            content: `興味あり人数減少DMの再送に失敗しました。募集ID: ${recruitmentId}、ユーザーID: ${interest.userId}`,
          }).catch((error) => logRecoverableError("Recoverable asynchronous operation failed", error));
        }
      } else {
        const persisted = await CallWaitInterest.updateOne(
          { _id: claimed._id, status: "active", thresholdNotificationStatus: "processing" },
          { $set: { thresholdNotificationStatus: "sent" } },
        );
        if (persisted.matchedCount !== 1) {
          throw new Error("CALL_WAIT_THRESHOLD_NOTIFICATION_STATE_CHANGED");
        }
      }
      } catch (error) {
        if (claimed) {
          await CallWaitInterest.updateOne(
            { _id: claimed._id, status: "active", thresholdNotificationStatus: "processing" },
            {
              $set: {
                thresholdNotificationStatus: "failed",
                thresholdNotificationLastTriedAt: new Date(),
                thresholdNotificationLastError: error?.message ?? String(error),
              },
            },
          ).catch((markError) => console.error("Failed to mark threshold notification failure:", markError));
        }
        await sendOperationalLog({
          guild: client.guilds.cache.get(guildId),
          settings,
          fallbackChannel: null,
          content: `興味あり人数減少通知の処理に失敗しました。募集ID: ${recruitmentId}、ユーザーID: ${interest.userId}、エラー: ${error?.stack ?? error}`,
        }).catch((logError) => console.error(logError));
      }
    }
  }
  
  async function enableCallWaitInterestRenotification(interaction) {
    interaction = await deferComponentResponse(interaction, "update");
    const recruitmentId = interaction.customId.slice("call_wait_interest_renotify:".length);
    const interest = await CallWaitInterest.findOne({ recruitmentId, userId: interaction.user.id, status: "active", thresholdNotificationSent: true }).lean();
    if (!interest) { await interaction.reply({ content: "この募集の興味あり登録は、すでに終了しています。", flags: MessageFlags.Ephemeral }); return; }
    const settings = await getGuildSettings(interest.guildId); const prompt = settings?.callWaitPrompt;
    const targetAt = new Date(prompt?.targetAt);
    const recruitmentIsActive = Boolean(
      prompt
        && prompt.messageId === recruitmentId
        && Number.isFinite(targetAt.getTime())
        && targetAt.getTime() > Date.now(),
    );
    if (!recruitmentIsActive) {
      await interaction.editReply({
        content: "この募集はすでに終了しています。",
        components: [],
      });
      return;
    }
    const count = prompt?.messageId === recruitmentId ? normalizeCallWaitMemberIds(prompt.memberIds).length : -1;
    const enabled = await CallWaitInterest.findOneAndUpdate(
      {
        _id: interest._id,
        recruitmentId,
        status: "active",
        thresholdNotificationSent: true,
        renotificationEnabled: false,
      },
      { $set: { renotificationEnabled: true, thresholdNotificationStatus: "idle" } },
      { returnDocument: "after", lean: true },
    );
    if (!enabled) { await interaction.reply({ content: "この再通知はすでに処理されています。", flags: MessageFlags.Ephemeral }); return; }
    await interaction.update({
      content: count >= enabled.notificationThreshold
        ? "【再通知を受け付けました】\n\n新しい到達通知を送信します。"
        : `【再通知を受け付けました】\n\n参加予定者が再び${enabled.notificationThreshold}人以上になった際に、DMでお知らせします。\n\n現在の参加予定者数：${Math.max(0, count)}人`,
      components: getCallWaitInterestComponents(recruitmentId, {
        includeJoin: false,
        showThreshold: false,
        allowRenotification: false,
        linkUrl: getCallWaitPromptUrl(interest.guildId, prompt),
      }),
    });
    await notifyCallWaitInterests(interest.guildId, recruitmentId);
  }
  
  async function refreshCallWaitPromptMessage(guild, prompt) {
    const channel = await resolveConfiguredTextChannel(guild, prompt?.channelId);
    const message = await channel?.messages?.fetch?.(prompt?.messageId).catch(() => null);
    await message?.edit({ content: formatCallWaitPromptV2(new Date(prompt.targetAt), prompt.memberIds), components: [createCallWaitInterestRow()] }).catch((error) => logRecoverableError("Failed to update call-wait prompt after interest cancellation", error));
  }
  
  async function notifyCallWaitInterests(guildId, recruitmentId) {
    const settings = await getGuildSettings(guildId); const prompt = settings?.callWaitPrompt;
    if (!prompt || prompt.messageId !== recruitmentId) return;
    const count = normalizeCallWaitMemberIds(prompt.memberIds).length;
    const linkUrl = getCallWaitPromptUrl(guildId, prompt);
    const interests = await CallWaitInterest.find({ guildId, recruitmentId, status: "active" }).lean();
    for (const interest of interests) {
      let claimed = null;
      let notificationType = "initial";
      try {
      if (count < interest.notificationThreshold) continue;
      // The receipt is the initial notification when the threshold was already
      // satisfied at registration time.
      if (!interest.renotificationEnabled && interest.thresholdSatisfiedInReceipt) continue;
      notificationType = interest.renotificationEnabled ? "renotification" : "initial";
      claimed = await CallWaitInterest.findOneAndUpdate(
        notificationType === "renotification"
          ? { _id: interest._id, status: "active", thresholdNotificationSent: true, renotificationEnabled: true, thresholdNotificationStatus: { $in: [null, "idle", "failed"] }, notificationThreshold: { $lte: count } }
          : { _id: interest._id, status: "active", thresholdNotificationSent: false, thresholdNotificationStatus: { $in: [null, "idle", "failed"] }, notificationThreshold: { $lte: count } },
        {
          $set: {
            thresholdNotificationStatus: "processing",
            thresholdNotificationLastTriedAt: new Date(),
            thresholdNotificationLastError: null,
            ...(notificationType === "renotification" ? { renotificationEnabled: false } : {}),
          },
          $inc: { thresholdNotificationRetryCount: 1 },
        },
        { returnDocument: "after", lean: true },
      );
      if (!claimed) continue;
      const channel = await client.channels.fetch(claimed.receiptDmChannelId).catch(() => null);
      const title = notificationType === "renotification" ? "【参加予定者が再び集まりました】" : "【参加予定者が集まりました】";
      const thresholdSentence = notificationType === "renotification"
        ? `参加予定者数が再び通知条件の${claimed.notificationThreshold}人に達しました。`
        : `参加予定者数が通知条件として設定した${claimed.notificationThreshold}人に達しました。`;
      let sendError = null;
      const message = await channel?.send?.({ content: `${title}\n\n${formatJstTime(new Date(prompt.targetAt))}からの定時募集で、${thresholdSentence}\n\n現在の参加予定者数：${count}人\n\n参加する場合は、下の「参加予定」を押してください。`, components: getCallWaitInterestComponents(recruitmentId, { includeJoin: true, linkUrl }) }).catch((error) => {
        sendError = error;
        return null;
      });
      if (message) {
        const persisted = await CallWaitInterest.updateOne(
          { _id: claimed._id, status: "active", thresholdNotificationStatus: "processing" },
          { $set: { thresholdNotificationSent: true, thresholdNotificationStatus: "sent", thresholdSatisfiedInReceipt: false, renotificationEnabled: false, thresholdNotificationLastError: null, latestThresholdDmChannelId: message.channelId, latestThresholdDmMessageId: message.id } },
        );
        if (persisted.matchedCount !== 1 || persisted.modifiedCount !== 1) {
          await message.edit({ content: "【操作できません】\n\nこの募集の状態が変更されたため、この通知からは操作できません。", components: [] }).catch((error) => logRecoverableError("Failed to disable stale call-wait interest message", error));
          await sendOperationalLog({ guild: client.guilds.cache.get(guildId), settings, fallbackChannel: null, content: `興味あり到達DMの確定に失敗しました。募集ID: ${recruitmentId}、ユーザーID: ${claimed.userId}` }).catch((error) => logRecoverableError("Recoverable asynchronous operation failed", error));
          continue;
        }
        const receipt = await channel?.messages?.fetch?.(interest.receiptDmMessageId).catch(() => null);
        await receipt?.edit({
          components: getCallWaitInterestComponents(recruitmentId, { includeJoin: true, linkUrl }),
        }).catch((error) => logRecoverableError("Recoverable asynchronous operation failed", error));
      } else {
        const failurePatch = notificationType === "renotification"
          ? { thresholdNotificationStatus: "failed", renotificationEnabled: true, thresholdNotificationLastError: sendError?.message ?? "DM channel is unavailable" }
          : { thresholdNotificationSent: false, thresholdNotificationStatus: "failed", thresholdNotificationLastError: sendError?.message ?? "DM channel is unavailable" };
        await CallWaitInterest.updateOne({ _id: claimed._id, thresholdNotificationStatus: "processing" }, { $set: failurePatch });
        await sendOperationalLog({
          guild: client.guilds.cache.get(guildId),
          settings,
          fallbackChannel: null,
          content: `興味あり到達DMの送信に失敗しました。募集ID: ${recruitmentId}、ユーザーID: ${claimed.userId}、種別: ${notificationType}、発生日時: ${new Date().toISOString()}、エラー: ${sendError?.stack ?? sendError?.message ?? "DMチャンネルを取得できませんでした"}`,
        }).catch((error) => logRecoverableError("Recoverable asynchronous operation failed", error));
      }
      } catch (error) {
        if (claimed) {
          const failurePatch = notificationType === "renotification"
            ? { thresholdNotificationStatus: "failed", renotificationEnabled: true, thresholdNotificationLastError: error?.message ?? String(error) }
            : { thresholdNotificationSent: false, thresholdNotificationStatus: "failed", thresholdNotificationLastError: error?.message ?? String(error) };
          await CallWaitInterest.updateOne(
            { _id: claimed._id, status: "active", thresholdNotificationStatus: "processing" },
            { $set: failurePatch },
          ).catch((error) => logRecoverableError("Recoverable asynchronous operation failed", error));
        }
        await sendOperationalLog({
          guild: client.guilds.cache.get(guildId),
          settings,
          fallbackChannel: null,
          content: `興味あり通知処理中にエラーが発生しました。\n募集ID: ${recruitmentId}\nユーザーID: ${interest.userId}\nエラー: ${error?.stack ?? error}`,
        }).catch((error) => logRecoverableError("Recoverable asynchronous operation failed", error));
      }
    }
  }
  
  async function handleCallWaitButton(interaction) {
    if (interaction.customId.startsWith("call_wait_interest_renotify:")) {
      await enableCallWaitInterestRenotification(interaction);
      return;
    }
    if (interaction.customId === CALL_WAIT_INTEREST_CUSTOM_ID) {
      await registerCallWaitInterestFromPublicButton(interaction);
      return;
    }
    if (interaction.customId.startsWith("call_wait_interest_join:")) {
      await joinCallWaitFromInterestDm(interaction);
      return;
    }
    if (interaction.customId.startsWith("call_wait_interest_cancel:")) {
      await cancelCallWaitInterestFromDm(interaction);
      return;
    }
    if (!interaction.inGuild()) {
      await interaction.reply({
        content: "このボタンはサーバー内で使ってください。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  
    interaction = await deferComponentResponse(interaction, "reply");
  
    const settings = await getGuildSettings(interaction.guildId);
    const prompt = settings?.callWaitPrompt;
    const isJoin = interaction.customId === CALL_WAIT_JOIN_CUSTOM_ID;
    const promptMessageId = isJoin || interaction.customId === CALL_WAIT_CANCEL_CUSTOM_ID
      ? interaction.message?.id
      : interaction.customId.slice(`${CALL_WAIT_CANCEL_CUSTOM_ID}:`.length);
  
    if (
      !prompt ||
      prompt.mode !== CALL_WAIT_MODE_BUTTON ||
      prompt.messageId !== promptMessageId
    ) {
      await interaction.reply({
        content: "この募集は現在有効ではありません。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  
    const targetAt = new Date(prompt.targetAt);
    if (!Number.isFinite(targetAt.getTime()) || targetAt.getTime() <= Date.now()) {
      await interaction.reply({
        content: "この募集は締め切られています。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  
    const memberIds = normalizeCallWaitMemberIds(prompt.memberIds);
    const userId = interaction.user.id;
    const activeInterest = !isJoin
      ? await CallWaitInterest.findOne({
        guildId: interaction.guildId,
        recruitmentId: prompt.messageId,
        userId,
        status: "active",
      }).lean()
      : null;
    const joinedInterest = !isJoin
      ? await CallWaitInterest.findOne({
        guildId: interaction.guildId,
        recruitmentId: prompt.messageId,
        userId,
        status: "joined",
      }).lean()
      : null;
  
    if (isJoin && memberIds.includes(userId)) {
      await interaction.reply({
        content: "すでに参加予定として登録されています。\n取り消す場合は、募集メッセージの「キャンセル」を押してください。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  
    if (!isJoin && !memberIds.includes(userId)) {
      if (activeInterest) {
        await endCallWaitInterest(activeInterest, "canceled");
        await sendCallWaitApplicantLog({
          guild: interaction.guild,
          settings,
          action: "interest_cancel",
          userId,
          memberIds,
          recruitmentId: prompt.messageId,
        });
        await interaction.reply({
          content: "興味ありを解除しました。\nこの募集についてのDM通知は送信されません。",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      await interaction.reply({
        content: "この募集には、参加予定または興味ありとして登録されていません。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  
    const participantResult = isJoin
      ? await registerCallWaitParticipant({
        guildId: interaction.guildId,
        recruitmentId: prompt.messageId,
        userId,
        source: "public_prompt",
      })
      : null;
    const updatedPrompt = isJoin
      ? participantResult?.settings
      : await updateCallWaitPromptMember({
        guildId: interaction.guildId,
        messageId: prompt.messageId,
        userId,
        operation: "remove",
      });
    if (!updatedPrompt) {
      await interaction.reply({
        content: participantResult?.reason === "already_joined"
          ? "すでに参加予定として登録されています。"
          : "この募集はすでに更新されています。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (!isJoin && joinedInterest) {
      const canceledInterest = await cancelJoinedCallWaitInterest({
        guildId: interaction.guildId,
        recruitmentId: prompt.messageId,
        userId,
      });
      if (!canceledInterest) {
        const restoredPrompt = await updateCallWaitPromptMember({
          guildId: interaction.guildId,
          messageId: prompt.messageId,
          userId,
          operation: "add",
        });
        const remainingJoinedInterest = await CallWaitInterest.exists({
          guildId: interaction.guildId,
          recruitmentId: prompt.messageId,
          userId,
          status: "joined",
        });
        if (!restoredPrompt || remainingJoinedInterest) {
          await sendOperationalLog({
            guild: interaction.guild,
            settings,
            fallbackChannel: null,
            content: `参加予定キャンセルの整合性回復に失敗しました。募集ID: ${prompt.messageId}、ユーザーID: ${userId}`,
          }).catch((error) => logRecoverableError("Failed to report call-wait cancellation inconsistency", error));
        }
        await interaction.editReply({
          content: "参加予定のキャンセル状態を確定できませんでした。参加予定は維持されています。もう一度お試しください。",
        });
        return;
      }
    }
    const nextMemberIds = normalizeCallWaitMemberIds(updatedPrompt.callWaitPrompt?.memberIds);
    const nextTargetAt = new Date(updatedPrompt.callWaitPrompt?.targetAt ?? prompt.targetAt);
  
    // Keep the public募集 message and its count in sync with the atomically
    // updated participant list. Fetch settings again so a concurrent click is
    // reflected whenever possible.
    const latestSettings = await getGuildSettings(interaction.guildId);
    const latestPrompt = latestSettings?.callWaitPrompt;
    const promptForDisplay = latestPrompt?.messageId === prompt.messageId
      ? latestPrompt
      : latestPrompt
        ? null
        : updatedPrompt.callWaitPrompt;
    const displayedMemberIds = normalizeCallWaitMemberIds(promptForDisplay?.memberIds ?? nextMemberIds);
    const displayedTargetAt = new Date(promptForDisplay?.targetAt ?? nextTargetAt);
    if (
      !isJoin &&
      promptForDisplay?.messageId === prompt.messageId &&
      interaction.message &&
      typeof interaction.message.edit === "function"
    ) {
      await interaction.message.edit({
        content: formatCallWaitPromptV2(displayedTargetAt, displayedMemberIds),
        components: [createCallWaitInterestRow()],
      }).catch((error) => {
        console.error(`Failed to update call wait prompt message: ${error.message}`);
      });
    }
  
    if (isJoin) {
      await finalizeCallWaitParticipantRegistration({
        guild: interaction.guild,
        settings: latestSettings ?? settings,
        recruitmentId: prompt.messageId,
        userId,
        source: "public_prompt",
      });
    } else {
      if (activeInterest) await endCallWaitInterest(activeInterest, "canceled");
      await sendCallWaitApplicantLog({
        guild: interaction.guild,
        settings: latestSettings ?? settings,
        action: "cancel",
        userId,
        memberIds: displayedMemberIds,
        recruitmentId: prompt.messageId,
      });
    }
  
    if (!isJoin) {
      await reconcileCallWaitInterestThresholds(interaction.guildId, prompt.messageId);
    }
  
    if (isJoin) {
      await interaction.reply({
        content: "参加予定を受け付けました。\n取り消す場合は、募集メッセージの「キャンセル」を押してください。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  
    await interaction.reply({
      content: "参加予定を取り消しました。",
      flags: MessageFlags.Ephemeral,
    });
  }
  
  async function sendCallWaitApplicantLog({
    guild,
    settings,
    action,
    userId = null,
    memberIds,
    recruitmentId = null,
    source = null,
  }) {
    const actionLabel =
      action === "join"
        ? "希望ボタンが押されました"
        : action === "cancel"
          ? "希望キャンセルボタンが押されました"
          : action === "interest"
            ? "興味ありボタンが押されました"
            : action === "interest_cancel"
              ? "興味あり解除ボタンが押されました"
              : "希望者リストをリセットしました";
    const list = await formatCallWaitApplicantList(guild, memberIds);
    const interestList = await formatCallWaitInterestList(guild, recruitmentId);
    const lines = [
      `通話待機システム: ${actionLabel}`,
      `操作ユーザー: ${userId ? `<@${userId}>` : "システム"}`,
      ...(action === "join" ? [`操作元: ${source === "interest_dm" ? "DM" : "公開募集メッセージ"}`] : []),
      "現在の通話希望者:",
      list,
      "現在の興味あり:",
      interestList,
    ];
  
    await sendOperationalLog({
      guild,
      settings,
      fallbackChannel: null,
      content: lines.join("\n"),
      allowedMentions: { parse: [] },
    });
  }
  
  async function sendCallWaitInterestStateLog({ guildId, recruitmentId, userId, action }) {
    const guild =
      client.guilds.cache.get(guildId) ??
      (await client.guilds.fetch(guildId).catch(() => null));
    if (!guild) return;
  
    const settings = await getGuildSettings(guild.id);
    const prompt = settings?.callWaitPrompt?.messageId === recruitmentId
      ? settings.callWaitPrompt
      : null;
    await sendCallWaitApplicantLog({
      guild,
      settings,
      action,
      userId,
      memberIds: normalizeCallWaitMemberIds(prompt?.memberIds),
      recruitmentId,
    });
  }
  
  async function formatCallWaitApplicantList(guild, memberIds) {
    const uniqueMemberIds = normalizeCallWaitMemberIds(memberIds);
  
    if (uniqueMemberIds.length === 0) {
      return "なし";
    }
  
    const lines = [];
  
    for (const memberId of uniqueMemberIds) {
      const member = await guild.members.fetch(memberId).catch(() => null);
      lines.push(member ? `- ${member.displayName} (${member.id})` : `- ${memberId}`);
    }
  
    return lines.join("\n");
  }
  
  async function formatCallWaitInterestList(guild, recruitmentId) {
    if (!recruitmentId) {
      return "なし";
    }
  
    const memberIds = await CallWaitInterest.find({
      guildId: guild.id,
      recruitmentId,
      status: "active",
    }).distinct("userId");
  
    if (memberIds.length === 0) {
      return "なし";
    }
  
    const lines = [];
  
    for (const memberId of memberIds) {
      const member = await guild.members.fetch(memberId).catch(() => null);
      lines.push(member ? `・${member.displayName}(${member.id})` : `・${memberId}`);
    }
  
    return lines.join("\n");
  }
  
  async function mergeActiveButtonRecruitmentIntoScheduled(guild, settings) {
    const lease = await acquireMongoLease(`${OTEBO_BUTTON_LIFECYCLE_LEASE_PREFIX}:${guild.id}`, { leaseMs: 120_000 });
    if (!lease) return { settings, creatorId: null, blocked: true };
    try {
      settings = await getGuildSettings(guild.id);
      const recruitment = findActiveButtonOteboRecruitment(settings);
      if (!recruitment) return { settings, creatorId: null, blocked: false };
      const claimedSettings = await transitionOteboRecruitment({
        guildId: guild.id,
        recruitmentId: recruitment.id,
        fromStatuses: ["active"],
        toStatus: "merging",
        patch: { mergeSource: "scheduled" },
      });
      if (!claimedSettings) return { settings, creatorId: null, blocked: false };
      const claimedRecruitment = getOteboRecruitment(claimedSettings, recruitment.id) ?? recruitment;
      clearOteboRecruitmentTimers(guild.id, recruitment.id);
      await oteboRecruitmentPanelService.removeOteboRecruitmentPanel(guild).catch((error) => logRecoverableError("Failed to hide Otebo panel during scheduled merge", error));
      await deleteOteboRecruitmentMessage(guild, claimedRecruitment).catch(async (error) => {
        logRecoverableError("Failed to delete button recruitment during scheduled merge", error);
        const channel = await resolveConfiguredTextChannel(guild, claimedRecruitment.channelId);
        const message = channel?.messages?.fetch ? await channel.messages.fetch(claimedRecruitment.messageId).catch(() => null) : null;
        await message?.edit({ content: "この募集は別の募集の成立により終了しました。", components: [], allowedMentions: { parse: [] } }).catch(() => null);
      });
      for (const memberId of Object.keys(claimedRecruitment.pendingConfirmations ?? {})) {
        const member = await guild.members.fetch(memberId).catch(() => null);
        await member?.send({ content: OTEBO_MERGED_NOTICE, allowedMentions: { parse: [] } }).catch(() => null);
      }
      const slotId = claimedSettings?.oteboRecruitmentSlot?.slotId;
      if (slotId) await transitionOteboRecruitmentSlot({ guildId: guild.id, slotId, fromStatuses: ["active"], toStatus: "merging", patch: { recruitmentId: recruitment.id } }).catch(() => null);
      return { settings: claimedSettings, recruitment: claimedRecruitment, creatorId: claimedRecruitment.ownerId, blocked: false };
    } finally {
      await releaseMongoLease(lease).catch((error) => logRecoverableError("Failed to release scheduled merge lease", error));
    }
  }
  
  async function grantCallWaitRoleAndQueueNotice({ guild, settings, memberIds, sourceId }) {
    const merge = await mergeActiveButtonRecruitmentIntoScheduled(guild, settings);
    if (merge.blocked) return false;
    settings = merge.settings;
    const uniqueMemberIds = [...new Set([...(memberIds ?? []), merge.creatorId].filter(Boolean))];
    if (uniqueMemberIds.length < CALL_WAIT_MIN_MEMBERS || !settings?.callWaitRoleId) return false;
    const channel = await resolveConfiguredTextChannel(guild, getCallWaitNoticeChannelId(settings));
    if (!channel) return false;
    const result = await callWaitRoleService.replaceRole({
      guild,
      roleId: settings.callWaitRoleId,
      memberIds: uniqueMemberIds,
      sourceType: "scheduled",
      sourceId,
      removalDelayMs: CALL_WAIT_ROLE_REMOVE_MS,
      requiredMemberCount: CALL_WAIT_MIN_MEMBERS,
    });
    if (!result.ok) {
      if (merge.recruitment) {
        await transitionOteboRecruitment({
          guildId: guild.id,
          recruitmentId: merge.recruitment.id,
          fromStatuses: ["merging"],
          toStatus: "cleanup_pending",
          patch: { lastError: result.reason ?? "Scheduled call-wait role replacement failed" },
        }).catch(() => null);
        const mergeSlotId = settings?.oteboRecruitmentSlot?.slotId;
        if (mergeSlotId) await transitionOteboRecruitmentSlot({
          guildId: guild.id,
          slotId: mergeSlotId,
          fromStatuses: ["merging"],
          toStatus: "cleanup_pending",
          patch: { lastError: result.reason ?? "Scheduled call-wait role replacement failed" },
        }).catch(() => null);
      }
      await sendOperationalLog({ guild, settings, fallbackChannel: null, content: `scheduled call-wait role replacement failed guild=${guild.id} error=${result.reason ?? "unknown"}` }).catch(() => null);
      return false;
    }
    let nextSettings;
    try {
      nextSettings = await saveGuildSettingsWithCurrent(guild.id, settings, {
        callWaitPendingNotice: {
          memberIds: result.grantedMemberIds,
          generationId: result.generation?.generationId,
          sourceId,
          createdAt: new Date().toISOString(),
          status: "pending",
          attemptCount: 0,
        },
      });
    } catch (error) {
      await callWaitRoleService.rollbackGeneration({ guild, generationId: result.generation.generationId, reason: `scheduled call-wait state save failed: ${error.message}` }).catch(() => null);
      if (merge.recruitment) {
        await transitionOteboRecruitment({
          guildId: guild.id,
          recruitmentId: merge.recruitment.id,
          fromStatuses: ["merging"],
          toStatus: "cleanup_pending",
          patch: { lastError: `Scheduled call-wait state save failed: ${error.message}` },
        }).catch(() => null);
        const mergeSlotId = settings?.oteboRecruitmentSlot?.slotId;
        if (mergeSlotId) await transitionOteboRecruitmentSlot({
          guildId: guild.id,
          slotId: mergeSlotId,
          fromStatuses: ["merging"],
          toStatus: "cleanup_pending",
          patch: { lastError: `Scheduled call-wait state save failed: ${error.message}` },
        }).catch(() => null);
      }
      return false;
    }
    if (merge.recruitment) {
      await deleteOteboRecruitmentState(guild.id, nextSettings, merge.recruitment.id).catch((error) => logRecoverableError("Failed to clear merged button recruitment", error));
      clearOteboRecruitmentTimers(guild.id, merge.recruitment.id);
      const slotId = nextSettings?.oteboRecruitmentSlot?.slotId;
      if (slotId) await releaseOteboRecruitmentSlot({ guildId: guild.id, slotId, status: "closed", patch: { closedReason: "scheduled_merge" } }).catch((error) => logRecoverableError("Failed to close merged button slot", error));
    }
    await maybeSendPendingCallWaitStartNotice(guild, nextSettings);
    return true;
  
  }
    /* legacy per-member role path retained below for old persisted actions
    const uniqueMemberIds = [...new Set(memberIds)].filter(Boolean);
  
    if (uniqueMemberIds.length < CALL_WAIT_MIN_MEMBERS) {
      return false;
    }
  
    const channel = await resolveConfiguredTextChannel(
      guild,
      getCallWaitNoticeChannelId(settings),
    );
  
    if (!channel || !settings.callWaitRoleId) {
      return false;
    }
  
    const newlyAddedMemberIds = [];
    const eligibleMemberIds = [];
  
    for (const memberId of uniqueMemberIds) {
      const member = await guild.members.fetch(memberId).catch(() => null);
  
      if (!member || member.user?.bot) {
        continue;
      }
  
      if (member.roles.cache.has(settings.callWaitRoleId)) {
        eligibleMemberIds.push(member.id);
        continue;
      }
  
      await member.roles.add(
        settings.callWaitRoleId,
        "通話待機システムの集合通知",
      ).then(async () => {
        try {
          await VoiceParticipantRoleGrant.updateOne(
            {
              guildId: guild.id,
              memberId: member.id,
              roleId: settings.callWaitRoleId,
              sourceType: "call_wait",
              sourceId: sourceId ?? "unknown",
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
                roleId: settings.callWaitRoleId,
                sourceType: "call_wait",
                sourceId: sourceId ?? "unknown",
              },
            },
            { upsert: true },
          );
        } catch (error) {
          await member.roles.remove(settings.callWaitRoleId, "Rollback untracked call-wait role").catch((rollbackError) => {
            console.error(`Failed to roll back call-wait role for ${member.id}: ${rollbackError.message}`);
          });
          throw error;
        }
        newlyAddedMemberIds.push(member.id);
        eligibleMemberIds.push(member.id);
      }).catch((error) => {
        console.error(`Failed to add call wait role to ${member.id}: ${error.message}`);
      });
    }
  
    if (eligibleMemberIds.length < CALL_WAIT_MIN_MEMBERS) {
      if (newlyAddedMemberIds.length > 0) {
        await removeCallWaitRoleFromMembers(
          guild,
          settings.callWaitRoleId,
          newlyAddedMemberIds,
          { sourceType: "call_wait", sourceId: sourceId ?? "unknown" },
        ).catch((rollbackError) => {
          console.error(`Failed to roll back incomplete call-wait role grants: ${rollbackError.message}`);
        });
      }
      return false;
    }
  
    const nextSettings = await saveGuildSettingsWithCurrent(guild.id, settings, {
      callWaitPendingNotice: {
        memberIds: eligibleMemberIds,
        createdAt: new Date().toISOString(),
        status: "pending",
        attemptCount: 0,
      },
    });
  
    if (eligibleMemberIds.length > 0) {
      try {
        await scheduleCallWaitRoleRemoval({
          guild,
          roleId: settings.callWaitRoleId,
          // Removal is source-scoped in VoiceParticipantRoleGrant, so this can
          // safely include members who already had the role.  It also repairs a
          // crash after granting a role but before its first removal timer was
          // persisted.
          memberIds: eligibleMemberIds,
          sourceId,
        });
      } catch (error) {
        // Do not leave temporary roles behind when their persistent removal
        // schedule could not be written.
        await removeCallWaitRoleFromMembers(
          guild,
          settings.callWaitRoleId,
          newlyAddedMemberIds,
          { sourceType: "call_wait", sourceId: sourceId ?? "unknown" },
        ).catch((rollbackError) => {
          console.error(`Failed to roll back scheduled call-wait roles: ${rollbackError.message}`);
        });
        await saveGuildSettingsWithCurrent(guild.id, nextSettings, {
          callWaitPendingNotice: null,
        }).catch((cleanupError) => {
          console.error(`Failed to clear unschedulable call-wait notice: ${cleanupError.message}`);
        });
        throw error;
      }
    }
  
    await maybeSendPendingCallWaitStartNotice(guild, nextSettings);
  
    return true;
  }
  
  */
  async function maybeSendPendingCallWaitStartNotice(guild, settings) {
    const pendingNotice = settings?.callWaitPendingNotice;
  
    if (
      settings?.callWaitEnabled !== true ||
      !pendingNotice ||
      !settings.callWaitRoleId
    ) {
      return false;
    }
  
    // Reaching the scheduled time with two confirmed participants is enough to
    // announce immediately; waiting for a VC join delays the established call.
    if ((pendingNotice.memberIds ?? []).length < CALL_WAIT_MIN_MEMBERS) {
      return false;
    }
  
    const claimedSettings = await claimCallWaitPendingNotice({ guildId: guild.id });
    if (!claimedSettings?.callWaitPendingNotice) {
      return false;
    }
    settings = claimedSettings;
  
    const channel = await resolveConfiguredTextChannel(
      guild,
      getCallWaitNoticeChannelId(settings),
    );
  
    if (!channel) {
      await failCallWaitPendingNotice({
        guildId: guild.id,
        error: "Configured call-wait notice channel is unavailable",
      });
      return false;
    }
  
    try {
    await channel.send({
      content: `<@&${settings.callWaitRoleId}> 雑談希望者が複数人集まりました！VCへの参加お願いします！`,
      allowedMentions: { roles: [settings.callWaitRoleId] },
    });
    } catch (error) {
      await failCallWaitPendingNotice({ guildId: guild.id, error: error?.message ?? error });
      throw error;
    }
  
    try {
      await saveGuildSettingsWithCurrent(guild.id, settings, {
        callWaitPendingNotice: null,
      });
    } catch (error) {
      await saveGuildSettingsWithCurrent(guild.id, settings, {
        callWaitPendingNotice: {
          ...settings.callWaitPendingNotice,
          status: "sent_unconfirmed",
          sentAt: new Date().toISOString(),
          lastError: `Notice was sent but cleanup persistence failed: ${error.message}`,
        },
      }).catch((statusError) => {
        console.error(`Failed to persist call-wait sent_unconfirmed state: ${statusError.message}`);
      });
      throw error;
    }
  
    return true;
  }
  
  function normalizeCallWaitMemberIds(memberIds) {
    return Array.isArray(memberIds)
      ? [...new Set(memberIds.filter((memberId) => typeof memberId === "string"))]
      : [];
  }
  
  async function getNonBotMemberIds(guild, memberIds) {
    const eligible = [];
    for (const memberId of normalizeCallWaitMemberIds(memberIds)) {
      const member = guild.members.cache?.get(memberId)
        ?? await guild.members.fetch(memberId).catch(() => null);
      if (member?.user?.bot) continue;
      eligible.push(memberId);
    }
    return eligible;
  }
  
  function getCallWaitPromptChannelId(settings) {
    return settings?.callWaitPromptChannelId ?? null;
  }
  
  function getCallWaitNoticeChannelId(settings) {
    return settings?.callWaitNoticeChannelId ?? null;
  }
  
  async function scheduleCallWaitRoleRemoval({ guild, roleId, memberIds, sourceId }) {
    const normalizedIds = normalizeCallWaitMemberIds(memberIds);
    const actionKey = `callwait-role-remove:${guild.id}:${createSessionId()}`;
    await schedulePersistentRoleRemoval({
      actionKey,
      type: "callwait_role_remove",
      guild,
      roleId,
      memberIds: normalizedIds,
      delayMs: CALL_WAIT_ROLE_REMOVE_MS,
      timers: callWaitRoleRemovalTimers,
      payload: { sourceType: "call_wait", sourceId: sourceId ?? "unknown" },
    });
  }
  
  async function schedulePersistentRoleRemoval({ actionKey, type, guild, roleId, memberIds, delayMs, timers, payload }) {
    const executeAt = new Date(Date.now() + delayMs);
    await scheduleAction({ actionKey, guildId: guild.id, type, executeAt, roleId, memberIds, payload: payload ?? {} });
    const previous = timers.get(actionKey);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      timers.delete(actionKey);
      void executeScheduledRoleRemoval({ actionKey, guild, roleId, memberIds, type, payload })
        .catch((error) => {
          console.error(`Failed to execute ${type}: ${error.message}`);
        })
        .finally(() => requestOperationalStatusRefresh(guild.id, type));
    }, Math.max(0, executeAt.getTime() - Date.now()));
    timers.set(actionKey, timer);
  }
  
  async function scheduleWaitingVcCleanup({ actionKey, guild, channelId, delayMs, sessionId }) {
    const executeAt = new Date(Date.now() + delayMs);
    await scheduleAction({ actionKey, guildId: guild.id, type: "split_waiting_vc_cleanup", executeAt, payload: { channelId, sessionId } });
    const timer = setTimeout(() => {
      void executeWaitingVcCleanup({ actionKey, guild, channelId, sessionId })
        .catch((error) => {
          console.error(`Failed to clean up waiting VC: ${error.message}`);
        })
        .finally(() => requestOperationalStatusRefresh(guild.id, "split-waiting-vc-cleanup"));
    }, Math.max(0, executeAt.getTime() - Date.now()));
    const previous = callWaitRoleRemovalTimers.get(actionKey);
    if (previous) clearTimeout(previous);
    callWaitRoleRemovalTimers.set(actionKey, timer);
  }
  
  async function executeWaitingVcCleanup({ actionKey, guild, channelId, sessionId }) {
    const claimed = await claimAction(actionKey);
    if (!claimed) return;
    try {
      const session = sessionId ? await SplitProcessSession.findOne({ sessionId }).lean() : null;
      if (session?.status === "active" && ["active", "extended"].includes(session.waitingMonitorStatus)) {
        // The monitor owns this VC while it is active/extended.  A cleanup action
        // must never delete a channel that can still receive transfers.
        await scheduleWaitingVcCleanup({
          actionKey: `${actionKey}:retry:${Date.now()}`,
          guild,
          channelId,
          delayMs: WAITING_ROOM_POLL_MS,
          sessionId,
        });
        await finishAction(actionKey);
        return;
      }
      const channel = await guild.channels.fetch(channelId).catch((error) => {
        if (error?.code === 10003) return null;
        throw error;
      });
      if (channel) await channel.delete().catch((error) => {
        if (error?.code !== 10003) throw error;
      });
      if (sessionId) await SplitProcessSession.updateOne(
        { sessionId, waitingChannelId: channelId },
        { $set: { waitingVcCleanupCompleted: true, waitingMonitorStatus: "closed", waitingMonitorClosedAt: new Date() } },
      );
      await finishAction(actionKey);
    } catch (error) {
      await failAction(actionKey, error.message).catch((error) => logRecoverableError("Recoverable asynchronous operation failed", error));
      throw error;
    }
  }
  
  async function cancelKokuchiRoleRemovalWait({ guild, reservation }) {
    const eventId = reservation?.reservationId;
    if (!guild?.id || !eventId) return { errors: [] };
    const eventActions = await ScheduledAction.find({ guildId: guild.id, "payload.kokuchiEventId": eventId }).lean().catch(() => []);
    for (const action of eventActions) {
      const timer = callWaitRoleRemovalTimers.get(action.actionKey);
      if (timer) clearTimeout(timer);
      callWaitRoleRemovalTimers.delete(action.actionKey);
    }
    const sessions = await SplitProcessSession.find({
      guildId: guild.id,
      kokuchiEventId: eventId,
      status: { $in: ["active", "feedback_open", "role_remove_pending", "cleaning_up"] },
    }).lean();
    const errors = [];
    for (const session of sessions ?? []) {
      cancelSplitCountdown(session.sessionId);
      const sessionErrors = [];
      const actionKey = `split-role-remove:${session.sessionId}`;
      const timer = callWaitRoleRemovalTimers.get(actionKey);
      if (timer) clearTimeout(timer);
      callWaitRoleRemovalTimers.delete(actionKey);
      await ScheduledAction.updateOne(
        { actionKey, status: { $in: ["pending", "running", "failed"] } },
        { $set: { status: "canceled", completedAt: new Date(), lastError: "Canceled with kokuchi event" } },
      ).catch((error) => sessionErrors.push(`ScheduledAction ${actionKey}: ${error.message}`));
      for (const memberId of normalizeCallWaitMemberIds(session.participantRoleGrantedMemberIds)) {
        const member = await guild.members.fetch(memberId).catch(() => null);
        if (!member) continue;
        try {
          await removeVoiceParticipantRole(member, session.participantRoleId, { sourceType: "splitvc", sourceId: session.sessionId });
        } catch (error) {
          sessionErrors.push(`member ${memberId}: ${error.message}`);
        }
      }
      await SplitProcessSession.updateOne(
        { _id: session._id },
        { $set: { roleRemovalCompleted: sessionErrors.length === 0, phase: sessionErrors.length === 0 ? "completed" : "role_remove_pending", status: sessionErrors.length === 0 ? "completed" : "role_remove_pending", lastError: sessionErrors.length === 0 ? null : sessionErrors.join(" | ") } },
      ).catch((error) => sessionErrors.push(`SplitProcessSession ${session.sessionId}: ${error.message}`));
      errors.push(...sessionErrors);
    }
    return { errors };
  }
  
  async function executeScheduledRoleRemoval({ actionKey, guild, roleId, memberIds, payload }) {
    const claimed = await claimAction(actionKey);
    if (!claimed) return;
    try {
      if (payload?.generationId) {
        const generationResult = await callWaitRoleService.executeGenerationRemoval({
          guild,
          generationId: payload.generationId,
        });
        if (generationResult.status === "busy") {
          const retryAt = new Date(Date.now() + 5_000);
          const retried = await retryAction(actionKey, {
            executeAt: retryAt,
            lastError: "call_wait_role replacement is in progress",
          }).catch((error) => {
            logRecoverableError("Failed to retry call-wait role generation removal", error);
            return null;
          });
          if (retried) {
            const retryTimer = setTimeout(() => {
              callWaitRoleRemovalTimers.delete(actionKey);
              void executeScheduledRoleRemoval({ actionKey, guild, roleId, memberIds, payload })
                .catch((error) => logRecoverableError("Failed to retry call-wait role generation removal", error));
            }, 5_000);
            callWaitRoleRemovalTimers.set(actionKey, retryTimer);
          } else {
            await failAction(actionKey, "call_wait_role replacement remained busy").catch((error) => logRecoverableError("Failed to persist call-wait role generation retry failure", error));
          }
          return;
        }
        if (generationResult.status === "failed") throw generationResult.error ?? new Error("call_wait_role generation removal failed");
        if (["completed", "superseded", "ignored"].includes(generationResult.status)) {
          await completeCallWaitRoleGenerationLifecycle(guild, payload.generationId);
        }
        await finishAction(actionKey);
        return;
      }
      const session = payload?.sessionId
        ? await SplitProcessSession.findOne({ sessionId: payload.sessionId }).lean()
        : null;
      const actionGuard = await getKokuchiActionGuard({
        guildId: guild.id,
        eventId: payload?.kokuchiEventId ?? session?.kokuchiEventId ?? null,
        expectedRevision: payload?.kokuchiEventRevision ?? session?.kokuchiEventRevision ?? null,
      });
      if (!actionGuard.valid) {
        await stopInvalidKokuchiAction({ actionKey, guild, sessionId: payload?.sessionId ?? null, guard: actionGuard });
        return;
      }
      // A role can be shared by unrelated operations.  Only remove it from the
      // members recorded by this session/action, never from every role holder.
      const targetMemberIds = payload?.sessionId
        ? normalizeCallWaitMemberIds(session?.participantRoleGrantedMemberIds)
        : normalizeCallWaitMemberIds(memberIds);
  
      let removed = 0;
      let failed = 0;
      if (payload?.sessionId) {
        for (const memberId of targetMemberIds) {
          const beforeDiscord = await getKokuchiActionGuard({
            guildId: guild.id,
            eventId: actionGuard.eventId,
            expectedRevision: payload?.kokuchiEventRevision ?? session?.kokuchiEventRevision ?? null,
          });
          if (!beforeDiscord.valid) {
            await stopInvalidKokuchiAction({ actionKey, guild, sessionId: payload.sessionId, guard: beforeDiscord });
            return;
          }
          try {
            const member = await guild.members.fetch(memberId);
            await removeVoiceParticipantRole(member, roleId, {
              sourceType: "splitvc",
              sourceId: payload.sessionId,
            });
            removed += 1;
          } catch (error) {
            failed += 1;
            console.error(`Failed to remove split participant role from ${memberId}: ${error.message}`);
          }
        }
        if (failed) throw new Error(`Failed to remove role from ${failed} member(s); removed ${removed} member(s)`);
      } else {
        await removeCallWaitRoleFromMembers(guild, roleId, targetMemberIds, payload);
      }
  
      const beforePersist = await getKokuchiActionGuard({
        guildId: guild.id,
        eventId: actionGuard.eventId,
        expectedRevision: payload?.kokuchiEventRevision ?? session?.kokuchiEventRevision ?? null,
      });
      if (!beforePersist.valid) {
        await stopInvalidKokuchiAction({ actionKey, guild, sessionId: payload?.sessionId ?? null, guard: beforePersist });
        return;
      }
  
      if (payload?.sourceType === "otebo" && payload.sourceId) {
        const currentSettings = await getGuildSettings(guild.id);
        const recruitment = getOteboRecruitment(currentSettings, payload.sourceId);
        if (recruitment?.status === "cleanup_pending") {
          await deleteOteboRecruitmentState(guild.id, currentSettings, payload.sourceId);
          clearOteboRecruitmentTimers(guild.id, payload.sourceId);
        }
      }
  
      if (payload?.sessionId) {
        const settings = await getGuildSettings(guild.id);
        const sessionEvent = session?.kokuchiEventId
          ? await KokuchiReservation.findOne({ guildId: guild.id, reservationId: session.kokuchiEventId }).lean().catch(() => null)
          : null;
  
        await sendOperationalLog({
          guild,
          settings,
          fallbackChannel: null,
          content: `感想受付終了に伴い参加者ロールを解除しました。解除成功: ${removed}人、解除失敗: ${failed}人。`,
        });
  
        const finalGuard = await getKokuchiActionGuard({
          guildId: guild.id,
          eventId: actionGuard.eventId,
          expectedRevision: payload?.kokuchiEventRevision ?? session?.kokuchiEventRevision ?? null,
        });
        if (!finalGuard.valid) {
          await stopInvalidKokuchiAction({ actionKey, guild, sessionId: payload.sessionId, guard: finalGuard });
          return;
        }
        await SplitProcessSession.updateOne(
          { sessionId: payload.sessionId },
          {
            $set: {
              roleRemovalCompleted: true,
              phase: "completed",
              status: "completed",
              completedAt: new Date(),
              lastError: undefined,
            },
          },
        );
        const sessionRestoreStatus = normalizeGatheringVcRestoreStatus(sessionEvent ?? {});
        if (sessionEvent && (sessionEvent.gatheringVcRestorePending === true || isGatheringVcRestoreBlocking(sessionRestoreStatus))) {
          // The split session owns the event identity.  A newer /kokuchi must
          // not prevent an older event's VC snapshot from being restored; the
          // guarded settings mirror update inside the restore path will leave
          // the newer event untouched.
          await restoreGatheringVcPermissionAfterSplit(guild, settings, { eventId: session.kokuchiEventId, force: true }).catch((error) => {
            logRecoverableError("Failed to restore gathering VC permission after split role removal", error);
          });
        }
        if (session?.kokuchiEventId) {
          await clearCompletedGatheringVcEventState({ guild, eventId: session.kokuchiEventId, settings }).catch((error) => {
            logRecoverableError("Failed to clear completed gathering VC event state", error);
          });
        }
        await SplitReviewDraft.deleteMany({ guildId: guild.id, splitSessionId: payload.sessionId }).catch((error) => logRecoverableError("Recoverable asynchronous operation failed", error));
        if (session?.reviewButtonShown && session?.finishNoticeChannelId && session?.finishNoticeMessageId) {
          const noticeChannel = await guild.channels.fetch(session.finishNoticeChannelId).catch(() => null);
          const notice = await noticeChannel?.messages?.fetch(session.finishNoticeMessageId).catch(() => null);
          await notice?.edit({ components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`split_review_closed:${payload.sessionId}`).setLabel("感想受付は終了しました").setStyle(ButtonStyle.Secondary).setDisabled(true))] }).catch((error) => logRecoverableError("Recoverable asynchronous operation failed", error));
        }
      }
      await finishAction(actionKey);
    } catch (error) {
      if (payload?.sessionId) {
        await SplitProcessSession.updateOne(
          { sessionId: payload.sessionId },
          { $set: { roleRemovalCompleted: false, phase: "role_remove_pending", status: "role_remove_pending", lastError: error.message } },
        ).catch((error) => logRecoverableError("Recoverable asynchronous operation failed", error));
      }
      await failAction(actionKey, error.message).catch((persistError) => logRecoverableError(`Failed to persist waiting-VC cleanup failure for ${actionKey}`, persistError));
      throw error;
    }
  }
  
  async function completeCallWaitRoleGenerationLifecycle(guild, generationId) {
    let settings = await getGuildSettings(guild.id);
    if (settings?.callWaitPendingNotice?.generationId === generationId) {
      settings = await saveGuildSettingsWithCurrent(guild.id, settings, { callWaitPendingNotice: null });
    }
    for (const recruitment of Object.values(getOteboRecruitments(settings))) {
      if (recruitment?.roleGenerationId !== generationId) continue;
      if (!["success_notified", "cleanup_pending", "voice_started_notified", "auto_cancelled"].includes(recruitment.status)) continue;
      await deleteOteboRecruitmentState(guild.id, settings, recruitment.id).catch((error) => logRecoverableError("Failed to clear completed button recruitment", error));
      clearOteboRecruitmentTimers(guild.id, recruitment.id);
      const slotId = settings?.oteboRecruitmentSlot?.slotId;
      if (slotId) await releaseOteboRecruitmentSlot({ guildId: guild.id, slotId, status: "closed", patch: { closedReason: "role_generation_completed" } }).catch((error) => logRecoverableError("Failed to close button recruitment slot", error));
      settings = await getGuildSettings(guild.id);
    }
    await oteboRecruitmentPanelService.ensureOteboRecruitmentPanel(guild).catch((error) => logRecoverableError("Failed to restore Otebo panel after role generation cleanup", error));
  }
  
  async function executeSplitFinishNotice({ actionKey, guild, payload }) {
    const claimed = await claimAction(actionKey);
    if (!claimed) return;
    try {
      const session = await SplitProcessSession.findOne({ sessionId: payload?.sessionId }).lean();
      const actionGuard = await getKokuchiActionGuard({
        guildId: guild.id,
        eventId: payload?.kokuchiEventId ?? session?.kokuchiEventId ?? null,
        expectedRevision: payload?.kokuchiEventRevision ?? session?.kokuchiEventRevision ?? null,
      });
      if (!actionGuard.valid) {
        await stopInvalidKokuchiAction({ actionKey, guild, sessionId: payload?.sessionId ?? null, guard: actionGuard });
        return;
      }
      if (session && !session.finishNoticeSent) {
        const sent = await sendSplitFinishNotice({ guild, session, channelId: payload?.channelId });
        if (!sent) {
          await finishAction(actionKey, "canceled", "Kokuchi event was canceled or its lifecycle revision changed");
          return;
        }
      }
      await finishAction(actionKey);
    } catch (error) {
      await failAction(actionKey, error.message).catch((error) => logRecoverableError("Recoverable asynchronous operation failed", error));
      throw error;
    }
  }
  
  async function restoreScheduledActions() {
    const recovery = await recoverInterruptedActions();
    const actions = await getPendingActions();
    let restored = 0;
    for (const action of actions) {
      const guild = client.guilds.cache.get(action.guildId) ?? await client.guilds.fetch(action.guildId).catch(() => null);
      if (!guild) {
        await failAction(action.actionKey, "Guild not found").catch((error) => logRecoverableError("Recoverable asynchronous operation failed", error));
        continue;
      }
      if (action.type === "split_waiting_vc_cleanup") {
        const timer = setTimeout(() => {
          void executeWaitingVcCleanup({ actionKey: action.actionKey, guild, channelId: action.payload?.channelId, sessionId: action.payload?.sessionId })
            .catch((error) => {
              console.error(`Failed to restore waiting VC cleanup ${action.actionKey}: ${error.message}`);
            })
            .finally(() => requestOperationalStatusRefresh(guild.id, "split-waiting-vc-cleanup"));
        }, Math.max(0, new Date(action.executeAt).getTime() - Date.now()));
        callWaitRoleRemovalTimers.set(action.actionKey, timer);
        restored += 1;
        continue;
      }
      if (action.type === "split_finish_notice") {
        const timer = setTimeout(() => {
          void executeSplitFinishNotice({ actionKey: action.actionKey, guild, payload: action.payload })
            .catch((error) => {
              console.error(`Failed to restore split finish notice ${action.actionKey}: ${error.message}`);
            })
            .finally(() => requestOperationalStatusRefresh(guild.id, "split-finish-notice"));
        }, Math.max(0, new Date(action.executeAt).getTime() - Date.now()));
        callWaitRoleRemovalTimers.set(action.actionKey, timer);
        restored += 1;
        continue;
      }
      if (action.type === "callwait_followup") {
        const timer = setTimeout(() => {
          void executeCallWaitFollowup({ actionKey: action.actionKey, guild })
            .catch((error) => {
              console.error(`Failed to restore call-wait follow-up ${action.actionKey}: ${error.message}`);
            })
            .finally(() => requestOperationalStatusRefresh(guild.id, "callwait-followup"));
        }, Math.max(0, new Date(action.executeAt).getTime() - Date.now()));
        callWaitFollowupTimers.set(action.actionKey, timer);
        restored += 1;
        continue;
      }
      const timers = action.type === "otebo_role_remove" ? oteboRecruitmentTimers : callWaitRoleRemovalTimers;
      const previousTimer = timers.get(action.actionKey);
      if (previousTimer) clearTimeout(previousTimer);
      const timer = setTimeout(() => {
        timers.delete(action.actionKey);
        void executeScheduledRoleRemoval({ actionKey: action.actionKey, guild, roleId: action.roleId, memberIds: action.memberIds, payload: action.payload })
          .catch((error) => {
            console.error(`Failed to restore scheduled action ${action.actionKey}: ${error.message}`);
          })
          .finally(() => requestOperationalStatusRefresh(guild.id, action.type));
      }, Math.max(0, new Date(action.executeAt).getTime() - Date.now()));
      timers.set(action.actionKey, timer);
      restored += 1;
    }
    console.log(`Startup scheduled actions restored: ${restored}; interrupted actions recovered: ${recovery.modifiedCount}`);
  }
  
  async function scheduleCallWaitFollowupCheck(guild) {
    const actionKey = `callwait-followup:${guild.id}:${createSessionId()}`;
    const executeAt = new Date(Date.now() + CALL_WAIT_FOLLOWUP_CHECK_MS);
    const result = await scheduleSingleGuildAction({
      actionKey,
      guildId: guild.id,
      type: "callwait_followup",
      executeAt,
    });
    const scheduledAction = result.action;
    if (!result.scheduled || scheduledAction.status !== "pending") return;
  
    const existingTimer = callWaitFollowupTimers.get(scheduledAction.actionKey);
  
    if (existingTimer) {
      clearTimeout(existingTimer);
    }
  
    const delayMs = Math.max(0, new Date(scheduledAction.executeAt).getTime() - Date.now());
    const timer = setTimeout(() => {
      callWaitFollowupTimers.delete(scheduledAction.actionKey);
      void executeCallWaitFollowup({ actionKey: scheduledAction.actionKey, guild })
        .catch((error) => {
          console.error(`Failed to run call wait follow-up ${scheduledAction.actionKey}: ${error.message}`, error);
        })
        .finally(() => requestOperationalStatusRefresh(guild.id, "callwait-followup"));
    }, delayMs);
  
    callWaitFollowupTimers.set(scheduledAction.actionKey, timer);
  }
  
  async function executeCallWaitFollowup({ actionKey, guild }) {
    const claimed = await claimAction(actionKey);
    if (!claimed) return;
    try {
      await runCallWaitFollowupCheck(guild.id);
      await finishAction(actionKey);
    } catch (error) {
      // A transient Discord or MongoDB outage must not permanently suppress
      // future scheduled recruitment.  Put the follow-up back in the durable
      // queue and install a local retry; startup restoration covers restarts.
      const executeAt = new Date(Date.now() + CALL_WAIT_FOLLOWUP_RETRY_MS);
      const retried = await retryAction(actionKey, {
        executeAt,
        lastError: error.message,
      }).catch((retryError) => {
        console.error(`Failed to reschedule call-wait follow-up ${actionKey}: ${retryError.message}`, retryError);
        return null;
      });
      if (retried) {
        const retryTimer = setTimeout(() => {
          callWaitFollowupTimers.delete(actionKey);
          void executeCallWaitFollowup({ actionKey, guild })
            .catch((retryError) => {
              console.error(`Failed to retry call-wait follow-up ${actionKey}: ${retryError.message}`, retryError);
            })
            .finally(() => requestOperationalStatusRefresh(guild.id, "callwait-followup-retry"));
        }, CALL_WAIT_FOLLOWUP_RETRY_MS);
        callWaitFollowupTimers.set(actionKey, retryTimer);
      } else {
        await failAction(actionKey, error.message).catch((error) => logRecoverableError("Recoverable asynchronous operation failed", error));
      }
      throw error;
    }
  }
  
  async function runCallWaitFollowupCheck(guildId) {
    const guild =
      client.guilds.cache.get(guildId) ??
      (await client.guilds.fetch(guildId).catch(() => null));
  
    if (!guild) {
      return;
    }
  
    const settings = await getGuildSettings(guild.id);
  
    if (settings?.callWaitEnabled !== true || settings.callWaitPrompt) {
      return;
    }
  
    if (await maybeSendPendingCallWaitStartNotice(guild, settings)) {
      return;
    }
  
    // 希望者確認の30分後に行う再確認からも、停止時間中は募集を作らない。
    if (await isKokuchiCallWaitPaused(settings, guild.id, new Date())) {
      return;
    }
  
    const activeVoiceMemberIds = getCallWaitActiveVoiceMemberIds(
      guild,
      settings.callWaitVoiceCategoryId,
    );
  
    if (activeVoiceMemberIds.length >= CALL_WAIT_MIN_MEMBERS) {
      const promptChannel = await resolveConfiguredTextChannel(
        guild,
        getCallWaitPromptChannelId(settings),
      );
  
      if (promptChannel) {
        await sendCallWaitSkippedNotice({
          guild,
          settings,
          channel: promptChannel,
          now: new Date(),
        });
      }
  
      return;
    }
  
    await sendCallWaitPromptForGuild(guild, settings, {
      force: false,
      now: new Date(),
    });
  }
  
  async function sendCallWaitSkippedNotice({ guild, settings, channel, now }) {
    if (settings?.callWaitSkippedNotice) {
      return settings;
    }
  
    const message = await channel.send({
      content: "現在複数人が雑談中のため定時募集は送信されていません。",
      allowedMentions: { parse: [] },
    }).catch((error) => {
      console.error(`Failed to send skipped call wait notice: ${error.message}`);
      return null;
    });
  
    if (!message) {
      return settings;
    }
  
    return saveGuildSettingsWithCurrent(guild.id, settings, {
      callWaitSkippedNotice: {
        channelId: channel.id,
        messageId: message.id,
      },
    });
  }
  
  async function removeCallWaitRoleFromMembers(guild, roleId, memberIds, source = null) {
    const errors = [];
    for (const memberId of memberIds) {
      const member = await guild.members.fetch(memberId).catch(() => null);
  
      if (!member) {
        continue;
      }
  
      if (source?.sourceType) {
        await removeVoiceParticipantRole(member, roleId, source);
        continue;
      }
  
      if (!member.roles.cache.has(roleId)) {
        continue;
      }
  
      await member.roles.remove(
        roleId,
        "通話待機システムの30分経過による自動解除",
      ).catch((error) => {
        console.error(`Failed to remove call wait role from ${member.id}: ${error.message}`);
        errors.push(error);
      });
    }
    if (errors.length) throw new AggregateError(errors, "Failed to remove one or more call-wait roles.");
  }
  
  function getCallWaitActiveVoiceMemberIds(guild, categoryId) {
    if (!categoryId) {
      return [];
    }
  
    const memberIds = new Set();
    const voiceTypes = new Set([ChannelType.GuildVoice, ChannelType.GuildStageVoice]);
  
    for (const channel of guild.channels.cache.values()) {
      if (!voiceTypes.has(channel.type) || channel.parentId !== categoryId) {
        continue;
      }
  
      for (const member of channel.members.values()) {
        if (!member.user?.bot) {
          memberIds.add(member.id);
        }
      }
    }
  
    return [...memberIds];
  }
  
  function formatCallWaitPromptV2(targetAt, memberIds = []) {
    const time = formatJstTime(targetAt);
    return [
      "【定時募集】",
      "",
      `${time}から雑談したい方を募集しています。`,
      `${time}時点で参加予定者が2人以上集まっていたら、メンションでお知らせします！`,
      "",
      `現在の参加予定者数：${normalizeCallWaitMemberIds(memberIds).length}人`,
    ].join("\n");
  }
  
  function getCallWaitIntervalMinutes(settings = null) {
    return normalizeCallWaitIntervalMinutes(settings?.callWaitIntervalMinutes);
  }
  
  function getCallWaitSlotKey(targetAt, settings = null) {
    return createCallWaitSlotKey(targetAt, getCallWaitIntervalMinutes(settings));
  }
  
  function formatJstTime(date) {
    const jstDate = new Date(date.getTime() + 9 * 60 * 60 * 1000);
    return `${String(jstDate.getUTCHours()).padStart(2, "0")}:${String(
      jstDate.getUTCMinutes(),
    ).padStart(2, "0")}`;
  }
  
  function createOteboDraftRows(draft) {
    // Retired callers receive the same current panel without the removed mode
    // selector or the old duration wording.
    return createButtonOteboDraftRows(draft);
  }
  
  function createOteboTimeOptions(now) {
    const first = getNextQuarterHourStart(now);
    const defaultTargetAt = new Date(first.getTime() + 60 * 60 * 1000);
    const options = [];
  
    for (let offsetMinutes = 0; offsetMinutes <= 120; offsetMinutes += 15) {
      const targetAt = new Date(first.getTime() + minutesToMs(offsetMinutes));
      options.push({
        label: formatJstTime(targetAt),
        value: targetAt.toISOString(),
      });
    }
  
    options.defaultTargetAt = defaultTargetAt;
    return options;
  }
  
  function createButtonOteboDraftRows(draft) {
    const timeOptions = createOteboTimeOptions(new Date());
    let selectedTargetAt = draft.targetAt;
    const selectedDuration = normalizeButtonDuration(draft.duration);
    const selectedMention = draft.mentionBosyu === true ? "yes" : "no";
  
    if (!timeOptions.some((option) => option.value === selectedTargetAt)) {
      selectedTargetAt = timeOptions.defaultTargetAt.toISOString();
      draft.targetAt = selectedTargetAt;
    }
  
    return [
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`${OTEBO_DRAFT_SELECT_CUSTOM_ID}:target_at`)
          .setPlaceholder("掲載終了時刻")
          .addOptions(timeOptions.map((option) => ({
            label: option.value === selectedTargetAt ? `掲載終了時刻：${option.label}` : option.label,
            value: option.value,
            default: option.value === selectedTargetAt,
          }))),
      ),
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`${OTEBO_DRAFT_SELECT_CUSTOM_ID}:duration`)
          .setPlaceholder("予定通話時間")
          .addOptions(
            { label: "なし", value: OTEBO_DURATION_NONE, default: selectedDuration === OTEBO_DURATION_NONE },
            { label: "30分", value: OTEBO_DURATION_30, default: selectedDuration === OTEBO_DURATION_30 },
            { label: "1時間", value: OTEBO_DURATION_60, default: selectedDuration === OTEBO_DURATION_60 },
          ),
      ),
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`${OTEBO_DRAFT_SELECT_CUSTOM_ID}:mention`)
          .setPlaceholder("@通話へのメンション")
          .addOptions(
            { label: "しない", value: "no", default: selectedMention === "no" },
            { label: "する", value: "yes", default: selectedMention === "yes" },
          ),
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(OTEBO_DRAFT_NOTE_CUSTOM_ID)
          .setLabel("ひとことを入力して送信")
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(OTEBO_DRAFT_SUBMIT_CUSTOM_ID)
          .setLabel("ひとことなしで送信")
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(OTEBO_DRAFT_CANCEL_CUSTOM_ID)
          .setLabel("キャンセル")
          .setStyle(ButtonStyle.Danger),
      ),
    ];
  }
  
  function formatButtonOteboDraftContent(draft) {
    const targetAt = new Date(draft.targetAt);
    const duration = normalizeButtonDuration(draft.duration) === OTEBO_DURATION_30
      ? "30分"
      : normalizeButtonDuration(draft.duration) === OTEBO_DURATION_60
        ? "1時間"
        : "なし";
    return [
      "ボタン募集の内容を選択してください。",
      "",
      `掲載終了時刻：${Number.isFinite(targetAt.getTime()) ? formatJstTime(targetAt) : "未選択"}`,
      `予定通話時間：${duration}`,
      `@通話へのメンション：${draft.mentionBosyu ? "する" : "しない"}`,
      "",
      "ひとことを添える場合は「ひとことを入力して送信」を押してください。",
    ].join("\n");
  }
  
  function getNextQuarterHourStart(date) {
    const quarterMs = 15 * 60 * 1000;
    const jstOffsetMs = 9 * 60 * 60 * 1000;
    const shifted = date.getTime() + jstOffsetMs;
    const remainder = shifted % quarterMs;
    const nextShifted = remainder === 0
      ? shifted + quarterMs
      : shifted + (quarterMs - remainder);
  
    return new Date(nextShifted - jstOffsetMs);
  }
  
  function createDefaultOteboDraft(guildId, userId) {
    const timeOptions = createOteboTimeOptions(new Date());
  
    return {
      guildId,
      userId,
      type: OTEBO_TYPE_IMMEDIATE,
      targetAt: timeOptions.defaultTargetAt.toISOString(),
      duration: OTEBO_DURATION_NONE,
      mentionBosyu: false,
      createdAt: new Date().toISOString(),
    };
  }
  
  function formatOteboDraftContent(draft) {
    // Keep the retired helper aligned with the current no-mode-selection UI.
    return formatButtonOteboDraftContent(draft);
  }
  
  function formatOteboOwnerCancelMessage() {
    return [
      "ボタン募集を作成しました。",
      "募集の取り消しは公開メッセージの「募集を取り消す」から行えます。",
    ].join("\n");
  }
  
  async function updateOteboDraftMenuAfterModal(draftMenu) {
    if (!draftMenu?.applicationId || !draftMenu?.token || !draftMenu?.messageId) {
      return;
    }
  
    await client.rest.patch(
      Routes.webhookMessage(
        draftMenu.applicationId,
        draftMenu.token,
        draftMenu.messageId,
      ),
      {
        body: {
          content: formatOteboOwnerCancelMessage(),
          components: [],
          allowed_mentions: { parse: [] },
        },
      },
    ).catch(() => null);
  }
  
  function createOteboJoinRow(recruitment) {
    return createButtonOteboJoinRow(recruitment);
  }
  
  function createButtonOteboJoinRow(recruitment) {
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`${OTEBO_JOIN_CUSTOM_ID}:${recruitment.id}`)
        .setLabel("参加希望")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`${OTEBO_OWNER_CANCEL_CUSTOM_ID}:${recruitment.id}`)
        .setLabel("募集を取り消す")
        .setStyle(ButtonStyle.Secondary),
    );
  }
  
  function createOteboMemberCancelRow(recruitmentId) {
    return createButtonOteboMemberCancelRow(recruitmentId);
  }
  
  function createButtonOteboMemberCancelRow(recruitmentId) {
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`${OTEBO_MEMBER_CANCEL_CUSTOM_ID}:${recruitmentId}`)
        .setLabel("参加をキャンセル")
        .setStyle(ButtonStyle.Danger),
    );
  }
  
  function createOteboOwnerCancelConfirmRow(recruitmentId) {
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`${OTEBO_OWNER_CANCEL_CONFIRM_CUSTOM_ID}:${recruitmentId}`)
        .setLabel("キャンセル")
        .setStyle(ButtonStyle.Danger),
    );
  }
  
  function formatOteboRecruitmentMessage(recruitment, settings) {
    return formatButtonRecruitmentMessage({
      closingAt: recruitment?.targetAt,
      duration: recruitment?.duration,
      mentionRoleId: settings?.bosyuMentionRoleId,
      mentionEnabled: recruitment?.mentionBosyu === true,
      note: recruitment?.note,
    });
  
  }
    /* legacy scheduled formatting retained below for persisted old records
    const targetAt = new Date(recruitment.targetAt);
    const time = formatJstTime(targetAt);
    const mention =
      shouldMentionBosyuInOteboRecruitment(recruitment, settings)
        ? `<@&${settings.bosyuMentionRoleId}>`
        : "";
    const note = normalizeOteboNote(recruitment.note);
    const noteLine = note ? `ひとこと：${sanitizeDiscordMentions(note)}` : null;
  
    if (recruitment.type === OTEBO_TYPE_IMMEDIATE) {
      return [
        `【雑談募集】${mention ? ` ${mention}` : ""}`,
        `${time}まで掲載される${getOteboImmediateDurationPrefix(recruitment.duration)}雑談の募集です。`,
        "下のボタンが押されたらすぐに集合メンションされます。",
        noteLine,
      ].filter((line) => line !== null).join("\n");
    }
  
    return [
      `【雑談募集】${mention ? ` ${mention}` : ""}`,
      `${time}から${getOteboScheduledDurationText(recruitment.duration)}の雑談の募集です`,
      `${time}時点で2人以上の参加予定者がいたら集合メンションします。`,
      `現在の参加予定者数：${normalizeCallWaitMemberIds(recruitment.memberIds).length}人`,
      noteLine,
      "",
      "ボタンを押してからのキャンセルも可能ですのでお気軽に押してみてください！",
    ].filter((line) => line !== null).join("\n");
  }
  
  */
  async function editOteboRecruitmentMessage(guild, settings, recruitment) {
    if (!recruitment?.channelId || !recruitment?.messageId) {
      return;
    }
  
    const channel = await resolveConfiguredTextChannel(guild, recruitment.channelId);
  
    if (!channel || typeof channel.messages?.fetch !== "function") {
      return;
    }
  
    const message = await channel.messages.fetch(recruitment.messageId).catch(() => null);
  
    if (!message) {
      return;
    }
  
    await message.edit({
      content: formatOteboRecruitmentMessage(recruitment, settings),
      components: [createButtonOteboJoinRow(recruitment)],
      allowedMentions: getOteboRecruitmentAllowedMentions(recruitment, settings),
    }).catch((error) => {
      console.error(`Failed to edit otebo recruitment message: ${error.message}`);
    });
  }
  
  function getOteboRecruitmentAllowedMentions(recruitment, settings) {
    return shouldMentionBosyuInOteboRecruitment(recruitment, settings)
      ? { roles: [settings.bosyuMentionRoleId] }
      : { parse: [] };
  }
  
  function shouldMentionBosyuInOteboRecruitment(recruitment, settings) {
    return Boolean(
      recruitment?.mentionBosyu &&
        settings?.bosyuMentionRoleId &&
        (recruitment.publishedToNotice !== false ||
          recruitment.channelId === getCallWaitNoticeChannelId(settings)),
    );
  }
  
  function formatOteboStartNoticeMessage(roleId, recruitment) {
    return formatButtonSuccessNotice({ roleId, duration: recruitment?.duration, note: recruitment?.note });
  
  }
    /* legacy formatting retained below for old records
    const lines = [
      `<@&${roleId}> ボタン募集の参加予定者が集まりました！VCへの参加お願いします！`,
    ];
    const durationText = getOteboScheduledDurationText(recruitment?.duration);
    const note = normalizeOteboNote(recruitment?.note);
  
    if (durationText) {
      lines.push(`通話時間：${durationText}`);
    }
  
    if (note) {
      lines.push(`ひとこと：${sanitizeDiscordMentions(note)}`);
    }
  
    return lines.join("\n");
  }
  
  */
  function getOteboScheduledDurationText(duration) {
    if (normalizeOteboDuration(duration) === OTEBO_DURATION_30) {
      return "30分間";
    }
  
    if (normalizeOteboDuration(duration) === OTEBO_DURATION_60) {
      return "1時間";
    }
  
    return "";
  }
  
  function getOteboImmediateDurationPrefix(duration) {
    if (normalizeOteboDuration(duration) === OTEBO_DURATION_30) {
      return "30分間の";
    }
  
    if (normalizeOteboDuration(duration) === OTEBO_DURATION_60) {
      return "1時間の";
    }
  
    return "";
  }
  
  function normalizeOteboDuration(duration) {
    return normalizeButtonDuration(duration);
  
    return duration === OTEBO_DURATION_30 || duration === OTEBO_DURATION_60
      ? duration
      : OTEBO_DURATION_NONE;
  }
  
  function normalizeOteboNote(note) {
    return normalizeButtonNote(note);
  
    return String(note ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
  }
  
  function sanitizeDiscordMentions(text) {
    return String(text ?? "").replace(/@/g, "@\u200b");
  }
  
  function getOteboQuickConfirmSeconds(settings, recruitment = null) {
    return getNonNegativeInteger(
      recruitment?.quickConfirmSeconds,
      getNonNegativeInteger(
        settings?.oteboQuickConfirmSeconds,
        OTEBO_DEFAULT_QUICK_CONFIRM_SECONDS,
      ),
    );
  }
  
  function getOteboDraftKey(guildId, userId) {
    return `${guildId}:${userId}`;
  }
  
  function createOteboRecruitmentId() {
    return `otebo-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  }
  
  async function validateOteboSettings(guild, settings, draft) {
    if (!settings?.callWaitRoleId || !getCallWaitNoticeChannelId(settings)) {
      return {
        ok: false,
        reason: "call_wait_role と call_wait_notice_channel を設定してください。",
      };
    }
    if (draft?.mentionBosyu === true && !settings?.bosyuMentionRoleId) {
      return {
        ok: false,
        reason: "@通話へのメンションを使うには bosyu_mention_role を設定してください。",
      };
    }
    const noticeChannel = await resolveConfiguredTextChannel(guild, getCallWaitNoticeChannelId(settings));
    const role = await guild.roles.fetch(settings.callWaitRoleId).catch(() => null);
    const botMember = guild.members.me ?? await guild.members.fetchMe().catch(() => null);
    const permissions = noticeChannel?.permissionsFor?.(botMember);
    const requiredPermissions = [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.EmbedLinks,
      PermissionFlagsBits.ReadMessageHistory,
      PermissionFlagsBits.ManageMessages,
    ];
    if (!noticeChannel || !permissions || !requiredPermissions.every((permission) => permissions.has(permission))) {
      return {
        ok: false,
        reason: "call_wait_notice_channel で閲覧・送信・埋め込み・履歴参照・メッセージ管理の権限が必要です。",
      };
    }
    if (!role || role.managed || role.editable === false || !botMember?.permissions?.has?.(PermissionFlagsBits.ManageRoles)) {
      return {
        ok: false,
        reason: "call_wait_role が見つからないか、BotのManage Roles権限またはロール階層が不足しています。",
      };
    }
    return { ok: true, noticeChannel, previewChannel: null, role };
  
  }
    /* legacy scheduled validation retained below for old records
    if (!settings?.callWaitRoleId || !getCallWaitNoticeChannelId(settings)) {
      return {
        ok: false,
        reason: "`/setting callwait call_wait_role:ロール call_wait_notice_channel:送信先` を設定してください。",
      };
    }
  
    if (draft.mentionBosyu === true && !settings?.bosyuMentionRoleId) {
      return {
        ok: false,
        reason: "`@通話へのメンション` を使うには `/setting callwait bosyu_mention_role:ロール` を設定してください。",
      };
    }
  
    const noticeChannel = await resolveConfiguredTextChannel(
      guild,
      getCallWaitNoticeChannelId(settings),
    );
    const previewChannel = await resolveConfiguredTextChannel(
      guild,
      settings?.oteboPreviewChannelId,
    );
    const role = await guild.roles.fetch(settings.callWaitRoleId).catch(() => null);
  
    if (!noticeChannel) {
      return {
        ok: false,
        reason: "ボタン募集の送信先チャンネルを取得できません。`/setting callwait call_wait_notice_channel:送信先` を確認してください。",
      };
    }
  
    if (!role) {
      return {
        ok: false,
        reason: "通話希望者ロールを取得できません。`/setting callwait call_wait_role:ロール` を確認してください。",
      };
    }
  
    return {
      ok: true,
      noticeChannel,
      previewChannel,
      role,
    };
  }
  
  */
  function getOteboRecruitments(settings) {
    return settings?.oteboRecruitments &&
      typeof settings.oteboRecruitments === "object" &&
      !Array.isArray(settings.oteboRecruitments)
      ? settings.oteboRecruitments
      : {};
  }
  
  function getOteboRecruitment(settings, recruitmentId) {
    const recruitment = getOteboRecruitments(settings)[recruitmentId];
    return recruitment && typeof recruitment === "object" ? recruitment : null;
  }
  
  function getOteboVoiceStatusSessions(settings) {
    return settings?.oteboVoiceStatusSessions &&
      typeof settings.oteboVoiceStatusSessions === "object" &&
      !Array.isArray(settings.oteboVoiceStatusSessions)
      ? settings.oteboVoiceStatusSessions
      : {};
  }
  
  function isActiveOteboRecruitment(recruitment, messageId = null) {
    if (!recruitment || recruitment.status !== "active") {
      return false;
    }
  
    return !messageId || recruitment.messageId === messageId;
  }
  
  function findActiveOteboRecruitmentByOwner(settings, ownerId) {
    return Object.values(getOteboRecruitments(settings)).find(
      (recruitment) =>
        recruitment?.status === "active" &&
        recruitment.ownerId === ownerId,
    );
  }
  
  function findActiveButtonOteboRecruitment(settings) {
    return Object.values(getOteboRecruitments(settings)).find((recruitment) => (
      recruitment
      && recruitment.type !== OTEBO_TYPE_SCHEDULED
      && ["creating", "active", "closing", "merging", "auto_cancel_processing", "success_processing", "success_notified", "cleanup_pending", "published_unconfirmed"].includes(recruitment.status)
    )) ?? null;
  }
  
  async function saveOteboRecruitmentState(guildId, currentSettings, recruitment) {
    return replaceNestedObject({
      guildId,
      path: `oteboRecruitments.${recruitment.id}`,
      value: recruitment,
    }).then(() => getGuildSettings(guildId));
  }
  
  async function deleteOteboRecruitmentState(guildId, currentSettings, recruitmentId) {
    await unsetNestedObject({ guildId, path: `oteboRecruitments.${recruitmentId}` });
    return getGuildSettings(guildId);
  }
  
  function addUniqueMemberId(memberIds, memberId) {
    return [...new Set([...normalizeCallWaitMemberIds(memberIds), memberId].filter(Boolean))];
  }
  
  function createOteboVoiceStatusSession({ recruitment, memberIds, notifiedAt }) {
    const durationMinutes = getOteboDurationMinutes(recruitment.duration);
    if (!durationMinutes) {
      return null;
    }
  
    return {
      id: createOteboRecruitmentId(),
      recruitmentId: recruitment.id,
      memberIds: normalizeCallWaitMemberIds(memberIds),
      duration: normalizeOteboDuration(recruitment.duration),
      durationMinutes,
      notifiedAt: notifiedAt.toISOString(),
      statusChannelId: null,
      statusSetAt: null,
      clearAt: null,
      createdAt: new Date().toISOString(),
    };
  }
  
  function getOteboDurationMinutes(duration) {
    if (normalizeOteboDuration(duration) === OTEBO_DURATION_30) {
      return 30;
    }
  
    if (normalizeOteboDuration(duration) === OTEBO_DURATION_60) {
      return 60;
    }
  
    return null;
  }
  
  function getOteboVoiceStatusLabel(duration) {
    if (normalizeOteboDuration(duration) === OTEBO_DURATION_30) {
      return "30分";
    }
  
    if (normalizeOteboDuration(duration) === OTEBO_DURATION_60) {
      return "1時間";
    }
  
    return "";
  }
  
  async function restoreOteboRecruitmentTimers() {
    for (const guild of client.guilds.cache.values()) {
      try {
      const settings = await getGuildSettings(guild.id);
  
      const slot = settings?.oteboRecruitmentSlot;
      const slotRecruitment = slot?.recruitmentId
        ? getOteboRecruitment(settings, slot.recruitmentId)
        : null;
      if (
        slot?.status
        && ["creating", "active", "closing", "merging", "auto_cancel_processing", "success_processing", "success_notified", "cleanup_pending", "uncertain"].includes(slot.status)
        && !slotRecruitment
      ) {
        await transitionOteboRecruitmentSlot({
          guildId: guild.id,
          slotId: slot.slotId,
          fromStatuses: [slot.status],
          toStatus: "uncertain",
          patch: { lastError: "Bot restarted while button recruitment state was incomplete; automatic resend disabled" },
        }).catch((error) => console.error(`Failed to mark uncertain button recruitment slot for guild ${guild.id}: ${error.message}`));
      }
  
      for (const recruitment of Object.values(getOteboRecruitments(settings))) {
        if (recruitment?.status === "publishing") {
          await transitionOteboRecruitment({
            guildId: guild.id,
            recruitmentId: recruitment.id,
            fromStatuses: ["publishing"],
            toStatus: "published_unconfirmed",
            patch: { lastError: "Bot restarted while a legacy scheduled publication was processing; automatic resend disabled" },
          }).catch((error) => console.error(`Failed to mark uncertain legacy otebo publication ${recruitment.id}: ${error.message}`));
          continue;
          /* legacy recovery path intentionally disabled to prevent duplicate notices */
          /*
          const recoveredSettings = await transitionOteboRecruitment({
            guildId: guild.id,
            recruitmentId: recruitment.id,
            fromStatuses: ["publishing"],
            toStatus: "active",
            patch: { lastError: "Bot restarted while otebo notice publication was processing" },
          }).catch((error) => {
            console.error(`Failed to recover otebo publishing state ${recruitment.id}: ${error.message}`);
            return null;
          });
          const recovered = recoveredSettings && getOteboRecruitment(recoveredSettings, recruitment.id);
          if (recovered?.status === "active") {
            scheduleOteboRecruitmentTimers(guild, recovered);
          }
          continue;
          */
        }
        if (["success_processing", "success_notified", "cleanup_pending"].includes(recruitment?.status)) {
          if (recruitment.roleGenerationId) {
            continue;
          }
          console.error(`Button recruitment success state has no role generation; automatic notice replay disabled guild=${guild.id} recruitment=${recruitment.id}`);
          continue;
          /* legacy per-recruitment role recovery intentionally disabled */
          /*
          const memberIds = normalizeCallWaitMemberIds(
            recruitment.participantRoleGrantedMemberIds ?? recruitment.memberIds,
          );
          if (settings?.callWaitRoleId && memberIds.length) {
            await scheduleOteboRoleRemoval({
              guild,
              roleId: settings.callWaitRoleId,
              memberIds,
              recruitmentId: recruitment.id,
            });
          }
          if (recruitment.status !== "cleanup_pending") {
            await transitionOteboRecruitment({
              guildId: guild.id,
              recruitmentId: recruitment.id,
              fromStatuses: [recruitment.status],
              toStatus: "cleanup_pending",
              patch: { lastError: "Bot restarted during otebo success processing; notice replay is disabled" },
            });
          }
          continue;
          */
        }
        if (recruitment?.status === "active") {
          scheduleOteboRecruitmentTimers(guild, recruitment);
        }
      }
  
      for (const session of Object.values(getOteboVoiceStatusSessions(settings))) {
        if (session?.statusChannelId) {
          scheduleOteboVoiceStatusClear(guild, session);
        } else {
          scheduleOteboVoiceStatusDeadline(guild, session);
        }
      }
  
      await processOteboVoiceStatusSessions(guild, settings);
      } catch (error) {
        console.error(`Failed to restore otebo state for guild ${guild.id}: ${error.message}`);
      }
    }
  }
  
  async function restoreCallWaitRoleGenerations() {
    for (const guild of client.guilds.cache.values()) {
      await callWaitRoleService.restore(guild).catch((error) => {
        console.error(`Failed to reconcile call_wait_role generations for guild ${guild.id}: ${error.message}`);
      });
    }
  }
  
  function scheduleOteboRecruitmentTimers(guild, recruitment) {
    clearOteboRecruitmentTimers(guild.id, recruitment.id);
  
    if (recruitment?.type !== OTEBO_TYPE_IMMEDIATE) return;
  
    if (shouldScheduleOteboNoticePublish(recruitment)) {
      const publishAt = getOteboNoticePublishAt(recruitment);
      const key = getOteboPublishTimerKey(guild.id, recruitment.id);
      const publishDelayMs = Math.max(1000, publishAt.getTime() - Date.now());
      const publishTimer = setTimeout(() => {
        oteboRecruitmentTimers.delete(key);
        void processOteboNoticePublish(guild.id, recruitment.id).catch((error) => {
          console.error(`Failed to publish otebo notice message: ${error.message}`, error);
        }).finally(() => requestOperationalStatusRefresh(guild.id, "otebo-notice-publish"));
      }, publishDelayMs);
  
      oteboRecruitmentTimers.set(key, publishTimer);
    }
  
    const targetAt = new Date(recruitment.targetAt);
    if (Number.isFinite(targetAt.getTime())) {
      const delayMs = Math.max(1000, targetAt.getTime() - Date.now());
      const key = getOteboDeadlineTimerKey(guild.id, recruitment.id);
      const timer = setTimeout(() => {
        oteboRecruitmentTimers.delete(key);
        void processOteboDeadline(guild.id, recruitment.id).catch((error) => {
          console.error(`Failed to process otebo deadline: ${error.message}`, error);
        }).finally(() => requestOperationalStatusRefresh(guild.id, "otebo-deadline"));
      }, delayMs);
  
      oteboRecruitmentTimers.set(key, timer);
    }
  
    for (const [memberId, expiresAt] of Object.entries(
      recruitment.pendingConfirmations ?? {},
    )) {
      scheduleOteboImmediateConfirmation(guild, recruitment, memberId, expiresAt);
    }
  }
  
  function shouldScheduleOteboNoticePublish(recruitment) {
    if (
      recruitment?.status !== "active" ||
      recruitment.type !== OTEBO_TYPE_SCHEDULED ||
      recruitment.publishedToNotice !== false
    ) {
      return false;
    }
  
    const publishAt = getOteboNoticePublishAt(recruitment);
    const targetAt = new Date(recruitment.targetAt);
  
    return (
      Number.isFinite(publishAt.getTime()) &&
      Number.isFinite(targetAt.getTime()) &&
      Date.now() < targetAt.getTime()
    );
  }
  
  function getOteboNoticePublishAt(recruitment) {
    const targetAt = new Date(recruitment?.targetAt);
  
    if (!Number.isFinite(targetAt.getTime())) {
      return new Date(Number.NaN);
    }
  
    return new Date(targetAt.getTime() - OTEBO_SCHEDULED_NOTICE_LEAD_MS);
  }
  
  async function processOteboNoticePublish(guildId, recruitmentId) {
    const guild =
      client.guilds.cache.get(guildId) ??
      (await client.guilds.fetch(guildId).catch(() => null));
  
    if (!guild) {
      return;
    }
  
    const settings = await getGuildSettings(guild.id);
    const recruitment = getOteboRecruitment(settings, recruitmentId);
  
    if (!shouldScheduleOteboNoticePublish(recruitment)) {
      return;
    }
  
    const claimedSettings = await transitionOteboRecruitment({
      guildId: guild.id,
      recruitmentId,
      fromStatuses: ["active"],
      toStatus: "publishing",
    });
    if (!claimedSettings) {
      return;
    }
    const claimedRecruitment = getOteboRecruitment(claimedSettings, recruitmentId);
    if (!claimedRecruitment || claimedRecruitment.status !== "publishing") {
      return;
    }
  
    const noticeChannel = await resolveConfiguredTextChannel(
      guild,
      claimedRecruitment.noticeChannelId ?? getCallWaitNoticeChannelId(claimedSettings),
    );
  
    if (!noticeChannel) {
      await transitionOteboRecruitment({
        guildId: guild.id,
        recruitmentId,
        fromStatuses: ["publishing"],
        toStatus: "active",
        patch: { lastError: "Configured otebo notice channel is unavailable" },
      });
      return;
    }
  
    const nextRecruitment = {
      ...claimedRecruitment,
      channelId: noticeChannel.id,
      messageId: null,
      noticeChannelId: noticeChannel.id,
      publishedToNotice: true,
      status: "active",
    };
    let message;
    try {
      message = await noticeChannel.send({
        content: formatOteboRecruitmentMessage(nextRecruitment, claimedSettings),
        components: [createButtonOteboJoinRow(nextRecruitment)],
        allowedMentions: getOteboRecruitmentAllowedMentions(nextRecruitment, claimedSettings),
      });
    } catch (error) {
      await transitionOteboRecruitment({
        guildId: guild.id,
        recruitmentId,
        fromStatuses: ["publishing"],
        toStatus: "active",
        patch: { lastError: `Otebo notice send failed: ${error.message}` },
      }).catch((statusError) => {
        console.error(`Failed to restore otebo publication state: ${statusError.message}`);
      });
      throw error;
    }
  
    nextRecruitment.messageId = message.id;
  
    let nextSettings;
    try {
      nextSettings = await saveOteboRecruitmentState(
        guild.id,
        claimedSettings,
        nextRecruitment,
      );
    } catch (error) {
      await message.edit({
        content: "【操作できません】\n\n募集の保存に失敗したため、このメッセージは無効です。",
        components: [],
      }).catch((editError) => {
        console.error(`Failed to disable unconfirmed otebo notice: ${editError.message}`);
      });
      await transitionOteboRecruitment({
        guildId: guild.id,
        recruitmentId,
        fromStatuses: ["publishing"],
        toStatus: "published_unconfirmed",
        patch: { lastError: `Otebo notice was sent but persistence failed: ${error.message}` },
      }).catch((statusError) => {
        console.error(`Failed to persist otebo published_unconfirmed state: ${statusError.message}`);
      });
      throw error;
    }
  
    await deleteOteboRecruitmentMessage(guild, recruitment).catch((error) => {
      console.error(`Failed to delete obsolete otebo preview message: ${error.message}`);
    });
    scheduleOteboRecruitmentTimers(guild, nextRecruitment);
    await sendOteboApplicantLog({
      guild,
      settings: nextSettings,
      action: "publish",
      memberIds: normalizeCallWaitMemberIds(nextRecruitment.memberIds),
    });
  }
  
  function scheduleOteboImmediateConfirmation(
    guild,
    recruitment,
    memberId,
    expiresAtValue = null,
  ) {
    const expiresAt = new Date(
      expiresAtValue ??
        recruitment.pendingConfirmations?.[memberId] ??
        Date.now(),
    );
    const key = getOteboConfirmationTimerKey(guild.id, recruitment.id, memberId);
    const existingTimer = oteboRecruitmentTimers.get(key);
  
    if (existingTimer) {
      clearTimeout(existingTimer);
    }
  
    const delayMs = Number.isFinite(expiresAt.getTime())
      ? Math.max(0, expiresAt.getTime() - Date.now())
      : 0;
    const timer = setTimeout(() => {
      oteboRecruitmentTimers.delete(key);
      void processOteboImmediateConfirmation(
        guild.id,
        recruitment.id,
        memberId,
      ).catch((error) => {
        console.error(`Failed to process otebo confirmation: ${error.message}`, error);
      }).finally(() => requestOperationalStatusRefresh(guild.id, "otebo-confirmation"));
    }, delayMs);
  
    oteboRecruitmentTimers.set(key, timer);
  }
  
  async function processOteboImmediateConfirmation(guildId, recruitmentId, memberId) {
    const guild =
      client.guilds.cache.get(guildId) ??
      (await client.guilds.fetch(guildId).catch(() => null));
  
    if (!guild) {
      return;
    }
  
    const settings = await getGuildSettings(guild.id);
    const recruitment = getOteboRecruitment(settings, recruitmentId);
  
    if (
      !isActiveOteboRecruitment(recruitment) ||
      recruitment.type !== OTEBO_TYPE_IMMEDIATE ||
      !normalizeCallWaitMemberIds(recruitment.memberIds).includes(memberId)
    ) {
      return;
    }
  
    const expiresAt = new Date(recruitment.pendingConfirmations?.[memberId]);
    if (Number.isFinite(expiresAt.getTime()) && expiresAt.getTime() > Date.now()) {
      scheduleOteboImmediateConfirmation(guild, recruitment, memberId, expiresAt);
      return;
    }
  
    const eligibleMemberIds = await getNonBotMemberIds(guild, recruitment.memberIds);
    if (eligibleMemberIds.length >= CALL_WAIT_MIN_MEMBERS) {
      await finishOteboRecruitmentSuccess({
        guild,
        settings,
        recruitment,
      });
      return;
    }
  
    const storedExpiresAt = recruitment.pendingConfirmations?.[memberId];
    if (!storedExpiresAt) return;
    const clearedSettings = await clearOteboRecruitmentConfirmation({
      guildId: guild.id,
      recruitmentId,
      messageId: recruitment.messageId,
      userId: memberId,
      expiresAt: storedExpiresAt,
    });
    if (!clearedSettings) return;
    const clearedRecruitment = getOteboRecruitment(clearedSettings, recruitmentId) ?? recruitment;
    const targetAt = new Date(clearedRecruitment.targetAt);
    if (Number.isFinite(targetAt.getTime()) && targetAt.getTime() <= Date.now()) {
      // The deadline may have observed a still-pending confirmation and exited.
      // Re-run the durable deadline path after the confirmation is cleared so a
      // one-member recruitment cannot remain active forever.
      await processOteboDeadline(guild.id, recruitmentId);
    }
  }
  
  async function processOteboDeadline(guildId, recruitmentId) {
    const guild =
      client.guilds.cache.get(guildId) ??
      (await client.guilds.fetch(guildId).catch(() => null));
  
    if (!guild) {
      return;
    }
  
    const deadlineLease = await acquireMongoLease(`otebo-deadline:${guild.id}:${recruitmentId}`, { leaseMs: 2 * 60 * 1000 });
    if (!deadlineLease) return { status: "busy" };
    try {
    const settings = await getGuildSettings(guild.id);
    const recruitment = getOteboRecruitment(settings, recruitmentId);
  
    if (!isActiveOteboRecruitment(recruitment)) {
      return;
    }
  
    const memberIds = normalizeCallWaitMemberIds(recruitment.memberIds);
    const eligibleMemberIds = await getNonBotMemberIds(guild, memberIds);
  
    if (recruitment.type === OTEBO_TYPE_IMMEDIATE) {
      const pendingCount = Object.keys(recruitment.pendingConfirmations ?? {}).length;
      if (eligibleMemberIds.length >= CALL_WAIT_MIN_MEMBERS) {
        if (pendingCount > 0) return;
        const finished = await finishOteboRecruitmentSuccess({ guild, settings, recruitment });
        if (finished) return;
        return;
      }
      const closing = await transitionOteboRecruitment({
        guildId: guild.id,
        recruitmentId,
        fromStatuses: ["active"],
        toStatus: "closing",
        patch: { closedReason: "expired" },
      });
      if (!closing) return;
      await deleteOteboRecruitmentMessage(guild, recruitment).catch(async (error) => {
        logRecoverableError("Failed to delete expired button recruitment", error);
        await editOteboRecruitmentMessageClosed(guild, recruitment);
      });
      const nextSettings = await deleteOteboRecruitmentState(guild.id, closing, recruitment.id);
      clearOteboRecruitmentTimers(guild.id, recruitment.id);
      const slotId = nextSettings?.oteboRecruitmentSlot?.slotId;
      if (slotId) await releaseOteboRecruitmentSlot({ guildId: guild.id, slotId, status: "closed", patch: { closedReason: "expired" } }).catch((error) => logRecoverableError("Failed to release expired button recruitment slot", error));
      await sendOteboApplicantLog({ guild, settings: nextSettings, action: "reset", memberIds: [] });
      await oteboRecruitmentPanelService.ensureOteboRecruitmentPanel(guild).catch((error) => logRecoverableError("Failed to restore Otebo panel after expiry", error));
      return;
    }
  
    if (recruitment.type === OTEBO_TYPE_SCHEDULED) {
      if (eligibleMemberIds.length >= CALL_WAIT_MIN_MEMBERS) {
        await finishOteboRecruitmentSuccess({
          guild,
          settings,
          recruitment,
        });
        return;
      }
  
      await deleteOteboRecruitmentMessage(guild, recruitment).catch(async (error) => {
        logRecoverableError("Failed to delete expired scheduled recruitment", error);
        await editOteboRecruitmentMessageClosed(guild, recruitment);
      });
      const nextSettings = await deleteOteboRecruitmentState(
        guild.id,
        settings,
        recruitment.id,
      );
      clearOteboRecruitmentTimers(guild.id, recruitment.id);
      await sendOteboApplicantLog({
        guild,
        settings: nextSettings,
        action: "reset",
        memberIds: [],
      });
      return;
    }
  
    const pendingCount = Object.keys(recruitment.pendingConfirmations ?? {}).length;
    if (memberIds.length >= CALL_WAIT_MIN_MEMBERS && pendingCount > 0) {
      return;
    }
  
    await deleteOteboRecruitmentMessage(guild, recruitment).catch(async (error) => {
      logRecoverableError("Failed to delete expired recruitment", error);
      await editOteboRecruitmentMessageClosed(guild, recruitment);
    });
    const nextSettings = await deleteOteboRecruitmentState(
      guild.id,
      settings,
      recruitment.id,
    );
    clearOteboRecruitmentTimers(guild.id, recruitment.id);
    await sendOteboApplicantLog({
      guild,
      settings: nextSettings,
      action: "reset",
      memberIds: [],
    });
    } finally {
      await releaseMongoLease(deadlineLease).catch((error) => logRecoverableError("Failed to release otebo deadline lease", error));
    }
  }
  
  async function releaseOteboSuccessClaim(guild, recruitmentId, error) {
    const restoredSettings = await transitionOteboRecruitment({
      guildId: guild.id,
      recruitmentId,
      fromStatuses: ["success_processing"],
      toStatus: "active",
      patch: { lastError: error?.message ?? String(error) },
    });
    const restored = restoredSettings && getOteboRecruitment(restoredSettings, recruitmentId);
    if (restored?.status === "active") {
      scheduleOteboRecruitmentTimers(guild, restored);
      await oteboRecruitmentPanelService.ensureOteboRecruitmentPanel(guild).catch((panelError) => {
        logRecoverableError("Failed to restore Otebo panel after unsuccessful success processing", panelError);
      });
    }
    return restoredSettings;
  }
  
  async function finishOteboRecruitmentSuccess({ guild, settings, recruitment }) {
    return finishButtonOteboRecruitmentSuccess({ guild, settings, recruitment });
  
  }
    /* legacy per-recruitment role path retained below for old persisted records
    const memberIds = normalizeCallWaitMemberIds(recruitment.memberIds);
  
    if (memberIds.length < CALL_WAIT_MIN_MEMBERS || !settings?.callWaitRoleId) {
      return false;
    }
  
    const successLease = await acquireMongoLease(`otebo-success:${guild.id}:${recruitment.id}`, { leaseMs: 2 * 60 * 1000 });
    if (!successLease) return false;
  
    try {
    const claimedSettings = await transitionOteboRecruitment({
      guildId: guild.id,
      recruitmentId: recruitment.id,
      fromStatuses: ["active"],
      toStatus: "success_processing",
    });
    if (!claimedSettings) return false;
    settings = claimedSettings;
    recruitment = getOteboRecruitment(claimedSettings, recruitment.id);
    if (!recruitment || recruitment.status !== "success_processing") return false;
  
    const channel = await resolveConfiguredTextChannel(
      guild,
      getCallWaitNoticeChannelId(settings),
    );
    if (!channel) {
      await releaseOteboSuccessClaim(guild, recruitment.id, new Error("Configured otebo success notice channel is unavailable"));
      return false;
    }
  
    const { memberIds: roleMemberIds, grantedMemberIds } = await addTemporaryRoleToMembers({
      guild,
      roleId: settings.callWaitRoleId,
      memberIds,
      sourceType: "otebo",
      sourceId: recruitment.id,
      reason: "ボタン募集の集合通知",
    });
  
    if (roleMemberIds.length < CALL_WAIT_MIN_MEMBERS) {
      await removeTemporaryRoleFromMembers({
        guild,
        roleId: settings.callWaitRoleId,
        memberIds: grantedMemberIds,
        sourceType: "otebo",
        sourceId: recruitment.id,
        reason: "Recruitment could not grant roles to enough members",
      }).catch((error) => console.error(`Failed to roll back otebo roles: ${error.message}`, error));
      await releaseOteboSuccessClaim(guild, recruitment.id, new Error("Could not grant the participant role to enough members"));
      return false;
    }
  
    const notifiedAt = new Date();
    try {
      await channel.send({
        content: formatOteboStartNoticeMessage(settings.callWaitRoleId, recruitment),
        allowedMentions: { roles: [settings.callWaitRoleId] },
      });
    } catch (error) {
      await removeTemporaryRoleFromMembers({
        guild,
        roleId: settings.callWaitRoleId,
        memberIds: grantedMemberIds,
        sourceType: "otebo",
        sourceId: recruitment.id,
        reason: "Recruitment success notice failed",
      }).catch((rollbackError) => console.error(`Failed to roll back otebo roles: ${rollbackError.message}`, rollbackError));
      await releaseOteboSuccessClaim(guild, recruitment.id, error);
      return false;
    }
  
    const notifiedSettings = await transitionOteboRecruitment({
      guildId: guild.id,
      recruitmentId: recruitment.id,
      fromStatuses: ["success_processing"],
      toStatus: "success_notified",
      patch: {
        successNoticeSentAt: notifiedAt.toISOString(),
        participantRoleGrantedMemberIds: grantedMemberIds,
        lastError: null,
      },
    });
    if (!notifiedSettings) {
      // The Discord notice is already visible.  Do not retry it automatically.
      console.error(`Otebo success notice was sent but its state could not be persisted: ${recruitment.id}`);
      return false;
    }
    settings = notifiedSettings;
    recruitment = getOteboRecruitment(notifiedSettings, recruitment.id);
  
    try {
      if (grantedMemberIds.length) {
        await scheduleOteboRoleRemoval({
          guild,
          roleId: settings.callWaitRoleId,
          memberIds: grantedMemberIds,
          recruitmentId: recruitment.id,
        });
      }
    } catch (error) {
      await removeTemporaryRoleFromMembers({
        guild,
        roleId: settings.callWaitRoleId,
        memberIds: grantedMemberIds,
        sourceType: "otebo",
        sourceId: recruitment.id,
        reason: "Persistent role removal schedule failed",
      }).catch((rollbackError) => console.error(`Failed to roll back otebo roles: ${rollbackError.message}`, rollbackError));
      await transitionOteboRecruitment({
        guildId: guild.id,
        recruitmentId: recruitment.id,
        fromStatuses: ["success_notified"],
        toStatus: "failed",
        patch: { lastError: `Persistent role removal schedule failed: ${error.message}` },
      }).catch((statusError) => console.error(`Failed to persist otebo failure state: ${statusError.message}`));
      return false;
    }
    await deleteOteboRecruitmentMessage(guild, recruitment);
    const recruitments = { ...getOteboRecruitments(settings) };
    delete recruitments[recruitment.id];
    const voiceStatusSessions = { ...getOteboVoiceStatusSessions(settings) };
    const voiceStatusSession = createOteboVoiceStatusSession({
      recruitment,
      memberIds: roleMemberIds,
      notifiedAt,
      settings,
    });
  
    if (voiceStatusSession) {
      voiceStatusSessions[voiceStatusSession.id] = voiceStatusSession;
    }
  
    let nextSettings;
    try {
      nextSettings = await saveGuildSettingsWithCurrent(guild.id, settings, {
        oteboRecruitments: recruitments,
        oteboVoiceStatusSessions: voiceStatusSessions,
      });
    } catch (error) {
      await transitionOteboRecruitment({
        guildId: guild.id,
        recruitmentId: recruitment.id,
        fromStatuses: ["success_notified"],
        toStatus: "cleanup_pending",
        patch: { lastError: `Otebo completion persistence failed after notification: ${error.message}` },
      }).catch((statusError) => console.error(`Failed to persist otebo cleanup-pending state: ${statusError.message}`));
      throw error;
    }
    clearOteboRecruitmentTimers(guild.id, recruitment.id);
    await sendOteboApplicantLog({
      guild,
      settings: nextSettings,
      action: "notify",
      memberIds: roleMemberIds,
    });
  
    if (voiceStatusSession) {
      scheduleOteboVoiceStatusDeadline(guild, voiceStatusSession);
      await processOteboVoiceStatusSessions(guild, nextSettings);
    }
  
    return true;
    } finally {
      await releaseMongoLease(successLease).catch((error) => {
        console.error(`Failed to release otebo success lease for ${guild.id}:${recruitment.id}: ${error.message}`);
      });
    }
  }
  
  */
  async function finishButtonOteboRecruitmentSuccess({ guild, settings, recruitment }) {
    let memberIds = await getNonBotMemberIds(guild, recruitment?.memberIds);
    if (memberIds.length < CALL_WAIT_MIN_MEMBERS || !settings?.callWaitRoleId) return false;
    const successLease = await acquireMongoLease(`otebo-success:${guild.id}:${recruitment.id}`, { leaseMs: 120_000 });
    if (!successLease) return false;
    try {
      const claimedSettings = await transitionOteboRecruitment({
        guildId: guild.id,
        recruitmentId: recruitment.id,
        fromStatuses: ["active"],
        toStatus: "success_processing",
      });
      if (!claimedSettings) return false;
      settings = claimedSettings;
      recruitment = getOteboRecruitment(settings, recruitment.id);
      if (!recruitment) return false;
      memberIds = await getNonBotMemberIds(guild, recruitment.memberIds);
      if (memberIds.length < CALL_WAIT_MIN_MEMBERS) {
        await releaseOteboSuccessClaim(
          guild,
          recruitment.id,
          new Error("参加者が成立人数を下回ったため、成立処理を取り消しました。"),
        );
        return false;
      }
      await oteboRecruitmentPanelService.removeOteboRecruitmentPanel(guild).catch((error) => logRecoverableError("Failed to hide Otebo panel during success processing", error));
  
      const channel = await resolveConfiguredTextChannel(guild, getCallWaitNoticeChannelId(settings));
      if (!channel) {
        await releaseOteboSuccessClaim(guild, recruitment.id, new Error("call_wait_notice_channel is unavailable"));
        return false;
      }
      const roleResult = await callWaitRoleService.replaceRole({
        guild,
        roleId: settings.callWaitRoleId,
        memberIds,
        sourceType: "button",
        sourceId: recruitment.id,
        reason: "ボタン募集成立通知",
        removalDelayMs: OTEBO_ROLE_REMOVE_MS,
        requiredMemberCount: CALL_WAIT_MIN_MEMBERS,
      });
      if (!roleResult.ok) {
        await releaseOteboSuccessClaim(guild, recruitment.id, new Error(roleResult.reason ?? "call_wait_role の付与に失敗しました。"));
        return false;
      }
  
      let notice;
      try {
        notice = await channel.send({
          content: formatOteboStartNoticeMessage(settings.callWaitRoleId, recruitment),
          allowedMentions: { roles: [settings.callWaitRoleId] },
        });
      } catch (error) {
        await callWaitRoleService.rollbackGeneration({ guild, generationId: roleResult.generation.generationId, reason: "ボタン募集成立通知の送信失敗" }).catch(() => null);
        await releaseOteboSuccessClaim(guild, recruitment.id, error);
        return false;
      }
  
      const notifiedAt = new Date();
      const notifiedSettings = await transitionOteboRecruitment({
        guildId: guild.id,
        recruitmentId: recruitment.id,
        fromStatuses: ["success_processing"],
        toStatus: "success_notified",
        patch: {
          successNoticeSentAt: notifiedAt.toISOString(),
          successNoticeMessageId: notice.id,
          participantRoleGrantedMemberIds: roleResult.grantedMemberIds,
          roleGenerationId: roleResult.generation.generationId,
          lastError: null,
        },
      });
      if (!notifiedSettings) {
        console.error(`Button recruitment success notice was sent but state is uncertain: ${recruitment.id}`);
        await sendOperationalLog({ guild, settings, fallbackChannel: null, content: `button recruitment success state uncertain guild=${guild.id} recruitment=${recruitment.id} generation=${roleResult.generation.generationId}` });
        return false;
      }
      settings = notifiedSettings;
      recruitment = getOteboRecruitment(settings, recruitment.id) ?? recruitment;
  
      await deleteOteboRecruitmentMessage(guild, recruitment).catch(async (error) => {
        logRecoverableError("Failed to delete completed button recruitment", error);
        const messageChannel = await resolveConfiguredTextChannel(guild, recruitment.channelId);
        const message = messageChannel?.messages?.fetch
          ? await messageChannel.messages.fetch(recruitment.messageId).catch(() => null)
          : null;
        await message?.edit({
          content: "この募集は成立しました。",
          components: [],
          allowedMentions: { parse: [] },
        }).catch(() => null);
      });
  
      const voiceStatusSessions = { ...getOteboVoiceStatusSessions(settings) };
      const voiceStatusSession = createOteboVoiceStatusSession({ recruitment, memberIds: roleResult.grantedMemberIds, notifiedAt });
      if (voiceStatusSession) voiceStatusSessions[voiceStatusSession.id] = voiceStatusSession;
      const savedSettings = await saveGuildSettingsWithCurrent(guild.id, settings, {
        oteboRecruitments: { ...getOteboRecruitments(settings), [recruitment.id]: { ...recruitment, roleGenerationId: roleResult.generation.generationId } },
        oteboRecruitmentSlot: {
          ...(settings.oteboRecruitmentSlot ?? {}),
          status: "success_notified",
          recruitmentId: recruitment.id,
          generationId: roleResult.generation.generationId,
          updatedAt: new Date().toISOString(),
        },
        ...(voiceStatusSession ? { oteboVoiceStatusSessions: voiceStatusSessions } : {}),
      });
      await oteboRecruitmentPanelService.removeOteboRecruitmentPanel(guild).catch((error) => logRecoverableError("Failed to hide Otebo panel after success", error));
      clearOteboRecruitmentTimers(guild.id, recruitment.id);
      await sendOteboApplicantLog({ guild, settings: savedSettings, action: "notify", memberIds: roleResult.grantedMemberIds });
      if (voiceStatusSession) {
        scheduleOteboVoiceStatusDeadline(guild, voiceStatusSession);
        await processOteboVoiceStatusSessions(guild, savedSettings);
      }
      return true;
    } finally {
      await releaseMongoLease(successLease).catch((error) => logRecoverableError("Failed to release button success lease", error));
    }
  }
  
  async function deleteOteboRecruitmentMessage(guild, recruitment) {
    if (!recruitment?.channelId || !recruitment?.messageId) return { deleted: true, missing: true };
    const channel = await resolveConfiguredTextChannel(guild, recruitment.channelId);
    if (!channel?.messages?.fetch) throw new Error("Button recruitment channel is unavailable");
    const message = await channel.messages.fetch(recruitment.messageId).catch((error) => {
      if (error?.code === 10008 || error?.code === "10008") return null;
      throw error;
    });
    if (!message) return { deleted: true, missing: true };
    await message.delete();
    return { deleted: true, missing: false };
  }
  
  async function editOteboRecruitmentMessageClosed(guild, recruitment, content = "このボタン募集は終了しました。") {
    if (!recruitment?.channelId || !recruitment?.messageId) return;
    const channel = await resolveConfiguredTextChannel(guild, recruitment.channelId).catch(() => null);
    const message = await channel?.messages?.fetch?.(recruitment.messageId).catch(() => null);
    await message?.edit({ content, components: [], allowedMentions: { parse: [] } }).catch((error) => {
      logRecoverableError("Failed to edit closed button recruitment message", error);
    });
  }
  
  async function addTemporaryRoleToMembers({ guild, roleId, memberIds, reason, sourceType = "otebo", sourceId }) {
    const roleMemberIds = [];
    const grantedMemberIds = [];
  
    for (const memberId of normalizeCallWaitMemberIds(memberIds)) {
      const member = await guild.members.fetch(memberId).catch(() => null);
  
      if (!member || member.user?.bot) {
        continue;
      }
  
      if (member.roles.cache.has(roleId)) {
        roleMemberIds.push(member.id);
        continue;
      }
  
      try {
        await member.roles.add(roleId, reason);
        await VoiceParticipantRoleGrant.updateOne(
          {
            guildId: guild.id,
            memberId: member.id,
            roleId,
            sourceType,
            sourceId: sourceId ?? "unknown",
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
              roleId,
              sourceType,
              sourceId: sourceId ?? "unknown",
            },
          },
          { upsert: true },
        );
        roleMemberIds.push(member.id);
        grantedMemberIds.push(member.id);
      } catch (error) {
        await member.roles.remove(roleId, "Rollback untracked temporary role").catch((rollbackError) => {
          console.error(`Failed to roll back temporary role for ${member.id}: ${rollbackError.message}`);
        });
        console.error(`Failed to add temporary call role to ${member.id}: ${error.message}`);
      }
    }
  
    return { memberIds: roleMemberIds, grantedMemberIds };
  }
  
  async function scheduleOteboRoleRemoval({ guild, roleId, memberIds, recruitmentId }) {
    const normalizedIds = normalizeCallWaitMemberIds(memberIds);
    const actionKey = `otebo-role-remove:${guild.id}:${recruitmentId ?? roleId}`;
    await schedulePersistentRoleRemoval({
      actionKey,
      type: "otebo_role_remove",
      guild,
      roleId,
      memberIds: normalizedIds,
      delayMs: OTEBO_ROLE_REMOVE_MS,
      timers: oteboRecruitmentTimers,
      payload: { sourceType: "otebo", sourceId: recruitmentId ?? "unknown" },
    });
    return;
    const key = getOteboRoleTimerKey(guild.id, roleId, Date.now());
    const timer = setTimeout(() => {
      oteboRecruitmentTimers.delete(key);
      void removeTemporaryRoleFromMembers({
        guild,
        roleId,
        memberIds,
        reason: "ボタン募集の20分経過による自動解除",
      }).catch((error) => {
        console.error(`Failed to remove otebo role: ${error.message}`, error);
      });
    }, OTEBO_ROLE_REMOVE_MS);
  
    oteboRecruitmentTimers.set(key, timer);
  }
  
  async function removeTemporaryRoleFromMembers({ guild, roleId, memberIds, reason, sourceType = "otebo", sourceId }) {
    const errors = [];
    for (const memberId of normalizeCallWaitMemberIds(memberIds)) {
      const member = await guild.members.fetch(memberId).catch(() => null);
  
      if (!member) {
        continue;
      }
  
      await removeVoiceParticipantRole(member, roleId, {
        sourceType,
        sourceId: sourceId ?? "unknown",
      }).catch((error) => {
        console.error(`Failed to remove temporary role from ${member.id}: ${error.message}`);
        errors.push(error);
      });
    }
    if (errors.length) throw new AggregateError(errors, "Failed to remove one or more temporary roles.");
  }
  
  async function processOteboVoiceStatusSessions(guild, settings) {
    let sessions = { ...getOteboVoiceStatusSessions(settings) };
    let changed = false;
    const now = Date.now();
  
    for (const session of Object.values(sessions)) {
      if (!session?.id) {
        continue;
      }
  
      if (session.statusChannelId) {
        const clearAt = new Date(session.clearAt);
  
        if (Number.isFinite(clearAt.getTime()) && clearAt.getTime() <= now) {
          await clearOteboVoiceStatusSession(guild, session);
          delete sessions[session.id];
          changed = true;
        } else {
          scheduleOteboVoiceStatusClear(guild, session);
        }
  
        continue;
      }
  
      const notifiedAt = new Date(session.notifiedAt);
  
      if (
        !Number.isFinite(notifiedAt.getTime()) ||
        now - notifiedAt.getTime() >= OTEBO_VOICE_STATUS_DEADLINE_MS
      ) {
        delete sessions[session.id];
        changed = true;
        continue;
      }
  
      const voiceChannel = findFirstOteboVoiceStatusChannel(guild, session.memberIds);
  
      if (!voiceChannel) {
        scheduleOteboVoiceStatusDeadline(guild, session);
        continue;
      }
  
      let nextSession = session;
  
      if (!session.durationMinutes) {
        delete sessions[session.id];
        changed = true;
        continue;
      }
  
      const statusText = `会話時間：${getOteboVoiceStatusLabel(session.duration)}(予定)`;
  
      await setVoiceChannelStatus(
        voiceChannel,
        statusText,
        "ボタン募集の参加者がVCに集まったため",
      ).then(() => {
        const statusSetAt = new Date();
        sessions[session.id] = {
          ...nextSession,
          statusChannelId: voiceChannel.id,
          statusSetAt: statusSetAt.toISOString(),
          clearAt: new Date(
            statusSetAt.getTime() +
              minutesToMs(session.durationMinutes) +
              OTEBO_VOICE_STATUS_EXTRA_MS,
          ).toISOString(),
        };
        scheduleOteboVoiceStatusClear(guild, sessions[session.id]);
        changed = true;
      }).catch((error) => {
        console.error(`Failed to set otebo voice status: ${error.message}`);
        sessions[session.id] = nextSession;
        scheduleOteboVoiceStatusDeadline(guild, session);
      });
    }
  
    if (!changed) {
      return settings;
    }
  
    return saveGuildSettingsWithCurrent(guild.id, settings, {
      oteboVoiceStatusSessions: sessions,
    });
  }
  
  function findFirstOteboVoiceStatusChannel(guild, memberIds) {
    const targetMemberIds = new Set(normalizeCallWaitMemberIds(memberIds));
    const voiceTypes = new Set([ChannelType.GuildVoice, ChannelType.GuildStageVoice]);
  
    for (const channel of guild.channels.cache.values()) {
      if (!voiceTypes.has(channel.type) || !channel?.isVoiceBased?.()) {
        continue;
      }
  
      let count = 0;
  
      for (const member of channel.members.values()) {
        if (!member.user?.bot && targetMemberIds.has(member.id)) {
          count += 1;
        }
      }
  
      if (count >= CALL_WAIT_MIN_MEMBERS) {
        return channel;
      }
    }
  
    return null;
  }
  
  async function clearOteboVoiceStatusSession(guild, session) {
    const channel = await guild.channels.fetch(session.statusChannelId).catch(() => null);
  
    if (!channel?.isVoiceBased?.()) {
      return;
    }
  
    await setVoiceChannelStatus(
      channel,
      "",
      "ボタン募集で設定した会話時間ステータスの自動解除",
    ).catch((error) => {
      console.error(`Failed to clear otebo voice status: ${error.message}`);
    });
  }
  
  function scheduleOteboVoiceStatusClear(guild, session) {
    const clearAt = new Date(session.clearAt);
  
    if (!Number.isFinite(clearAt.getTime())) {
      return;
    }
  
    const key = getOteboVoiceStatusTimerKey(guild.id, session.id);
    const existingTimer = oteboRecruitmentTimers.get(key);
  
    if (existingTimer) {
      clearTimeout(existingTimer);
    }
  
    const timer = setTimeout(() => {
      oteboRecruitmentTimers.delete(key);
      void processOteboVoiceStatusClear(guild.id, session.id).catch((error) => {
        console.error(`Failed to process otebo voice status clear: ${error.message}`, error);
      }).finally(() => requestOperationalStatusRefresh(guild.id, "otebo-voice-status-clear"));
    }, Math.max(1000, clearAt.getTime() - Date.now()));
  
    oteboRecruitmentTimers.set(key, timer);
  }
  
  function scheduleOteboVoiceStatusDeadline(guild, session) {
    const notifiedAt = new Date(session.notifiedAt);
  
    if (!Number.isFinite(notifiedAt.getTime())) {
      return;
    }
  
    const key = getOteboVoiceStatusTimerKey(guild.id, session.id);
    const existingTimer = oteboRecruitmentTimers.get(key);
  
    if (existingTimer) {
      clearTimeout(existingTimer);
    }
  
    const deadlineAt = notifiedAt.getTime() + OTEBO_VOICE_STATUS_DEADLINE_MS;
    const timer = setTimeout(() => {
      oteboRecruitmentTimers.delete(key);
      void processOteboVoiceStatusDeadline(guild.id, session.id).catch((error) => {
        console.error(`Failed to process otebo voice status deadline: ${error.message}`, error);
      }).finally(() => requestOperationalStatusRefresh(guild.id, "otebo-voice-status-deadline"));
    }, Math.max(1000, deadlineAt - Date.now()));
  
    oteboRecruitmentTimers.set(key, timer);
  }
  
  async function processOteboVoiceStatusClear(guildId, sessionId) {
    const guild =
      client.guilds.cache.get(guildId) ??
      (await client.guilds.fetch(guildId).catch(() => null));
  
    if (!guild) {
      return;
    }
  
    const settings = await getGuildSettings(guild.id);
    const sessions = { ...getOteboVoiceStatusSessions(settings) };
    const session = sessions[sessionId];
  
    if (!session) {
      return;
    }
  
    await clearOteboVoiceStatusSession(guild, session);
    delete sessions[sessionId];
    await saveGuildSettingsWithCurrent(guild.id, settings, {
      oteboVoiceStatusSessions: sessions,
    });
    await oteboRecruitmentPanelService.ensureOteboRecruitmentPanel(guild).catch((error) => logRecoverableError("Failed to restore Otebo panel after voice status cleanup", error));
  }
  
  async function processOteboVoiceStatusDeadline(guildId, sessionId) {
    const guild =
      client.guilds.cache.get(guildId) ??
      (await client.guilds.fetch(guildId).catch(() => null));
  
    if (!guild) {
      return;
    }
  
    const settings = await getGuildSettings(guild.id);
    const sessions = { ...getOteboVoiceStatusSessions(settings) };
    const session = sessions[sessionId];
  
    if (!session || session.statusChannelId) {
      return;
    }
  
    const notifiedAt = new Date(session.notifiedAt);
  
    if (
      Number.isFinite(notifiedAt.getTime()) &&
      Date.now() - notifiedAt.getTime() < OTEBO_VOICE_STATUS_DEADLINE_MS
    ) {
      scheduleOteboVoiceStatusDeadline(guild, session);
      return;
    }
  
    delete sessions[sessionId];
    await saveGuildSettingsWithCurrent(guild.id, settings, {
      oteboVoiceStatusSessions: sessions,
    });
    await oteboRecruitmentPanelService.ensureOteboRecruitmentPanel(guild).catch((error) => logRecoverableError("Failed to restore Otebo panel after voice status deadline", error));
  }
  
  async function sendOteboApplicantLog({
    guild,
    settings,
    action,
    userId = null,
    memberIds,
  }) {
    const actionLabel =
      action === "create"
        ? "募集が作成されました"
        : action === "join"
          ? "参加希望ボタンが押されました"
          : action === "cancel"
            ? "参加キャンセルボタンが押されました"
            : action === "notify"
              ? "集合通知を送信しました"
              : action === "owner_cancel"
                ? "募集者が募集をキャンセルしました"
                : action === "publish"
                  ? "募集メッセージを集合通知送信先へ移動しました"
                : "希望者リストをリセットしました";
    const list = await formatCallWaitApplicantList(guild, memberIds);
  
    await sendOperationalLog({
      guild,
      settings,
      fallbackChannel: null,
      content: [
        `ボタン募集システム: ${actionLabel}`,
        `操作ユーザー: ${userId ? `<@${userId}>` : "システム"}`,
        "現在の参加予定者:",
        list,
      ].join("\n"),
      allowedMentions: { parse: [] },
    });
  }
  
  function clearOteboRecruitmentTimers(guildId, recruitmentId) {
    for (const [key, timer] of oteboRecruitmentTimers.entries()) {
      if (key.startsWith(`${guildId}:${recruitmentId}:`)) {
        clearTimeout(timer);
        oteboRecruitmentTimers.delete(key);
      }
    }
  }
  
  function clearOteboConfirmationTimer(guildId, recruitmentId, memberId) {
    const key = getOteboConfirmationTimerKey(guildId, recruitmentId, memberId);
    const timer = oteboRecruitmentTimers.get(key);
  
    if (timer) {
      clearTimeout(timer);
      oteboRecruitmentTimers.delete(key);
    }
  }
  
  function getOteboDeadlineTimerKey(guildId, recruitmentId) {
    return `${guildId}:${recruitmentId}:deadline`;
  }
  
  function getOteboPublishTimerKey(guildId, recruitmentId) {
    return `${guildId}:${recruitmentId}:publish`;
  }
  
  function getOteboConfirmationTimerKey(guildId, recruitmentId, memberId) {
    return `${guildId}:${recruitmentId}:confirm:${memberId}`;
  }
  
  function getOteboRoleTimerKey(guildId, roleId, startedAt) {
    return `${guildId}:role:${roleId}:${startedAt}`;
  }
  
  function getOteboVoiceStatusTimerKey(guildId, sessionId) {
    return `${guildId}:voice-status:${sessionId}`;
  }

  return {
    handleSendCallWait,
    handleSendOtebo,
    handleOteboButton,
    handleOteboCreateButton,
    handleOteboDraftSelect,
    handleOteboDraftNoteButton,
    handleOteboDraftSubmitButton,
    handleOteboNoteModal,
    createOteboRecruitmentFromDraft,
    createButtonOteboRecruitmentFromDraft,
    handleOteboJoinButton,
    handleOteboImmediateJoin,
    formatOteboImmediateJoinReply,
    startOteboImmediateReplyCountdown,
    handleOteboMemberCancelButton,
    handleOteboOwnerCancelButton,
    handleOteboOwnerCancelConfirmButton,
    cancelOteboParticipation,
    cancelButtonOteboRecruitment,
    respondOteboCancel,
    scheduleNextCallWaitTick,
    processCallWaitForAllGuilds,
    processCallWaitForGuild,
    sendCallWaitPromptForGuild,
    validateCallWaitSettings,
    evaluateCallWaitPrompt,
    deleteCallWaitPrompt,
    deleteCallWaitMessage,
    getCallWaitInterestComponents,
    buildCallWaitInterestReceiptContent,
    formatCallWaitInterestEndedContent,
    formatCallWaitInterestCanceledContent,
    formatCallWaitInterestJoinedContent,
    getCallWaitPromptUrl,
    formatCallWaitInterestEndNotificationContent,
    endCallWaitInterestsForRecruitment,
    retryPendingCallWaitEndNotifications,
    endOrphanedCallWaitInterests,
    isCallWaitDmFailure,
    editDeferredEphemeralReply,
    deferComponentResponse,
    deferCommandResponse,
    registerCallWaitInterestFromPublicButton,
    cancelCallWaitInterestFromPublicButton,
    cancelCallWaitInterestFromDm,
    endCallWaitInterest,
    cancelJoinedCallWaitInterest,
    editCallWaitInterestMessages,
    handleCallWaitInterestThresholdSelect,
    registerCallWaitParticipant,
    finalizeCallWaitParticipantRegistration,
    joinCallWaitFromInterestDm,
    reconcileCallWaitInterestThresholds,
    enableCallWaitInterestRenotification,
    refreshCallWaitPromptMessage,
    notifyCallWaitInterests,
    handleCallWaitButton,
    sendCallWaitApplicantLog,
    sendCallWaitInterestStateLog,
    formatCallWaitApplicantList,
    formatCallWaitInterestList,
    mergeActiveButtonRecruitmentIntoScheduled,
    grantCallWaitRoleAndQueueNotice,
    maybeSendPendingCallWaitStartNotice,
    normalizeCallWaitMemberIds,
    getNonBotMemberIds,
    getCallWaitPromptChannelId,
    getCallWaitNoticeChannelId,
    scheduleCallWaitRoleRemoval,
    schedulePersistentRoleRemoval,
    scheduleWaitingVcCleanup,
    executeWaitingVcCleanup,
    cancelKokuchiRoleRemovalWait,
    executeScheduledRoleRemoval,
    completeCallWaitRoleGenerationLifecycle,
    executeSplitFinishNotice,
    restoreScheduledActions,
    scheduleCallWaitFollowupCheck,
    executeCallWaitFollowup,
    runCallWaitFollowupCheck,
    sendCallWaitSkippedNotice,
    removeCallWaitRoleFromMembers,
    getCallWaitActiveVoiceMemberIds,
    formatCallWaitPromptV2,
    getCallWaitIntervalMinutes,
    getCallWaitSlotKey,
    formatJstTime,
    createOteboDraftRows,
    createOteboTimeOptions,
    createButtonOteboDraftRows,
    formatButtonOteboDraftContent,
    getNextQuarterHourStart,
    createDefaultOteboDraft,
    formatOteboDraftContent,
    formatOteboOwnerCancelMessage,
    updateOteboDraftMenuAfterModal,
    createOteboJoinRow,
    createButtonOteboJoinRow,
    createOteboMemberCancelRow,
    createButtonOteboMemberCancelRow,
    createOteboOwnerCancelConfirmRow,
    formatOteboRecruitmentMessage,
    editOteboRecruitmentMessage,
    getOteboRecruitmentAllowedMentions,
    shouldMentionBosyuInOteboRecruitment,
    formatOteboStartNoticeMessage,
    getOteboScheduledDurationText,
    getOteboImmediateDurationPrefix,
    normalizeOteboDuration,
    normalizeOteboNote,
    sanitizeDiscordMentions,
    getOteboQuickConfirmSeconds,
    getOteboDraftKey,
    createOteboRecruitmentId,
    validateOteboSettings,
    getOteboRecruitments,
    getOteboRecruitment,
    getOteboVoiceStatusSessions,
    isActiveOteboRecruitment,
    findActiveOteboRecruitmentByOwner,
    findActiveButtonOteboRecruitment,
    saveOteboRecruitmentState,
    deleteOteboRecruitmentState,
    addUniqueMemberId,
    createOteboVoiceStatusSession,
    getOteboDurationMinutes,
    getOteboVoiceStatusLabel,
    restoreOteboRecruitmentTimers,
    restoreCallWaitRoleGenerations,
    scheduleOteboRecruitmentTimers,
    shouldScheduleOteboNoticePublish,
    getOteboNoticePublishAt,
    processOteboNoticePublish,
    scheduleOteboImmediateConfirmation,
    processOteboImmediateConfirmation,
    processOteboDeadline,
    releaseOteboSuccessClaim,
    finishOteboRecruitmentSuccess,
    finishButtonOteboRecruitmentSuccess,
    deleteOteboRecruitmentMessage,
    editOteboRecruitmentMessageClosed,
    addTemporaryRoleToMembers,
    scheduleOteboRoleRemoval,
    removeTemporaryRoleFromMembers,
    processOteboVoiceStatusSessions,
    findFirstOteboVoiceStatusChannel,
    clearOteboVoiceStatusSession,
    scheduleOteboVoiceStatusClear,
    scheduleOteboVoiceStatusDeadline,
    processOteboVoiceStatusClear,
    processOteboVoiceStatusDeadline,
    sendOteboApplicantLog,
    clearOteboRecruitmentTimers,
    clearOteboConfirmationTimer,
    getOteboDeadlineTimerKey,
    getOteboPublishTimerKey,
    getOteboConfirmationTimerKey,
    getOteboRoleTimerKey,
    getOteboVoiceStatusTimerKey,
    shutdown() {
      if (callWaitTimer) clearTimeout(callWaitTimer);
      callWaitTimer = null;
    },
  };
}
