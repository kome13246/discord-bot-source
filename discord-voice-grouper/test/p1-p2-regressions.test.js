import test from "node:test";
import assert from "node:assert/strict";
import { ChannelType, PermissionFlagsBits } from "discord.js";
import { createFukyoThemeService } from "../src/fukyo-theme-service.js";
import { createOperationalStatusBoardService } from "../src/operational-status-board-service.js";
import { createSettingsApplyDispatcher, createSettingsApplyService } from "../src/settings-apply-service.js";
import { createSettingsValidationService } from "../src/settings-validation-service.js";
import { createReadyHandler } from "../src/app/startup-coordinator.js";
import { createSetupDraftService } from "../src/setup-service.js";
import { getSetupFeatureSchema } from "../src/setup-schema.js";
import { settingCommand } from "../src/commands.js";
import { createConfigurationService } from "../src/configuration-service.js";
import { createReconciliationRepairService, extractRepairCandidates } from "../src/reconciliation-repair-service.js";
import { createCallWaitSettingsReconciler } from "../src/callwait-settings-reconciler.js";
import { createVcDmService } from "../src/vc-dm-service.js";

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function query(value) {
  return {
    lean: async () => clone(value),
    session() { return this; },
    sort() { return this; },
    limit() { return this; },
    then(resolve, reject) { return Promise.resolve(clone(value)).then(resolve, reject); },
  };
}

function matches(row, filter = {}) {
  if (!row) return false;
  if (filter.$or && !filter.$or.some((branch) => matches(row, branch))) return false;
  for (const [key, expected] of Object.entries(filter)) {
    if (key === "$or") continue;
    if (expected && typeof expected === "object") {
      if (expected.$in && !expected.$in.includes(row[key])) return false;
      if (expected.$lte && !(new Date(row[key]).getTime() <= new Date(expected.$lte).getTime())) return false;
      if (expected.$lt && !(Number(row[key] ?? 0) < Number(expected.$lt))) return false;
      if (expected.$exists !== undefined && (row[key] !== undefined) !== expected.$exists) return false;
      if (expected.$in || expected.$lte || expected.$lt || expected.$exists !== undefined) continue;
    }
    if (row[key] !== expected) return false;
  }
  return true;
}

function applyUpdate(row, update) {
  Object.assign(row, clone(update?.$set ?? {}));
  for (const [key, value] of Object.entries(update?.$inc ?? {})) row[key] = Number(row[key] ?? 0) + Number(value);
  for (const key of Object.keys(update?.$unset ?? {})) delete row[key];
  return row;
}

function createJobModel(initial) {
  const jobs = initial.map(clone);
  return {
    jobs,
    findOne: (filter) => query(jobs.find((row) => matches(row, filter)) ?? null),
    find: (filter) => query(jobs.filter((row) => matches(row, filter))),
    findOneAndUpdate: (filter, update) => {
      const row = jobs.find((candidate) => matches(candidate, filter));
      return query(row ? applyUpdate(row, update) : null);
    },
    updateMany: (filter, update) => {
      let modifiedCount = 0;
      for (const row of jobs) if (matches(row, filter)) { applyUpdate(row, update); modifiedCount += 1; }
      return query({ modifiedCount });
    },
  };
}

function adminInteraction(options = {}) {
  const replies = [];
  const interaction = {
    guildId: "guild-1",
    user: { id: "admin-1" },
    deferred: true,
    replied: false,
    inGuild: () => true,
    memberPermissions: { has: () => true },
    options: {
      getString: () => "new theme",
      getInteger: () => 1,
      getChannel: () => null,
      getBoolean: () => true,
    },
    editReply: async (payload) => { replies.push(payload); return { id: "discord-message" }; },
    followUp: async (payload) => { replies.push(payload); return { id: "discord-message" }; },
    ...options,
  };
  return { interaction, replies };
}

