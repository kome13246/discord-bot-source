export function createInteractionHandler({
  isShuttingDown,
  messageFlags,
  services,
  handlers,
  ids,
  onError = async (_interaction, error) => { throw error; },
  onFinally = async () => {},
  logger = console,
}) {
  return async function handleInteraction(interaction) {
    if (isShuttingDown()) {
      if (!interaction.deferred && !interaction.replied) {
        await interaction.reply({
          content: "Botは再起動中です。少し待ってからもう一度お試しください。",
          flags: messageFlags.Ephemeral,
        }).catch((error) => logger.error("Failed to reply during shutdown:", error));
      }
      return;
    }

    try {
    if (interaction.isButton()) {
      if (interaction.customId.startsWith("setup:")) return await handlers.handleSetupInteraction(interaction);
      if (interaction.customId === "rtc:ready" || interaction.customId === "rtc:cancel") return await services.rtc?.handleInteraction?.(interaction);
      if (interaction.customId.startsWith("vcdm:")) return await services.vcDm.handleInteraction(interaction);
      if (interaction.customId.startsWith("operational:")) return await services.operationalManagement.handle(interaction);
      if (
        interaction.customId.startsWith(`${ids.splitReviewOpen}:`)
        || interaction.customId.startsWith(`${ids.splitReviewSubmit}:`)
      ) return await handlers.handleSplitReviewButton(interaction);
      if (interaction.customId.startsWith(`${ids.splitRandomTopic}:`)) return await handlers.handleSplitRandomTopicButton(interaction);
      if (interaction.customId.startsWith("vc_control:")) return await services.voiceChannelControl.handle(interaction);
      if (interaction.customId === "bosyu_edit") return await handlers.handleBosyuButton(interaction);
      if (interaction.customId === "profile_open") return await handlers.handleProfileOpen(interaction);
      if (interaction.customId.startsWith("profile_publish:")) return await handlers.handleProfilePublishButton(interaction);
      if (interaction.customId.startsWith("session_cancel:")) return await handlers.handleSessionButton(interaction);
      if (interaction.customId.startsWith("auto_split:")) return await handlers.handleAutoSplitButton(interaction);
      if (interaction.customId.startsWith("suggest_topic:")) return await handlers.handleSuggestTopicButton(interaction);
      if (interaction.customId.startsWith("feedback_form_button:")) return await handlers.handleFeedbackFormButton(interaction);
      if (interaction.customId === ids.diaryJoin || interaction.customId === ids.diaryLeave) return await handlers.handleDiaryButton(interaction);

      if (
        interaction.customId === ids.callWaitJoin
        || interaction.customId === ids.callWaitInterest
        || interaction.customId === ids.callWaitCancel
        || interaction.customId.startsWith(`${ids.callWaitCancel}:`)
        || interaction.customId.startsWith("call_wait_interest_")
      ) return await handlers.handleCallWaitButton(interaction);

      if (interaction.customId.startsWith(`${ids.kokuchiReservationCancel}:`)) {
        return await handlers.handleKokuchiReservationCancel(interaction);
      }

      if (
        interaction.customId === ids.oteboCreate
        || interaction.customId === ids.oteboDraftNote
        || interaction.customId === ids.oteboDraftSubmit
        || interaction.customId === ids.oteboDraftCancel
        || interaction.customId.startsWith(`${ids.oteboJoin}:`)
        || interaction.customId.startsWith(`${ids.oteboMemberCancel}:`)
        || interaction.customId.startsWith(`${ids.oteboOwnerCancel}:`)
        || interaction.customId.startsWith(`${ids.oteboOwnerCancelConfirm}:`)
      ) return await handlers.handleOteboButton(interaction);

      return;
    }

    if (interaction.isUserSelectMenu?.() && interaction.customId.startsWith("vcdm:")) {
      return await services.vcDm.handleInteraction(interaction);
    }

    // Setup uses Discord's typed channel/role select menus in addition to
    // string selects.  discord.js does not classify typed selects as string
    // selects, so route them explicitly before the string-select branch.
    if (
      (interaction.isChannelSelectMenu?.() || interaction.isRoleSelectMenu?.())
      && interaction.customId.startsWith("setup:")
    ) {
      return await handlers.handleSetupInteraction(interaction);
    }

    if (interaction.isStringSelectMenu()) {
      if (interaction.customId.startsWith("setup:")) return await handlers.handleSetupInteraction(interaction);
      if (interaction.customId.startsWith("operational:")) return await services.operationalManagement.handle(interaction);
      if (interaction.customId.startsWith(`${ids.splitReviewSelect}:`)) return await handlers.handleSplitReviewSelect(interaction);
      if (interaction.customId.startsWith("vc_control:")) return await services.voiceChannelControl.handle(interaction);
      if (interaction.customId.startsWith(`${ids.oteboDraftSelect}:`)) return await handlers.handleOteboDraftSelect(interaction);
      if (interaction.customId.startsWith(`${ids.callWaitInterestSelect}:`)) return await handlers.handleCallWaitInterestThresholdSelect(interaction);
      return;
    }

    if (interaction.isModalSubmit()) {
      if (interaction.customId.startsWith("operational:")) return await services.operationalManagement.handle(interaction);
      if (interaction.customId.startsWith(`${ids.splitReviewModal}:`)) return await handlers.handleSplitReviewModal(interaction);
      if (interaction.customId.startsWith("vc_control:")) return await services.voiceChannelControl.handle(interaction);
      if (interaction.customId === "profile_modal") return await handlers.handleProfileModal(interaction);
      if (interaction.customId.startsWith("bosyu_edit_modal:")) return await handlers.handleBosyuEditModal(interaction);
      if (interaction.customId.startsWith("feedback_form_modal:")) return await handlers.handleFeedbackFormModal(interaction);
      if (interaction.customId === ids.oteboNoteModal) return await handlers.handleOteboNoteModal(interaction);
      return;
    }

    if (!interaction.isChatInputCommand()) return;
    const commandHandler = {
      splitvc: handlers.handleSplitVoice,
      botstatus: services.operationalManagement.handleCommand,
      config: handlers.handleConfig,
      checkbot: handlers.handleCheckbot,
      setup: handlers.handleSetup,
      "setup-profile": handlers.handleSetupProfile,
      addwadai: handlers.handleAddWadai,
      showwadai: handlers.handleShowWadai,
      delwadai: handlers.handleDelWadai,
      addfukyo: services.fukyoTheme.addTheme,
      showfukyo: services.fukyoTheme.showThemes,
      delfukyo: services.fukyoTheme.deleteTheme,
      sendfukyo: services.fukyoTheme.sendTheme,
      kokuchi: handlers.handleKokuchi,
      remove: handlers.handleRemoveRole,
      sendcallwait: handlers.handleSendCallWait,
      senddiary: handlers.handleSendDiary,
      setupforms: handlers.handleSetupForms,
      setting: handlers.handleSetting,
      show: handlers.handleShowReview,
    }[interaction.commandName];

    if (commandHandler) await commandHandler(interaction);
    } catch (error) {
      await onError(interaction, error);
    } finally {
      await onFinally(interaction);
    }
  };
}
