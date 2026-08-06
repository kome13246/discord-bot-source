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
      if (interaction.customId.startsWith("vcdm:")) return services.vcDm.handleInteraction(interaction);
      if (interaction.customId.startsWith("operational:")) return services.operationalManagement.handle(interaction);
      if (
        interaction.customId.startsWith(`${ids.splitReviewOpen}:`)
        || interaction.customId.startsWith(`${ids.splitReviewSubmit}:`)
      ) return handlers.handleSplitReviewButton(interaction);
      if (interaction.customId.startsWith(`${ids.splitRandomTopic}:`)) return handlers.handleSplitRandomTopicButton(interaction);
      if (interaction.customId.startsWith("vc_control:")) return services.voiceChannelControl.handle(interaction);
      if (interaction.customId === "bosyu_edit") return handlers.handleBosyuButton(interaction);
      if (interaction.customId === "profile_open") return handlers.handleProfileOpen(interaction);
      if (interaction.customId.startsWith("profile_publish:")) return handlers.handleProfilePublishButton(interaction);
      if (interaction.customId.startsWith("session_cancel:")) return handlers.handleSessionButton(interaction);
      if (interaction.customId.startsWith("auto_split:")) return handlers.handleAutoSplitButton(interaction);
      if (interaction.customId.startsWith("suggest_topic:")) return handlers.handleSuggestTopicButton(interaction);
      if (interaction.customId.startsWith("feedback_form_button:")) return handlers.handleFeedbackFormButton(interaction);

      if (
        interaction.customId === ids.callWaitJoin
        || interaction.customId === ids.callWaitInterest
        || interaction.customId === ids.callWaitCancel
        || interaction.customId.startsWith(`${ids.callWaitCancel}:`)
        || interaction.customId.startsWith("call_wait_interest_")
      ) return handlers.handleCallWaitButton(interaction);

      if (interaction.customId.startsWith(`${ids.kokuchiReservationCancel}:`)) {
        return handlers.handleKokuchiReservationCancel(interaction);
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
      ) return handlers.handleOteboButton(interaction);

      return;
    }

    if (interaction.isUserSelectMenu?.() && interaction.customId.startsWith("vcdm:")) {
      return services.vcDm.handleInteraction(interaction);
    }

    if (interaction.isStringSelectMenu()) {
      if (interaction.customId.startsWith("operational:")) return services.operationalManagement.handle(interaction);
      if (interaction.customId.startsWith(`${ids.splitReviewSelect}:`)) return handlers.handleSplitReviewSelect(interaction);
      if (interaction.customId.startsWith("vc_control:")) return services.voiceChannelControl.handle(interaction);
      if (interaction.customId.startsWith(`${ids.oteboDraftSelect}:`)) return handlers.handleOteboDraftSelect(interaction);
      if (interaction.customId.startsWith(`${ids.callWaitInterestSelect}:`)) return handlers.handleCallWaitInterestThresholdSelect(interaction);
      return;
    }

    if (interaction.isModalSubmit()) {
      if (interaction.customId.startsWith("operational:")) return services.operationalManagement.handle(interaction);
      if (interaction.customId.startsWith(`${ids.splitReviewModal}:`)) return handlers.handleSplitReviewModal(interaction);
      if (interaction.customId.startsWith("vc_control:")) return services.voiceChannelControl.handle(interaction);
      if (interaction.customId === "profile_modal") return handlers.handleProfileModal(interaction);
      if (interaction.customId.startsWith("bosyu_edit_modal:")) return handlers.handleBosyuEditModal(interaction);
      if (interaction.customId.startsWith("feedback_form_modal:")) return handlers.handleFeedbackFormModal(interaction);
      if (interaction.customId === ids.oteboNoteModal) return handlers.handleOteboNoteModal(interaction);
      return;
    }

    if (!interaction.isChatInputCommand()) return;

    const commandHandler = {
      splitvc: handlers.handleSplitVoice,
      botstatus: services.operationalManagement.handleCommand,
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