test("布教設定の競合通知がtruthyなeditReply結果でも成功経路へ流れない", async () => {
  let refreshes = 0;
  const saveError = Object.assign(new Error("stale"), { code: "CONFIGURATION_REVISION_CONFLICT" });
  const service = createFukyoThemeService({
    getGuildSettings: async () => ({ configRevision: 4, fukyoThemes: [{ id: "old", name: "old", normalizedName: "old" }] }),
    saveGuildSettings: async () => { throw new Error("unexpected legacy write"); },
    saveVersionedGuildConfiguration: async () => { throw saveError; },
    sendOperationalLog: async () => {},
    acquireMongoLease: async () => ({ lockKey: "lock" }),
    releaseMongoLease: async () => {},
    requestOperationalStatusRefresh: () => { refreshes += 1; },
  });
  const added = adminInteraction();
  await service.addTheme(added.interaction);
  assert.equal(added.replies.length, 1);
  assert.equal(refreshes, 0);
  assert.match(added.replies[0].content, /先に更新されました/);

  const deleted = adminInteraction({ options: { getInteger: () => 1 } });
  await service.deleteTheme(deleted.interaction);
  assert.equal(deleted.replies.length, 1);
  assert.equal(refreshes, 0);
  assert.match(deleted.replies[0].content, /先に更新されました/);

  const updated = adminInteraction();
  await service.updateSetting(updated.interaction);
  assert.equal(updated.replies.length, 1);
  assert.equal(refreshes, 0);
  assert.match(updated.replies[0].content, /先に更新されました/);
});

test("布教設定のトランザクション利用不可もtruthyな通知だけで終了し成功処理を行わない", async () => {
  let refreshes = 0;
  const saveError = Object.assign(new Error("transactions unavailable"), { code: "CONFIGURATION_TRANSACTIONS_UNAVAILABLE" });
  const service = createFukyoThemeService({
    getGuildSettings: async () => ({ configRevision: 4, fukyoThemes: [{ id: "old", name: "old", normalizedName: "old" }] }),
    saveGuildSettings: async () => { throw new Error("unexpected legacy write"); },
    saveVersionedGuildConfiguration: async () => { throw saveError; },
    sendOperationalLog: async () => {},
    acquireMongoLease: async () => ({ lockKey: "lock" }),
    releaseMongoLease: async () => {},
    requestOperationalStatusRefresh: () => { refreshes += 1; },
  });
  const added = adminInteraction();
  await service.addTheme(added.interaction);
  assert.equal(added.replies.length, 1);
  assert.equal(refreshes, 0);
  assert.match(added.replies[0].content, /トランザクションが利用できない/);

  const updated = adminInteraction();
  await service.updateSetting(updated.interaction);
  assert.equal(updated.replies.length, 1);
  assert.equal(refreshes, 0);
  assert.match(updated.replies[0].content, /トランザクションが利用できない/);
});

function boardGuild() {
  const channel = {
    id: "status-channel",
    type: ChannelType.GuildText,
    send: async () => { throw new Error("send must not run before lease"); },
    permissionsFor: () => ({ has: () => true }),
  };
  return {
    id: "guild-1",
    members: { me: {} },
    channels: { cache: new Map([[channel.id, channel]]), fetch: async () => channel },
  };
}

test("ステータスボードの開始前競合はretryable/beforeDiscordとして適用ジョブをretry_waitへ戻す", async () => {
  const guild = boardGuild();
  const boardService = createOperationalStatusBoardService({
    acquireMongoLease: async () => null,
    getOperationalStatusSnapshot: async () => ({ guildId: guild.id, modules: {} }),
    logger: { error() {} },
  });
  const configured = await boardService.configure(guild, "status-channel");
  const removed = await boardService.remove(guild);
  for (const result of [configured, removed]) {
    assert.equal(result.status, "busy");
    assert.equal(result.retryable, true);
    assert.equal(result.beforeDiscord, true);
  }

  const dispatcher = createSettingsApplyDispatcher({
    getGuild: async () => guild,
    getGuildSettings: async () => ({ statusBoardChannelId: "status-channel" }),
    operationalStatusBoardService: boardService,
  });
  await assert.rejects(
    dispatcher.dispatch({ guildId: guild.id, changedKeys: ["statusBoardChannelId"] }),
    (error) => error.code === "SETTINGS_APPLY_RETRY",
  );
});

