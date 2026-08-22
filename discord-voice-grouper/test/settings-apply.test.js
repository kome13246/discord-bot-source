import test from "node:test";
import assert from "node:assert/strict";
import { createConfigurationService } from "../src/configuration-service.js";
import { createSettingsApplyDispatcher, createSettingsApplyService } from "../src/settings-apply-service.js";
import { createSettingsValidationService } from "../src/settings-validation-service.js";
import { createCallWaitSettingsReconciler } from "../src/callwait-settings-reconciler.js";
import { createRecruitmentFeature } from "../src/features/recruitment.js";
import { isVoiceChannelControlTarget } from "../src/voice-channel-control-service.js";

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function query(value) {
  return {
    lean: async () => clone(value),
    sort() { return this; },
    limit(limit) {
      if (Array.isArray(value)) this.lean = async () => clone(value.slice(0, limit));
      return this;
    },
    then(resolve, reject) { return Promise.resolve(clone(value)).then(resolve, reject); },
  };
}

function matches(document, filter = {}) {
  if (!document) return false;
  for (const [key, expected] of Object.entries(filter)) {
    if (key === "$or") {
      if (!expected.some((item) => matches(document, item))) return false;
      continue;
    }
    if (key === "$and") {
      if (!expected.every((item) => matches(document, item))) return false;
      continue;
    }
    if (expected && typeof expected === "object" && "$lte" in expected) {
      if (!(new Date(document[key]).getTime() <= new Date(expected.$lte).getTime())) return false;
      continue;
    }
    if (expected && typeof expected === "object" && "$in" in expected) {
      if (!expected.$in.includes(document[key])) return false;
      continue;
    }
    if (expected && typeof expected === "object" && "$exists" in expected) {
      if ((document[key] !== undefined) !== expected.$exists) return false;
      continue;
    }
    if (document[key] !== expected) return false;
  }
  return true;
}

function createJobModel(initial = []) {
  const jobs = initial.map(clone);
  const applyUpdate = (document, update) => {
    if (update?.$set) Object.assign(document, clone(update.$set));
    if (update?.$inc) for (const [key, amount] of Object.entries(update.$inc)) document[key] = Number(document[key] ?? 0) + amount;
    if (update?.$unset) for (const key of Object.keys(update.$unset)) delete document[key];
  };
  return {
    jobs,
    findOne(filter) { return query(jobs.find((job) => matches(job, filter)) ?? null); },
    find(filter = {}) { return query(jobs.filter((job) => matches(job, filter))); },
    findOneAndUpdate(filter, update) {
      const document = jobs.find((job) => matches(job, filter));
      if (document) applyUpdate(document, update);
      return query(document ?? null);
    },
    updateMany(filter, update) {
      let modifiedCount = 0;
      for (const document of jobs) if (matches(document, filter)) { applyUpdate(document, update); modifiedCount += 1; }
      return query({ modifiedCount });
    },
  };
}

function createWorker(jobs, options = {}) {
  const jobModel = createJobModel(jobs);
  const now = () => new Date("2026-08-22T00:00:00.000Z");
  const dispatched = [];
  const service = createSettingsApplyService({
    jobModel,
    now,
    getGuildSettings: async (guildId) => ({ guildId, configRevision: 1 }),
    configurationService: { getCurrentConfiguration: async (guildId) => ({ guildId, revision: 1 }) },
    dispatcher: {
      dispatch: async (job) => {
        dispatched.push(job.guildId);
        return options.dispatch?.(job) ?? { status: "applied" };
      },
    },
    maxAttempts: options.maxAttempts ?? 3,
    backoffBaseMs: 1,
    backoffMaxMs: 1,
    workerId: "test-worker",
  });
  return { service, jobModel, dispatched };
}

