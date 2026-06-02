import "./load-env.js";
import { createServer } from "node:http";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  ModalBuilder,
  PermissionFlagsBits,
  Routes,
  TextInputBuilder,
  TextInputStyle,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  PermissionsBitField,
} from "discord.js";
import {
  deleteBumpReminder,
  getBumpReminders,
  saveBumpReminder,
} from "./bump-reminder-store.js";
import { buildGroups, describeGroups, shuffle } from "./grouping.js";
import { getGuildSettings, saveGuildSettings } from "./settings-store.js";

const { DISCORD_TOKEN, DISBOARD_BOT_ID, KEEP_ALIVE_PORT, PORT } = process.env;

const DISBOARD_DEFAULT_BOT_ID = "302050872383242240";
const BUMP_REMINDER_WAIT_MS = 2 * 60 * 60 * 1000;
const WAITING_ROOM_MONITOR_MS = 10 * 60 * 1000;
const WAITING_ROOM_POLL_MS = 5 * 1000;
const DEFAULT_TRANSFER_WAIT_SECONDS = 30;
const DEFAULT_NOTICE_WAIT_MINUTES = 25;
const DEFAULT_ROLE_REMOVE_WAIT_MINUTES = 3;
const DEFAULT_WAITING_VC_NAME = "途中参加部屋";
const COUNTDOWN_UPDATE_MS = 1000;
const PB_CHILD_WAIT_MS = 20 * 1000;
const DEFAULT_FINISH_MESSAGE = "終了時間です。";
const MESSAGE_LIMIT = 1900;

const activeSessions = new Map();
const bumpReminderTimers = new Map();
const lastBosyuTimestamps = new Map();
const bosyuEditSessions = new Map();
const voiceMonitorSessions = new Map();
const topicFormSessions = new Map();
const autoSplitSuggestionMessages = new Map();

const VOICE_MONITOR_MIN_MEMBERS = 2;
const AUTO_SPLIT_THRESHOLD = 6;
const VOICE_REMINDER_INTERVAL_MS = 30 * 60 * 1000;
const TOPIC_FORM_EXPIRE_MS = 30 * 60 * 1000;
const SUGGESTED_TOPICS = [
  "最近ハマっているゲームや漫画について",
  "最近見た映画やアニメの話",
  "最近の仕事・学業であった面白い出来事",
  "今後やってみたいことや旅行の予定",
  "好きな音楽やおすすめのアーティスト",
  "日常のちょっとした悩みや相談",
  "最近挑戦したことや学んだこと",
  "おすすめのカフェや飲食店について",
  "最近気になっているニュースや話題",
  "趣味や特技の話",
];

if (!DISCORD_TOKEN) {
  throw new Error("DISCORD_TOKEN is required.");
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

const healthPort = Number(PORT ?? KEEP_ALIVE_PORT);

if (Number.isInteger(healthPort) && healthPort > 0) {
  startHealthServer(healthPort);
}

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);
  void restoreBumpReminders().catch((error) => {
    console.error(error);
  });
});

client.on(Events.MessageCreate, async (message) => {
  try {
    await handleDisboardBumpMessage(message);
    await handleTopicRequestMessage(message);
  } catch (error) {
    console.error(error);
  }
});

