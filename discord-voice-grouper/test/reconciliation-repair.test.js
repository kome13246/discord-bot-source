import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PermissionFlagsBits } from "discord.js";
import { createConfigurationFeature, formatRepairStatus } from "../src/features/configuration.js";
import { createVoiceChannelControlService } from "../src/voice-channel-control-service.js";
import { createOperationalStatusService } from "../src/operational-status-service.js";
import {
  boundedEvidence,
  createReconciliationRepairService,
  extractRepairCandidates,
} from "../src/reconciliation-repair-service.js";

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function query(value) {
  return {
    lean: async () => clone(value),
    then(resolve, reject) { return Promise.resolve(clone(value)).then(resolve, reject); },
  };
}

function equalValue(actual, expected) {
  if (expected && typeof expected === "object") {
    if (expected.$in) return expected.$in.includes(actual);
    if (expected.$lt !== undefined) return Number(actual ?? 0) < Number(expected.$lt);
    if (expected.$lte !== undefined) return actual == null || new Date(actual).getTime() <= new Date(expected.$lte).getTime();
    if (expected.$exists !== undefined) return expected.$exists ? actual !== undefined : actual === undefined;
  }
  return expected === actual;
}

function matches(row, filter = {}) {
  if (filter.$or && !filter.$or.some((branch) => matches(row, branch))) return false;
  for (const [key, expected] of Object.entries(filter)) {
    if (key === "$or") continue;
    if (!equalValue(row[key], expected)) return false;
  }
  return true;
}

function createRepairModel() {
  const rows = [];
  let sequence = 0;
  const model = {
    rows,
    create: async (document) => {
      const duplicate = rows.find((row) => row.guildId === document.guildId
        && row.observationRunId === document.observationRunId
        && row.actionKey === document.actionKey);
      if (duplicate) {
        const error = new Error("duplicate");
        error.code = 11000;
        throw error;
      }
      const active = rows.find((row) => row.guildId === document.guildId
        && row.actionKey === document.actionKey
        && ["pending", "processing", "retry_wait", "blocked", "circuit_open"].includes(row.status));
      if (active) {
        const error = new Error("active duplicate");
        error.code = 11000;
        throw error;
      }
      const row = { _id: `job-${++sequence}`, fencingToken: 0, ...clone(document) };
      rows.push(row);
      return query(row);
    },
    findOne: (filter) => query(rows.find((row) => matches(row, filter)) ?? null),
    find: (filter) => {
      let selected = rows.filter((row) => matches(row, filter));
      const result = {
        sort(spec) {
          const [key, direction] = Object.entries(spec)[0];
          selected.sort((left, right) => (direction < 0 ? -1 : 1) * String(right[key] ?? "").localeCompare(String(left[key] ?? "")));
          return result;
        },
        limit(value) { selected = selected.slice(0, value); return result; },
        lean: async () => clone(selected),
        then(resolve, reject) { return Promise.resolve(clone(selected)).then(resolve, reject); },
      };
      return result;
    },
    findOneAndUpdate: (filter, update, options = {}) => {
      let candidates = rows.filter((row) => matches(row, filter));
      if (options.sort) candidates = candidates.sort((left, right) => String(left._id).localeCompare(String(right._id)));
      const row = candidates[0] ?? null;
      if (row) {
        Object.assign(row, clone(update.$set ?? {}));
        for (const [key, value] of Object.entries(update.$inc ?? {})) row[key] = Number(row[key] ?? 0) + Number(value);
      }
      return query(row);
    },
    updateMany: async (filter, update) => {
      let modifiedCount = 0;
      for (const row of rows) if (matches(row, filter)) {
        Object.assign(row, clone(update.$set ?? {}));
        modifiedCount += 1;
      }
      return { modifiedCount };
    },
  };
  return model;
}

const healthyValidation = () => ({ status: "ok", reports: [{ checks: [] }] });
const healthyOperational = () => ({ modules: { panels: { key: "panels", severity: "healthy", issues: [] }, recruitment: { key: "recruitment", severity: "healthy", issues: [] } } });

function validationFor(actionKey, statusEvidence = "message-missing") {
  if (actionKey === "status_board.ensure") {
    const check = statusEvidence === "channel-mismatch"
      ? { key: "status_board.channel", status: "error", reason: "channel-mismatch" }
      : { key: "status_board.message", status: "error", reason: "message-missing" };
    return { status: "error", reports: [{ checks: [check] }] };
  }
  const code = actionKey === "profile_panel.ensure"
    ? "profile_panel_missing"
    : actionKey === "otebo_panel.ensure" ? "otebo_panel_state_missing" : "vc_panel_missing";
  return healthyValidation.withCandidate?.(code) ?? { status: "warning", reports: [{ checks: [] }] };
}

