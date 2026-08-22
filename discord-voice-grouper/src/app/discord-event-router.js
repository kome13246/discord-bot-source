import { isVoiceChannelControlTarget } from "../voice-channel-control-service.js";

export function registerDiscordEventHandlers({
  client,
  Events,
  ChannelType,
  debugLogs,
  isShuttingDown,
  getGuildSettings,
  requestOperationalStatusRefresh,
  logRecoverableError,
  services,
  handlers,
  logger = console,
}) {
  client.on(Events.Error, (error) => logger.error("Discord client error:", error));
  client.on(Events.Warn, (message) => logger.warn(`Discord client warning: ${message}`));
  client.on(Events.ShardError, (error, shardId) => logger.error(`Discord shard ${shardId} error:`, error));
  client.on(Events.ShardDisconnect, (event, shardId) => logger.error(`Discord shard ${shardId} disconnected: code=${event.code} reason=${event.reason ?? ""}`));
  client.on(Events.ShardReady, (shardId) => logger.log(`Discord shard ${shardId} ready.`));
  client.on(Events.ShardReconnecting, (shardId) => logger.warn(`Discord shard ${shardId} reconnecting...`));
  if (debugLogs) client.on(Events.Debug, (message) => logger.debug(`Discord debug: ${message}`));

  client.on(Events.MessageCreate, async (message) => {
    if (isShuttingDown()) return;
    try {
      await handlers.handleDisboardBumpMessage(message);
      await handlers.handleTopicRequestMessage(message);
      void handlers.handleProfileRegistrationPanelMessage(message).catch((error) => {
        logRecoverableError("Profile registration panel message processing failed", error);
      });
      void handlers.handleOteboRecruitmentPanelMessage(message).catch((error) => {
        logRecoverableError("Otebo recruitment panel message processing failed", error);
      });
    } catch (error) {
      logger.error("Message processing failed", {
        guildId: message.guildId ?? null,
        channelId: message.channelId ?? null,
        userId: message.author?.id ?? null,
        error: error?.stack ?? error,
      });
    }
  });

  client.on(Events.GuildMemberAdd, async (member) => {
    if (isShuttingDown()) return;
    try {
      await services.vcDm.handleMemberAdd(member);
    } catch (error) {
      logRecoverableError("VC DM member-add processing failed", error);
    }
  });

  client.on(Events.GuildMemberRemove, async (member) => {
    if (isShuttingDown()) return;
    try {
      await services.vcDm.handleMemberRemove(member);
    } catch (error) {
      logRecoverableError("VC DM member-remove processing failed", error);
    }
  });

  client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
    if (isShuttingDown()) return;
    try {
      await services.vcDm.handleVoiceState(oldState, newState);
    } catch (error) {
      logRecoverableError("VC DM voice-state processing failed", error);
    }
    try {
      await handlers.handleProfileVoiceState(oldState, newState);
    } catch (error) {
      logRecoverableError("Profile voice-state processing failed", error);
    }
    try {
      await handlers.handleVoiceStateUpdate(oldState, newState);
      const guild = newState.guild ?? oldState.guild;
      const settings = await getGuildSettings(guild?.id).catch(() => null);
      if (newState.guild) await services.oteboRecruitmentPanel.ensureOteboRecruitmentPanel(newState.guild, settings).catch(() => null);
    } catch (error) {
      logRecoverableError("Voice participant role processing failed", error);
    }
    try {
      await services.voiceChannelControl.handleVoiceState(oldState, newState);
    } catch (error) {
      logRecoverableError("Voice exit schedule processing failed", error);
    }
    requestOperationalStatusRefresh(newState.guild?.id ?? oldState.guild?.id, "voice-state");
  });

  client.on(Events.ChannelCreate, async (channel) => {
    if (channel.type === ChannelType.GuildVoice) {
      try {
        const result = await services.voiceChannelControl.ensurePanel(channel);
        if (["unknown", "blocked"].includes(result?.status)) {
          logger.warn(`VC control panel create did not complete: guild=${channel.guildId ?? channel.guild?.id ?? "unknown"} channel=${channel.id} status=${result.status} reason=${result.reason ?? "unspecified"}`);
        }
      } catch (error) {
        logger.error("VC control panel create failed:", error);
      }
    }
    if (channel.guildId) requestOperationalStatusRefresh(channel.guildId, "channel-create");
  });

  client.on(Events.ChannelDelete, async (channel) => {
    if (channel.type === ChannelType.GuildVoice) {
      await services.voiceChannelControl.cleanup(channel).catch((error) => logRecoverableError("Recoverable asynchronous operation failed", error));
    }
    if (channel.guildId) requestOperationalStatusRefresh(channel.guildId, "channel-delete");
  });

  client.on(Events.ChannelUpdate, async (oldChannel, newChannel) => {
    if (newChannel.type !== ChannelType.GuildVoice) return;
    const settings = await getGuildSettings(newChannel.guild.id).catch(() => null);
    const wasTarget = isVoiceChannelControlTarget(oldChannel, settings);
    const isTarget = isVoiceChannelControlTarget(newChannel, settings);
    if (isTarget && !wasTarget) {
      try {
        const result = await services.voiceChannelControl.ensurePanel(newChannel);
        if (["unknown", "blocked"].includes(result?.status)) {
          logger.warn(`VC control panel update did not complete: guild=${newChannel.guild?.id ?? newChannel.guildId ?? "unknown"} channel=${newChannel.id} status=${result.status} reason=${result.reason ?? "unspecified"}`);
        }
      } catch (error) {
        logRecoverableError("Recoverable asynchronous operation failed", error);
      }
    }
    if (!isTarget && wasTarget) {
      await services.voiceChannelControl.cleanup(newChannel).catch((error) => logRecoverableError("Recoverable asynchronous operation failed", error));
    }
    requestOperationalStatusRefresh(newChannel.guild.id, "channel-update");
  });
}
