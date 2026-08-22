import test from "node:test";
import assert from "node:assert/strict";
import { PermissionFlagsBits, PermissionsBitField } from "discord.js";
import { configCommand, commands } from "../src/commands.js";
import {
  ConfigurationRevisionConflictError,
  ConfigurationRevisionNotFoundError,
  ConfigurationRevisionReadbackError,
  createConfigurationService,
  createEffectiveConfigurationWriter,
} from "../src/configuration-service.js";
import {
  canonicalizeConfiguration,
  diffConfiguration,
  pickConfigurationPatch,
} from "../src/settings-configuration.js";
import { createConfigurationFeature } from "../src/features/configuration.js";
import { createGuildOperationsFeature } from "../src/features/guild-operations.js";

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function query(value) {
  return {
    lean: async () => clone(value),
    session() { return this; },
    sort() { return this; },
    limit(limit) {
      if (Array.isArray(value)) this.lean = async () => clone(value.slice(0, limit));
      return this;
    },
    then(resolve, reject) { return Promise.resolve(clone(value)).then(resolve, reject); },
  };
}

function matchesFilter(document, filter) {
  if (!document || document.guildId !== filter.guildId) return false;
  if (!filter.$or) return true;
  return filter.$or.some((condition) => {
    if (condition.configRevision?.$exists === false) return document.configRevision === undefined;
    return document.configRevision === condition.configRevision;
  });
}

function createMemoryModels(initial = {}) {
  const settings = new Map(Object.entries(initial).map(([guildId, value]) => [guildId, { guildId, ...clone(value) }]));
  const revisions = [];
  const settingsModel = {
    findOne(filter) { return query(settings.get(filter.guildId) ?? null); },
    find(filter = {}) {
      return query([...settings.values()].filter((document) => !filter.guildId || document.guildId === filter.guildId));
    },
    findOneAndUpdate(filter, update) {
      let document = settings.get(filter.guildId);
      if (document && !matchesFilter(document, filter)) return query(null);
      if (!document) document = { guildId: filter.guildId };
      if (update.$set) Object.assign(document, clone(update.$set));
      if (update.$unset) for (const key of Object.keys(update.$unset)) delete document[key];
      if (update.$setOnInsert && !settings.has(filter.guildId)) Object.assign(document, clone(update.$setOnInsert));
      settings.set(filter.guildId, document);
      return query(document);
    },
    updateMany(filter, update) {
      let modifiedCount = 0;
      for (const document of settings.values()) {
        const matchesGuild = !filter.guildId || filter.guildId === document.guildId;
        const missingRevision = document.configRevision === undefined;
        if (matchesGuild && filter.configRevision?.$exists === false && missingRevision) {
          Object.assign(document, clone(update.$set));
          modifiedCount += 1;
        }
      }
      return query({ modifiedCount });
    },
  };
  const revisionModel = {
    create: async (documents) => {
      const values = Array.isArray(documents) ? documents : [documents];
      revisions.push(...clone(values));
      return values;
    },
    find(filter) {
      const rows = revisions.filter((row) => row.guildId === filter.guildId);
      return query(rows);
    },
    findOne(filter) {
      return query(revisions.find((row) => row.guildId === filter.guildId && row.revision === filter.revision) ?? null);
    },
  };
  return { settings, revisions, settingsModel, revisionModel };
}

function createService(initial = {}) {
  const models = createMemoryModels(initial);
  const service = createConfigurationService({
    settingsModel: models.settingsModel,
    revisionModel: models.revisionModel,
    transactionRunner: async (work) => work(null),
    now: () => new Date("2026-08-22T00:00:00.000Z"),
  });
  return { ...models, service };
}