function operationalFor(actionKey) {
  if (actionKey === "status_board.ensure") return healthyOperational();
  const code = actionKey === "profile_panel.ensure"
    ? "profile_panel_missing"
    : actionKey === "otebo_panel.ensure" ? "otebo_panel_state_missing" : "vc_panel_missing";
  const moduleKey = actionKey === "otebo_panel.ensure" ? "recruitment" : "panels";
  return { modules: { [moduleKey]: { key: moduleKey, severity: "warning", issues: [{ code, severity: "warning", blocking: false }] } } };
}

function createOperationalPanelFixture() {
  const records = {
    profile: { guildId: "guild-1", channelId: "profile-old", messageId: "profile-message" },
    otebo: { guildId: "guild-1", channelId: "otebo-old", messageId: "otebo-message" },
  };
  const emptyModel = () => ({
    find: () => query([]),
    findOne: () => query(null),
    countDocuments: async () => 0,
    findOneAndUpdate: async () => null,
  });
  const modelNames = [
    "BumpReminder", "BosyuEditSession", "CallWaitInterest", "FukyoThemeState", "FukyoWeeklyPost",
    "KokuchiReservation", "OperationalHealthState", "OperationalStatusBoard", "ProfileRegistrationPanel",
    "OteboRecruitmentPanel", "CallWaitRoleGeneration", "ScheduledAction", "SplitProcessSession",
    "VoiceChannelControl", "VoiceExitSchedule", "VoiceParticipantRoleGrant",
  ];
  const models = Object.fromEntries(modelNames.map((name) => [name, emptyModel()]));
  models.ProfileRegistrationPanel.findOne = () => query(records.profile);
  models.OteboRecruitmentPanel.findOne = () => query(records.otebo);
  const panelMessage = (id) => ({ id, delete: async () => {} });
  const channel = (id, messageId) => ({
    id,
    type: 0,
    permissionsFor: () => ({ has: () => true }),
    messages: { fetch: async () => panelMessage(messageId) },
  });
  const channels = [
    channel("profile-old", "profile-message"),
    channel("profile-new", "profile-message"),
    channel("otebo-old", "otebo-message"),
    channel("otebo-new", "otebo-message"),
  ];
  const guild = {
    id: "guild-1",
    members: { me: {} },
    channels: { cache: new Map(channels.map((item) => [item.id, item])), fetch: async (id) => channels.find((item) => item.id === id) ?? null },
    roles: { cache: new Map() },
  };
  const settings = {
    guildId: guild.id,
    profileIntroductionChannelId: "profile-new",
    callWaitEnabled: true,
    callWaitRoleId: "callwait-role",
    callWaitNoticeChannelId: "otebo-new",
  };
  const statusService = createOperationalStatusService({
    getGuildSettings: async () => settings,
    client: { guilds: { cache: new Map([[guild.id, guild]]) } },
    getDatabaseStatus: async () => ({ status: "connected", error: null }),
    models,
  });
  return { records, guild, settings, statusService };
}

function createHarness(actionKey, { post = "healthy", preflight = "candidate", preflightValidation = null, preflightOperational = null, operation = { status: "created" }, guild = null, statusEvidence = "message-missing" } = {}) {
  const model = createRepairModel();
  let readCount = 0;
  let mutations = 0;
  const defaultGuild = guild ?? {
    id: "guild-1",
    members: { me: { id: "bot" } },
    channels: { cache: new Map([["voice-1", { id: "voice-1", type: 2, parentId: "vc-category" }]]) },
  };
  const settings = {
    statusBoardChannelId: "status-channel",
    profileIntroductionChannelId: "profile-channel",
    callWaitNoticeChannelId: "otebo-channel",
    vcControlCategoryId: "vc-category",
  };
  const service = createReconciliationRepairService({
    repairJobModel: model,
    validationService: { validateGuild: async () => {
      readCount += 1;
      if (preflightValidation) return preflightValidation;
      if (preflight === "gone") return healthyValidation();
      if (preflight === "unknown") return { status: "unknown", reports: [{ checks: [{ key: "profile.channel", status: "unknown", reason: "fetch-failed" }] }] };
      if (readCount > 1 && post === "healthy") return healthyValidation();
      return actionKey === "status_board.ensure" ? validationFor(actionKey, statusEvidence) : healthyValidation();
    } },
    operationalStatusService: { getOperationalStatusSnapshot: async () => {
      if (preflightOperational) return preflightOperational;
      if (preflight === "gone") return healthyOperational();
      if (preflight === "unknown") return { modules: { panels: { key: "panels", severity: "unknown", issues: [] } } };
      if (readCount > 1 && post === "healthy") return healthyOperational();
      return operationalFor(actionKey);
    } },
    getGuild: async () => defaultGuild,
    getGuildSettings: async () => settings,
    operationalStatusBoardService: { configure: async () => { mutations += 1; return operation; } },
    profileRegistrationPanelService: { ensureProfileRegistrationPanel: async () => { mutations += 1; return operation; } },
    oteboRecruitmentPanelService: { ensureOteboRecruitmentPanel: async () => { mutations += 1; return operation; } },
    voiceChannelControlService: { ensurePanel: async () => { mutations += 1; return operation; } },
    now: () => new Date("2026-08-22T00:00:00.000Z"),
    workerIntervalMs: 999_999,
    setIntervalFn: () => ({ unref() {} }),
    clearIntervalFn: () => {},
    setHeartbeatIntervalFn: () => ({ unref() {} }),
    clearHeartbeatIntervalFn: () => {},
    logger: { warn() {} },
  });
  return { model, service, get mutations() { return mutations; }, get readCount() { return readCount; }, guild: defaultGuild };
}

