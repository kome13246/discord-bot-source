import { ChannelType } from "discord.js";
import { ADMIN_CONFIGURATION_KEYS } from "./settings-configuration.js";
import { SETUP_DRAFT_FEATURES } from "./models/setup-draft.js";

const TEXT_CHANNEL_TYPES = Object.freeze([ChannelType.GuildText, ChannelType.GuildAnnouncement]);
const PROFILE_TEXT_CHANNEL_TYPES = Object.freeze([ChannelType.GuildText]);
const VOICE_CHANNEL_TYPES = Object.freeze([ChannelType.GuildVoice, ChannelType.GuildStageVoice]);
const CATEGORY_TYPES = Object.freeze([ChannelType.GuildCategory]);

const required = () => true;
const optional = () => false;
const enabled = ({ feature, values }) => (
  (feature === "callwait" && values.callWaitEnabled === true)
  || (feature === "vc_dm" && values.vcDmEnabled === true)
  || (feature === "fukyo" && values.fukyoWeeklyThemeEnabled === true)
);
const partybeast = ({ values }) => values.splitMode === "partybeast";
const vcDmEventTimeVisible = ({ values }) => values.vcDmEnabled === true;
const vcDmEventTimeRequired = ({ feature, values, patch, current }) => (
  feature === "vc_dm"
  && values.vcDmEnabled === true
  && (
    current?.kokuchiEventTimeConfigured !== true
    || hasOwn(patch, "kokuchiEventTime") && (patch.kokuchiEventTime === null || patch.kokuchiEventTime === "")
  )
);

const hourlyEventChoices = Object.freeze(Array.from({ length: 24 }, (_value, hour) => {
  const value = `${String(hour).padStart(2, "0")}:00`;
  return { label: value, value };
}));

function field({ key, label, type, required: isRequired = required, channelTypes = null, choices = null, showIf = null }) {
  if (!ADMIN_CONFIGURATION_KEYS.has(key)) throw new Error(`Setup schema key is not cataloged: ${key}`);
  return Object.freeze({ key, label, type, required: isRequired, channelTypes, choices, showIf });
}

