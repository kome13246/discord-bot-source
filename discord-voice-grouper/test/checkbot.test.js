import test from "node:test";
import assert from "node:assert/strict";
import {
  ChannelType,
  PermissionFlagsBits,
  PermissionsBitField,
} from "discord.js";
import { commands, checkBotCommand } from "../src/commands.js";
import {
  CHECKBOT_STATUSES,
  createSettingsValidationService,
} from "../src/settings-validation-service.js";
import { createCheckbotFeature, buildCheckbotEmbeds, embedTextLength, totalEmbedTextLength } from "../src/features/checkbot.js";

const allPermissions = new PermissionsBitField([
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.Connect,
  PermissionFlagsBits.MoveMembers,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.ManageMessages,
  PermissionFlagsBits.MentionEveryone,
]);
const noMentionPermission = new PermissionsBitField([
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.Connect,
  PermissionFlagsBits.MoveMembers,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.ManageChannels,
]);
const noManageChannelsPermission = new PermissionsBitField([
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.Connect,
  PermissionFlagsBits.MoveMembers,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.MentionEveryone,
]);

function guildFixture({ channelFetch, roleFetch, channels = [], roles = [], botPermissions = allPermissions } = {}) {
  const channelCache = new Map(channels.map((channel) => [channel.id, channel]));
  const roleCache = new Map(roles.map((role) => [role.id, role]));
  const bot = {
    permissions: botPermissions,
    roles: { highest: { position: 10 } },
  };
  return {
    id: "guild-1",
    channels: {
      cache: channelCache,
      fetch: channelFetch ?? (async (id) => channelCache.get(id) ?? null),
    },
    roles: {
      cache: roleCache,
      fetch: roleFetch ?? (async (id) => roleCache.get(id) ?? null),
    },
    members: { me: bot, fetchMe: async () => bot },
  };
}

function textChannel(id, permissions = allPermissions) {
  return {
    id,
    guildId: "guild-1",
    type: ChannelType.GuildText,
    send: async () => ({ id: "message" }),
    permissionsFor: () => permissions,
  };
}

function categoryChannel(id, permissions = allPermissions) {
  return {
    id,
    guildId: "guild-1",
    type: ChannelType.GuildCategory,
    permissionsFor: () => permissions,
  };
}

function voiceChannel(id, permissions = allPermissions) {
  return {
    id,
    guildId: "guild-1",
    type: ChannelType.GuildVoice,
    permissionsFor: () => permissions,
  };
}

function role(id, position = 1, overrides = {}) {
  return {
    id,
    guildId: "guild-1",
    position,
    managed: false,
    editable: true,
    mentionable: true,
    ...overrides,
  };
}

test("/checkbot command requires ManageGuild and exposes every supported feature choice", () => {
  const json = checkBotCommand.toJSON();
  assert.equal(json.name, "checkbot");
  assert.equal(json.default_member_permissions, String(PermissionFlagsBits.ManageGuild));
  assert.equal(json.dm_permission, false);
  const option = json.options.find((item) => item.name === "feature");
  assert.deepEqual(option.choices.map((choice) => choice.value), [
    "all",
    "splitvc",
    "kokuchi",
    "callwait",
    "vc_dm",
    "forms",
    "profile",
    "voice_control",
    "status_board",
    "fukyo",
  ]);
  assert.ok(commands.some((command) => command.name === "checkbot"));
});

test("validator filters a single feature without running the other feature checks", async () => {
  const service = createSettingsValidationService();
  const result = await service.validateGuild({
    guild: guildFixture(),
    settings: {},
    feature: "kokuchi",
  });
  assert.equal(result.reports.length, 1);
  assert.equal(result.reports[0].feature, "kokuchi");
  assert.equal(result.reports[0].checks.some((check) => check.key.startsWith("splitvc.")), false);
});

test("all and every supported feature filter produce the expected reports", async () => {
  const service = createSettingsValidationService();
  const guild = guildFixture();
  const all = await service.validateGuild({ guild, settings: {}, feature: "all" });
  assert.deepEqual(all.reports.map((report) => report.feature), [
    "splitvc", "kokuchi", "callwait", "vc_dm", "forms", "profile", "voice_control", "status_board", "fukyo",
  ]);
  for (const feature of all.reports.map((report) => report.feature)) {
    const one = await service.validateGuild({ guild, settings: {}, feature });
    assert.deepEqual(one.reports.map((report) => report.feature), [feature]);
  }
});