function createConfigurationModels(initial = {}, options = {}) {
  const settings = new Map(Object.entries(initial).map(([guildId, value]) => [guildId, { guildId, ...clone(value) }]));
  const revisions = [];
  const jobs = [];
  const matchesSettings = (document, filter) => {
    if (!document || document.guildId !== filter.guildId) return false;
    if (!filter.$or) return true;
    return filter.$or.some((condition) => (
      condition.configRevision?.$exists === false
        ? document.configRevision === undefined
        : document.configRevision === condition.configRevision
    ));
  };
  const settingsModel = {
    findOne: (filter) => query(settings.get(filter.guildId) ?? null),
    find: (filter = {}) => query([...settings.values()].filter((row) => !filter.guildId || row.guildId === filter.guildId)),
    findOneAndUpdate: (filter, update) => {
      let row = settings.get(filter.guildId);
      if (row && !matchesSettings(row, filter)) return query(null);
      if (!row) row = { guildId: filter.guildId };
      if (update.$set) Object.assign(row, clone(update.$set));
      if (update.$unset) for (const key of Object.keys(update.$unset)) delete row[key];
      settings.set(filter.guildId, row);
      return query(row);
    },
  };
  const revisionModel = {
    create: async (rows) => {
      const values = Array.isArray(rows) ? rows : [rows];
      revisions.push(...clone(values));
      if (options.failRevisionCreate) throw new Error("revision failure");
      return values;
    },
    findOne: (filter) => query(revisions.find((row) => row.guildId === filter.guildId && row.revision === filter.revision) ?? null),
    find: (filter) => query(revisions.filter((row) => row.guildId === filter.guildId)),
  };
  const jobModel = {
    create: async (rows) => {
      const values = Array.isArray(rows) ? rows : [rows];
      if (options.failJobCreate) throw new Error("job failure");
      jobs.push(...clone(values));
      return values;
    },
    findOne: (filter) => query(jobs.find((row) => row.guildId === filter.guildId && row.revision === filter.revision) ?? null),
  };
  const transactionRunner = async (work) => {
    const beforeSettings = clone([...settings.entries()]);
    const beforeRevisions = clone(revisions);
    const beforeJobs = clone(jobs);
    try {
      return await work(null);
    } catch (error) {
      settings.clear();
      for (const [key, value] of beforeSettings) settings.set(key, value);
      revisions.splice(0, revisions.length, ...beforeRevisions);
      jobs.splice(0, jobs.length, ...beforeJobs);
      throw error;
    }
  };
  return {
    settings,
    revisions,
    jobs,
    settingsModel,
    revisionModel,
    jobModel,
    service: createConfigurationService({ settingsModel, revisionModel, applyJobModel: jobModel, transactionRunner, now: () => new Date("2026-08-22") }),
  };
}

test("apply job claim is atomic and an older revision is superseded without Discord work", async () => {
  const { service, jobModel, dispatched } = createWorker([
    { guildId: "guild1", revision: 1, targetRevision: 1, status: "pending", nextAttemptAt: new Date("2026-08-21") },
  ]);
  const result = await service.processAvailable();
  assert.equal(result.length, 1);
  assert.equal(jobModel.jobs[0].status, "applied");
  assert.deepEqual(dispatched, ["guild1"]);

  const old = createWorker([{ guildId: "guild2", revision: 1, targetRevision: 1, status: "pending", nextAttemptAt: new Date("2026-08-21") }]);
  old.service = createSettingsApplyService({
    jobModel: old.jobModel,
    now: () => new Date("2026-08-22"),
    configurationService: { getCurrentConfiguration: async () => ({ revision: 2 }) },
    dispatcher: { dispatch: async () => { throw new Error("must not dispatch"); } },
    workerId: "old-worker",
  });
  await old.service.processAvailable();
  assert.equal(old.jobModel.jobs[0].status, "superseded");
});

test("unknown Discord outcome is blocked and never blindly retried", async () => {
  const worker = createWorker([
    { guildId: "guild1", revision: 1, targetRevision: 1, status: "pending", nextAttemptAt: new Date("2026-08-21") },
  ], { dispatch: () => ({ status: "unknown", reason: "timeout after send" }) });
  await worker.service.processAvailable();
  assert.equal(worker.jobModel.jobs[0].status, "blocked");
  assert.equal(worker.dispatched.length, 1);
  await worker.service.processAvailable();
  assert.equal(worker.dispatched.length, 1);
});

test("expired processing leases are blocked without replay, and retry count is bounded", async () => {
  const worker = createWorker([
    { guildId: "guild1", revision: 1, targetRevision: 1, status: "processing", leaseOwner: "dead", leaseExpiresAt: new Date("2026-08-21"), nextAttemptAt: new Date("2026-08-21"), attemptCount: 0 },
  ], { dispatch: () => { throw new Error("temporary"); }, maxAttempts: 1 });
  await worker.service.recoverExpiredLeases();
  assert.equal(worker.jobModel.jobs[0].status, "blocked");
  assert.match(worker.jobModel.jobs[0].lastError, /outcome was unknown/);
  await worker.service.processAvailable();
  assert.equal(worker.dispatched.length, 0);
  assert.equal(worker.jobModel.jobs[0].status, "blocked");
  worker.jobModel.jobs[0].status = "failed";
  const manual = await worker.service.retryJob("guild1", 1);
  assert.equal(manual.status, "pending");
  assert.equal(manual.attemptCount, 0);
  assert.equal(manual.manualRetryCount, 1);
  worker.jobModel.jobs[0].status = "failed";
  worker.jobModel.jobs[0].manualRetryCount = 3;
  await assert.rejects(worker.service.retryJob("guild1", 1), (error) => error.code === "SETTINGS_APPLY_RETRY_LIMIT");
});

test("one guild failure does not stop another guild apply", async () => {
  const worker = createWorker([
    { guildId: "bad", revision: 1, targetRevision: 1, status: "pending", nextAttemptAt: new Date("2026-08-21") },
    { guildId: "good", revision: 1, targetRevision: 1, status: "pending", nextAttemptAt: new Date("2026-08-21") },
  ], { dispatch: (job) => job.guildId === "bad" ? ({ status: "unknown" }) : ({ status: "applied" }) });
  await worker.service.processAvailable();
  assert.equal(worker.jobModel.jobs.find((job) => job.guildId === "bad").status, "blocked");
  assert.equal(worker.jobModel.jobs.find((job) => job.guildId === "good").status, "applied");
});

