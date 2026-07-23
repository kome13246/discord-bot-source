import {
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
} from "discord.js";
import { UserProfile } from "./models/user-profile.js";
import { summarizeProfileError } from "./profile-service.js";

const MISSING_RESOURCE_CODES = new Set([10003, 10008, "10003", "10008"]);

export function buildPublicProfileEmbed({ profile, member, user = member?.user }) {
  const displayName = member?.displayName ?? user?.username ?? profile.nickname;
  const avatarUrl = member?.displayAvatarURL?.() ?? user?.displayAvatarURL?.();
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setAuthor({
      name: displayName,
      ...(avatarUrl ? { iconURL: avatarUrl } : {}),
    })
    .setTitle(`${profile.nickname}さんの自己紹介`)
    .setTimestamp(new Date());

  const fields = [
    ["現状", profile.status],
    ["趣味", profile.hobby],
    ["ひとこと", profile.comment],
  ];
  const nonEmptyFields = fields.filter(([, value]) => value);
  if (nonEmptyFields.length > 0) {
    embed.addFields(nonEmptyFields.map(([name, value]) => ({ name, value, inline: false })));
  }
  return embed;
}

export function profilePublishButton(userId) {
  return {
    customId: `profile_publish:${userId}`,
    label: "自己紹介を送信",
  };
}

export async function resolveProfileIntroductionChannel(guild, settings) {
  const channelId = settings?.profileIntroductionChannelId;
  if (!channelId) return null;
  const channel = await guild.channels.fetch(channelId).catch((error) => {
    if (isMissingResourceError(error)) return null;
    throw error;
  });
  if (!channel || ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)) {
    return null;
  }
  return channel;
}

export function canSendPublicProfile(channel, guild) {
  const me = guild.members.me;
  const permissions = channel?.permissionsFor(me);
  const required = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks,
  ];
  return Boolean(permissions && required.every((permission) => permissions.has(permission)));
}

export async function canPublishProfile({ guild, settings }) {
  if (!settings?.profileIntroductionChannelId) {
    return { ok: false, reason: "not-configured", channel: null };
  }
  const channel = await resolveProfileIntroductionChannel(guild, settings);
  if (!channel) return { ok: false, reason: "channel-unavailable", channel: null };
  if (!canSendPublicProfile(channel, guild)) {
    return { ok: false, reason: "permission-denied", channel };
  }
  return { ok: true, reason: null, channel };
}

export async function clearPublishedProfileReference({ guildId, userId }) {
  await UserProfile.updateOne(
    { guildId, userId },
    { $set: { publishedChannelId: null, publishedMessageId: null, publishedAt: null, publishedUpdatedAt: null } },
  );
}

export async function refreshPublishedProfile({ guild, member, profile, settings }) {
  if (!profile.publishedChannelId || !profile.publishedMessageId) {
    if (profile.publishedChannelId || profile.publishedMessageId) {
      await clearPublishedProfileReference({ guildId: guild.id, userId: profile.userId });
      return { status: "unpublished", profile: withClearedPublication(profile) };
    }
    return { status: "unpublished", profile };
  }

  const channel = await guild.channels.fetch(profile.publishedChannelId).catch((error) => {
    if (isMissingResourceError(error)) return null;
    throw error;
  });
  if (!channel) {
    await clearPublishedProfileReference({ guildId: guild.id, userId: profile.userId });
    return { status: "missing", profile: withClearedPublication(profile) };
  }
  if (!canSendPublicProfile(channel, guild)) {
    throw new Error("Published profile channel permission denied.");
  }

  const message = await channel.messages.fetch(profile.publishedMessageId).catch((error) => {
    if (isMissingResourceError(error)) return null;
    throw error;
  });
  if (!message) {
    await clearPublishedProfileReference({ guildId: guild.id, userId: profile.userId });
    return { status: "missing", profile: withClearedPublication(profile) };
  }

  await message.edit({
    embeds: [buildPublicProfileEmbed({ profile, member })],
    allowedMentions: { parse: [] },
  });
  const updatedAt = new Date();
  await UserProfile.updateOne(
    { guildId: guild.id, userId: profile.userId },
    { $set: { publishedUpdatedAt: updatedAt } },
  );
  return { status: "updated", profile: { ...profile.toObject?.() ?? profile, publishedUpdatedAt: updatedAt } };
}

export async function publishProfile({ guild, member, profile, settings }) {
  if (profile.publishedChannelId && profile.publishedMessageId) {
    const refreshed = await refreshPublishedProfile({ guild, member, profile, settings });
    if (refreshed.status !== "unpublished") return refreshed;
  }

  const availability = await canPublishProfile({ guild, settings });
  if (!availability.ok) return { status: availability.reason, profile };

  const message = await availability.channel.send({
    embeds: [buildPublicProfileEmbed({ profile, member })],
    allowedMentions: { parse: [] },
  });
  const publishedAt = new Date();
  try {
    await UserProfile.updateOne(
      { guildId: guild.id, userId: profile.userId },
      { $set: { publishedChannelId: availability.channel.id, publishedMessageId: message.id, publishedAt, publishedUpdatedAt: publishedAt } },
    );
  } catch (error) {
    await message.delete().catch(() => null);
    const wrapped = new Error(`Public profile state save failed: ${summarizeProfileError(error)}`);
    wrapped.code = "PUBLIC_PROFILE_STATE_SAVE_FAILED";
    throw wrapped;
  }
  return { status: "published", profile: { ...profile.toObject?.() ?? profile, publishedChannelId: availability.channel.id, publishedMessageId: message.id, publishedAt, publishedUpdatedAt: publishedAt }, channel: availability.channel };
}

function isMissingResourceError(error) {
  return MISSING_RESOURCE_CODES.has(error?.code);
}

function withClearedPublication(profile) {
  return { ...profile.toObject?.() ?? profile, publishedChannelId: null, publishedMessageId: null, publishedAt: null, publishedUpdatedAt: null };
}