test("configuration catalog excludes runtime state, secrets, and environment-only values", () => {
  const snapshot = canonicalizeConfiguration({
    childCategoryId: "category",
    vcDmTargetChannelIds: ["b", "a", "a"],
    callWaitPrompt: { messageId: "runtime-message" },
    kokuchiEventId: "runtime-event",
    token: "secret",
    environmentFallback: "not-persisted",
  });
  assert.deepEqual(snapshot, {
    childCategoryId: "category",
    vcDmTargetChannelIds: ["a", "b"],
  });
  assert.throws(() => pickConfigurationPatch({ callWaitPrompt: { messageId: "runtime" } }), /Unsupported administrator configuration/);
});

test("canonical diff reports additions, changes, and removals deterministically", () => {
  const diff = diffConfiguration(
    { childCategoryId: "old", waitingVcName: "old", splitMode: "direct" },
    { childCategoryId: "new", finishMessage: "done", splitMode: "direct" },
  );
  assert.deepEqual(diff.added, [{ key: "finishMessage", to: "done" }]);
  assert.deepEqual(diff.changed, [{ key: "childCategoryId", from: "old", to: "new" }]);
  assert.deepEqual(diff.removed, [{ key: "waitingVcName", from: "old" }]);
  assert.equal(diff.count, 3);
});

test("explicit null remains in snapshots and rollback instead of reviving an environment value", async () => {
  const { service, settings, revisions } = createService({ guild1: {
    configRevision: 1,
    callWaitNoticeChannelId: "environment-or-old-channel",
  } });
  const cleared = await service.updateConfiguration("guild1", { callWaitNoticeChannelId: null }, {
    expectedRevision: 1,
    source: "setting",
  });
  assert.deepEqual(cleared.snapshot, { callWaitNoticeChannelId: null });
  assert.deepEqual(cleared.changes.changed, [{ key: "callWaitNoticeChannelId", from: "environment-or-old-channel", to: null }]);
  assert.equal(settings.get("guild1").callWaitNoticeChannelId, null);

  await service.updateConfiguration("guild1", { callWaitNoticeChannelId: "new-channel" }, {
    expectedRevision: 2,
    source: "setting",
  });
  const rolledBack = await service.rollbackConfiguration("guild1", 2, {
    expectedRevision: 3,
    source: "config/rollback",
  });
  assert.equal(rolledBack.revision, 4);
  assert.equal(settings.get("guild1").callWaitNoticeChannelId, null);
  assert.equal(revisions.at(-1).snapshot.callWaitNoticeChannelId, null);
  assert.deepEqual(revisions.at(-1).changes.changed, [{ key: "callWaitNoticeChannelId", from: "new-channel", to: null }]);
});

test("versioned update increments exactly once after an existing guild baseline", async () => {
  const { service, revisions, settings } = createService({ guild1: { childCategoryId: "old", callWaitPrompt: { messageId: "runtime" } } });
  await service.backfillGuildSettings("guild1");
  const result = await service.updateConfiguration("guild1", { childCategoryId: "new" }, {
    expectedRevision: 1,
    actorUserId: "user1",
    source: "setting",
    reason: "test update",
  });
  assert.equal(result.revision, 2);
  assert.equal(settings.get("guild1").configRevision, 2);
  assert.equal(revisions.length, 2);
  assert.deepEqual(revisions[1].snapshot, { childCategoryId: "new" });
  assert.equal("callWaitPrompt" in revisions[1].snapshot, false);
  assert.equal(revisions[1].actorUserId, "user1");
  assert.deepEqual(revisions[1].changes.changed, [{ key: "childCategoryId", from: "old", to: "new" }]);
});

test("first versioned update creates metadata for a guild without a stored document", async () => {
  const { service, settings, revisions } = createService();
  const result = await service.updateConfiguration("new-guild", { splitMode: "direct" }, { expectedRevision: 0, source: "setting" });
  assert.equal(result.revision, 1);
  assert.equal(settings.get("new-guild").configRevision, 1);
  assert.equal(revisions[0].baseRevision, 0);
});