test("実サービス相当の適用workerでも開始前ステータスボード競合は再試行待ちになる", async () => {
  const guild = boardGuild();
  const boardService = createOperationalStatusBoardService({
    acquireMongoLease: async () => null,
    getOperationalStatusSnapshot: async () => ({ guildId: guild.id, modules: {} }),
    logger: { error() {} },
  });
  const model = createJobModel([{
    guildId: guild.id,
    revision: 1,
    targetRevision: 1,
    changedKeys: ["statusBoardChannelId"],
    status: "pending",
    attemptCount: 0,
    nextAttemptAt: new Date("2026-08-21T00:00:00.000Z"),
  }]);
  const settings = { guildId: guild.id, configRevision: 1, statusBoardChannelId: "status-channel" };
  const dispatcher = createSettingsApplyDispatcher({
    getGuild: async () => guild,
    getGuildSettings: async () => settings,
    operationalStatusBoardService: boardService,
  });
  const service = createSettingsApplyService({
    jobModel: model,
    configurationService: {
      getCurrentConfiguration: async () => ({ guildId: guild.id, revision: 1 }),
      getRevision: async () => ({ guildId: guild.id, revision: 1, baseRevision: 0, snapshot: {} }),
    },
    getGuildSettings: async () => settings,
    getEnvironmentSettings: async () => ({}),
    getGuild: async () => guild,
    dispatcher,
    now: () => new Date("2026-08-22T00:00:00.000Z"),
    logger: { error() {}, debug() {}, warn() {} },
  });
  await service.processAvailable();
  assert.equal(model.jobs[0].status, "retry_wait");
});

test("VC DM disableのpanel removal failureは実サービスdispatcherからworkerへblockedを伝播する", async () => {
  const guild = { id: "guild-1", channels: { cache: new Map() } };
  const client = { guilds: { cache: new Map([[guild.id, guild]]) } };
  const vcDmService = createVcDmService({
    client,
    getGuildSettings: async () => ({ guildId: guild.id, vcDmEnabled: false }),
    panelServiceOverride: {
      removePanel: async () => ({ status: "remove-failed", retryable: false }),
      shutdown: async () => {},
    },
    logger: { warn() {}, error() {} },
  });
  const model = createJobModel([{
    guildId: guild.id,
    revision: 1,
    targetRevision: 1,
    changedKeys: ["vcDmEnabled"],
    status: "pending",
    attemptCount: 0,
    nextAttemptAt: new Date("2026-08-21T00:00:00.000Z"),
  }]);
  const dispatcher = createSettingsApplyDispatcher({
    getGuild: async () => guild,
    getGuildSettings: async () => ({ guildId: guild.id, vcDmEnabled: false }),
    vcDmService,
  });
  const apply = createSettingsApplyService({
    jobModel: model,
    configurationService: { getCurrentConfiguration: async () => ({ guildId: guild.id, revision: 1 }) },
    getGuildSettings: async () => ({ guildId: guild.id, vcDmEnabled: false, configRevision: 1 }),
    getGuild: async () => guild,
    dispatcher,
    now: () => new Date("2026-08-22T00:00:00.000Z"),
    logger: { error() {}, debug() {}, warn() {} },
  });
  try {
    await apply.processAvailable();
    assert.equal(model.jobs[0].status, "blocked");
    assert.notEqual(model.jobs[0].status, "applied");
  } finally {
    await vcDmService.shutdown();
  }
});

test("ステータスボードのDiscord後lease喪失はretryではなくblockedへ分類される", async () => {
  const guild = boardGuild();
  const dispatcher = createSettingsApplyDispatcher({
    getGuild: async () => guild,
    getGuildSettings: async () => ({ statusBoardChannelId: "status-channel" }),
    operationalStatusBoardService: {
      configure: async () => { throw new Error("lease lost after Discord send"); },
    },
  });
  await assert.rejects(
    dispatcher.dispatch({ guildId: guild.id, changedKeys: ["statusBoardChannelId"] }),
    (error) => error.code === "SETTINGS_APPLY_UNKNOWN_OUTCOME",
  );
});

