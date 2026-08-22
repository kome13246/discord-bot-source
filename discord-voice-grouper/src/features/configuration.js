import { MessageFlags, PermissionFlagsBits } from "discord.js";

const MAX_CONTENT = 1_900;
const MAX_CHUNKS = 8;

function cleanText(value, max = 800) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/<@!?&?#?\d+>/g, "[mention]")
    .slice(0, max);
}

function formatValue(value) {
  if (value === undefined) return "未設定";
  if (value === null) return "null";
  if (typeof value === "string") return cleanText(value);
  try {
    return cleanText(JSON.stringify(value), 800);
  } catch {
    return "[表示不可]";
  }
}

function splitText(text, max = MAX_CONTENT) {
  const output = [];
  let current = "";
  for (const line of String(text ?? "").split("\n")) {
    if (line.length > max) {
      if (current) output.push(current);
      for (let offset = 0; offset < line.length; offset += max) output.push(line.slice(offset, offset + max));
      current = "";
      continue;
    }
    const next = current ? `${current}\n${line}` : line;
    if (next.length > max && current) {
      output.push(current);
      current = line;
    } else current = next;
  }
  if (current || output.length === 0) output.push(current);
  return output;
}

function formatSnapshot(snapshot = {}) {
  const entries = Object.entries(snapshot).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) return "（設定値はありません）";
  return entries.map(([key, value]) => `${key}: ${formatValue(value)}`).join("\n");
}

function formatHistory(rows) {
  if (!rows.length) return "履歴はありません。現在の構成リビジョンは 0 です。";
  return rows.map((row) => {
    const changes = row.changes ?? {};
    const count = Number(changes.count ?? 0);
    const actor = cleanText(row.actorUserId ?? "不明", 128);
    const source = cleanText(row.source ?? "unknown", 100);
    const reason = row.reason ? ` / ${cleanText(row.reason, 200)}` : "";
    const parsedDate = row.createdAt ? new Date(row.createdAt) : null;
    const createdAt = parsedDate && !Number.isNaN(parsedDate.getTime())
      ? cleanText(parsedDate.toISOString(), 40)
      : "日時不明";
    return `r${row.revision} (base r${row.baseRevision ?? 0}) ${createdAt}\nactor=${actor} source=${source}${reason}\n変更 ${count}件`;
  }).join("\n\n");
}

function formatDiff(result) {
  const changes = result?.changes ?? {};
  const lines = [`r${result.fromRevision} → r${result.toRevision}`];
  for (const entry of changes.added ?? []) lines.push(`追加 ${entry.key}: ${formatValue(entry.to)}`);
  for (const entry of changes.changed ?? []) lines.push(`変更 ${entry.key}: ${formatValue(entry.from)} → ${formatValue(entry.to)}`);
  for (const entry of changes.removed ?? []) lines.push(`削除 ${entry.key}: ${formatValue(entry.from)}`);
  if (lines.length === 1) lines.push("差分はありません。");
  return lines.join("\n");
}

function formatApplyJob(job) {
  if (!job) return "適用ジョブはまだ確認できません（設定保存のみ完了している可能性があります）。";
  const manual = Number(job.manualRetryCount ?? 0);
  const manualLimit = Number(job.maxManualRetries ?? 3);
  const statusLabels = {
    pending: "待機中",
    processing: "適用中",
    applied: "適用済み",
    retry_wait: "再試行待ち",
    failed: manual >= manualLimit ? "失敗（手動再試行上限）" : "失敗（再試行可能）",
    superseded: "旧リビジョンのため無効化",
    blocked: "安全のため停止",
  };
  const error = job.lastError ? `\n理由: ${cleanText(job.lastError, 500)}` : "";
  return `適用ジョブ r${job.revision ?? job.targetRevision ?? "?"}: ${statusLabels[job.status] ?? cleanText(job.status, 80)} / 試行${Number(job.attemptCount ?? 0)}回 / 手動再試行${manual}/${manualLimit}${error}`;
}