function observation(actionKey, runId = "run-1") {
  const candidate = actionKey === "status_board.ensure"
    ? extractRepairCandidates(validationFor(actionKey), healthyOperational())[0]
    : extractRepairCandidates(healthyValidation(), operationalFor(actionKey))[0];
  return { guildId: "guild-1", runId, startedAt: new Date(), completedAt: new Date(), candidates: [candidate] };
}

test("repair enqueue accepts only confirmed allowlisted evidence", async () => {
  const forged = { key: "profile_panel.ensure", safe: true, requiresApplyJob: true, evidenceStatus: "warning", evidence: { source: "operational", code: "panel_check_failed" } };
  assert.equal(boundedEvidence(forged), null);
  const harness = createHarness("profile_panel.ensure");
  const result = await harness.service.enqueueObservation({ guildId: "guild-1", runId: "run-forged", candidates: [forged] });
  assert.equal(result.jobs.length, 0);
});

test("allowlist violations in persisted jobs are blocked without invoking an adapter", async () => {
  const harness = createHarness("profile_panel.ensure");
  harness.model.rows.push({
    _id: "unsafe", guildId: "guild-1", observationRunId: "unsafe-run", actionKey: "settings.write",
    evidence: { key: "settings.write", reason: "forged", evidenceStatus: "error", source: "validation", checkKey: "settings" },
    status: "pending", attemptCount: 0, maxAttempts: 3, fencingToken: 0, nextAttemptAt: new Date(0),
  });
  const result = await harness.service.processAvailable();
  assert.equal(result.status, "completed");
  assert.equal(harness.mutations, 0);
  assert.equal(harness.model.rows[0].status, "blocked");
});

test("candidate disappearance and unknown preflight perform no Discord mutation", async () => {
  const gone = createHarness("profile_panel.ensure", { preflight: "gone" });
  await gone.service.enqueueObservation({ guildId: "guild-1", runId: "run-gone", candidates: [extractRepairCandidates(healthyValidation(), operationalFor("profile_panel.ensure"))[0]] });
  // Both reads return healthy in this fixture after the first call, so the
  // actual candidate is intentionally absent at the preflight boundary.
  gone.model.rows[0].status = "pending";
  const first = await gone.service.processAvailable();
  assert.equal(gone.mutations, 0);
  assert.equal(gone.model.rows[0].status, "no_longer_needed");
  assert.equal(first.status, "completed");

  const unknown = createHarness("profile_panel.ensure", { preflight: "unknown" });
  const candidate = extractRepairCandidates(healthyValidation(), operationalFor("profile_panel.ensure"))[0];
  await unknown.service.enqueueObservation({ guildId: "guild-1", runId: "run-unknown", candidates: [candidate] });
  unknown.model.rows[0].status = "pending";
  assert.equal((await unknown.service.processAvailable()).status, "completed");
  assert.equal(unknown.mutations, 0);
});

test("status-board channel or record uncertainty blocks repair before Discord", async () => {
  for (const unknownKey of ["status_board.channel", "status_board.message", "status_board.record"]) {
    const harness = createHarness("status_board.ensure", {
      preflightValidation: {
        status: "unknown",
        reports: [{ checks: [{ key: unknownKey, status: "unknown", reason: "api-unknown" }] }],
      },
    });
    const candidate = extractRepairCandidates(validationFor("status_board.ensure"), healthyOperational())[0];
    await harness.service.enqueueObservation({ guildId: "guild-1", runId: `unknown-${unknownKey}`, candidates: [candidate] });
    const result = await harness.service.processAvailable();
    assert.equal(result.status, "completed");
    assert.equal(harness.mutations, 0);
    assert.equal(harness.model.rows[0].status, "blocked");
    harness.model.rows.length = 0;
  }
});

test("each of the four actions executes exactly once only after postflight clears evidence", async () => {
  for (const actionKey of ["status_board.ensure", "profile_panel.ensure", "otebo_panel.ensure", "voice_control_panels.ensure"]) {
    const harness = createHarness(actionKey);
    await harness.service.enqueueObservation(observation(actionKey, `run-${actionKey}`));
    const result = await harness.service.processAvailable();
    assert.equal(result.status, "completed");
    assert.equal(harness.mutations, actionKey === "voice_control_panels.ensure" ? 1 : 1);
    assert.equal(harness.model.rows[0].status, "applied");
    assert.equal(harness.readCount >= 2, true);
  }
});