test("fukyo validation checks enabled state, target channel, and effective send permissions", async () => {
  const service = createSettingsValidationService();
  const channel = textChannel("fukyo-channel");
  const guild = guildFixture({ channels: [channel] });
  const result = await service.validateGuild({
    guild,
    feature: "fukyo",
    settings: {
      guildId: "guild-1",
      fukyoWeeklyThemeEnabled: true,
      fukyoThemeChannelId: channel.id,
      fukyoThemes: [{ id: "theme-1", name: "theme", normalizedName: "theme" }],
    },
  });
  assert.equal(result.reports.length, 1);
  assert.equal(result.reports[0].feature, "fukyo");
  assert.equal(result.reports[0].checks.find((check) => check.key === "fukyo.enabled").status, CHECKBOT_STATUSES.OK);
  assert.equal(result.reports[0].checks.some((check) => check.key.startsWith("fukyo.themeChannel.permission.SendMessages")), true);
});

test("Discord unknown resources are missing, while temporary API failures are unknown", async () => {
  const settings = { splitMode: "direct", childCategoryId: "missing-category" };
  const missingService = createSettingsValidationService();
  const missingGuild = guildFixture({ channelFetch: async () => {
    const error = new Error("Unknown Channel");
    error.code = 10003;
    throw error;
  } });
  const missing = await missingService.validateGuild({ guild: missingGuild, settings, feature: "splitvc" });
  const missingCheck = missing.reports[0].checks.find((check) => check.key === "splitvc.childCategory");
  assert.equal(missingCheck.status, CHECKBOT_STATUSES.ERROR);
  assert.equal(missingCheck.reason, "resource-missing");

  const unknownGuild = guildFixture({ channelFetch: async () => {
    const error = new Error("Discord API unavailable");
    error.status = 503;
    throw error;
  } });
  const unknown = await missingService.validateGuild({ guild: unknownGuild, settings, feature: "splitvc" });
  const unknownCheck = unknown.reports[0].checks.find((check) => check.key === "splitvc.childCategory");
  assert.equal(unknownCheck.status, CHECKBOT_STATUSES.UNKNOWN);
});

test("role hierarchy, managed/editable, and mentionability are independently diagnosed", async () => {
  const target = role("participant", 12, { editable: false, mentionable: false });
  const guild = guildFixture({ roles: [target] });
  const service = createSettingsValidationService();
  const result = await service.validateGuild({
    guild,
    settings: { splitMode: "direct", tempRoleId: target.id },
    feature: "splitvc",
  });
  const checks = result.reports[0].checks;
  assert.equal(checks.find((check) => check.key === "splitvc.participantRole.editable").status, CHECKBOT_STATUSES.ERROR);
  assert.equal(checks.find((check) => check.key === "splitvc.participantRole.mentionable").status, CHECKBOT_STATUSES.WARNING);

  const managedGuild = guildFixture({ roles: [role("managed", 1, { managed: true })] });
  const managed = await service.validateGuild({ guild: managedGuild, settings: { tempRoleId: "managed" }, feature: "splitvc" });
  assert.equal(managed.reports[0].checks.find((check) => check.key === "splitvc.participantRole.editable").reason, "managed-role");
});

