import "./load-env.js";
import { createServer } from "node:http";
import {
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  PermissionsBitField,
} from "discord.js";
import { buildGroups, describeGroups, shuffle } from "./grouping.js";

const { DISCORD_TOKEN, KEEP_ALIVE_PORT, PORT } = process.env;

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
  if (!interaction.isChatInputCommand()) {
    return;
  }

  if (interaction.commandName !== "splitvc") {
    return;
  }

  await handleSplitVoice(interaction);
});

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
  const channel = selectedChannel ?? fallbackChannel;
  const privateResult = interaction.options.getBoolean("private") ?? false;

  if (!channel?.isVoiceBased()) {
    await interaction.reply({
      content: "対象のボイスチャンネルを指定するか、自分がボイスチャンネルに入ってから実行してください。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const permissions = channel.permissionsFor(interaction.client.user);
  if (!permissions?.has(PermissionsBitField.Flags.ViewChannel)) {
    await interaction.reply({
      content: "Botがそのボイスチャンネルを見る権限を持っていません。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const includeBots = interaction.options.getBoolean("include_bots") ?? false;
  const shouldShuffle = interaction.options.getBoolean("shuffle") ?? true;
  const members = [...channel.members.values()]
    .filter((member) => includeBots || !member.user.bot)
    .sort((left, right) =>
      left.displayName.localeCompare(right.displayName, "ja"),
    );

  const targetMembers = shouldShuffle ? shuffle(members) : members;
  const groups = buildGroups(targetMembers);

  if (targetMembers.length === 0) {
    await interaction.reply({
      content: `${channel} に対象メンバーがいません。`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const content = formatResult(channel, targetMembers.length, groups);

  await interaction.reply({
    content,
    flags: privateResult ? MessageFlags.Ephemeral : undefined,
    allowedMentions: { parse: [] },
  });
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