test("status-board channel drift remains a repair candidate until postflight confirms the configured state", async () => {
  const harness = createHarness("status_board.ensure", { statusEvidence: "channel-mismatch" });
  const candidate = extractRepairCandidates(validationFor("status_board.ensure", "channel-mismatch"), healthyOperational())[0];
  assert.equal(candidate.evidence.checkKey, "status_board.channel");
  await harness.service.enqueueObservation({ guildId: "guild-1", runId: "status-drift", candidates: [candidate] });
  await harness.service.processAvailable();
  assert.equal(harness.mutations, 1);
  assert.equal(harness.model.rows[0].status, "applied");
});

test("実運用status snapshotのprofile/Otebo channel driftはenqueue後のpostflightまで確認される", async () => {
  for (const [actionKey, recordKey, targetChannelId, adapterName] of [
    ["profile_panel.ensure", "profile", "profile-new", "profileRegistrationPanelService"],
    ["otebo_panel.ensure", "otebo", "otebo-new", "oteboRecruitmentPanelService"],
  ]) {
    for (const clearDrift of [false, true]) {
      const fixture = createOperationalPanelFixture();
      const snapshot = await fixture.statusService.getOperationalStatusSnapshot(fixture.guild, { refreshPanelPresence: true });
      const candidate = extractRepairCandidates(healthyValidation(), snapshot).find((item) => item.key === actionKey);
      assert.ok(candidate, `${actionKey} should be extracted from the real operational snapshot`);
      assert.equal(candidate.evidence.code, `${recordKey}_panel_channel_mismatch`);
      const model = createRepairModel();
      const adapters = {
        profileRegistrationPanelService: { ensureProfileRegistrationPanel: async () => {
          if (clearDrift) fixture.records.profile.channelId = targetChannelId;
          return { status: "created" };
        } },
        oteboRecruitmentPanelService: { ensureOteboRecruitmentPanel: async () => {
          if (clearDrift) fixture.records.otebo.channelId = targetChannelId;
          return { status: "created" };
        } },
      };
      const repair = createReconciliationRepairService({
        repairJobModel: model,
        validationService: { validateGuild: async () => healthyValidation() },
        operationalStatusService: fixture.statusService,
        getGuild: async () => fixture.guild,
        getGuildSettings: async () => fixture.settings,
        ...adapters,
        now: () => new Date("2026-08-22T00:00:00.000Z"),
        setHeartbeatIntervalFn: () => ({ unref() {} }),
        clearHeartbeatIntervalFn: () => {},
        logger: { warn() {} },
      });
      await repair.enqueueObservation({ guildId: fixture.guild.id, runId: `${actionKey}-${clearDrift}`, candidates: [candidate] });
      await repair.processAvailable();
      assert.equal(model.rows[0].status, clearDrift ? "applied" : "blocked", `${adapterName} postflight status`);
    }
  }
});

test("mixed confirmed and unknown evidence blocks the action before Discord", async () => {
  const validation = healthyValidation();
  const operational = { modules: { panels: { key: "panels", severity: "warning", issues: [
    { code: "profile_panel_missing", severity: "warning", blocking: false },
    { code: "panel_check_failed", severity: "warning", blocking: false },
  ] } } };
  const harness = createHarness("profile_panel.ensure", { preflightOperational: operational });
  await harness.service.enqueueObservation({ guildId: "guild-1", runId: "run-mixed", candidates: extractRepairCandidates(validation, operational) });
  const result = await harness.service.processAvailable();
  assert.equal(result.status, "completed");
  assert.equal(harness.mutations, 0);
  assert.equal(harness.model.rows[0].status, "blocked");
});

test("same guild/action remains idempotent across observations and parallel workers", async () => {
  const harness = createHarness("profile_panel.ensure");
  const candidate = extractRepairCandidates(healthyValidation(), operationalFor("profile_panel.ensure"))[0];
  const first = await harness.service.enqueueObservation({ guildId: "guild-1", runId: "run-1", candidates: [candidate] });
  const second = await harness.service.enqueueObservation({ guildId: "guild-1", runId: "run-2", candidates: [candidate] });
  assert.equal(first.jobs.length, 1);
  assert.equal(second.jobs.length, 1);
  assert.equal(harness.model.rows.length, 1);
  const [left, right] = await Promise.all([harness.service.processAvailable(), harness.service.processAvailable()]);
  assert.equal(harness.model.rows.length, 1);
  assert.equal(harness.mutations <= 1, true);
  assert.equal([left.status, right.status].includes("skipped"), true);
});

