import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  MessageFlags,
  PermissionFlagsBits,
  RoleSelectMenuBuilder,
  StringSelectMenuBuilder,
} from "discord.js";
import { diffConfiguration } from "../settings-configuration.js";
import {
  firstSetupField,
  getSetupFeatureSchema,
  nextSetupField,
  validateSetupDraft,
  visibleSetupFields,
} from "../setup-schema.js";
import { SETUP_DRAFT_FEATURES } from "../models/setup-draft.js";

const MAX_CONTENT = 1_900;
const SETUP_PREFIX = "setup";
const FEATURE_STEP = "feature";
const REVIEW_STEP = "review";

const FEATURE_LABELS = Object.freeze({
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

function checkbotGuide(feature) {
  return `/checkbot feature:${feature}`;
}

function featureCompletionGuide(feature) {
  return feature === "forms" ? "\nフォームのボタン設置は設定確定後に /setupforms を実行してください。" : "";
}

function hasManageGuild(interaction) {
  try {
    return Boolean(interaction?.memberPermissions?.has?.(PermissionFlagsBits.ManageGuild));
  } catch {
    return false;
  }
}

function cleanText(value, max = 500) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/<@!?&?#?\d+>/g, "[mention]")
    .replace(/\s+/g, " ")
    .slice(0, max);
}

function safeContent(value, max = MAX_CONTENT) {
  const text = cleanText(value, max);
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}

function payload(content, components = []) {
  return {
    content: safeContent(content),
    components,
    allowedMentions: { parse: [] },
  };
}

function valueText(value) {
  if (value === undefined || value === null || value === "") return "未設定";
  if (typeof value === "boolean") return value ? "有効" : "無効";
  if (Array.isArray(value)) return value.length ? value.join(", ") : "未設定";
  return cleanText(value, 240);
}

function fieldValue(draft, current, key) {
  return Object.prototype.hasOwnProperty.call(draft?.patch ?? {}, key)
    ? draft.patch[key]
    : current?.[key];
}

function id(action, sessionId, key = null) {
  const value = key ? `${SETUP_PREFIX}:${action}:${sessionId}:${key}` : `${SETUP_PREFIX}:${action}:${sessionId}`;
  if (value.length > 100) throw new Error("Setup component customId exceeds Discord's 100-character limit.");
  return value;
}

function featureOptions() {
  return SETUP_DRAFT_FEATURES.map((feature) => ({ label: FEATURE_LABELS[feature], value: feature }));
}

function commonButtons(sessionId, { includeBack = false, includeCancel = true } = {}) {
  const buttons = [];
  if (includeBack) buttons.push(new ButtonBuilder().setCustomId(id("back", sessionId)).setLabel("戻る").setStyle(ButtonStyle.Secondary));
  if (includeCancel) buttons.push(new ButtonBuilder().setCustomId(id("cancel", sessionId)).setLabel("キャンセル").setStyle(ButtonStyle.Danger));
  return buttons;
}

function formatPatch(patch = {}) {
  const entries = Object.entries(patch);
  if (!entries.length) return "（今回の変更はありません）";
  return entries.map(([key, value]) => `${key}: ${valueText(value)}`).join("\n");
}

function plannedConfigurationPatch(patch = {}) {
  return {
    ...patch,
    ...(Object.prototype.hasOwnProperty.call(patch, "kokuchiEventTime")
      ? { kokuchiEventTimeConfigured: typeof patch.kokuchiEventTime === "string" && patch.kokuchiEventTime.length > 0 }
      : {}),
  };
}

function formatDiff(diff) {
  const lines = [];
  for (const item of diff?.added ?? []) lines.push(`追加 ${item.key}: ${valueText(item.to)}`);
  for (const item of diff?.changed ?? []) lines.push(`変更 ${item.key}: ${valueText(item.from)} → ${valueText(item.to)}`);
  for (const item of diff?.removed ?? []) lines.push(`解除 ${item.key}: ${valueText(item.from)}`);
  return lines.length ? lines.join("\n") : "（現在設定との差分はありません）";
}

function fieldFromStep(draft, current) {
  if (!draft?.feature || !draft.step?.startsWith("field:")) return null;
  return visibleSetupFields(draft.feature, draft.patch, current)
    .find((field) => field.key === draft.step.slice("field:".length)) ?? null;
}

function stepForField(field) {
  return field ? `field:${field.key}` : REVIEW_STEP;
}

function choiceValue(field, value) {
  if (field.type === "boolean") return value === "true";
  return value;
}

function selectedId(interaction) {
  return interaction?.values?.[0] ?? null;
}

function cacheGet(cache, idValue) {
  if (!cache || !idValue) return null;
  if (typeof cache.get === "function") return cache.get(idValue) ?? null;
  return cache[idValue] ?? null;
}

function resourceGuildId(resource) {
  return resource?.guildId ?? resource?.guild?.id ?? resource?.guildID ?? null;
}

function channelKindMatches(channel, field) {
  if (!channel) return false;
  if (!field.channelTypes?.length) return true;
  return field.channelTypes.includes(channel.type);
}

async function resolveSelectedResource(guild, interaction, field, resourceId) {
  if (!resourceId) throw new Error(`${field.label}を選択してください。`);
  let resource = field.type === "role"
    ? cacheGet(interaction?.roles, resourceId) ?? cacheGet(guild?.roles?.cache, resourceId)
    : cacheGet(interaction?.channels, resourceId) ?? cacheGet(guild?.channels?.cache, resourceId);
  if (!resource) {
    const manager = field.type === "role" ? guild?.roles : guild?.channels;
    if (typeof manager?.fetch !== "function") throw new Error(`${field.label}を再確認できません。もう一度選択してください。`);
    resource = await manager.fetch(resourceId);
  }
  if (!resource || (resourceGuildId(resource) && resourceGuildId(resource) !== guild?.id)) {
    throw new Error(`${field.label}はこのサーバーの対象ではありません。`);
  }
  if (field.type === "channel" && !channelKindMatches(resource, field)) {
    throw new Error(`${field.label}の種別が想定と異なります。`);
  }
  if (field.type === "role" && resource.type !== undefined) {
    throw new Error(`${field.label}にはロールを指定してください。`);
  }
  if (field.type === "role" && resource.id === guild?.id) {
    throw new Error(`${field.label}には@everyoneを指定できません。`);
  }
  return resource;
}

export function createSetupFeature({
  draftService,
  getGuildSettings,
  configurationService = null,
  logger = console,
} = {}) {
  if (!draftService) throw new Error("draftService is required.");
  if (typeof getGuildSettings !== "function") throw new Error("getGuildSettings is required.");

  async function currentSettings(guildId) {
    try {
      return await getGuildSettings(guildId);
    } catch (error) {
      logger.warn?.(`Setup settings read failed for guild=${guildId}: ${error?.message ?? error}`);
      return {};
    }
  }

  async function respondInitial(interaction, content, components = []) {
    const body = payload(content, components);
    if (interaction.deferred || interaction.replied) return interaction.editReply(body);
    return interaction.reply({ ...body, flags: MessageFlags.Ephemeral });
  }

  async function acknowledgeComponent(interaction) {
    if (interaction.deferred || interaction.replied) return;
    if (typeof interaction.deferUpdate === "function") await interaction.deferUpdate();
  }

  async function ensureComponentAccess(interaction) {
    if (!interaction?.inGuild?.() || !interaction.guildId) {
      await respondInitial(interaction, "このセットアップ操作はサーバー内で使ってください。");
      return false;
    }
    if (!hasManageGuild(interaction)) {
      await respondInitial(interaction, "セットアップ開始後もサーバー管理権限が必要です。権限を確認してから再実行してください。");
      return false;
    }
    return true;
  }

  async function showFeatureChooser(interaction, draft, heading = "設定する機能を選択してください。") {
    const rows = [new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(id("feature", draft.sessionId))
        .setPlaceholder("機能を選択")
        .setMinValues(1)
        .setMaxValues(1)
        .addOptions(featureOptions()),
    )];
    const buttons = commonButtons(draft.sessionId);
    if (buttons.length) rows.push(new ActionRowBuilder().addComponents(buttons));
    await respondInitial(interaction, `${heading}\n下書きID: ${draft.sessionId}\n基準リビジョン: r${draft.baseRevision}\n権限診断は確定前後に /checkbot で確認してください。`, rows);
  }

  async function showField(interaction, draft, current = null) {
    const settings = current ?? await currentSettings(draft.guildId);
    const field = fieldFromStep(draft, settings);
    if (!field) return showReview(interaction, draft, settings);
    const rows = [];
    let selector;
    if (field.type === "channel") {
      selector = new ChannelSelectMenuBuilder()
        .setCustomId(id("channel", draft.sessionId, field.key))
        .setPlaceholder(field.label)
        .setMinValues(1)
        .setMaxValues(1);
      if (field.channelTypes?.length) selector.setChannelTypes(...field.channelTypes);
    } else if (field.type === "role") {
      selector = new RoleSelectMenuBuilder()
        .setCustomId(id("role", draft.sessionId, field.key))
        .setPlaceholder(field.label)
        .setMinValues(1)
        .setMaxValues(1);
    } else {
      selector = new StringSelectMenuBuilder()
        .setCustomId(id("value", draft.sessionId, field.key))
        .setPlaceholder(field.label)
        .setMinValues(1)
        .setMaxValues(1)
        .addOptions((field.choices ?? []).map((choice) => ({ label: choice.label, value: choice.value })));
    }
    rows.push(new ActionRowBuilder().addComponents(selector));
    const controls = [];
    if (!field.required({ feature: draft.feature, patch: draft.patch, current: settings, values: { ...settings, ...draft.patch } })) {
      controls.push(new ButtonBuilder().setCustomId(id("keep", draft.sessionId, field.key)).setLabel("現在値を維持").setStyle(ButtonStyle.Secondary));
      controls.push(new ButtonBuilder().setCustomId(id("clear", draft.sessionId, field.key)).setLabel("設定を解除").setStyle(ButtonStyle.Secondary));
    }
    controls.push(...commonButtons(draft.sessionId, { includeBack: true }));
    if (controls.length) rows.push(new ActionRowBuilder().addComponents(...controls));
    const existing = fieldValue(draft, settings, field.key);
    await respondInitial(interaction, `【${FEATURE_LABELS[draft.feature]}】\n${field.label}を選択してください。\n現在値: ${valueText(existing)}\n\n値の詳細調整は保存後に /setting ${draft.feature} を利用できます。\n権限診断は ${checkbotGuide(draft.feature)} で確認してください。`, rows);
  }

  async function showReview(interaction, draft, current = null) {
    const settings = current ?? await currentSettings(draft.guildId);
    const validation = validateSetupDraft(draft.feature, draft.patch, settings);
    const currentRevision = Number(settings?.configRevision ?? 0);
    const reviewPatch = plannedConfigurationPatch(draft.patch);
    const next = { ...settings, ...reviewPatch };
    const diff = diffConfiguration(settings, next);
    const missing = validation.missing.map((field) => field.label);
    const invalid = (validation.invalid ?? []).map((field) => field.label);
    const content = [
      `【${FEATURE_LABELS[draft.feature] ?? "機能"} セットアップ確認】`,
      `現在リビジョン: r${currentRevision} / 下書き基準: r${draft.baseRevision}`,
      "",
      "予定差分:",
      formatDiff(diff),
      "",
      `下書き値:\n${formatPatch(reviewPatch)}`,
      missing.length ? `\n未入力の必須項目: ${missing.join("、")}` : "\n必須項目は入力済みです。",
      invalid.length ? `\n値を再確認してください: ${invalid.join("、")}` : "",
      `\n権限診断は ${checkbotGuide(draft.feature)} で確認してください（このウィザードでは権限変更を行いません）。`,
    ].join("\n");
    const controls = [];
    if (validation.ok) controls.push(new ButtonBuilder().setCustomId(id("confirm", draft.sessionId)).setLabel("この内容で確定").setStyle(ButtonStyle.Success));
    controls.push(new ButtonBuilder().setCustomId(id("back", draft.sessionId)).setLabel("戻る").setStyle(ButtonStyle.Secondary));
    controls.push(new ButtonBuilder().setCustomId(id("cancel", draft.sessionId)).setLabel("キャンセル").setStyle(ButtonStyle.Danger));
    await respondInitial(interaction, content, [new ActionRowBuilder().addComponents(controls)]);
  }

  async function render(interaction, draft) {
    if (!draft?.feature || draft.step === FEATURE_STEP) return showFeatureChooser(interaction, draft, draft.feature ? "機能を選択してください。" : "設定する機能を選択してください。");
    const settings = await currentSettings(draft.guildId);
    if (draft.step === REVIEW_STEP) return showReview(interaction, draft, settings);
    return showField(interaction, draft, settings);
  }

  async function handleSetup(interaction) {
    if (!interaction?.inGuild?.() || !interaction.guildId) {
      await respondInitial(interaction, "このコマンドはサーバー内で使ってください。");
      return;
    }
    if (!hasManageGuild(interaction)) {
      await respondInitial(interaction, "この操作にはサーバー管理権限が必要です。");
      return;
    }
    if (typeof interaction.deferReply === "function" && !interaction.deferred && !interaction.replied) await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const result = await draftService.startDraft({ guildId: interaction.guildId, actorUserId: interaction.user?.id });
    if (result.status === "busy") {
      await respondInitial(interaction, "このサーバーでは別の管理者がセットアップ中です。既存の下書きが終了してから再実行してください。");
      return;
    }
    await render(interaction, result.draft);
  }

  async function loadOwnedDraft(interaction, sessionId, includeInactive = false) {
    const draft = await draftService.getDraft(sessionId, {
      guildId: interaction.guildId,
      actorUserId: interaction.user?.id,
      includeInactive,
    });
    if (!draft || (!includeInactive && draft.status !== "active")) throw new Error("このセットアップ下書きは見つからないか、期限切れです。/setup で新しい下書きを開始してください。");
    if (draft.guildId !== interaction.guildId || draft.actorUserId !== interaction.user?.id) throw new Error("この下書きを操作する権限がありません。");
    return draft;
  }

  async function handleFeatureSelection(interaction, draft) {
    if (draft.step !== FEATURE_STEP) throw new Error("この機能選択は現在の手順ではありません。");
    const feature = selectedId(interaction);
    if (!SETUP_DRAFT_FEATURES.includes(feature)) throw new Error("セットアップ対象外の機能です。");
    const settings = await currentSettings(draft.guildId);
    const field = firstSetupField(feature, {}, settings);
    const updated = await draftService.selectFeature({ sessionId: draft.sessionId, guildId: draft.guildId, actorUserId: draft.actorUserId, feature, firstStep: stepForField(field) });
    await render(interaction, updated);
  }

  async function handleFieldSelection(interaction, draft, action, key) {
    const settings = await currentSettings(draft.guildId);
    const field = visibleSetupFields(draft.feature, draft.patch, settings).find((item) => item.key === key);
    if (!field || !fieldFromStep(draft, settings) || fieldFromStep(draft, settings).key !== key) throw new Error("このセットアップ項目は現在の手順ではありません。");
    let value;
    if (action === "keep" || action === "clear") {
      if (field.required({ feature: draft.feature, patch: draft.patch, current: settings, values: { ...settings, ...draft.patch } })) throw new Error(`${field.label}は必須項目です。`);
      if (action === "keep") {
        const nextPatch = { ...(draft.patch ?? {}) };
        delete nextPatch[key];
        const next = nextSetupField(draft.feature, nextPatch, settings, key);
        const updated = await draftService.removePatchKey({
          sessionId: draft.sessionId,
          guildId: draft.guildId,
          actorUserId: draft.actorUserId,
          key,
          feature: draft.feature,
          step: stepForField(next),
        });
        await render(interaction, updated);
        return;
      }
      value = null;
    } else if (field.type === "channel" || field.type === "role") {
      const resource = await resolveSelectedResource(interaction.guild, interaction, field, selectedId(interaction));
      value = resource.id;
    } else {
      const selected = selectedId(interaction);
      if (!(field.choices ?? []).some((choice) => choice.value === selected)) throw new Error("選択値が不正です。");
      value = choiceValue(field, selected);
    }
    if (field.key === "kokuchiMentionRoleIds") value = value === null ? null : [value];
    const merged = await draftService.mergePatch({ sessionId: draft.sessionId, guildId: draft.guildId, actorUserId: draft.actorUserId, patch: { [key]: value } });
    const next = nextSetupField(draft.feature, merged.patch, settings, key);
    const updated = await draftService.updateDraft({ sessionId: merged.sessionId, guildId: merged.guildId, actorUserId: merged.actorUserId, feature: merged.feature, step: stepForField(next), patch: merged.patch });
    await render(interaction, updated);
  }

  async function handleBack(interaction, draft) {
    const settings = await currentSettings(draft.guildId);
    if (draft.step === REVIEW_STEP) {
      const fields = (getSetupFeatureSchema(draft.feature)?.fields ?? []).filter((item) => !item.showIf || item.showIf({ feature: draft.feature, patch: draft.patch, current: settings, values: { ...settings, ...draft.patch } }));
      const previous = fields.at(-1);
      const updated = await draftService.updateDraft({ ...draft, step: stepForField(previous), patch: draft.patch });
      await render(interaction, updated);
      return;
    }
    if (draft.step?.startsWith("field:")) {
      const fields = (getSetupFeatureSchema(draft.feature)?.fields ?? []).filter((item) => !item.showIf || item.showIf({ feature: draft.feature, patch: draft.patch, current: settings, values: { ...settings, ...draft.patch } }));
      const index = fields.findIndex((item) => item.key === draft.step.slice("field:".length));
      if (index <= 0) {
        // Returning to feature selection starts a new feature draft.  Clear
        // the previous feature's values so a stale interaction can never
        // carry unrelated catalog keys into the next confirmation.
        const updated = await draftService.updateDraft({ ...draft, feature: null, step: FEATURE_STEP, patch: {} });
        await render(interaction, updated);
        return;
      }
      const updated = await draftService.updateDraft({ ...draft, step: stepForField(fields[index - 1]), patch: draft.patch });
      await render(interaction, updated);
      return;
    }
    await render(interaction, draft);
  }

  async function handleComponent(interaction) {
    const parts = String(interaction.customId ?? "").split(":");
    if (parts[0] !== SETUP_PREFIX || !parts[1] || !parts[2]) return false;
    if (!await ensureComponentAccess(interaction)) return true;
    await acknowledgeComponent(interaction);
    try {
      const action = parts[1];
      const sessionId = parts[2];
      const key = parts[3] ?? null;
      const draft = await loadOwnedDraft(interaction, sessionId, action === "cancel" || action === "confirm");
      if (action === "cancel") {
        if (draft.status !== "active") throw new Error("この下書きはすでに確定または終了しています。");
        await draftService.cancelDraft({ sessionId, guildId: interaction.guildId, actorUserId: interaction.user?.id });
        await respondInitial(interaction, "セットアップをキャンセルしました。GuildSettingsは変更していません。");
        return true;
      }
      if (draft.status !== "active") throw new Error("この下書きは現在操作できません。/setup で状態を確認してください。");
      if (action === "feature") await handleFeatureSelection(interaction, draft);
      else if (["channel", "role", "value", "keep", "clear"].includes(action)) await handleFieldSelection(interaction, draft, action, key);
      else if (action === "back") await handleBack(interaction, draft);
      else if (action === "review") await showReview(interaction, draft);
      else if (action === "confirm") {
        if (draft.step !== REVIEW_STEP) throw new Error("確認できるのはレビュー画面からだけです。古いボタンは使用できません。");
        const result = await draftService.commitDraft({ sessionId, guildId: interaction.guildId, actorUserId: interaction.user?.id });
        if (result.status === "completed") {
          const applyStatus = result.apply?.status ? `適用ジョブ: ${cleanText(result.apply.status, 80)}` : "適用ジョブは /config apply_status で確認できます。";
          await respondInitial(interaction, `セットアップをr${result.revision}として確定しました。\n${applyStatus}\n権限診断: ${checkbotGuide(result.draft.feature)}${featureCompletionGuide(result.draft.feature)}`);
        } else if (result.status === "conflict") {
          await respondInitial(interaction, "設定が別の管理者によって先に更新されました。上書きは行っていません。新しい /setup を開始してください。");
        } else if (result.status === "unknown") {
          await respondInitial(interaction, "確定処理の結果を確認できませんでした。再確定は行っていません。/config show で現在リビジョンを確認し、新しい /setup を開始してください。");
        } else {
          await respondInitial(interaction, "セットアップの確定に失敗しました。設定の再確定は行っていません。新しい /setup を開始してください。");
        }
      } else throw new Error("未知のセットアップ操作です。");
      return true;
    } catch (error) {
      logger.warn?.(`Setup interaction failed: ${error?.message ?? error}`);
      await respondInitial(interaction, cleanText(error?.message ?? "セットアップを処理できませんでした。"));
      return true;
    }
  }

  return {
    handleSetup,
    handleInteraction: handleComponent,
    customIdPrefix: `${SETUP_PREFIX}:`,
  };
}

export {
  FEATURE_LABELS,
  FEATURE_STEP,
  REVIEW_STEP,
  SETUP_PREFIX,
  id as buildSetupCustomId,
};
