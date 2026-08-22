import crypto from "node:crypto";
import { ChannelType, MessageFlags, PermissionFlagsBits } from "discord.js";
import { claimFukyoWeeklyPost, finishFukyoWeeklyPost, getFukyoThemeState, saveFukyoThemeState } from "./fukyo-theme-store.js";

export const FUKYO_MESSAGE = (name) => `【週替わりテーマ】\n今週のテーマは「${name}」です！\nぜひお薦めしていってください！\n\n週替わりテーマ以外の投稿も大歓迎です！`;

export function normalizeFukyoThemeName(value) {
  return String(value ?? "").normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

export function cleanFukyoThemeName(value) {
  return String(value ?? "").replace(/[\r\n\u0000-\u001f\u007f-\u009f]/g, "").trim();
}

/** Pure selection helper: callers persist the returned state only after a successful public send. */
export function selectFukyoTheme(currentThemes, state = {}, explicitIndex = null, random = Math.random) {
  const ids = new Set(currentThemes.map((theme) => theme.id));
  let usedThemeIds = [...new Set((state.usedThemeIds ?? []).filter((id) => ids.has(id)))];
  let cycleNumber = state.cycleNumber ?? 0;
  let selected = explicitIndex === null ? null : currentThemes[explicitIndex];
  if (!selected) {
    let candidates = currentThemes.filter((theme) => !usedThemeIds.includes(theme.id));
    if (candidates.length === 0) { usedThemeIds = []; cycleNumber += 1; candidates = currentThemes; }
    selected = candidates[Math.min(candidates.length - 1, Math.floor(random() * candidates.length))];
  }
  return { selected, state: { usedThemeIds, cycleNumber, lastThemeId: state.lastThemeId ?? null } };
}

function jstParts(now) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(now);
  return Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
}

function jstDateAt(parts, days, hour = 6) {
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days, hour - 9, 0, 0));
}

function dateKey(parts, days = 0) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return date.toISOString().slice(0, 10);
}

export function getNextFukyoSlot(now = new Date()) {
  const parts = jstParts(now);
  const day = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
  let days = (8 - day) % 7;
  if (days === 0 && (parts.hour > 6 || (parts.hour === 6 && (parts.minute > 0 || parts.second > 0)))) days = 7;
  return { weekKey: dateKey(parts, days), at: jstDateAt(parts, days) };
}

export function getLatestDueFukyoSlot(now = new Date()) {
  const parts = jstParts(now);
  const day = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
  let daysBack = (day + 6) % 7;
  if (day === 1 && parts.hour < 6) daysBack = 7;
  return { weekKey: dateKey(parts, -daysBack), at: jstDateAt(parts, -daysBack) };
}

function reply(interaction, content) {
  const payload = { content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } };
  if (interaction.deferred) return interaction.editReply(payload);
  if (interaction.replied) return interaction.followUp(payload);
  return interaction.reply(payload);
}

// Configuration writes can fail after the interaction has already been
// acknowledged.  Keep that acknowledgement out of the value returned to
// callers: discord.js Message objects are truthy and used to make callers
// mistake a conflict/error notice for a successful settings write.
export const FUKYO_CONFIGURATION_SAVE_FAILED = Object.freeze({ ok: false });

function splitText(text, max = 1900) {
  const output = []; let current = "";
  for (const line of text.split("\n")) {
    const next = current ? `${current}\n${line}` : line;
    if (next.length > max && current) { output.push(current); current = line; } else current = next;
  }
  if (current) output.push(current);
  return output;
}

