import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { OperationalActionLog } from "./models/operational-action-log.js";

const PREFIX = "operational";
const confirmationTokens = new Map();
const actionLabels = {
  kokuchi_cancel: "kokuchiを通常キャンセル",
  kokuchi_force_terminate: "kokuchiを強制終了",
  kokuchi_clear_state: "kokuchiの状態だけ解除",
  restore_gathering_vc: "集合VC権限を復元",
  remove_participant_roles: "参加者ロールを一括解除",
  reinstall_panels: "常設パネルを再確認・再設置",
  close_expired_recruitments: "期限切れ定時募集を終了",
};

function clean(value, max = 1800) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function actionResult(result) {
  if (["success", "canceled", "cleared", "restored", "not_needed"].includes(result?.result) || ["canceled", "cleared", "restored"].includes(result?.status)) return "success";
  if (["partial", "cancel_partial"].includes(result?.result) || result?.status === "partial") return "partial";
  return "failed";
}

function resultText(result) {
  const warnings = result?.warnings?.length ? `\n注意: ${result.warnings.map(clean).join(" / ")}` : "";
  const errors = result?.errors?.length ? `\nエラー: ${result.errors.map(clean).join(" / ")}` : "";
  return `${result?.status ?? "完了"}${result?.permissionRestored ? ` / 集合VC権限: ${result.permissionRestored}` : ""}${warnings}${errors}`;
}

async function reply(interaction, payload) {
  if (interaction.deferred || interaction.replied) return interaction.followUp({ ...payload, flags: payload.flags ?? MessageFlags.Ephemeral });
  return interaction.reply(payload);
}