test("configuration revision and apply job are created atomically", async () => {
  const models = createConfigurationModels();
  const result = await models.service.updateConfiguration("guild1", { statusBoardChannelId: "channel1" }, { expectedRevision: 0, source: "setting" });
  assert.equal(result.revision, 1);
  assert.equal(models.revisions.length, 1);
  assert.equal(models.jobs.length, 1);
  assert.equal(models.jobs[0].guildId, "guild1");
  assert.equal(models.jobs[0].targetRevision, 1);
  assert.deepEqual(models.jobs[0].changedKeys, ["statusBoardChannelId"]);

  const failed = createConfigurationModels({}, { failJobCreate: true });
  await assert.rejects(failed.service.updateConfiguration("guild1", { splitMode: "direct" }, { expectedRevision: 0 }), /job failure/);
  assert.equal(failed.settings.size, 0);
  assert.equal(failed.revisions.length, 0);
  assert.equal(failed.jobs.length, 0);
});

test("rollback sets and unsets only catalog keys and keeps runtime state", async () => {
  const models = createConfigurationModels({ guild1: {
    configRevision: 1,
    splitMode: "direct",
    childCategoryId: "old",
    callWaitPrompt: { messageId: "runtime" },
  } });
  models.revisions.push({ guildId: "guild1", revision: 1, baseRevision: 0, schemaVersion: 1, snapshot: { splitMode: "direct", childCategoryId: "old" }, changes: {} });
  const result = await models.service.rollbackConfiguration("guild1", 1, { expectedRevision: 1, reason: "restore" });
  assert.equal(result.jobType, "rollback");
  assert.equal(result.rollbackTargetRevision, 1);
  assert.equal(models.settings.get("guild1").childCategoryId, "old");
  assert.equal(models.settings.get("guild1").callWaitPrompt.messageId, "runtime");

  models.revisions.push({ guildId: "guild1", revision: 3, baseRevision: 2, schemaVersion: 1, snapshot: { splitMode: "direct" }, changes: {} });
  const removed = await models.service.rollbackConfiguration("guild1", 3, { expectedRevision: 2 });
  assert.equal("childCategoryId" in models.settings.get("guild1"), false);
  assert.equal("callWaitPrompt" in models.settings.get("guild1"), true);
  assert.equal(removed.revision, 3);
  await assert.rejects(models.service.rollbackConfiguration("guild2", 1, { expectedRevision: 0 }), (error) => error.code === "CONFIGURATION_REVISION_NOT_FOUND");
});

test("status board dispatcher applies and removes through the operational service", async () => {
  const calls = [];
  const dispatcher = createSettingsApplyDispatcher({
    getGuild: async () => ({ id: "guild1" }),
    getGuildSettings: async () => ({ statusBoardChannelId: "channel1" }),
    operationalStatusBoardService: {
      configure: async (guild, channel) => { calls.push(["configure", guild.id, channel]); return { status: "created" }; },
      remove: async (guild) => { calls.push(["remove", guild.id]); return { status: "removed" }; },
    },
  });
  await dispatcher.dispatch({ guildId: "guild1", revision: 1, changedKeys: ["statusBoardChannelId"] });
  assert.deepEqual(calls, [["configure", "guild1", "channel1"]]);
  const removeDispatcher = createSettingsApplyDispatcher({
    getGuild: async () => ({ id: "guild1" }),
    getGuildSettings: async () => ({ statusBoardChannelId: null }),
    operationalStatusBoardService: { remove: async (guild) => { calls.push(["remove", guild.id]); return { status: "removed" }; } },
  });
  await removeDispatcher.dispatch({ guildId: "guild1", revision: 2, changedKeys: ["statusBoardChannelId"] });
  assert.deepEqual(calls.at(-1), ["remove", "guild1"]);
});

test("kokuchi event-time changes reschedule kokuchi and resync VC DM reminders", async () => {
  const calls = [];
  const dispatcher = createSettingsApplyDispatcher({
    getGuild: async () => ({ id: "guild1" }),
    getGuildSettings: async () => ({ kokuchiEventTime: "20:00", kokuchiEventTimeConfigured: true, vcDmEnabled: true }),
    rescheduleCurrentKokuchiEvent: async () => { calls.push("kokuchi"); return { status: "applied" }; },
    vcDmService: { onSettingsChanged: async () => { calls.push("vc_dm"); return { status: "applied" }; } },
  });
  await dispatcher.dispatch({ guildId: "guild1", revision: 1, changedKeys: ["kokuchiEventTime"] });
  assert.deepEqual(calls, ["kokuchi", "vc_dm"]);

  calls.length = 0;
  await dispatcher.dispatch({ guildId: "guild1", revision: 2, changedKeys: ["kokuchiAnnouncementChannelId"] });
  assert.deepEqual(calls, ["kokuchi"]);
});

