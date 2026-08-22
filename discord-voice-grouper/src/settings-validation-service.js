import {
  ChannelType,
  PermissionFlagsBits,
} from "discord.js";

/**
 * The settings validation used by /checkbot deliberately contains only
 * read-only operations.  In particular, this module never calls send(),
 * edit(), setPermissions(), role.edit(), or any of the voice state methods.
 */

export const CHECKBOT_FEATURES = Object.freeze([
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

export const CHECKBOT_STATUSES = Object.freeze({
  OK: "ok",
  WARNING: "warning",
  ERROR: "error",
  UNKNOWN: "unknown",
});

const STATUS_RANK = Object.freeze({
  [CHECKBOT_STATUSES.OK]: 0,
  [CHECKBOT_STATUSES.WARNING]: 1,
  [CHECKBOT_STATUSES.UNKNOWN]: 2,
  [CHECKBOT_STATUSES.ERROR]: 3,
});

const PERMISSION_NAMES = Object.freeze({
  ViewChannel: PermissionFlagsBits.ViewChannel,
  SendMessages: PermissionFlagsBits.SendMessages,
  EmbedLinks: PermissionFlagsBits.EmbedLinks,
  ReadMessageHistory: PermissionFlagsBits.ReadMessageHistory,
  Connect: PermissionFlagsBits.Connect,
  MoveMembers: PermissionFlagsBits.MoveMembers,
  ManageRoles: PermissionFlagsBits.ManageRoles,
  ManageChannels: PermissionFlagsBits.ManageChannels,
  ManageMessages: PermissionFlagsBits.ManageMessages,
  MentionEveryone: PermissionFlagsBits.MentionEveryone,
});

const TEXT_CHANNEL_TYPES = new Set([
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
]);
const VOICE_CHANNEL_TYPES = new Set([
  ChannelType.GuildVoice,
  ChannelType.GuildStageVoice,
]);

const TEXT_PERMISSIONS = Object.freeze([
  "ViewChannel",
  "SendMessages",
  "EmbedLinks",
  "ReadMessageHistory",
]);
const CALLWAIT_NOTICE_PERMISSIONS = Object.freeze([
  ...TEXT_PERMISSIONS,
  "ManageMessages",
]);
const VOICE_READ_PERMISSIONS = Object.freeze([
  "ViewChannel",
  "Connect",
]);
const VOICE_MOVE_PERMISSIONS = Object.freeze([
  "ViewChannel",
  "Connect",
  "MoveMembers",
]);
const VOICE_OPEN_PERMISSIONS = Object.freeze([
  "ViewChannel",
  "Connect",
  "MoveMembers",
  "ManageChannels",
]);
const CATEGORY_CREATE_PERMISSIONS = Object.freeze([
  "ViewChannel",
  "ManageChannels",
  "Connect",
  "MoveMembers",
]);
const VOICE_CONTROL_CATEGORY_PERMISSIONS = Object.freeze([
  "ViewChannel",
  "SendMessages",
  "EmbedLinks",
  "ReadMessageHistory",
  "ManageChannels",
]);

const STATUS_LABELS = Object.freeze({
  splitvc: "splitvc",
  kokuchi: "kokuchi",
  callwait: "callwait",
  vc_dm: "vc_dm",
  forms: "forms",
  profile: "profile",
  voice_control: "voice_control",
  status_board: "status_board",
  fukyo: "fukyo",
});

const permissionLabel = (name) => name.replaceAll(/([a-z])([A-Z])/g, "$1 $2");

function statusOf(checks) {
  return checks.reduce((worst, check) => (
    STATUS_RANK[check.status] > STATUS_RANK[worst] ? check.status : worst
  ), CHECKBOT_STATUSES.OK);
}

function normalizeFeature(feature) {
  if (typeof feature !== "string" || feature.trim() === "" || feature === "all") return "all";
  const value = feature.trim().toLowerCase();
  return CHECKBOT_FEATURES.includes(value) ? value : "all";
}

function errorText(error) {
  return String(error?.message ?? error ?? "unknown error").replace(/\s+/g, " ").slice(0, 300);
}

function identityOf(resource) {
  return resource?.guildId ?? resource?.guild?.id ?? resource?.guildID ?? null;
}

function looksLikeTextChannel(channel) {
  if (!channel) return false;
  if (TEXT_CHANNEL_TYPES.has(channel.type)) return true;
  if (typeof channel.type === "string" && /(?:text|announcement)/i.test(channel.type)) return true;
  // Test doubles and a few older discord.js objects expose the predicate but
  // omit type.  A thread is not considered a configured target here.
  return channel.type === undefined && channel.isTextBased?.() === true && !channel.isThread?.();
}

function looksLikeVoiceChannel(channel) {
  if (!channel) return false;
  if (VOICE_CHANNEL_TYPES.has(channel.type)) return true;
  if (typeof channel.type === "string" && /(?:voice|stage)/i.test(channel.type)) return true;
  return channel.type === undefined && channel.isVoiceBased?.() === true;
}

function looksLikeCategory(channel) {
  if (!channel) return false;
  if (channel.type === ChannelType.GuildCategory) return true;
  if (typeof channel.type === "string" && /category/i.test(channel.type)) return true;
  return channel.type === undefined && channel.isCategory?.() === true;
}

function hasPermission(permissionSet, permissionName) {
  if (!permissionSet) return null;
  const bit = PERMISSION_NAMES[permissionName] ?? permissionName;
  try {
    if (typeof permissionSet.has === "function") {
      if (permissionSet.has(bit)) return true;
      // Accommodate small test doubles and discord.js-compatible wrappers
      // which accept the symbolic permission name instead of the bit.
      return Boolean(permissionSet.has(permissionName));
    }
    // Small test doubles sometimes expose a Set of permission names.
    if (permissionSet instanceof Set) {
      return permissionSet.has(permissionName) || permissionSet.has(bit);
    }
    if (Array.isArray(permissionSet)) return permissionSet.includes(permissionName) || permissionSet.includes(bit);
  } catch {
    return null;
  }
  return null;
}

function addCheck(ctx, key, label, status, detail, extra = {}) {
  ctx.checks.push({
    key,
    label,
    status,
    severity: status === CHECKBOT_STATUSES.OK ? "healthy" : status,
    detail,
    ...extra,
  });
}

function addMissing(ctx, key, label, detail = `${label}が未設定です。`) {
  addCheck(ctx, key, label, CHECKBOT_STATUSES.WARNING, detail, { reason: "missing" });
}

function addSettingReadFailure(ctx, error) {
  addCheck(
    ctx,
    "settings",
    "GuildSettings",
    CHECKBOT_STATUSES.UNKNOWN,
    `設定を確認できませんでした。Discord権限不足とは判定していません: ${errorText(error)}`,
    { reason: "settings-fetch-failed" },
  );
}

function cacheGet(cache, id) {
  if (!cache || !id) return null;
  if (typeof cache.get === "function") return cache.get(id) ?? null;
  if (cache instanceof Map) return cache.get(id) ?? null;
  return cache[id] ?? null;
}

function makeContext({ guild, settings, settingsError, logger }) {
  return {
    guild,
    settings: settings ?? null,
    settingsError: settingsError ?? null,
    logger,
    checks: [],
    channels: new Map(),
    roles: new Map(),
    botMember: undefined,
    botMemberResolved: false,
    skipDisabledDependencies: false,
  };
}

/** Classify a Discord fetch error without treating a transient API failure as missing configuration. */
export function classifyDiscordFetchError(error, resourceType = "resource") {
  const code = Number(error?.code ?? error?.rawError?.code ?? error?.data?.code);
  const status = Number(error?.status ?? error?.statusCode ?? error?.rawError?.status);
  const message = String(error?.message ?? error ?? "").toLowerCase();
  const expectedUnknownCode = resourceType === "role"
    ? 10011
    : resourceType === "guild"
      ? 10004
      : resourceType === "message"
        ? 10008
        : 10003;
  if (code === expectedUnknownCode || code === 10003 || code === 10004 || code === 10008 || code === 10011 || status === 404) return "missing";
  if (message.includes("unknown channel") || message.includes("unknown role") || message.includes("unknown guild") || message.includes("unknown message")) return "missing";
  return "unknown";
}

export function isMissingDiscordResourceError(error, resourceType = "resource") {
  return classifyDiscordFetchError(error, resourceType) === "missing";
}

async function resolveChannel(ctx, id) {
  if (!id) return { state: "missing" };
  if (ctx.channels.has(id)) return ctx.channels.get(id);
  const cached = cacheGet(ctx.guild?.channels?.cache, id);
  if (cached) {
    const result = { state: "present", resource: cached, source: "cache" };
    ctx.channels.set(id, result);
    return result;
  }
  if (typeof ctx.guild?.channels?.fetch !== "function") {
    const result = { state: "unknown", error: new Error("Guild channel fetch is unavailable") };
    ctx.channels.set(id, result);
    return result;
  }
  try {
    const channel = await ctx.guild.channels.fetch(id);
    const result = channel
      ? { state: "present", resource: channel, source: "api" }
      : { state: "absent" };
    ctx.channels.set(id, result);
    return result;
  } catch (error) {
    const result = isMissingDiscordResourceError(error, "channel")
      ? { state: "absent", error }
      : { state: "unknown", error };
    ctx.channels.set(id, result);
    return result;
  }
}

async function resolveRole(ctx, id) {
  if (!id) return { state: "missing" };
  if (ctx.roles.has(id)) return ctx.roles.get(id);
  const cached = cacheGet(ctx.guild?.roles?.cache, id);
  if (cached) {
    const result = { state: "present", resource: cached, source: "cache" };
    ctx.roles.set(id, result);
    return result;
  }
  if (typeof ctx.guild?.roles?.fetch !== "function") {
    const result = { state: "unknown", error: new Error("Guild role fetch is unavailable") };
    ctx.roles.set(id, result);
    return result;
  }
  try {
    const role = await ctx.guild.roles.fetch(id);
    const result = role
      ? { state: "present", resource: role, source: "api" }
      : { state: "absent" };
    ctx.roles.set(id, result);
    return result;
  } catch (error) {
    const result = isMissingDiscordResourceError(error, "role")
      ? { state: "absent", error }
      : { state: "unknown", error };
    ctx.roles.set(id, result);
    return result;
  }
}

async function getBotMember(ctx) {
  if (ctx.botMemberResolved) return ctx.botMember;
  ctx.botMemberResolved = true;
  const cached = ctx.guild?.members?.me;
  if (cached) {
    ctx.botMember = cached;
    return cached;
  }
  if (typeof ctx.guild?.members?.fetchMe !== "function") return null;
  try {
    ctx.botMember = await ctx.guild.members.fetchMe();
  } catch (error) {
    ctx.botMember = { __checkbotFetchError: error };
  }
  return ctx.botMember;
}

async function effectivePermissions(ctx, channel) {
  const botMember = await getBotMember(ctx);
  if (!botMember || botMember.__checkbotFetchError) return { state: "unknown", botMember };
  if (typeof channel?.permissionsFor !== "function") {
    // Guild-level permissions are still useful for a test double and for
    // channels that intentionally omit a permissionsFor implementation.  A
    // real discord.js channel always provides the method.
    return botMember.permissions ? { state: "present", permissions: botMember.permissions } : { state: "unknown", botMember };
  }
  try {
    const permissions = channel.permissionsFor(botMember);
    return permissions ? { state: "present", permissions } : { state: "unknown", botMember };
  } catch (error) {
    return { state: "unknown", botMember, error };
  }
}

function checkGuildIdentity(ctx, resource, label) {
  const resourceGuildId = identityOf(resource);
  if (resourceGuildId && resourceGuildId !== ctx.guild?.id) {
    return {
      status: CHECKBOT_STATUSES.ERROR,
      detail: `${label}は別のサーバーに属しています。`,
      reason: "guild-mismatch",
    };
  }
  return null;
}

async function checkChannel(ctx, {
  key,
  label,
  id,
  kind,
  permissions = [],
  required = true,
  mention = false,
  channelTypes = null,
}) {
  if (!id) {
    if (required) addMissing(ctx, key, label);
    return null;
  }
  const resolved = await resolveChannel(ctx, id);
  if (resolved.state === "unknown") {
    addCheck(ctx, key, label, CHECKBOT_STATUSES.UNKNOWN, `${label}をDiscord APIで確認できませんでした。権限不足とは断定していません: ${errorText(resolved.error)}`, { reason: "fetch-failed", id });
    return null;
  }
  if (resolved.state !== "present") {
    addCheck(ctx, key, label, CHECKBOT_STATUSES.ERROR, `${label}（${id}）が見つかりません。`, { reason: "resource-missing", id });
    return null;
  }
  const channel = resolved.resource;
  const identityIssue = checkGuildIdentity(ctx, channel, label);
  if (identityIssue) {
    addCheck(ctx, key, label, identityIssue.status, identityIssue.detail, { reason: identityIssue.reason, id });
    return null;
  }
  const typeOk = kind === "text"
    ? (Array.isArray(channelTypes) && channelTypes.length > 0
      ? channelTypes.includes(channel.type)
      : looksLikeTextChannel(channel))
    : kind === "voice"
      ? looksLikeVoiceChannel(channel)
      : kind === "category"
        ? looksLikeCategory(channel)
        : true;
  if (!typeOk) {
    addCheck(ctx, key, label, CHECKBOT_STATUSES.ERROR, `${label}の種別が想定と異なります。`, { reason: "wrong-type", id });
    return null;
  }
  if (kind === "text" && channel.send !== undefined && typeof channel.send !== "function") {
    addCheck(ctx, key, label, CHECKBOT_STATUSES.ERROR, `${label}は送信可能なテキストチャンネルではありません。`, { reason: "not-sendable", id });
    return null;
  }
  addCheck(ctx, key, label, CHECKBOT_STATUSES.OK, `${label}を確認しました。`, { reason: "present", id, source: resolved.source });

  if (permissions.length > 0) {
    const permissionResult = await effectivePermissions(ctx, channel);
    for (const permissionName of permissions) {
      if (permissionResult.state !== "present") {
        addCheck(ctx, `${key}.permission.${permissionName}`, `${label} / ${permissionLabel(permissionName)}`, CHECKBOT_STATUSES.UNKNOWN, `${label}に対するBotの実効権限を確認できませんでした。権限不足とは断定していません。`, { reason: "effective-permissions-unknown", permission: permissionName, id });
        continue;
      }
      const allowed = hasPermission(permissionResult.permissions, permissionName);
      if (allowed === null) {
        addCheck(ctx, `${key}.permission.${permissionName}`, `${label} / ${permissionLabel(permissionName)}`, CHECKBOT_STATUSES.UNKNOWN, `Botの${permissionLabel(permissionName)}実効権限を判定できませんでした。`, { reason: "permission-unreadable", permission: permissionName, id });
      } else if (allowed) {
        addCheck(ctx, `${key}.permission.${permissionName}`, `${label} / ${permissionLabel(permissionName)}`, CHECKBOT_STATUSES.OK, `Botに${permissionLabel(permissionName)}があります。`, { reason: "permission-granted", permission: permissionName, id });
      } else {
        addCheck(ctx, `${key}.permission.${permissionName}`, `${label} / ${permissionLabel(permissionName)}`, CHECKBOT_STATUSES.ERROR, `Botに${permissionLabel(permissionName)}がありません。`, { reason: "permission-denied", permission: permissionName, id });
      }
    }
  }
  return channel;
}

async function checkRole(ctx, {
  key,
  label,
  id,
  assign = false,
  mention = false,
  required = true,
}) {
  if (!id) {
    if (required) addMissing(ctx, key, label);
    return null;
  }
  const resolved = await resolveRole(ctx, id);
  if (resolved.state === "unknown") {
    addCheck(ctx, key, label, CHECKBOT_STATUSES.UNKNOWN, `${label}をDiscord APIで確認できませんでした。権限不足とは断定していません: ${errorText(resolved.error)}`, { reason: "fetch-failed", id });
    return null;
  }
  if (resolved.state !== "present") {
    addCheck(ctx, key, label, CHECKBOT_STATUSES.ERROR, `${label}（${id}）が見つかりません。`, { reason: "resource-missing", id });
    return null;
  }
  const role = resolved.resource;
  const identityIssue = checkGuildIdentity(ctx, role, label);
  if (identityIssue) {
    addCheck(ctx, key, label, identityIssue.status, identityIssue.detail, { reason: identityIssue.reason, id });
    return null;
  }
  addCheck(ctx, key, label, CHECKBOT_STATUSES.OK, `${label}を確認しました。`, { reason: "present", id, source: resolved.source });

  if (role.managed === true || role.id === ctx.guild?.id) {
    addCheck(ctx, `${key}.editable`, `${label} / managed`, CHECKBOT_STATUSES.ERROR, `${label}はBotが付与・操作できないmanagedロールまたは@everyoneです。`, { reason: "managed-role", id });
  } else if (assign) {
    const botMember = await getBotMember(ctx);
    if (botMember?.__checkbotFetchError || !botMember) {
      addCheck(ctx, `${key}.editable`, `${label} / hierarchy`, CHECKBOT_STATUSES.UNKNOWN, `${label}とBotのロール階層を確認できませんでした。`, { reason: "bot-member-unknown", id });
    } else {
      const highest = botMember.roles?.highest ?? botMember.roles?.cache?.sort?.()?.first?.();
      const highestPosition = Number(highest?.position ?? botMember.roles?.highest?.position);
      const rolePosition = Number(role.position);
      if (role.editable === false || (Number.isFinite(rolePosition) && Number.isFinite(highestPosition) && rolePosition >= highestPosition)) {
        addCheck(ctx, `${key}.editable`, `${label} / hierarchy`, CHECKBOT_STATUSES.ERROR, `${label}はBotの最上位ロールより下に置かれていないため操作できません。`, { reason: "role-hierarchy", id });
      } else if (role.editable === true || (Number.isFinite(rolePosition) && Number.isFinite(highestPosition))) {
        addCheck(ctx, `${key}.editable`, `${label} / hierarchy`, CHECKBOT_STATUSES.OK, `${label}はBotから操作できるロール階層です。`, { reason: "role-editable", id });
      } else {
        addCheck(ctx, `${key}.editable`, `${label} / hierarchy`, CHECKBOT_STATUSES.UNKNOWN, `${label}のeditable・ロール階層を確認できませんでした。`, { reason: "role-hierarchy-unknown", id });
      }
    }
    const botMemberForPermission = await getBotMember(ctx);
    const manageRoles = hasPermission(botMemberForPermission?.permissions, "ManageRoles");
    addCheck(ctx, `${key}.permission.ManageRoles`, `${label} / ManageRoles`, manageRoles === true ? CHECKBOT_STATUSES.OK : manageRoles === false ? CHECKBOT_STATUSES.ERROR : CHECKBOT_STATUSES.UNKNOWN, manageRoles === true ? "BotにManageRolesがあります。" : manageRoles === false ? "BotにManageRolesがありません。" : "BotのManageRolesを確認できませんでした。", { reason: manageRoles === true ? "permission-granted" : manageRoles === false ? "permission-denied" : "permission-unreadable", permission: "ManageRoles", id });
  }
  if (mention) {
    if (role.mentionable === true) addCheck(ctx, `${key}.mentionable`, `${label} / mentionable`, CHECKBOT_STATUSES.OK, `${label}はメンション可能です。`, { reason: "mentionable", id });
    else if (role.mentionable === false) addCheck(ctx, `${key}.mentionable`, `${label} / mentionable`, CHECKBOT_STATUSES.WARNING, `${label}はメンション不可です。`, { reason: "not-mentionable", id });
    else addCheck(ctx, `${key}.mentionable`, `${label} / mentionable`, CHECKBOT_STATUSES.UNKNOWN, `${label}のメンション可否を確認できませんでした。`, { reason: "mentionability-unknown", id });
  }
  return role;
}

function uniqueIds(values) {
  return [...new Set((values ?? []).filter((value) => typeof value === "string" && value.length > 0))];
}

/**
 * Discord permits a bot to mention a role without MentionEveryone when the
 * role itself is mentionable.  MentionEveryone is only required for a
 * non-mentionable role, so this final capability check intentionally combines
 * the role state with each real message destination.
 */
async function checkMentionCapability(ctx, {
  key,
  label,
  roleId,
  channelIds,
}) {
  if (!roleId) return;
  const roleResult = await resolveRole(ctx, roleId);
  if (roleResult.state === "unknown") {
    addCheck(ctx, `${key}.result`, `${label} / メンション可否`, CHECKBOT_STATUSES.UNKNOWN, `${label}を確認できないため、メンション可否を判定できません。権限不足とは断定していません: ${errorText(roleResult.error)}`, { reason: "role-fetch-unknown", roleId });
    return;
  }
  if (roleResult.state !== "present") {
    addCheck(ctx, `${key}.result`, `${label} / メンション可否`, CHECKBOT_STATUSES.ERROR, `${label}が見つからないため、メンションできません。`, { reason: "role-missing", roleId });
    return;
  }
  const role = roleResult.resource;
  const roleGuildIssue = checkGuildIdentity(ctx, role, label);
  if (roleGuildIssue) {
    addCheck(ctx, `${key}.result`, `${label} / メンション可否`, roleGuildIssue.status, roleGuildIssue.detail, { reason: roleGuildIssue.reason, roleId });
    return;
  }
  const roleIsMentionable = role.mentionable === true;
  if (!roleIsMentionable && role.mentionable !== false) {
    addCheck(ctx, `${key}.result`, `${label} / メンション可否`, CHECKBOT_STATUSES.UNKNOWN, "ロールのmentionable状態を確認できないため、メンション可否を判定できません。", { reason: "mentionability-unknown", roleId });
    return;
  }

  const destinations = uniqueIds(channelIds);
  if (destinations.length === 0) {
    addCheck(ctx, `${key}.result`, `${label} / メンション可否`, CHECKBOT_STATUSES.UNKNOWN, "ロールの送信先チャンネルが特定できないため、MentionEveryoneを確認できません。", { reason: "mention-destination-unknown", roleId });
    return;
  }
  const destinationStatuses = [];
  for (const channelId of destinations) {
    const channelResult = await resolveChannel(ctx, channelId);
    let status = CHECKBOT_STATUSES.OK;
    let detail = "";
    let reason = "mention-permission-granted";
    if (channelResult.state === "unknown") {
      status = CHECKBOT_STATUSES.UNKNOWN;
      reason = "channel-fetch-unknown";
      detail = `送信先チャンネル（${channelId}）を確認できないため、MentionEveryoneを判定できません。権限不足とは断定していません: ${errorText(channelResult.error)}`;
    } else if (channelResult.state !== "present") {
      status = CHECKBOT_STATUSES.ERROR;
      reason = "channel-missing";
      detail = `送信先チャンネル（${channelId}）が見つからないため、メンションできません。`;
    } else {
      const channel = channelResult.resource;
      const guildIssue = checkGuildIdentity(ctx, channel, "メンション送信先");
      if (guildIssue) {
        status = guildIssue.status;
        reason = guildIssue.reason;
        detail = guildIssue.detail;
      } else if (!looksLikeTextChannel(channel)) {
        status = CHECKBOT_STATUSES.ERROR;
        reason = "channel-wrong-type";
        detail = `送信先（${channelId}）がテキストチャンネルではありません。`;
      } else {
        const permissionResult = await effectivePermissions(ctx, channel);
        if (permissionResult.state !== "present") {
          status = CHECKBOT_STATUSES.UNKNOWN;
          reason = "mention-permission-unknown";
          detail = `送信先（${channelId}）のBot実効MentionEveryoneを確認できません。権限不足とは断定していません。`;
        } else {
          const canView = hasPermission(permissionResult.permissions, "ViewChannel");
          const canSend = hasPermission(permissionResult.permissions, "SendMessages");
          if (canView === null || canSend === null) {
            status = CHECKBOT_STATUSES.UNKNOWN;
            reason = "send-permission-unreadable";
            detail = `送信先（${channelId}）のBot実効送信権限を判定できません。`;
          } else if (!canView || !canSend) {
            status = CHECKBOT_STATUSES.ERROR;
            reason = "send-permission-denied";
            detail = `送信先（${channelId}）でBotに閲覧または送信権限がないため、メンションできません。`;
          } else if (roleIsMentionable) {
            status = CHECKBOT_STATUSES.OK;
            reason = "mentionable-role";
            detail = `ロールがメンション可能で、送信先（${channelId}）へ送信できます。MentionEveryoneは不要です。`;
          } else {
            const allowed = hasPermission(permissionResult.permissions, "MentionEveryone");
            if (allowed === true) {
              status = CHECKBOT_STATUSES.OK;
              reason = "mention-permission-granted";
              detail = `送信先（${channelId}）でBotにMentionEveryoneがあります。`;
            } else if (allowed === false) {
              status = CHECKBOT_STATUSES.ERROR;
              reason = "mention-permission-denied";
              detail = `送信先（${channelId}）でBotにMentionEveryoneがないため、mentionable=falseのロールをメンションできません。`;
            } else {
              status = CHECKBOT_STATUSES.UNKNOWN;
              reason = "mention-permission-unreadable";
              detail = `送信先（${channelId}）のBot実効MentionEveryoneを判定できません。`;
            }
          }
        }
      }
    }
    destinationStatuses.push(status);
    addCheck(ctx, `${key}.destination.${channelId}`, `${label} / メンション送信先`, status, detail, { reason, roleId, channelId, permission: "MentionEveryone" });
  }
  const finalStatus = destinationStatuses.includes(CHECKBOT_STATUSES.ERROR)
    ? CHECKBOT_STATUSES.ERROR
    : destinationStatuses.includes(CHECKBOT_STATUSES.UNKNOWN)
      ? CHECKBOT_STATUSES.UNKNOWN
      : CHECKBOT_STATUSES.OK;
  addCheck(ctx, `${key}.result`, `${label} / メンション可否`, finalStatus, finalStatus === CHECKBOT_STATUSES.OK
    ? "すべての送信先でメンション可能です。"
    : finalStatus === CHECKBOT_STATUSES.ERROR
      ? "1つ以上の送信先でメンションできません。"
      : "送信先または実効権限が不明なため、メンション可否を確定できません。", { reason: `mention-${finalStatus}`, roleId });
}

function roleIdsFrom(settings, arrayKey, singularKeys = []) {
  const array = Array.isArray(settings?.[arrayKey]) ? settings[arrayKey] : [];
  const singular = singularKeys.map((key) => settings?.[key]).filter(Boolean);
  return [...new Set([...array, ...singular].filter((id) => typeof id === "string" && id.length > 0))];
}

function announcementChannelId(settings) {
  return settings?.kokuchiAnnouncementChannelId
    ?? settings?.wadaiChannelId
    ?? settings?.splitStartChannelId
    ?? null;
}

async function validateSplitvc(ctx) {
  const settings = ctx.settings ?? {};
  addCheck(ctx, "splitvc.mode", "VC作成方式", CHECKBOT_STATUSES.OK, settings.splitMode === "partybeast" ? "PB互換モードです。" : "Bot直接作成モードです。", { reason: "configured", value: settings.splitMode ?? "direct" });
  await checkRole(ctx, { key: "splitvc.participantRole", label: "splitvc参加者ロール", id: settings.tempRoleId ?? settings.participantRoleId, assign: true, mention: true });
  if ((settings.splitMode ?? "direct") === "partybeast") {
    await checkChannel(ctx, { key: "splitvc.parentChannel", label: "splitvc PB親VC", id: settings.parentChannelId, kind: "voice", permissions: VOICE_MOVE_PERMISSIONS });
  } else if (settings.parentChannelId) {
    await checkChannel(ctx, { key: "splitvc.parentChannel", label: "splitvc PB親VC（任意）", id: settings.parentChannelId, kind: "voice", permissions: VOICE_MOVE_PERMISSIONS, required: false });
  } else {
    addCheck(ctx, "splitvc.parentChannel", "splitvc PB親VC", CHECKBOT_STATUSES.OK, "直接作成モードではPB親VCは使用しません。", { reason: "not-required" });
  }
  await checkChannel(ctx, { key: "splitvc.childCategory", label: "splitvc子VCカテゴリ", id: settings.childCategoryId, kind: "category", permissions: CATEGORY_CREATE_PERMISSIONS, required: (settings.splitMode ?? "direct") === "direct" });
  if (settings.waitingVcCategoryId) {
    await checkChannel(ctx, { key: "splitvc.waitingVcCategory", label: "splitvc待機VCカテゴリ", id: settings.waitingVcCategoryId, kind: "category", permissions: CATEGORY_CREATE_PERMISSIONS, required: false });
  } else {
    addMissing(ctx, "splitvc.waitingVcCategory", "splitvc待機VCカテゴリ", "途中参加用待機VCカテゴリが未設定です（必要な運用では設定してください）。");
  }
  const textTargets = [
    ["splitFeedbackChannelId", "splitvc終了後フィードバック先"],
    ["voiceReminderChannelId", "VC集合リマインダー先"],
    ["voiceTopicChannelId", "VC話題投稿先"],
    ["postSplitWadaiChannelId", "splitvc後話題投稿先"],
    ["kokuchiAnnouncementChannelId", "kokuchi告知・開始案内先"],
    ["wadaiChannelId", "話題・告知投稿先"],
    ["splitStartChannelId", "splitvc開始案内先"],
  ];
  const seen = new Set();
  for (const [field, label] of textTargets) {
    const id = settings[field];
    if (id && !seen.has(id)) {
      seen.add(id);
      await checkChannel(ctx, { key: `splitvc.${field}`, label, id, kind: "text", permissions: TEXT_PERMISSIONS, required: false });
    } else if (!id) addMissing(ctx, `splitvc.${field}`, label, `${label}が未設定です。`);
  }
  await checkMentionCapability(ctx, {
    key: "splitvc.participantRole.mention",
    label: "splitvc参加者ロール",
    roleId: settings.tempRoleId ?? settings.participantRoleId,
    channelIds: [
      settings.postSplitWadaiChannelId,
      settings.kokuchiAnnouncementChannelId,
      settings.wadaiChannelId,
      settings.splitStartChannelId,
      settings.voiceReminderChannelId,
      settings.voiceTopicChannelId,
    ],
  });
  await checkBotGuildPermission(ctx, "splitvc", "MoveMembers");
  await checkBotGuildPermission(ctx, "splitvc", "ManageRoles");
}

async function validateKokuchi(ctx) {
  const settings = ctx.settings ?? {};
  const announcement = announcementChannelId(settings);
  await checkChannel(ctx, { key: "kokuchi.announcement", label: "kokuchi告知・開始案内先", id: announcement, kind: "text", permissions: TEXT_PERMISSIONS });
  await checkChannel(ctx, { key: "kokuchi.overview", label: "kokuchi概要案内先", id: settings.kokuchiOverviewChannelId, kind: "text", permissions: TEXT_PERMISSIONS, required: false });
  if (settings.gatheringVoiceChannelId) {
    await checkChannel(ctx, { key: "kokuchi.gatheringVoice", label: "kokuchi集合VC", id: settings.gatheringVoiceChannelId, kind: "voice", permissions: VOICE_OPEN_PERMISSIONS, required: true });
  } else {
    addMissing(ctx, "kokuchi.gatheringVoice", "kokuchi集合VC", "集合VCは任意設定です。告知のみの運用では設定不要です。");
  }
  const mentionRoles = roleIdsFrom(settings, "kokuchiMentionRoleIds", ["kokuchiMentionRoleId", "kokuchiGatheringReminderRoleId"]);
  if (mentionRoles.length === 0) addMissing(ctx, "kokuchi.mentionRoles", "kokuchi告知メンションロール", "告知メンションロールが未設定です（任意）。");
  const kokuchiMentionDestinations = [announcement, settings.kokuchiGatheringReminderChannelId ?? announcement];
  for (const id of mentionRoles) {
    await checkRole(ctx, { key: `kokuchi.mentionRole.${id}`, label: "kokuchi告知メンションロール", id, mention: true, required: false });
    await checkMentionCapability(ctx, {
      key: `kokuchi.mentionRole.${id}`,
      label: "kokuchi告知メンションロール",
      roleId: id,
      channelIds: kokuchiMentionDestinations,
    });
  }
  if (settings.kokuchiEventTimeConfigured === false) addCheck(ctx, "kokuchi.eventTime", "kokuchi開催時刻", CHECKBOT_STATUSES.WARNING, "開催時刻が明示設定されていません。互換デフォルト時刻が使われます。", { reason: "defaulted" });
  else if (settings.kokuchiEventTime) addCheck(ctx, "kokuchi.eventTime", "kokuchi開催時刻", CHECKBOT_STATUSES.OK, `開催時刻 ${settings.kokuchiEventTime} を確認しました。`, { reason: "configured" });
  else addMissing(ctx, "kokuchi.eventTime", "kokuchi開催時刻");
  if (settings.gatheringVoiceChannelId) {
    await checkBotGuildPermission(ctx, "kokuchi", "ManageChannels");
  } else {
    addCheck(ctx, "kokuchi.guildPermission.ManageChannels", "Botギルド権限 / Manage Channels", CHECKBOT_STATUSES.OK, "集合VCが未設定の告知のみ運用では、集合VCの開閉に必要なManageChannelsは不要です。", { reason: "not-required", permission: "ManageChannels" });
  }
}

async function validateCallwait(ctx) {
  const settings = ctx.settings ?? {};
  if (settings.callWaitEnabled === true) addCheck(ctx, "callwait.enabled", "callwait有効状態", CHECKBOT_STATUSES.OK, "通話待機システムは有効です。", { reason: "enabled" });
  else {
    // A rollback which disables callwait is safe even when its former
    // dependencies have already been removed.  Keep the explicit warning,
    // but do not turn those intentionally inactive resources into errors.
    addCheck(ctx, "callwait.enabled", "callwait有効状態", CHECKBOT_STATUSES.WARNING, "通話待機システムは無効または未設定です。", { reason: "disabled" });
    if (ctx.skipDisabledDependencies) {
      addCheck(ctx, "callwait.disabledSafe", "callwait無効化", CHECKBOT_STATUSES.OK, "無効化されたcallwaitの依存先は検査対象外です。", { reason: "disabled-safe" });
      return;
    }
  }
  await checkRole(ctx, { key: "callwait.role", label: "callwait参加希望者ロール", id: settings.callWaitRoleId, assign: true, mention: true });
  await checkChannel(ctx, { key: "callwait.promptChannel", label: "callwait募集先", id: settings.callWaitPromptChannelId, kind: "text", permissions: TEXT_PERMISSIONS });
  await checkChannel(ctx, { key: "callwait.noticeChannel", label: "callwait通知先", id: settings.callWaitNoticeChannelId, kind: "text", permissions: CALLWAIT_NOTICE_PERMISSIONS });
  await checkChannel(ctx, { key: "callwait.voiceCategory", label: "callwait参加確認VCカテゴリ", id: settings.callWaitVoiceCategoryId, kind: "category", permissions: VOICE_READ_PERMISSIONS, required: false });
  if (settings.bosyuMentionRoleId) {
    await checkRole(ctx, { key: "callwait.mentionRole", label: "callwait募集通知ロール", id: settings.bosyuMentionRoleId, mention: true, required: false });
    await checkMentionCapability(ctx, {
      key: "callwait.mentionRole",
      label: "callwait募集通知ロール",
      roleId: settings.bosyuMentionRoleId,
      channelIds: [settings.callWaitNoticeChannelId],
    });
  }
  else addMissing(ctx, "callwait.mentionRole", "callwait募集通知ロール", "募集通知ロールは未設定です（任意）。");
  const interval = Number(settings.callWaitIntervalMinutes);
  if ([30, 45, 60].includes(interval)) addCheck(ctx, "callwait.interval", "callwait募集間隔", CHECKBOT_STATUSES.OK, `${interval}分を確認しました。`, { reason: "configured" });
  else addCheck(ctx, "callwait.interval", "callwait募集間隔", CHECKBOT_STATUSES.WARNING, "募集間隔が未設定または不正です。", { reason: "invalid" });
  await checkMentionCapability(ctx, {
    key: "callwait.role.mention",
    label: "callwait参加希望者ロール",
    roleId: settings.callWaitRoleId,
    channelIds: [settings.callWaitNoticeChannelId],
  });
  await checkBotGuildPermission(ctx, "callwait", "ManageRoles");
}

async function validateVcDm(ctx) {
  const settings = ctx.settings ?? {};
  if (settings.vcDmEnabled === true) addCheck(ctx, "vc_dm.enabled", "vc_dm有効状態", CHECKBOT_STATUSES.OK, "VC未参加・長期不参加者向けDMは有効です。", { reason: "enabled" });
  else {
    addCheck(ctx, "vc_dm.enabled", "vc_dm有効状態", CHECKBOT_STATUSES.WARNING, "vc_dmは無効または未設定です。", { reason: "disabled" });
    if (ctx.skipDisabledDependencies) {
      addCheck(ctx, "vc_dm.disabledSafe", "vc_dm無効化", CHECKBOT_STATUSES.OK, "無効化されたvc_dmの依存先は検査対象外です。", { reason: "disabled-safe" });
      return;
    }
  }
  await checkChannel(ctx, { key: "vc_dm.panelChannel", label: "vc_dm対象確認パネル先", id: settings.vcDmPanelChannelId, kind: "text", permissions: TEXT_PERMISSIONS });
  const hasExplicitChannels = Array.isArray(settings.vcDmTargetChannelIds) && settings.vcDmTargetChannelIds.length > 0;
  await checkChannel(ctx, { key: "vc_dm.targetCategory", label: "vc_dm対象VCカテゴリ", id: settings.vcDmTargetCategoryId, kind: "category", permissions: VOICE_READ_PERMISSIONS, required: !hasExplicitChannels });
  if (hasExplicitChannels) {
    for (const id of settings.vcDmTargetChannelIds) await checkChannel(ctx, { key: `vc_dm.targetChannel.${id}`, label: "vc_dm対象VC", id, kind: "voice", permissions: VOICE_READ_PERMISSIONS, required: false });
  } else if (!settings.vcDmTargetCategoryId) {
    addMissing(ctx, "vc_dm.targets", "vc_dm対象VC", "対象VCカテゴリまたは個別VCが未設定です。");
  }
  for (const id of Array.isArray(settings.vcDmExcludedCategoryIds) ? settings.vcDmExcludedCategoryIds : []) {
    await checkChannel(ctx, { key: `vc_dm.excludedCategory.${id}`, label: "vc_dm対象外VCカテゴリ", id, kind: "category", permissions: [], required: false });
  }
  for (const id of Array.isArray(settings.vcDmExcludedChannelIds) ? settings.vcDmExcludedChannelIds : []) {
    await checkChannel(ctx, { key: `vc_dm.excludedChannel.${id}`, label: "vc_dm対象外VC", id, kind: "voice", permissions: [], required: false });
  }
  addCheck(ctx, "vc_dm.dmDelivery", "DM送信可否", CHECKBOT_STATUSES.UNKNOWN, "DM送信可否（受信設定・ブロック等）はDiscord API上で事前確定できません。実送信は行わず、手動確認してください。", { reason: "dm-uncheckable" });
  await checkBotGuildPermission(ctx, "vc_dm", "ViewChannel");
}

async function validateForms(ctx) {
  const settings = ctx.settings ?? {};
  await checkChannel(ctx, { key: "forms.formChannel", label: "フォーム設置先", id: settings.formChannelId, kind: "text", permissions: TEXT_PERMISSIONS });
  await checkChannel(ctx, { key: "forms.formSendChannel", label: "フォーム転送先", id: settings.formSendChannelId, kind: "text", permissions: TEXT_PERMISSIONS });
  await checkChannel(ctx, { key: "forms.reviewSendChannel", label: "感想送信先", id: settings.reviewSendChannelId, kind: "text", permissions: TEXT_PERMISSIONS, required: false });
  if (settings.formModeratorRoleId) {
    await checkRole(ctx, { key: "forms.moderatorRole", label: "フォームモデレーターロール", id: settings.formModeratorRoleId, mention: true, required: false });
    await checkMentionCapability(ctx, {
      key: "forms.moderatorRole",
      label: "フォームモデレーターロール",
      roleId: settings.formModeratorRoleId,
      channelIds: [settings.formSendChannelId],
    });
  } else addMissing(ctx, "forms.moderatorRole", "フォームモデレーターロール", "相談・苦情フォームのメンションロールは未設定です（任意）。");
}

async function validateProfile(ctx) {
  await checkChannel(ctx, {
    key: "profile.introductionChannel",
    label: "プロフィール公開先",
    id: ctx.settings?.profileIntroductionChannelId,
    kind: "text",
    channelTypes: [ChannelType.GuildText],
    permissions: TEXT_PERMISSIONS,
  });
}

async function validateVoiceControl(ctx) {
  const settings = ctx.settings ?? {};
  await checkChannel(ctx, { key: "voice_control.category", label: "VCコントロール対象カテゴリ", id: settings.vcControlCategoryId, kind: "category", permissions: VOICE_CONTROL_CATEGORY_PERMISSIONS });
  if (settings.vcControlNotifyRoleId) await checkRole(ctx, { key: "voice_control.notifyRole", label: "VCコントロール通知ロール", id: settings.vcControlNotifyRoleId, mention: true, required: false });
  else addMissing(ctx, "voice_control.notifyRole", "VCコントロール通知ロール", "通知ロールは未設定です（任意）。");
  await checkBotGuildPermission(ctx, "voice_control", "ManageChannels");
}

async function validateStatusBoard(ctx, getStatusBoard, statusBoardOverride = null) {
  // Rollback preflight passes an explicit target.  Never let the operational
  // runtime board hide a missing or unauthorized target channel.
  if (statusBoardOverride && Object.prototype.hasOwnProperty.call(statusBoardOverride, "channelId")) {
    const channelId = statusBoardOverride.channelId ?? null;
    if (!channelId) {
      addMissing(ctx, "status_board.channel", "ステータスボード設置先", "ステータスボードは未設置です。");
      return;
    }
    await checkChannel(ctx, { key: "status_board.channel", label: "ステータスボード設置先", id: channelId, kind: "text", permissions: TEXT_PERMISSIONS });
    addCheck(ctx, "status_board.message", "ステータスボードメッセージ", CHECKBOT_STATUSES.WARNING, "対象チャンネルは確認しました。適用前のメッセージ存在確認は行っていません。", { reason: "target-message-not-checked", id: channelId });
    return;
  }
  let board = null;
  let boardError = null;
  if (typeof getStatusBoard === "function") {
    try {
      board = await getStatusBoard(ctx.guild?.id);
    } catch (error) {
      boardError = error;
    }
  }
  if (boardError) {
    addCheck(ctx, "status_board.record", "ステータスボード設定", CHECKBOT_STATUSES.UNKNOWN, `ステータスボード設定を確認できませんでした。自動修復や変更は行っていません: ${errorText(boardError)}`, { reason: "settings-fetch-failed" });
    return;
  }
  // The configured target is authoritative.  A persisted board record may be
  // stale after an administrator moves the setting, so using board.channelId
  // here would validate the old channel and hide a repairable drift.
  const configuredChannelId = ctx.settings?.statusBoardChannelId ?? ctx.settings?.operationalStatusBoardChannelId ?? null;
  const channelId = configuredChannelId;
  if (!channelId) {
    addMissing(ctx, "status_board.channel", "ステータスボード設置先", "ステータスボードは未設置です。");
    return;
  }
  const boardChannel = await checkChannel(ctx, { key: "status_board.channel", label: "ステータスボード設置先", id: channelId, kind: "text", permissions: TEXT_PERMISSIONS });
  if (board?.channelId && board.channelId !== configuredChannelId
    && boardChannel
    && !ctx.checks.some((check) => check.key?.startsWith("status_board.channel") && check.status === CHECKBOT_STATUSES.ERROR)
    && !ctx.checks.some((check) => check.key?.startsWith("status_board.channel") && check.status === CHECKBOT_STATUSES.UNKNOWN)) {
    addCheck(
      ctx,
      "status_board.channel",
      "ステータスボード設置先",
      CHECKBOT_STATUSES.ERROR,
      "保存済みステータスボードの設置先が現在の設定と一致しません。",
      { reason: "channel-mismatch", configuredChannelId, persistedChannelId: board.channelId },
    );
  }
  if (!board?.messageId) {
    addCheck(ctx, "status_board.message", "ステータスボードメッセージ", CHECKBOT_STATUSES.WARNING, "ボードメッセージIDが保存されていません。", { reason: "message-missing" });
    return;
  }
  if (!boardChannel?.messages || typeof boardChannel.messages.fetch !== "function") {
    addCheck(ctx, "status_board.message", "ステータスボードメッセージ", CHECKBOT_STATUSES.UNKNOWN, "ボードメッセージを読み取り確認できません。変更操作は行っていません。", { reason: "message-fetch-unknown", id: board.messageId });
    return;
  }
  try {
    const message = await boardChannel.messages.fetch(board.messageId);
    addCheck(ctx, "status_board.message", "ステータスボードメッセージ", message ? CHECKBOT_STATUSES.OK : CHECKBOT_STATUSES.ERROR, message ? "保存済みのボードメッセージを確認しました。" : "保存済みのボードメッセージが見つかりません。", { reason: message ? "present" : "message-missing", id: board.messageId });
  } catch (error) {
    const missing = isMissingDiscordResourceError(error, "message");
    addCheck(ctx, "status_board.message", "ステータスボードメッセージ", missing ? CHECKBOT_STATUSES.ERROR : CHECKBOT_STATUSES.UNKNOWN, missing ? "保存済みのボードメッセージが見つかりません。" : `ボードメッセージを確認できませんでした。権限不足とは断定していません: ${errorText(error)}`, { reason: missing ? "message-missing" : "message-fetch-unknown", id: board.messageId });
  }
}

async function validateFukyo(ctx) {
  const settings = ctx.settings ?? {};
  const enabled = settings.fukyoWeeklyThemeEnabled === true;
  addCheck(
    ctx,
    "fukyo.enabled",
    "布教週次投稿の有効状態",
    enabled ? CHECKBOT_STATUSES.OK : CHECKBOT_STATUSES.WARNING,
    enabled ? "布教テーマの週次投稿は有効です。" : "布教テーマの週次投稿は無効または未設定です。",
    { reason: enabled ? "enabled" : "disabled" },
  );
  await checkChannel(ctx, {
    key: "fukyo.themeChannel",
    label: "布教テーマ投稿先",
    id: settings.fukyoThemeChannelId,
    kind: "text",
    permissions: TEXT_PERMISSIONS,
    required: enabled,
  });
  const themes = Array.isArray(settings.fukyoThemes) ? settings.fukyoThemes : [];
  if (themes.length === 0) {
    addCheck(ctx, "fukyo.themes", "布教テーマ一覧", CHECKBOT_STATUSES.WARNING, "投稿する布教テーマが未登録です。/addfukyo で登録してください。", { reason: "themes-missing" });
  } else {
    addCheck(ctx, "fukyo.themes", "布教テーマ一覧", CHECKBOT_STATUSES.OK, `${themes.length}件の布教テーマを確認しました。`, { reason: "themes-present", count: themes.length });
  }
}

async function checkBotGuildPermission(ctx, feature, permissionName) {
  const botMember = await getBotMember(ctx);
  const result = hasPermission(botMember?.permissions, permissionName);
  addCheck(ctx, `${feature}.guildPermission.${permissionName}`, `Botギルド権限 / ${permissionLabel(permissionName)}`, result === true ? CHECKBOT_STATUSES.OK : result === false ? CHECKBOT_STATUSES.ERROR : CHECKBOT_STATUSES.UNKNOWN, result === true ? `Botに${permissionLabel(permissionName)}があります。` : result === false ? `Botに${permissionLabel(permissionName)}がありません。` : `Botの${permissionLabel(permissionName)}を確認できませんでした。権限不足とは断定していません。`, { reason: result === true ? "permission-granted" : result === false ? "permission-denied" : "permission-unreadable", permission: permissionName });
}

async function runFeature(ctx, feature, getStatusBoard, statusBoardOverride = null) {
  if (ctx.settingsError) {
    addSettingReadFailure(ctx, ctx.settingsError);
    return;
  }
  switch (feature) {
    case "splitvc": return validateSplitvc(ctx);
    case "kokuchi": return validateKokuchi(ctx);
    case "callwait": return validateCallwait(ctx);
    case "vc_dm": return validateVcDm(ctx);
    case "forms": return validateForms(ctx);
    case "profile": return validateProfile(ctx);
    case "voice_control": return validateVoiceControl(ctx);
    case "status_board": return validateStatusBoard(ctx, getStatusBoard, statusBoardOverride);
    case "fukyo": return validateFukyo(ctx);
    default: return undefined;
  }
}

/**
 * Create the read-only validator.  getGuildSettings is optional so the
 * service remains straightforward to unit test with an already-read settings
 * object.  getStatusBoard is likewise optional because status-board state is
 * persisted in its own model rather than GuildSettings.
 */
export function createSettingsValidationService({
  getGuildSettings = null,
  getStatusBoard = null,
  logger = console,
} = {}) {
  async function validateFeature({ guild, settings = undefined, settingsError = null, feature = "all", statusBoardOverride = null, disabledFeatureSafe = false } = {}) {
    let effectiveSettings = settings;
    let effectiveSettingsError = settingsError;
    if (effectiveSettings === undefined && !effectiveSettingsError && typeof getGuildSettings === "function") {
      try {
        effectiveSettings = await getGuildSettings(guild?.id);
      } catch (error) {
        effectiveSettingsError = error;
      }
    }
    const normalized = normalizeFeature(feature);
    if (normalized === "all") {
      return validateGuild({
        guild,
        settings: effectiveSettings,
        settingsError: effectiveSettingsError,
        feature: normalized,
        statusBoardOverride,
      });
    }
    const ctx = makeContext({ guild, settings: effectiveSettings, settingsError: effectiveSettingsError, logger });
    ctx.skipDisabledDependencies = disabledFeatureSafe;
    const settingsGuildId = effectiveSettings?.guildId;
    if (settingsGuildId && guild?.id && settingsGuildId !== guild.id) {
      addCheck(ctx, "settings.guild", "GuildSettings所属Guild", CHECKBOT_STATUSES.ERROR, "読み込んだGuildSettingsが実行対象のサーバーと一致しません。", { reason: "guild-mismatch" });
    }
    await runFeature(ctx, normalized, getStatusBoard, statusBoardOverride);
    return {
      feature: normalized,
      label: STATUS_LABELS[normalized],
      status: statusOf(ctx.checks),
      severity: statusOf(ctx.checks) === CHECKBOT_STATUSES.OK ? "healthy" : statusOf(ctx.checks),
      checks: ctx.checks,
      settings: effectiveSettings ?? null,
      intentNotice: "Developer PortalのMessage Content / Server Members Intentはコードだけでは確認できません。Developer Portalで有効化を手動確認してください。",
    };
  }

  async function validateGuild({ guild, settings = undefined, settingsError = null, feature = "all", statusBoardOverride = null, disabledFeatureSafe = false } = {}) {
    let effectiveSettings = settings;
    let effectiveSettingsError = settingsError;
    if (effectiveSettings === undefined && !effectiveSettingsError && typeof getGuildSettings === "function") {
      try {
        effectiveSettings = await getGuildSettings(guild?.id);
      } catch (error) {
        effectiveSettingsError = error;
      }
    }
    const normalized = normalizeFeature(feature);
    const features = normalized === "all" ? CHECKBOT_FEATURES : [normalized];
    const reports = [];
    for (const item of features) {
      reports.push(await validateFeature({ guild, settings: effectiveSettings, settingsError: effectiveSettingsError, feature: item, statusBoardOverride, disabledFeatureSafe }));
    }
    const checks = reports.flatMap((report) => report.checks);
    const status = statusOf(checks);
    return {
      guildId: guild?.id ?? null,
      feature: normalized,
      status,
      severity: status === CHECKBOT_STATUSES.OK ? "healthy" : status,
      reports,
      checks,
      settings: effectiveSettings ?? null,
      intentNotice: "Developer PortalのMessage Content / Server Members Intentはコードだけでは確認できません。Developer Portalで有効化を手動確認してください。",
    };
  }

  // Aliases make the service convenient for composition roots and tests that
  // prefer a `check` verb while retaining the more descriptive API.
  return { validateGuild, validateFeature, check: validateGuild, normalizeFeature };
}

export {
  CATEGORY_CREATE_PERMISSIONS,
  CHECKBOT_FEATURES as checkbotFeatures,
  normalizeFeature,
  statusOf as aggregateCheckbotStatus,
  TEXT_PERMISSIONS,
  VOICE_MOVE_PERMISSIONS,
};