function repairHarness(operation) {
  const model = createJobModel([]);
  model.create = async (document) => {
    const row = { _id: "repair-job", fencingToken: 0, ...clone(document) };
    model.jobs.push(row);
    return query(row);
  };
  const validation = { status: "error", reports: [{ checks: [{ key: "status_board.message", status: "error", reason: "message-missing" }] }] };
  const operational = { modules: {} };
  const candidate = extractRepairCandidates(validation, operational)[0];
  const service = createReconciliationRepairService({
    repairJobModel: model,
    validationService: { validateGuild: async () => validation },
    operationalStatusService: { getOperationalStatusSnapshot: async () => operational },
    getGuild: async () => ({ id: "guild-1", channels: { cache: new Map() } }),
    getGuildSettings: async () => ({ statusBoardChannelId: "status-channel" }),
    operationalStatusBoardService: { configure: operation },
    now: () => new Date("2026-08-22T00:00:00.000Z"),
    setHeartbeatIntervalFn: () => ({ unref() {} }),
    clearHeartbeatIntervalFn: () => {},
    logger: { warn() {} },
  });
  return { model, candidate, service };
}

test("修復は明示された開始前busyだけretryし、Discord後のlease喪失はblockedにする", async () => {
  const before = repairHarness(async () => ({ status: "busy", beforeDiscord: true, retryable: true }));
  await before.service.enqueueObservation({ guildId: "guild-1", runId: "before-run", candidates: [before.candidate] });
  await before.service.processAvailable();
  assert.equal(before.model.jobs[0].status, "retry_wait");

  const after = repairHarness(async () => { throw Object.assign(new Error("lease lost after send"), { retryable: true }); });
  await after.service.enqueueObservation({ guildId: "guild-1", runId: "after-run", candidates: [after.candidate] });
  await after.service.processAvailable();
  assert.equal(after.model.jobs[0].status, "blocked");

  const postResult = repairHarness(async () => ({ status: "busy", reason: "lease lost after send" }));
  await postResult.service.enqueueObservation({ guildId: "guild-1", runId: "post-result-run", candidates: [postResult.candidate] });
  await postResult.service.processAvailable();
  assert.equal(postResult.model.jobs[0].status, "blocked");
});

test("プロフィール公開先はsetup・checkbot・/settingのすべてでGuildTextだけを許可する", async () => {
  const field = getSetupFeatureSchema("profile").fields[0];
  assert.deepEqual(field.channelTypes, [ChannelType.GuildText]);
  const settingProfile = settingCommand.toJSON().options.find((item) => item.name === "profile");
  const option = settingProfile.options.find((item) => item.name === "introduction_channel");
  assert.deepEqual(option.channel_types, [ChannelType.GuildText]);

  const announcement = {
    id: "profile-channel",
    guildId: "guild-1",
    type: ChannelType.GuildAnnouncement,
    send: async () => {},
    permissionsFor: () => ({ has: () => true }),
  };
  const validator = createSettingsValidationService();
  const report = await validator.validateFeature({
    guild: {
      id: "guild-1",
      channels: { cache: new Map([[announcement.id, announcement]]) },
      members: { me: { permissions: { has: () => true } } },
    },
    settings: { profileIntroductionChannelId: announcement.id },
    feature: "profile",
  });
  assert.equal(report.checks.find((check) => check.key === "profile.introductionChannel").reason, "wrong-type");
});

test("status-board validation uses the configured channel and exposes persisted channel drift as a repair candidate", async () => {
  const target = {
    id: "status-new",
    guildId: "guild-1",
    type: ChannelType.GuildText,
    permissionsFor: () => ({ has: () => true }),
    messages: { fetch: async () => null },
  };
  const persisted = {
    guildId: "guild-1",
    channelId: "status-old",
    messageId: "old-message",
  };
  const validator = createSettingsValidationService({ getStatusBoard: async () => persisted });
  const report = await validator.validateFeature({
    guild: {
      id: "guild-1",
      members: { me: {} },
      channels: { cache: new Map([[target.id, target]]), fetch: async (id) => id === target.id ? target : null },
    },
    settings: { statusBoardChannelId: target.id },
    feature: "status_board",
  });
  const mismatch = report.checks.find((check) => check.key === "status_board.channel" && check.reason === "channel-mismatch");
  assert.equal(mismatch.status, "error");
  assert.equal(report.checks.find((check) => check.key === "status_board.message").reason, "message-missing");
  const candidate = extractRepairCandidates(report, { modules: {} }).find((item) => item.key === "status_board.ensure");
  assert.equal(candidate.evidence.checkKey, "status_board.channel");
});