test("profile removal failure is not accepted as an applied settings job", async () => {
  const dispatcher = createSettingsApplyDispatcher({
    getGuild: async () => ({ id: "guild1" }),
    getGuildSettings: async () => ({ profileIntroductionChannelId: null }),
    profileRegistrationPanelService: {
      removeProfileRegistrationPanel: async () => ({ status: "remove-failed", retryable: true }),
    },
  });
  await assert.rejects(
    dispatcher.dispatch({ guildId: "guild1", revision: 1, changedKeys: ["profileIntroductionChannelId"] }),
    (error) => error.code === "SETTINGS_APPLY_RETRY",
  );
});

function createVoiceControlApplyWorker(ensurePanel, { targetCount = 1, settings: settingsOverride = {} } = {}) {
  const targetEntries = [
    ["target", { id: "target", type: 2, parentId: "category", guild: null }],
    ...(targetCount >= 2 ? [["target-2", { id: "target-2", type: 2, parentId: "category", guild: null }]] : []),
  ];
  const guild = {
    id: "guild1",
    channels: {
      cache: new Map([
        ...targetEntries,
        ["outside", { id: "outside", type: 2, parentId: "other-category", guild: null }],
        ["parent", { id: "parent", type: 2, parentId: "category", guild: null }],
        ["reminder", { id: "reminder", type: 2, parentId: "category", guild: null }],
        ["text", { id: "text", type: 0, parentId: "category", guild: null }],
      ]),
    },
  };
  for (const channel of guild.channels.cache.values()) channel.guild = guild;
  const model = createJobModel([{
    guildId: "guild1", revision: 1, targetRevision: 1, status: "pending",
    nextAttemptAt: new Date("2026-08-21"), attemptCount: 0,
    changedKeys: ["vcControlCategoryId"],
  }]);
  const settings = {
    guildId: "guild1",
    configRevision: 1,
    vcControlCategoryId: "category",
    parentChannelId: "parent",
    voiceReminderParentChannelIds: ["reminder"],
    ...settingsOverride,
  };
  const service = createSettingsApplyService({
    jobModel: model,
    now: () => new Date("2026-08-22T00:00:00.000Z"),
    getGuild: async () => guild,
    getGuildSettings: async () => settings,
    configurationService: { getCurrentConfiguration: async () => ({ guildId: "guild1", revision: 1 }) },
    dispatcher: createSettingsApplyDispatcher({
      getGuild: async () => guild,
      getGuildSettings: async () => settings,
      voiceChannelControlService: { ensurePanel },
    }),
    backoffBaseMs: 1,
    backoffMaxMs: 1,
    workerId: "voice-control-test",
  });
  return { service, model, guild };
}

test("voice-control unknown outcome blocks the apply job and only targets configured VC channels", async () => {
  const calls = [];
  const harness = createVoiceControlApplyWorker(async (channel) => {
    calls.push(channel.id);
    return { status: "unknown", reason: "timeout after send", unknownOutcome: true };
  });
  await harness.service.processAvailable();
  assert.equal(harness.model.jobs[0].status, "blocked");
  assert.deepEqual(calls, ["target"]);
});

test("voice-control partial completion followed by busy is blocked and never replayed", async () => {
  const calls = [];
  const harness = createVoiceControlApplyWorker(async (channel) => {
    calls.push(channel.id);
    return calls.length === 1
      ? { status: "created", messageId: "message-target" }
      : { status: "busy", beforeDiscord: true, reason: "lease-unavailable" };
  }, { targetCount: 2 });
  await harness.service.processAvailable();
  assert.equal(harness.model.jobs[0].status, "blocked");
  assert.deepEqual(calls, ["target", "target-2"]);
  await harness.service.processAvailable();
  assert.deepEqual(calls, ["target", "target-2"]);
});

test("voice-control permission block propagates to a blocked apply job", async () => {
  const harness = createVoiceControlApplyWorker(async () => ({ status: "blocked", reason: "permissions", beforeDiscord: true }));
  await harness.service.processAvailable();
  assert.equal(harness.model.jobs[0].status, "blocked");
});

test("voice-control busy before mutation remains retryable", async () => {
  const harness = createVoiceControlApplyWorker(async () => ({ status: "busy", beforeDiscord: true, reason: "lease-unavailable" }));
  await harness.service.processAvailable();
  assert.equal(harness.model.jobs[0].status, "retry_wait");
});

test("voice-control apply is applied only after every target panel confirms success", async () => {
  const calls = [];
  const harness = createVoiceControlApplyWorker(async (channel) => {
    calls.push(channel.id);
    return { status: "created", messageId: `message-${channel.id}` };
  });
  await harness.service.processAvailable();
  assert.equal(harness.model.jobs[0].status, "applied");
  assert.deepEqual(calls, ["target"]);
});