export const SETUP_FEATURE_SCHEMAS = Object.freeze({
  splitvc: Object.freeze({
    label: "splitvc",
    fields: Object.freeze([
      field({ key: "splitMode", label: "VC作成方式", type: "string", choices: [{ label: "Bot直接作成", value: "direct" }, { label: "PB互換", value: "partybeast" }] }),
      field({ key: "tempRoleId", label: "参加者ロール", type: "role" }),
      field({ key: "parentChannelId", label: "PB親ボイスチャンネル", type: "channel", channelTypes: VOICE_CHANNEL_TYPES, required: partybeast, showIf: partybeast }),
      field({ key: "childCategoryId", label: "子VCカテゴリ", type: "channel", channelTypes: CATEGORY_TYPES }),
      field({ key: "waitingVcCategoryId", label: "途中参加用待機VCカテゴリ（任意）", type: "channel", channelTypes: CATEGORY_TYPES, required: optional }),
      field({ key: "splitFeedbackChannelId", label: "終了後フィードバック案内先（任意）", type: "channel", channelTypes: TEXT_CHANNEL_TYPES, required: optional }),
    ]),
  }),
  kokuchi: Object.freeze({
    label: "kokuchi",
    fields: Object.freeze([
      field({ key: "kokuchiAnnouncementChannelId", label: "告知・開始案内先", type: "channel", channelTypes: TEXT_CHANNEL_TYPES }),
      field({ key: "kokuchiOverviewChannelId", label: "概要案内先（任意）", type: "channel", channelTypes: TEXT_CHANNEL_TYPES, required: optional }),
      field({ key: "kokuchiEventTime", label: "開催時刻（任意）", type: "string", choices: [{ label: "18:00", value: "18:00" }, { label: "19:00", value: "19:00" }, { label: "20:00", value: "20:00" }, { label: "21:00", value: "21:00" }, { label: "22:00", value: "22:00" }], required: optional }),
      field({ key: "gatheringVoiceChannelId", label: "集合VC（任意）", type: "channel", channelTypes: VOICE_CHANNEL_TYPES, required: optional }),
      field({ key: "kokuchiMentionRoleIds", label: "告知メンションロール（任意）", type: "role", required: optional }),
    ]),
  }),
  callwait: Object.freeze({
    label: "callwait",
    fields: Object.freeze([
      field({ key: "callWaitEnabled", label: "callwait有効状態", type: "boolean", choices: [{ label: "有効", value: "true" }, { label: "無効", value: "false" }] }),
      field({ key: "callWaitRoleId", label: "通話希望者ロール", type: "role", required: enabled, showIf: enabled }),
      field({ key: "callWaitPromptChannelId", label: "定時募集先", type: "channel", channelTypes: TEXT_CHANNEL_TYPES, required: enabled, showIf: enabled }),
      field({ key: "callWaitNoticeChannelId", label: "常設パネル・通知先", type: "channel", channelTypes: TEXT_CHANNEL_TYPES, required: enabled, showIf: enabled }),
      field({ key: "callWaitVoiceCategoryId", label: "参加確認VCカテゴリ（任意）", type: "channel", channelTypes: CATEGORY_TYPES, required: optional, showIf: enabled }),
      field({ key: "bosyuMentionRoleId", label: "募集通知ロール（任意）", type: "role", required: optional, showIf: enabled }),
    ]),
  }),
  vc_dm: Object.freeze({
      label: "vc_dm",
    fields: Object.freeze([
      field({ key: "vcDmEnabled", label: "VC DM有効状態", type: "boolean", choices: [{ label: "有効", value: "true" }, { label: "無効", value: "false" }] }),
      field({ key: "kokuchiEventTime", label: "週次処理の基準時刻（明示設定）", type: "string", choices: hourlyEventChoices, required: vcDmEventTimeRequired, showIf: vcDmEventTimeVisible }),
      field({ key: "vcDmPanelChannelId", label: "対象確認パネル先", type: "channel", channelTypes: TEXT_CHANNEL_TYPES, required: enabled, showIf: enabled }),
      field({ key: "vcDmTargetCategoryId", label: "対象VCカテゴリ", type: "channel", channelTypes: CATEGORY_TYPES, required: enabled, showIf: enabled }),
    ]),
  }),
  forms: Object.freeze({
    label: "forms",
    fields: Object.freeze([
      field({ key: "formChannelId", label: "フォーム設置先", type: "channel", channelTypes: TEXT_CHANNEL_TYPES }),
      field({ key: "formSendChannelId", label: "フォーム転送先", type: "channel", channelTypes: TEXT_CHANNEL_TYPES }),
      field({ key: "reviewSendChannelId", label: "感想送信先（任意）", type: "channel", channelTypes: TEXT_CHANNEL_TYPES, required: optional }),
      field({ key: "formModeratorRoleId", label: "モデレーターロール（任意）", type: "role", required: optional }),
    ]),
  }),
  profile: Object.freeze({
    label: "profile",
    fields: Object.freeze([
      field({ key: "profileIntroductionChannelId", label: "プロフィール公開先", type: "channel", channelTypes: PROFILE_TEXT_CHANNEL_TYPES }),
    ]),
  }),
  voice_control: Object.freeze({
    label: "voice_control",
    fields: Object.freeze([
      field({ key: "vcControlCategoryId", label: "VCコントロール対象カテゴリ", type: "channel", channelTypes: CATEGORY_TYPES }),
      field({ key: "vcControlNotifyRoleId", label: "通知ロール（任意）", type: "role", required: optional }),
    ]),
  }),
  status_board: Object.freeze({
    label: "status_board",
    fields: Object.freeze([
      field({ key: "statusBoardChannelId", label: "ステータスボード先（未設置なら解除）", type: "channel", channelTypes: TEXT_CHANNEL_TYPES, required: optional }),
    ]),
  }),
  fukyo: Object.freeze({
    label: "fukyo",
    fields: Object.freeze([
      field({ key: "fukyoWeeklyThemeEnabled", label: "布教週次投稿の有効状態", type: "boolean", choices: [{ label: "有効", value: "true" }, { label: "無効", value: "false" }] }),
      field({ key: "fukyoThemeChannelId", label: "布教テーマ投稿先", type: "channel", channelTypes: TEXT_CHANNEL_TYPES, required: enabled, showIf: enabled }),
    ]),
  }),
});