test("mentionability and the target channel determine the final mention capability", async () => {
  const announcement = textChannel("announcement", noMentionPermission);
  const gathering = voiceChannel("gathering", allPermissions);
  const mentionableRole = role("mentionable", 1, { mentionable: true });
  const guild = guildFixture({ channels: [announcement, gathering], roles: [mentionableRole] });
  const service = createSettingsValidationService();
  const mentionable = await service.validateGuild({
    guild,
    settings: {
      kokuchiAnnouncementChannelId: announcement.id,
      gatheringVoiceChannelId: gathering.id,
      kokuchiMentionRoleIds: [mentionableRole.id],
    },
    feature: "kokuchi",
  });
  assert.equal(mentionable.reports[0].checks.find((check) => check.key === "kokuchi.mentionRole.mentionable.result").status, CHECKBOT_STATUSES.OK);

  const nonMentionableRole = role("non-mentionable", 1, { mentionable: false });
  const noMentionGuild = guildFixture({ channels: [announcement, gathering], roles: [nonMentionableRole] });
  const denied = await service.validateGuild({
    guild: noMentionGuild,
    settings: {
      kokuchiAnnouncementChannelId: announcement.id,
      gatheringVoiceChannelId: gathering.id,
      kokuchiMentionRoleIds: [nonMentionableRole.id],
    },
    feature: "kokuchi",
  });
  assert.equal(denied.reports[0].checks.find((check) => check.key === "kokuchi.mentionRole.non-mentionable.result").status, CHECKBOT_STATUSES.ERROR);

  const unknownPermissionChannel = {
    ...announcement,
    permissionsFor: () => null,
  };
  const unknownGuild = guildFixture({ channels: [unknownPermissionChannel, gathering], roles: [nonMentionableRole] });
  const unknown = await service.validateGuild({
    guild: unknownGuild,
    settings: {
      kokuchiAnnouncementChannelId: announcement.id,
      gatheringVoiceChannelId: gathering.id,
      kokuchiMentionRoleIds: [nonMentionableRole.id],
    },
    feature: "kokuchi",
  });
  assert.equal(unknown.reports[0].checks.find((check) => check.key === "kokuchi.mentionRole.non-mentionable.result").status, CHECKBOT_STATUSES.UNKNOWN);

  const apiUnknownGuild = guildFixture({
    channels: [gathering],
    roles: [nonMentionableRole],
    channelFetch: async (id) => {
      if (id === gathering.id) return gathering;
      const error = new Error("Discord temporarily unavailable");
      error.status = 503;
      throw error;
    },
  });
  const apiUnknown = await service.validateGuild({
    guild: apiUnknownGuild,
    settings: {
      kokuchiAnnouncementChannelId: announcement.id,
      gatheringVoiceChannelId: gathering.id,
      kokuchiMentionRoleIds: [nonMentionableRole.id],
    },
    feature: "kokuchi",
  });
  assert.equal(apiUnknown.reports[0].checks.find((check) => check.key === "kokuchi.mentionRole.non-mentionable.result").status, CHECKBOT_STATUSES.UNKNOWN);
});

test("kokuchi gathering VC is optional and only requires ManageChannels when configured", async () => {
  const announcement = textChannel("announcement", noManageChannelsPermission);
  const service = createSettingsValidationService();
  const settings = {
    kokuchiAnnouncementChannelId: announcement.id,
    kokuchiEventTime: "21:00",
    kokuchiEventTimeConfigured: true,
  };
  const noticeOnly = await service.validateGuild({
    guild: guildFixture({ channels: [announcement], botPermissions: noManageChannelsPermission }),
    settings,
    feature: "kokuchi",
  });
  const noticeOnlyChecks = noticeOnly.reports[0].checks;
  assert.equal(noticeOnlyChecks.find((check) => check.key === "kokuchi.gatheringVoice").status, CHECKBOT_STATUSES.WARNING);
  assert.equal(noticeOnlyChecks.find((check) => check.key === "kokuchi.guildPermission.ManageChannels").reason, "not-required");
  assert.equal(noticeOnlyChecks.some((check) => check.status === CHECKBOT_STATUSES.ERROR), false);

  const gathering = voiceChannel("gathering", allPermissions);
  const configuredWithoutManageChannels = await service.validateGuild({
    guild: guildFixture({ channels: [announcement, gathering], botPermissions: noManageChannelsPermission }),
    settings: { ...settings, gatheringVoiceChannelId: gathering.id },
    feature: "kokuchi",
  });
  const deniedChecks = configuredWithoutManageChannels.reports[0].checks;
  assert.equal(deniedChecks.find((check) => check.key === "kokuchi.guildPermission.ManageChannels").status, CHECKBOT_STATUSES.ERROR);

  const configuredWithManageChannels = await service.validateGuild({
    guild: guildFixture({ channels: [announcement, gathering], botPermissions: allPermissions }),
    settings: { ...settings, gatheringVoiceChannelId: gathering.id },
    feature: "kokuchi",
  });
  const allowedChecks = configuredWithManageChannels.reports[0].checks;
  assert.equal(allowedChecks.find((check) => check.key === "kokuchi.gatheringVoice").status, CHECKBOT_STATUSES.OK);
  assert.equal(allowedChecks.find((check) => check.key === "kokuchi.gatheringVoice.permission.ManageChannels").status, CHECKBOT_STATUSES.OK);
  assert.equal(allowedChecks.find((check) => check.key === "kokuchi.guildPermission.ManageChannels").status, CHECKBOT_STATUSES.OK);
});