test("voice-controlはnot-configured・未知status・サービス結果欠落を成功扱いしない", async () => {
  for (const operation of [
    async () => ({ status: "not-configured", beforeDiscord: true }),
    async () => ({ status: "future-status" }),
    async () => undefined,
  ]) {
    const harness = createVoiceControlApplyWorker(operation);
    await harness.service.processAvailable();
    assert.equal(harness.model.jobs[0].status, "blocked");
  }
});

test("voice-control target helper and apply integration require a configured category", async () => {
  const channel = { id: "target", type: 2, parentId: "category" };
  assert.equal(isVoiceChannelControlTarget(channel, { vcControlCategoryId: "category" }), true);
  assert.equal(isVoiceChannelControlTarget(channel, {}), false);
  assert.equal(isVoiceChannelControlTarget(channel, { vcControlCategoryId: null }), false);
  assert.equal(isVoiceChannelControlTarget({ id: "x", type: 2 }, {}), false);

  const calls = [];
  const harness = createVoiceControlApplyWorker(async (target) => {
    calls.push(target.id);
    return { status: "created" };
  }, { settings: { vcControlCategoryId: null } });
  await harness.service.processAvailable();
  assert.equal(harness.model.jobs[0].status, "applied");
  assert.deepEqual(calls, []);
});

test("rollback preflight permits warnings but blocks unsafe errors/unknowns before writes", async () => {
  const service = createSettingsApplyService({
    jobModel: createJobModel(),
    configurationService: { getRevision: async () => ({ snapshot: { statusBoardChannelId: "channel1" } }) },
    getGuildSettings: async () => ({ configRevision: 2, statusBoardChannelId: "old" }),
    getEnvironmentSettings: () => ({}),
    validationService: { validateGuild: async () => ({ checks: [{ key: "optional", status: "warning" }] }) },
    getGuild: async () => ({ id: "guild1" }),
  });
  const allowed = await service.preflightRollback({ guildId: "guild1", targetRevision: 1 });
  assert.equal(allowed.warningCount, 1);

  const blocked = createSettingsApplyService({
    jobModel: createJobModel(),
    configurationService: { getRevision: async () => ({ snapshot: {} }) },
    getGuildSettings: async () => ({ configRevision: 2 }),
    validationService: { validateGuild: async () => ({ checks: [{ key: "channel", status: "error" }, { key: "dm", status: "unknown", reason: "dm-uncheckable" }] }) },
    getGuild: async () => ({ id: "guild1" }),
  });
  await assert.rejects(blocked.preflightRollback({ guildId: "guild1", targetRevision: 1 }), (error) => error.code === "SETTINGS_APPLY_PREFLIGHT_BLOCKED");
});

test("rollback preflight validates only changed features and permits disabling incomplete callwait", async () => {
  const channel = {
    id: "board-target",
    guildId: "guild1",
    type: 0,
    send: async () => ({ id: "message" }),
    permissionsFor: () => ({ has: () => true }),
  };
  const guild = {
    id: "guild1",
    channels: { cache: new Map([[channel.id, channel]]), fetch: async (id) => id === channel.id ? channel : null },
    roles: { cache: new Map(), fetch: async () => null },
    members: { me: { permissions: { has: () => true }, roles: { highest: { position: 10 } } } },
  };
  const validationService = createSettingsValidationService();
  const service = createSettingsApplyService({
    jobModel: createJobModel(),
    configurationService: {
      getRevision: async (_guildId, revision) => revision === 1
        ? { guildId: "guild1", revision: 1, snapshot: { callWaitEnabled: false, statusBoardChannelId: channel.id } }
        : { guildId: "guild1", revision: 2, snapshot: { callWaitEnabled: true, statusBoardChannelId: "current-board" } },
    },
    getGuildSettings: async () => ({ guildId: "guild1", configRevision: 2, callWaitEnabled: true, statusBoardChannelId: "current-board" }),
    getEnvironmentSettings: async () => ({}),
    validationService,
    getGuild: async () => guild,
  });
  const result = await service.preflightRollback({ guildId: "guild1", targetRevision: 1, guild });
  assert.deepEqual(result.features, ["callwait", "status_board"]);
  assert.equal(result.report.checks.some((check) => check.key.startsWith("splitvc.")), false);
  assert.equal(result.report.checks.some((check) => check.status === "error"), false);
});