test("設定適用の旧設定再構築は欠落snapshotを環境デフォルトで補い明示snapshotを優先する", async () => {
  const model = createJobModel([{
    guildId: "guild-1", revision: 2, targetRevision: 2, status: "pending", attemptCount: 0,
    nextAttemptAt: new Date("2026-08-21T00:00:00.000Z"),
  }]);
  let previous;
  const service = createSettingsApplyService({
    jobModel: model,
    configurationService: {
      getCurrentConfiguration: async () => ({ guildId: "guild-1", revision: 2 }),
      getRevision: async (_guildId, revision) => revision === 2
        ? { baseRevision: 1, snapshot: { callWaitNoticeChannelId: "snapshot-new" } }
        : { baseRevision: 0, snapshot: { callWaitNoticeChannelId: "snapshot-old" } },
    },
    getGuildSettings: async () => ({ guildId: "guild-1", configRevision: 2, callWaitPromptChannelId: "mongo-current" }),
    getEnvironmentSettings: async () => ({ callWaitPromptChannelId: "environment-old", updatedAt: "must-not-be-runtime" }),
    getGuild: async () => ({ id: "guild-1" }),
    dispatcher: { dispatch: async (_job, context) => { previous = context.previousSettings; return { status: "applied" }; } },
    now: () => new Date("2026-08-22T00:00:00.000Z"),
  });
  await service.processAvailable();
  assert.equal(previous.callWaitPromptChannelId, "environment-old");
  assert.equal(previous.callWaitNoticeChannelId, "snapshot-old");
  assert.equal(previous.updatedAt, undefined);
});

test("実dispatcherとcallwait reconcilerは環境由来の旧prompt/noticeを新設定移行前にcleanupする", async () => {
  const model = createJobModel([{
    guildId: "guild-1", revision: 2, targetRevision: 2, changedKeys: ["callWaitPromptChannelId", "callWaitNoticeChannelId"],
    status: "pending", attemptCount: 0, nextAttemptAt: new Date("2026-08-21T00:00:00.000Z"),
  }]);
  const currentSettings = {
    guildId: "guild-1", configRevision: 2, callWaitEnabled: true,
    callWaitPromptChannelId: "new-prompt", callWaitNoticeChannelId: "new-notice",
    callWaitPrompt: { channelId: "old-prompt", messageId: "old-prompt-message" },
    callWaitSkippedNotice: { channelId: "old-notice", messageId: "old-notice-message" },
  };
  const deletes = [];
  const runtimePatches = [];
  const callWaitReconciler = createCallWaitSettingsReconciler({
    saveGuildSettingsWithCurrent: async (_guildId, _next, patch) => { runtimePatches.push(patch); },
    endCallWaitInterestsForRecruitment: async () => ({ status: "applied" }),
    deleteCallWaitPrompt: async (_guild, prompt) => { deletes.push(["prompt", prompt]); return { status: "removed" }; },
    deleteCallWaitMessage: async (_guild, notice) => { deletes.push(["notice", notice]); return { status: "removed" }; },
  });
  const dispatcher = createSettingsApplyDispatcher({
    getGuild: async () => ({ id: "guild-1" }),
    getGuildSettings: async () => currentSettings,
    callWaitReconciler,
  });
  const service = createSettingsApplyService({
    jobModel: model,
    configurationService: {
      getCurrentConfiguration: async () => ({ guildId: "guild-1", revision: 2 }),
      getRevision: async (_guildId, revision) => revision === 2
        ? { guildId: "guild-1", revision: 2, baseRevision: 1, snapshot: { callWaitPromptChannelId: "new-prompt", callWaitNoticeChannelId: "new-notice" } }
        : { guildId: "guild-1", revision: 1, baseRevision: 0, snapshot: {} },
    },
    getGuildSettings: async () => currentSettings,
    getEnvironmentSettings: async () => ({ callWaitPromptChannelId: "old-prompt", callWaitNoticeChannelId: "old-notice", updatedAt: "environment" }),
    getGuild: async () => ({ id: "guild-1" }),
    dispatcher,
    now: () => new Date("2026-08-22T00:00:00.000Z"),
    logger: { error() {}, debug() {}, warn() {} },
  });
  await service.processAvailable();
  assert.equal(model.jobs[0].status, "applied");
  assert.deepEqual(deletes, [
    ["prompt", currentSettings.callWaitPrompt],
    ["notice", currentSettings.callWaitSkippedNotice],
  ]);
  assert.deepEqual(runtimePatches, [{ callWaitPrompt: null, callWaitSkippedNotice: null }]);
});