export function getSetupFeatureSchema(feature) {
  return SETUP_FEATURE_SCHEMAS[feature] ?? null;
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object ?? {}, key);
}

function mergedValues(feature, patch = {}, current = {}) {
  const schema = getSetupFeatureSchema(feature);
  const values = {};
  for (const item of schema?.fields ?? []) values[item.key] = hasOwn(patch, item.key) ? patch[item.key] : current?.[item.key];
  return values;
}

export function visibleSetupFields(feature, patch = {}, current = {}) {
  const schema = getSetupFeatureSchema(feature);
  if (!schema) return [];
  const values = mergedValues(feature, patch, current);
  return schema.fields.filter((item) => !item.showIf || item.showIf({ feature, patch, current, values }));
}

export function missingSetupFields(feature, patch = {}, current = {}) {
  const values = mergedValues(feature, patch, current);
  return visibleSetupFields(feature, patch, current)
    .filter((item) => item.required({ feature, patch, current, values }))
    .filter((item) => {
      const needsExplicitEventTime = feature === "vc_dm"
        && item.key === "kokuchiEventTime"
        && values.vcDmEnabled === true
        && (
          current?.kokuchiEventTimeConfigured !== true
          || hasOwn(patch, item.key) && (patch[item.key] === null || patch[item.key] === "")
        );
      if (needsExplicitEventTime) return !hasOwn(patch, item.key) || typeof patch[item.key] !== "string" || patch[item.key] === "";
      return !hasOwn(patch, item.key)
        ? values[item.key] === undefined || values[item.key] === null || values[item.key] === ""
        : patch[item.key] === undefined || patch[item.key] === null || patch[item.key] === "";
    });
}

export function setupFieldAt(feature, index, patch = {}, current = {}) {
  return visibleSetupFields(feature, patch, current)[Number(index)] ?? null;
}

export function firstSetupField(feature, patch = {}, current = {}) {
  return setupFieldAt(feature, 0, patch, current);
}

export function nextSetupField(feature, patch = {}, current = {}, currentKey = null) {
  const fields = visibleSetupFields(feature, patch, current);
  const index = fields.findIndex((item) => item.key === currentKey);
  return index < 0 ? fields[0] ?? null : fields[index + 1] ?? null;
}

export function validateSetupDraft(feature, patch = {}, current = {}) {
  const schema = getSetupFeatureSchema(feature);
  if (!schema) return { ok: false, missing: [], error: "この機能はセットアップ対象外です。" };
  const unsupported = Object.keys(patch ?? {}).filter((key) => !schema.fields.some((item) => item.key === key) || !ADMIN_CONFIGURATION_KEYS.has(key));
  const missing = missingSetupFields(feature, patch, current);
  const invalid = [];
  for (const item of schema.fields) {
    if (!hasOwn(patch, item.key) || patch[item.key] === null || patch[item.key] === undefined || patch[item.key] === "") continue;
    const value = patch[item.key];
    const valid = item.type === "boolean"
      ? typeof value === "boolean"
      : item.type === "string"
        ? typeof value === "string" && (!item.choices?.length || item.choices.some((choice) => choice.value === value))
        : item.type === "role" && item.key.endsWith("RoleIds")
          ? Array.isArray(value) && value.every((roleId) => typeof roleId === "string" && roleId.length > 0)
          : typeof value === "string" && value.length > 0;
    if (!valid) invalid.push(item);
  }
  return {
    ok: unsupported.length === 0 && missing.length === 0 && invalid.length === 0,
    missing,
    unsupported,
    invalid,
    values: mergedValues(feature, patch, current),
  };
}

export { CATEGORY_TYPES, PROFILE_TEXT_CHANNEL_TYPES, TEXT_CHANNEL_TYPES, VOICE_CHANNEL_TYPES };