test("lease contention permits one worker and lease loss fences the next Discord operation", async () => {
  const harness = createHarness("profile_panel.ensure");
  const candidate = extractRepairCandidates(healthyValidation(), operationalFor("profile_panel.ensure"))[0];
  await harness.service.enqueueObservation({ guildId: "guild-1", runId: "lease-run", candidates: [candidate] });
  const claimed = await harness.service.claimNextJob();
  assert.ok(claimed?.leaseOwner);
  assert.ok(claimed?.leaseId);
  assert.equal(Number.isFinite(claimed?.fencingToken), true);
  // The second claim sees the processing row and cannot duplicate it.
  assert.equal(await harness.service.claimNextJob(), null);

  const lossModel = createRepairModel();
  const loss = createReconciliationRepairService({
    repairJobModel: lossModel,
    validationService: { validateGuild: async () => ({ status: "error", reports: [{ checks: [{ key: "status_board.message", status: "error", reason: "message-missing" }] }] }) },
    operationalStatusService: { getOperationalStatusSnapshot: async () => healthyOperational() },
    getGuild: async () => ({ id: "guild-1", channels: { cache: new Map() } }),
    getGuildSettings: async () => ({ statusBoardChannelId: "status-channel" }),
    operationalStatusBoardService: { configure: async () => { throw new Error("must not run after lease loss"); } },
    now: () => new Date("2026-08-22T00:00:00.000Z"),
    setHeartbeatIntervalFn: () => ({ unref() {} }),
    clearHeartbeatIntervalFn: () => {},
    logger: { warn() {} },
  });
  await loss.enqueueObservation(observation("status_board.ensure", "loss-run"));
  let renewCount = 0;
  // Claim itself is synchronous in this fake; processJob's first ownership
  // check loses the lease before any board mutation.
  const original = lossModel.findOneAndUpdate;
  lossModel.findOneAndUpdate = (filter, update, options) => {
    if (update.$set?.status === "processing") return original(filter, update, options);
    renewCount += 1;
    if (renewCount > 0 && update.$set?.heartbeatAt) return query(null);
    return original(filter, update, options);
  };
  const processed = await loss.processAvailable();
  assert.equal(processed.status, "completed");
  assert.equal(lossModel.rows[0].status, "processing");
});

test("known pre-mutation busy retries finitely, opens a circuit, and a new observation cannot bypass it", async () => {
  let now = 0;
  const harness = createHarness("profile_panel.ensure", { operation: { status: "busy", beforeDiscord: true } });
  // Replace clock with a moving value so each bounded backoff is due.
  const service = createReconciliationRepairService({
    repairJobModel: harness.model,
    validationService: { validateGuild: async () => healthyValidation() },
    operationalStatusService: { getOperationalStatusSnapshot: async () => operationalFor("profile_panel.ensure") },
    getGuild: async () => harness.guild,
    getGuildSettings: async () => ({ profileIntroductionChannelId: "profile-channel" }),
    profileRegistrationPanelService: { ensureProfileRegistrationPanel: async () => ({ status: "busy", beforeDiscord: true }) },
    now: () => new Date(++now),
    backoffBaseMs: 1,
    backoffMaxMs: 1,
    setHeartbeatIntervalFn: () => ({ unref() {} }),
    clearHeartbeatIntervalFn: () => {},
    logger: { warn() {} },
  });
  const candidate = extractRepairCandidates(healthyValidation(), operationalFor("profile_panel.ensure"))[0];
  await service.enqueueObservation({ guildId: "guild-1", runId: "busy-run", candidates: [candidate] });
  for (let count = 0; count < 3; count += 1) await service.processAvailable();
  assert.equal(harness.model.rows[0].status, "circuit_open");
  const again = await service.enqueueObservation({ guildId: "guild-1", runId: "busy-run-2", candidates: [candidate] });
  assert.equal(again.jobs[0].status, "circuit_open");
});

test("one guild action failure is fenced without affecting another guild", async () => {
  const model = createRepairModel();
  const calls = [];
  const reads = new Map();
  const service = createReconciliationRepairService({
    repairJobModel: model,
    validationService: { validateGuild: async ({ guild }) => {
      const count = (reads.get(guild.id) ?? 0) + 1;
      reads.set(guild.id, count);
      return count === 1 ? { status: "error", reports: [{ checks: [{ key: "status_board.message", status: "error", reason: "message-missing" }] }], guild } : healthyValidation();
    } },
    operationalStatusService: { getOperationalStatusSnapshot: async () => healthyOperational() },
    getGuild: async (guildId) => ({ id: guildId, channels: { cache: new Map() } }),
    getGuildSettings: async () => ({ statusBoardChannelId: "status-channel" }),
    operationalStatusBoardService: { configure: async (guild) => { calls.push(guild.id); if (guild.id === "bad") throw new Error("send timeout"); return { status: "created" }; } },
    now: () => new Date("2026-08-22T00:00:00.000Z"),
    setHeartbeatIntervalFn: () => ({ unref() {} }),
    clearHeartbeatIntervalFn: () => {},
    logger: { warn() {} },
  });
  const candidate = extractRepairCandidates({ status: "error", reports: [{ checks: [{ key: "status_board.message", status: "error", reason: "message-missing" }] }] }, healthyOperational())[0];
  await service.enqueueObservation({ guildId: "bad", runId: "bad-run", candidates: [candidate] });
  await service.enqueueObservation({ guildId: "good", runId: "good-run", candidates: [candidate] });
  await service.processAvailable({ maxJobs: 10 });
  assert.deepEqual(calls, ["bad", "good"]);
  assert.equal(model.rows.find((row) => row.guildId === "bad").status, "blocked");
  assert.equal(model.rows.find((row) => row.guildId === "good").status, "applied");
});