function formatCountMap(counts = {}) {
  return `正常${Number(counts.healthy ?? 0)} / 警告${Number(counts.warning ?? 0)} / エラー${Number(counts.error ?? 0)} / 不明${Number(counts.unknown ?? 0)}`;
}

function formatDateValue(value) {
  if (!value) return "不明";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "不明" : date.toISOString();
}

function formatReconciliationStatus(observation) {
  if (!observation) {
    return "【30分照合】まだ実行されていません。Botのready後に初回照合を開始します。確認済み候補は安全確認後に修復ジョブへ投入されます。";
  }
  const statusLabels = {
    healthy: "正常",
    warning: "警告",
    error: "エラー",
    unknown: "確認不能",
    failed: "実行失敗",
  };
  const started = formatDateValue(observation.startedAt);
  const completed = formatDateValue(observation.completedAt);
  const next = formatDateValue(observation.nextRunAt);
  const candidates = (Array.isArray(observation.candidates) ? observation.candidates : []).slice(0, 50).map((candidate) => (
    `- ${cleanText(candidate.key, 120)}: ${cleanText(candidate.reason, 300)} [${cleanText(candidate.evidenceStatus, 30)}]`
  ));
  return [
    "【30分照合】",
    `状態: ${statusLabels[observation.status] ?? cleanText(observation.status, 40)}`,
    `開始: ${cleanText(started, 50)} / 完了: ${cleanText(completed, 50)} / 所要: ${Number(observation.durationMs ?? 0)}ms`,
    `次回予定: ${cleanText(next, 50)}`,
    `設定・権限: ${formatCountMap(observation.validationCounts)}`,
    `運用状態: ${cleanText(observation.operationalSeverity, 40)} (${formatCountMap(observation.operationalCounts)})`,
    `連続失敗: ${Number(observation.consecutiveFailures ?? 0)}`,
    observation.lastError ? `最終エラー: ${cleanText(observation.lastError, 500)}` : "最終エラー: なし",
    candidates.length ? `自動修復候補（実行状態は/config repair_status）:\n${candidates.join("\n")}` : "自動修復候補: なし（unknown/API不明は候補化しません）",
  ].join("\n");
}

function formatRepairStatus(jobs = []) {
  const rows = Array.isArray(jobs) ? jobs.slice(0, 20) : [];
  if (rows.length === 0) return "【自動修復】このサーバーには修復ジョブがありません。確認済み候補が観測された場合だけ投入されます。";
  const labels = {
    pending: "待機中",
    processing: "実行中",
    applied: "適用済み",
    retry_wait: "再試行待ち",
    blocked: "安全のため停止",
    circuit_open: "自動再試行停止",
    superseded: "旧候補のため無効",
    no_longer_needed: "候補消失",
    failed: "失敗",
  };
  return [
    "【自動修復】",
    ...rows.map((job) => {
      const reason = job.lastError || job.result?.reason || "";
      const observed = formatDateValue(job.observedAt);
      const next = formatDateValue(job.nextAttemptAt);
      return `${cleanText(job.actionKey, 120)}: ${labels[job.status] ?? cleanText(job.status, 80)} / 観測 ${cleanText(observed, 50)} / 試行 ${Number(job.attemptCount ?? 0)}/${Number(job.maxAttempts ?? 3)} / 次回 ${cleanText(next, 50)}${reason ? `\n理由: ${cleanText(reason, 500)}` : ""}`;
    }),
  ].join("\n");
}

function hasManageGuild(interaction) {
  try {
    return Boolean(interaction?.memberPermissions?.has?.(PermissionFlagsBits.ManageGuild));
  } catch {
    return false;
  }
}