client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  try {
    await handleVoiceStateUpdate(oldState, newState);
  } catch (error) {
    console.error(error);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isButton()) {
      if (interaction.customId === "bosyu_edit") {
        await handleBosyuButton(interaction);
        return;
      }

      if (interaction.customId.startsWith("session_cancel:")) {
        await handleSessionButton(interaction);
        return;
      }

      if (interaction.customId.startsWith("topic_form_button:")) {
        await handleTopicFormButton(interaction);
        return;
      }

      if (interaction.customId.startsWith("auto_split:")) {
        await handleAutoSplitButton(interaction);
        return;
      }

      if (interaction.customId.startsWith("suggest_topic:")) {
        await handleSuggestTopicButton(interaction);
        return;
      }
    }

    if (interaction.isModalSubmit()) {
      if (interaction.customId.startsWith("bosyu_edit_modal:")) {
        await handleBosyuEditModal(interaction);
        return;
      }

      if (interaction.customId.startsWith("topic_form:")) {
        await handleTopicFormModal(interaction);
        return;
      }

      return;
    }

    if (!interaction.isChatInputCommand()) {
      return;
    }

    if (interaction.commandName === "splitvc") {
      await handleSplitVoice(interaction);
      return;
    }

    if (interaction.commandName === "b") {
      await handleBosyu(interaction);
      return;
    }

    if (interaction.commandName === "setting") {
      await handleSetting(interaction);
    }
  } catch (error) {
    console.error(error);
    await replySafely(interaction, "処理中にエラーが発生しました。Renderのログを確認してください。");
  }
});

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
    const settings = await getGuildSettings(interaction.guildId);
    await replyOrFollowUp(interaction, {
      content: formatSettings(settings),
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
    return;
  }

  const tempRole = interaction.options.getRole("participant_role", false);
  const parentChannel = interaction.options.getChannel("parent_channel", false);
  const childCategory = interaction.options.getChannel("child_category", false);
  const waitingVcCategory = interaction.options.getChannel("waiting_vc_category", false,);
  const waitingVcName = interaction.options.getString("waiting_vc_name", false);
  const bosyuChannel = interaction.options.getChannel("bosyu_channel", false);
  const bosyuMentionRole = interaction.options.getRole("bosyu_mention_role", false);
  const voiceParticipantRole = interaction.options.getRole("voice_participant_role", false);
  const voiceReminderChannel = interaction.options.getChannel("voice_reminder_channel", false);
  const voiceTopicChannel = interaction.options.getChannel("voice_topic_channel", false);
  const voiceReminderParentChannel = interaction.options.getChannel("voice_reminder_parent_channel", false);
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

  if (bosyuChannel) {
    patch.bosyuChannelId = bosyuChannel.id;
  }

  if (bosyuMentionRole) {
    patch.bosyuMentionRoleId = bosyuMentionRole.id;
  }

  if (voiceParticipantRole) {
    patch.voiceParticipantRoleId = voiceParticipantRole.id;
  }

  if (voiceReminderChannel) {
    patch.voiceReminderChannelId = voiceReminderChannel.id;
  }

  if (voiceTopicChannel) {
    patch.voiceTopicChannelId = voiceTopicChannel.id;
  }

  if (voiceReminderParentChannel) {
    patch.voiceReminderParentChannelId = voiceReminderParentChannel.id;
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
    await interaction.reply({
      content: "変更する項目を1つ以上指定してください。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const settings = await saveGuildSettings(interaction.guildId, patch);
  await replyOrFollowUp(interaction, {
    content: `設定を保存しました。\n\n${formatSettings(settings)}`,
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
}

async function handleDisboardBumpMessage(message) {
  if (!message.inGuild() || !isDisboardBumpMessage(message)) {
    return;
  }

  const user = message.interactionMetadata?.user ?? message.interaction?.user;

  if (!user || user.bot) {
    return;
  }

  const reminder = {
    id: message.id,
    guildId: message.guildId,
    channelId: message.channelId,
    userId: user.id,
    dueAt: new Date(Date.now() + BUMP_REMINDER_WAIT_MS).toISOString(),
    sourceMessageId: message.id,
  };

  await saveBumpReminder(reminder);
  scheduleBumpReminder(reminder);
}

function isDisboardBumpMessage(message) {
  const disboardBotId = DISBOARD_BOT_ID || DISBOARD_DEFAULT_BOT_ID;
  const commandName = message.interaction?.commandName;

  return (
    message.author?.id === disboardBotId &&
    commandName === "bump" &&
    Boolean(message.interactionMetadata?.user ?? message.interaction?.user)
  );
}

async function restoreBumpReminders() {
  const reminders = await getBumpReminders();

  for (const reminder of reminders) {
    scheduleBumpReminder(reminder);
  }
}

async function handleTopicRequestMessage(message) {
  if (!message.inGuild() || message.author.bot) {
    return;
  }

  if (!message.content.includes("話題を出して")) {
    return;
  }

  const session = [...voiceMonitorSessions.values()].find(
    (session) => session.guildId === message.guildId && session.reminderChannelId === message.channelId,
  );

  if (!session) {
    return;
  }

  const topic = SUGGESTED_TOPICS[Math.floor(Math.random() * SUGGESTED_TOPICS.length)];
  await message.channel.send({ content: `話題の提案です：${topic}` });
}

async function handleVoiceStateUpdate(oldState, newState) {
  const guild = newState.guild ?? oldState.guild;
  if (!guild) {
    return;
  }

  const settings = await getGuildSettings(guild.id);
  const changedChannelIds = new Set();

  if (oldState.channelId) {
    changedChannelIds.add(oldState.channelId);
  }

  if (newState.channelId) {
    changedChannelIds.add(newState.channelId);
  }

  const monitoredChannelIds = [];

  for (const channelId of changedChannelIds) {
    if (await isVoiceChannelMonitored(guild, settings, channelId)) {
      monitoredChannelIds.push(channelId);
    }

    await maybeSendAutoSplitSuggestion(guild, settings, channelId);
  }

  if (monitoredChannelIds.length > 0) {
    await Promise.all(
      monitoredChannelIds.map((channelId) =>
        updateVoiceMonitorSession(guild, settings, channelId),
      ),
    );
  }

  if (
    oldState.member &&
    oldState.member.user &&
    !oldState.member.user.bot &&
    oldState.channelId &&
    settings?.voiceParticipantRoleId &&
    (await isVoiceChannelMonitored(guild, settings, oldState.channelId))
  ) {
    const stillInActiveSession = await isMemberInActiveVoiceMonitorContext(
      guild,
      settings,
      oldState.member.id,
    );

    if (!stillInActiveSession) {
      const member = await guild.members.fetch(oldState.member.id).catch(() => null);
      if (member) {
        await removeVoiceParticipantRole(member, settings.voiceParticipantRoleId);
      }
    }
  }
}

async function findAssociatedTextChannel(guild, voiceChannel, settings) {
  const textTypes = [ChannelType.GuildText, ChannelType.GuildAnnouncement];

  if (settings?.voiceReminderChannelId) {
    const configured = await guild.channels.fetch(settings.voiceReminderChannelId).catch(() => null);
    return configured && textTypes.includes(configured.type) ? configured : null;
  }

  const channels = [...guild.channels.cache.values()].filter((c) => textTypes.includes(c.type));

  // 1) exact name match
  let ch = channels.find((c) => c.name === voiceChannel.name);
  if (ch) return ch;

  // 2) same parent + name contains
  if (voiceChannel.parentId) {
    ch = channels.find((c) => c.parentId === voiceChannel.parentId && c.name.includes(voiceChannel.name));
    if (ch) return ch;
  }

  // 3) topic contains voice channel id
  ch = channels.find((c) => typeof c.topic === "string" && c.topic.includes(voiceChannel.id));
  if (ch) return ch;

  // 4) name starts with
  ch = channels.find((c) => c.name.startsWith(voiceChannel.name));
  if (ch) return ch;

  return null;
}

function createAutoSplitRow(channelId, disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`auto_split:${channelId}`)
      .setLabel("自動振り分け")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(disabled),
  );
}

async function maybeSendAutoSplitSuggestion(guild, settings, channelId) {
  const voiceChannel = await guild.channels.fetch(channelId).catch(() => null);

  if (!voiceChannel?.isVoiceBased()) {
    return;
  }

  if (settings?.voiceReminderParentChannelId === channelId) {
    return;
  }

  const members = getNonBotVoiceMembers(voiceChannel);
  const existingMessageId = autoSplitSuggestionMessages.get(channelId);

  if (members.length >= AUTO_SPLIT_THRESHOLD) {
    if (existingMessageId) {
      return;
    }

    const reminderChannel = await findAssociatedTextChannel(guild, voiceChannel, settings);

    if (!reminderChannel || typeof reminderChannel.send !== "function") {
      return;
    }

    const canAutoSplit = Boolean(settings?.voiceReminderParentChannelId && settings?.tempRoleId);
    const components = [createAutoSplitRow(channelId, !canAutoSplit)];
    const mentionText = settings?.tempRoleId ? `<@&${settings.tempRoleId}> ` : "";
    const content =
      `${mentionText}1つのvcに６人以上集まると喋れない人が出てきがちなので当チャンネルでは振り分けを推奨しています。\nまた、振り分け方が決まらないときは下の自動振り分けボタンをご活用ください！` +
      (canAutoSplit
        ? ""
        : "\n※リマインダー対象PB親チャンネルまたは参加者ロールが設定されていないため、自動振り分けは無効です。");

    const suggestionMessage = await reminderChannel.send({
      content,
      components,
      allowedMentions: settings?.tempRoleId ? { roles: [settings.tempRoleId] } : { parse: [] },
    });

    autoSplitSuggestionMessages.set(channelId, suggestionMessage.id);
    return;
  }

  if (existingMessageId && members.length < AUTO_SPLIT_THRESHOLD) {
    const reminderChannel = await findAssociatedTextChannel(guild, voiceChannel, settings);
    if (reminderChannel && typeof reminderChannel.messages?.fetch === "function") {
      const message = await reminderChannel.messages
        .fetch(existingMessageId)
        .catch(() => null);
      if (message) {
        await message.delete().catch(() => null);
      }
    }

    autoSplitSuggestionMessages.delete(channelId);
  }
}

async function isVoiceChannelMonitored(guild, settings, channelId) {
  if (!channelId) {
    return false;
  }

  const voiceChannel =
    guild.channels.cache.get(channelId) ??
    (await guild.channels.fetch(channelId).catch(() => null));

  if (!voiceChannel?.isVoiceBased()) {
    return false;
  }

  if (await isPbChildVoiceChannel(guild, settings, voiceChannel)) {
    return true;
  }

  return (
    Array.isArray(settings?.voiceMonitorVoiceChannelIds) &&
    settings.voiceMonitorVoiceChannelIds.includes(channelId)
  );
}

async function isPbChildVoiceChannel(guild, settings, voiceChannel) {
  if (!settings?.voiceReminderParentChannelId || !voiceChannel?.isVoiceBased()) {
    return false;
  }

  const parentChannel = await guild.channels
    .fetch(settings.voiceReminderParentChannelId)
    .catch(() => null);

  if (!parentChannel?.isVoiceBased() || voiceChannel.id === parentChannel.id) {
    return false;
  }

  if (settings.childCategoryId) {
    return voiceChannel.parentId === settings.childCategoryId;
  }

  return Boolean(parentChannel.parentId && voiceChannel.parentId === parentChannel.parentId);
}

function getNonBotVoiceMembers(voiceChannel) {
  return [...voiceChannel.members.values()].filter((member) => !member.user.bot);
}

function getVoiceMonitorSessionKey(guildId, channelId) {
  return `${guildId}:${channelId}`;
}

async function isMemberInActiveVoiceMonitorContext(
  guild,
  settings,
  memberId,
  ignoredSessionKey = null,
) {
  for (const session of voiceMonitorSessions.values()) {
    const sessionKey = getVoiceMonitorSessionKey(session.guildId, session.voiceChannelId);

    if (
      session.guildId === guild.id &&
      sessionKey !== ignoredSessionKey &&
      session.memberIds.has(memberId)
    ) {
      return true;
    }
  }

  for (const voiceState of guild.voiceStates.cache.values()) {
    if (voiceState.member?.id !== memberId || !voiceState.channelId) {
      continue;
    }

    const sessionKey = getVoiceMonitorSessionKey(guild.id, voiceState.channelId);

    if (sessionKey === ignoredSessionKey) {
      continue;
    }

    if (voiceMonitorSessions.has(sessionKey)) {
      return true;
    }

    const voiceChannel =
      guild.channels.cache.get(voiceState.channelId) ??
      (await guild.channels.fetch(voiceState.channelId).catch(() => null));

    if (
      voiceChannel?.isVoiceBased() &&
      getNonBotVoiceMembers(voiceChannel).length >= VOICE_MONITOR_MIN_MEMBERS &&
      (await isVoiceChannelMonitored(guild, settings, voiceState.channelId))
    ) {
      return true;
    }
  }

  return false;
}

async function updateVoiceMonitorSession(guild, settings, channelId) {
  const voiceChannel = await guild.channels.fetch(channelId).catch(() => null);

  if (!voiceChannel?.isVoiceBased()) {
    return;
  }

  const members = getNonBotVoiceMembers(voiceChannel);

  const sessionKey = getVoiceMonitorSessionKey(guild.id, channelId);
  const existingSession = voiceMonitorSessions.get(sessionKey);

  if (members.length >= VOICE_MONITOR_MIN_MEMBERS) {
    if (!existingSession) {
      const reminderChannel = await findAssociatedTextChannel(guild, voiceChannel, settings);

      if (!reminderChannel || typeof reminderChannel.send !== "function") {
        return;
      }

      const session = {
        guildId: guild.id,
        voiceChannelId: channelId,
        reminderChannelId: reminderChannel.id,
        participantRoleId: settings.voiceParticipantRoleId,
        startTime: Date.now(),
        reminderCount: 0,
        memberIds: new Set(),
        reminderTimer: null,
        lastReminderMessageId: null,
        active: true,
        topicForms: new Map(),
      };

      voiceMonitorSessions.set(sessionKey, session);
      await startVoiceMonitorSession(session, voiceChannel, members, reminderChannel);
      return;
    }

    await ensureSessionMembersHaveRole(existingSession, voiceChannel, members);
    return;
  }

  if (existingSession) {
    await stopVoiceMonitorSession(existingSession, guild, voiceChannel, settings);
  }
}

async function startVoiceMonitorSession(session, voiceChannel, members, reminderChannel) {
  await reminderChannel.send({
    content:
      "お集まりいただきありがとうございます！\n「話題を出して」とチャットに送るとbotが話題を出してくれるので話題に詰まったら使ってみてください！",
  });

  await ensureSessionMembersHaveRole(session, voiceChannel, members);
  scheduleNextVoiceReminder(session);
}

async function ensureSessionMembersHaveRole(session, voiceChannel, members) {
  session.memberIds = new Set(members.map((member) => member.id));

  if (!session.participantRoleId || members.length < VOICE_MONITOR_MIN_MEMBERS) {
    return;
  }

  const role = await voiceChannel.guild.roles
    .fetch(session.participantRoleId)
    .catch(() => null);

  if (!role) {
    return;
  }

  for (const member of members) {
    if (!member.roles.cache.has(role.id)) {
      try {
        await member.roles.add(role, "VC参加者ロールを付与");
      } catch {
        // ignore individual failures
      }
    }
  }
}

function scheduleNextVoiceReminder(session) {
  if (session.reminderTimer) {
    clearTimeout(session.reminderTimer);
  }

  session.reminderTimer = setTimeout(async () => {
    if (!voiceMonitorSessions.has(getVoiceMonitorSessionKey(session.guildId, session.voiceChannelId))) {
      return;
    }

    await sendVoiceMonitorReminder(session).catch((error) => {
      console.error(error);
    });
  }, VOICE_REMINDER_INTERVAL_MS);
}

async function sendVoiceMonitorReminder(session) {
  const reminderChannel = await client.channels
    .fetch(session.reminderChannelId)
    .catch(() => null);

  if (!reminderChannel || typeof reminderChannel.send !== "function") {
    return;
  }

  if (session.lastReminderMessageId) {
    const previousMessage = await reminderChannel.messages
      .fetch(session.lastReminderMessageId)
      .catch(() => null);

    if (previousMessage) {
      await previousMessage.delete().catch(() => null);
    }
  }

  const elapsedMs = Date.now() - session.startTime;
  const elapsedText = formatVoiceElapsedTime(elapsedMs);
  const formId = createSessionId();

  const mentionText = session.participantRoleId
    ? `<@&${session.participantRoleId}> `
    : "";

  const reminderMessage = await reminderChannel.send({
    content: `${mentionText}あつまってから${elapsedText}が経過しました！お時間大丈夫でしょうか！お暇があれば今話してる話題をフォームへお願いします！`,
    components: [createTopicFormRow(formId)],
    allowedMentions: session.participantRoleId
      ? { roles: [session.participantRoleId] }
      : { parse: [] },
  });

  session.lastReminderMessageId = reminderMessage.id;

  const topicForm = {
    guildId: session.guildId,
    voiceChannelId: session.voiceChannelId,
    reminderChannelId: session.reminderChannelId,
    expiresAt: Date.now() + TOPIC_FORM_EXPIRE_MS,
    messageId: reminderMessage.id,
    disableTimer: null,
  };

  topicForm.disableTimer = setTimeout(() => {
    void disableTopicForm(formId).catch((error) => {
      console.error(error);
    });
  }, TOPIC_FORM_EXPIRE_MS);

  topicFormSessions.set(formId, topicForm);
  session.topicForms.set(formId, topicForm);
  session.reminderCount += 1;
  scheduleNextVoiceReminder(session);
}

async function disableTopicForm(formId) {
  const topicForm = topicFormSessions.get(formId);
  if (!topicForm) {
    return;
  }

  topicFormSessions.delete(formId);

  const session = voiceMonitorSessions.get(
    getVoiceMonitorSessionKey(topicForm.guildId, topicForm.voiceChannelId),
  );

  if (session) {
    session.topicForms.delete(formId);
  }

  const reminderChannel = await client.channels
    .fetch(topicForm.reminderChannelId)
    .catch(() => null);

  if (!reminderChannel || typeof reminderChannel.messages?.fetch !== "function") {
    return;
  }

  const reminderMessage = await reminderChannel.messages
    .fetch(topicForm.messageId)
    .catch(() => null);

  if (!reminderMessage) {
    return;
  }

  await editSafely(reminderMessage, {
    components: [createTopicFormRow(formId, true)],
  });
}

async function stopVoiceMonitorSession(session, guild, voiceChannel, settings) {
  if (session.reminderTimer) {
    clearTimeout(session.reminderTimer);
  }

  for (const [formId, topicForm] of session.topicForms.entries()) {
    if (topicForm.disableTimer) {
      clearTimeout(topicForm.disableTimer);
    }
    topicFormSessions.delete(formId);
  }

  const sessionKey = getVoiceMonitorSessionKey(session.guildId, session.voiceChannelId);

  voiceMonitorSessions.delete(sessionKey);

  const memberIds = new Set(
    [
      ...session.memberIds,
      ...getNonBotVoiceMembers(voiceChannel).map((member) => member.id),
    ],
  );

  for (const memberId of memberIds) {
    if (!settings.voiceParticipantRoleId) {
      continue;
    }

    const stillInActiveSession = await isMemberInActiveVoiceMonitorContext(
      guild,
      settings,
      memberId,
      sessionKey,
    );

    if (!stillInActiveSession) {
      const member = await guild.members.fetch(memberId).catch(() => null);
      if (!member) {
        continue;
      }

      await removeVoiceParticipantRole(member, settings.voiceParticipantRoleId);
    }
  }

  // ノーティフィケーションは不要のため送信しない
}

function createTopicFormRow(formId, disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`topic_form_button:${formId}`)
      .setLabel(disabled ? "フォーム期限切れ" : "話題フォームを開く")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(disabled),
  );
}

function createVoiceTopicModal(formId) {
  return new ModalBuilder()
    .setCustomId(`topic_form:${formId}`)
    .setTitle("今の話題を投稿")
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("voice_topic_input")
          .setLabel("今話している話題を入力してください")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(400)
          .setPlaceholder("例：ゲームについてしゃべってます！"),
      ),
    );
}