function createDraftModel() {
  const rows = [];
  return {
    rows,
    findOne: (filter) => query(rows.find((row) => matches(row, filter)) ?? null),
    findOneAndUpdate: (filter, update) => {
      const row = rows.find((candidate) => matches(candidate, filter));
      return query(row ? applyUpdate(row, update) : null);
    },
    create: async (documents) => { rows.push(...documents.map(clone)); return documents.map(clone); },
  };
}

test("setup確定直前は強制fetchで削除済みchannelを検出し、CAS claim後も設定を書かない", async () => {
  const model = createDraftModel();
  let writes = 0;
  let fetchOptions;
  const service = createSetupDraftService({
    draftModel: model,
    getGuildSettings: async () => ({ guildId: "guild-1", configRevision: 1 }),
    getGuild: async () => ({
      id: "guild-1",
      channels: { cache: new Map([["profile-channel", { id: "profile-channel", type: ChannelType.GuildText }]]), fetch: async (_id, options) => { fetchOptions = options; return null; } },
      roles: { cache: new Map(), fetch: async () => null },
    }),
    saveVersionedGuildConfiguration: async () => { writes += 1; return {}; },
    now: () => new Date("2026-08-22T00:00:00.000Z"),
  });
  const started = await service.startDraft({ guildId: "guild-1", actorUserId: "admin-1" });
  await service.selectFeature({ sessionId: started.draft.sessionId, guildId: "guild-1", actorUserId: "admin-1", feature: "profile", firstStep: "field:profileIntroductionChannelId" });
  await service.mergePatch({ sessionId: started.draft.sessionId, guildId: "guild-1", actorUserId: "admin-1", patch: { profileIntroductionChannelId: "profile-channel" } });
  await service.updateDraft({ sessionId: started.draft.sessionId, guildId: "guild-1", actorUserId: "admin-1", step: "review" });
  await assert.rejects(
    service.commitDraft({ sessionId: started.draft.sessionId, guildId: "guild-1", actorUserId: "admin-1" }),
    (error) => error.code === "SETUP_DRAFT_RESOURCE_INVALID",
  );
  assert.equal(writes, 0);
  assert.deepEqual(fetchOptions, { force: true });
  assert.equal(model.rows[0].status, "cancelled");
});

