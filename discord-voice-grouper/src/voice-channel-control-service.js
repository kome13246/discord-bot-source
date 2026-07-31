import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder,
  MessageFlags, ModalBuilder, PermissionFlagsBits, StringSelectMenuBuilder,
  TextInputBuilder, TextInputStyle,
} from "discord.js";
import { clearLegacyVoiceControlTimers, deleteVoiceControl, getVoiceControl, upsertVoiceControl } from "./voice-channel-control-store.js";
import {
  cancelVoiceExitSchedule, cancelVoiceExitSchedulesForChannel, claimVoiceExitSchedule,
  createVoiceExitNoticeDeletion, deleteClaimedVoiceExitSchedule, deleteVoiceExitNoticeDeletion,
  getVoiceExitSchedule, incrementVoiceExitScheduleRetry, listInterruptedVoiceExitSchedules,
  listVoiceExitNoticeDeletions, listVoiceExitSchedules, removeInterruptedVoiceExitSchedule,
  saveVoiceExitSchedule,
} from "./voice-exit-schedule-store.js";

const P = "vc_control";
const EXIT_DURATIONS = [
  [5, "5分後"], [15, "15分後"], [30, "30分後"], [45, "45分後"],
  [60, "1時間後"], [75, "1時間15分後"], [90, "1時間30分後"],
  [105, "1時間45分後"], [120, "2時間後"],
];
const EXIT_CANCEL = "cancel";
const EXIT_DELAY_GRACE_MS = 15 * 60 * 1000;
const NOTICE_DELETE_DELAY_MS = 10 * 60 * 1000;
const RETRY_DELAY_MS = 5_000;
const MAX_SEND_RETRIES = 3;

const scheduleTimers = new Map();
const deletionTimers = new Map();
const key = (guildId, userId) => `${guildId}:${userId}`;
const deletionKey = (notice) => `${notice.guildId}:${notice.channelId}:${notice.messageId}`;

const panel = (channel) => ({
  embeds: [new EmbedBuilder().setTitle("VCコントロールパネル").setDescription(
    "名前変更：VC名を変更します\n"
    + "ステータス：VCの下に出る表示を設定します\n"
    + "人数制限：チャットに参加できる人数を設定します\n"
    + "退出予定：指定した時間後にVCチャットへお知らせします（自動退出はしません）",
  )],
  components: [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`${P}:name:${channel.id}`).setLabel("VC名を変更").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`${P}:limit:${channel.id}`).setLabel("人数制限を設定").setStyle(ButtonStyle.Primary),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`${P}:status:${channel.id}`).setLabel("ステータスを設定").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`${P}:exit_schedule:${channel.id}`).setLabel("退出予定を設定").setStyle(ButtonStyle.Primary),
    ),
  ],
});

function formatDuration(minutes) {
  return EXIT_DURATIONS.find(([value]) => value === minutes)?.[1] ?? `${minutes}分`;
}

function hasChannelSendPermission(channel, guild) {
  const me = guild.members?.me;
  if (!me || !channel.permissionsFor) return true;
  const permissions = channel.permissionsFor(me);
  return Boolean(permissions?.has(PermissionFlagsBits.ViewChannel) && permissions?.has(PermissionFlagsBits.SendMessages));
}

function isRetryableDiscordError(error) {
  return error?.status >= 500 || error?.code === "ETIMEDOUT" || error?.code === "ECONNRESET";
}

function normalizeVoiceExitSchedule(schedule) {
  return typeof schedule?.toObject === "function" ? schedule.toObject() : schedule;
}

function hasRequiredVoiceExitScheduleFields(schedule) {
  return Boolean(schedule?._id && schedule.guildId && schedule.userId && schedule.voiceChannelId && schedule.scheduledAt);
}