async function handleTopicFormButton(interaction) {
  const formId = interaction.customId.slice("topic_form_button:".length);
  const topicForm = topicFormSessions.get(formId);

  if (!topicForm || Date.now() > topicForm.expiresAt) {
    await interaction.reply({
      content: "このフォームの有効期限が切れました。次のリマインダーをお待ちください。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.showModal(createVoiceTopicModal(formId));
}

async function handleAutoSplitButton(interaction) {
  if (!interaction.inGuild()) {
    await replyOrFollowUp(interaction, {
      content: "この操作はサーバー内で実行してください。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const channelId = interaction.customId.slice("auto_split:".length);
  const settings = await getGuildSettings(interaction.guildId);
  const guild = interaction.guild;
  const voiceChannel = await guild.channels.fetch(channelId).catch(() => null);

  if (!voiceChannel?.isVoiceBased()) {
    await interaction.reply({
      content: "対象のボイスチャンネルが見つかりませんでした。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const members = [...voiceChannel.members.values()].filter((member) => !member.user.bot);

  if (members.length < AUTO_SPLIT_THRESHOLD) {
    await interaction.reply({
      content: "参加人数が6人未満になったため、自動振り分けは実行できませんでした。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

const parentChannelId = settings?.voiceReminderParentChannelId;
    const parentChannel = parentChannelId
      ? await guild.channels.fetch(parentChannelId).catch(() => null)
      : null;
    const participantRole = settings?.tempRoleId
      ? await guild.roles.fetch(settings.tempRoleId).catch(() => null)
      : null;

    if (!parentChannelId || !parentChannel?.isVoiceBased() || !participantRole) {
      await interaction.reply({
        content:
          "リマインダー対象PB親チャンネルまたは参加者ロールが未設定のため、自動振り分けを実行できませんでした。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.update({
    content: "自動振り分けを実行します。少々お待ちください…",
    components: [],
  });

  const [stayGroup, moveGroup] = splitIntoTwoRandomGroups(members);

  const transferResult = await transferMembersToPbChildChannel(moveGroup, {
    parentChannel,
    childCategoryId: settings.childCategoryId,
    participantRole,
    sourceChannelId: voiceChannel.id,
  });

  const moved = moveGroup.length - transferResult.failed.length;
  const roleFailedText = transferResult.roleFailures.length
    ? ` 参加者ロール付与失敗: ${transferResult.roleFailures.join("、")}`
    : "";
  const failedText = transferResult.failed.length
    ? ` 転送失敗: ${transferResult.failed.join("、")}`
    : "";

  await interaction.followUp({
    content: `自動振り分けを完了しました。
${transferResult.childChannel ? `<#${transferResult.childChannel.id}>` : "PB子VCの検出に失敗しました。"} へ ${moved}/${moveGroup.length} 人を転送しました。${failedText}${roleFailedText}`,
    allowedMentions: { parse: [] },
  });

  autoSplitSuggestionMessages.delete(channelId);
}

function splitIntoTwoRandomGroups(members) {
  const shuffled = shuffle(members);
  const firstGroupSize = Math.ceil(shuffled.length / 2);
  return [
    shuffled.slice(0, firstGroupSize),
    shuffled.slice(firstGroupSize),
  ];
}

async function transferMembersToPbChildChannel(members, config) {
  const failures = [];
  const roleFailures = [];
  const participantMemberIds = new Set();

  if (members.length === 0) {
    return { childChannel: null, failed: [], roleFailures };
  }

  const seedMember = members[0];

  try {
    await seedMember.voice.setChannel(
      config.parentChannel,
      "Move split group seed to PB parent channel",
    );
  } catch {
    failures.push(seedMember.displayName);
  }

  const seedRoleFailure = await addRoleForTransfer(
    seedMember,
    config.participantRole,
    participantMemberIds,
  );

  if (seedRoleFailure) {
    roleFailures.push(seedRoleFailure);
  }

  const childChannel = await waitForPbChildChannel(seedMember, {
    parentChannel: config.parentChannel,
    sourceChannelId: config.sourceChannelId,
    childCategoryId: config.childCategoryId,
  });

  if (!childChannel) {
    return { childChannel: null, failed: [seedMember.displayName], roleFailures };
  }

  let movedCount = failures.length === 0 ? 1 : 0;

  for (const member of members.slice(1)) {
    try {
      await member.voice.setChannel(
        childChannel,
        "Move group member to PB child channel",
      );
      const roleFailure = await addRoleForTransfer(
        member,
        config.participantRole,
        participantMemberIds,
      );

      if (roleFailure) {
        roleFailures.push(roleFailure);
      }

      movedCount += 1;
    } catch {
      failures.push(member.displayName);
    }
  }

  return {
    childChannel,
    failed: failures,
    roleFailures,
    participantMemberIds: [...participantMemberIds],
  };
}

async function handleSuggestTopicButton(interaction) {
  const session = [...voiceMonitorSessions.values()].find(
    (session) =>
      interaction.customId === `suggest_topic:${session.voiceChannelId}` &&
      session.guildId === interaction.guildId,
  );

  if (!session) {
    await interaction.reply({
      content: "現在、話題提案を行えるセッションがありません。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const topic = SUGGESTED_TOPICS[Math.floor(Math.random() * SUGGESTED_TOPICS.length)];

  await interaction.reply({
    content: `話題の提案です：${topic}`,
    flags: MessageFlags.Ephemeral,
  });
}

async function handleTopicFormModal(interaction) {
  const formId = interaction.customId.slice("topic_form:".length);
  const topicForm = topicFormSessions.get(formId);

  if (!topicForm || Date.now() > topicForm.expiresAt) {
    await interaction.reply({
      content: "このフォームの有効期限が切れました。次のリマインダーをお待ちください。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const topicText = interaction.fields.getTextInputValue("voice_topic_input").trim();

  // Require the submitter to be in a VC. If not, reject the submission.
  const posterVoiceChannel = interaction.member?.voice?.channel;
  if (!posterVoiceChannel?.isVoiceBased()) {
    await replyOrFollowUp(interaction, {
      content: "VC参加者のみが使えます",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const voiceChannel = posterVoiceChannel;

  // Forward the topic text to the configured topic forward channel, or fall back to the reminder channel.
  try {
    const settings = await getGuildSettings(topicForm.guildId);
    const topicChannel = settings?.voiceTopicChannelId
      ? await client.channels.fetch(settings.voiceTopicChannelId).catch(() => null)
      : null;
    const sendChannel =
      topicChannel && typeof topicChannel.send === "function"
        ? topicChannel
        : await client.channels
            .fetch(topicForm.reminderChannelId)
            .catch(() => null);

    if (sendChannel && typeof sendChannel.send === "function") {
      const channelMention = voiceChannel?.id ? `<#${voiceChannel.id}>` : "(不明なVC)";
      await sendChannel.send({
        content: `いまのわだい：${channelMention}\n${topicText}`,
      }).catch(() => null);
    }
  } catch (err) {
    console.error(`Failed to forward topic to channel: ${err?.message ?? err}`);
  }

  await interaction.reply({
    content: "話題を送信しました。",
    flags: MessageFlags.Ephemeral,
  });

  if (topicForm.disableTimer) {
    clearTimeout(topicForm.disableTimer);
  }

  const session = voiceMonitorSessions.get(
    getVoiceMonitorSessionKey(topicForm.guildId, topicForm.voiceChannelId),
  );

  if (session) {
    session.topicForms.delete(formId);
  }

  topicFormSessions.delete(formId);

  const reminderChannel = await client.channels
    .fetch(topicForm.reminderChannelId)
    .catch(() => null);

  if (reminderChannel && typeof reminderChannel.messages?.fetch === "function") {
    const reminderMessage = await reminderChannel.messages
      .fetch(topicForm.messageId)
      .catch(() => null);

    if (reminderMessage) {
      await editSafely(reminderMessage, {
        components: [createTopicFormRow(formId, true)],
      });
    }
  }
}

async function removeVoiceParticipantRole(member, roleId) {
  if (!member.roles.cache.has(roleId)) {
    return;
  }

  try {
    await member.roles.remove(roleId, "VC離脱に伴う参加者ロール解除");
  } catch {
    // ignore removal failures
  }
}

function formatVoiceElapsedTime(elapsedMs) {
  const totalMinutes = Math.floor(elapsedMs / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours > 0) {
    return `${hours}時間${minutes}分`;
  }

  return `${minutes}分`;
}

function scheduleBumpReminder(reminder) {
  if (bumpReminderTimers.has(reminder.id)) {
    clearTimeout(bumpReminderTimers.get(reminder.id));
  }

  const delayMs = Math.max(0, new Date(reminder.dueAt).getTime() - Date.now());
  const timer = setTimeout(() => {
    bumpReminderTimers.delete(reminder.id);
    void sendBumpReminder(reminder).catch((error) => {
      console.error(error);
    });
  }, delayMs);

  bumpReminderTimers.set(reminder.id, timer);
}

async function sendBumpReminder(reminder) {
  const channel = await client.channels.fetch(reminder.channelId).catch(() => null);

  if (!channel || typeof channel.send !== "function") {
    await deleteBumpReminder(reminder.id);
    return;
  }

  await channel.send({
    content: `<@${reminder.userId}> 前回のbumpから２時間が経過しました`,
    allowedMentions: { users: [reminder.userId] },
  });
  await deleteBumpReminder(reminder.id);
}

async function handleSplitVoice(interaction) {
  if (!interaction.inGuild()) {
    await interaction.reply({
      content: "このコマンドはサーバー内で使ってください。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const selectedChannel = interaction.options.getChannel("channel", false);
  const fallbackChannel = interaction.member?.voice?.channel ?? null;
  const sourceChannel = selectedChannel ?? fallbackChannel;
  const privateResult = interaction.options.getBoolean("private") ?? false;

  if (!sourceChannel?.isVoiceBased()) {
    await interaction.reply({
      content: "対象のボイスチャンネルを指定するか、自分がボイスチャンネルに入ってから実行してください。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const botMember = await interaction.guild.members.fetch(interaction.client.user.id);
  const sourcePermissions = sourceChannel.permissionsFor(botMember);

  if (!sourcePermissions?.has(PermissionsBitField.Flags.ViewChannel)) {
    await interaction.reply({
      content: "Botが対象のボイスチャンネルを見る権限を持っていません。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const includeBots = interaction.options.getBoolean("include_bots") ?? false;
  const shouldShuffle = interaction.options.getBoolean("shuffle") ?? true;
  const members = [...sourceChannel.members.values()]
    .filter((member) => includeBots || !member.user.bot)
    .sort((left, right) =>
      left.displayName.localeCompare(right.displayName, "ja"),
    );

  const targetMembers = shouldShuffle ? shuffle(members) : members;
  const groups = buildGroups(targetMembers);

  if (targetMembers.length === 0) {
    await interaction.reply({
      content: `${sourceChannel} に対象メンバーがいません。`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await replyInChunks(interaction, formatResult(sourceChannel, targetMembers.length, groups), {
    flags: privateResult ? MessageFlags.Ephemeral : undefined,
    allowedMentions: { parse: [] },
  });

  const settings = await getGuildSettings(interaction.guildId);
  const config = await resolveProcessConfig(interaction, settings, botMember);
  const transferWaitMs = secondsToMs(
    getNonNegativeInteger(
      settings?.transferWaitSeconds,
      DEFAULT_TRANSFER_WAIT_SECONDS,
    ),
  );
  const noticeWaitMs = minutesToMs(
    getNonNegativeInteger(settings?.noticeWaitMinutes, DEFAULT_NOTICE_WAIT_MINUTES),
  );
  const roleRemoveWaitMs = minutesToMs(
    getNonNegativeInteger(
      settings?.roleRemoveWaitMinutes,
      DEFAULT_ROLE_REMOVE_WAIT_MINUTES,
    ),
  );

  if (config.errors.length > 0) {
    await interaction.followUp({
      content: `PB連携プロセスは実行できません。\n${config.errors.map((error) => `- ${error}`).join("\n")}`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const operationChannel = getSendableChannel(interaction);

  if (!operationChannel) {
    await interaction.followUp({
      content: "結果や待機メッセージを送信できるテキストチャンネルが見つかりません。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await operationChannel.send({
    content: `${config.tempRole} は、各メンバーをVCへ転送したタイミングで付与します。`,
    allowedMentions: { roles: [] },
  });

  const transferCanceled = await runCountdown({
    channel: operationChannel,
    ownerId: interaction.user.id,
    totalMs: transferWaitMs,
    updateEveryMs: COUNTDOWN_UPDATE_MS,
    buttonLabel: "転送キャンセル",
    cancelText: "転送はキャンセルされました。終了通知の待機は続行します。",
    render: (remainingMs) =>
      `PB親チャンネルへの転送開始まで残り ${formatDuration(remainingMs)} です。\nキャンセルできるのはコマンド実行者のみです。`,
  });

  const childChannelIds = new Set();
  const participantMemberIds = new Set();
  const processState = { ended: false };
  let temporaryWaitingVc = null;
  let temporaryWaitingVcDeleteTimer = null;

  if (transferCanceled) {
    await operationChannel.send("転送をキャンセルしました。");
  } else {
    const transferResult = await transferGroups(groups, {
      parentChannel: config.parentChannel,
      childCategoryId: config.childCategoryId,
      participantRole: config.tempRole,
      sourceChannelId: sourceChannel.id,
    });
    addMany(childChannelIds, transferResult.childChannelIds);
    addMany(participantMemberIds, transferResult.participantMemberIds);

    await sendChunked(operationChannel, `転送結果\n${transferResult.lines.join("\n")}`, {
      allowedMentions: { parse: [] },
    });

    if (config.waitingVcCategoryId) {

      temporaryWaitingVc = await operationChannel.guild.channels.create({
        name: config.waitingVcName,
        type: ChannelType.GuildVoice,
        parent: config.waitingVcCategoryId,

        permissionOverwrites: [
          {
            id: operationChannel.guild.roles.everyone.id,

            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.Connect,
            ],

            deny: [
              PermissionFlagsBits.Speak,
            ],
          },
        ],
      });

      await operationChannel.send(
        `待機用VC ${temporaryWaitingVc} を作成しました。10分後に自動削除されます。`,
      );

      temporaryWaitingVcDeleteTimer = setTimeout(async () => {

        try {

          const fetchedChannel =
            await operationChannel.guild.channels.fetch(
              temporaryWaitingVc.id,
            ).catch(() => null);

          if (fetchedChannel) {
            await notifyWaitingVcClosure(operationChannel, fetchedChannel);
            await fetchedChannel.delete();

            await operationChannel.send(
              "待機用VCを自動削除しました。",
            );
          }

        } catch (error) {

          console.error(error);

        }

      }, 10 * 60 * 1000);

      void runWaitingRoomMonitor({
        channel: operationChannel,
        guild: interaction.guild,
        waitingChannel: temporaryWaitingVc,
        parentChannel: config.parentChannel,
        participantRole: config.tempRole,
        childCategoryId: config.childCategoryId,
        childChannelIds,
        participantMemberIds,
        state: processState,
      }).catch((error) => {
        console.error(error);
      });
    }


    void runEndNotificationFlow({
      channel: operationChannel,
      guild: interaction.guild,
      ownerId: interaction.user.id,
      roleId: config.tempRole.id,
      memberIds: participantMemberIds,
      finishMessage: settings.finishMessage || DEFAULT_FINISH_MESSAGE,
      noticeWaitMs,
      roleRemoveWaitMs,
      childChannelIds,
      state: processState, temporaryWaitingVc, temporaryWaitingVcDeleteTimer,
    }).catch((error) => {
      console.error(error);
    });
  }
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
  const lastUsedAt = lastBosyuTimestamps.get(rateLimitKey) ?? 0;
  const now = Date.now();

  if (now - lastUsedAt < BOSYU_COOLDOWN_MS) {
    const remainingMs = BOSYU_COOLDOWN_MS - (now - lastUsedAt);
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

  const content = formatBosyuMessage(timeValue, purposeValue, noteValue, bosyuMentionRoleId);

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
    voiceChannelId: currentVoiceChannel?.isVoiceBased() ? currentVoiceChannel.id : null,
  });

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
  const session = bosyuEditSessions.get(messageId);

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
  const content = formatBosyuMessage(timeValue, purposeValue, noteValue, session.bosyuMentionRoleId);

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

function formatBosyuMessage(time, purpose, note, mentionRoleId) {
  const lines = [];

  if (mentionRoleId) {
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

async function getPbChildChannelName(voiceChannel, settings, guild) {
  if (!voiceChannel?.isVoiceBased() || !settings?.parentChannelId || !guild) {
    return null;
  }

  if (voiceChannel.id === settings.parentChannelId) {
    return null;
  }

  if (settings.childCategoryId) {
    if (voiceChannel.parentId !== settings.childCategoryId) {
      return null;
    }
    return voiceChannel.name;
  }

  const parentChannel = await guild.channels
    .fetch(settings.parentChannelId)
    .catch(() => null);

  if (!parentChannel?.isVoiceBased()) {
    return null;
  }

  if (voiceChannel.parentId !== parentChannel.parentId) {
    return null;
  }

  return voiceChannel.name;
}

  async function resolveProcessConfig(interaction, settings, botMember) {
    const errors = [];

    if (!settings?.tempRoleId) {
      errors.push("/setting set で参加者ロールを設定してください。");
    }

    if (!settings?.parentChannelId) {
      errors.push("/setting set でPB親ボイスチャンネルを設定してください。");
    }

    const tempRole = settings?.tempRoleId
      ? await interaction.guild.roles.fetch(settings.tempRoleId).catch(() => null)
      : null;
    const parentChannel = settings?.parentChannelId
      ? await interaction.guild.channels.fetch(settings.parentChannelId).catch(() => null)
      : null;
    const childCategory = settings?.childCategoryId
      ? await interaction.guild.channels.fetch(settings.childCategoryId).catch(() => null)
      : null;
    const waitingVcCategory = settings?.waitingVcCategoryId
      ? await interaction.guild.channels.fetch(settings.waitingVcCategoryId,).catch(() => null)
      : null;

    if (settings?.tempRoleId && !tempRole) {
      errors.push("設定済みの参加者ロールが見つかりません。");
    }

    if (settings?.parentChannelId && !parentChannel?.isVoiceBased()) {
      errors.push("設定済みのPB親チャンネルがボイスチャンネルではありません。");
    }

    if (settings?.childCategoryId && !childCategory) {
      errors.push("設定済みの子VCカテゴリが見つかりません。");
    } else if (settings?.childCategoryId && childCategory.type !== ChannelType.GuildCategory) {
      errors.push("設定済みの子VCカテゴリがカテゴリチャンネルではありません。");
    }

    if (settings?.waitingVcCategoryId && !waitingVcCategory) {
      errors.push("設定済みの待機VCカテゴリが見つかりません。");
    } else if (
      settings?.waitingVcCategoryId &&
      waitingVcCategory.type !== ChannelType.GuildCategory
    ) {
      errors.push("待機VCカテゴリがカテゴリチャンネルではありません。");
    }

    if (tempRole) {
      if (tempRole.managed || tempRole.id === interaction.guild.id) {
        errors.push("その参加者ロールはBotから付与できません。");
      }

      if (tempRole.position >= botMember.roles.highest.position) {
        errors.push("参加者ロールはBotの最上位ロールより下に置いてください。");
      }
    }

    if (!botMember.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
      errors.push("Botに Manage Roles 権限がありません。");
    }

    if (!botMember.permissions.has(PermissionsBitField.Flags.MoveMembers)) {
      errors.push("Botに Move Members 権限がありません。");
    }

    if (parentChannel?.isVoiceBased()) {
      const parentPermissions = parentChannel.permissionsFor(botMember);

      if (!parentPermissions?.has(PermissionsBitField.Flags.ViewChannel)) {
        errors.push("BotがPB親チャンネルを見る権限を持っていません。");
      }

      if (!parentPermissions?.has(PermissionsBitField.Flags.Connect)) {
        errors.push("BotがPB親チャンネルへ接続する権限を持っていません。");
      }
    }


    const sendableChannel = getSendableChannel(interaction);
    const textPermissions = sendableChannel?.permissionsFor(botMember);

    if (!textPermissions?.has(PermissionsBitField.Flags.SendMessages)) {
      errors.push("Botがこのチャンネルにメッセージを送信できません。");
    }

    return {
      errors,
      tempRole,
      parentChannel,
      waitingVcCategory,
      childCategoryId: childCategory?.id ?? null,
      waitingVcCategoryId: waitingVcCategory?.id ?? null,
      waitingVcName: settings?.waitingVcName || DEFAULT_WAITING_VC_NAME,
    };
  }

  async function addRoleToMembers(members, role) {
    const failed = [];

    for (const member of members) {
      try {
        await member.roles.add(role, "Participant role for voice grouping session");
      } catch {
        failed.push(member.displayName);
      }
    }

    return { failed };
  }

  async function addRoleForTransfer(member, role, participantMemberIds) {
    try {
      await member.roles.add(role, "Participant role for voice grouping session");
      participantMemberIds.add(member.id);
      return null;
    } catch {
      return member.displayName;
    }
  }

  async function transferGroups(groups, config) {
    const lines = [];
    const childChannelIds = new Set();
    const participantMemberIds = new Set();

    for (const [index, group] of groups.entries()) {
      const groupNumber = index + 1;
      const seedMember = group[0];

      if (!seedMember?.voice?.channelId) {
        lines.push(`グループ ${groupNumber}: 代表メンバーがVCにいないため転送できませんでした。`);
        continue;
      }

      try {
        await seedMember.voice.setChannel(
          config.parentChannel,
          "Move one group member to PB parent channel",
        );
        const roleFailures = [];
        const seedRoleFailure = await addRoleForTransfer(
          seedMember,
          config.participantRole,
          participantMemberIds,
        );

        if (seedRoleFailure) {
          roleFailures.push(seedRoleFailure);
        }

        const childChannel = await waitForPbChildChannel(seedMember, config);

        if (!childChannel) {
          lines.push(`グループ ${groupNumber}: PBの子VCを検出できませんでした。`);
          continue;
        }

        childChannelIds.add(childChannel.id);

        let movedCount = 1;
        const failed = [];

        for (const member of group.slice(1)) {
          if (!member.voice?.channelId) {
            failed.push(member.displayName);
            continue;
          }

          try {
            await member.voice.setChannel(
              childChannel,
              "Move remaining group members to PB child channel",
            );
            const roleFailure = await addRoleForTransfer(
              member,
              config.participantRole,
              participantMemberIds,
            );

            if (roleFailure) {
              roleFailures.push(roleFailure);
            }

            movedCount += 1;
          } catch {
            failed.push(member.displayName);
          }
        }

        const failedText =
          failed.length > 0 ? ` 転送失敗: ${failed.join("、")}` : "";
        const roleFailedText =
          roleFailures.length > 0
            ? ` 参加者ロール付与失敗: ${roleFailures.join("、")}`
            : "";
        lines.push(
          `グループ ${groupNumber}: ${childChannel.name} へ ${movedCount}/${group.length} 人を転送しました。${failedText}${roleFailedText}`,
        );
      } catch (error) {
        lines.push(`グループ ${groupNumber}: 転送中に失敗しました。${error.message}`);
      }
    }

    return {
      lines,
      childChannelIds: [...childChannelIds],
      participantMemberIds: [...participantMemberIds],
    };
  }

  async function waitForPbChildChannel(member, config) {
    const startedAt = Date.now();

    while (Date.now() - startedAt < PB_CHILD_WAIT_MS) {
      const channel = member.voice.channel;

      if (isExpectedPbChildChannel(channel, config)) {
        return channel;
      }

      await sleep(750);
    }

    return null;
  }

  function isExpectedPbChildChannel(channel, config) {
    if (
      !channel?.isVoiceBased() ||
      channel.id === config.parentChannel.id ||
      channel.id === config.sourceChannelId
    ) {
      return false;
    }

    if (config.childCategoryId) {
      return channel.parentId === config.childCategoryId;
    }

    if (config.parentChannel.parentId) {
      return channel.parentId === config.parentChannel.parentId;
    }

    return true;
  }

  async function runWaitingRoomMonitor(options) {
    const endsAt = Date.now() + WAITING_ROOM_MONITOR_MS;

    await options.channel.send(
      `${options.waitingChannel} の途中参加監視を10分間開始します。`,
    );

    while (Date.now() < endsAt && !options.state.ended) {
      await processWaitingRoom(options);
      await sleep(WAITING_ROOM_POLL_MS);
    }

    if (!options.state.ended) {
      await options.channel.send("途中参加監視を終了しました。");
    }
  }

  async function processWaitingRoom(options) {
    const waitingMembers = getWaitingMembers(options.waitingChannel);

    if (waitingMembers.length === 0) {
      return;
    }

    const underfilledChildChannel = await findUnderfilledChildChannel(
      options.guild,
      options.childChannelIds,
    );

    if (underfilledChildChannel) {
      const member = waitingMembers[0];
      const roleFailure = await moveMemberToChildChannel(
        member,
        underfilledChildChannel,
        options.participantRole,
        options.participantMemberIds,
      );
      const roleFailureText = roleFailure
        ? ` 参加者ロール付与失敗: ${roleFailure}`
        : "";

      await options.channel.send(
        `途中参加: ${member.displayName} を ${underfilledChildChannel.name} へ転送しました。${roleFailureText}`,
      );
      return;
    }

    if (waitingMembers.length >= 3) {
      const result = await transferWaitingGroupToNewChild(waitingMembers.slice(0, 3), {
        parentChannel: options.parentChannel,
        participantRole: options.participantRole,
        sourceChannelId: options.waitingChannel.id,
        childCategoryId: options.childCategoryId,
        participantMemberIds: options.participantMemberIds,
      });

      if (result.childChannelId) {
        options.childChannelIds.add(result.childChannelId);
      }

      await sendChunked(options.channel, `途中参加の新規グループ\n${result.lines.join("\n")}`, {
        allowedMentions: { parse: [] },
      });
    }
  }

  function getWaitingMembers(waitingChannel) {
    return [...waitingChannel.members.values()]
      .filter((member) => !member.user.bot)
      .sort((left, right) =>
        left.displayName.localeCompare(right.displayName, "ja"),
      );
  }

  async function findUnderfilledChildChannel(guild, childChannelIds) {
    for (const channelId of childChannelIds) {
      const channel =
        guild.channels.cache.get(channelId) ??
        (await guild.channels.fetch(channelId).catch(() => null));

      if (
        channel?.isVoiceBased() &&
        [...channel.members.values()].filter((member) => !member.user.bot).length <= 3
      ) {
        return channel;
      }
    }

    return null;
  }

  async function moveMemberToChildChannel(
    member,
    childChannel,
    participantRole,
    participantMemberIds,
  ) {
    await member.voice.setChannel(
      childChannel,
      "Move waiting participant to PB child channel",
    );
    return addRoleForTransfer(member, participantRole, participantMemberIds);
  }

  async function transferWaitingGroupToNewChild(members, config) {
    const lines = [];
    const seedMember = members[0];

    try {
      await seedMember.voice.setChannel(
        config.parentChannel,
        "Move waiting group seed to PB parent channel",
      );
      const roleFailures = [];
      const seedRoleFailure = await addRoleForTransfer(
        seedMember,
        config.participantRole,
        config.participantMemberIds,
      );

      if (seedRoleFailure) {
        roleFailures.push(seedRoleFailure);
      }

      const childChannel = await waitForPbChildChannel(seedMember, config);

      if (!childChannel) {
        return {
          childChannelId: null,
          lines: ["PBの子VCを検出できませんでした。"],
        };
      }

      let movedCount = 1;
      const failed = [];

      for (const member of members.slice(1)) {
        try {
          await member.voice.setChannel(
            childChannel,
            "Move waiting group members to PB child channel",
          );
          const roleFailure = await addRoleForTransfer(
            member,
            config.participantRole,
            config.participantMemberIds,
          );

          if (roleFailure) {
            roleFailures.push(roleFailure);
          }

          movedCount += 1;
        } catch {
          failed.push(member.displayName);
        }
      }

      const failedText =
        failed.length > 0 ? ` 転送失敗: ${failed.join("、")}` : "";
      const roleFailedText =
        roleFailures.length > 0
          ? ` 参加者ロール付与失敗: ${roleFailures.join("、")}`
          : "";
      lines.push(
        `${childChannel.name} へ ${movedCount}/${members.length} 人を転送しました。${failedText}${roleFailedText}`,
      );

      return {
        childChannelId: childChannel.id,
        lines,
      };
    } catch (error) {
      return {
        childChannelId: null,
        lines: [`転送中に失敗しました。${error.message}`],
      };
    }
  }

  async function runEndNotificationFlow(options) {
    const notificationCanceled = await runCountdown({
      channel: options.channel,
      ownerId: options.ownerId,
      totalMs: options.noticeWaitMs,
      updateEveryMs: COUNTDOWN_UPDATE_MS,
      buttonLabel: "終了通知キャンセル",
      cancelText: "終了通知はキャンセルされました。参加者ロールをすぐ解除します。",
      autoCancelWhen: () => areAllChannelsGone(options.guild, options.childChannelIds),
      render: (remainingMs) =>
        `終了通知まで残り ${formatDuration(remainingMs)} です。\nキャンセルできるのはコマンド実行者のみです。`,
    });

    if (notificationCanceled) {
      const cancelText =
        notificationCanceled === "auto"
          ? "PBの子VCがすべて削除されたため、終了通知を自動キャンセルしました。参加者ロールを解除します。"
          : "終了通知をキャンセルしました。参加者ロールを解除します。";

      await options.channel.send(cancelText);
      if (options.temporaryWaitingVc) {

        if (options.temporaryWaitingVcDeleteTimer) {
          clearTimeout(options.temporaryWaitingVcDeleteTimer);
        }

        const fetchedChannel =
          await options.guild.channels.fetch(
            options.temporaryWaitingVc.id,
          ).catch(() => null);

        if (fetchedChannel) {
          await notifyWaitingVcClosure(options.channel, fetchedChannel);
          await fetchedChannel.delete().catch(() => null);

          await options.channel.send(
            "待機用VCを削除しました。",
          );
        }
      }
      const cleanupResult = await removeRoleFromMembers(
        options.guild,
        options.roleId,
        options.memberIds,
      );

      await options.channel.send(
        `参加者ロールを解除しました。解除成功: ${cleanupResult.removed}人、解除失敗: ${cleanupResult.failed}人。`,
      );
      options.state.ended = true;
      return;
    }

    await options.channel.send({
      content: `<@&${options.roleId}> ${options.finishMessage}`,
      allowedMentions: { roles: [options.roleId] },
    });

    await sleep(options.roleRemoveWaitMs);

    const cleanupResult = await removeRoleFromMembers(
      options.guild,
      options.roleId,
      options.memberIds,
    );

    await options.channel.send(
      `参加者ロールを解除しました。解除成功: ${cleanupResult.removed}人、解除失敗: ${cleanupResult.failed}人。`,
    );
    options.state.ended = true;
  }

  async function removeRoleFromMembers(guild, roleId, memberIds) {
    let removed = 0;
    let failed = 0;

    for (const memberId of memberIds) {
      try {
        const member = await guild.members.fetch(memberId);

        if (member.roles.cache.has(roleId)) {
          await member.roles.remove(roleId, "Remove participant voice grouping role");
          removed += 1;
        }
      } catch {
        failed += 1;
      }
    }

    return { removed, failed };
  }

  async function areAllChannelsGone(guild, channelIds) {
    const ids = [...channelIds];

    if (ids.length === 0) {
      return false;
    }

    for (const channelId of ids) {
      const cachedChannel = guild.channels.cache.get(channelId);

      if (cachedChannel) {
        return false;
      }

      const fetchedChannel = await guild.channels
        .fetch(channelId)
        .catch(() => null);

      if (fetchedChannel) {
        return false;
      }
    }

    return true;
  }

  async function runCountdown(options) {
    if (options.totalMs <= 0) {
      return false;
    }

    const sessionId = createSessionId();
    const session = {
      ownerId: options.ownerId,
      canceled: false,
      cancelText: options.cancelText,
    };

    activeSessions.set(sessionId, session);

    const message = await options.channel.send({
      content: options.render(options.totalMs),
      components: [createCancelRow(sessionId, options.buttonLabel)],
    });

    const startedAt = Date.now();

    while (Date.now() - startedAt < options.totalMs) {
      if (session.canceled) {
        activeSessions.delete(sessionId);
        await deleteLater(message);
        return true;
      }

      const elapsedMs = Date.now() - startedAt;
      const remainingMs = Math.max(0, options.totalMs - elapsedMs);
      await sleep(Math.min(options.updateEveryMs, remainingMs));

      if (!session.canceled && options.autoCancelWhen) {
        const shouldAutoCancel = await options.autoCancelWhen();

        if (shouldAutoCancel) {
          activeSessions.delete(sessionId);
          await editSafely(message, {
            content: "PBの子VCがすべて削除されたため、終了通知を自動キャンセルします。",
            components: [],
          });
          await deleteLater(message);
          return "auto";
        }
      }

      if (!session.canceled) {
        await editSafely(message, {
          content: options.render(Math.max(0, options.totalMs - (Date.now() - startedAt))),
          components: [createCancelRow(sessionId, options.buttonLabel)],
        });
      }
    }

    activeSessions.delete(sessionId);
    await deleteLater(message);
    return false;
  }

  async function handleSessionButton(interaction) {
    if (!interaction.customId.startsWith("session_cancel:")) {
      return;
    }

    const sessionId = interaction.customId.slice("session_cancel:".length);
    const session = activeSessions.get(sessionId);

    if (!session) {
      await interaction.reply({
        content: "この待機操作はすでに終了しています。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (interaction.user.id !== session.ownerId) {
      await interaction.reply({
        content: "このボタンを押せるのは、コマンドを実行した人だけです。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    session.canceled = true;
    await interaction.update({
      content: session.cancelText,
      components: [],
    });
  }

  function createCancelRow(sessionId, label) {
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`session_cancel:${sessionId}`)
        .setLabel(label)
        .setStyle(ButtonStyle.Danger),
    );
  }

  function formatSettings(settings) {
    if (!settings) {
      return "PB連携設定はまだ保存されていません。";
    }

    return [
      "現在のPB連携設定:",
      `参加者ロール: ${settings.tempRoleId ? `<@&${settings.tempRoleId}>` : "未設定"}`,
      `PB親チャンネル: ${settings.parentChannelId ? `<#${settings.parentChannelId}>` : "未設定"}`,
      `子VCカテゴリ: ${settings.childCategoryId ? `<#${settings.childCategoryId}>` : "未設定"}`,
      `待機VCカテゴリ: ${settings.waitingVcCategoryId ? `<#${settings.waitingVcCategoryId}>` : "未設定"}`,
      `待機VC名: ${settings.waitingVcName || DEFAULT_WAITING_VC_NAME}`,
      `募集コマンド使用チャンネル: ${settings.bosyuChannelId ? `<#${settings.bosyuChannelId}>` : "制限なし"}`,
      `募集メンションロール: ${settings.bosyuMentionRoleId ? `<@&${settings.bosyuMentionRoleId}>` : "未設定"}`,
      `終了通知内容: ${settings.finishMessage || DEFAULT_FINISH_MESSAGE}`,
      `転送前待機: ${getNonNegativeInteger(settings.transferWaitSeconds, DEFAULT_TRANSFER_WAIT_SECONDS)}秒`,
      `終了通知前待機: ${getNonNegativeInteger(settings.noticeWaitMinutes, DEFAULT_NOTICE_WAIT_MINUTES)}分`,
      `通知後ロール解除待機: ${getNonNegativeInteger(settings.roleRemoveWaitMinutes, DEFAULT_ROLE_REMOVE_WAIT_MINUTES)}分`,
      "",
      "現在のVCリマインダー設定:",
      `リマインダー対象PB親VC: ${settings.voiceReminderParentChannelId ? `<#${settings.voiceReminderParentChannelId}>` : "未設定"}`,
      `参加者ロール: ${settings.voiceParticipantRoleId ? `<@&${settings.voiceParticipantRoleId}>` : "未設定"}`,
      `リマインダー送信先: ${settings.voiceReminderChannelId ? `<#${settings.voiceReminderChannelId}>` : "ボイスチャンネルに付随するテキストチャンネルを自動参照"}`,
      `話題送信先: ${settings.voiceTopicChannelId ? `<#${settings.voiceTopicChannelId}>` : "リマインダー送信先と同じ"}`,
    ].join("\n");
  }

  function formatResult(channel, total, groups) {
    const lines = [
      `**${channel.name} のグループ分け**`,
      describeGroups(total, groups),
      "",
    ];

    groups.forEach((group, index) => {
      const members = group
        .map((member) => `- ${escapeMarkdown(member.displayName)}`)
        .join("\n");

      lines.push(`**グループ ${index + 1} (${group.length}人)**`);
      lines.push(members);
      lines.push("");
    });

    return lines.join("\n").trim();
  }

  function escapeMarkdown(text) {
    return text.replace(/([\\`*_{}[\]()#+\-.!|>])/g, "\\$1");
  }

  function splitMessage(content, maxLength = MESSAGE_LIMIT) {
    const chunks = [];
    let current = "";

    for (const line of content.split("\n")) {
      if (line.length > maxLength) {
        if (current) {
          chunks.push(current);
          current = "";
        }

        for (let index = 0; index < line.length; index += maxLength) {
          chunks.push(line.slice(index, index + maxLength));
        }

        continue;
      }

      const next = current ? `${current}\n${line}` : line;

      if (next.length > maxLength) {
        chunks.push(current);
        current = line;
      } else {
        current = next;
      }
    }

    if (current) {
      chunks.push(current);
    }

    return chunks.length > 0 ? chunks : [content];
  }

  async function replyInChunks(interaction, content, options) {
    const chunks = splitMessage(content);
    const [firstChunk, ...restChunks] = chunks;

    await interaction.reply({
      ...options,
      content: firstChunk,
    });

    for (const chunk of restChunks) {
      await interaction.followUp({
        ...options,
        content: chunk,
      });
    }
  }

  async function sendChunked(channel, content, options = {}) {
    for (const chunk of splitMessage(content)) {
      await channel.send({
        ...options,
        content: chunk,
      });
    }
  }

  async function replySafely(interaction, content) {
    const payload = {
      content,
      flags: MessageFlags.Ephemeral,
    };

    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(payload).catch(() => null);
    } else {
      await interaction.reply(payload).catch(() => null);
    }
  }

  async function replyOrFollowUp(interaction, payload) {
    if (!payload || typeof payload !== "object") {
      payload = { content: String(payload ?? ""), flags: MessageFlags.Ephemeral };
    }

    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(payload).catch(() => null);
    } else {
      await interaction.reply(payload).catch(() => null);
    }
  }

  async function editSafely(message, payload) {
    await message.edit(payload).catch(() => null);
  }

  // Note: Discord API does not provide a channel "status" field. We no longer attempt
  // to synthesize a status by editing channel names; the bot only updates VC names when
  // the purpose is provided. Topic submissions are forwarded to the configured reminder
  // text channel instead of being stored as a channel status.

  async function deleteLater(message) {
    await sleep(1500);
    await message.delete().catch(() => null);
  }

  async function notifyWaitingVcClosure(operationChannel, waitingVc) {
    const waitingMembers = [...waitingVc.members.values()].filter(
      (member) => !member.user.bot,
    );

    if (waitingMembers.length === 0) {
      return;
    }

    await operationChannel.send(
      "誠に申し訳ございませんが、途中参加の条件がそろわなかったため途中参加部屋が削除されました。次の機会があればぜひまたご参加ください",
    );
  }

  function getSendableChannel(interaction) {
    const channel = interaction.channel;
    return channel && typeof channel.send === "function" ? channel : null;
  }

  function createSessionId() {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  }

  function addMany(set, values) {
    for (const value of values) {
      set.add(value);
    }
  }

  function formatDuration(ms) {
    const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;

    return `${minutes}分${seconds.toString().padStart(2, "0")}秒`;
  }

  function getNonNegativeInteger(value, fallback) {
    return Number.isInteger(value) && value >= 0 ? value : fallback;
  }

  function secondsToMs(seconds) {
    return seconds * 1000;
  }

  function minutesToMs(minutes) {
    return minutes * 60 * 1000;
  }

  function sleep(ms) {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  function startHealthServer(port) {
    const startedAt = new Date();

    const server = createServer((request, response) => {
      const path = request.url?.split("?")[0] ?? "/";

      if (request.method === "GET" && (path === "/" || path === "/health")) {
        const body = JSON.stringify({
          ok: true,
          ready: client.isReady(),
          bot: client.user?.tag ?? null,
          uptimeSeconds: Math.round(process.uptime()),
          startedAt: startedAt.toISOString(),
        });

        response.writeHead(200, {
          "cache-control": "no-store",
          "content-type": "application/json; charset=utf-8",
        });
        response.end(body);
        return;
      }

      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not Found");
    });

    server.listen(port, "0.0.0.0", () => {
      console.log(`Health server listening on port ${port}`);
    });
  }

  client.login(DISCORD_TOKEN);