test("setup確定直前はroleも強制fetchし、型変更されたroleを設定へ書き込まない", async () => {
  const model = createDraftModel();
  let writes = 0;
  let fetchOptions;
  const service = createSetupDraftService({
    draftModel: model,
    getGuildSettings: async () => ({ guildId: "guild-1", configRevision: 1 }),
    getGuild: async () => ({
      id: "guild-1",
      channels: {
        cache: new Map(),
        fetch: async (id) => ["prompt", "notice"].includes(id)
          ? { id, guildId: "guild-1", type: ChannelType.GuildText }
          : null,
      },
      roles: {
        cache: new Map([["call-role", { id: "call-role", guildId: "guild-1" }]]),
        fetch: async (_id, options) => { fetchOptions = options; return { id: "call-role", guildId: "guild-1", type: ChannelType.GuildText }; },
      },
    }),
    saveVersionedGuildConfiguration: async () => { writes += 1; return {}; },
    now: () => new Date("2026-08-22T00:00:00.000Z"),
  });
  const started = await service.startDraft({ guildId: "guild-1", actorUserId: "admin-1" });
  await service.selectFeature({ sessionId: started.draft.sessionId, guildId: "guild-1", actorUserId: "admin-1", feature: "callwait", firstStep: "field:callWaitEnabled" });
  await service.mergePatch({ sessionId: started.draft.sessionId, guildId: "guild-1", actorUserId: "admin-1", patch: { callWaitEnabled: true, callWaitRoleId: "call-role", callWaitPromptChannelId: "prompt", callWaitNoticeChannelId: "notice", bosyuMentionRoleId: "call-role" } });
  await service.updateDraft({ sessionId: started.draft.sessionId, guildId: "guild-1", actorUserId: "admin-1", step: "review" });
  await assert.rejects(
    service.commitDraft({ sessionId: started.draft.sessionId, guildId: "guild-1", actorUserId: "admin-1" }),
    (error) => error.code === "SETUP_DRAFT_RESOURCE_INVALID",
  );
  assert.equal(writes, 0);
  assert.deepEqual(fetchOptions, { force: true });
  assert.equal(model.rows[0].status, "cancelled");
});

test("起動時の設定適用ジョブは通常復元と別phaseで先に完了する", async () => {
  const order = [];
  const handler = createReadyHandler({
    clearReadyWatchdog: () => {},
    migrate: async () => {},
    settingsApplyTasks: [{ name: "settings-apply-jobs", run: async () => order.push("apply") }],
    restoreTasks: [{ name: "profile", run: async () => order.push("profile") }, { name: "vc-dm", run: async () => order.push("vc-dm") }],
    lateRestoreTasks: [{ name: "otebo", run: async () => order.push("otebo") }],
    workerStartTasks: [{ name: "worker", run: async () => order.push("worker") }],
    updateRestoreState: () => {},
    recordStartupRestore: async () => {},
    statusBoard: { start: () => {}, restore: async () => {} },
    shouldSendMongoSuccessLog: () => false,
    clearMongoSuccessLog: () => {},
    sendMongoStartupEmbed: async () => true,
    processCallWait: async () => {},
    retryCallWaitNotifications: async () => {},
    scheduleCallWait: () => {},
    now: () => new Date("2026-08-22T00:00:00.000Z"),
    logger: { log() {}, error() {} },
  });
  await handler({ user: { tag: "bot" } });
  assert.equal(order[0], "apply");
  assert.deepEqual(new Set(order.slice(1, 3)), new Set(["profile", "vc-dm"]));
  assert.equal(order[3], "otebo");
  assert.equal(order[4], "worker");
});

test("最終worker phaseの失敗もrestore集計と起動記録へ含める", async () => {
  const order = [];
  const workerError = new Error("worker start failed");
  let restoreState;
  let recorded;
  const handler = createReadyHandler({
    clearReadyWatchdog: () => {},
    migrate: async () => {},
    settingsApplyTasks: [{ name: "apply", run: async () => order.push("apply") }],
    restoreTasks: [{ name: "restore", run: async () => order.push("restore") }],
    lateRestoreTasks: [{ name: "late", run: async () => order.push("late") }],
    workerStartTasks: [{ name: "worker", run: async () => { order.push("worker"); throw workerError; } }],
    updateRestoreState: (state) => { restoreState = state; },
    recordStartupRestore: async (state) => { recorded = state; },
    statusBoard: { start: () => {}, restore: async () => {} },
    shouldSendMongoSuccessLog: () => false,
    clearMongoSuccessLog: () => {},
    sendMongoStartupEmbed: async () => true,
    processCallWait: async () => {},
    retryCallWaitNotifications: async () => {},
    scheduleCallWait: () => {},
    now: () => new Date("2026-08-22T00:00:00.000Z"),
    logger: { log() {}, error() {} },
  });
  await handler({ user: { tag: "bot" } });
  assert.deepEqual(order, ["apply", "restore", "late", "worker"]);
  assert.deepEqual(restoreState, { completed: true, failed: true, failures: [{ name: "worker", error: "worker start failed" }] });
  assert.deepEqual(recorded.results.map(({ name, status }) => ({ name, status })), [
    { name: "apply", status: "fulfilled" },
    { name: "restore", status: "fulfilled" },
    { name: "late", status: "fulfilled" },
    { name: "worker", status: "rejected" },
  ]);
});

