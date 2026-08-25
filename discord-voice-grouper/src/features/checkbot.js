import {
  MessageFlags,
  PermissionFlagsBits,
} from "discord.js";
import {
  CHECKBOT_FEATURES,
  CHECKBOT_STATUSES,
} from "../settings-validation-service.js";

const STATUS_EMOJI = Object.freeze({
  [CHECKBOT_STATUSES.OK]: "✅",
  [CHECKBOT_STATUSES.WARNING]: "⚠",
  [CHECKBOT_STATUSES.ERROR]: "❌",
  [CHECKBOT_STATUSES.UNKNOWN]: "❔",
});

const STATUS_COLOR = Object.freeze({
  [CHECKBOT_STATUSES.OK]: 0x57F287,
  [CHECKBOT_STATUSES.WARNING]: 0xFEE75C,
  [CHECKBOT_STATUSES.ERROR]: 0xED4245,
  [CHECKBOT_STATUSES.UNKNOWN]: 0x95A5A6,
});

const STATUS_LABEL = Object.freeze({
  [CHECKBOT_STATUSES.OK]: "正常",
  [CHECKBOT_STATUSES.WARNING]: "警告・未設定",
  [CHECKBOT_STATUSES.ERROR]: "実行不能",
  [CHECKBOT_STATUSES.UNKNOWN]: "確認不能",
});

const MAX_FIELD_NAME = 256;
const MAX_FIELD_VALUE = 1_024;
const MAX_EMBED_FIELDS = 25;
const MAX_EMBEDS = 10;
const MAX_EMBED_TEXT = 6_000;
const PAGE_TITLE_RESERVE = 32;
const OVERFLOW_NOTICE = "結果が長いため一部を省略しました。省略分は /checkbot feature:<機能名> で個別に確認してください。";

