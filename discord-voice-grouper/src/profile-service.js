import { EmbedBuilder, ChannelType, PermissionFlagsBits } from "discord.js";
import { UserProfile } from "./models/user-profile.js";
import { ActiveProfile } from "./models/active-profile.js";

const queues = new Map();
const keyOf = (guildId, userId) => `${guildId}:${userId}`;

export function summarizeProfileError(error) {
  const text = error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error ?? "unknown error");
  return text
    .replace(/mongodb(?:\+srv)?:\/\/[^\s]+/gi, "[redacted MongoDB URI]")
    .replace(/\b(token|password|passwd|pwd|secret)\s*[=:]\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/\bBot\s+[A-Za-z0-9._-]+/g, "Bot [redacted]")
    .slice(0, 200);
}

export function normalizeProfileValue(value, max) {
  return String(value ?? "").trim().replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").slice(0, max);
}

export function buildProfileEmbed(profile, member) {
  const lines = [`呼び名：${profile.nickname}`];
  if (profile.status) lines.push(`現状：${profile.status}`);
  if (profile.hobby) lines.push(`趣味：${profile.hobby}`);
  if (profile.comment) lines.push(`ひとこと：${profile.comment}`);
  const embed = new EmbedBuilder().setColor(0x5865f2)
    .setTitle(`${member.displayName}さんのプロフィール`).setDescription(lines.join("\n"))
    .setFooter({ text: "Profile Bot" });
  const avatar = member.displayAvatarURL?.();
  if (avatar) embed.setThumbnail(avatar);
  return embed;
}

function enqueue(guildId, userId, task) {
  const key = keyOf(guildId, userId);
  const previous = queues.get(key) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(task).finally(() => { if (queues.get(key) === next) queues.delete(key); });
  queues.set(key, next);
  return next;
}

async function logError({ guild, settings, sendOperationalLog, processName, voiceChannel, member, error }) {
  const message = `[${processName}] guild=${guild?.name ?? "?"}(${guild?.id ?? "?"}) voice=${voiceChannel?.name ?? "?"}(${voiceChannel?.id ?? "?"}) user=${member?.user?.username ?? "?"}(${member?.id ?? "?"}) error=${summarizeProfileError(error)} time=${new Date().toISOString()}`;
  console.error(message);
  try { await sendOperationalLog({ guild, settings, fallbackChannel: voiceChannel, content: message }); } catch {}
}

async function removeActive({ guild, settings, record, sendOperationalLog, member, voiceChannel }) {
  if (!record) return;
  try {
    const channel = await guild.channels.fetch(record.channelId).catch(async (error) => {
      if (error?.code === 10003 || error?.code === "10003") {
        return null;
      }
      await logError({ guild, settings, sendOperationalLog, processName: "profile channel fetch failed", voiceChannel, member, error });
      return null;
    });
    if (channel?.messages?.fetch) {
      const message = await channel.messages.fetch(record.messageId).catch(async (error) => {
        if (error?.code !== 10008) {
          await logError({ guild, settings, sendOperationalLog, processName: "profile message fetch failed", voiceChannel, member, error });
        }
        return null;
      });
      if (message) await message.delete();
    }
  } catch (error) {
    if (error?.code !== 10003 && error?.code !== "10003") {
      await logError({ guild, settings, sendOperationalLog, processName: "profile delete failed", voiceChannel, member, error });
    }
  }
  await ActiveProfile.deleteOne({ _id: record._id }).catch(async (error) => logError({ guild, settings, sendOperationalLog, processName: "profile metadata delete failed", voiceChannel, member, error }));
}

export async function handleProfileVoiceState(oldState, newState, { client, sendOperationalLog, getGuildSettings }) {
  if (oldState.channelId === newState.channelId) return;
  const guild = newState.guild ?? oldState.guild;
  const member = newState.member ?? oldState.member;
  if (!guild || !member || member.user?.bot) return;
  return enqueue(guild.id, member.id, async () => {
    const settings = await getGuildSettings(guild.id).catch(async (error) => {
      await logError({ guild, settings: null, sendOperationalLog, processName: "profile settings fetch failed", voiceChannel: newState.channel ?? oldState.channel, member, error });
      return null;
    });
    const oldRecord = await ActiveProfile.findOne({ guildId: guild.id, userId: member.id }).catch(async (error) => { await logError({ guild, settings, sendOperationalLog, processName: "profile metadata fetch failed", voiceChannel: oldState.channel, member, error }); return null; });
    if (oldRecord) await removeActive({ guild, settings, record: oldRecord, sendOperationalLog, member, voiceChannel: oldState.channel });
    if (!newState.channelId || newState.channel?.type === ChannelType.GuildStageVoice) return;
    if (isProfileExcludedVoiceChannel(newState.channel, settings)) return;
    const profile = await UserProfile.findOne({ guildId: guild.id, userId: member.id }).catch(async (error) => { await logError({ guild, settings, sendOperationalLog, processName: "profile fetch failed", voiceChannel: newState.channel, member, error }); return null; });
    if (!profile) return;
    await sendProfileToVoice(newState.channel, member, profile, { guild, settings, sendOperationalLog });
  });
}