test("rollback preflight blocks callwait when the notice channel lacks ManageMessages", async () => {
  const textPermissions = { has: (permission) => [
    "ViewChannel", "SendMessages", "EmbedLinks", "ReadMessageHistory",
  ].includes(permission) };
  const prompt = { id: "prompt", guildId: "guild1", type: 0, permissionsFor: () => textPermissions };
  const notice = { id: "notice", guildId: "guild1", type: 0, permissionsFor: () => textPermissions };
  const role = { id: "role", guildId: "guild1", managed: false, mentionable: true, editable: true, position: 1 };
  const guild = {
    id: "guild1",
    channels: { cache: new Map([[prompt.id, prompt], [notice.id, notice]]), fetch: async (id) => id === prompt.id ? prompt : id === notice.id ? notice : null },
    roles: { cache: new Map([[role.id, role]]), fetch: async (id) => id === role.id ? role : null },
    members: { me: { permissions: { has: () => true }, roles: { highest: { position: 10 } } } },
  };
  const service = createSettingsApplyService({
    jobModel: createJobModel(),
    configurationService: {
      getRevision: async (_guildId, revision) => revision === 1
        ? { guildId: "guild1", revision: 1, snapshot: { callWaitEnabled: true, callWaitRoleId: "role", callWaitPromptChannelId: "prompt", callWaitNoticeChannelId: "notice", callWaitIntervalMinutes: 30 } }
        : { guildId: "guild1", revision: 2, snapshot: { callWaitEnabled: false } },
    },
    getGuildSettings: async () => ({ guildId: "guild1", configRevision: 2, callWaitEnabled: false }),
    getEnvironmentSettings: async () => ({}),
    validationService: createSettingsValidationService(),
    getGuild: async () => guild,
  });
  await assert.rejects(
    service.preflightRollback({ guildId: "guild1", targetRevision: 1, guild }),
    (error) => error.code === "SETTINGS_APPLY_PREFLIGHT_BLOCKED"
      && error.reasons.some((reason) => reason === "callwait.noticeChannel.permission.ManageMessages"),
  );
});

test("rollback preflight validates the target status-board channel instead of the current runtime board", async () => {
  const current = {
    id: "current-board",
    guildId: "guild1",
    type: 0,
    send: async () => ({ id: "message" }),
    permissionsFor: () => ({ has: () => true }),
  };
  const target = {
    id: "target-board",
    guildId: "guild1",
    type: 0,
    send: async () => ({ id: "message" }),
    permissionsFor: () => ({ has: () => true }),
  };
  const guild = {
    id: "guild1",
    channels: { cache: new Map([[current.id, current]]), fetch: async (id) => id === current.id ? current : null },
    roles: { cache: new Map(), fetch: async () => null },
    members: { me: { permissions: { has: () => true }, roles: { highest: { position: 10 } } } },
  };
  const validationService = createSettingsValidationService();
  const makeService = (channelInCache) => createSettingsApplyService({
    jobModel: createJobModel(),
    configurationService: { getRevision: async (_guildId, revision) => ({
      guildId: "guild1",
      revision,
      snapshot: { statusBoardChannelId: revision === 1 ? "target-board" : "current-board" },
    }) },
    getGuildSettings: async () => ({ guildId: "guild1", configRevision: 2, statusBoardChannelId: "current-board" }),
    getEnvironmentSettings: async () => ({}),
    validationService,
    getGuild: async () => ({ ...guild, channels: { ...guild.channels, cache: new Map(channelInCache.map((value) => [value.id, value])) } }),
  });
  await assert.rejects(
    makeService([current]).preflightRollback({ guildId: "guild1", targetRevision: 1, guild }),
    (error) => error.code === "SETTINGS_APPLY_PREFLIGHT_BLOCKED" && error.reasons.some((reason) => reason === "status_board.channel"),
  );
  const allowed = await makeService([current, target]).preflightRollback({ guildId: "guild1", targetRevision: 1, guild: { ...guild, channels: { ...guild.channels, cache: new Map([[current.id, current], [target.id, target]]), fetch: async (id) => id === target.id ? target : current } } });
  assert.equal(allowed.report.checks.find((check) => check.key === "status_board.channel").status, "ok");
});

test("status-board busy before mutation is retryable rather than blocked", async () => {
  const worker = createWorker([
    { guildId: "guild1", revision: 1, targetRevision: 1, status: "pending", nextAttemptAt: new Date("2026-08-21") },
  ], { dispatch: () => ({ status: "busy", reason: "lease-unavailable" }) });
  await worker.service.processAvailable();
  assert.equal(worker.jobModel.jobs[0].status, "retry_wait");
});

test("expired apply leases are fenced without takeover or Discord replay", async () => {
  const model = createJobModel([
    { guildId: "guild1", revision: 1, targetRevision: 1, status: "pending", nextAttemptAt: new Date("2026-08-21"), attemptCount: 0 },
  ]);
  const base = Date.parse("2026-08-22T00:00:00.000Z");
  let clock = 0;
  let startedResolve;
  let releaseResolve;
  const started = new Promise((resolve) => { startedResolve = resolve; });
  const release = new Promise((resolve) => { releaseResolve = resolve; });
  const configuration = { getCurrentConfiguration: async (guildId) => ({ guildId, revision: 1 }) };
  const oldWorker = createSettingsApplyService({
    jobModel: model,
    configurationService: configuration,
    getGuildSettings: async (guildId) => ({ guildId, configRevision: 1 }),
    now: () => new Date(base + clock),
    leaseMs: 30,
    workerId: "old-worker",
    dispatcher: {
      dispatch: async (_job, context) => {
        await context.assertLease();
        startedResolve();
        await release;
        return { status: "applied" };
      },
    },
  });
  const oldRun = oldWorker.processAvailable();
  await started;
  clock = 31;
  let newWorkerSideEffects = 0;
  const newWorker = createSettingsApplyService({
    jobModel: model,
    configurationService: configuration,
    getGuildSettings: async (guildId) => ({ guildId, configRevision: 1 }),
    now: () => new Date(base + clock),
    leaseMs: 30,
    workerId: "new-worker",
    dispatcher: { dispatch: async () => { newWorkerSideEffects += 1; return { status: "applied" }; } },
  });
  await newWorker.processAvailable();
  assert.equal(newWorkerSideEffects, 0);
  assert.equal(model.jobs[0].status, "blocked");
  releaseResolve();
  await oldRun;
  assert.equal(model.jobs[0].status, "blocked");
  assert.equal(model.jobs[0].leaseOwner, null);
});