test("checkbot validation is read-only and checks effective channel permissions", async () => {
  const calls = [];
  const channel = {
    ...textChannel("prompt"),
    send: async () => { calls.push("send"); },
    permissionsFor: () => allPermissions,
    edit: async () => { calls.push("channel.edit"); },
    delete: async () => { calls.push("channel.delete"); },
    permissionOverwrites: { edit: async () => { calls.push("permissionOverwrites.edit"); } },
  };
  const guild = guildFixture({ channels: [channel] });
  guild.channels.create = async () => { calls.push("channels.create"); };
  guild.roles.create = async () => { calls.push("roles.create"); };
  guild.roles.cache.set("participant", {
    ...role("participant"),
    edit: async () => { calls.push("role.edit"); },
    delete: async () => { calls.push("role.delete"); },
  });
  guild.members.me.roles.add = async () => { calls.push("member.roles.add"); };
  guild.members.me.roles.remove = async () => { calls.push("member.roles.remove"); };
  guild.members.me.voice = { setChannel: async () => { calls.push("voice.setChannel"); } };
  const service = createSettingsValidationService();
  const result = await service.validateGuild({
    guild,
    settings: { callWaitPromptChannelId: "prompt" },
    feature: "callwait",
  });
  assert.equal(calls.length, 0);
  assert.ok(result.reports[0].checks.some((check) => check.key === "callwait.promptChannel.permission.SendMessages" && check.status === CHECKBOT_STATUSES.OK));

  const responses = [];
  const feature = createCheckbotFeature({
    getGuildSettings: async () => ({ callWaitPromptChannelId: "prompt" }),
    validationService: service,
  });
  await feature.handleCheckbot({
    guild,
    guildId: guild.id,
    inGuild: () => true,
    memberPermissions: { has: (permission) => permission === PermissionFlagsBits.ManageGuild },
    options: { getString: () => "callwait" },
    deferReply: async (payload) => responses.push({ type: "defer", payload }),
    editReply: async (payload) => responses.push({ type: "edit", payload }),
  });
  assert.equal(responses[0].payload.flags, 64);
  assert.deepEqual(responses.at(-1).payload.allowedMentions, { parse: [] });
  assert.equal(calls.length, 0);
});

test("callwait notice requires ManageMessages but the prompt channel does not", async () => {
  const textOnly = new PermissionsBitField([
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks,
    PermissionFlagsBits.ReadMessageHistory,
  ]);
  const prompt = textChannel("prompt", textOnly);
  const notice = textChannel("notice", textOnly);
  const guild = guildFixture({ channels: [prompt, notice] });
  const service = createSettingsValidationService();
  const report = await service.validateGuild({
    guild,
    settings: { callWaitPromptChannelId: "prompt", callWaitNoticeChannelId: "notice" },
    feature: "callwait",
  });
  const checks = report.reports[0].checks;
  assert.equal(checks.find((check) => check.key === "callwait.noticeChannel.permission.ManageMessages")?.status, CHECKBOT_STATUSES.ERROR);
  assert.equal(checks.some((check) => check.key === "callwait.promptChannel.permission.ManageMessages"), false);

  const promptOnly = await service.validateGuild({
    guild: guildFixture({ channels: [prompt] }),
    settings: { callWaitPromptChannelId: "prompt" },
    feature: "callwait",
  });
  assert.equal(promptOnly.reports[0].checks.some((check) => check.key === "callwait.promptChannel.permission.ManageMessages"), false);
});

test("large checkbot output stays within Discord embed limits and preserves overflow fields", () => {
  const reports = Array.from({ length: 16 }, (_, featureIndex) => ({
    feature: `feature-${featureIndex}`,
    status: CHECKBOT_STATUSES.UNKNOWN,
    intentNotice: "Intent manual check",
    checks: Array.from({ length: 40 }, (_, checkIndex) => ({
      key: `feature-${featureIndex}-${checkIndex}`,
      label: `項目 ${featureIndex}-${checkIndex}`,
      status: CHECKBOT_STATUSES.UNKNOWN,
      detail: `詳細 ${"x".repeat(900)} ${featureIndex}-${checkIndex}`,
    })),
  }));
  const embeds = buildCheckbotEmbeds({ reports });
  assert.ok(embeds.length <= 10);
  assert.ok(totalEmbedTextLength(embeds) <= 6000);
  for (const embed of embeds) {
    assert.ok((embed.title ?? "").length <= 256);
    assert.ok((embed.description ?? "").length <= 4096);
    assert.ok((embed.footer?.text ?? "").length <= 2048);
    assert.ok(embed.fields.length <= 25);
    for (const field of embed.fields) {
      assert.ok(field.name.length <= 256);
      assert.ok(field.value.length <= 1024);
    }
    assert.ok(embedTextLength(embed) <= 6000);
  }
  const overflow = embeds.find((embed) => embed.title.includes("省略あり"));
  assert.ok(overflow);
  assert.match(overflow.description, /省略/);
  assert.ok(embeds.some((embed) => embed.fields.some((field) => field.value.includes("詳細"))));
});