test("CAS allows only one of two concurrent updates and rejects stale writes", async () => {
  const { service } = createService({ guild1: { configRevision: 1, splitMode: "direct" } });
  const outcomes = await Promise.allSettled([
    service.updateConfiguration("guild1", { childCategoryId: "a" }, { expectedRevision: 1, actorUserId: "a", source: "setting" }),
    service.updateConfiguration("guild1", { childCategoryId: "b" }, { expectedRevision: 1, actorUserId: "b", source: "setting" }),
  ]);
  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter((outcome) => outcome.status === "rejected" && outcome.reason instanceof ConfigurationRevisionConflictError).length, 1);
  await assert.rejects(
    service.updateConfiguration("guild1", { childCategoryId: "stale" }, { expectedRevision: 1, source: "setting" }),
    (error) => error.code === "CONFIGURATION_REVISION_CONFLICT" && error.actualRevision === 2,
  );
});

test("history, show, and diff cannot cross guild boundaries", async () => {
  const { service } = createService();
  await service.updateConfiguration("guild1", { splitMode: "direct" }, { expectedRevision: 0, source: "setting" });
  assert.equal((await service.listHistory("guild2", 20)).length, 0);
  await assert.rejects(service.getRevision("guild2", 1), ConfigurationRevisionNotFoundError);
  await assert.rejects(service.diffRevisions("guild2", 0, 1), ConfigurationRevisionNotFoundError);
  assert.equal((await service.getRevision("guild1", 1)).snapshot.splitMode, "direct");
});

test("backfill creates an idempotent baseline without runtime or environment values", async () => {
  const { service, settings, revisions } = createService({ guild1: { childCategoryId: "category", callWaitPrompt: { messageId: "runtime" }, environmentFallback: "must-not-enter" } });
  const first = await service.backfillGuildSettings("guild1");
  const second = await service.backfillGuildSettings("guild1");
  assert.equal(first.modifiedCount, 1);
  assert.equal(second.modifiedCount, 0);
  assert.equal(settings.get("guild1").configRevision, 1);
  assert.equal(revisions.length, 1);
  assert.deepEqual(revisions[0].snapshot, { childCategoryId: "category" });
  assert.equal(revisions[0].changes.baseline, true);
  assert.equal(revisions[0].source, "migration/backfill");
  const updated = await service.updateConfiguration("guild1", { childCategoryId: "changed" }, { expectedRevision: 1, source: "setting" });
  assert.equal(updated.revision, 2);
  assert.deepEqual(updated.changes.changed, [{ key: "childCategoryId", from: "category", to: "changed" }]);
});

test("concurrent backfill creates one baseline and promotes an intermediate revision zero", async () => {
  const { service, settings, revisions } = createService({ guild1: { configRevision: 0, splitMode: "direct" } });
  const results = await Promise.all([
    service.backfillGuildSettings("guild1"),
    service.backfillGuildSettings("guild1"),
  ]);
  assert.equal(settings.get("guild1").configRevision, 1);
  assert.equal(revisions.filter((row) => row.guildId === "guild1" && row.revision === 1).length, 1);
  assert.equal(results.filter((result) => result.baselineCreatedCount === 1).length, 1);
});