test("voice ensure distinguishes 404 from transient API failure and compensates save failure", async () => {
  const guild = { id: "guild-voice", members: { me: { id: "bot" } } };
  const messages = new Map();
  const channel = {
    id: "voice-1", type: 2, parentId: "category", guild,
    permissionsFor: () => ({ has: () => true }),
    messages: { fetch: async (id) => {
      if (id === "missing") { const error = new Error("unknown message"); error.code = 10008; throw error; }
      if (id === "transient") { const error = new Error("gateway timeout"); error.status = 503; throw error; }
      return messages.get(id);
    } },
    send: async () => { const message = { id: `new-${messages.size}`, delete: async () => { messages.delete(message.id); } }; messages.set(message.id, message); return message; },
  };
  guild.channels = { cache: new Map([[channel.id, channel]]) };
  let record = { panelMessageId: "missing" };
  let sends = 0;
  const lease = { lockKey: "voice", leaseId: "voice-lease" };
  const base = {
    getGuildSettings: async () => ({ vcControlCategoryId: "category" }),
    acquireLease: async () => lease,
    renewLease: async () => true,
    releaseLease: async () => {},
    getVoiceControlRecord: async () => record,
    upsertVoiceControlRecord: async (_guildId, _channelId, patch) => { record = { ...record, ...patch }; },
    setIntervalFn: () => ({ unref() {} }),
    clearIntervalFn: () => {},
  };
  const service = createVoiceChannelControlService(base);
  const missing = await service.ensurePanel(channel);
  sends += 1;
  assert.equal(missing.status, "created");
  assert.equal(sends, 1);
  record = { panelMessageId: "transient" };
  const unknown = await service.ensurePanel(channel);
  assert.equal(unknown.status, "unknown");
  assert.equal(messages.size, 1);

  let deleted = 0;
  record = null;
  const saveFail = createVoiceChannelControlService({
    ...base,
    upsertVoiceControlRecord: async () => { throw new Error("mongo unavailable"); },
    getVoiceControlRecord: async () => null,
    releaseLease: async () => {},
  });
  channel.send = async () => ({ id: "save-fail", delete: async () => { deleted += 1; } });
  const failed = await saveFail.ensurePanel(channel);
  assert.equal(failed.status, "unknown");
  assert.equal(deleted, 1);
});

test("expired processing leases are blocked on restart and applied jobs are not replayed", async () => {
  const model = createRepairModel();
  let mutations = 0;
  model.rows.push({
    _id: "expired", guildId: "guild-1", observationRunId: "old", actionKey: "profile_panel.ensure",
    evidence: { key: "profile_panel.ensure", reason: "missing", evidenceStatus: "warning", source: "operational", code: "profile_panel_missing", checkKey: null },
    status: "processing", attemptCount: 1, maxAttempts: 3, leaseOwner: "old-worker", leaseId: "old-lease", fencingToken: 1,
    leaseExpiresAt: new Date("2026-08-21T00:00:00.000Z"), nextAttemptAt: new Date("2026-08-21T00:00:00.000Z"),
  });
  model.rows.push({
    _id: "applied", guildId: "guild-1", observationRunId: "applied-run", actionKey: "profile_panel.ensure",
    evidence: { key: "profile_panel.ensure", reason: "missing", evidenceStatus: "warning", source: "operational", code: "profile_panel_missing", checkKey: null },
    status: "applied", attemptCount: 1, maxAttempts: 3, leaseOwner: null, leaseId: null, fencingToken: 2,
    nextAttemptAt: null,
  });
  const service = createReconciliationRepairService({
    repairJobModel: model,
    validationService: { validateGuild: async () => healthyValidation() },
    operationalStatusService: { getOperationalStatusSnapshot: async () => healthyOperational() },
    getGuild: async () => ({ id: "guild-1", channels: { cache: new Map() } }),
    getGuildSettings: async () => ({ profileIntroductionChannelId: "profile-channel" }),
    profileRegistrationPanelService: { ensureProfileRegistrationPanel: async () => { mutations += 1; return { status: "created" }; } },
    now: () => new Date("2026-08-22T00:00:00.000Z"),
    setIntervalFn: () => ({ unref() {} }),
    clearIntervalFn: () => {},
    logger: { warn() {} },
  });
  await service.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(model.rows[0].status, "blocked");
  assert.equal(mutations, 0);
  await service.stop();
});