test("graceful shutdown keeps an in-flight apply lease alive until the mutation settles", async () => {
  const model = createJobModel([
    { guildId: "guild1", revision: 1, targetRevision: 1, status: "pending", nextAttemptAt: new Date("2026-08-21"), attemptCount: 0 },
  ]);
  const base = Date.parse("2026-08-22T00:00:00.000Z");
  let clock = 0;
  let startedResolve;
  let releaseResolve;
  const started = new Promise((resolve) => { startedResolve = resolve; });
  const release = new Promise((resolve) => { releaseResolve = resolve; });
  const configuration = { getCurrentConfiguration: async (guildId) => ({ guildId, revision: 1 }) };
  const oldWorker = createSettingsApplyService({
    jobModel: model,
    configurationService: configuration,
    getGuildSettings: async (guildId) => ({ guildId, configRevision: 1 }),
    now: () => new Date(base + clock),
    leaseMs: 30,
    shutdownDrainTimeoutMs: 500,
    workerId: "old-worker",
    dispatcher: {
      dispatch: async (_job, context) => {
        await context.assertLease();
        startedResolve();
        await release;
        return { status: "applied" };
      },
    },
  });
  const oldRun = oldWorker.processAvailable();
  await started;
  const shutdown = oldWorker.shutdown();

  // The old worker is stopping new claims, but its heartbeat remains active.
  // Move logical time beyond the original lease and give one heartbeat tick a
  // chance to extend ownership before a second worker tries to claim it.
  clock = 31;
  await new Promise((resolve) => setTimeout(resolve, 25));
  let newWorkerSideEffects = 0;
  const newWorker = createSettingsApplyService({
    jobModel: model,
    configurationService: configuration,
    getGuildSettings: async (guildId) => ({ guildId, configRevision: 1 }),
    now: () => new Date(base + clock),
    leaseMs: 30,
    workerId: "new-worker",
    dispatcher: { dispatch: async () => { newWorkerSideEffects += 1; return { status: "applied" }; } },
  });
  await newWorker.processAvailable();
  assert.equal(newWorkerSideEffects, 0);
  assert.equal(model.jobs[0].status, "processing");
  assert.equal(model.jobs[0].leaseOwner, "old-worker");

  releaseResolve();
  await oldRun;
  await shutdown;
  assert.equal(model.jobs[0].status, "applied");
  assert.equal(model.jobs[0].leaseOwner, null);
});

test("callwait apply reconciliation clears prompt, notice, and disabled followups once", async () => {
  const calls = [];
  const timers = new Map([["callwait-followup:guild1:message", setTimeout(() => {}, 60_000)]]);
  let runtimePatch = null;
  const reconciler = createCallWaitSettingsReconciler({
    saveGuildSettingsWithCurrent: async (_guildId, _settings, patch) => { runtimePatch = patch; },
    endCallWaitInterestsForRecruitment: async (...args) => calls.push(["end", ...args]),
    deleteCallWaitPrompt: async (...args) => calls.push(["prompt", ...args]),
    deleteCallWaitMessage: async (...args) => calls.push(["notice", ...args]),
    callWaitFollowupTimers: timers,
  });
  const result = await reconciler.reconcile({
    guild: { id: "guild1" },
    currentSettings: {
      callWaitEnabled: true,
      callWaitPromptChannelId: "old-channel",
      callWaitPrompt: { channelId: "old-channel", messageId: "prompt" },
      callWaitSkippedNotice: { channelId: "notice-channel", messageId: "notice" },
      callWaitPendingNotice: { status: "pending" },
    },
    nextSettings: { callWaitEnabled: false, callWaitPromptChannelId: "new-channel" },
  });
  assert.equal(result.status, "applied");
  assert.deepEqual(calls.map(([name]) => name), ["end", "prompt", "notice"]);
  assert.deepEqual(runtimePatch, { callWaitPrompt: null, callWaitSkippedNotice: null, callWaitPendingNotice: null });
  assert.equal(timers.size, 0);
});

