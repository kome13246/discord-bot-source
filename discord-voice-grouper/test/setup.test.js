import test from "node:test";
import assert from "node:assert/strict";
import {
  ChannelType,
  PermissionFlagsBits,
} from "discord.js";
import { commands, setupCommand } from "../src/commands.js";
import { createInteractionHandler } from "../src/interaction-router.js";
import { GuildSetupDraft, SETUP_DRAFT_FEATURES } from "../src/models/setup-draft.js";
import { createSetupFeature, buildSetupCustomId } from "../src/features/setup.js";
import {
  SETUP_FEATURE_SCHEMAS,
  validateSetupDraft,
} from "../src/setup-schema.js";
import { createSetupDraftService } from "../src/setup-service.js";
import { ADMIN_CONFIGURATION_KEYS } from "../src/settings-configuration.js";

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function matches(document, filter = {}) {
  if (!document) return false;
  return Object.entries(filter).every(([key, expected]) => {
    if (key === "$or") return expected.some((condition) => matches(document, condition));
    if (expected && typeof expected === "object" && !Array.isArray(expected)) {
      if (Object.hasOwn(expected, "$in")) return expected.$in.includes(document[key]);
      if (Object.hasOwn(expected, "$lte")) return document[key] <= expected.$lte;
      if (Object.hasOwn(expected, "$exists")) return expected.$exists === (document[key] !== undefined);
    }
    return document[key] === expected;
  });
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

function applyUpdate(document, update) {
  if (update?.$set) Object.assign(document, clone(update.$set));
  if (update?.$unset) for (const key of Object.keys(update.$unset)) delete document[key];
  return document;
}

function createDraftModel(initial = []) {
  const rows = initial.map(clone);
  const model = {
    rows,
    findOne(filter) { return query(rows.find((row) => matches(row, filter)) ?? null); },
    find(filter) { return query(rows.filter((row) => matches(row, filter))); },
    findOneAndUpdate(filter, update) {
      const row = rows.find((candidate) => matches(candidate, filter));
      return query(row ? applyUpdate(row, update) : null);
    },
    create: async (documents) => {
      const values = Array.isArray(documents) ? documents : [documents];
      for (const value of values) {
        if (rows.some((row) => row.guildId === value.guildId && ["active", "committing"].includes(row.status))) {
          const error = new Error("duplicate active setup draft");
          error.code = 11000;
          throw error;
        }
      }
      rows.push(...values.map(clone));
      return values.map(clone);
    },
  };
  return model;
}

function createService({ settings = {}, now = new Date("2026-08-22T00:00:00.000Z"), writer = null } = {}) {
  const model = createDraftModel();
  const current = { guildId: "guild-1", configRevision: 2, ...clone(settings) };
  const writes = [];
  const save = writer ?? (async (guildId, patch, options) => {
    writes.push({ guildId, patch: clone(patch), options: clone(options) });
    current.configRevision = options.expectedRevision + 1;
    Object.assign(current, clone(patch));
    return { ...clone(current), revision: current.configRevision, apply: { status: "pending" } };
  });
  const service = createSetupDraftService({
    draftModel: model,
    getGuildSettings: async () => clone(current),
    saveVersionedGuildConfiguration: save,
    now: () => now,
  });
  return { current, model, service, writes };
}

function permissionInteraction({ userId = "admin-1", guildId = "guild-1", overrides = {} } = {}) {
  let lastReply = null;
  const interaction = {
    guildId,
    user: { id: userId },
    guild: { id: guildId, channels: { cache: new Map() }, roles: { cache: new Map() } },
    memberPermissions: { has: (permission) => permission === PermissionFlagsBits.ManageGuild },
    deferred: false,
    replied: false,
    inGuild: () => true,
    deferReply: async (payload) => { interaction.deferred = true; interaction.deferPayload = payload; },
    deferUpdate: async () => { interaction.deferred = true; },
    reply: async (payload) => { interaction.replied = true; lastReply = payload; },
    editReply: async (payload) => { lastReply = payload; return payload; },
    get lastReply() { return lastReply; },
    ...overrides,
  };
  return interaction;
}

test("/setup command is guild-management scoped and registered", () => {
  const json = setupCommand.toJSON();
  assert.equal(json.name, "setup");
  assert.equal(json.default_member_permissions, String(PermissionFlagsBits.ManageGuild));
  assert.equal(json.dm_permission, false);
  assert.ok(commands.some((command) => command.name === "setup"));
});

test("setup schema covers every supported feature and only catalog keys", () => {
  assert.deepEqual(Object.keys(SETUP_FEATURE_SCHEMAS).sort(), [...SETUP_DRAFT_FEATURES].sort());
  for (const schema of Object.values(SETUP_FEATURE_SCHEMAS)) {
    for (const field of schema.fields) assert.ok(ADMIN_CONFIGURATION_KEYS.has(field.key), field.key);
  }
  for (const key of ["callWaitEnabled", "vcDmEnabled", "fukyoWeeklyThemeEnabled"]) {
    const field = Object.values(SETUP_FEATURE_SCHEMAS).flatMap((schema) => schema.fields).find((item) => item.key === key);
    assert.equal(field.choices.length, 2);
  }
  assert.equal(validateSetupDraft("profile", {}, {}).ok, false);
  assert.equal(validateSetupDraft("profile", { profileIntroductionChannelId: "channel" }, {}).ok, true);
  assert.equal(validateSetupDraft("callwait", { callWaitEnabled: false }, {}).ok, true);
  const vcDmCurrent = { kokuchiEventTime: "21:00", kokuchiEventTimeConfigured: false };
  assert.equal(validateSetupDraft("vc_dm", {
    vcDmEnabled: true,
    vcDmPanelChannelId: "panel",
    vcDmTargetCategoryId: "category",
  }, vcDmCurrent).ok, false);
  assert.equal(validateSetupDraft("vc_dm", {
    vcDmEnabled: true,
    kokuchiEventTime: "20:00",
    vcDmPanelChannelId: "panel",
    vcDmTargetCategoryId: "category",
  }, vcDmCurrent).ok, true);
  assert.equal(validateSetupDraft("vc_dm", {
    vcDmEnabled: true,
    kokuchiEventTime: null,
    vcDmPanelChannelId: "panel",
    vcDmTargetCategoryId: "category",
  }, { kokuchiEventTime: "21:00", kokuchiEventTimeConfigured: true }).ok, false);
  assert.equal(validateSetupDraft("status_board", {}, {}).ok, true);
  assert.equal(validateSetupDraft("profile", { profileIntroductionChannelId: "x", callWaitPrompt: "runtime" }, {}).ok, false);
});

test("setup draft is guild-wide busy, resumable, owner-isolated, and expires", async () => {
  const now = new Date("2026-08-22T00:00:00.000Z");
  const fixture = createService({ now });
  const created = await fixture.service.startDraft({ guildId: "guild-1", actorUserId: "admin-1" });
  assert.equal(created.status, "created");
  const resumed = await fixture.service.startDraft({ guildId: "guild-1", actorUserId: "admin-1" });
  assert.equal(resumed.status, "resumed");
  assert.equal(resumed.draft.sessionId, created.draft.sessionId);
  assert.equal((await fixture.service.startDraft({ guildId: "guild-1", actorUserId: "admin-2" })).status, "busy");
  assert.equal(await fixture.service.getDraft(created.draft.sessionId, { guildId: "other", actorUserId: "admin-1" }), null);
  assert.equal(await fixture.service.getDraft(created.draft.sessionId, { guildId: "guild-1", actorUserId: "admin-2" }), null);

  fixture.model.rows[0].expiresAt = new Date(now.getTime() - 1);
  const expired = await fixture.service.getDraft(created.draft.sessionId, { guildId: "guild-1", actorUserId: "admin-1", includeInactive: true });
  assert.equal(expired.status, "expired");
});

test("setup draft schema has a single guild-wide active/committing uniqueness guard", () => {
  const index = GuildSetupDraft.schema.indexes().find(([fields, options]) => (
    fields.guildId === 1
    && options?.unique === true
    && options.partialFilterExpression?.status?.$in?.includes("active")
    && options.partialFilterExpression.status.$in.includes("committing")
  ));
  assert.ok(index, "guild-wide active draft partial unique index is required");
});

test("feature reselection clears old patch and commit revalidates schema once", async () => {
  const fixture = createService();
  const draft = (await fixture.service.startDraft({ guildId: "guild-1", actorUserId: "admin-1" })).draft;
  const profile = await fixture.service.selectFeature({
    sessionId: draft.sessionId,
    guildId: draft.guildId,
    actorUserId: draft.actorUserId,
    feature: "profile",
    firstStep: "field:profileIntroductionChannelId",
  });
  const profilePatch = await fixture.service.mergePatch({
    sessionId: profile.sessionId,
    guildId: profile.guildId,
    actorUserId: profile.actorUserId,
    patch: { profileIntroductionChannelId: "channel-1" },
  });
  const split = await fixture.service.selectFeature({
    sessionId: profile.sessionId,
    guildId: profile.guildId,
    actorUserId: profile.actorUserId,
    feature: "splitvc",
    firstStep: "field:splitMode",
  });
  assert.deepEqual(split.patch, {});
  await fixture.service.updateDraft({ ...split, step: "review" });
  await assert.rejects(
    fixture.service.commitDraft({ sessionId: split.sessionId, guildId: split.guildId, actorUserId: split.actorUserId }),
    (error) => error.code === "SETUP_DRAFT_INVALID",
  );
  assert.equal(fixture.writes.length, 0);
});

test("valid setup confirm claims atomically and invokes the versioned writer once", async () => {
  const fixture = createService();
  const draft = (await fixture.service.startDraft({ guildId: "guild-1", actorUserId: "admin-1" })).draft;
  await fixture.service.selectFeature({ sessionId: draft.sessionId, guildId: draft.guildId, actorUserId: draft.actorUserId, feature: "profile", firstStep: "field:profileIntroductionChannelId" });
  const profilePatch = await fixture.service.mergePatch({ sessionId: draft.sessionId, guildId: draft.guildId, actorUserId: draft.actorUserId, patch: { profileIntroductionChannelId: "channel-1" } });
  await fixture.service.updateDraft({ ...profilePatch, step: "review" });
  const result = await fixture.service.commitDraft({ sessionId: draft.sessionId, guildId: draft.guildId, actorUserId: draft.actorUserId, reason: "wizard confirm" });
  assert.equal(result.status, "completed");
  assert.equal(result.revision, 3);
  assert.equal(fixture.writes.length, 1);
  assert.deepEqual(fixture.writes[0].patch, { profileIntroductionChannelId: "channel-1" });
  assert.equal(fixture.writes[0].options.expectedRevision, 2);
  assert.equal(fixture.writes[0].options.source, "setup");
  await assert.rejects(
    fixture.service.commitDraft({ sessionId: draft.sessionId, guildId: draft.guildId, actorUserId: draft.actorUserId }),
    (error) => error.code === "SETUP_DRAFT_CONFLICT",
  );
  assert.equal(fixture.writes.length, 1);
});

test("setup preserves fukyo enablement companion atomically and makes event time explicit for vc_dm", async () => {
  const now = new Date("2026-08-22T01:02:03.000Z");
  const fukyo = createService({ now, settings: { fukyoWeeklyThemeEnabled: false } });
  const fukyoDraft = (await fukyo.service.startDraft({ guildId: "guild-1", actorUserId: "admin-1" })).draft;
  await fukyo.service.selectFeature({ sessionId: fukyoDraft.sessionId, guildId: fukyoDraft.guildId, actorUserId: fukyoDraft.actorUserId, feature: "fukyo", firstStep: "field:fukyoWeeklyThemeEnabled" });
  const fukyoPatch = await fukyo.service.mergePatch({ sessionId: fukyoDraft.sessionId, guildId: fukyoDraft.guildId, actorUserId: fukyoDraft.actorUserId, patch: { fukyoWeeklyThemeEnabled: true, fukyoThemeChannelId: "theme-channel" } });
  await fukyo.service.updateDraft({ ...fukyoPatch, step: "review" });
  const committedFukyo = await fukyo.service.commitDraft({ sessionId: fukyoDraft.sessionId, guildId: fukyoDraft.guildId, actorUserId: fukyoDraft.actorUserId });
  assert.equal(committedFukyo.status, "completed");
  assert.deepEqual(fukyo.writes[0].options.companionPatch, { fukyoWeeklyThemeEnabledAt: now });
  assert.equal("fukyoWeeklyThemeEnabledAt" in fukyo.writes[0].patch, false);

  const vcDm = createService({ settings: { kokuchiEventTime: "21:00", kokuchiEventTimeConfigured: false } });
  const vcDmDraft = (await vcDm.service.startDraft({ guildId: "guild-1", actorUserId: "admin-1" })).draft;
  await vcDm.service.selectFeature({ sessionId: vcDmDraft.sessionId, guildId: vcDmDraft.guildId, actorUserId: vcDmDraft.actorUserId, feature: "vc_dm", firstStep: "field:vcDmEnabled" });
  const vcDmPatch = await vcDm.service.mergePatch({ sessionId: vcDmDraft.sessionId, guildId: vcDmDraft.guildId, actorUserId: vcDmDraft.actorUserId, patch: { vcDmEnabled: true, kokuchiEventTime: "20:00", vcDmPanelChannelId: "panel", vcDmTargetCategoryId: "category" } });
  await vcDm.service.updateDraft({ ...vcDmPatch, step: "review" });
  const committedVcDm = await vcDm.service.commitDraft({ sessionId: vcDmDraft.sessionId, guildId: vcDmDraft.guildId, actorUserId: vcDmDraft.actorUserId });
  assert.equal(committedVcDm.status, "completed");
  assert.equal(vcDm.writes[0].patch.kokuchiEventTimeConfigured, true);

  const invalidVcDm = createService({ settings: { kokuchiEventTime: "21:00", kokuchiEventTimeConfigured: true } });
  const invalidDraft = (await invalidVcDm.service.startDraft({ guildId: "guild-1", actorUserId: "admin-1" })).draft;
  await invalidVcDm.service.selectFeature({ sessionId: invalidDraft.sessionId, guildId: invalidDraft.guildId, actorUserId: invalidDraft.actorUserId, feature: "vc_dm", firstStep: "field:vcDmEnabled" });
  const invalidPatch = await invalidVcDm.service.mergePatch({ sessionId: invalidDraft.sessionId, guildId: invalidDraft.guildId, actorUserId: invalidDraft.actorUserId, patch: { vcDmEnabled: true, kokuchiEventTime: null, vcDmPanelChannelId: "panel", vcDmTargetCategoryId: "category" } });
  await invalidVcDm.service.updateDraft({ ...invalidPatch, step: "review" });
  await assert.rejects(invalidVcDm.service.commitDraft({ sessionId: invalidDraft.sessionId, guildId: invalidDraft.guildId, actorUserId: invalidDraft.actorUserId }), (error) => error.code === "SETUP_DRAFT_INVALID");
  assert.equal(invalidVcDm.writes.length, 0);
});

test("revision conflict, restart resume, and cancellation remain safe", async () => {
  const conflict = createService({ writer: async () => { const error = new Error("stale"); error.code = "CONFIGURATION_REVISION_CONFLICT"; throw error; } });
  const draft = (await conflict.service.startDraft({ guildId: "guild-1", actorUserId: "admin-1" })).draft;
  await conflict.service.selectFeature({ sessionId: draft.sessionId, guildId: draft.guildId, actorUserId: draft.actorUserId, feature: "profile", firstStep: "field:profileIntroductionChannelId" });
  const patch = await conflict.service.mergePatch({ sessionId: draft.sessionId, guildId: draft.guildId, actorUserId: draft.actorUserId, patch: { profileIntroductionChannelId: "channel" } });
  await conflict.service.updateDraft({ ...patch, step: "review" });
  const conflictResult = await conflict.service.commitDraft({ sessionId: draft.sessionId, guildId: draft.guildId, actorUserId: draft.actorUserId });
  assert.equal(conflictResult.status, "conflict");
  assert.equal((await conflict.service.getDraft(draft.sessionId, { guildId: draft.guildId, actorUserId: draft.actorUserId, includeInactive: true })).status, "cancelled");

  const resume = createService();
  const resumable = (await resume.service.startDraft({ guildId: "guild-1", actorUserId: "admin-1" })).draft;
  const secondService = createSetupDraftService({
    draftModel: resume.model,
    getGuildSettings: async () => clone(resume.current),
    saveVersionedGuildConfiguration: async () => ({ configRevision: 3, revision: 3 }),
    now: () => new Date("2026-08-22T00:00:00.000Z"),
  });
  const resumed = await secondService.startDraft({ guildId: "guild-1", actorUserId: "admin-1" });
  assert.equal(resumed.status, "resumed");
  assert.equal(resumed.draft.sessionId, resumable.sessionId);
  await secondService.cancelDraft({ sessionId: resumable.sessionId, guildId: "guild-1", actorUserId: "admin-1" });
  assert.equal((await secondService.getDraft(resumable.sessionId, { guildId: "guild-1", actorUserId: "admin-1", includeInactive: true })).status, "cancelled");
});

test("claimed draft is revalidated after the CAS claim and never writes an invalid concurrent patch", async () => {
  const model = createDraftModel();
  const originalFindOneAndUpdate = model.findOneAndUpdate.bind(model);
  model.findOneAndUpdate = (filter, update) => {
    const result = originalFindOneAndUpdate(filter, update);
    if (filter.status === "active" && filter.step === "review") {
      const originalLean = result.lean.bind(result);
      result.lean = async () => {
        const value = await originalLean();
        model.rows[0].patch = { callWaitPrompt: { messageId: "runtime" } };
        return value;
      };
    }
    return result;
  };
  const current = { guildId: "guild-1", configRevision: 2 };
  let writes = 0;
  const service = createSetupDraftService({
    draftModel: model,
    getGuildSettings: async () => clone(current),
    saveVersionedGuildConfiguration: async () => { writes += 1; return { configRevision: 3, revision: 3 }; },
  });
  const draft = (await service.startDraft({ guildId: "guild-1", actorUserId: "admin-1" })).draft;
  await service.selectFeature({ sessionId: draft.sessionId, guildId: draft.guildId, actorUserId: draft.actorUserId, feature: "profile", firstStep: "field:profileIntroductionChannelId" });
  const patch = await service.mergePatch({ sessionId: draft.sessionId, guildId: draft.guildId, actorUserId: draft.actorUserId, patch: { profileIntroductionChannelId: "channel" } });
  await service.updateDraft({ ...patch, step: "review" });
  await assert.rejects(
    service.commitDraft({ sessionId: draft.sessionId, guildId: draft.guildId, actorUserId: draft.actorUserId }),
    (error) => error.code === "SETUP_DRAFT_INVALID",
  );
  assert.equal(writes, 0);
  assert.equal((await service.getDraft(draft.sessionId, { guildId: draft.guildId, actorUserId: draft.actorUserId, includeInactive: true })).status, "cancelled");
});

test("setup commit revalidates kept and selected resources with a forced fetch, while skipping hidden or cleared values", async () => {
  async function commitFixture({ feature, patch, settings, resources = {}, fetchOverride = null }) {
    const model = createDraftModel([{
      sessionId: "session-1",
      guildId: "guild-1",
      actorUserId: "admin-1",
      baseRevision: 2,
      feature,
      step: "review",
      patch,
      status: "active",
      expiresAt: new Date("2026-08-23T00:00:00.000Z"),
    }]);
    const fetches = [];
    const guild = {
      id: "guild-1",
      channels: {
        cache: new Map(Object.entries(resources.channels ?? {})),
        fetch: async (id, options) => {
          fetches.push(["channel", id, options]);
          return fetchOverride ? fetchOverride("channel", id, options) : resources.channels?.[id] ?? null;
        },
      },
      roles: {
        cache: new Map(Object.entries(resources.roles ?? {})),
        fetch: async (id, options) => {
          fetches.push(["role", id, options]);
          return fetchOverride ? fetchOverride("role", id, options) : resources.roles?.[id] ?? null;
        },
      },
    };
    const writes = [];
    const service = createSetupDraftService({
      draftModel: model,
      getGuildSettings: async () => clone({ guildId: "guild-1", configRevision: 2, ...settings }),
      getGuild: async () => guild,
      saveVersionedGuildConfiguration: async (_guildId, nextPatch) => {
        writes.push(nextPatch);
        return { revision: 3, configRevision: 3 };
      },
      now: () => new Date("2026-08-22T00:00:00.000Z"),
    });
    const commit = service.commitDraft({ sessionId: "session-1", guildId: "guild-1", actorUserId: "admin-1" });
    return { commit, fetches, writes, row: model.rows[0] };
  }

  const selected = await commitFixture({
    feature: "profile",
    patch: { profileIntroductionChannelId: "selected" },
    settings: {},
    resources: { channels: { selected: { id: "selected", guildId: "guild-1", type: ChannelType.GuildText } } },
  });
  assert.equal((await selected.commit).status, "completed");
  assert.equal(selected.writes.length, 1);
  assert.deepEqual(selected.fetches, [["channel", "selected", { force: true }]]);

  const keptDeleted = await commitFixture({
    feature: "profile",
    patch: {},
    settings: { profileIntroductionChannelId: "kept" },
    resources: { channels: { kept: { id: "kept", guildId: "guild-1", type: ChannelType.GuildText } } },
    fetchOverride: (_kind, id, options) => options?.force === true && id === "kept" ? null : undefined,
  });
  await assert.rejects(keptDeleted.commit, (error) => error.code === "SETUP_DRAFT_RESOURCE_INVALID");
  assert.equal(keptDeleted.writes.length, 0);
  assert.equal(keptDeleted.row.status, "cancelled");

  const changedType = await commitFixture({
    feature: "profile",
    patch: { profileIntroductionChannelId: "changed" },
    settings: {},
    resources: { channels: { changed: { id: "changed", guildId: "guild-1", type: ChannelType.GuildCategory } } },
  });
  await assert.rejects(changedType.commit, (error) => error.code === "SETUP_DRAFT_RESOURCE_INVALID");
  assert.equal(changedType.writes.length, 0);

  const hidden = await commitFixture({
    feature: "callwait",
    patch: { callWaitEnabled: false },
    settings: { callWaitEnabled: true, callWaitPromptChannelId: "prompt", callWaitNoticeChannelId: "notice", callWaitRoleId: "role" },
    resources: {},
  });
  assert.equal((await hidden.commit).status, "completed");
  assert.deepEqual(hidden.fetches, []);

  const cleared = await commitFixture({
    feature: "status_board",
    patch: { statusBoardChannelId: null },
    settings: { statusBoardChannelId: "old-board" },
    resources: {},
  });
  assert.equal((await cleared.commit).status, "completed");
  assert.deepEqual(cleared.fetches, []);
});

test("concurrent confirmation permits only one writer call", async () => {
  let release;
  const entered = new Promise((resolve) => { release = resolve; });
  let resolveStarted;
  const started = new Promise((resolve) => { resolveStarted = resolve; });
  const fixture = createService({
    writer: async () => {
      resolveStarted();
      await entered;
      return { configRevision: 3, revision: 3 };
    },
  });
  const draft = (await fixture.service.startDraft({ guildId: "guild-1", actorUserId: "admin-1" })).draft;
  await fixture.service.selectFeature({ sessionId: draft.sessionId, guildId: draft.guildId, actorUserId: draft.actorUserId, feature: "profile", firstStep: "field:profileIntroductionChannelId" });
  const profilePatch = await fixture.service.mergePatch({ sessionId: draft.sessionId, guildId: draft.guildId, actorUserId: draft.actorUserId, patch: { profileIntroductionChannelId: "channel-1" } });
  await fixture.service.updateDraft({ ...profilePatch, step: "review" });
  const first = fixture.service.commitDraft({ sessionId: draft.sessionId, guildId: draft.guildId, actorUserId: draft.actorUserId });
  await Promise.race([
    started,
    new Promise((_resolve, reject) => setTimeout(() => reject(new Error("versioned writer did not start")), 1_000)),
  ]);
  const second = fixture.service.commitDraft({ sessionId: draft.sessionId, guildId: draft.guildId, actorUserId: draft.actorUserId });
  const secondResult = await Promise.allSettled([second]);
  assert.equal(secondResult[0].status, "rejected");
  assert.equal(secondResult[0].reason.code, "SETUP_DRAFT_CONFLICT");
  release();
  assert.equal((await first).status, "completed");
});

test("setup UI is ephemeral, mention-safe, revalidates channel type, and routes confirm", async () => {
  const fixture = createService();
  const guild = {
    id: "guild-1",
    channels: { cache: new Map(), fetch: async (id) => guild.channels.cache.get(id) },
    roles: { cache: new Map(), fetch: async (id) => guild.roles.cache.get(id) },
  };
  const text = { id: "text-1", guildId: guild.id, type: ChannelType.GuildText };
  guild.channels.cache.set(text.id, text);
  const setup = createSetupFeature({
    draftService: fixture.service,
    getGuildSettings: async () => clone(fixture.current),
    logger: { warn() {} },
  });
  const command = permissionInteraction({ overrides: { guild } });
  await setup.handleSetup(command);
  assert.equal(command.deferPayload.flags, 64);
  assert.deepEqual(command.lastReply.allowedMentions, { parse: [] });
  assert.ok(command.lastReply.content.length <= 1_900);
  const sessionId = fixture.model.rows[0].sessionId;

  const feature = permissionInteraction({ overrides: {
    guild,
    customId: buildSetupCustomId("feature", sessionId),
    values: ["profile"],
  } });
  await setup.handleInteraction(feature);
  assert.equal(feature.deferPayload, undefined);
  assert.equal(feature.deferred, true);
  assert.match(feature.lastReply.components[0].components[0].data.custom_id, /profileIntroductionChannelId$/);

  const chooseChannel = permissionInteraction({ overrides: {
    guild,
    customId: buildSetupCustomId("channel", sessionId, "profileIntroductionChannelId"),
    channels: new Map([[text.id, text]]),
    values: [text.id],
  } });
  await setup.handleInteraction(chooseChannel);
  assert.match(chooseChannel.lastReply.content, /checkbot feature:profile/);
  assert.equal(chooseChannel.lastReply.allowedMentions.parse.length, 0);
  const confirmId = chooseChannel.lastReply.components[0].components[0].data.custom_id;
  assert.equal(confirmId, buildSetupCustomId("confirm", sessionId));
  assert.ok(confirmId.length <= 100);

  const wrongType = { id: "category-1", guildId: guild.id, type: ChannelType.GuildCategory };
  const invalid = permissionInteraction({ overrides: {
    guild,
    customId: buildSetupCustomId("channel", sessionId, "profileIntroductionChannelId"),
    channels: new Map([[wrongType.id, wrongType]]),
    values: [wrongType.id],
  } });
  // The old interaction is still at review, so this is rejected rather than
  // accidentally accepting a stale selector from another step.
  await setup.handleInteraction(invalid);
  assert.match(invalid.lastReply.content, /現在の手順|種別/);

  const confirm = permissionInteraction({ overrides: {
    guild,
    customId: confirmId,
  } });
  await setup.handleInteraction(confirm);
  assert.match(confirm.lastReply.content, /確定しました/);
  assert.deepEqual(confirm.lastReply.allowedMentions, { parse: [] });
});

test("component access is rechecked and optional fields distinguish keep from clear", async () => {
  const fixture = createService({ settings: { statusBoardChannelId: "existing-board" } });
  const setup = createSetupFeature({
    draftService: fixture.service,
    getGuildSettings: async () => clone(fixture.current),
    logger: { warn() {} },
  });
  const guild = { id: "guild-1", channels: { cache: new Map(), fetch: async () => null }, roles: { cache: new Map(), fetch: async () => null } };
  const command = permissionInteraction({ overrides: { guild } });
  await setup.handleSetup(command);
  const sessionId = fixture.model.rows[0].sessionId;
  const feature = permissionInteraction({ overrides: { guild, customId: buildSetupCustomId("feature", sessionId), values: ["status_board"] } });
  await setup.handleInteraction(feature);
  const controls = feature.lastReply.components[1].components.map((component) => component.data.custom_id);
  assert.ok(controls.some((customId) => customId.startsWith(`setup:keep:${sessionId}:statusBoardChannelId`)));
  assert.ok(controls.some((customId) => customId.startsWith(`setup:clear:${sessionId}:statusBoardChannelId`)));

  const keep = permissionInteraction({ overrides: { guild, customId: buildSetupCustomId("keep", sessionId, "statusBoardChannelId") } });
  await setup.handleInteraction(keep);
  assert.deepEqual(fixture.model.rows[0].patch, {});
  assert.match(keep.lastReply.content, /現在値を維持|差分はありません/);
  const back = permissionInteraction({ overrides: { guild, customId: buildSetupCustomId("back", sessionId) } });
  await setup.handleInteraction(back);
  const clear = permissionInteraction({ overrides: { guild, customId: buildSetupCustomId("clear", sessionId, "statusBoardChannelId") } });
  await setup.handleInteraction(clear);
  assert.equal(fixture.model.rows[0].patch.statusBoardChannelId, null);

  const unauthorized = permissionInteraction({ userId: "admin-1", overrides: {
    guild,
    customId: buildSetupCustomId("cancel", sessionId),
    memberPermissions: { has: () => false },
  } });
  await setup.handleInteraction(unauthorized);
  assert.equal(unauthorized.deferred, false);
  assert.equal(unauthorized.lastReply.flags, 64);
  assert.equal(fixture.model.rows[0].status, "active");

  const wrongUser = permissionInteraction({ userId: "other-admin", overrides: { guild, customId: buildSetupCustomId("cancel", sessionId) } });
  await setup.handleInteraction(wrongUser);
  assert.equal(fixture.model.rows[0].status, "active");
  const wrongGuild = permissionInteraction({ guildId: "other-guild", overrides: { guild: { ...guild, id: "other-guild" }, customId: buildSetupCustomId("cancel", sessionId) } });
  await setup.handleInteraction(wrongGuild);
  assert.equal(fixture.model.rows[0].status, "active");
});

test("stale, expired, and overlong setup components are rejected without a write", async () => {
  assert.throws(() => buildSetupCustomId("confirm", "x".repeat(95)), /100-character/);
  const fixture = createService();
  const setup = createSetupFeature({ draftService: fixture.service, getGuildSettings: async () => clone(fixture.current), logger: { warn() {} } });
  const guild = { id: "guild-1", channels: { cache: new Map(), fetch: async () => null }, roles: { cache: new Map(), fetch: async () => null } };
  const draft = (await fixture.service.startDraft({ guildId: "guild-1", actorUserId: "admin-1" })).draft;
  const chooseProfile = permissionInteraction({ overrides: { guild, customId: buildSetupCustomId("feature", draft.sessionId), values: ["profile"] } });
  await setup.handleInteraction(chooseProfile);
  const staleFeature = permissionInteraction({ overrides: { guild, customId: buildSetupCustomId("feature", draft.sessionId), values: ["splitvc"] } });
  await setup.handleInteraction(staleFeature);
  assert.equal(fixture.model.rows[0].feature, "profile");
  const staleConfirm = permissionInteraction({ overrides: { guild, customId: buildSetupCustomId("confirm", draft.sessionId) } });
  await setup.handleInteraction(staleConfirm);
  assert.equal(fixture.writes.length, 0);
  assert.equal(fixture.model.rows[0].status, "active");

  fixture.model.rows[0].expiresAt = new Date("2020-01-01T00:00:00.000Z");
  const expired = permissionInteraction({ overrides: { guild, customId: buildSetupCustomId("cancel", draft.sessionId) } });
  await setup.handleInteraction(expired);
  assert.equal(fixture.model.rows[0].status, "expired");
});

test("setup interactions are wired through the shutdown-aware router", async () => {
  const calls = [];
  const handler = createInteractionHandler({
    isShuttingDown: () => false,
    messageFlags: { Ephemeral: 64 },
    services: {
      vcDm: { handleInteraction: async () => {} },
      operationalManagement: { handle: async () => {}, handleCommand: async () => {} },
      voiceChannelControl: { handle: async () => {} },
      fukyoTheme: { addTheme: async () => {}, showThemes: async () => {}, deleteTheme: async () => {}, sendTheme: async () => {} },
    },
    handlers: {
      handleSetup: async () => calls.push("command"),
      handleSetupInteraction: async () => calls.push("component"),
    },
    ids: {
      splitReviewOpen: "split_review_open", splitReviewSubmit: "split_review_submit", splitRandomTopic: "split_random_topic",
      callWaitJoin: "call_wait_join", callWaitInterest: "call_wait_interest", callWaitCancel: "call_wait_cancel",
      kokuchiReservationCancel: "kokuchi_reservation_cancel", oteboCreate: "otebo_create", oteboDraftNote: "otebo_draft_note",
      oteboDraftSubmit: "otebo_draft_submit", oteboDraftCancel: "otebo_draft_cancel", oteboJoin: "otebo_join",
      oteboMemberCancel: "otebo_member_cancel", oteboOwnerCancel: "otebo_owner_cancel", oteboOwnerCancelConfirm: "otebo_owner_cancel_confirm",
      splitReviewSelect: "split_review_select", oteboDraftSelect: "otebo_draft_select", callWaitInterestSelect: "call_wait_interest_threshold",
      splitReviewModal: "split_review_comment", oteboNoteModal: "otebo_note_modal",
    },
  });
  const base = {
    customId: "setup:feature:session", commandName: "setup", deferred: false, replied: false,
    isButton: () => false, isUserSelectMenu: () => false, isStringSelectMenu: () => false,
    isModalSubmit: () => false, isChatInputCommand: () => true,
  };
  await handler(base);
  await handler({ ...base, isChatInputCommand: () => false, isButton: () => true });
  assert.deepEqual(calls, ["command", "component"]);
});