function shorten(value, max) {
  const text = String(value ?? "").replace(/\u0000/g, "").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3))}...`;
}

function featureLabel(feature) {
  return {
    splitvc: "splitvc",
    kokuchi: "kokuchi",
    callwait: "callwait",
    vc_dm: "vc_dm",
    forms: "forms",
    profile: "profile",
    voice_control: "voice_control",
    status_board: "status_board",
    fukyo: "fukyo",
  }[feature] ?? feature;
}

function normalizeFeature(value) {
  if (typeof value !== "string" || value.trim() === "" || value === "all") return "all";
  const normalized = value.trim().toLowerCase();
  return CHECKBOT_FEATURES.includes(normalized) ? normalized : "all";
}

function checkField(check) {
  const status = check?.status ?? CHECKBOT_STATUSES.UNKNOWN;
  const emoji = STATUS_EMOJI[status] ?? STATUS_EMOJI[CHECKBOT_STATUSES.UNKNOWN];
  const label = shorten(`${emoji} ${check?.label ?? check?.key ?? "確認項目"}`, MAX_FIELD_NAME);
  const value = shorten(`${STATUS_LABEL[status] ?? "確認不能"} — ${check?.detail ?? "詳細なし"}`, MAX_FIELD_VALUE) || "詳細なし";
  return { name: label, value, inline: false };
}

function embedTextLength(embed) {
  return [
    embed?.title,
    embed?.description,
    embed?.footer?.text,
    ...(embed?.fields ?? []).flatMap((field) => [field?.name, field?.value]),
  ].reduce((total, value) => total + String(value ?? "").length, 0);
}

function reportEmbeds(report) {
  const checks = Array.isArray(report?.checks) ? report.checks : [];
  const status = report?.status ?? CHECKBOT_STATUSES.UNKNOWN;
  const base = {
    color: STATUS_COLOR[status] ?? STATUS_COLOR[CHECKBOT_STATUSES.UNKNOWN],
    description: `${STATUS_LABEL[status] ?? "確認不能"}。設定の保存・権限変更・メッセージ送信・VC操作は行っていません。`,
    footer: {
      text: shorten(report?.intentNotice ?? "Developer PortalのIntentは手動確認が必要です。", 2_048),
    },
  };
  const fields = checks.map(checkField);
  const pages = [];
  let pageFields = [];
  const createCandidate = (candidateFields) => ({
    ...base,
    title: shorten(`${STATUS_EMOJI[status] ?? "❔"} ${featureLabel(report?.feature)}`, MAX_FIELD_NAME),
    fields: candidateFields,
  });
  for (const field of fields) {
    const candidateFields = [...pageFields, field];
    const candidate = createCandidate(candidateFields);
    if (pageFields.length > 0 && (candidateFields.length > MAX_EMBED_FIELDS || embedTextLength(candidate) > MAX_EMBED_TEXT - PAGE_TITLE_RESERVE)) {
      pages.push(createCandidate(pageFields));
      pageFields = [field];
    } else {
      pageFields = candidateFields;
    }
  }
  if (pageFields.length > 0 || pages.length === 0) pages.push(createCandidate(pageFields));
  return pages.map((embed, index) => ({
    ...embed,
    title: pages.length > 1
      ? shorten(`${embed.title} (${index + 1}/${pages.length})`, MAX_FIELD_NAME)
      : embed.title,
  }));
}

function totalEmbedTextLength(embeds) {
  return embeds.reduce((total, embed) => total + embedTextLength(embed), 0);
}

/**
 * Discord's 6,000-character embed limit is shared by every embed in one
 * message. Keep the first useful results and reserve an embed which tells the
 * administrator how to inspect anything that could not fit.
 */
function limitMessageEmbedText(embeds) {
  if (totalEmbedTextLength(embeds) <= MAX_EMBED_TEXT) return embeds;

  const notice = {
    title: "❔ checkbot（省略あり）",
    color: STATUS_COLOR[CHECKBOT_STATUSES.UNKNOWN],
    description: OVERFLOW_NOTICE,
    fields: [],
    footer: { text: "Developer PortalのIntentは手動確認が必要です。" },
  };
  const contentBudget = MAX_EMBED_TEXT - embedTextLength(notice);
  const retained = [];
  let used = 0;
  let truncated = false;

  // Leave one of Discord's ten embed slots for the overflow notice.
  for (const source of embeds.slice(0, MAX_EMBEDS - 1)) {
    const base = { ...source, fields: [] };
    const baseLength = embedTextLength(base);
    if (used + baseLength > contentBudget) {
      truncated = true;
      break;
    }
    retained.push(base);
    used += baseLength;

    for (const field of source.fields ?? []) {
      const fieldLength = String(field.name ?? "").length + String(field.value ?? "").length;
      if (used + fieldLength <= contentBudget) {
        retained.at(-1).fields.push(field);
        used += fieldLength;
        continue;
      }

      const valueBudget = contentBudget - used - String(field.name ?? "").length;
      if (valueBudget > 0) {
        const clippedValue = valueBudget < 3
          ? "…"
          : (shorten(field.value, valueBudget) || "…");
        const clippedField = { ...field, value: clippedValue };
        retained.at(-1).fields.push(clippedField);
        used += String(clippedField.name ?? "").length + String(clippedField.value ?? "").length;
      }
      truncated = true;
      break;
    }
    if (truncated) break;
  }

  // Reaching the source-embed cap also means later results were omitted.
  if (retained.length < embeds.length) truncated = true;
  return truncated ? [...retained, notice] : retained;
}

/** Build plain JSON embeds so the formatter remains easy to test without a Discord client. */
export function buildCheckbotEmbeds(result) {
  const reports = Array.isArray(result?.reports) ? result.reports : [];
  let embeds = reports.flatMap(reportEmbeds);
  if (embeds.length === 0) {
    embeds = [{
      title: "❔ checkbot",
      color: STATUS_COLOR[CHECKBOT_STATUSES.UNKNOWN],
      description: "確認結果を作成できませんでした。",
      fields: [],
      footer: { text: "Developer PortalのIntentは手動確認が必要です。" },
    }];
  }
  // Discord accepts at most ten embeds per message.  The normal `all` result
  // uses one page per feature; this defensive compression also keeps custom
  // validators from producing an invalid response.
  if (embeds.length > MAX_EMBEDS) {
    const overflow = embeds.slice(MAX_EMBEDS - 1).flatMap((embed) => embed.fields ?? []);
    const overflowDescription = OVERFLOW_NOTICE;
    const retained = [];
    for (const field of overflow) {
      if (retained.length >= MAX_EMBED_FIELDS) break;
      const candidate = {
        title: "❔ checkbot（続き・省略あり）",
        color: STATUS_COLOR[CHECKBOT_STATUSES.UNKNOWN],
        description: overflowDescription,
        fields: [...retained, field],
        footer: { text: "Developer PortalのIntentは手動確認が必要です。" },
      };
      // Leave room for the omitted-count prefix, whose digit length depends
      // on the number of discarded fields.
      if (embedTextLength(candidate) > MAX_EMBED_TEXT - 64) break;
      retained.push(field);
    }
    const omittedCount = Math.max(0, overflow.length - retained.length);
    embeds = embeds.slice(0, MAX_EMBEDS - 1);
    embeds.push({
      title: "❔ checkbot（続き・省略あり）",
      color: STATUS_COLOR[CHECKBOT_STATUSES.UNKNOWN],
      description: shorten(`結果が長いため${omittedCount}件を省略しました。${overflowDescription}`, 4_096),
      fields: retained,
      footer: { text: "Developer PortalのIntentは手動確認が必要です。" },
    });
  }
  return limitMessageEmbedText(embeds);
}

export { embedTextLength, totalEmbedTextLength };

function hasManageGuild(interaction) {
  try {
    return Boolean(interaction?.memberPermissions?.has?.(PermissionFlagsBits.ManageGuild));
  } catch {
    return false;
  }
}

/**
 * The /checkbot handler has no dependency on guild-operations on purpose:
 * reading settings and Discord resources must not accidentally call a
 * feature's mutation path.
 */
export function createCheckbotFeature({
  getGuildSettings,
  validationService,
  logger = console,
} = {}) {
  if (!validationService?.validateGuild) throw new Error("checkbot requires a settings validation service");

  async function handleCheckbot(interaction) {
    if (!interaction?.inGuild?.() || !interaction.guildId) {
      await interaction?.reply?.({
        content: "このコマンドはサーバー内で使ってください。",
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      return;
    }
    if (!hasManageGuild(interaction)) {
      await interaction.reply({
        content: "この確認にはサーバー管理権限が必要です。",
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const requestedFeature = normalizeFeature(interaction.options?.getString?.("feature", false));
    let settings;
    let settingsError = null;
    try {
      settings = typeof getGuildSettings === "function"
        ? await getGuildSettings(interaction.guildId)
        : undefined;
    } catch (error) {
      settingsError = error;
      logger.warn?.(`checkbot settings read failed for ${interaction.guildId}: ${error?.message ?? error}`);
    }

    let result;
    try {
      result = await validationService.validateGuild({
        guild: interaction.guild,
        settings,
        settingsError,
        feature: requestedFeature,
      });
    } catch (error) {
      logger.error?.("checkbot validation failed", error);
      result = {
        feature: requestedFeature,
        status: CHECKBOT_STATUSES.UNKNOWN,
        reports: [{
          feature: requestedFeature,
          status: CHECKBOT_STATUSES.UNKNOWN,
          checks: [{
            key: "validator",
            label: "設定・権限検証",
            status: CHECKBOT_STATUSES.UNKNOWN,
            detail: `検証処理を完了できませんでした。権限不足とは断定していません: ${shorten(error?.message ?? error, 300)}`,
          }],
          intentNotice: "Developer PortalのIntentは手動確認が必要です。",
        }],
      };
    }
    await interaction.editReply({
      embeds: buildCheckbotEmbeds(result),
      allowedMentions: { parse: [] },
    });
  }

  return { handleCheckbot };
}
