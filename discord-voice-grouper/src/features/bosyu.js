import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import {
  consumeBosyuCooldown,
  deleteBosyuEditSession,
  getActiveBosyuEditSessions,
  getBosyuEditSession,
  getExpiredBosyuEditSessions,
  saveBosyuEditSession,
} from "../bosyu-state-store.js";

export function createBosyuFeature({
  client,
  getGuildSettings,
  replyOrFollowUp,
  logRecoverableError,
}) {
  const lastBosyuTimestamps = new Map();
  const bosyuEditSessions = new Map();

  async function restoreBosyuEditSessions() {
    const expiredSessions = await getExpiredBosyuEditSessions();
    for (const session of expiredSessions) {
      await invalidateBosyuEditMessage(session).catch((error) => {
        console.error(`Failed to invalidate expired /bosyu edit ${session.messageId}: ${error.message}`);
      });
      await deleteBosyuEditSession(session.messageId).catch((error) => logRecoverableError("Recoverable asynchronous operation failed", error));
    }
    const sessions = await getActiveBosyuEditSessions();
    let restored = 0;
    for (const session of sessions) {
      bosyuEditSessions.set(session.messageId, {
        ownerId: session.ownerId,
        expiresAt: new Date(session.expiresAt).getTime(),
        bosyuMentionRoleId: session.bosyuMentionRoleId,
        anonymous: session.anonymous,
        voiceChannelId: session.voiceChannelId,
      });
      restored += 1;
      scheduleBosyuEditExpiry(session.messageId, session.channelId, new Date(session.expiresAt).getTime());
    }
    console.log(`Startup bosyu edit sessions restored: ${restored}`);
  }
  
  async function invalidateBosyuEditMessage(session) {
    const channel = await client.channels.fetch(session.channelId).catch(() => null);
    const message = channel?.messages?.fetch ? await channel.messages.fetch(session.messageId).catch(() => null) : null;
    await message?.edit({ components: [] }).catch((error) => logRecoverableError("Recoverable asynchronous operation failed", error));
  }
  
  function scheduleBosyuEditExpiry(messageId, channelId, expiresAt) {
    setTimeout(async () => {
      bosyuEditSessions.delete(messageId);
      const channel = await client.channels.fetch(channelId).catch(() => null);
      const message = channel?.messages?.fetch ? await channel.messages.fetch(messageId).catch(() => null) : null;
      await message?.edit({ components: [] }).catch((error) => logRecoverableError("Recoverable asynchronous operation failed", error));
      await deleteBosyuEditSession(messageId).catch((error) => {
        console.error(`Failed to delete expired /bosyu edit session ${messageId}: ${error.message}`);
      });
    }, Math.max(0, expiresAt - Date.now()));
  }
  

  const BOSYU_COOLDOWN_MS = 15 * 60 * 1000;
  const BOSYU_EDIT_WINDOW_MS = 15 * 60 * 1000;
  
  async function handleBosyu(interaction) {
    if (!interaction.inGuild()) {
      await interaction.reply({
        content: "このコマンドはサーバー内で使ってください。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  
    const settings = await getGuildSettings(interaction.guildId);
    const bosyuChannelId = settings?.bosyuChannelId;
    const bosyuMentionRoleId = settings?.bosyuMentionRoleId;
  
    if (bosyuChannelId && interaction.channelId !== bosyuChannelId) {
      await replyOrFollowUp(interaction, {
        content: "このチャンネルでは /bosyu を使用できません。設定された募集チャンネルで実行してください。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  
    const rateLimitKey = `${interaction.guildId}:${interaction.user.id}`;
    const now = Date.now();
    const cooldown = await consumeBosyuCooldown({
      guildId: interaction.guildId,
      userId: interaction.user.id,
      now: new Date(now),
      durationMs: BOSYU_COOLDOWN_MS,
    });
  
    if (!cooldown.allowed) {
      const remainingMs = Math.max(0, new Date(cooldown.availableAt).getTime() - now);
      const remainingMinutes = Math.floor(remainingMs / 60000);
      const remainingSeconds = Math.floor((remainingMs % 60000) / 1000);
  
      await replyOrFollowUp(interaction, {
        content: `15分以内に再度 /bosyu を使用できません。あと ${remainingMinutes}分${remainingSeconds}秒 です。`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  
    lastBosyuTimestamps.set(rateLimitKey, now);
  
    const timeValue = interaction.options.getString("time", false)?.trim() ?? "";
    let purposeValue = interaction.options.getString("purpose", false)?.trim() ?? "";
    const anonymous = interaction.options.getBoolean("anonymous", false) ?? false;
    const noteValue = interaction.options.getString("note", true).trim();
  
    const currentVoiceChannel = interaction.member?.voice?.channel;
  
    if (currentVoiceChannel?.isVoiceBased()) {
      if (purposeValue) {
        try {
          await currentVoiceChannel.edit(
            { name: purposeValue },
            "募集名目に合わせてVC名を更新",
          );
        } catch {
          // 応答は作成するが、変更できない場合は無視する
        }
      }
    }
  
    const content = formatBosyuMessage(
      timeValue,
      purposeValue,
      noteValue,
      bosyuMentionRoleId,
      anonymous,
    );
  
    await replyOrFollowUp(interaction, {
      content,
      components: [createBosyuEditRow()],
      allowedMentions: {
        roles: bosyuMentionRoleId ? [bosyuMentionRoleId] : [],
      },
    });
  
    const message = await interaction.fetchReply();
    const expiresAt = now + BOSYU_EDIT_WINDOW_MS;
  
    bosyuEditSessions.set(message.id, {
      ownerId: interaction.user.id,
      expiresAt,
      bosyuMentionRoleId,
      anonymous,
      voiceChannelId: currentVoiceChannel?.isVoiceBased() ? currentVoiceChannel.id : null,
    });
    await saveBosyuEditSession({
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      messageId: message.id,
      ownerId: interaction.user.id,
      expiresAt: new Date(expiresAt),
      bosyuMentionRoleId,
      anonymous,
      voiceChannelId: currentVoiceChannel?.isVoiceBased() ? currentVoiceChannel.id : null,
    });
    scheduleBosyuEditExpiry(message.id, interaction.channelId, expiresAt);
  
    setTimeout(async () => {
      bosyuEditSessions.delete(message.id);
  
      try {
        const channel = await client.channels.fetch(interaction.channelId).catch(() => null);
        if (!channel || typeof channel.messages?.fetch !== "function") {
          return;
        }
  
        const replyMessage = await channel.messages.fetch(message.id).catch(() => null);
        if (!replyMessage) {
          return;
        }
  
        await replyMessage.edit({ components: [] });
      } catch {
        // ignore expired cleanup errors
      }
    }, BOSYU_EDIT_WINDOW_MS);
  }
  
  async function handleBosyuButton(interaction) {
    if (!interaction.inGuild()) {
      await interaction.reply({
        content: "この操作はサーバー内で実行してください。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  
    // A modal is the initial interaction response.  Do not wait for MongoDB
    // here; startup restoration populates the short-lived edit-session cache.
    const session = bosyuEditSessions.get(interaction.message.id);
  
    if (!session || Date.now() > session.expiresAt) {
      await replyOrFollowUp(interaction, {
        content: "募集内容の編集期限が終了しました。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  
    if (interaction.user.id !== session.ownerId) {
      await replyOrFollowUp(interaction, {
        content: "この募集メッセージを編集できるのは実行者のみです。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  
    try {
      await interaction.showModal(createBosyuModal(interaction.message.id, interaction.message.content));
    } catch (error) {
      console.error(`Failed to show modal for bosyu_edit: ${error.message}`, error);
      await replyOrFollowUp(interaction, {
        content: "モーダルの表示に失敗しました。ブラウザやクライアントを最新にして再試行してください。",
        flags: MessageFlags.Ephemeral,
      });
    }
  }
  
  async function handleBosyuEditModal(interaction) {
    if (!interaction.inGuild()) {
      await replyOrFollowUp(interaction, {
        content: "この操作はサーバー内で実行してください。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  
    const messageId = interaction.customId.slice("bosyu_edit_modal:".length);
    const session = bosyuEditSessions.get(messageId) ?? await getBosyuEditSession(messageId);
  
    if (!session || Date.now() > session.expiresAt) {
      await replyOrFollowUp(interaction, {
        content: "募集内容の編集期限が終了しました。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  
    if (interaction.user.id !== session.ownerId) {
      await replyOrFollowUp(interaction, {
        content: "この募集メッセージを編集できるのは実行者のみです。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  
    const timeValue = interaction.fields.getTextInputValue("bosyu_time");
    const purposeValue = interaction.fields.getTextInputValue("bosyu_purpose");
    const noteValue = interaction.fields.getTextInputValue("bosyu_note");
    const content = formatBosyuMessage(
      timeValue,
      purposeValue,
      noteValue,
      session.bosyuMentionRoleId,
      session.anonymous,
    );
  
    const channel = interaction.channel;
    const replyMessage = await channel.messages.fetch(messageId).catch(() => null);
  
    if (!replyMessage) {
      await replyOrFollowUp(interaction, {
        content: "募集メッセージの取得に失敗しました。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  
    let replyMessageUpdated = true;
    try {
      await replyMessage.edit({
        content,
        components: Date.now() <= session.expiresAt ? [createBosyuEditRow()] : [],
        allowedMentions: {
          roles: session.bosyuMentionRoleId ? [session.bosyuMentionRoleId] : [],
        },
      });
    } catch (error) {
      replyMessageUpdated = false;
      console.error(`Failed to update bosyu message: ${error.message}`, error);
    }
  
    // Update the original VC from the bosyu session if available, otherwise fall back to the editor's current VC.
    try {
      let targetVoiceChannel = null;
      if (session.voiceChannelId) {
        targetVoiceChannel = await interaction.guild.channels.fetch(session.voiceChannelId).catch(() => null);
      }
  
      if (!targetVoiceChannel) {
        targetVoiceChannel = interaction.member?.voice?.channel;
      }
  
      if (targetVoiceChannel?.isVoiceBased()) {
        if (purposeValue?.trim()) {
          try {
            await targetVoiceChannel.edit({ name: purposeValue }, "Update VC name from bosyu edit");
          } catch (err) {
            console.error(`Failed to update bosyu VC name: ${err.message}`, err);
          }
        }
  
        // 'noteValue' (ひとこと) is included in the message content; do not attempt to set a channel status.
      }
    } catch (error) {
      console.error(`Error updating VC from bosyu edit: ${error.message}`);
    }
  
    await replyOrFollowUp(interaction, {
      content: replyMessageUpdated
        ? "募集内容を更新しました。"
        : "募集内容の更新は試みましたが、募集メッセージの編集に失敗しました。",
      flags: MessageFlags.Ephemeral,
    });
  }
  
  function createBosyuEditRow() {
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("bosyu_edit")
        .setLabel("募集内容を編集")
        .setStyle(ButtonStyle.Primary),
    );
  }
  
  function createBosyuModal(messageId, content) {
    const defaultValues = parseBosyuContent(content);
  
    return new ModalBuilder()
      .setCustomId(`bosyu_edit_modal:${messageId}`)
      .setTitle("募集内容を編集")
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId("bosyu_time")
            .setLabel("時間")
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
            .setMaxLength(100)
            .setPlaceholder("例: 1時間、30分、〇〇まで（省略可）")
            .setValue(defaultValues.time),
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId("bosyu_purpose")
            .setLabel("名目")
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
            .setMaxLength(100)
            .setPlaceholder("例: ゲーム、作業、雑談（省略可）")
            .setValue(defaultValues.purpose),
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId("bosyu_note")
            .setLabel("ひとこと")
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
            .setMaxLength(200)
            .setPlaceholder("例: 遠慮せずご参加ください！")
            .setValue(defaultValues.note),
        ),
      );
  }
  
  function parseBosyuContent(content) {
    if (!content) {
      return { time: "", purpose: "", note: "" };
    }
  
    const lines = content.split("\n").map((line) => line.trim());
    const timeLine = lines.find((line) => line.startsWith("時間:"));
    const purposeLine = lines.find((line) => line.startsWith("名目:"));
    const noteLine = lines.find((line) => line.startsWith("ひとこと:"));
  
    return {
      time: timeLine ? timeLine.replace(/^時間:\s*/, "") : "",
      purpose: purposeLine ? purposeLine.replace(/^名目:\s*/, "") : "",
      note: noteLine ? noteLine.replace(/^ひとこと:\s*/, "") : "",
    };
  }
  
  function formatBosyuMessage(time, purpose, note, mentionRoleId, anonymous = false) {
    const lines = [];
  
    if (mentionRoleId && !anonymous) {
      lines.push(`<@&${mentionRoleId}>`);
    }
  
    if (time) {
      lines.push(`時間：${time}`);
    }
  
    if (purpose) {
      lines.push(`名目：${purpose}`);
    }
  
    if (note) {
      lines.push(`ひとこと：${note}`);
    }
  
    return lines.join("\n");
  }
  

  return {
    handleBosyu,
    handleBosyuButton,
    handleBosyuEditModal,
    restoreBosyuEditSessions,
  };
}

