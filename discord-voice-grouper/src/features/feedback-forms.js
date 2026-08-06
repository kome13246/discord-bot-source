import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  ModalBuilder,
  PermissionsBitField,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";

const FORM_TYPES = {
  topic: "話題提供",
  complaint: "相談・苦情",
  suggestion: "提案・要望",
};

export function createFeedbackFormsFeature({ getGuildSettings, replyOrFollowUp }) {
  async function handleSetup(interaction) {
    if (!interaction.inGuild()) {
      await replyOrFollowUp(interaction, { content: "このコマンドはサーバー内で使ってください。", flags: MessageFlags.Ephemeral });
      return;
    }
    if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild)) {
      await replyOrFollowUp(interaction, { content: "フォームを設置するには、サーバー管理権限が必要です。", flags: MessageFlags.Ephemeral });
      return;
    }
    const settings = await getGuildSettings(interaction.guildId);
    if (!settings?.formChannelId || !settings?.formSendChannelId) {
      await replyOrFollowUp(interaction, { content: "`/setting forms form_channel:設置先 form_send_channel:転送先` を設定してください。", flags: MessageFlags.Ephemeral });
      return;
    }
    const formChannel = await interaction.guild.channels.fetch(settings.formChannelId).catch(() => null);
    if (!formChannel || typeof formChannel.send !== "function") {
      await replyOrFollowUp(interaction, { content: "フォーム設置先チャンネルへ送信できません。", flags: MessageFlags.Ephemeral });
      return;
    }
    for (const formMessage of createMessages()) {
      await formChannel.send({
        content: formMessage.content,
        components: [createButtonRow(formMessage.type)],
        allowedMentions: { parse: [] },
      });
    }
    await replyOrFollowUp(interaction, {
      content: `${formChannel} にフォームを設置しました。`,
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
  }

  async function handleButton(interaction) {
    const type = interaction.customId.slice("feedback_form_button:".length);
    const label = FORM_TYPES[type];
    if (!label) {
      await interaction.reply({ content: "不明なフォームです。", flags: MessageFlags.Ephemeral });
      return;
    }
    const modal = new ModalBuilder()
      .setCustomId(`feedback_form_modal:${type}`)
      .setTitle(`${label}フォーム`)
      .addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("feedback_form_content")
          .setLabel("内容")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(1500),
      ));
    await interaction.showModal(modal);
  }

  async function handleModal(interaction) {
    if (!interaction.inGuild()) {
      await interaction.reply({ content: "このフォームはサーバー内で使ってください。", flags: MessageFlags.Ephemeral });
      return;
    }
    const type = interaction.customId.slice("feedback_form_modal:".length);
    const label = FORM_TYPES[type];
    if (!label) {
      await interaction.reply({ content: "不明なフォームです。", flags: MessageFlags.Ephemeral });
      return;
    }
    const settings = await getGuildSettings(interaction.guildId);
    if (!settings?.formSendChannelId) {
      await interaction.reply({ content: "フォーム転送先が設定されていません。", flags: MessageFlags.Ephemeral });
      return;
    }
    const sendChannel = await interaction.guild.channels.fetch(settings.formSendChannelId).catch(() => null);
    if (!sendChannel || typeof sendChannel.send !== "function") {
      await interaction.reply({ content: "フォーム転送先チャンネルへ送信できません。", flags: MessageFlags.Ephemeral });
      return;
    }
    const content = interaction.fields.getTextInputValue("feedback_form_content").trim();
    const senderMention = `<@${interaction.user.id}>`;
    const moderatorMention = type === "complaint" && settings.formModeratorRoleId
      ? `<@&${settings.formModeratorRoleId}>`
      : null;
    await sendChannel.send({
      content: [moderatorMention, `送信者:${senderMention}`, `分類:${label}`, `内容:${content}`].filter(Boolean).join("\n"),
      allowedMentions: {
        parse: [],
        users: [],
        roles: moderatorMention ? [settings.formModeratorRoleId] : [],
      },
    });
    await interaction.reply({ content: "フォームを送信しました。", flags: MessageFlags.Ephemeral });
  }

  return { handleSetup, handleButton, handleModal };
}

export function createMessages() {
  return [
    { type: "topic", content: "会話練習会の話題ボタンに使えるような話題があればぜひ送ってください！" },
    { type: "suggestion", content: "提案および要望があればぜひお聞かせください！" },
    { type: "complaint", content: "対人トラブルや、サーバーについての苦情があればこちらへ" },
  ];
}

export function createButtonRow(type) {
  const buttonConfig = {
    topic: { label: "話題提供フォーム", style: ButtonStyle.Primary },
    suggestion: { label: "提案・要望フォーム", style: ButtonStyle.Success },
    complaint: { label: "相談・苦情フォーム", style: ButtonStyle.Secondary },
  }[type];
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`feedback_form_button:${type}`).setLabel(buttonConfig.label).setStyle(buttonConfig.style),
  );
}