test("callwait cleanup blocks on an unknown Discord delete and preserves runtime references", async () => {
  let saved = 0;
  const reconciler = createCallWaitSettingsReconciler({
    saveGuildSettingsWithCurrent: async () => { saved += 1; },
    endCallWaitInterestsForRecruitment: async () => ({ status: "applied" }),
    deleteCallWaitPrompt: async () => ({ status: "unknown", unknownOutcome: true }),
    deleteCallWaitMessage: async () => ({ status: "removed" }),
  });
  const result = await reconciler.reconcile({
    guild: { id: "guild1" },
    currentSettings: {
      callWaitEnabled: true,
      callWaitPrompt: { channelId: "prompt-channel", messageId: "prompt" },
      callWaitSkippedNotice: { channelId: "notice-channel", messageId: "notice" },
    },
    nextSettings: { callWaitEnabled: false },
  });
  assert.equal(result.status, "unknown");
  assert.equal(result.unknownOutcome, true);
  assert.equal(saved, 0);
});

test("callwait cleanup retries a failed runtime save after the Discord message is already gone", async () => {
  let saveAttempts = 0;
  let deleteAttempts = 0;
  const reconciler = createCallWaitSettingsReconciler({
    saveGuildSettingsWithCurrent: async () => {
      saveAttempts += 1;
      if (saveAttempts === 1) throw new Error("temporary Mongo failure");
    },
    endCallWaitInterestsForRecruitment: async () => ({ status: "applied" }),
    deleteCallWaitPrompt: async () => {
      deleteAttempts += 1;
      return deleteAttempts === 1 ? { status: "removed" } : { status: "already-absent", idempotent: true };
    },
  });
  const input = {
    guild: { id: "guild1" },
    currentSettings: { callWaitEnabled: true, callWaitPrompt: { channelId: "channel", messageId: "prompt" } },
    nextSettings: { callWaitEnabled: false },
  };
  const first = await reconciler.reconcile(input);
  assert.equal(first.status, "retry_wait");
  const second = await reconciler.reconcile(input);
  assert.equal(second.status, "applied");
  assert.equal(deleteAttempts, 2);
  assert.equal(saveAttempts, 2);
});

test("callwait cleanup does not clear the database or delete the next message after lease loss", async () => {
  let assertions = 0;
  let notices = 0;
  let saved = 0;
  const leaseError = Object.assign(new Error("lease lost"), { leaseLost: true, code: "SETTINGS_APPLY_LEASE_LOST" });
  const reconciler = createCallWaitSettingsReconciler({
    saveGuildSettingsWithCurrent: async () => { saved += 1; },
    endCallWaitInterestsForRecruitment: async () => ({ status: "applied" }),
    deleteCallWaitPrompt: async () => ({ status: "removed" }),
    deleteCallWaitMessage: async () => { notices += 1; return { status: "removed" }; },
  });
  await assert.rejects(reconciler.reconcile({
    guild: { id: "guild1" },
    currentSettings: {
      callWaitEnabled: true,
      callWaitPrompt: { channelId: "prompt-channel", messageId: "prompt" },
      callWaitSkippedNotice: { channelId: "notice-channel", messageId: "notice" },
    },
    nextSettings: { callWaitEnabled: false },
    assertLease: async () => {
      assertions += 1;
      if (assertions === 4) throw leaseError;
    },
  }), (error) => error === leaseError);
  assert.equal(assertions, 4);
  assert.equal(notices, 0);
  assert.equal(saved, 0);
});

test("callwait Discord deletion distinguishes idempotent absence from an unknown outcome", async () => {
  const feature = createRecruitmentFeature({});
  const missingChannel = {
    id: "channel",
    messages: {
      fetch: async () => { throw Object.assign(new Error("Unknown Message"), { code: 10008 }); },
    },
  };
  const missingResult = await feature.deleteCallWaitMessage({
    id: "guild1",
    channels: { cache: new Map([[missingChannel.id, missingChannel]]) },
  }, { channelId: "channel", messageId: "message" });
  assert.equal(missingResult.status, "already-absent");

  const uncertainChannel = {
    id: "channel",
    messages: {
      fetch: async () => ({ delete: async () => { throw Object.assign(new Error("Missing Permissions"), { code: 50013 }); } }),
    },
  };
  const unknownResult = await feature.deleteCallWaitMessage({
    id: "guild1",
    channels: { cache: new Map([[uncertainChannel.id, uncertainChannel]]) },
  }, { channelId: "channel", messageId: "message" });
  assert.equal(unknownResult.status, "unknown");
  assert.equal(unknownResult.unknownOutcome, true);

  let deleted = 0;
  const successfulChannel = {
    id: "channel",
    messages: {
      fetch: async () => ({ delete: async () => { deleted += 1; } }),
    },
  };
  const successResult = await feature.deleteCallWaitMessage({
    id: "guild1",
    channels: { cache: new Map([[successfulChannel.id, successfulChannel]]) },
  }, { channelId: "channel", messageId: "message" });
  assert.equal(successResult.status, "removed");
  assert.equal(deleted, 1);
});