test("effective versioned writer rehydrates environment defaults and verifies the committed revision", async () => {
  const calls = [];
  const writer = createEffectiveConfigurationWriter({
    updateConfiguration: async (...args) => {
      calls.push(args);
      return {
        revision: 3,
        baseRevision: 2,
        schemaVersion: 1,
        snapshot: { splitMode: "direct" },
        changes: { added: [], changed: [], removed: [], count: 0, keys: [] },
      };
    },
    getGuildSettings: async (guildId) => ({
      guildId,
      configRevision: 3,
      splitMode: "direct",
      callWaitNoticeChannelId: "environment-only-channel",
    }),
  });
  const effective = await writer("guild1", { splitMode: "direct" }, { expectedRevision: 2, source: "setting" });
  assert.equal(effective.callWaitNoticeChannelId, "environment-only-channel");
  assert.equal(effective.configRevision, 3);
  assert.equal(effective.revision, 3);
  assert.equal(effective.committedRevision, 3);
  assert.equal(effective.superseded, undefined);
  assert.equal(calls.length, 1);
  await assert.rejects(
    createEffectiveConfigurationWriter({
      updateConfiguration: async () => ({ revision: 4 }),
      getGuildSettings: async () => ({ guildId: "guild1", configRevision: 3 }),
    })("guild1", {}, { expectedRevision: 3 }),
    (error) => error instanceof ConfigurationRevisionReadbackError
      && error.code === "CONFIGURATION_REVISION_READBACK_CONFLICT",
  );
  await assert.rejects(
    createEffectiveConfigurationWriter({
      updateConfiguration: async () => ({ revision: 2 }),
      getGuildSettings: async () => null,
    })("guild1", {}, { expectedRevision: 1 }),
    (error) => error instanceof ConfigurationRevisionReadbackError
      && error.code === "CONFIGURATION_REVISION_READBACK_CONFLICT",
  );
});

test("effective writer returns a newer concurrent readback without mixing committed history metadata", async () => {
  const committed = {
    revision: 3,
    baseRevision: 2,
    schemaVersion: 1,
    snapshot: { splitMode: "direct" },
    changes: { added: [], changed: [{ key: "splitMode" }], removed: [], count: 1, keys: ["splitMode"] },
    source: "setting",
  };
  const effective = await createEffectiveConfigurationWriter({
    updateConfiguration: async () => committed,
    getGuildSettings: async () => ({
      guildId: "guild1",
      configRevision: 4,
      splitMode: "partybeast",
      fukyoThemeChannelId: "latest-channel",
    }),
  })("guild1", { splitMode: "direct" }, { expectedRevision: 2 });
  assert.equal(effective.configRevision, 4);
  assert.equal(effective.revision, 4);
  assert.equal(effective.committedRevision, 3);
  assert.equal(effective.superseded, true);
  assert.equal(effective.splitMode, "partybeast");
  assert.equal(effective.fukyoThemeChannelId, "latest-channel");
  assert.equal("snapshot" in effective, false);
  assert.equal("changes" in effective, false);
  assert.equal(effective.committedResult, committed);
});

test("versioned companion runtime patch commits with fukyo enabled and stays out of snapshots", async () => {
  const { service, settings, revisions } = createService({ guild1: { configRevision: 1, fukyoWeeklyThemeEnabled: false } });
  const saved = await service.updateConfiguration("guild1", { fukyoWeeklyThemeEnabled: true }, {
    expectedRevision: 1,
    source: "setting",
    companionPatch: { fukyoWeeklyThemeEnabledAt: new Date("2026-08-22T00:00:00.000Z") },
  });
  assert.equal(settings.get("guild1").fukyoWeeklyThemeEnabled, true);
  assert.equal(settings.get("guild1").fukyoWeeklyThemeEnabledAt, "2026-08-22T00:00:00.000Z");
  assert.equal(saved.snapshot.fukyoWeeklyThemeEnabledAt, undefined);
  assert.equal(revisions.at(-1).snapshot.fukyoWeeklyThemeEnabledAt, undefined);
  assert.deepEqual(saved.changes.changed, [{ key: "fukyoWeeklyThemeEnabled", from: false, to: true }]);
  await assert.rejects(
    service.updateConfiguration("guild1", { fukyoWeeklyThemeEnabled: false }, {
      expectedRevision: 2,
      companionPatch: { callWaitPrompt: "not-allowed" },
    }),
    (error) => error.code === "UNSUPPORTED_VERSIONED_COMPANION_KEY",
  );
});

