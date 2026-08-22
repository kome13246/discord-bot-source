import test from "node:test";
import assert from "node:assert/strict";
import { PermissionFlagsBits } from "discord.js";
import { configCommand } from "../src/commands.js";
import { createConfigurationFeature, formatReconciliationStatus } from "../src/features/configuration.js";
import {
  RECONCILIATION_INTERVAL_MS,
  createReconciliationService,
  extractRepairCandidates,
} from "../src/reconciliation-service.js";

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function query(value) {
  return {
    lean: async () => clone(value),
    then(resolve, reject) { return Promise.resolve(clone(value)).then(resolve, reject); },
  };
}

function createObservationModel() {
  const rows = [];
  const model = {
    rows,
    findOne(filter) { return query(rows.find((row) => row.guildId === filter.guildId) ?? null); },
    findOneAndUpdate(filter, update) {
      let row = rows.find((item) => item.guildId === filter.guildId);
      const existed = Boolean(row);
      if (update.$set?.guildId !== undefined && update.$setOnInsert?.guildId !== undefined) {
        throw new Error("MongoDB update path conflict: guildId");
      }
      if (!row) {
        row = { guildId: filter.guildId };
        rows.push(row);
      }
      Object.assign(row, clone(update.$set ?? {}));
      if (!existed) Object.assign(row, clone(update.$setOnInsert ?? {}));
      return query(row);
    },
  };
  return model;
}

function healthyValidation() {
  return {
    status: "ok",
    reports: [{ feature: "profile", status: "ok", checks: [{ status: "ok", key: "profile.channel" }] }],
  };
}

function healthyOperational() {
  return {
    modules: {
      system: { key: "system", severity: "healthy", issues: [] },
      panels: { key: "panels", severity: "healthy", issues: [] },
    },
  };
}

function createFixture({ guilds = [{ id: "guild-1" }], validate = healthyValidation, operational = healthyOperational, lease = {} } = {}) {
  const model = createObservationModel();
  const calls = { validate: 0, operational: [], acquire: 0, renew: 0, release: 0 };
  const leases = {
    acquire: lease.acquire ?? (async (key) => { calls.acquire += 1; return { lockKey: key, ownerId: "worker", leaseId: `lease-${calls.acquire}` }; }),
    renew: lease.renew ?? (async () => { calls.renew += 1; return true; }),
    release: lease.release ?? (async () => { calls.release += 1; return true; }),
  };
  const service = createReconciliationService({
    getGuilds: () => guilds,
    validationService: {
      validateGuild: async (args) => {
        calls.validate += 1;
        return typeof validate === "function" ? validate(args) : validate;
      },
    },
    operationalStatusService: {
      getOperationalStatusSnapshot: async (guild, options) => {
        calls.operational.push({ guild, options });
        return typeof operational === "function" ? operational(guild, options) : operational;
      },
    },
    observationModel: model,
    acquireLease: leases.acquire,
    renewLease: leases.renew,
    releaseLease: leases.release,
    now: () => new Date("2026-08-22T00:00:00.000Z"),
    intervalMs: RECONCILIATION_INTERVAL_MS,
    logger: { warn() {} },
  });
  return { service, model, calls, leases };
}

test("production reconciliation interval is exactly 30 minutes and candidate extraction is allowlisted", () => {
  assert.equal(RECONCILIATION_INTERVAL_MS, 1_800_000);
  const candidates = extractRepairCandidates({
    status: "unknown",
    reports: [{ checks: [
      { key: "status_board.message", status: "error", reason: "message-missing" },
      { key: "status_board.channel", status: "error", reason: "resource-missing" },
      { key: "profile.channel", status: "unknown", reason: "fetch-failed" },
    ] }],
  }, {
    modules: {
      panels: {
        key: "panels",
        issues: [
          { code: "profile_panel_message_missing", severity: "warning", blocking: false },
          { code: "panel_check_failed", severity: "unknown", blocking: false },
        ],
      },
    },
  });
  // A missing configured channel is not a safe target for automatic board
  // recreation, even when the persisted message is also missing.
  assert.deepEqual(candidates.map((candidate) => candidate.key), ["profile_panel.ensure"]);
  assert.ok(candidates.every((candidate) => candidate.safe === true && candidate.requiresApplyJob === true));
  assert.deepEqual(extractRepairCandidates({ reports: [{ checks: [
    { key: "status_board.channel", status: "error", reason: "permission-denied" },
    { key: "status_board.message", status: "warning", reason: "message-missing" },
  ] }] }, { modules: {} }), []);
  assert.deepEqual(extractRepairCandidates({ reports: [{ checks: [
    { key: "status_board.channel", status: "unknown", reason: "api-unknown" },
    { key: "status_board.message", status: "warning", reason: "message-missing" },
  ] }] }, { modules: {} }), []);
});

