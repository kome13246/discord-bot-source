import "./load-env.js";
import { createServer } from "node:http";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  PermissionsBitField,
} from "discord.js";
import { buildGroups, describeGroups, shuffle } from "./grouping.js";
import { getGuildSettings, saveGuildSettings } from "./settings-store.js";

const { DISCORD_TOKEN, KEEP_ALIVE_PORT, PORT } = process.env;

const TRANSFER_WAIT_MS = 30 * 1000;
const END_NOTICE_WAIT_MS = 25 * 60 * 1000;
const ROLE_CLEANUP_WAIT_MS = 10 * 60 * 1000;
const PB_CHILD_WAIT_MS = 20 * 1000;
const DEFAULT_FINISH_MESSAGE = "終了時間です。";
const MESSAGE_LIMIT = 1900;

const activeSessions = new Map();

if (!DISCORD_TOKEN) {
  throw new Error("DISCORD_TOKEN is required.");
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

const healthPort = Number(PORT ?? KEEP_ALIVE_PORT);

if (Number.isInteger(healthPort) && healthPort > 0) {
  startHealthServer(healthPort);
}

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);
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

  const tempRole = interaction.options.getRole("temp_role", false);
  const parentChannel = interaction.options.getChannel("parent_channel", false);
  const childCategory = interaction.options.getChannel("child_category", false);
  const finishMessage = interaction.options.getString("finish_message", false);
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

  if (finishMessage?.trim()) {
    patch.finishMessage = finishMessage.trim();
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

  if (config.errors.length > 0) {
    await interaction.followUp({
      content: `PB連携プロセスは実行できません。\n${config.errors.map((error) => `- ${error}`).join("\n")}`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const roleResult = await addRoleToMembers(targetMembers, config.tempRole);
  const operationChannel = getSendableChannel(interaction);

  if (!operationChannel) {
    await interaction.followUp({
      content: "結果や待機メッセージを送信できるテキストチャンネルが見つかりません。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await sendChunked(
    operationChannel,
    [
      `${config.tempRole} を対象メンバーに付与しました。`,
      roleResult.failed.length > 0
        ? `付与できなかったメンバー: ${roleResult.failed.join("、")}`
        : "全員に付与できました。",
    ].join("\n"),
    { allowedMentions: { roles: [] } },
  );

  const transferCanceled = await runCountdown({
    channel: operationChannel,
    ownerId: interaction.user.id,
    totalMs: TRANSFER_WAIT_MS,
    updateEveryMs: 5 * 1000,
    buttonLabel: "転送キャンセル",
    cancelText: "転送はキャンセルされました。終了通知の待機は続行します。",
    render: (remainingMs) =>
      `PB親チャンネルへの転送開始まで残り ${formatDuration(remainingMs)} です。\nキャンセルできるのはコマンド実行者のみです。`,
  });

  if (transferCanceled) {
    await operationChannel.send("転送をキャンセルしました。");
  } else {
    const transferLines = await transferGroups(groups, {
      parentChannel: config.parentChannel,
      childCategoryId: config.childCategoryId,
      sourceChannelId: sourceChannel.id,
    });

    await sendChunked(operationChannel, `転送結果\n${transferLines.join("\n")}`, {
      allowedMentions: { parse: [] },
    });
  }

  void runEndNotificationFlow({
    channel: operationChannel,
    guild: interaction.guild,
    ownerId: interaction.user.id,
    roleId: config.tempRole.id,
    memberIds: targetMembers.map((member) => member.id),
    finishMessage: settings.finishMessage || DEFAULT_FINISH_MESSAGE,
  }).catch((error) => {
    console.error(error);
  });
}

async function resolveProcessConfig(interaction, settings, botMember) {
  const errors = [];

  if (!settings?.tempRoleId) {
    errors.push("/setting set で一時ロールを設定してください。");
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

  if (settings?.tempRoleId && !tempRole) {
    errors.push("設定済みの一時ロールが見つかりません。");
  }

  if (settings?.parentChannelId && !parentChannel?.isVoiceBased()) {
    errors.push("設定済みのPB親チャンネルがボイスチャンネルではありません。");
  }

  if (settings?.childCategoryId && childCategory?.type !== ChannelType.GuildCategory) {
    errors.push("設定済みの子VCカテゴリがカテゴリチャンネルではありません。");
  }

  if (tempRole) {
    if (tempRole.managed || tempRole.id === interaction.guild.id) {
      errors.push("その一時ロールはBotから付与できません。");
    }

    if (tempRole.position >= botMember.roles.highest.position) {
      errors.push("一時ロールはBotの最上位ロールより下に置いてください。");
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
    childCategoryId: childCategory?.id ?? null,
  };
}

async function addRoleToMembers(members, role) {
  const failed = [];

  for (const member of members) {
    try {
      await member.roles.add(role, "Temporary role for voice grouping session");
    } catch {
      failed.push(member.displayName);
    }
  }

  return { failed };
}

async function transferGroups(groups, config) {
  const lines = [];

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

      const childChannel = await waitForPbChildChannel(seedMember, config);

      if (!childChannel) {
        lines.push(`グループ ${groupNumber}: PBの子VCを検出できませんでした。`);
        continue;
      }

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
          movedCount += 1;
        } catch {
          failed.push(member.displayName);
        }
      }

      const failedText =
        failed.length > 0 ? ` 転送失敗: ${failed.join("、")}` : "";
      lines.push(
        `グループ ${groupNumber}: ${childChannel.name} へ ${movedCount}/${group.length} 人を転送しました。${failedText}`,
      );
    } catch (error) {
      lines.push(`グループ ${groupNumber}: 転送中に失敗しました。${error.message}`);
    }
  }

  return lines;
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

async function runEndNotificationFlow(options) {
  const notificationCanceled = await runCountdown({
    channel: options.channel,
    ownerId: options.ownerId,
    totalMs: END_NOTICE_WAIT_MS,
    updateEveryMs: 60 * 1000,
    buttonLabel: "終了通知キャンセル",
    cancelText: "終了通知はキャンセルされました。一時ロール解除は予定通り行います。",
    render: (remainingMs) =>
      `終了通知まで残り ${formatDuration(remainingMs)} です。\nキャンセルできるのはコマンド実行者のみです。`,
  });

  if (!notificationCanceled) {
    await options.channel.send({
      content: `<@&${options.roleId}> ${options.finishMessage}`,
      allowedMentions: { roles: [options.roleId] },
    });
  } else {
    await options.channel.send("終了通知をキャンセルしました。");
  }

  await sleep(ROLE_CLEANUP_WAIT_MS);

  const cleanupResult = await removeRoleFromMembers(
    options.guild,
    options.roleId,
    options.memberIds,
  );

  await options.channel.send(
    `一時ロールを解除しました。解除成功: ${cleanupResult.removed}人、解除失敗: ${cleanupResult.failed}人。`,
  );
}

async function removeRoleFromMembers(guild, roleId, memberIds) {
  let removed = 0;
  let failed = 0;

  for (const memberId of memberIds) {
    try {
      const member = await guild.members.fetch(memberId);

      if (member.roles.cache.has(roleId)) {
        await member.roles.remove(roleId, "Remove temporary voice grouping role");
        removed += 1;
      }
    } catch {
      failed += 1;
    }
  }

  return { removed, failed };
}

async function runCountdown(options) {
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
    `一時ロール: ${settings.tempRoleId ? `<@&${settings.tempRoleId}>` : "未設定"}`,
    `PB親チャンネル: ${settings.parentChannelId ? `<#${settings.parentChannelId}>` : "未設定"}`,
    `子VCカテゴリ: ${settings.childCategoryId ? `<#${settings.childCategoryId}>` : "未設定"}`,
    `終了通知内容: ${settings.finishMessage || DEFAULT_FINISH_MESSAGE}`,
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

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes === 0) {
    return `${seconds}秒`;
  }

  return `${minutes}分${seconds}秒`;
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
