import "./load-env.js";
import { createServer } from "node:http";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  PermissionFlagsBits,
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
const COUNTDOWN_UPDATE_MS = 1000;
const PB_CHILD_WAIT_MS = 20 * 1000;
const DEFAULT_FINISH_MESSAGE = "終了時間です。";
const MESSAGE_LIMIT = 1900;

const activeSessions = new Map();
const bumpReminderTimers = new Map();

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
  } catch (error) {
    console.error(error);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isButton()) {
      await handleSessionButton(interaction);
      return;
    }

    if (!interaction.isChatInputCommand()) {
      return;
    }

    if (interaction.commandName === "splitvc") {
      await handleSplitVoice(interaction);
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
    await interaction.reply({
      content: "このコマンドはサーバー内で使ってください。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild)) {
    await interaction.reply({
      content: "この設定を変更するには、サーバー管理権限が必要です。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const subcommand = interaction.options.getSubcommand();

  if (subcommand === "show") {
    const settings = await getGuildSettings(interaction.guildId);
    await interaction.reply({
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
  await interaction.reply({
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
        name: "途中参加部屋",
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

      if (
        channel?.isVoiceBased() &&
        channel.id !== config.parentChannel.id &&
        channel.id !== config.sourceChannelId &&
        (!config.childCategoryId || channel.parentId === config.childCategoryId)
      ) {
        return channel;
      }

      await sleep(750);
    }

    return null;
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
      `終了通知内容: ${settings.finishMessage || DEFAULT_FINISH_MESSAGE}`,
      `転送前待機: ${getNonNegativeInteger(settings.transferWaitSeconds, DEFAULT_TRANSFER_WAIT_SECONDS)}秒`,
      `終了通知前待機: ${getNonNegativeInteger(settings.noticeWaitMinutes, DEFAULT_NOTICE_WAIT_MINUTES)}分`,
      `通知後ロール解除待機: ${getNonNegativeInteger(settings.roleRemoveWaitMinutes, DEFAULT_ROLE_REMOVE_WAIT_MINUTES)}分`,
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

  async function editSafely(message, payload) {
    await message.edit(payload).catch(() => null);
  }

  async function deleteLater(message) {
    await sleep(1500);
    await message.delete().catch(() => null);
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