test("panel channel drift is a confirmed candidate for profile and Otebo repair", () => {
  const candidates = extractRepairCandidates(
    { status: "ok", reports: [{ checks: [] }] },
    {
      modules: {
        panels: { key: "panels", severity: "warning", issues: [{ code: "profile_panel_channel_mismatch", severity: "warning", blocking: false }] },
        recruitment: { key: "recruitment", severity: "warning", issues: [{ code: "otebo_panel_channel_mismatch", severity: "warning", blocking: false }] },
      },
    },
  );
  assert.deepEqual(candidates.map((candidate) => candidate.key), ["profile_panel.ensure", "otebo_panel.ensure"]);
  assert.deepEqual(candidates.map((candidate) => candidate.evidence.code), ["profile_panel_channel_mismatch", "otebo_panel_channel_mismatch"]);
});

test("reconciliation observes read-only validation and operational status, and unknown evidence is not a repair candidate", async () => {
  const fixture = createFixture({
    validate: {
      status: "unknown",
      reports: [{ checks: [{ key: "profile.channel", status: "unknown", reason: "fetch-failed" }] }],
    },
    operational: { modules: { system: { key: "system", severity: "unknown", issues: [{ code: "panel_check_failed", severity: "unknown" }] } } },
  });
  const result = await fixture.service.runNow();
  assert.equal(result.status, "completed");
  assert.equal(fixture.model.rows[0].status, "unknown");
  assert.deepEqual(fixture.model.rows[0].candidates, []);
  assert.equal(fixture.calls.operational[0].options.persistHealth, false);
  assert.equal(fixture.calls.operational[0].options.readOnly, true);
  assert.equal(fixture.calls.release, 1);
});

test("reconciliation observation upsert keeps guildId without a conflicting update path", async () => {
  const fixture = createFixture();
  await fixture.service.runNow();
  assert.equal(fixture.model.rows.length, 1);
  assert.equal(fixture.model.rows[0].guildId, "guild-1");

  // The second run exercises the existing-row update path as well as the
  // first-run upsert path against a double that rejects MongoDB path conflicts.
  await fixture.service.runNow();
  assert.equal(fixture.model.rows.length, 1);
  assert.equal(fixture.model.rows[0].guildId, "guild-1");
});

test("lease contention skips a guild, overlapping ticks are suppressed, and guild failures are isolated", async () => {
  let releaseValidation;
  const validationStarted = new Promise((resolve) => {
    releaseValidation = resolve;
  });
  let started = false;
  const fixture = createFixture({
    guilds: [{ id: "guild-1" }, { id: "guild-2" }],
    validate: async ({ guild }) => {
      if (guild.id === "guild-1") {
        started = true;
        await validationStarted;
        return healthyValidation();
      }
      throw new Error("guild two read failed");
    },
    lease: {
      acquire: async (key) => key.endsWith("guild-1") ? { lockKey: key, ownerId: "worker", leaseId: "one" } : null,
    },
  });
  const first = fixture.service.runNow();
  while (!started) await new Promise((resolve) => setImmediate(resolve));
  const overlap = await fixture.service.runNow();
  assert.equal(overlap.status, "skipped");
  assert.equal(overlap.reason, "overlap");
  releaseValidation();
  const result = await first;
  assert.equal(result.status, "completed");
  assert.equal(result.results[0].status, "healthy");
  assert.equal(result.results[1].status, "skipped");
  assert.equal(fixture.model.rows.length, 1);
  assert.equal(fixture.calls.release, 1);
});

test("failed observations increment consecutiveFailures and a later confirmed run resets them", async () => {
  let shouldFail = true;
  const fixture = createFixture({
    validate: async () => {
      if (shouldFail) throw new Error("temporary\nsecret-token");
      return healthyValidation();
    },
  });
  await fixture.service.runNow();
  assert.equal(fixture.model.rows[0].status, "failed");
  assert.equal(fixture.model.rows[0].consecutiveFailures, 1);
  assert.equal(fixture.model.rows[0].lastError.includes("secret-token"), false);
  assert.match(fixture.model.rows[0].lastError, /secret-\[redacted\]/);
  shouldFail = false;
  await fixture.service.runNow();
  assert.equal(fixture.model.rows[0].status, "healthy");
  assert.equal(fixture.model.rows[0].consecutiveFailures, 0);
  assert.equal(fixture.model.rows[0].lastError, null);
});