async function sendChunks(interaction, text) {
  const chunks = splitText(text);
  const first = {
    content: chunks[0],
    allowedMentions: { parse: [] },
  };
  await interaction.editReply(first);
  if (typeof interaction.followUp !== "function") return;
  for (const chunk of chunks.slice(1, MAX_CHUNKS)) {
    await interaction.followUp({
      content: chunk,
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
  }
  if (chunks.length > MAX_CHUNKS) {
    await interaction.followUp({
      content: "表示件数が多いため一部を省略しました。limitを下げるか、対象リビジョンを指定してください。",
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
  }
}

export function createConfigurationFeature({ configurationService, applyService = null, reconciliationService = null, repairService = null, logger = console } = {}) {
  if (!configurationService) throw new Error("configurationService is required");

  async function handleConfig(interaction) {
    if (!interaction?.inGuild?.() || !interaction.guildId) {
      await interaction?.reply?.({ content: "このコマンドはサーバー内で使ってください。", flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
      return;
    }
    if (!hasManageGuild(interaction)) {
      await interaction.reply({ content: "このコマンドにはサーバー管理権限が必要です。", flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const subcommand = interaction.options.getSubcommand();
      const currentApplyService = typeof applyService === "function" ? applyService() : applyService;
      const currentReconciliationService = typeof reconciliationService === "function" ? reconciliationService() : reconciliationService;
      const currentRepairService = typeof repairService === "function" ? repairService() : repairService;
      if (subcommand === "history") {
        const limit = interaction.options.getInteger("limit", false) ?? 10;
        const rows = await configurationService.listHistory(interaction.guildId, limit);
        await sendChunks(interaction, `【設定履歴】\n${formatHistory(rows)}`);
        return;
      }
      if (subcommand === "show") {
        const revision = interaction.options.getInteger("revision", false);
        const row = await configurationService.getRevision(interaction.guildId, revision);
        await sendChunks(interaction, `【設定 r${row.revision}】\n${formatSnapshot(row.snapshot)}`);
        return;
      }
      if (subcommand === "diff") {
        const from = interaction.options.getInteger("from", true);
        const to = interaction.options.getInteger("to", true);
        const result = await configurationService.diffRevisions(interaction.guildId, from, to);
        await sendChunks(interaction, `【設定差分】\n${formatDiff(result)}`);
        return;
      }
      if (subcommand === "rollback") {
        const targetRevision = interaction.options.getInteger("revision", true);
        const reason = interaction.options.getString("reason", false) ?? "config command rollback";
        const current = await configurationService.getCurrentConfiguration(interaction.guildId);
        let preflight = null;
        if (currentApplyService?.preflightRollback) {
          preflight = await currentApplyService.preflightRollback({
            guildId: interaction.guildId,
            targetRevision,
            expectedRevision: current.revision,
            guild: interaction.guild,
          });
        }
        const committed = await configurationService.rollbackConfiguration(interaction.guildId, targetRevision, {
          expectedRevision: current.revision,
          actorUserId: interaction.user?.id ?? null,
          source: "config/rollback",
          reason,
          preflight: null,
        });
        let job = committed.applyJob ?? null;
        if (currentApplyService?.applyCommittedRevision) {
          const applied = await currentApplyService.applyCommittedRevision(interaction.guildId, committed.revision);
          job = applied?.status ? { ...(job ?? {}), ...applied, revision: committed.revision } : job;
        }
        const warning = preflight?.warningCount ? `\n事前確認: 警告${preflight.warningCount}件（設定保存は許可）` : "";
        await sendChunks(interaction, `設定をr${committed.revision}としてr${targetRevision}へロールバックしました。${warning}\n${formatApplyJob(job)}`);
        return;
      }
      if (subcommand === "apply_status") {
        if (!currentApplyService?.getJobStatus) {
          await sendChunks(interaction, "適用ジョブサービスが利用できません。設定履歴のみ確認できます。");
          return;
        }
        const revision = interaction.options.getInteger("revision", false);
        const job = await currentApplyService.getJobStatus(interaction.guildId, revision);
        await sendChunks(interaction, formatApplyJob(job));
        return;
      }
      if (subcommand === "apply_retry") {
        if (!currentApplyService?.retryJob) {
          await sendChunks(interaction, "適用ジョブサービスが利用できません。再試行要求は受け付けられません。");
          return;
        }
        const revision = interaction.options.getInteger("revision", true);
        const job = await currentApplyService.retryJob(interaction.guildId, revision);
        await sendChunks(interaction, `適用ジョブの再試行を受け付けました。\n${formatApplyJob(job)}`);
        return;
      }
      if (subcommand === "reconcile_status") {
        if (!currentReconciliationService?.getLatest) {
          await sendChunks(interaction, "30分照合サービスが利用できません。まだ実行されていない可能性があります。");
          return;
        }
        const observation = await currentReconciliationService.getLatest(interaction.guildId);
        await sendChunks(interaction, formatReconciliationStatus(observation));
        return;
      }
      if (subcommand === "repair_status") {
        if (!currentRepairService?.getStatus) {
          await sendChunks(interaction, "自動修復サービスが利用できません。確認済み候補のみが安全確認後に投入されます。");
          return;
        }
        const jobs = await currentRepairService.getStatus(interaction.guildId, 20);
        await sendChunks(interaction, formatRepairStatus(jobs));
        return;
      }
      if (subcommand === "repair_retry") {
        if (!currentRepairService?.retryJob) {
          await sendChunks(interaction, "自動修復サービスが利用できません。再試行要求は受け付けられません。");
          return;
        }
        const action = interaction.options.getString("action", true);
        const job = await currentRepairService.retryJob(interaction.guildId, action);
        await sendChunks(interaction, `修復ジョブの手動再検証・再試行を受け付けました。\n${formatRepairStatus([job])}`);
        return;
      }
      await sendChunks(interaction, "未知の設定サブコマンドです。");
    } catch (error) {
      logger.warn?.(`Configuration command failed: ${error?.message ?? error}`);
      const message = error?.code === "CONFIGURATION_REVISION_NOT_FOUND"
        ? "指定したリビジョンはこのサーバーに存在しません。"
        : error?.code === "CONFIGURATION_TRANSACTIONS_UNAVAILABLE"
          ? "設定の安全な履歴保存に必要なMongoDBトランザクションが利用できません。設定は変更していません。MongoDBをレプリカセット等で起動してから再実行してください。"
        : error?.code === "SETTINGS_APPLY_PREFLIGHT_BLOCKED"
          ? "ロールバック前の安全確認で停止しました。Discordの対象・権限を確認してから再実行してください。"
          : error?.code === "SETTINGS_APPLY_RETRY_LIMIT"
            ? "この適用ジョブの手動再試行上限に達しています。Discordの状態を確認してから設定を再保存してください。"
          : error?.code === "RECONCILIATION_REPAIR_ACTION_INVALID"
            ? "指定された修復アクションは許可されていません。"
          : error?.code === "RECONCILIATION_REPAIR_NOT_RETRYABLE"
            ? "再試行できる修復ジョブがありません。最新の /config repair_status を確認してください。"
          : error?.code === "RECONCILIATION_REPAIR_RETRY_CONFLICT"
            ? "修復ジョブが別の管理者によって先に再試行されました。状態を再確認してください。"
          : error?.code === "RECONCILIATION_REPAIR_RETRY_LIMIT"
            ? "この修復ジョブの手動再試行上限に達しています。Discordの状態を確認してください。"
          : error?.code === "CONFIGURATION_REVISION_CONFLICT"
            ? "設定が別の管理者によって先に更新されました。現在のリビジョンを確認してから再実行してください。上書きは行っていません。"
        : "設定履歴を確認できませんでした。時間をおいて再実行してください。";
      await sendChunks(interaction, message);
    }
  }

  return { handleConfig };
}

export {
  formatDiff,
  formatHistory,
  formatReconciliationStatus,
  formatRepairStatus,
  formatSnapshot,
  splitText,
};
