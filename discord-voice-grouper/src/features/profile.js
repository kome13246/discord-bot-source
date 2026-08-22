import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  MessageFlags,
  ModalBuilder,
  PermissionsBitField,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { UserProfile } from "../models/user-profile.js";
import {
  normalizeProfileValue,
  refreshProfileInVoice,
  summarizeProfileError,
} from "../profile-service.js";
import {
  buildProfileRegistrationPanelPayload,
} from "../profile-registration-panel-service.js";
import { saveProfileRegistrationPanel } from "../profile-registration-panel-store.js";
import {
  canSendPublicProfile,
  canPublishProfile,
  profilePublishButton,
  publishProfile,
  refreshPublishedProfile,
} from "../profile-publication-service.js";

export function createProfileFeature({
  getGuildSettings,
  sendOperationalLog,
  profileRegistrationPanelService,
  logRecoverableError,
  acquireMongoLease,
  releaseMongoLease,
  saveGuildSettingsWithCurrent,
  saveVersionedGuildConfiguration = null,
  replyOrFollowUp,
  formatSettings,
}) {
  const profilePublicationLocks = new Set();

  async function saveProfileConfiguration(interaction, previousSettings, patch) {
    if (typeof saveVersionedGuildConfiguration !== "function") {
      return saveGuildSettingsWithCurrent(interaction.guildId, previousSettings, patch);
    }
    try {
      return await saveVersionedGuildConfiguration(interaction.guildId, patch, {
        expectedRevision: Number.isInteger(Number(previousSettings?.configRevision))
          ? Number(previousSettings.configRevision)
          : 0,
        actorUserId: interaction.user?.id ?? null,
        source: "setting",
        reason: "profile-setting",
      });
    } catch (error) {
      if (error?.code === "CONFIGURATION_REVISION_CONFLICT") {
        await replyOrFollowUp(interaction, { content: "設定が別の管理者によって先に更新されました。現在の設定を再表示してから、もう一度実行してください。上書きは行っていません。", flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
        return null;
      }
      if (error?.code === "CONFIGURATION_TRANSACTIONS_UNAVAILABLE") {
        await replyOrFollowUp(interaction, { content: "設定の安全な履歴保存に必要なMongoDBトランザクションが利用できないため、設定を変更しませんでした。", flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
        return null;
      }
      throw error;
    }
  }

  async function handleSetupProfile(interaction) {
    if (!interaction.inGuild() || !interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator)) {
      await replyOrFollowUp(interaction, { content: "管理者のみ実行できます。", flags: MessageFlags.Ephemeral }); return;
    }
    await interaction.reply(buildProfileRegistrationPanelPayload());
    const message = await interaction.fetchReply();
    try {
      await saveProfileRegistrationPanel({ guildId: interaction.guildId, channelId: message.channelId, messageId: message.id });
    } catch (error) {
      await message.delete().catch(() => null);
      throw error;
    }
  }
  
  async function handleProfileOpen(interaction) {
    if (!interaction.inGuild()) return interaction.reply({ content: "サーバー内で使用してください。", flags: MessageFlags.Ephemeral });
    let profile;
    try {
      profile = await UserProfile.findOne({ guildId: interaction.guildId, userId: interaction.user.id }).lean();
    } catch (error) {
      await logProfileFailure(interaction, "profile modal fetch failed", error);
      await interaction.reply({ content: "自己紹介の取得に失敗しました。", flags: MessageFlags.Ephemeral });
      return;
    }
    const input = (id, label, style, max, value, required) => new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setMaxLength(max).setRequired(required).setValue(value ?? ""));
    const modal = new ModalBuilder().setCustomId("profile_modal").setTitle("自己紹介登録・編集").addComponents(
      input("profile_nickname", "呼び名", TextInputStyle.Short, 20, normalizeProfileValue(profile?.nickname, 20), true),
      input("profile_status", "現状", TextInputStyle.Short, 30, normalizeProfileValue(profile?.status, 30), false),
      input("profile_hobby", "趣味", TextInputStyle.Paragraph, 80, normalizeProfileValue(profile?.hobby, 80), false),
      input("profile_comment", "ひとこと", TextInputStyle.Paragraph, 150, normalizeProfileValue(profile?.comment, 150), false),
    );
    await interaction.showModal(modal);
  }
  
  async function handleProfileModal(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const submittedValues = {
      nickname: normalizeProfileValue(interaction.fields.getTextInputValue("profile_nickname"), 20),
      status: normalizeProfileValue(interaction.fields.getTextInputValue("profile_status"), 30),
      hobby: normalizeProfileValue(interaction.fields.getTextInputValue("profile_hobby"), 80),
      comment: normalizeProfileValue(interaction.fields.getTextInputValue("profile_comment"), 150),
    };
    if (!submittedValues.nickname) {
      await interaction.editReply({ content: "呼び名は必須です。" });
      return;
    }
  
    let existing;
    try {
      existing = await UserProfile.findOne({ guildId: interaction.guildId, userId: interaction.user.id });
      const values = {
        nickname: submittedValues.nickname,
        status: submittedValues.status,
        hobby: submittedValues.hobby,
        comment: submittedValues.comment,
      };
      await UserProfile.findOneAndUpdate(
        { guildId: interaction.guildId, userId: interaction.user.id },
        values,
        { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
      );
    } catch (error) {
      await interaction.editReply({ content: "自己紹介の保存に失敗しました。" }).catch((error) => logRecoverableError("Recoverable asynchronous operation failed", error));
      await logProfileFailure(interaction, "profile save failed", error);
      return;
    }
  
    const settings = await getGuildSettings(interaction.guildId).catch(async (error) => {
      await logProfileFailure(interaction, "profile settings fetch failed", error, existing);
      return null;
    });
    const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
    if (member?.voice?.channel && settings) {
      await refreshProfileInVoice(member, { guild: interaction.guild, settings, sendOperationalLog }).catch((error) => {
        void logProfileFailure(interaction, "profile VC refresh failed", error, existing);
      });
    }
  
    const latestProfile = await UserProfile.findOne({ guildId: interaction.guildId, userId: interaction.user.id }).catch(async (error) => {
      await logProfileFailure(interaction, "profile latest fetch failed", error, existing);
      return null;
    });
    if (!latestProfile) {
      await interaction.editReply({ content: "自己紹介の保存後確認に失敗しました。" });
      return;
    }
    let publication = { status: "unpublished" };
    if (latestProfile && settings) {
      try {
        publication = await refreshPublishedProfile({
          guild: interaction.guild,
          member: member ?? { displayName: interaction.user.username, user: interaction.user },
          profile: latestProfile,
          settings,
        });
      } catch (error) {
        await logProfileFailure(interaction, "profile public update failed", error, latestProfile);
        publication = { status: "update-failed" };
      }
    }
  
    const baseMessage = existing ? "自己紹介を更新しました。" : "自己紹介を登録しました。";
    if (publication.status === "updated") {
      await interaction.editReply({ content: `${baseMessage}\n自己紹介チャンネルのメッセージも更新しました。` });
      return;
    }
    if (publication.status === "update-failed") {
      await interaction.editReply({ content: `${baseMessage}\n自己紹介は更新しましたが、チャンネルのメッセージ更新に失敗しました。` });
      return;
    }
  
    const availability = settings
      ? await canPublishProfile({ guild: interaction.guild, settings }).catch(async (error) => {
        await logProfileFailure(interaction, "profile public channel check failed", error, latestProfile);
        return { ok: false, reason: "channel-unavailable" };
      })
      : { ok: false, reason: "channel-unavailable" };
    const content = publication.status === "missing"
      ? `${baseMessage}\n以前送信した自己紹介メッセージが見つかりませんでした。もう一度自己紹介チャンネルに送信しますか？`
      : availability.ok
        ? `${baseMessage}\n自己紹介チャンネルに送信しますか？`
        : availability.reason === "not-configured"
          ? `${baseMessage}\n自己紹介チャンネルが設定されていないため、現在は公開できません。管理者が /setting profile で設定してください。`
          : `${baseMessage}\n自己紹介チャンネルを利用できないため、現在は公開できません。`;
    const button = profilePublishButton(interaction.user.id);
    const components = availability.ok
      ? [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(button.customId).setLabel(button.label).setStyle(ButtonStyle.Primary))]
      : [];
    await interaction.editReply({ content, components });
  }
  
  async function logProfileFailure(interaction, processName, error, profile = null) {
    const settings = await getGuildSettings(interaction.guildId).catch(() => null);
    const message = `[${processName}] guild=${interaction.guild?.name ?? "?"}(${interaction.guildId ?? "?"}) user=${interaction.user.username}(${interaction.user.id}) publishedChannelId=${profile?.publishedChannelId ?? "?"} publishedMessageId=${profile?.publishedMessageId ?? "?"} error=${summarizeProfileError(error)} time=${new Date().toISOString()}`;
    console.error(message);
    await sendOperationalLog({ guild: interaction.guild, settings, fallbackChannel: null, content: message });
  }
  
  async function handleProfilePublishButton(interaction) {
    if (!interaction.inGuild()) {
      await interaction.reply({ content: "サーバー内で使用してください。", flags: MessageFlags.Ephemeral });
      return;
    }
    const [, targetUserId] = interaction.customId.split(":");
    if (targetUserId !== interaction.user.id) {
      await interaction.reply({ content: "このボタンは自己紹介を登録した本人だけが使用できます。", flags: MessageFlags.Ephemeral });
      return;
    }
  
    const lockKey = `${interaction.guildId}:${targetUserId}`;
    if (profilePublicationLocks.has(lockKey)) {
      await interaction.reply({ content: "自己紹介の送信処理を実行中です。", flags: MessageFlags.Ephemeral });
      return;
    }
    profilePublicationLocks.add(lockKey);
    let profile = null;
    let profileLease = null;
    try {
      await interaction.update({ content: "自己紹介を送信しています…", components: [] });
      profileLease = await acquireMongoLease(`profile-publish:${interaction.guildId}:${targetUserId}`, { leaseMs: 2 * 60 * 1000 });
      if (!profileLease) {
        await interaction.editReply({ content: "自己紹介の送信処理を実行中です。少し待ってから確認してください。" });
        return;
      }
      profile = await UserProfile.findOne({ guildId: interaction.guildId, userId: targetUserId });
      if (!profile) {
        await interaction.editReply({ content: "自己紹介が見つかりません。先に自己紹介を保存してください。" });
        return;
      }
      const member = await interaction.guild.members.fetch(targetUserId).catch(() => null);
      if (interaction.user.bot || member?.user.bot) {
        await interaction.editReply({ content: "Botの自己紹介は公開できません。" });
        return;
      }
      const settings = await getGuildSettings(interaction.guildId);
      const publicMember = member ?? { displayName: interaction.user.username, user: interaction.user };
      const result = await publishProfile({ guild: interaction.guild, member: publicMember, profile, settings });
      if (result.status === "published") {
        void profileRegistrationPanelService.requestProfileRegistrationPanelMove(interaction.guild, "profile-published").catch((error) => {
          logRecoverableError("Profile registration panel move after publication failed", error);
        });
      }
      if (result.status === "published" || result.status === "updated") {
        await interaction.editReply({ content: "自己紹介チャンネルへ送信しました。" });
        return;
      }
      if (result.status === "missing") {
        const button = profilePublishButton(targetUserId);
        await interaction.editReply({
          content: "以前送信した自己紹介メッセージが見つかりませんでした。もう一度送信してください。",
          components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(button.customId).setLabel(button.label).setStyle(ButtonStyle.Primary))],
        });
        return;
      }
      const reason = result.status === "not-configured"
        ? "自己紹介チャンネルが設定されていません。管理者が /setting profile で設定してください。"
        : result.status === "permission-denied"
          ? "Botに自己紹介チャンネルの閲覧・送信・Embed権限がありません。"
          : "自己紹介チャンネルを利用できません。設定とBotの権限を確認してください。";
      await interaction.editReply({ content: reason });
    } catch (error) {
      await logProfileFailure(interaction, "profile publish failed", error, profile);
      const content = error?.code === "PUBLIC_PROFILE_STATE_SAVE_FAILED"
        ? "自己紹介の送信状態を保存できなかったため、投稿を取り消しました。時間をおいてもう一度お試しください。"
        : "自己紹介の送信に失敗しました。時間をおいてもう一度お試しください。";
      await interaction.editReply({ content }).catch((error) => logRecoverableError("Recoverable asynchronous operation failed", error));
    } finally {
      if (profileLease) {
        await releaseMongoLease(profileLease).catch((error) => {
          console.error(`Failed to release profile publication lease for ${lockKey}: ${error.message}`);
        });
      }
      profilePublicationLocks.delete(lockKey);
    }
  }
  
  async function handleProfileIntroductionSetting(interaction) {
    const previousSettings = await getGuildSettings(interaction.guildId);
    const channel = interaction.options.getChannel("introduction_channel", false);
    if (!channel) {
      const settings = await saveProfileConfiguration(interaction, previousSettings, { profileIntroductionChannelId: null });
      if (!settings) return;
      await replyOrFollowUp(interaction, { content: `自己紹介チャンネルの設定を解除しました。${formatApplyStatus(settings)}\n\n${formatSettings(settings)}`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
      return;
    }
    if (channel.type !== ChannelType.GuildText || !canSendPublicProfile(channel, interaction.guild)) {
      await replyOrFollowUp(interaction, { content: "Botが閲覧・メッセージ送信・Embed送信できるテキストチャンネルを指定してください。", flags: MessageFlags.Ephemeral });
      return;
    }
    const settings = await saveProfileConfiguration(interaction, previousSettings, { profileIntroductionChannelId: channel.id });
    if (!settings) return;
    await replyOrFollowUp(interaction, { content: `自己紹介チャンネルを <#${channel.id}> に設定しました。${formatApplyStatus(settings)}\n\n${formatSettings(settings)}`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  }

  function formatApplyStatus(settings) {
    const status = settings?.apply?.status;
    if (status === "applied") return " Discordへのパネル反映も完了しました。";
    if (status === "blocked" || status === "failed") return " 設定は保存済みですが、Discordへのパネル反映を確認できません。/config apply_status を確認してください。";
    return " 設定履歴へ保存しました。Discordへのパネル反映状態は /config apply_status で確認できます。";
  }

  return {
    handleSetupProfile,
    handleProfileOpen,
    handleProfileModal,
    handleProfilePublishButton,
    handleProfileIntroductionSetting,
  };
}