test("companion and administrator settings roll back together when the revision insert fails", async () => {
  const models = createMemoryModels({ guild1: { configRevision: 1, fukyoWeeklyThemeEnabled: false } });
  const beforeSettings = clone(models.settings.get("guild1"));
  const failingRevisionModel = {
    create: async () => { throw new Error("revision insert failed"); },
    findOne: models.revisionModel.findOne,
  };
  const service = createConfigurationService({
    settingsModel: models.settingsModel,
    revisionModel: failingRevisionModel,
    transactionRunner: async (work) => {
      const settingsBefore = clone(models.settings.get("guild1"));
      const revisionsBefore = clone(models.revisions);
      try {
        return await work(null);
      } catch (error) {
        models.settings.set("guild1", settingsBefore);
        models.revisions.splice(0, models.revisions.length, ...revisionsBefore);
        throw error;
      }
    },
  });
  await assert.rejects(
    service.updateConfiguration("guild1", { fukyoWeeklyThemeEnabled: true }, {
      expectedRevision: 1,
      companionPatch: { fukyoWeeklyThemeEnabledAt: "2026-08-22T00:00:00.000Z" },
    }),
    /revision insert failed/,
  );
  assert.deepEqual(models.settings.get("guild1"), beforeSettings);
  assert.equal(models.revisions.length, 0);
});

test("standalone MongoDB rejects versioned updates before any write", async () => {
  let reads = 0;
  let writes = 0;
  const service = createConfigurationService({
    connection: { readyState: 1, client: { topology: { description: { type: "Single" } } } },
    settingsModel: {
      findOne: () => { reads += 1; return query(null); },
      findOneAndUpdate: () => { writes += 1; return query(null); },
    },
    revisionModel: { create: async () => { writes += 1; } },
  });
  await assert.rejects(
    service.updateConfiguration("guild1", { splitMode: "direct" }, { expectedRevision: 0, source: "setting" }),
    (error) => error.code === "CONFIGURATION_TRANSACTIONS_UNAVAILABLE",
  );
  assert.equal(reads, 0);
  assert.equal(writes, 0);
});

test("config command is ManageGuild-only, ephemeral, guild-scoped, and mention-safe", async () => {
  const calls = [];
  const feature = createConfigurationFeature({
    configurationService: {
      listHistory: async (guildId) => {
        calls.push(["history", guildId]);
        return [{ guildId, revision: 1, baseRevision: 0, actorUserId: "user", source: "setting", changes: { count: 1 }, createdAt: "2026-08-22T00:00:00.000Z", snapshot: { token: "must-not-display" } }];
      },
      getRevision: async (guildId, revision) => ({ guildId, revision: revision ?? 1, snapshot: { childCategoryId: "channel" } }),
      diffRevisions: async (guildId, from, to) => ({ guildId, fromRevision: from, toRevision: to, changes: { added: [{ key: "childCategoryId", to: "channel" }], changed: [], removed: [] } }),
    },
  });
  const responses = [];
  await feature.handleConfig({
    guildId: "guild1",
    inGuild: () => true,
    memberPermissions: { has: (permission) => permission === PermissionFlagsBits.ManageGuild },
    options: {
      getSubcommand: () => "history",
      getInteger: () => 20,
    },
    deferReply: async (payload) => responses.push(["defer", payload]),
    editReply: async (payload) => responses.push(["edit", payload]),
    followUp: async (payload) => responses.push(["follow", payload]),
  });
  assert.deepEqual(calls, [["history", "guild1"]]);
  assert.equal(responses[0][1].flags, 64);
  assert.equal(responses.find(([type]) => type === "edit")[1].flags, undefined);
  assert.equal(responses.at(-1)[1].allowedMentions.parse.length, 0);
  assert.match(responses.at(-1)[1].content, /r1/);
  assert.doesNotMatch(responses.at(-1)[1].content, /must-not-display/);
  assert.ok(commands.some((command) => command.name === "config"));
  const json = configCommand.toJSON();
  assert.equal(json.default_member_permissions, String(PermissionFlagsBits.ManageGuild));
  assert.equal(json.dm_permission, false);
  assert.deepEqual(json.options.map((option) => option.name), ["history", "show", "diff", "rollback", "apply_status", "apply_retry", "reconcile_status", "repair_status", "repair_retry"]);
});