export function createOperationalManagementService({
  statusService,
  boardService,
  recoveryService,
  actions = {},
  getGuildSettings = async () => null,
  sendOperationalLog = async () => null,
  logger = console,
} = {}) {
  if (!statusService || !boardService) throw new Error("statusService and boardService are required.");

  async function freshMember(interaction) {
    if (interaction.guild?.members?.fetch) return interaction.guild.members.fetch(interaction.user.id).catch(() => null);
    return interaction.member;
  }

  async function permission(interaction, required) {
    const member = await freshMember(interaction);
    const permissions = member?.permissions ?? interaction.memberPermissions;
    return Boolean(permissions?.has?.(required));
  }

  async function requireManageGuild(interaction) {
    if (await permission(interaction, PermissionFlagsBits.ManageGuild)) return true;
    await reply(interaction, { content: "この操作にはManageGuild権限が必要です。", flags: MessageFlags.Ephemeral });
    return false;
  }

  async function requireAdministrator(interaction) {
    if (await permission(interaction, PermissionFlagsBits.Administrator)) return true;
    await reply(interaction, { content: "この操作にはAdministrator権限が必要です。", flags: MessageFlags.Ephemeral });
    return false;
  }

  async function audit(interaction, actionType, result, before = null, after = null, targetId = null) {
    const entry = {
      guildId: interaction.guildId,
      actionType,
      actorUserId: interaction.user?.id ?? null,
      targetType: "operational",
      targetId,
      before,
      after,
      result: actionResult(result),
      errors: (result?.errors ?? []).map(clean).slice(0, 20),
      cleanupAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    };
    let durableRecorded = false;
    let operationalRecorded = false;
    try {
      await OperationalActionLog.create(entry);
      durableRecorded = true;
    } catch (error) {
      logger.error?.(`Operational audit log failed for ${interaction.guildId}: ${error?.message ?? error}`);
    }
    try {
      const settings = await getGuildSettings(interaction.guildId).catch(() => null);
      const sent = await sendOperationalLog({
        guild: interaction.guild,
        settings,
        fallbackChannel: null,
        content: `運用管理 action=${actionType} guildId=${interaction.guildId} actorUserId=${interaction.user?.id ?? "unknown"} result=${entry.result}${targetId ? ` targetId=${targetId}` : ""}${entry.errors.length ? ` errors=${entry.errors.join(" / ")}` : ""}`,
      });
      operationalRecorded = Boolean(sent);
    } catch (error) {
      logger.error?.(`Operational management log failed for ${interaction.guildId}: ${error?.message ?? error}`);
    }
    return { ...entry, auditStatus: durableRecorded && operationalRecorded ? "recorded" : durableRecorded || operationalRecorded ? "partial" : "failed" };
  }

  async function snapshot(guild) {
    return statusService.getOperationalStatusSnapshot(guild);
  }

  async function showDetailsMenu(interaction) {
    if (!(await requireManageGuild(interaction))) return;
    const current = await snapshot(interaction.guild);
    const options = Object.values(current.modules ?? {}).slice(0, 25).map((module) => ({ label: clean(module.label ?? module.key, 90), value: module.key, description: clean(module.summary, 90) || "状態詳細を表示" }));
    if (!options.length) return reply(interaction, { content: "表示できる状態がありません。", flags: MessageFlags.Ephemeral });
    const menu = new StringSelectMenuBuilder().setCustomId(`${PREFIX}:details_select:${interaction.guildId}`).setPlaceholder("確認する機能を選択").addOptions(options);
    return reply(interaction, { content: `要対応 ${current.attentionCount ?? 0}件 / 確認推奨 ${current.recommendationCount ?? 0}件\n詳細を表示する機能を選択してください。`, components: [new ActionRowBuilder().addComponents(menu)], flags: MessageFlags.Ephemeral });
  }

  async function showManageMenu(interaction) {
    if (!(await requireManageGuild(interaction))) return;
    const current = await snapshot(interaction.guild);
    const available = current.availableActions ?? [];
    const options = available.filter((action) => actionLabels[action]).slice(0, 25).map((action) => ({ label: actionLabels[action], value: action, description: action === "kokuchi_force_terminate" ? "Administratorと60秒以内の再確認が必要" : "最新状態を確認して実行" }));
    if (!options.length) return reply(interaction, { content: "現在実行可能な管理操作はありません。", flags: MessageFlags.Ephemeral });
    const menu = new StringSelectMenuBuilder().setCustomId(`${PREFIX}:manage_select:${interaction.guildId}`).setPlaceholder("実行する管理操作を選択").addOptions(options);
    return reply(interaction, { content: "破壊的操作はここに直接配置せず、選択後に最新状態と権限を再確認します。", components: [new ActionRowBuilder().addComponents(menu)], flags: MessageFlags.Ephemeral });
  }

  async function showKokuchiTargetMenu(interaction, current, action) {
    const candidates = current.modules?.kokuchi?.details?.candidates ?? [];
    const options = candidates.slice(0, 25).map((candidate) => ({
      label: clean(`${candidate.status} / ${candidate.reservationId}`, 100),
      value: candidate.reservationId,
      description: clean(candidate.eventAt ? new Date(candidate.eventAt).toLocaleString("ja-JP") : "開催日時未設定", 100),
    }));
    if (!options.length) return reply(interaction, { content: "現在の開催回候補を取得できません。最新状態からやり直してください。", flags: MessageFlags.Ephemeral });
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`${PREFIX}:kokuchi_target_select:${interaction.guildId}:${action}`)
      .setPlaceholder("対象の開催回を選択")
      .addOptions(options);
    return reply(interaction, { content: "複数の開催回候補があります。対象を選択してから操作を続けてください。", components: [new ActionRowBuilder().addComponents(menu)], flags: MessageFlags.Ephemeral });
  }

  async function showModuleDetails(interaction) {
    if (!(await requireManageGuild(interaction))) return;
    const current = await snapshot(interaction.guild);
    const module = current.modules?.[interaction.values?.[0]];
    if (!module) return reply(interaction, { content: "選択した状態は見つかりません。もう一度ボードから開いてください。", flags: MessageFlags.Ephemeral });
    const detail = JSON.stringify(module.details ?? {}, null, 2);
    const issues = (module.issues ?? []).map((item) => `・${clean(item.message ?? item, 500)}`).join("\n") || "なし";
    return reply(interaction, { content: `【${module.label}】 ${module.severity}\n${clean(module.summary)}\n\n問題:\n${clean(issues, 700)}\n\n詳細:\n\`\`\`json\n${clean(detail, 900)}\n\`\`\``, flags: MessageFlags.Ephemeral });
  }

  async function showForceConfirmation(interaction, targetId = null) {
    if (!(await requireAdministrator(interaction))) return;
    const token = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    confirmationTokens.set(token, { guildId: interaction.guildId, targetId, expiresAt: Date.now() + 60_000 });
    setTimeout(() => confirmationTokens.delete(token), 60_000).unref?.();
    return reply(interaction, { content: "現在の状態を実行直前に再取得してkokuchiを強制終了します。投稿済み告知・送信済み通知・splitvc・参加者ロールは変更しません。60秒以内に再確認してください。", components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`${PREFIX}:confirm_force:${interaction.guildId}:${token}`).setLabel("強制終了を実行").setStyle(ButtonStyle.Danger))], flags: MessageFlags.Ephemeral });
  }

  async function showClearModal(interaction, targetId = null) {
    if (!(await requireAdministrator(interaction))) return;
    const modal = new ModalBuilder().setCustomId(`${PREFIX}:clear_modal:${interaction.guildId}`).setTitle("kokuchi状態だけ解除");
    const reason = new TextInputBuilder().setCustomId("reason").setLabel("実権限を確認した理由").setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(500).setPlaceholder("集合VCの実際の権限を確認し、必要な手動修正を完了した理由");
    modal.setCustomId(`${PREFIX}:clear_modal:${interaction.guildId}:${targetId ?? ""}`);
    return interaction.showModal(modal.addComponents(new ActionRowBuilder().addComponents(reason)));
  }

  async function executeAction(interaction, action, targetId = null) {
    const current = await snapshot(interaction.guild);
    if (!current.availableActions?.includes(action) && action !== "kokuchi_force_terminate" && action !== "kokuchi_clear_state") {
      return { status: "rejected", errors: ["操作対象が最新状態では実行可能でなくなりました。"] };
    }
    if (action === "kokuchi_cancel") return recoveryService.normalCancel({ guild: interaction.guild, actorUserId: interaction.user.id, targetId });
    if (action === "kokuchi_force_terminate") return recoveryService.forceTerminate({ guild: interaction.guild, actorUserId: interaction.user.id, targetId });
    if (action === "restore_gathering_vc") return recoveryService.restorePermission({ guild: interaction.guild, actorUserId: interaction.user.id, targetId });
    if (action === "kokuchi_clear_state") return recoveryService.clearStateOnly({ guild: interaction.guild, actorUserId: interaction.user.id, targetId, confirmed: true, reason: "Administrator confirmed the gathering VC permissions before state-only recovery." });
    if (action === "remove_participant_roles") return actions.removeParticipantRoles?.(interaction.guild, interaction) ?? { status: "failed", errors: ["参加者ロール解除処理が接続されていません。"] };
    if (action === "reinstall_panels") return actions.reinstallPanels?.(interaction.guild, interaction) ?? { status: "failed", errors: ["パネル再設置処理が接続されていません。"] };
    if (action === "close_expired_recruitments") return actions.closeExpiredRecruitments?.(interaction.guild, interaction) ?? { status: "failed", errors: ["期限切れ募集終了処理が接続されていません。"] };
    return { status: "rejected", errors: [`未対応の操作: ${action}`] };
  }

  async function executeAndReport(interaction, action, targetId = null) {
    const before = await snapshot(interaction.guild).catch(() => null);
    const result = await executeAction(interaction, action, targetId).catch((error) => ({ status: "failed", result: "failed", errors: [clean(error?.message ?? error)] }));
    const after = await snapshot(interaction.guild).catch(() => null);
    const auditResult = await audit(interaction, action, result, result.before ?? before, result.after ?? after, targetId);
    if (auditResult.auditStatus !== "recorded") {
      result.errors = [...(result.errors ?? []), `Operational audit recording status: ${auditResult.auditStatus}`];
      if (actionResult(result) === "success") {
        result.status = "partial";
        result.result = "partial";
      }
    }
    await boardService.requestRefresh(interaction.guild, `management:${action}`).catch(() => {});
    return result;
  }

  async function handleCommand(interaction) {
    if (!interaction.inGuild?.()) return reply(interaction, { content: "このコマンドはサーバー内で使用してください。", flags: MessageFlags.Ephemeral });
    const subcommand = interaction.options.getSubcommand();
    if (subcommand === "show") {
      if (!(await requireManageGuild(interaction))) return;
      const current = await snapshot(interaction.guild);
      const payload = boardService.buildPayload(current);
      return reply(interaction, { ...payload, flags: MessageFlags.Ephemeral });
    }
    if (subcommand === "refresh") {
      if (!(await requireManageGuild(interaction))) return;
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const result = await boardService.refresh(interaction.guild, "manual-command");
      return interaction.editReply({ content: `ステータスを再確認しました: ${result.status}`, embeds: [], components: [] });
    }
    if (subcommand === "manage") return showManageMenu(interaction);
    return reply(interaction, { content: "不明なbotstatus操作です。", flags: MessageFlags.Ephemeral });
  }

  async function handle(interaction) {
    if (!interaction.customId?.startsWith(`${PREFIX}:`) || !interaction.guild) return false;
    const parts = interaction.customId.split(":");
    const operation = parts[1];
    if (parts[2] !== interaction.guildId) return false;
    if (interaction.isButton()) {
      if (operation === "refresh") {
        if (!(await requireManageGuild(interaction))) return true;
        await interaction.deferUpdate();
        const result = await boardService.refresh(interaction.guild, "manual-button");
        await interaction.followUp({ content: `ステータスボードを更新しました: ${result.status}`, flags: MessageFlags.Ephemeral });
        return true;
      }
      if (operation === "details") { await showDetailsMenu(interaction); return true; }
      if (operation === "manage") { await showManageMenu(interaction); return true; }
      if (operation === "confirm_force") {
        if (!(await requireAdministrator(interaction))) return true;
        const token = parts[3];
        const confirmation = confirmationTokens.get(token);
        if (!confirmation || confirmation.guildId !== interaction.guildId || confirmation.expiresAt <= Date.now()) return reply(interaction, { content: "確認画面の有効期限が切れています。最新の状態からやり直してください。", flags: MessageFlags.Ephemeral });
        confirmationTokens.delete(token);
        await interaction.deferUpdate();
        const result = await executeAndReport(interaction, "kokuchi_force_terminate", confirmation.targetId ?? null);
        return interaction.followUp({ content: `kokuchi強制終了: ${resultText(result)}`, flags: MessageFlags.Ephemeral });
      }
      return false;
    }
    if (interaction.isStringSelectMenu()) {
      if (operation === "details_select") { await showModuleDetails(interaction); return true; }
      if (operation === "kokuchi_target_select") {
        if (!(await requireManageGuild(interaction))) return true;
        const action = parts[3];
        if (!["kokuchi_cancel", "kokuchi_force_terminate", "kokuchi_clear_state", "restore_gathering_vc"].includes(action)) return false;
        const current = await snapshot(interaction.guild);
        const targetId = interaction.values?.[0];
        const candidate = current.modules?.kokuchi?.details?.candidates?.find((item) => item.reservationId === targetId);
        if (!candidate) return reply(interaction, { content: "選択した開催回は最新状態に存在しません。もう一度管理メニューを開いてください。", flags: MessageFlags.Ephemeral });
        if (action === "kokuchi_force_terminate") {
          await showForceConfirmation(interaction, targetId);
          return true;
        }
        if (action === "kokuchi_clear_state") {
          await showClearModal(interaction, targetId);
          return true;
        }
        await interaction.deferUpdate();
        const result = await executeAndReport(interaction, action, targetId);
        await interaction.followUp({ content: `${actionLabels[action] ?? action}: ${resultText(result)}`, flags: MessageFlags.Ephemeral });
        return true;
      }
      if (operation === "manage_select") {
        if (!(await requireManageGuild(interaction))) return true;
        const action = interaction.values?.[0];
        if (action === "kokuchi_force_terminate" || action === "kokuchi_clear_state") {
          if (action === "kokuchi_clear_state") {
            const current = await snapshot(interaction.guild);
            const candidates = current.modules?.kokuchi?.details?.candidates ?? [];
            if (candidates.length > 1) await showKokuchiTargetMenu(interaction, current, action);
            else await showClearModal(interaction, candidates[0]?.reservationId ?? null);
          } else {
            const current = await snapshot(interaction.guild);
            if ((current.modules?.kokuchi?.details?.candidates?.length ?? 0) > 1) await showKokuchiTargetMenu(interaction, current, action);
            else await showForceConfirmation(interaction);
          }
          return true;
        }
        if (action === "restore_gathering_vc") {
          const current = await snapshot(interaction.guild);
          if ((current.modules?.kokuchi?.details?.candidates?.length ?? 0) > 1) {
            await showKokuchiTargetMenu(interaction, current, action);
            return true;
          }
        }
        if (action === "kokuchi_cancel") {
          const current = await snapshot(interaction.guild);
          if ((current.modules?.kokuchi?.details?.candidates?.length ?? 0) > 1) {
            await showKokuchiTargetMenu(interaction, current, action);
            return true;
          }
        }
        await interaction.deferUpdate();
        const result = await executeAndReport(interaction, action);
        await interaction.followUp({ content: `${actionLabels[action] ?? action}: ${resultText(result)}`, flags: MessageFlags.Ephemeral });
        return true;
      }
      return false;
    }
    if (interaction.isModalSubmit() && operation === "clear_modal") {
      if (!(await requireAdministrator(interaction))) return true;
      const reason = interaction.fields.getTextInputValue("reason");
      const targetId = parts[3] || null;
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const result = await recoveryService.clearStateOnly({ guild: interaction.guild, actorUserId: interaction.user.id, targetId, confirmed: true, reason });
      const auditResult = await audit(interaction, "kokuchi_clear_state", result, result.before ?? null, result.after ?? await snapshot(interaction.guild).catch(() => null));
      if (auditResult.auditStatus !== "recorded") {
        result.errors = [...(result.errors ?? []), `Operational audit recording status: ${auditResult.auditStatus}`];
        if (actionResult(result) === "success") {
          result.status = "partial";
          result.result = "partial";
        }
      }
      await boardService.requestRefresh(interaction.guild, "management:kokuchi_clear_state").catch(() => {});
      await interaction.editReply(`kokuchi状態だけ解除: ${resultText(result)}`);
      return true;
    }
    return false;
  }

  return { handle, handleCommand, audit, actionLabels };
}
