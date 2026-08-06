import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { SplitProcessSession } from "../models/split-process-session.js";
import { SplitReview } from "../models/split-review.js";
import { SplitReviewDraft } from "../models/split-review-draft.js";

const SPLIT_REVIEW_OPEN = "split_review_open";
const SPLIT_REVIEW_SELECT = "split_review_select";
const SPLIT_REVIEW_SUBMIT = "split_review_submit";
const SPLIT_REVIEW_MODAL = "split_review_comment";

const TALK_AMOUNT_LABELS = {
  much: "かなり話せた",
  moderate: "そこそこだった",
  little: "あまり話せなかった",
};
const DURATION_FEELING_LABELS = {
  long: "少し長かった",
  just_right: "ちょうどよかった",
  short: "少し短かった",
};
const PRACTICE_EFFECT_LABELS = {
  much: "かなりなった",
  some: "すこしはなった",
  little: "あまりならなかった",
};

export function createSplitReviewFeature({
  client,
  getGuildSettings,
  sendOperationalLog,
}) {
  async function handleShowReview(interaction) {
    if (!interaction.inGuild()) return;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const settings = await getGuildSettings(interaction.guildId);
    const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
    const canManageGuild = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
    const hasModeratorRole = settings?.formModeratorRoleId
      && member?.roles.cache.has(settings.formModeratorRoleId);
    if (!canManageGuild && !hasModeratorRole) {
      return interaction.editReply({
        content: "このコマンドを使用する権限がありません。",
        flags: MessageFlags.Ephemeral,
      });
    }
    const question = interaction.options.getString("question", true);
    const isAllQuestion = question === "all";
    const recent = interaction.options.getInteger("recent", false);
    let sessions = await SplitProcessSession.find({
      guildId: interaction.guildId,
      reviewAggregationEligible: true,
      status: { $in: ["feedback_open", "completed"] },
      isTestSession: { $ne: true },
    }).sort({ conversationStartedAt: -1, createdAt: -1 }).lean();
    if (recent) sessions = sessions.slice(0, recent);
    const sessionIds = sessions.map((session) => session.sessionId);
    const reviews = sessionIds.length
      ? await SplitReview.find({
        guildId: interaction.guildId,
        splitSessionId: { $in: sessionIds },
        questionnaireVersion: 1,
      }).lean()
      : [];
    const eligibleCount = sessions.reduce(
      (total, session) => total + (session.reviewEligibleMemberIds?.length ?? 0),
      0,
    );
    const dates = [...new Set(sessions
      .slice()
      .reverse()
      .map((session) => jstReviewDate(session.conversationStartedAt ?? session.createdAt)))];
    const dateText = dates.join("・");
    const scopeLines = [
      `対象：${recent ? `直近${recent}回` : "全期間"}`,
      recent
        ? `対象日：${dateText || "対象セッションはありません"}`
        : `対象期間：${dateText ? `${dates[0]}〜${dates[dates.length - 1]}` : "対象セッションはありません"}`,
      `開催回数：${sessions.length}回`,
      `延べ参加者数：${eligibleCount}人`,
      ...(isAllQuestion ? [
        `回答数：${reviews.length}件`,
        `回答率：${eligibleCount ? `${(reviews.length / eligibleCount * 100).toFixed(1)}%` : "算出不可"}`,
      ] : []),
    ];
  
    const fields = {
      "1": { field: "talkAmount", title: "どれくらい喋れた？", choices: [["much", "かなり話せた"], ["moderate", "そこそこだった"], ["little", "あまり話せなかった"]] },
      "2": { field: "durationFeeling", title: "時間はどう感じた？", choices: [["long", "少し長かった"], ["just_right", "ちょうどよかった"], ["short", "少し短かった"]] },
      "3": { field: "practiceEffect", title: "会話の練習になった？", choices: [["much", "かなりなった"], ["some", "すこしはなった"], ["little", "あまりならなかった"]] },
    };
  
    const renderQuestion = ({ field, title, choices }) => {
      const valid = reviews.filter((review) => choices.some(([value]) => review[field] === value));
      if (!valid.length) return `【${title}】\n回答はまだありません。`;
  
      const resultLines = choices.map(([value, label]) => {
        const count = valid.filter((review) => review[field] === value).length;
        return `${label}：${count}票（${(count / valid.length * 100).toFixed(1)}%）`;
      });
      return [
        `【${title}】`,
        ...(!isAllQuestion ? [
          `回答数：${valid.length}件`,
          `回答率：${eligibleCount ? `${(valid.length / eligibleCount * 100).toFixed(1)}%` : "算出不可"}`,
        ] : []),
        "",
        ...resultLines,
      ].join("\n");
    };
  
    if (question !== "all" && !fields[question]) {
      await interaction.editReply({
        content: "選択した質問は集計できません。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const renderedQuestions = ["1", "2", "3"]
      .map((key) => renderQuestion(fields[key]))
      .join("\n\n");
    const content = question === "all"
      ? [...scopeLines, "", renderedQuestions].join("\n")
      : [...scopeLines, "", renderQuestion(fields[question])].join("\n");
    await interaction.editReply({ content, flags: MessageFlags.Ephemeral });
  }
  

  function splitReviewRows(sessionId, draft = {}) {
    draft ??= {};
    const select = (field, placeholder, options, value) => new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
      .setCustomId(`${SPLIT_REVIEW_SELECT}:${sessionId}:${field}`).setPlaceholder(placeholder)
      .addOptions(options.map((option) => ({ ...option, default: option.value === value }))));
    return [
      select("talk", "どれくらい喋れた？", [{ label: "かなり話せた", value: "much" }, { label: "そこそこだった", value: "moderate" }, { label: "あまり話せなかった", value: "little" }], draft.talkAmount),
      select("duration", "時間はどう感じた？", [{ label: "少し長かった", value: "long" }, { label: "ちょうどよかった", value: "just_right" }, { label: "少し短かった", value: "short" }], draft.durationFeeling),
      select("practice", "会話の練習になった？", [{ label: "かなりなった", value: "much" }, { label: "すこしはなった", value: "some" }, { label: "あまりならなかった", value: "little" }], draft.practiceEffect),
      new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`${SPLIT_REVIEW_SUBMIT}:${sessionId}:comment`).setLabel("コメント付きで送信").setStyle(ButtonStyle.Primary), new ButtonBuilder().setCustomId(`${SPLIT_REVIEW_SUBMIT}:${sessionId}:plain`).setLabel("コメントなしで送信").setStyle(ButtonStyle.Secondary)),
    ];
  }
  async function getEligibleReviewSession(interaction, sessionId) {
    const session = await SplitProcessSession.findOne({ sessionId, guildId: interaction.guildId }).lean();
    if (!session || session.status !== "feedback_open" || !session.reviewDeadlineAt || Date.now() > new Date(session.reviewDeadlineAt).getTime()) return { error: "感想の受付時間は終了しました。" };
    const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
    if (!member?.roles.cache.has(session.participantRoleId)) return { error: "この感想フォームは、今回の参加者のみ利用できます。" };
    const review = await SplitReview.exists({ guildId: interaction.guildId, splitSessionId: sessionId, userId: interaction.user.id });
    if (review) return { error: "この回の感想はすでに送信済みです。" };
    return { session };
  }
  async function deferSplitReviewReply(interaction) {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    }
  }
  
  async function handleSplitReviewButton(interaction) {
    const [, sessionId, kind] = interaction.customId.split(":");
    const isOpenButton = interaction.customId.startsWith(`${SPLIT_REVIEW_OPEN}:`);
  
    // A modal must be acknowledged with showModal; do not defer this branch.
    if (kind === "comment") {
      const checked = await getEligibleReviewSession(interaction, sessionId);
      if (checked.error) {
        return interaction.reply({ content: checked.error, flags: MessageFlags.Ephemeral });
      }
      const draft = await SplitReviewDraft.findOne({
        guildId: interaction.guildId,
        splitSessionId: sessionId,
        userId: interaction.user.id,
      }).lean();
      if (!draft?.talkAmount || !draft?.durationFeeling || !draft?.practiceEffect) {
        return interaction.reply({ content: "3つの項目をすべて選択してください。", flags: MessageFlags.Ephemeral });
      }
      const modal = new ModalBuilder()
        .setCustomId(`${SPLIT_REVIEW_MODAL}:${sessionId}`)
        .setTitle("感想コメント")
        .addComponents(new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId("comment")
            .setLabel("コメント（任意）")
            .setStyle(TextInputStyle.Paragraph)
            .setMaxLength(1500)
            .setRequired(false),
        ));
      return interaction.showModal(modal);
    }
  
    if (!isOpenButton) {
      await deferSplitReviewReply(interaction);
    }
    const checked = await getEligibleReviewSession(interaction, sessionId);
    if (checked.error) {
      const reply = { content: checked.error, flags: MessageFlags.Ephemeral };
      return interaction.deferred ? interaction.editReply(reply) : interaction.reply(reply);
    }
    const draft = await SplitReviewDraft.findOne({
      guildId: interaction.guildId,
      splitSessionId: sessionId,
      userId: interaction.user.id,
    }).lean();
    if (isOpenButton) {
      return interaction.reply({
        content: "感想の入力ありがとうございます。この感想は運営に送信されます。\n今後に活かしていくために、遠慮せず送っていただけるとありがたいです。",
        components: splitReviewRows(sessionId, draft),
        flags: MessageFlags.Ephemeral,
      });
    }
    if (!draft?.talkAmount || !draft?.durationFeeling || !draft?.practiceEffect) {
      return interaction.editReply({ content: "3つの項目をすべて選択してください。" });
    }
    await submitSplitReview(interaction, checked.session, draft, "");
  }
  async function handleSplitReviewSelect(interaction) {
    const [, sessionId, field] = interaction.customId.split(":");
    const checked = await getEligibleReviewSession(interaction, sessionId);
    if (checked.error) return interaction.update({ content: checked.error, components: [] });
    const key = { talk: "talkAmount", duration: "durationFeeling", practice: "practiceEffect" }[field];
    const draft = await SplitReviewDraft.findOneAndUpdate(
      { guildId: interaction.guildId, splitSessionId: sessionId, userId: interaction.user.id },
      { $set: { [key]: interaction.values[0], updatedAt: new Date(), expiresAt: checked.session.reviewDeadlineAt } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    ).lean();
    await interaction.update({
      content: "感想の入力ありがとうございます。この感想は運営に送信されます。\n今後に活かしていくために、遠慮せず送っていただけるとありがたいです。",
      components: splitReviewRows(sessionId, draft),
    });
  }
  async function handleSplitReviewModal(interaction) {
    const sessionId = interaction.customId.split(":")[1];
    await deferSplitReviewReply(interaction);
    const checked = await getEligibleReviewSession(interaction, sessionId);
    if (checked.error) return interaction.editReply({ content: checked.error });
    const draft = await SplitReviewDraft.findOne({
      guildId: interaction.guildId,
      splitSessionId: sessionId,
      userId: interaction.user.id,
    }).lean();
    if (!draft?.talkAmount || !draft?.durationFeeling || !draft?.practiceEffect) {
      return interaction.editReply({ content: "3つの項目をすべて選択してください。" });
    }
    await submitSplitReview(
      interaction,
      checked.session,
      draft,
      interaction.fields.getTextInputValue("comment"),
    );
  }
  
  async function deliverSplitReview(guild, review) {
    const claimed = await SplitReview.findOneAndUpdate(
      { _id: review._id, deliveryStatus: { $in: ["pending", "failed"] } },
      {
        $set: { deliveryStatus: "processing", deliveryLastTriedAt: new Date() },
        $inc: { deliveryRetryCount: 1 },
        $unset: { deliveryLastError: 1 },
      },
      { returnDocument: "after", lean: true },
    );
    if (!claimed) return { delivered: false, error: "Review delivery is already being processed" };
  
    try {
      if (!claimed.reviewChannelId) throw new Error("感想送信先が設定されていません。");
      const channel = await guild.channels.fetch(claimed.reviewChannelId);
      if (!channel?.send) throw new Error("感想送信先チャンネルを使用できません。");
      const members = claimed.groupMemberIds
        .filter((id) => id !== claimed.userId)
        .map((id, index) => `${index + 1}. <@${id}>`)
        .join("\n") || "（他のメンバーはいません）";
      const message = await channel.send({
        content: `<@${claimed.userId}> さんの感想（${claimed.eventDate}分）\n\nどれくらい喋れた？：${TALK_AMOUNT_LABELS[claimed.talkAmount] ?? "不明"}\n時間はどうだった？：${DURATION_FEELING_LABELS[claimed.durationFeeling] ?? "不明"}\n会話の練習になった？：${PRACTICE_EFFECT_LABELS[claimed.practiceEffect] ?? "不明"}${claimed.comment ? `\n\nコメント：${claimed.comment}` : ""}\n\n<@${claimed.userId}>さんのグループメンバー\n${members}`,
        allowedMentions: { parse: [] },
      });
      const completed = await SplitReview.updateOne(
        { _id: claimed._id, deliveryStatus: "processing" },
        { $set: { deliveryStatus: "delivered", reviewMessageId: message.id, reviewChannelId: channel.id }, $unset: { deliveryLastError: 1 } },
      );
      if (completed.matchedCount !== 1 || completed.modifiedCount !== 1) {
        throw new Error("Review delivery succeeded but completion could not be persisted");
      }
      return { delivered: true };
    } catch (error) {
      const failed = await SplitReview.updateOne(
        { _id: claimed._id, deliveryStatus: "processing" },
        { $set: { deliveryStatus: "failed", deliveryLastError: error.message, deliveryLastTriedAt: new Date() } },
      ).catch((statusError) => {
        console.error("Failed to persist split review delivery failure:", statusError);
        return null;
      });
      if (!failed || failed.matchedCount !== 1) {
        console.error("Split review delivery failed and its retry state could not be confirmed:", error);
      }
      return { delivered: false, error: error.message };
    }
  }
  
  async function restoreFailedSplitReviewDeliveries() {
    const reviews = await SplitReview.find({ deliveryStatus: "failed" }).lean();
    let retried = 0;
    for (const review of reviews) {
      try {
        const guild = client.guilds.cache.get(review.guildId) ?? await client.guilds.fetch(review.guildId).catch(() => null);
        if (!guild) throw new Error("Guild is unavailable");
        const result = await deliverSplitReview(guild, review);
        if (result.delivered) retried += 1;
        else console.error(`Failed to retry split review delivery ${review._id}: ${result.error}`);
      } catch (error) {
        console.error(`Failed to restore split review delivery ${review._id}: ${error.message}`);
      }
    }
    if (reviews.length) console.log(`Startup split review deliveries retried: ${retried}/${reviews.length}`);
  }
  
  async function submitSplitReview(interaction, session, draft, rawComment) {
    await deferSplitReviewReply(interaction);
    const finalCheck = await getEligibleReviewSession(interaction, session.sessionId);
    if (finalCheck.error) return interaction.editReply({ content: finalCheck.error });
    session = finalCheck.session;
    const comment = rawComment?.trim() || undefined;
    const group = (session.groupSnapshots ?? []).find(
      (item) => item.memberIds?.includes(interaction.user.id),
    );
    let review;
    let settings = null;
    try {
      settings = await getGuildSettings(interaction.guildId);
    } catch (error) {
      console.error("Failed to load settings before saving split review:", error);
    }
    try {
      review = await SplitReview.create({
        guildId: interaction.guildId,
        splitSessionId: session.sessionId,
        questionnaireVersion: 1,
        eventStartedAt: session.conversationStartedAt ?? session.createdAt,
        eventDate: jstReviewDate(session.conversationStartedAt ?? session.createdAt),
        userId: interaction.user.id,
        participantRoleId: session.participantRoleId,
        groupNumber: group?.groupNumber,
        groupMemberIds: group?.memberIds ?? [],
        talkAmount: draft.talkAmount,
        durationFeeling: draft.durationFeeling,
        practiceEffect: draft.practiceEffect,
        comment,
        deliveryStatus: "pending",
        reviewChannelId: settings?.reviewSendChannelId ?? null,
      });
    } catch (error) {
      if (error?.code === 11000) {
        return interaction.editReply({ content: "この回の感想はすでに送信済みです。" });
      }
      return interaction.editReply({
        content: "感想の送信に失敗しました。時間をおいてもう一度お試しください。",
      });
    }
  
    await SplitReviewDraft.deleteOne({
      guildId: interaction.guildId,
      splitSessionId: session.sessionId,
      userId: interaction.user.id,
    }).catch((error) => console.error("Failed to delete split review draft:", error));
  
    const delivery = await deliverSplitReview(interaction.guild, review);
    if (!delivery.delivered) {
      const failureLogContent = `【感想転送失敗】\nサーバー：${interaction.guild.name}（${interaction.guildId}）\nセッションID：${session.sessionId}\n回答者：${interaction.user.username}（${interaction.user.id}）\n感想送信先：${review.reviewChannelId}\nDB保存状態：保存済み\ndeliveryStatus：failed\nエラー内容：${delivery.error}\n発生日時：${new Date().toISOString()}`;
      const logSettings = settings ?? await getGuildSettings(interaction.guildId).catch((settingsError) => {
        console.error("Failed to load settings for review failure log:", settingsError);
        return null;
      });
      if (!logSettings) {
        console.error(failureLogContent);
      } else await sendOperationalLog({
        guild: interaction.guild,
        settings: logSettings,
        fallbackChannel: null,
        content: failureLogContent,
        allowedMentions: { parse: [] },
      }).catch((logError) => {
        console.error("Review delivery and operational log failed", failureLogContent, delivery.error, logError);
      });
      await interaction.editReply({
        content: "回答内容は保存しましたが、運営チャンネルへの転送に失敗しました。\n運営側で再送処理を行います。",
        components: [],
      }).catch((error) => console.error("Failed to complete split review interaction:", error));
      return;
    }
  
    await interaction.editReply({
      content: "感想を送信しました。ご協力ありがとうございます！",
      components: [],
    }).catch((error) => console.error("Failed to complete split review interaction:", error));
  }
  function jstReviewDate(value) { const parts = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric" }).formatToParts(new Date(value)); return `${parts.find((x) => x.type === "month")?.value}月${parts.find((x) => x.type === "day")?.value}日`; }
  

  return {
    handleShowReview,
    handleSplitReviewButton,
    handleSplitReviewSelect,
    handleSplitReviewModal,
    restoreFailedSplitReviewDeliveries,
  };
}