function configurationModels(settings, revisions) {
  const settingsRow = { guildId: "guild-1", ...clone(settings) };
  const revisionRows = revisions.map(clone);
  const jobs = [];
  const settingsModel = {
    findOne: () => query(settingsRow),
    findOneAndUpdate: (_filter, update) => query(applyUpdate(settingsRow, update)),
  };
  const revisionModel = {
    findOne: (filter) => query(revisionRows.find((row) => row.guildId === filter.guildId && row.revision === filter.revision) ?? null),
    create: async (rows) => { revisionRows.push(...(Array.isArray(rows) ? rows : [rows]).map(clone)); },
  };
  const applyJobModel = { create: async (rows) => { jobs.push(...(Array.isArray(rows) ? rows : [rows])); } };
  return { settingsRow, revisionRows, jobs, settingsModel, revisionModel, applyJobModel };
}

test("falseからtrueへのrollbackはfukyoのruntime時刻を同一transactionでnowへ更新する", async () => {
  const at = new Date("2026-08-22T12:34:56.000Z");
  const models = configurationModels(
    { configRevision: 2, fukyoWeeklyThemeEnabled: false },
    [{ guildId: "guild-1", revision: 1, baseRevision: 0, snapshot: { fukyoWeeklyThemeEnabled: true }, changes: {} }],
  );
  const service = createConfigurationService({
    settingsModel: models.settingsModel,
    revisionModel: models.revisionModel,
    applyJobModel: models.applyJobModel,
    transactionRunner: async (work) => work(null),
    now: () => at,
  });
  const committed = await service.rollbackConfiguration("guild-1", 1, { expectedRevision: 2 });
  assert.equal(models.settingsRow.fukyoWeeklyThemeEnabled, true);
  assert.equal(new Date(models.settingsRow.fukyoWeeklyThemeEnabledAt).toISOString(), at.toISOString());
  assert.equal(committed.snapshot.fukyoWeeklyThemeEnabledAt, undefined);
});

test("rollbackでfukyoがtrueのまま・無効化・他設定変更のときenabledAtを遡及更新しない", async () => {
  const originalAt = new Date("2026-08-01T12:00:00.000Z");
  const cases = [
    {
      name: "true-to-true",
      current: { configRevision: 2, fukyoWeeklyThemeEnabled: true, fukyoWeeklyThemeEnabledAt: originalAt },
      target: { fukyoWeeklyThemeEnabled: true },
    },
    {
      name: "true-to-false",
      current: { configRevision: 2, fukyoWeeklyThemeEnabled: true, fukyoWeeklyThemeEnabledAt: originalAt },
      target: { fukyoWeeklyThemeEnabled: false },
    },
    {
      name: "other-setting",
      current: { configRevision: 2, fukyoWeeklyThemeEnabled: false, fukyoWeeklyThemeEnabledAt: originalAt },
      target: { callWaitPromptChannelId: "prompt-channel" },
    },
  ];
  for (const item of cases) {
    const models = configurationModels(
      item.current,
      [{ guildId: "guild-1", revision: 1, baseRevision: 0, snapshot: item.target, changes: {} }],
    );
    const service = createConfigurationService({
      settingsModel: models.settingsModel,
      revisionModel: models.revisionModel,
      applyJobModel: models.applyJobModel,
      transactionRunner: async (work) => work(null),
      now: () => new Date("2026-08-22T12:34:56.000Z"),
    });
    await service.rollbackConfiguration("guild-1", 1, { expectedRevision: 2 });
    assert.equal(new Date(models.settingsRow.fukyoWeeklyThemeEnabledAt).toISOString(), originalAt.toISOString(), item.name);
  }
});