test("a validation exception records failed for one guild and still observes the next guild", async () => {
  const fixture = createFixture({
    guilds: [{ id: "guild-1" }, { id: "guild-2" }],
    validate: ({ guild }) => {
      if (guild.id === "guild-1") throw new Error("guild one unavailable");
      return healthyValidation();
    },
  });
  const result = await fixture.service.runNow();
  assert.deepEqual(result.results.map((item) => item.status), ["failed", "healthy"]);
  assert.deepEqual(fixture.model.rows.map((row) => row.status), ["failed", "healthy"]);
  assert.equal(fixture.calls.validate, 2);
});

test("heartbeat keeps a long read leased and a lost heartbeat forbids observation overwrite", async () => {
  let heartbeat;
  let releaseRead;
  const readDone = new Promise((resolve) => { releaseRead = resolve; });
  let renewed = 0;
  let lost = false;
  const model = createObservationModel();
  const longService = createReconciliationService({
    getGuilds: () => [{ id: "guild-1" }],
    validationService: { validateGuild: async () => { await readDone; return healthyValidation(); } },
    operationalStatusService: { getOperationalStatusSnapshot: async () => healthyOperational() },
    observationModel: model,
    acquireLease: async () => ({ lockKey: "k", ownerId: "o", leaseId: "l" }),
    renewLease: async () => { renewed += 1; return !lost; },
    releaseLease: async () => {},
    leaseMs: 30,
    setHeartbeatIntervalFn: (callback) => { heartbeat = callback; return { unref() {} }; },
    clearHeartbeatIntervalFn: () => {},
    now: () => new Date("2026-08-22T00:00:00.000Z"),
    logger: { warn() {} },
  });
  const run = longService.runNow();
  while (!heartbeat) await new Promise((resolve) => setImmediate(resolve));
  await heartbeat();
  assert.equal(renewed >= 1, true);
  lost = true;
  await heartbeat();
  releaseRead();
  const result = await run;
  assert.equal(result.results[0].status, "skipped");
  assert.equal(result.results[0].reason, "lease-lost");
  assert.equal(model.rows.length, 0);
});

test("start schedules an unref interval, dispatches immediately, and shutdown clears it after drain", async () => {
  let intervalCallback;
  let cleared = false;
  let releaseRead;
  const readDone = new Promise((resolve) => { releaseRead = resolve; });
  let started = false;
  const fixture = createFixture({
    validate: async () => {
      started = true;
      await readDone;
      return healthyValidation();
    },
  });
  const service = createReconciliationService({
    getGuilds: () => [{ id: "guild-1" }],
    validationService: { validateGuild: async () => {
      started = true;
      await readDone;
      return healthyValidation();
    } },
    operationalStatusService: { getOperationalStatusSnapshot: async () => healthyOperational() },
    observationModel: fixture.model,
    acquireLease: fixture.leases.acquire,
    renewLease: fixture.leases.renew,
    releaseLease: fixture.leases.release,
    setIntervalFn: (callback) => { intervalCallback = callback; return { unref() {} }; },
    clearIntervalFn: () => { cleared = true; },
    drainTimeoutMs: 500,
    logger: { warn() {} },
  });
  const startedResult = await service.start();
  assert.equal(startedResult.status, "started");
  while (!started) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(typeof intervalCallback, "function");
  const stopping = service.stop();
  assert.equal(cleared, true);
  releaseRead();
  await stopping;
  assert.equal(service.isStarted(), false);
});

test("reconcile_status is ManageGuild-only, ephemeral, bounded, and reports an unexecuted run", async () => {
  const feature = createConfigurationFeature({
    configurationService: { listHistory: async () => [] },
    reconciliationService: { getLatest: async () => null },
  });
  const responses = [];
  await feature.handleConfig({
    guildId: "guild-1",
    inGuild: () => true,
    memberPermissions: { has: (permission) => permission === PermissionFlagsBits.ManageGuild },
    options: { getSubcommand: () => "reconcile_status" },
    deferReply: async (payload) => responses.push(["defer", payload]),
    editReply: async (payload) => responses.push(["edit", payload]),
    followUp: async (payload) => responses.push(["follow", payload]),
  });
  assert.equal(configCommand.toJSON().options.some((option) => option.name === "reconcile_status"), true);
  assert.equal(responses[0][1].flags, 64);
  const content = responses.at(-1)[1].content;
  assert.match(content, /まだ実行されていません/);
  assert.equal(responses.at(-1)[1].allowedMentions.parse.length, 0);
  assert.ok(content.length <= 1_900);
  assert.match(formatReconciliationStatus({ status: "warning", candidates: [{ key: "x", reason: "safe", evidenceStatus: "warning" }] }), /修復候補/);
});