export function createVoiceChannelControlService({ getGuildSettings, sendOperationalLog = async () => {}, setVoiceChannelStatus = async (channel, status) => channel.setVoiceChannelStatus?.(status) }) {
  const getSettings = (guild) => getGuildSettings(guild.id).catch(() => null);
  const isTarget = (channel, settings) => channel?.type === ChannelType.GuildVoice
    && channel.id !== settings?.voiceReminderParentChannelId
    && channel.id !== settings?.parentChannelId
    && channel.parentId === settings?.vcControlCategoryId;
  const logFailure = async (processName, context, error, guild = context?.guild) => {
    if (!guild?.id) {
      console.error(`退出予定 ${processName}に失敗しました。guildId=${context?.guildId ?? "unknown"} userId=${context?.userId ?? "unknown"} voiceChannelId=${context?.voiceChannelId ?? context?.channelId ?? "unknown"} error=${error?.message ?? error}`);
      return;
    }
    const settings = await getSettings(guild);
    const sent = await sendOperationalLog({
      guild,
      settings,
      fallbackChannel: null,
      content: `退出予定 ${processName}に失敗しました。guildId=${context?.guildId ?? guild.id} userId=${context?.userId ?? "unknown"} voiceChannelId=${context?.voiceChannelId ?? context?.channelId ?? "unknown"} error=${error?.message ?? error}`,
    }).catch((logError) => {
      console.error("退出予定の運用ログ送信に失敗しました:", logError);
      return null;
    });
    if (!sent) console.error(`退出予定の運用ログを送信できませんでした。guildId=${guild.id}`);
  };
  const logInfo = async (content, context, guild = context?.guild) => {
    if (!guild?.id) {
      console.warn(`${content} guildId=${context?.guildId ?? "unknown"} userId=${context?.userId ?? "unknown"} voiceChannelId=${context?.voiceChannelId ?? context?.channelId ?? "unknown"}`);
      return;
    }
    const settings = await getSettings(guild);
    const sent = await sendOperationalLog({ guild, settings, fallbackChannel: null, content }).catch((error) => {
      console.error("退出予定の情報ログ送信に失敗しました:", error);
      return null;
    });
    if (!sent) console.warn(`退出予定の情報ログを送信できませんでした。guildId=${guild.id}`);
  };

  function clearScheduleTimer(guildId, userId) {
    const timerKey = key(guildId, userId);
    const timer = scheduleTimers.get(timerKey);
    if (timer) clearTimeout(timer);
    scheduleTimers.delete(timerKey);
  }

  async function ensurePanel(channel) {
    const settings = await getSettings(channel.guild);
    if (!isTarget(channel, settings)) return;
    const record = await getVoiceControl(channel.guild.id, channel.id);
    let message = record?.panelMessageId ? await channel.messages.fetch(record.panelMessageId).catch(() => null) : null;
    if (message) await message.edit(panel(channel));
    else message = await channel.send(panel(channel));
    await upsertVoiceControl(channel.guild.id, channel.id, { panelMessageId: message.id });
  }

  async function notify(schedule, alreadyClaimed = false) {
    const normalizedSchedule = normalizeVoiceExitSchedule(schedule);
    const activeGuild = normalizedSchedule?.guild;
    if (!hasRequiredVoiceExitScheduleFields(normalizedSchedule)) {
      const error = new Error("通知に必要な退出予定データが不足しています。");
      console.error("退出予定の通知を開始できません:", normalizedSchedule, error);
      await logFailure("通知予定データ検証", normalizedSchedule, error, activeGuild);
      return;
    }
    const claimed = alreadyClaimed ? normalizedSchedule : await claimVoiceExitSchedule(normalizedSchedule._id);
    if (!claimed) return;
    const channel = activeGuild?.channels?.cache?.get(claimed.voiceChannelId)
      ?? await activeGuild?.channels?.fetch?.(claimed.voiceChannelId).catch(() => null);
    const member = activeGuild?.members?.cache?.get(claimed.userId)
      ?? await activeGuild?.members?.fetch?.(claimed.userId).catch(() => null);
    if (!channel || member?.voice?.channelId !== claimed.voiceChannelId || !hasChannelSendPermission(channel, activeGuild)) {
      await deleteClaimedVoiceExitSchedule(claimed._id).catch((error) => logFailure("通知前の予定終了", claimed, error, activeGuild));
      return;
    }
    let message;
    try {
      message = await channel.send({
        content: `<@${claimed.userId}>さんが設定した退出予定時刻になりました！\nお時間は大丈夫でしょうか？`,
        allowedMentions: { parse: [], users: [claimed.userId], roles: [], repliedUser: false },
      });
    } catch (error) {
      const updated = await incrementVoiceExitScheduleRetry(claimed._id).catch(async (updateError) => {
        await logFailure("通知失敗状態更新", claimed, updateError, activeGuild);
        return null;
      });
      if (updated && updated.retryCount <= MAX_SEND_RETRIES && isRetryableDiscordError(error)) {
        scheduleTimers.set(key(updated.guildId, updated.userId), setTimeout(() => {
          scheduleTimers.delete(key(updated.guildId, updated.userId));
          void notify({ ...updated, guild: activeGuild }, true).catch((retryError) => logFailure("通知再試行", updated, retryError, activeGuild));
        }, RETRY_DELAY_MS));
        return;
      }
      await deleteClaimedVoiceExitSchedule(claimed._id).catch((deleteError) => logFailure("通知失敗後の予定終了", claimed, deleteError, activeGuild));
      await logFailure("通知送信", claimed, error, activeGuild);
      return;
    }
    const settings = await getSettings(activeGuild);
    if (settings?.voiceExitScheduleKeepMessage === false) {
      const notice = {
        guildId: claimed.guildId, channelId: channel.id, messageId: message.id,
        deleteAt: new Date(Date.now() + NOTICE_DELETE_DELAY_MS),
      };
      try {
        const persistedNotice = await createVoiceExitNoticeDeletion(notice);
        scheduleNoticeDeletion(activeGuild, persistedNotice);
      } catch (error) {
        scheduleNoticeDeletion(activeGuild, notice);
        await logFailure("通知削除予約保存", claimed, error, activeGuild);
      }
    }
    await deleteClaimedVoiceExitSchedule(claimed._id).catch((error) => logFailure("通知後の予定終了", claimed, error, activeGuild));
  }

  function scheduleVoiceExit(guild, schedule) {
    const normalizedSchedule = normalizeVoiceExitSchedule(schedule);
    if (!hasRequiredVoiceExitScheduleFields(normalizedSchedule)) {
      const error = new Error("タイマーに必要な退出予定データが不足しています。");
      console.error("退出予定タイマーを登録できません:", normalizedSchedule, error);
      void logFailure("タイマー予定データ検証", normalizedSchedule, error, guild);
      return;
    }
    clearScheduleTimer(normalizedSchedule.guildId, normalizedSchedule.userId);
    const delay = new Date(normalizedSchedule.scheduledAt).getTime() - Date.now();
    if (delay < -EXIT_DELAY_GRACE_MS) {
      return cancelVoiceExitSchedule(normalizedSchedule.guildId, normalizedSchedule.userId).catch((error) => logFailure("期限切れ処理", normalizedSchedule, error, guild));
    }
    const run = () => {
      scheduleTimers.delete(key(normalizedSchedule.guildId, normalizedSchedule.userId));
      void notify({ ...normalizedSchedule, guild }).catch((error) => logFailure("通知処理", normalizedSchedule, error, guild));
    };
    scheduleTimers.set(key(normalizedSchedule.guildId, normalizedSchedule.userId), setTimeout(run, Math.max(0, delay)));
  }

  function scheduleNoticeDeletion(guild, notice) {
    const timerKey = deletionKey(notice);
    const old = deletionTimers.get(timerKey);
    if (old) clearTimeout(old);
    deletionTimers.set(timerKey, setTimeout(() => {
      deletionTimers.delete(timerKey);
      void deleteNotice(guild, notice);
    }, Math.max(0, new Date(notice.deleteAt).getTime() - Date.now())));
  }

  async function deleteNotice(guild, notice) {
    try {
      const channel = guild.channels.cache.get(notice.channelId) ?? await guild.channels.fetch(notice.channelId);
      const message = await channel?.messages?.fetch(notice.messageId).catch(() => null);
      if (message) await message.delete();
      if (notice._id) await deleteVoiceExitNoticeDeletion(notice._id);
    } catch (error) {
      if (notice._id) await deleteVoiceExitNoticeDeletion(notice._id).catch(() => {});
      await logFailure("通知メッセージ削除", notice, error, guild);
    }
  }

  async function restore(client) {
    await clearLegacyVoiceControlTimers();
    for (const guild of client.guilds.cache.values()) {
      const settings = await getSettings(guild);
      for (const channel of guild.channels.cache.values()) if (isTarget(channel, settings)) await ensurePanel(channel).catch((error) => logFailure("パネル復旧", { guildId: guild.id, voiceChannelId: channel.id }, error, guild));
    }
    for (const schedule of await listInterruptedVoiceExitSchedules()) {
      const guild = client.guilds.cache.get(schedule.guildId);
      const removed = await removeInterruptedVoiceExitSchedule(schedule._id).catch(async (error) => {
        await logFailure("中断executing回収", schedule, error, guild);
        return null;
      });
      if (!removed) continue;
      const content = `退出予定の中断状態を起動時に回収しました。\nguildId=${schedule.guildId}\nuserId=${schedule.userId}\nvoiceChannelId=${schedule.voiceChannelId}`;
      if (guild) await logInfo(content, schedule, guild);
      else console.warn(content);
    }
    for (const schedule of await listVoiceExitSchedules()) {
      const guild = client.guilds.cache.get(schedule.guildId);
      if (guild) scheduleVoiceExit(guild, schedule);
      else await cancelVoiceExitSchedule(schedule.guildId, schedule.userId).catch((error) => logFailure("復旧", schedule, error));
    }
    for (const notice of await listVoiceExitNoticeDeletions()) {
      const guild = client.guilds.cache.get(notice.guildId);
      if (guild) scheduleNoticeDeletion(guild, notice);
      else await deleteVoiceExitNoticeDeletion(notice._id).catch((error) => logFailure("削除復旧", notice, error));
    }
  }

  async function cleanup(channel) {
    try {
      for (const schedule of await listVoiceExitSchedules()) {
        if (schedule.guildId === channel.guild.id && schedule.voiceChannelId === channel.id) clearScheduleTimer(schedule.guildId, schedule.userId);
      }
      await cancelVoiceExitSchedulesForChannel(channel.guild.id, channel.id);
    } catch (error) {
      await logFailure("VC削除時の自動取消", { guildId: channel.guild.id, voiceChannelId: channel.id }, error, channel.guild);
    }
    await deleteVoiceControl(channel.guild.id, channel.id).catch(() => {});
  }

  async function handleVoiceState(oldState, newState) {
    const guild = newState.guild ?? oldState.guild;
    const userId = newState.id ?? oldState.id;
    if (!guild || !userId || oldState.channelId === newState.channelId) return;
    try {
      const schedule = await getVoiceExitSchedule(guild.id, userId);
      if (schedule && newState.channelId !== schedule.voiceChannelId) {
        const cancelled = await cancelVoiceExitSchedule(guild.id, userId);
        if (cancelled) clearScheduleTimer(guild.id, userId);
      }
    } catch (error) {
      await logFailure("VC退出時の自動取消", { guildId: guild.id, userId, voiceChannelId: oldState.channelId }, error, guild);
    }
  }

  async function replyNotInVoice(interaction) {
    await interaction.reply({ content: "現在VCに参加していないため、退出予定を登録できません。\nVCへ参加してから設定してください。", flags: MessageFlags.Ephemeral });
  }

  async function showExitScheduleMenu(interaction, channel) {
    const current = await getVoiceExitSchedule(interaction.guildId, interaction.user.id);
    const currentText = current
      ? `現在の退出予定：<t:${Math.floor(new Date(current.scheduledAt).getTime() / 1000)}:t>（<t:${Math.floor(new Date(current.scheduledAt).getTime() / 1000)}:R>）\n新しい時間を選ぶと、現在の予定は上書きされます。`
      : "現在、退出予定は登録されていません。";
    const menu = new StringSelectMenuBuilder().setCustomId(`${P}:exit_schedule_select:${channel.id}`).addOptions([
      ...EXIT_DURATIONS.map(([value, label]) => ({ label, value: String(value) })),
      { label: "予定をキャンセル", value: EXIT_CANCEL },
    ]);
    await interaction.reply({ content: currentText, components: [new ActionRowBuilder().addComponents(menu)], flags: MessageFlags.Ephemeral });
  }

  async function handleExitScheduleSelect(interaction, channel) {
    const selected = interaction.values[0];
    if (selected === EXIT_CANCEL) {
      const cancelled = await cancelVoiceExitSchedule(interaction.guildId, interaction.user.id);
      if (!cancelled) {
        const current = await getVoiceExitSchedule(interaction.guildId, interaction.user.id);
        return interaction.update({ content: current?.status === "executing" ? "退出予定のお知らせ処理が既に開始されています。" : "現在あなたは退出予定を登録していないようです。", components: [] });
      }
      clearScheduleTimer(interaction.guildId, interaction.user.id);
      return interaction.update({ content: "退出予定のキャンセルが完了しました。", components: [] });
    }
    if (interaction.member?.voice?.channelId !== channel.id) return replyNotInVoice(interaction);
    if (!hasChannelSendPermission(channel, interaction.guild)) {
      return interaction.update({ content: "対象VCチャットへメッセージを送信できないため、退出予定を登録できません。", components: [] });
    }
    const minutes = Number(selected);
    if (!EXIT_DURATIONS.some(([value]) => value === minutes)) return interaction.update({ content: "選択した時間を確認できませんでした。", components: [] });
    const existing = await getVoiceExitSchedule(interaction.guildId, interaction.user.id);
    const scheduledAt = new Date(Date.now() + minutes * 60 * 1000);
    const saved = await saveVoiceExitSchedule({
      guildId: interaction.guildId, userId: interaction.user.id, voiceChannelId: channel.id,
      scheduledAt, durationMinutes: minutes,
    });
    if (!saved) return interaction.update({ content: "退出予定のお知らせ処理が既に開始されています。", components: [] });
    scheduleVoiceExit(interaction.guild, saved);
    const timestamp = `<t:${Math.floor(scheduledAt.getTime() / 1000)}:F>`;
    const content = existing
      ? `退出予定を変更しました！\n以前の予定を取り消し、${formatDuration(minutes)}の${timestamp}にお知らせします！\nキャンセルの際はメニュー内の「予定をキャンセル」を選ぶと、お知らせをキャンセルできます！`
      : `退出予定を承りました！\n${formatDuration(minutes)}の${timestamp}にお知らせします！\nキャンセルの際はメニュー内の「予定をキャンセル」を選ぶと、お知らせをキャンセルできます！`;
    await interaction.update({ content, components: [] });
  }

  async function handle(interaction) {
    const parts = interaction.customId.split(":");
    if (parts.length !== 3 || parts[0] !== P || !/^\d{15,20}$/.test(parts[2])) return false;
    const base = parts[1].replace(/_(modal|select)$/, "");
    if (["timer", "timer_cancel", "timer_select"].includes(parts[1])) {
      await interaction.reply({ content: "この機能は終了しました。最新のVCコントロールパネルをご利用ください。", flags: MessageFlags.Ephemeral }).catch(() => {});
      return true;
    }
    const channel = interaction.guild?.channels.cache.get(parts[2]);
    const settings = interaction.guild ? await getSettings(interaction.guild) : null;
    if (!isTarget(channel, settings)) return false;
    try {
      if (interaction.isButton() && base === "exit_schedule") {
        if (interaction.member?.voice?.channelId === channel.id) await showExitScheduleMenu(interaction, channel);
        else {
          const current = await getVoiceExitSchedule(interaction.guildId, interaction.user.id);
          if (current?.status === "scheduled") await showExitScheduleMenu(interaction, channel);
          else await replyNotInVoice(interaction);
        }
        return true;
      }
      if (interaction.isStringSelectMenu() && base === "exit_schedule") {
        await handleExitScheduleSelect(interaction, channel);
        return true;
      }
      if (interaction.member?.voice?.channelId !== channel.id) {
        await replyNotInVoice(interaction);
        return true;
      }
      if (interaction.isButton() && ["name", "status"].includes(base)) {
        const modal = new ModalBuilder().setCustomId(`${P}:${base}_modal:${channel.id}`).setTitle(base === "name" ? "VC名を変更" : "ステータスを設定").addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("value").setLabel("入力").setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(100)),
        );
        await interaction.showModal(modal);
        return true;
      }
      if (interaction.isButton() && base === "limit") {
        await interaction.reply({ components: [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`${P}:limit_select:${channel.id}`).addOptions([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((value) => ({ label: value === 0 ? "人数制限なし" : `${value}人`, value: String(value) }))))], flags: MessageFlags.Ephemeral });
        return true;
      }
      if (interaction.isModalSubmit()) {
        const value = interaction.fields.getTextInputValue("value").trim().replace(/[\r\n\x00-\x1f\x7f]/g, "");
        if (base === "name") { if (!value || value === channel.name) return interaction.reply({ content: "名前が変更されていません。", flags: MessageFlags.Ephemeral }); await channel.setName(value); }
        else await setVoiceChannelStatus(channel, value);
        await interaction.reply({ content: "設定しました。", flags: MessageFlags.Ephemeral });
        return true;
      }
      if (interaction.isStringSelectMenu() && base === "limit") {
        const value = Number(interaction.values[0]);
        if (channel.userLimit !== value) await channel.setUserLimit(value);
        await interaction.update({ content: "設定しました。", components: [] });
        return true;
      }
    } catch (error) {
      await logFailure("操作", { guildId: interaction.guildId, userId: interaction.user?.id, voiceChannelId: channel?.id }, error, interaction.guild);
      if (!interaction.replied && !interaction.deferred) await interaction.reply({ content: "処理中に失敗しました。", flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    return true;
  }

  return { ensurePanel, cleanup, handle, handleVoiceState, restore };
}