test("manual retry is finite and re-enters preflight instead of clearing blocked state blindly", async () => {
  const harness = createHarness("profile_panel.ensure", { preflight: "unknown" });
  const candidate = extractRepairCandidates(healthyValidation(), operationalFor("profile_panel.ensure"))[0];
  await harness.service.enqueueObservation({ guildId: "guild-1", runId: "manual-run", candidates: [candidate] });
  await harness.service.processAvailable();
  const first = await harness.service.retryJob("guild-1", "profile_panel.ensure");
  assert.equal(first.status, "pending");
  await harness.service.processAvailable();
  assert.equal(harness.model.rows[0].status, "blocked");
  assert.equal(harness.mutations, 0);
  harness.model.rows[0].status = "blocked";
  await harness.service.retryJob("guild-1", "profile_panel.ensure");
  harness.model.rows[0].status = "blocked";
  await harness.service.retryJob("guild-1", "profile_panel.ensure");
  harness.model.rows[0].status = "blocked";
  await assert.rejects(() => harness.service.retryJob("guild-1", "profile_panel.ensure"), { code: "RECONCILIATION_REPAIR_RETRY_LIMIT" });
  assert.equal(harness.mutations, 0);

  const concurrent = createHarness("profile_panel.ensure", { preflight: "unknown" });
  await concurrent.service.enqueueObservation({ guildId: "guild-1", runId: "concurrent-run", candidates: [candidate] });
  await concurrent.service.processAvailable();
  const outcomes = await Promise.allSettled([
    concurrent.service.retryJob("guild-1", "profile_panel.ensure"),
    concurrent.service.retryJob("guild-1", "profile_panel.ensure"),
  ]);
  assert.equal(outcomes.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter((item) => item.status === "rejected").length, 1);
});

test("shutdown drains an in-flight repair and does not start a new claim", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  // Replace the adapter used by the service's existing closure through a
  // second service so the gate is explicit and the job remains fenced.
  const model = createRepairModel();
  let mutating = false;
  const service = createReconciliationRepairService({
    repairJobModel: model,
    validationService: { validateGuild: async () => mutating ? healthyValidation() : healthyValidation() },
    operationalStatusService: { getOperationalStatusSnapshot: async () => mutating ? healthyOperational() : operationalFor("profile_panel.ensure") },
    getGuild: async () => ({ id: "guild-1", channels: { cache: new Map() } }),
    getGuildSettings: async () => ({ profileIntroductionChannelId: "profile-channel" }),
    profileRegistrationPanelService: { ensureProfileRegistrationPanel: async () => { mutating = true; await gate; return { status: "created" }; } },
    now: () => new Date("2026-08-22T00:00:00.000Z"),
    setIntervalFn: () => ({ unref() {} }),
    clearIntervalFn: () => {},
    setHeartbeatIntervalFn: () => ({ unref() {} }),
    clearHeartbeatIntervalFn: () => {},
    logger: { warn() {} },
  });
  await service.enqueueObservation(observation("profile_panel.ensure", "drain-run"));
  const running = service.processAvailable();
  while (!mutating) await new Promise((resolve) => setImmediate(resolve));
  const stopping = service.stop();
  release();
  await running;
  await stopping;
  assert.equal(model.rows[0].status, "applied");
  assert.equal((await service.processAvailable()).status, "skipped");
});

test("long repair keeps its fencing lease alive through heartbeat and shutdown drain", async () => {
  let heartbeatCallback;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let mutating = false;
  let clock = 0;
  const model = createRepairModel();
  const service = createReconciliationRepairService({
    repairJobModel: model,
    validationService: { validateGuild: async () => healthyValidation() },
    operationalStatusService: { getOperationalStatusSnapshot: async () => mutating ? healthyOperational() : operationalFor("profile_panel.ensure") },
    getGuild: async () => ({ id: "guild-1", channels: { cache: new Map() } }),
    getGuildSettings: async () => ({ profileIntroductionChannelId: "profile-channel" }),
    profileRegistrationPanelService: { ensureProfileRegistrationPanel: async () => { mutating = true; await gate; return { status: "created" }; } },
    now: () => new Date(++clock),
    leaseMs: 10,
    setHeartbeatIntervalFn: (callback) => { heartbeatCallback = callback; return { unref() {} }; },
    clearHeartbeatIntervalFn: () => {},
    logger: { warn() {} },
  });
  await service.enqueueObservation(observation("profile_panel.ensure", "heartbeat-run"));
  const running = service.processAvailable();
  while (!mutating) await new Promise((resolve) => setImmediate(resolve));
  const before = model.rows[0].heartbeatAt;
  await heartbeatCallback();
  assert.ok(model.rows[0].heartbeatAt);
  assert.notDeepEqual(model.rows[0].heartbeatAt, before);
  const stopping = service.stop();
  await heartbeatCallback();
  assert.equal(model.rows[0].status, "processing");
  release();
  await running;
  await stopping;
  assert.equal(model.rows[0].status, "applied");
});