test("config deferred response edits omit flags while overflow followups remain ephemeral", async () => {
  const responses = [];
  const rows = Array.from({ length: 20 }, (_, index) => ({
    guildId: "guild1",
    revision: index + 1,
    baseRevision: index,
    actorUserId: "actor",
    source: "setting",
    reason: "x".repeat(120),
    changes: { count: 1 },
    createdAt: "2026-08-22T00:00:00.000Z",
  }));
  const feature = createConfigurationFeature({
    configurationService: { listHistory: async () => rows },
  });
  await feature.handleConfig({
    guildId: "guild1",
    inGuild: () => true,
    memberPermissions: { has: (permission) => permission === PermissionFlagsBits.ManageGuild },
    options: { getSubcommand: () => "history", getInteger: () => 20 },
    deferReply: async (payload) => responses.push(["defer", payload]),
    editReply: async (payload) => responses.push(["edit", payload]),
    followUp: async (payload) => responses.push(["follow", payload]),
  });
  assert.equal(responses[0][1].flags, 64);
  assert.equal(responses[1][1].flags, undefined);
  assert.ok(responses.some(([type]) => type === "follow"));
  assert.ok(responses.filter(([type]) => type === "follow").every(([, payload]) => payload.flags === 64));
});

test("config gives an explicit transaction-unavailable message without implying history is merely empty", async () => {
  const feature = createConfigurationFeature({
    configurationService: {
      listHistory: async () => {
        const error = new Error("transactions are unavailable");
        error.code = "CONFIGURATION_TRANSACTIONS_UNAVAILABLE";
        throw error;
      },
    },
  });
  const responses = [];
  await feature.handleConfig({
    guildId: "guild1",
    inGuild: () => true,
    memberPermissions: { has: (permission) => permission === PermissionFlagsBits.ManageGuild },
    options: { getSubcommand: () => "history", getInteger: () => 20 },
    deferReply: async (payload) => responses.push(["defer", payload]),
    editReply: async (payload) => responses.push(["edit", payload]),
    followUp: async (payload) => responses.push(["follow", payload]),
  });
  const content = responses.at(-1)[1].content;
  assert.match(content, /MongoDBトランザクション/);
  assert.match(content, /設定は変更していません/);
});

test("/setting management path sends expectedRevision metadata to the versioned writer", async () => {
  const writes = [];
  const replies = [];
  const feature = createGuildOperationsFeature({
    MessageFlags: { Ephemeral: 64 },
    PermissionsBitField,
    getGuildSettings: async () => ({ configRevision: 4 }),
    saveGuildSettingsWithCurrent: async () => { throw new Error("runtime writer must not handle /setting"); },
    saveVersionedGuildConfiguration: async (guildId, patch, options) => {
      writes.push({ guildId, patch, options });
      return { guildId, configRevision: 5, splitMode: patch.splitMode };
    },
    replyOrFollowUp: async (_interaction, payload) => replies.push(payload),
    formatSettings: () => "safe settings",
  });
  await feature.handleSetting({
    guildId: "guild1",
    user: { id: "actor1" },
    inGuild: () => true,
    memberPermissions: { has: (permission) => permission === PermissionFlagsBits.ManageGuild },
    options: {
      getSubcommand: () => "splitvc",
      getString: (name) => name === "mode" ? "direct" : null,
      getChannel: () => null,
      getRole: () => null,
      getInteger: () => null,
    },
    deferReply: async () => {},
  });
  assert.deepEqual(writes, [{
    guildId: "guild1",
    patch: { splitMode: "direct" },
    options: {
      expectedRevision: 4,
      actorUserId: "actor1",
      source: "setting",
      reason: "setting-command",
    },
  }]);
  assert.match(replies[0].content, /safe settings/);
});