export function createFukyoThemeService({ getGuildSettings, saveGuildSettings, saveVersionedGuildConfiguration = null, sendOperationalLog, acquireMongoLease, releaseMongoLease, requestOperationalStatusRefresh = () => {} }) {
  let timer = null;
  let client = null;
  let stopped = false;

  async function withGuildLock(guildId, work) {
    const lease = await acquireMongoLease(`fukyo-theme:${guildId}`, { leaseMs: 60_000 });
    if (!lease) return { locked: false };
    try { return { locked: true, value: await work() }; } finally { await releaseMongoLease(lease).catch(() => null); }
  }

  function refreshStatus(guildId, reason) {
    try {
      requestOperationalStatusRefresh(guildId, reason);
    } catch (error) {
      console.error(`Fukyo operational status refresh request failed: ${error?.message ?? error}`);
    }
  }

  function themes(settings) {
    return Array.isArray(settings?.fukyoThemes) ? settings.fukyoThemes.filter((theme) => theme?.id && theme?.name && theme?.normalizedName) : [];
  }

  async function saveFukyoConfiguration(interaction, currentSettings, patch, reason, { companionPatch = {} } = {}) {
    try {
      let settings;
      if (typeof saveVersionedGuildConfiguration !== "function") {
        // Keep the legacy test/in-process adapter semantically equivalent to
        // the versioned writer: the activation timestamp is still a runtime
        // field, but must move with a false -> true update when no transaction
        // writer has been injected.
        settings = await saveGuildSettings(interaction.guildId, { ...patch, ...companionPatch });
      } else {
        settings = await saveVersionedGuildConfiguration(interaction.guildId, patch, {
          expectedRevision: Number.isInteger(Number(currentSettings?.configRevision))
            ? Number(currentSettings.configRevision)
            : 0,
          actorUserId: interaction.user?.id ?? null,
          source: "setting",
          reason,
          companionPatch,
        });
      }
      return { ok: true, settings };
    } catch (error) {
      if (error?.code === "CONFIGURATION_REVISION_CONFLICT") {
        await reply(interaction, "設定が別の管理者によって先に更新されました。現在の設定を再表示してから、もう一度実行してください。上書きは行っていません。");
        return { ...FUKYO_CONFIGURATION_SAVE_FAILED, reason: "revision-conflict", error };
      }
      if (error?.code === "CONFIGURATION_TRANSACTIONS_UNAVAILABLE") {
        await reply(interaction, "設定の安全な履歴保存に必要なMongoDBトランザクションが利用できないため、設定を変更しませんでした。");
        return { ...FUKYO_CONFIGURATION_SAVE_FAILED, reason: "transactions-unavailable", error };
      }
      throw error;
    }
  }

  async function chooseTheme(guildId, currentThemes, explicitIndex = null) {
    const state = await getFukyoThemeState(guildId) ?? { usedThemeIds: [], cycleNumber: 0, lastThemeId: null };
    return selectFukyoTheme(currentThemes, state, explicitIndex);
  }

  async function markThemeUsed(guildId, selection) {
    const usedThemeIds = selection.state.usedThemeIds.includes(selection.selected.id)
      ? selection.state.usedThemeIds : [...selection.state.usedThemeIds, selection.selected.id];
    await saveFukyoThemeState(guildId, { ...selection.state, usedThemeIds, lastThemeId: selection.selected.id });
  }

  async function resolveTarget(guild, settings) {
    if (!settings?.fukyoThemeChannelId) return { ok: false, reason: "channel_missing" };
    const channel = await guild.channels.fetch(settings.fukyoThemeChannelId).catch(() => null);
    if (!channel || ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type) || typeof channel.send !== "function") return { ok: false, reason: "channel_unavailable" };
    const me = guild.members.me ?? await guild.members.fetchMe().catch(() => null);
    const permissions = me && channel.permissionsFor?.(me);
    if (!permissions?.has(PermissionFlagsBits.ViewChannel) || !permissions?.has(PermissionFlagsBits.SendMessages)) return { ok: false, reason: "permission_denied" };
    return { ok: true, channel };
  }

  async function log(guild, settings, content, isError = false) {
    console[isError ? "error" : "warn"](content);
    const sent = await sendOperationalLog({ guild, settings, fallbackChannel: null, content, allowedMentions: { parse: [] } }).catch(() => null);
    if (!sent) console[isError ? "error" : "warn"](`布教テーマ運用ログ送信失敗 guildId=${guild?.id ?? "unknown"}`);
  }

  async function publish(guild, settings, explicitIndex = null) {
    const target = await resolveTarget(guild, settings);
    if (!target.ok) return target;
    const currentThemes = themes(settings);
    if (currentThemes.length === 0) return { ok: false, reason: "no_themes" };
    const selection = await chooseTheme(guild.id, currentThemes, explicitIndex);
    const message = await target.channel.send({ content: FUKYO_MESSAGE(selection.selected.name), allowedMentions: { parse: [] } });
    await markThemeUsed(guild.id, selection);
    return { ok: true, message, theme: selection.selected, channel: target.channel };
  }

  async function runWeeklyForGuild(guild, { weekKey, allowClaim = true } = {}) {
    const currentSettings = await getGuildSettings(guild.id);
    if (!currentSettings?.fukyoWeeklyThemeEnabled) return { status: "disabled" };
    const slot = weekKey ? { weekKey } : getLatestDueFukyoSlot();
    const enabledAt = currentSettings.fukyoWeeklyThemeEnabledAt ? new Date(currentSettings.fukyoWeeklyThemeEnabledAt) : null;
    if (enabledAt && slot.at && enabledAt > slot.at) return { status: "not-enabled-yet" };
    const claimed = allowClaim ? await claimFukyoWeeklyPost({ guildId: guild.id, weekKey: slot.weekKey }) : { claimed: true };
    if (!claimed.claimed) return { status: "already-recorded" };
    const locked = await withGuildLock(guild.id, async () => {
      const settings = await getGuildSettings(guild.id);
      if (!settings?.fukyoWeeklyThemeEnabled) return { status: "disabled" };
      try {
        const result = await publish(guild, settings);
        if (!result.ok) {
          const status = result.reason === "no_themes" ? "skipped" : "failed";
          await finishFukyoWeeklyPost({ guildId: guild.id, weekKey: slot.weekKey, status, patch: { reason: result.reason } });
          await log(guild, settings, `布教テーマ週次投稿 ${status}: guildId=${guild.id} weekKey=${slot.weekKey} reason=${result.reason}`, status === "failed");
          return { status, reason: result.reason };
        }
        await finishFukyoWeeklyPost({ guildId: guild.id, weekKey: slot.weekKey, status: "completed", patch: { themeId: result.theme.id, themeName: result.theme.name, messageId: result.message.id, channelId: result.channel.id } });
        return { status: "completed" };
      } catch (error) {
        const reason = error?.message ?? "unknown_error";
        await finishFukyoWeeklyPost({ guildId: guild.id, weekKey: slot.weekKey, status: "failed", patch: { reason } }).catch(() => null);
        await log(guild, settings, `布教テーマ週次投稿 failed: guildId=${guild.id} weekKey=${slot.weekKey} error=${reason}`, true);
        return { status: "failed", reason };
      }
    });
    if (!locked.locked) await log(guild, currentSettings, `布教テーマ週次投稿をロック取得失敗のため中止しました。guildId=${guild.id} weekKey=${slot.weekKey}`, true);
    const result = locked.value ?? { status: "lock-unavailable" };
    refreshStatus(guild.id, `fukyo-weekly:${result.status}`);
    return result;
  }

  async function runWeeklyForAllGuilds() {
    if (stopped || !client) return;
    const slot = getLatestDueFukyoSlot();
    for (const guild of client.guilds.cache.values()) await runWeeklyForGuild(guild, { weekKey: slot.weekKey }).catch((error) => console.error("布教テーマ週次投稿失敗", error));
  }

  function scheduleNext() {
    if (timer) clearTimeout(timer);
    if (stopped) return;
    const next = getNextFukyoSlot();
    timer = setTimeout(() => { void runWeeklyForAllGuilds().finally(scheduleNext); }, Math.max(0, next.at.getTime() - Date.now()));
  }

  async function ensureManager(interaction) {
    if (!interaction.inGuild()) { await reply(interaction, "このコマンドはサーバー内で使用してください。"); return false; }
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) { await reply(interaction, "この操作にはサーバー管理権限が必要です。"); return false; }
    return true;
  }

  return {
    async restore(discordClient) {
      client = discordClient; stopped = false;
      for (const guild of client.guilds.cache.values()) await runWeeklyForGuild(guild).catch((error) => console.error("布教テーマ起動時補完失敗", error));
      scheduleNext();
    },
    shutdown() { stopped = true; if (timer) clearTimeout(timer); timer = null; },
    async addTheme(interaction) {
      if (!await ensureManager(interaction)) return;
      const name = cleanFukyoThemeName(interaction.options.getString("theme", true));
      if (!name || name.length > 50) return reply(interaction, "テーマは改行なしの1～50文字で入力してください。");
      const normalizedName = normalizeFukyoThemeName(name);
      const locked = await withGuildLock(interaction.guildId, async () => {
        const settings = await getGuildSettings(interaction.guildId); const current = themes(settings);
        if (current.some((theme) => theme.normalizedName === normalizedName)) return { duplicate: true };
        const next = [...current, { id: crypto.randomUUID(), name, normalizedName }];
        const saved = await saveFukyoConfiguration(interaction, settings, { fukyoThemes: next }, "fukyo-theme-add");
        if (!saved.ok) return { conflict: true };
        refreshStatus(interaction.guildId, "fukyo-theme-add");
        return { name };
      });
      if (!locked.locked) return reply(interaction, "別の布教テーマ操作を処理中です。少し待ってから再実行してください。");
      if (locked.value?.conflict) return;
      return reply(interaction, locked.value.duplicate ? "同じ布教テーマがすでに登録されています。" : `布教テーマ「${name}」を追加しました。`);
    },
    async showThemes(interaction) {
      if (!interaction.inGuild()) return reply(interaction, "このコマンドはサーバー内で使用してください。");
      const current = themes(await getGuildSettings(interaction.guildId));
      if (current.length === 0) return reply(interaction, "布教テーマは登録されていません。");
      const chunks = splitText(["【布教テーマ一覧】", ...current.map((theme, index) => `${index + 1}. ${theme.name}`)].join("\n"));
      await reply(interaction, chunks.shift()); for (const chunk of chunks) await interaction.followUp({ content: chunk, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    },
    async deleteTheme(interaction) {
      if (!await ensureManager(interaction)) return;
      const number = interaction.options.getInteger("number", true);
      if (!Number.isInteger(number) || number < 1) return reply(interaction, "削除対象は /showfukyo の1始まりの番号で指定してください。");
      const locked = await withGuildLock(interaction.guildId, async () => {
        const settings = await getGuildSettings(interaction.guildId); const current = themes(settings); const target = current[number - 1];
        if (!target) return null;
        current.splice(number - 1, 1);
        const saved = await saveFukyoConfiguration(interaction, settings, { fukyoThemes: current }, "fukyo-theme-delete");
        if (!saved.ok) return { conflict: true };
        const state = await getFukyoThemeState(interaction.guildId);
        if (state) await saveFukyoThemeState(interaction.guildId, { ...state, usedThemeIds: (state.usedThemeIds ?? []).filter((id) => id !== target.id) });
        refreshStatus(interaction.guildId, "fukyo-theme-delete");
        return target;
      });
      if (!locked.locked) return reply(interaction, "別の布教テーマ操作を処理中です。少し待ってから再実行してください。");
      if (locked.value?.conflict) return;
      return reply(interaction, locked.value ? `布教テーマ「${locked.value.name}」を削除しました。` : "その番号の布教テーマはありません。");
    },
    async sendTheme(interaction) {
      if (!await ensureManager(interaction)) return;
      const number = interaction.options.getInteger("theme_number", false);
      if (number !== null && (!Number.isInteger(number) || number < 1)) return reply(interaction, "テーマ番号は /showfukyo の1始まりの番号で指定してください。");
      const locked = await withGuildLock(interaction.guildId, async () => {
        const settings = await getGuildSettings(interaction.guildId); const current = themes(settings);
        if (number !== null && !current[number - 1]) return { ok: false, reason: "invalid_number" };
        return publish(interaction.guild, settings, number === null ? null : number - 1);
      });
      if (!locked.locked) return reply(interaction, "別の布教テーマ操作を処理中です。少し待ってから再実行してください。");
      refreshStatus(interaction.guildId, "fukyo-theme-send");
      if (!locked.value.ok) {
        const messages = { no_themes: "布教テーマは登録されていません。", invalid_number: "その番号の布教テーマはありません。", channel_missing: "布教テーマの投稿先チャンネルが設定されていません。", channel_unavailable: "布教テーマの投稿先チャンネルが見つからないか、送信できません。", permission_denied: "Botに投稿先チャンネルの閲覧または送信権限がありません。" };
        return reply(interaction, messages[locked.value.reason] ?? "布教テーマの送信に失敗しました。");
      }
      return reply(interaction, `布教テーマ「${locked.value.theme.name}」を ${locked.value.channel} に送信しました。`);
    },
    async updateSetting(interaction) {
      const channel = interaction.options.getChannel("channel", false); const enabled = interaction.options.getBoolean("enabled", false);
      if (!channel && enabled === null) return reply(interaction, "channel または enabled を指定してください。");
      if (channel && ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)) return reply(interaction, "投稿先にはテキストチャンネルを指定してください。");
      const previous = await getGuildSettings(interaction.guildId);
      const patch = { ...(channel ? { fukyoThemeChannelId: channel.id } : {}), ...(enabled === null ? {} : { fukyoWeeklyThemeEnabled: enabled }) };
      const companionPatch = enabled && previous?.fukyoWeeklyThemeEnabled !== true
        ? { fukyoWeeklyThemeEnabledAt: new Date() }
        : {};
      const outcome = await saveFukyoConfiguration(interaction, previous, patch, "fukyo-setting", { companionPatch });
      if (!outcome.ok) return;
      const saved = outcome.settings;
      if (enabled === false) scheduleNext();
      refreshStatus(interaction.guildId, "fukyo-setting");
      const applyStatus = saved.apply?.status === "applied"
        ? "Discordへの関連処理も完了しました。"
        : "設定は保存済みです。Discordへの適用状態は /config apply_status で確認できます。";
      return reply(interaction, `布教テーマ設定を更新しました。${applyStatus}\n投稿先: ${saved.fukyoThemeChannelId ? `<#${saved.fukyoThemeChannelId}>` : "未設定"}\n自動投稿: ${saved.fukyoWeeklyThemeEnabled ? "有効" : "無効"}`);
    },
  };
}