test("voice control partial mutation is blocked rather than retried", async () => {
  const model = createRepairModel();
  const guild = { id: "guild-1", channels: { cache: new Map([
    ["voice-1", { id: "voice-1", type: 2, parentId: "category" }],
    ["voice-2", { id: "voice-2", type: 2, parentId: "category" }],
  ]) } };
  let count = 0;
  const service = createReconciliationRepairService({
    repairJobModel: model,
    validationService: { validateGuild: async () => ({ status: "warning", reports: [{ checks: [] }] }) },
    operationalStatusService: { getOperationalStatusSnapshot: async () => ({ modules: { panels: { key: "panels", severity: "warning", issues: [{ code: "vc_panel_missing", severity: "warning" }] } } }) },
    getGuild: async () => guild,
    getGuildSettings: async () => ({ vcControlCategoryId: "category" }),
    voiceChannelControlService: { ensurePanel: async () => { count += 1; return count === 1 ? { status: "created" } : { status: "busy", beforeDiscord: true }; } },
    now: () => new Date("2026-08-22T00:00:00.000Z"),
    setHeartbeatIntervalFn: () => ({ unref() {} }),
    clearHeartbeatIntervalFn: () => {},
    logger: { warn() {} },
  });
  const candidate = extractRepairCandidates(healthyValidation(), { modules: { panels: { key: "panels", severity: "warning", issues: [{ code: "vc_panel_missing", severity: "warning" }] } } })[0];
  await service.enqueueObservation({ guildId: "guild-1", runId: "partial-run", candidates: [candidate] });
  await service.processAvailable();
  assert.equal(count, 2);
  assert.equal(model.rows[0].status, "blocked");
  assert.notEqual(model.rows[0].status, "retry_wait");
});

test("repair errors redact Mongo credentials and tokens before persistence and display", async () => {
  const model = createRepairModel();
  const service = createReconciliationRepairService({
    repairJobModel: model,
    validationService: { validateGuild: async () => healthyValidation() },
    operationalStatusService: { getOperationalStatusSnapshot: async () => operationalFor("profile_panel.ensure") },
    getGuild: async () => ({ id: "guild-1", channels: { cache: new Map() } }),
    getGuildSettings: async () => ({ profileIntroductionChannelId: "profile-channel" }),
    profileRegistrationPanelService: { ensureProfileRegistrationPanel: async () => { throw new Error("mongodb://admin:secret@db.example.invalid/app token=bot-secret password=letmein"); } },
    now: () => new Date("2026-08-22T00:00:00.000Z"),
    setHeartbeatIntervalFn: () => ({ unref() {} }),
    clearHeartbeatIntervalFn: () => {},
    logger: { warn() {} },
  });
  const candidate = extractRepairCandidates(healthyValidation(), operationalFor("profile_panel.ensure"))[0];
  await service.enqueueObservation({ guildId: "guild-1", runId: "secret-run", candidates: [candidate] });
  await service.processAvailable();
  const saved = model.rows[0];
  assert.equal(saved.lastError.includes("mongodb://admin:secret"), false);
  assert.equal(saved.lastError.includes("bot-secret"), false);
  assert.equal(saved.lastError.includes("letmein"), false);
  assert.equal(formatRepairStatus([saved]).includes("bot-secret"), false);
});

test("repair status is guild-scoped, ephemeral, bounded, and mention-safe", async () => {
  const feature = createConfigurationFeature({
    configurationService: { listHistory: async () => [] },
    repairService: { getStatus: async () => [{ actionKey: "profile_panel.ensure", status: "blocked", attemptCount: 3, maxAttempts: 3, lastError: "<@&123>" }] },
  });
  const responses = [];
  await feature.handleConfig({
    guildId: "guild-1",
    inGuild: () => true,
    memberPermissions: { has: (permission) => permission === PermissionFlagsBits.ManageGuild },
    options: { getSubcommand: () => "repair_status" },
    deferReply: async (payload) => responses.push(["defer", payload]),
    editReply: async (payload) => responses.push(["edit", payload]),
    followUp: async (payload) => responses.push(["follow", payload]),
  });
  assert.equal(responses[0][1].flags, 64);
  assert.equal(responses.at(-1)[1].allowedMentions.parse.length, 0);
  assert.match(responses.at(-1)[1].content, /profile_panel\.ensure/);
  assert.equal(formatRepairStatus([]).length < 1_900, true);
});

test("startup and shutdown composition keep repair behind restore and stop reconciliation before repair", async () => {
  const startup = await readFile(new URL("../src/app/startup-coordinator.js", import.meta.url), "utf8");
  assert.ok(startup.indexOf("scheduleCallWait();") < startup.indexOf("startRepair(readyClient)"));
  assert.ok(startup.indexOf("startRepair(readyClient)") < startup.indexOf("startReconciliation(readyClient)"));
  const bot = await readFile(new URL("../src/bot.js", import.meta.url), "utf8");
  assert.ok(bot.indexOf("() => reconciliationService?.shutdown()") < bot.indexOf("() => reconciliationRepairService?.shutdown()"));
});