export async function sendProfileToVoice(voiceChannel, member, profile, context) {
  const me = voiceChannel.guild.members.me;
  const permissions = voiceChannel.permissionsFor(me);
  const required = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ReadMessageHistory];
  if (!permissions || !required.every((permission) => permissions.has(permission))) {
    await logError({ ...context, processName: "profile permission denied", voiceChannel, member, error: new Error("required permission missing") }); return null;
  }
  try {
    const message = await voiceChannel.send({ embeds: [buildProfileEmbed(profile, member)], allowedMentions: { parse: [] } });
    try {
      await ActiveProfile.findOneAndUpdate({ guildId: voiceChannel.guild.id, userId: member.id }, { channelId: voiceChannel.id, messageId: message.id }, { upsert: true, new: true });
    } catch (error) {
      await message.delete().catch(() => null);
      await logError({ ...context, processName: "profile metadata save failed", voiceChannel, member, error });
      return null;
    }
    return message;
  } catch (error) { await logError({ ...context, processName: "profile send failed", voiceChannel, member, error }); return null; }
}

export async function restoreProfiles(client, { sendOperationalLog, getGuildSettings }) {
  const stale = await ActiveProfile.find({}).catch(async (error) => {
    for (const guild of client.guilds.cache.values()) {
      const settings = await getGuildSettings(guild.id).catch(() => null);
      await logError({ guild, settings, sendOperationalLog, processName: "profile startup metadata fetch failed", error });
    }
    return [];
  });
  for (const record of stale) {
    const guild = client.guilds.cache.get(record.guildId);
    if (!guild) {
      await ActiveProfile.deleteOne({ _id: record._id }).catch((error) => console.error("Profile startup metadata delete failed:", summarizeProfileError(error)));
      continue;
    }
    const settings = await getGuildSettings(guild.id).catch(async (error) => {
      await logError({ guild, settings: null, sendOperationalLog, processName: "profile startup settings fetch failed", error });
      return null;
    });
    await removeActive({ guild, record, settings, sendOperationalLog }).catch(async (error) => logError({ guild, settings, sendOperationalLog, processName: "profile startup delete failed", error }));
  }
  for (const guild of client.guilds.cache.values()) {
    const settings = await getGuildSettings(guild.id).catch(async (error) => {
      await logError({ guild, settings: null, sendOperationalLog, processName: "profile startup settings fetch failed", error });
      return null;
    });
    for (const channel of guild.channels.cache.values()) {
      if (!channel.isVoiceBased?.() || channel.type === ChannelType.GuildStageVoice) continue;
      if (isProfileExcludedVoiceChannel(channel, settings)) continue;
      for (const member of channel.members.values()) {
        if (member.user.bot) continue;
        const profile = await UserProfile.findOne({ guildId: guild.id, userId: member.id }).catch(async (error) => {
          await logError({ guild, settings, sendOperationalLog, processName: "profile startup fetch failed", voiceChannel: channel, member, error });
          return null;
        });
        if (profile) await sendProfileToVoice(channel, member, profile, { guild, settings, sendOperationalLog });
      }
    }
  }
}

export async function refreshProfileInVoice(member, context) {
  return enqueue(member.guild.id, member.id, async () => {
    const channel = member.voice?.channel;
    if (!channel || channel.type === ChannelType.GuildStageVoice) return;
    const record = await ActiveProfile.findOne({ guildId: member.guild.id, userId: member.id }).catch(async (error) => {
      await logError({ ...context, processName: "profile refresh metadata fetch failed", voiceChannel: channel, member, error });
      return null;
    });
    if (record) await removeActive({ ...context, record, member, voiceChannel: channel });
    if (isProfileExcludedVoiceChannel(channel, context.settings)) return;
    const profile = await UserProfile.findOne({ guildId: member.guild.id, userId: member.id }).catch(async (error) => {
      await logError({ ...context, processName: "profile refresh fetch failed", voiceChannel: channel, member, error });
      return null;
    });
    if (profile) await sendProfileToVoice(channel, member, profile, context);
  });
}

function isProfileExcludedVoiceChannel(channel, settings) {
  if (!channel?.id) return false;
  return [
    settings?.gatheringVoiceChannelId,
    settings?.gatheringVcUnlockChannelId,
  ].includes(channel.id);
}
