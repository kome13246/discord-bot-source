import assert from "node:assert/strict";
import test from "node:test";
import { ChannelType } from "discord.js";
import { commands } from "../src/commands.js";
import { createSengenService } from "../src/sengen-service.js";
import { createSengenStore } from "../src/sengen-store.js";
import { panelPayload } from "../src/sengen-service.js";
import {
  addJstDaysAt18,
  appendSengenDeclarationMarker,
  buildSengenDeclarationContent,
  formatJstDateTime,
  getJstDateKey,
  hasSengenDeclarationMarker,
  validateSengenInput,
} from "../src/sengen-utils.js";

const quietLogger = { error() {}, warn() {} };
const baseTime = new Date("2026-09-30T09:30:00.000Z");

function clone(row) {
  return row ? { ...row } : null;
}

function createMemoryStore({ draft = null, declarations = [], panel = null } = {}) {
  const rows = new Map(declarations.map((row) => [row._id, clone(row)]));
  let currentDraft = clone(draft);
  let currentPanel = clone(panel);
  let nextId = 1;
  const store = {
    rows,
    get draft() { return clone(currentDraft); },
    get panel() { return clone(currentPanel); },
    async createDraft(value) { currentDraft = clone(value); return clone(currentDraft); },
    async getDraft(draftId, userId, guildId) {
      if (!currentDraft || currentDraft.draftId !== draftId || currentDraft.userId !== userId
        || currentDraft.guildId !== guildId || currentDraft.consumedAt) return null;
      return clone(currentDraft);
    },
    async refreshDraftDate(draftId, userId, guildId, previewDateKey, updatedAt) {
      if (!currentDraft || currentDraft.draftId !== draftId || currentDraft.userId !== userId || currentDraft.guildId !== guildId) return null;
      currentDraft = { ...currentDraft, previewDateKey, updatedAt };
      return clone(currentDraft);
    },
    async refreshDraftConfiguration(draftId, userId, guildId, values, updatedAt) {
      if (!currentDraft || currentDraft.draftId !== draftId || currentDraft.userId !== userId || currentDraft.guildId !== guildId) return null;
      currentDraft = { ...currentDraft, ...values, updatedAt };
      return clone(currentDraft);
    },
    async claimDraft(draftId, userId, guildId, consumedAt) {
      if (!currentDraft || currentDraft.draftId !== draftId || currentDraft.userId !== userId
        || currentDraft.guildId !== guildId || currentDraft.consumedAt) return null;
      currentDraft = { ...currentDraft, consumedAt };
      return clone(currentDraft);
    },
    async countActive(guildId, userId, at) {
      return [...rows.values()].filter((row) => row.guildId === guildId && row.userId === userId
        && !row.result && new Date(row.deadlineAt).getTime() > new Date(at).getTime()).length;
    },
    async createDeclaration(value) {
      const row = { ...value, _id: `decl-${nextId++}`, publicationStatus: "posting" };
      rows.set(row._id, row);
      return clone(row);
    },
    async setPostMessage(id, messageId) {
      const row = rows.get(id);
      if (!row || row.postMessageId || !["posting", "orphaned"].includes(row.publicationStatus)) return null;
      Object.assign(row, { postMessageId: messageId, publicationStatus: "published", lastError: null });
      return clone(row);
    },
    async markPublicationOrphaned(id, error, updatedAt) {
      const row = rows.get(id);
      if (!row) return null;
      Object.assign(row, { publicationStatus: "orphaned", lastError: String(error?.message ?? error), updatedAt });
      return { matchedCount: 1 };
    },
    async getDeclaration(id, guildId = undefined) {
      const row = rows.get(id);
      return row && (!guildId || row.guildId === guildId) ? clone(row) : null;
    },
    async submitResult({ declarationId, guildId, userId, result, now }) {
      const row = rows.get(declarationId);
      if (!row || row.guildId !== guildId || row.userId !== userId || row.result || new Date(row.deadlineAt) > now) return null;
      Object.assign(row, { result, resultSubmittedAt: now, failureReason: null, publicSyncPending: true });
      row.publicRevision = (row.publicRevision ?? 0) + 1;
      return clone(row);
    },
    async updateFailureReason({ declarationId, guildId, userId, reason, now }) {
      const row = rows.get(declarationId);
      if (!row || row.guildId !== guildId || row.userId !== userId || row.result !== "failed") return null;
      Object.assign(row, { failureReason: reason || null, publicSyncPending: true, updatedAt: now });
      row.publicRevision = (row.publicRevision ?? 0) + 1;
      return clone(row);
    },
    async correctResult({ declarationId, guildId, result, now }) {
      const row = rows.get(declarationId);
      if (!row || row.guildId !== guildId || !row.result) return null;
      Object.assign(row, { result, resultSubmittedAt: now, failureReason: null, publicSyncPending: true, updatedAt: now });
      row.publicRevision = (row.publicRevision ?? 0) + 1;
      return clone(row);
    },
    async claimResultPrompt(id, now) {
      const row = rows.get(id);
      if (!row || row.result || row.resultPromptSentAt || row.publicationStatus !== "published"
        || !row.postMessageId || new Date(row.deadlineAt) > now) return null;
      Object.assign(row, { resultPromptSentAt: now, nextProgressAt: null, updatedAt: now });
      return clone(row);
    },
    async claimProgress(id, expected, nextAt, now) {
      const row = rows.get(id);
      if (!row || row.result || row.publicationStatus !== "published" || !row.postMessageId
        || new Date(row.deadlineAt) <= now || new Date(row.nextProgressAt).getTime() !== new Date(expected).getTime()) return null;
      Object.assign(row, { nextProgressAt: nextAt, lastProgressNoticeAt: now });
      return clone(row);
    },
    async markPublicSynced(id, revision, now) {
      const row = rows.get(id);
      if (!row || !row.publicSyncPending || row.publicRevision !== revision) return { matchedCount: 0 };
      Object.assign(row, { publicSyncPending: false, publicSyncedRevision: revision, lastError: null, updatedAt: now });
      return { matchedCount: 1 };
    },
    async setPublicSyncError(id, error, now) {
      const row = rows.get(id);
      if (!row || !row.publicSyncPending) return { matchedCount: 0 };
      Object.assign(row, { lastError: String(error?.message ?? error), updatedAt: now });
      return { matchedCount: 1 };
    },
    async listUnpublished() { return [...rows.values()].filter((row) => !row.postMessageId && ["posting", "orphaned"].includes(row.publicationStatus)).map(clone); },
    async listDueResultPrompts(now) { return [...rows.values()].filter((row) => !row.result && !row.resultPromptSentAt && row.publicationStatus === "published" && row.postMessageId && new Date(row.deadlineAt) <= now).map(clone); },
    async listDueProgress(now) { return [...rows.values()].filter((row) => !row.result && row.publicationStatus === "published" && row.postMessageId && row.nextProgressAt && new Date(row.nextProgressAt) <= now && new Date(row.deadlineAt) > now).map(clone); },
    async listPublicSyncPending() { return [...rows.values()].filter((row) => row.publicSyncPending && row.postMessageId).map(clone); },
    async getPanel() { return clone(currentPanel); },
    async savePanel({ guildId, channelId, messageId, expectedCurrent = null, stalePanel = null }) {
      if (expectedCurrent
        ? currentPanel?.channelId !== expectedCurrent.channelId || currentPanel?.messageId !== expectedCurrent.messageId
        : currentPanel?.messageId) return null;
      const stalePanels = [...(currentPanel?.stalePanels ?? [])];
      if (stalePanel && !stalePanels.some((row) => row.channelId === stalePanel.channelId && row.messageId === stalePanel.messageId)) stalePanels.push(stalePanel);
      currentPanel = { guildId, channelId, messageId, stalePanels };
      return clone(currentPanel);
    },
    async removeStalePanel(guildId, stale) {
      if (currentPanel?.guildId === guildId) currentPanel.stalePanels = currentPanel.stalePanels.filter((row) => row.channelId !== stale.channelId || row.messageId !== stale.messageId);
    },
    async deletePanel(guildId, expectedCurrent = null) {
      if (currentPanel?.guildId !== guildId || (expectedCurrent && (currentPanel.channelId !== expectedCurrent.channelId || currentPanel.messageId !== expectedCurrent.messageId))) return { deletedCount: 0 };
      currentPanel = null;
      return { deletedCount: 1 };
    },
  };
  return store;
}

function messageComponents(rows = []) {
  return rows.map((row) => {
    const serialized = typeof row.toJSON === "function" ? row.toJSON() : row;
    return {
      components: (serialized.components ?? []).map((item) => ({
        customId: item.custom_id ?? item.customId,
        custom_id: item.custom_id ?? item.customId,
        data: item,
      })),
    };
  });
}

function recordMarkerIds(message) {
  return (message?.components ?? []).flatMap((row) => row.components.map((item) => item.customId ?? item.custom_id))
    .filter((customId) => customId?.startsWith("sengen:record:"));
}

function visibleDeclarationContent(message, declarationId) {
  const marker = appendSengenDeclarationMarker("", declarationId);
  return message.content.endsWith(marker) ? message.content.slice(0, -marker.length) : message.content;
}

function discordSnowflake(timestamp, sequence = 0) {
  return (((BigInt(timestamp) - 1_420_070_400_000n) << 22n) + BigInt(sequence)).toString();
}

function makeChannel(id, messages = new Map()) {
  return {
    id,
    type: ChannelType.GuildText,
    permissionsFor: () => ({ has: () => true }),
    messages: {
      fetch: async (value) => {
        if (typeof value === "string") return messages.get(value) ?? null;
        const options = value ?? {};
        let fetched = [...messages.values()];
        if (fetched.every((message) => /^\d+$/.test(String(message.id)))) {
          fetched.sort((left, right) => Number(BigInt(right.id) - BigInt(left.id)));
          if (options.before) fetched = fetched.filter((message) => BigInt(message.id) < BigInt(options.before));
        }
        fetched = fetched.slice(0, options.limit ?? 100);
        const page = new Map(fetched.map((message) => [message.id, message]));
        return { values: () => page.values(), first: () => page.values().next().value };
      },
    },
    send: async (payload) => {
      const message = makeMessage(`sent-${messages.size + 1}`, payload);
      messages.set(message.id, message);
      return message;
    },
    _messages: messages,
  };
}

function makeMessage(id, initial = {}) {
  return {
    id,
    author: initial.author ?? { id: "bot" },
    nonce: initial.nonce,
    createdTimestamp: initial.createdTimestamp,
    content: initial.content ?? "",
    components: messageComponents(initial.components ?? []),
    lastEdit: null,
    failNextEdit: false,
    async edit(payload) {
      if (this.failNextEdit) { this.failNextEdit = false; throw new Error("temporary message edit failure"); }
      this.lastEdit = payload;
      this.content = payload.content;
      this.components = messageComponents(payload.components);
      return this;
    },
    async delete() { this.deleted = true; },
  };
}

function createFixture({ now = () => baseTime, store = createMemoryStore(), settings = null, acquireLease = async () => ({ lockKey: "test" }), dmFails = false } = {}) {
  const postChannel = makeChannel("post");
  const panelChannel = makeChannel("panel");
  const guildChannels = new Map([[postChannel.id, postChannel], [panelChannel.id, panelChannel]]);
  const guild = {
    id: "g1",
    members: { me: {} },
    channels: { cache: guildChannels, fetch: async (id) => guildChannels.get(id) ?? null },
  };
  let dmAttempts = 0;
  const dmPayloads = [];
  const client = {
    user: { id: "bot" },
    guilds: { cache: new Map([[guild.id, guild]]), fetch: async () => guild },
    users: { fetch: async () => ({ send: async (payload) => { dmAttempts += 1; dmPayloads.push(payload); if (dmFails) throw new Error("DMs closed"); } }) },
  };
  const guildSettings = settings ?? { sengenPanelChannelId: "panel", sengenPostChannelId: "post", sengenOverviewChannelId: "overview" };
  const service = createSengenService({
    client,
    getGuildSettings: async () => guildSettings,
    store,
    now,
    acquireLease,
    renewLease: async () => true,
    releaseLease: async () => true,
    logger: quietLogger,
  });
  return { client, guild, postChannel, panelChannel, guildSettings, store, service, dmPayloads, get dmAttempts() { return dmAttempts; } };
}

function interaction(fixture, customId, { userId = "u1", guildId = null, admin = false, fields = null } = {}) {
  const value = {
    customId,
    user: { id: userId, bot: false },
    guildId,
    guild: guildId ? fixture.guild : null,
    channelId: "panel",
    fields,
    deferred: false,
    replied: false,
    replies: [],
    updates: [],
    modals: [],
    inGuild: () => Boolean(guildId),
    isFromMessage: () => true,
    memberPermissions: { has: () => admin },
    async deferUpdate() { this.deferred = true; },
    async deferReply() { this.deferred = true; },
    async editReply(payload) { this.updates.push(payload); return payload; },
    async update(payload) { this.updates.push(payload); this.replied = true; return payload; },
    async reply(payload) { this.replies.push(payload); this.replied = true; return payload; },
    async followUp(payload) { this.replies.push(payload); return payload; },
    async showModal(modal) { this.modals.push(modal); return modal; },
  };
  return value;
}

test("JST deadlines follow calendar days, including midnight, year, and leap-day boundaries", () => {
  const beforeTokyoMidnight = new Date("2026-09-30T14:59:00.000Z");
  assert.equal(getJstDateKey(beforeTokyoMidnight), "2026-09-30");
  assert.equal(addJstDaysAt18(beforeTokyoMidnight, 1).toISOString(), "2026-10-01T09:00:00.000Z");
  assert.equal(formatJstDateTime(addJstDaysAt18(beforeTokyoMidnight, 1)), "2026/10/01 18:00");
  assert.equal(getJstDateKey(new Date("2026-09-30T15:00:00.000Z")), "2026-10-01");
  assert.equal(addJstDaysAt18(new Date("2025-12-31T15:30:00.000Z"), 1).toISOString(), "2026-01-02T09:00:00.000Z");
  assert.equal(addJstDaysAt18(new Date("2024-02-28T10:00:00.000Z"), 1).toISOString(), "2024-02-29T09:00:00.000Z");
  assert.equal(addJstDaysAt18(new Date("2024-02-28T10:00:00.000Z"), 2).toISOString(), "2024-03-01T09:00:00.000Z");
});

test("content and interval validation enforce limits and neutralize user mention syntax", () => {
  assert.equal(validateSengenInput({ content: "  3回以上VCで話す  ", termDays: "90", intervalDays: "89" }).ok, true);
  assert.equal(validateSengenInput({ content: "目標", termDays: "1", intervalDays: "1" }).reason, "invalid-interval");
  assert.equal(validateSengenInput({ content: "目標", termDays: "91" }).reason, "invalid-term");
  assert.equal(validateSengenInput({ content: "   ", termDays: "5" }).reason, "empty-content");
  const declaration = buildSengenDeclarationContent({ userId: "123", content: "@everyone <@456>", termDays: 2, deadlineAt: addJstDaysAt18(baseTime, 2) });
  assert.match(declaration, /^<@123>の宣言/);
  assert.doesNotMatch(declaration, /@everyone|<@456>/);
});

test("unanswered declarations keep the same public display before and after deadline; a reported result replaces the term", () => {
  const declaration = {
    userId: "123", content: "目標", termDays: 2,
    deadlineAt: addJstDaysAt18(baseTime, 2), result: null,
  };
  const deadlineAt = new Date(declaration.deadlineAt).getTime();
  const beforeDeadline = buildSengenDeclarationContent(declaration, { now: new Date(deadlineAt - 1) });
  const afterDeadline = buildSengenDeclarationContent(declaration, { now: new Date(deadlineAt + 1) });
  assert.equal(afterDeadline, beforeDeadline);
  assert.match(beforeDeadline, /期間：2日間/);
  assert.match(beforeDeadline, /期限：2026\/10\/02 18:00（日本時間）/);
  assert.doesNotMatch(beforeDeadline, /結果確認待ち|結果：/);

  const achieved = buildSengenDeclarationContent({ ...declaration, result: "achieved" });
  assert.match(achieved, /結果：達成/);
  assert.doesNotMatch(achieved, /期間：/);
  assert.match(achieved, /期限：2026\/10\/02 18:00（日本時間）/);

  const failed = buildSengenDeclarationContent({ ...declaration, result: "failed", failureReason: "都合がつかなかった" });
  const failedLines = failed.split("\n");
  assert.match(failedLines[2], /^結果：失敗$/);
  assert.match(failedLines[3], /^期限：/);
  assert.equal(failedLines.at(-1), "失敗理由：都合がつかなかった");
  assert.doesNotMatch(failed, /期間：/);
});

test("declaration recovery marker is invisible, unique, appended at the end, and stays within Discord's content limit", () => {
  const declarationId = "0123456789abcdef01234567";
  const visibleContent = buildSengenDeclarationContent({
    userId: "123", content: "目標".repeat(150), termDays: 90,
    deadlineAt: addJstDaysAt18(baseTime, 90), result: "failed", failureReason: "理由".repeat(250),
  });
  const markedContent = appendSengenDeclarationMarker(visibleContent, declarationId);
  assert.ok(markedContent.length <= 2_000);
  assert.ok(markedContent.endsWith(appendSengenDeclarationMarker("", declarationId)));
  assert.equal(visibleDeclarationContent({ content: markedContent }, declarationId), visibleContent);
  assert.equal(hasSengenDeclarationMarker(markedContent, declarationId), true);
  assert.equal(hasSengenDeclarationMarker(markedContent, "fedcba9876543210fedcba98"), false);
  assert.equal(appendSengenDeclarationMarker("visible", null), "visible");
  assert.equal(hasSengenDeclarationMarker(markedContent, null), false);
});

test("the installation panel and registered setting/checkbot options expose Sengen", () => {
  const panel = panelPayload("overview");
  assert.equal(panel.content, "📣 宣言ボタン\nこの機能の概要は <#overview> からご確認ください！\n\n宣言はチャンネルに公開され、自分では変更・削除できません。\n期限にはDMで結果を確認します。途中確認のDMも設定できます。\nDMを受け取らない設定の場合、途中確認・結果確認の通知が届かないことがあります。");
  assert.equal(panel.components[0].components[0].data.custom_id, "sengen:open");
  assert.equal(panel.components[0].components[0].data.label, "宣言");
  const setting = commands.find((command) => command.name === "setting");
  const sengenSetting = setting.options.find((option) => option.type === 1 && option.name === "sengen");
  assert.deepEqual(sengenSetting.options.map((option) => option.name), ["panel_channel", "post_channel", "overview_channel"]);
  assert.ok(sengenSetting.options.every((option) => option.required));
  const checkbot = commands.find((command) => command.name === "checkbot");
  assert.ok(checkbot.options.find((option) => option.name === "feature").choices.some((choice) => choice.value === "sengen"));
});

test("deferred ephemeral validation edits omit reply-only flags", async () => {
  const fixture = createFixture({ settings: { sengenPanelChannelId: "panel", sengenPostChannelId: null, sengenOverviewChannelId: null } });
  const modal = interaction(fixture, "sengen:declaration_modal:panel", { guildId: "g1" });
  await fixture.service.handleInteraction(modal);
  assert.equal(modal.deferred, true);
  assert.match(modal.updates.at(-1).content, /宣言先が設定されていません/);
  assert.equal(Object.hasOwn(modal.updates.at(-1), "flags"), false);
  await fixture.service.shutdown();
});

test("due notification queries and atomic claims exclude unpublished declarations", async () => {
  const filters = [];
  const updates = [];
  const model = {
    find(filter) { filters.push(filter); return []; },
    findOneAndUpdate(filter, update) { filters.push(filter); updates.push(update); return null; },
  };
  const store = createSengenStore({ declarationModel: model, draftModel: {}, panelModel: {} });
  await store.listDueResultPrompts(baseTime);
  await store.listDueProgress(baseTime);
  await store.claimResultPrompt("d1", baseTime);
  await store.claimProgress("d1", baseTime, null, baseTime);
  for (const filter of filters) {
    assert.equal(filter.publicationStatus, "published");
    assert.deepEqual(filter.postMessageId, { $ne: null });
  }
  assert.deepEqual(updates[0].$set, { resultPromptSentAt: baseTime, nextProgressAt: null, updatedAt: baseTime });
  assert.equal(updates[0].$inc, undefined);
});

test("draft confirmation is one-time, publishes without requiring a DM, and limits active declarations to three", async () => {
  const activeRows = [1, 2, 3].map((n) => ({ _id: `old-${n}`, guildId: "g1", userId: "u1", result: null, deadlineAt: new Date("2026-10-05T09:00:00Z") }));
  const draft = {
    draftId: "draft-1", guildId: "g1", userId: "u1", content: "3回以上VCで話す", termDays: 3, intervalDays: 1,
    postChannelId: "post", overviewChannelId: "overview", previewDateKey: "2026-09-30",
    expiresAt: new Date("2026-09-30T10:00:00Z"), consumedAt: null,
  };
  const store = createMemoryStore({ draft, declarations: activeRows });
  const fixture = createFixture({ store });
  const full = interaction(fixture, "sengen:confirm:draft-1", { userId: "u1", guildId: "g1" });
  await fixture.service.handleInteraction(full);
  assert.match(full.updates.at(-1).content, /同時に進行できる宣言は3件まで/);
  assert.equal(fixture.postChannel._messages.size, 0);
  assert.equal(store.draft.consumedAt, null);

  for (const row of store.rows.values()) row.deadlineAt = new Date("2026-09-30T08:00:00Z");
  const confirms = [1, 2].map(() => interaction(fixture, "sengen:confirm:draft-1", { userId: "u1", guildId: "g1" }));
  await Promise.all(confirms.map((item) => fixture.service.handleInteraction(item)));
  assert.equal(fixture.postChannel._messages.size, 1);
  assert.equal(store.rows.size, 4);
  assert.equal(fixture.dmAttempts, 0);
  const published = [...store.rows.values()].find((row) => row.postMessageId);
  assert.equal(published.publicationStatus, "published");
  assert.equal(published.deadlineAt.toISOString(), "2026-10-03T09:00:00.000Z");
  const publicMessage = fixture.postChannel._messages.get(published.postMessageId);
  assert.match(publicMessage.content, /期限：2026\/10\/03 18:00/);
  assert.deepEqual(publicMessage.components, []);
  assert.equal(hasSengenDeclarationMarker(publicMessage.content, published._id), true);
  assert.equal(visibleDeclarationContent(publicMessage, published._id), buildSengenDeclarationContent(published));
  await fixture.service.shutdown();
});

test("confirmation crossing JST midnight refreshes the preview and uses the rechecked deadline", async () => {
  let currentTime = new Date("2026-09-30T14:59:00.000Z");
  const store = createMemoryStore();
  const fixture = createFixture({ store, now: () => currentTime });
  const submit = interaction(fixture, "sengen:declaration_modal:panel", {
    guildId: "g1",
    fields: { getTextInputValue: (id) => ({ sengen_content: "話す", sengen_term: "2", sengen_interval: "" })[id] },
  });
  await fixture.service.handleInteraction(submit);
  assert.match(submit.updates.at(-1).content, /期限：2026\/10\/02 18:00/);

  currentTime = new Date("2026-09-30T15:01:00.000Z");
  const refreshed = interaction(fixture, `sengen:confirm:${store.draft.draftId}`, { guildId: "g1" });
  await fixture.service.handleInteraction(refreshed);
  assert.equal(fixture.postChannel._messages.size, 0);
  assert.match(refreshed.updates.at(-1).content, /期限：2026\/10\/03 18:00/);
  assert.equal(store.draft.previewDateKey, "2026-10-01");

  const confirmed = interaction(fixture, `sengen:confirm:${store.draft.draftId}`, { guildId: "g1" });
  await fixture.service.handleInteraction(confirmed);
  assert.equal(fixture.postChannel._messages.size, 1);
  assert.equal([...store.rows.values()][0].deadlineAt.toISOString(), "2026-10-03T09:00:00.000Z");
  await fixture.service.shutdown();
});

test("a settings change refreshes the preview before publishing to the new channel", async () => {
  const store = createMemoryStore();
  const fixture = createFixture({ store });
  const submit = interaction(fixture, "sengen:declaration_modal:panel", {
    guildId: "g1",
    fields: { getTextInputValue: (id) => ({ sengen_content: "週2回走る", sengen_term: "5", sengen_interval: "2" })[id] },
  });
  await fixture.service.handleInteraction(submit);
  const draftId = store.draft.draftId;
  const newChannel = makeChannel("post-new");
  fixture.guild.channels.cache.set(newChannel.id, newChannel);
  fixture.guildSettings.sengenPostChannelId = newChannel.id;
  fixture.guildSettings.sengenOverviewChannelId = "overview-new";

  const refreshed = interaction(fixture, `sengen:confirm:${draftId}`, { guildId: "g1" });
  await fixture.service.handleInteraction(refreshed);
  assert.equal(fixture.postChannel._messages.size, 0);
  assert.equal(newChannel._messages.size, 0);
  assert.match(refreshed.updates.at(-1).content, /公開先：<#post-new>/);
  assert.equal(store.draft.postChannelId, "post-new");
  assert.equal(store.draft.overviewChannelId, "overview-new");

  const confirmed = interaction(fixture, `sengen:confirm:${draftId}`, { guildId: "g1" });
  await fixture.service.handleInteraction(confirmed);
  assert.equal(fixture.postChannel._messages.size, 0);
  assert.equal(newChannel._messages.size, 1);
  assert.equal([...store.rows.values()][0].postChannelId, "post-new");
  await fixture.service.shutdown();
});

test("unpublished recovery pages by registration time and matches only the bot's exact persistent record marker", async () => {
  const draft = {
    draftId: "recover-draft", guildId: "g1", userId: "u1", content: "毎日歩く", termDays: 7, intervalDays: null,
    postChannelId: "post", overviewChannelId: "overview", previewDateKey: "2026-09-30",
    expiresAt: new Date("2026-09-30T10:00:00Z"), consumedAt: null,
  };
  const store = createMemoryStore({ draft });
  const fixture = createFixture({ store });
  const registrationAt = baseTime.getTime();
  const targetId = discordSnowflake(registrationAt + 1_000);
  let targetMessage;
  fixture.postChannel.send = async (payload) => {
    targetMessage = makeMessage(targetId, { ...payload, createdTimestamp: registrationAt + 1_000, nonce: null });
    targetMessage.nonce = null;
    fixture.postChannel._messages.set(targetMessage.id, targetMessage);
    return targetMessage;
  };
  let setMessageCalls = 0;
  const setPostMessage = store.setPostMessage.bind(store);
  store.setPostMessage = async (...args) => {
    setMessageCalls += 1;
    if (setMessageCalls <= 2) return null;
    return setPostMessage(...args);
  };
  const submitted = interaction(fixture, "sengen:confirm:recover-draft", { guildId: "g1" });
  await fixture.service.handleInteraction(submitted);
  const declaration = [...store.rows.values()][0];
  assert.equal(declaration.publicationStatus, "orphaned");
  assert.equal(declaration.postMessageId, null);
  assert.equal(hasSengenDeclarationMarker(targetMessage.content, declaration._id), true);
  assert.equal(visibleDeclarationContent(targetMessage, declaration._id), buildSengenDeclarationContent(declaration));
  assert.deepEqual(targetMessage.components, []);

  const similarVisibleContent = visibleDeclarationContent(targetMessage, declaration._id);
  const markerRows = (id) => [{ components: [{ custom_id: `sengen:record:${id}`, label: "宣言", style: 2, type: 2, disabled: true }] }];
  const otherBotSameRecord = makeMessage(discordSnowflake(registrationAt + 2_000), {
    author: { id: "another-bot" }, content: appendSengenDeclarationMarker(similarVisibleContent, declaration._id), components: markerRows(declaration._id), createdTimestamp: registrationAt + 2_000,
  });
  const sameContentDifferentRecord = makeMessage(discordSnowflake(registrationAt + 3_000), {
    content: appendSengenDeclarationMarker(similarVisibleContent, "different-declaration"), components: markerRows("different-declaration"), createdTimestamp: registrationAt + 3_000,
  });
  fixture.postChannel._messages.set(otherBotSameRecord.id, otherBotSameRecord);
  fixture.postChannel._messages.set(sameContentDifferentRecord.id, sameContentDifferentRecord);
  for (let index = 0; index < 205; index += 1) {
    const timestamp = registrationAt + 10_000 + index * 1_000;
    const filler = makeMessage(discordSnowflake(timestamp), {
      content: appendSengenDeclarationMarker(similarVisibleContent, "another-record"),
      components: markerRows("another-record"),
      createdTimestamp: timestamp,
      nonce: null,
    });
    filler.nonce = null;
    fixture.postChannel._messages.set(filler.id, filler);
  }

  const pageRequests = [];
  const fetchMessages = fixture.postChannel.messages.fetch;
  fixture.postChannel.messages.fetch = async (options) => {
    if (options && typeof options === "object") pageRequests.push(options);
    return fetchMessages(options);
  };
  await fixture.service.processScheduledWork();
  assert.ok(pageRequests.length >= 3);
  assert.ok(pageRequests.some((request) => request.before));
  assert.equal(targetMessage.nonce, null);
  assert.equal(store.rows.get(declaration._id).postMessageId, targetId);
  assert.equal(store.rows.get(declaration._id).publicationStatus, "published");

  const legacyDeclaration = {
    ...declaration, _id: "legacy-declaration", userId: "u2", postMessageId: null, publicationStatus: "orphaned",
  };
  store.rows.set(legacyDeclaration._id, legacyDeclaration);
  const legacyMessage = makeMessage(discordSnowflake(registrationAt + 4_000), {
    content: similarVisibleContent,
    components: markerRows(legacyDeclaration._id),
    createdTimestamp: registrationAt + 4_000,
    nonce: null,
  });
  fixture.postChannel._messages.set(legacyMessage.id, legacyMessage);
  await fixture.service.processScheduledWork();
  assert.equal(store.rows.get(legacyDeclaration._id).postMessageId, legacyMessage.id);
  await fixture.service.shutdown();
});

test("failure result and reason stay owner-only, sync publicly with the recovery marker, remain editable, and stale buttons are rejected", async () => {
  const record = {
    _id: "d1", guildId: "g1", userId: "u1", content: "毎日歩く", termDays: 2,
    registeredAt: new Date("2026-09-28T09:00:00Z"), deadlineAt: new Date("2026-09-30T09:00:00Z"),
    postChannelId: "post", postMessageId: "public-d1", publicationStatus: "published",
    result: null, resultPromptSentAt: baseTime, resultSubmittedAt: null, failureReason: null,
    publicSyncPending: false, publicRevision: 0, publicSyncedRevision: 0,
  };
  const store = createMemoryStore({ declarations: [record] });
  const fixture = createFixture({ store, now: () => new Date("2026-09-30T10:00:00Z") });
  const publicMessage = makeMessage("public-d1");
  fixture.postChannel._messages.set(publicMessage.id, publicMessage);

  const wrongOwner = interaction(fixture, "sengen:result-confirm:d1:failed", { userId: "u2" });
  await fixture.service.handleInteraction(wrongOwner);
  assert.equal(store.rows.get("d1").result, null);

  const chooseFailed = interaction(fixture, "sengen:result-confirm:d1:failed");
  await fixture.service.handleInteraction(chooseFailed);
  assert.equal(store.rows.get("d1").result, "failed");
  assert.match(publicMessage.lastEdit.content, /結果：失敗/);
  assert.equal(hasSengenDeclarationMarker(publicMessage.lastEdit.content, "d1"), true);
  assert.equal(visibleDeclarationContent({ content: publicMessage.lastEdit.content }, "d1"), buildSengenDeclarationContent(store.rows.get("d1")));
  assert.deepEqual(recordMarkerIds(publicMessage), []);
  assert.deepEqual(publicMessage.lastEdit.components.flatMap((row) => row.components.map((item) => item.data.custom_id)), [
    "sengen:correct:d1:achieved", "sengen:correct:d1:failed",
  ]);
  assert.match(chooseFailed.updates.at(-1).content, /失敗した理由を書き残せます/);

  publicMessage.failNextEdit = true;
  const reasonSubmit = interaction(fixture, "sengen:reason-modal:d1", {
    fields: { getTextInputValue: () => "家族の都合" },
  });
  await fixture.service.handleInteraction(reasonSubmit);
  assert.equal(store.rows.get("d1").failureReason, "家族の都合");
  const failedSyncReply = reasonSubmit.updates.at(-1);
  assert.match(failedSyncReply.content, /Botが再試行/);
  assert.equal(failedSyncReply.components[0].components[0].data.custom_id, "sengen:reason:d1");

  const retry = interaction(fixture, "sengen:retry:d1");
  await fixture.service.handleInteraction(retry);
  assert.match(publicMessage.lastEdit.content, /失敗理由：家族の都合/);
  assert.equal(hasSengenDeclarationMarker(publicMessage.lastEdit.content, "d1"), true);
  const visibleFailedContent = visibleDeclarationContent({ content: publicMessage.lastEdit.content }, "d1");
  assert.equal(visibleFailedContent, buildSengenDeclarationContent(store.rows.get("d1")));
  assert.equal(visibleFailedContent.split("\n").at(-1), "失敗理由：家族の都合");
  assert.equal(retry.updates.at(-1).components[0].components[0].data.label, "失敗理由を編集");

  const reopen = interaction(fixture, "sengen:reason:d1");
  await fixture.service.handleInteraction(reopen);
  assert.equal(reopen.modals[0].components[0].components[0].data.value, "家族の都合");
  const nonOwner = interaction(fixture, "sengen:reason:d1", { userId: "u2" });
  await fixture.service.handleInteraction(nonOwner);
  assert.equal(nonOwner.modals.length, 0);
  assert.match(nonOwner.replies[0].content, /理由を編集できません/);

  const nonAdminCorrection = interaction(fixture, "sengen:correct:d1:achieved", { guildId: "g1" });
  await fixture.service.handleInteraction(nonAdminCorrection);
  assert.equal(store.rows.get("d1").result, "failed");

  const adminSelect = interaction(fixture, "sengen:correct:d1:achieved", { guildId: "g1", userId: "mod", admin: true });
  await fixture.service.handleInteraction(adminSelect);
  const adminConfirmId = adminSelect.updates.at(-1).components[0].components[0].data.custom_id;
  publicMessage.failNextEdit = true;
  const adminCorrection = interaction(fixture, adminConfirmId, { guildId: "g1", userId: "mod", admin: true });
  await fixture.service.handleInteraction(adminCorrection);
  assert.equal(store.rows.get("d1").result, "achieved");
  assert.equal(store.rows.get("d1").failureReason, null);
  assert.match(adminCorrection.updates.at(-1).components[0].components[0].data.custom_id, /^sengen:retry:/);

  for (const retryActor of [
    interaction(fixture, "sengen:retry:d1", { guildId: "g2", userId: "mod", admin: true }),
    interaction(fixture, "sengen:retry:d1", { guildId: "g1", userId: "regular", admin: false }),
    interaction(fixture, "sengen:retry:d1", { userId: "mod", admin: true }),
  ]) {
    await fixture.service.handleInteraction(retryActor);
    assert.match(retryActor.updates.at(-1).content, /再試行する権限がありません/);
  }
  const adminRetry = interaction(fixture, "sengen:retry:d1", { guildId: "g1", userId: "mod", admin: true });
  await fixture.service.handleInteraction(adminRetry);
  assert.match(publicMessage.lastEdit.content, /結果：達成/);
  assert.doesNotMatch(publicMessage.lastEdit.content, /失敗理由：/);
  assert.equal(hasSengenDeclarationMarker(publicMessage.lastEdit.content, "d1"), true);
  assert.equal(visibleDeclarationContent({ content: publicMessage.lastEdit.content }, "d1"), buildSengenDeclarationContent(store.rows.get("d1")));
  assert.deepEqual(recordMarkerIds(publicMessage), []);
  assert.equal(adminRetry.updates.at(-1).components.some((row) => row.components.some((item) => item.data.custom_id === "sengen:reason:d1")), false);
  const staleReason = interaction(fixture, "sengen:reason:d1");
  await fixture.service.handleInteraction(staleReason);
  assert.equal(staleReason.modals.length, 0);
  await fixture.service.shutdown();
});

test("a missed startup lease keeps progress catch-up in skip mode and failed result DMs are attempted once", async () => {
  const ended = {
    _id: "ended", guildId: "g1", userId: "u1", content: "期限済み", termDays: 1, intervalDays: 1,
    registeredAt: new Date("2026-09-29T09:00:00Z"), deadlineAt: new Date("2026-09-30T09:00:00Z"),
    postChannelId: "post", postMessageId: "public-ended", publicationStatus: "published",
    result: null, resultPromptSentAt: null, nextProgressAt: new Date("2026-09-30T09:00:00Z"),
    failureReason: null, publicSyncPending: false, publicRevision: 0,
  };
  const active = {
    _id: "active", guildId: "g1", userId: "u2", content: "進行中", termDays: 7, intervalDays: 1,
    registeredAt: new Date("2026-09-28T09:00:00Z"), deadlineAt: new Date("2026-10-05T09:00:00Z"),
    postChannelId: "post", postMessageId: "public-active", publicationStatus: "published",
    result: null, resultPromptSentAt: null, nextProgressAt: new Date("2026-09-29T09:00:00Z"),
    failureReason: null, publicSyncPending: false, publicRevision: 0,
  };
  const store = createMemoryStore({ declarations: [ended, active] });
  let leaseCalls = 0;
  const fixture = createFixture({
    store,
    now: () => new Date("2026-09-30T10:00:00Z"),
    acquireLease: async () => { leaseCalls += 1; return leaseCalls === 1 ? null : { lockKey: "test" }; },
    dmFails: true,
  });
  const endedMessage = makeMessage("public-ended", {
    content: appendSengenDeclarationMarker(buildSengenDeclarationContent(ended), ended._id),
  });
  fixture.postChannel._messages.set("public-ended", endedMessage);
  fixture.postChannel._messages.set("public-active", makeMessage("public-active"));

  assert.equal((await fixture.service.processScheduledWork({ startup: true })).status, "lease-unavailable");
  await fixture.service.processScheduledWork();
  assert.equal(fixture.dmAttempts, 1);
  assert.ok(store.rows.get("ended").resultPromptSentAt);
  assert.equal(store.rows.get("ended").publicSyncPending, false);
  assert.equal(store.rows.get("ended").publicRevision, 0);
  assert.ok(new Date(store.rows.get("active").nextProgressAt) > new Date("2026-09-30T10:00:00Z"));
  assert.equal(endedMessage.lastEdit, null);
  assert.equal(visibleDeclarationContent(endedMessage, ended._id), buildSengenDeclarationContent(ended));
  assert.doesNotMatch(endedMessage.content, /結果確認待ち/);
  await fixture.service.processScheduledWork();
  assert.equal(fixture.dmAttempts, 1);
  assert.equal(fixture.dmPayloads.length, 1);
  await fixture.service.shutdown();
});

test("panel removal waits behind a move and removes its committed panel", async () => {
  let unblockSend;
  let sendStarted;
  const started = new Promise((resolve) => { sendStarted = resolve; });
  const sendGate = new Promise((resolve) => { unblockSend = resolve; });
  const oldPanel = makeMessage("old-panel");
  const messages = new Map([[oldPanel.id, oldPanel]]);
  const store = createMemoryStore({ panel: { guildId: "g1", channelId: "panel", messageId: oldPanel.id, stalePanels: [] } });
  const fixture = createFixture({ store });
  fixture.panelChannel._messages.clear();
  for (const [id, message] of messages) fixture.panelChannel._messages.set(id, message);
  fixture.panelChannel.send = async (payload) => {
    sendStarted();
    await sendGate;
    const message = makeMessage("new-panel", payload);
    fixture.panelChannel._messages.set(message.id, message);
    return message;
  };
  oldPanel.delete = async () => { fixture.panelChannel._messages.delete(oldPanel.id); };
  let leaseHeld = false;
  const service = createSengenService({
    client: fixture.client,
    getGuildSettings: async () => fixture.guildSettings,
    store,
    acquireLease: async () => { if (leaseHeld) return null; leaseHeld = true; return { lockKey: "panel" }; },
    renewLease: async () => true,
    releaseLease: async () => { leaseHeld = false; return true; },
    logger: quietLogger,
  });
  const moving = service.movePanelToBottom(fixture.guild);
  await started;
  const removing = service.removePanel(fixture.guild);
  assert.equal(store.panel.messageId, "old-panel");
  unblockSend();
  assert.equal((await moving).status, "moved");
  assert.equal((await removing).status, "removed");
  assert.equal(store.panel, null);
  await service.shutdown();
});

test("ensure-panel cleanup is serialized with a concurrent move", async (t) => {
  for (const cleanupKind of ["stale", "duplicate"]) {
    await t.test(cleanupKind, async () => {
      let unblockDelete;
      let deleteStarted;
      const started = new Promise((resolve) => { deleteStarted = resolve; });
      const deleteGate = new Promise((resolve) => { unblockDelete = resolve; });
      const current = makeMessage("current-panel", panelPayload("overview"));
      const cleanupTarget = cleanupKind === "stale"
        ? makeMessage("stale-panel")
        : makeMessage("duplicate-panel", panelPayload("overview"));
      const messages = new Map([[current.id, current], [cleanupTarget.id, cleanupTarget]]);
      const panel = {
        guildId: "g1",
        channelId: "panel",
        messageId: current.id,
        stalePanels: cleanupKind === "stale" ? [{ channelId: "panel", messageId: cleanupTarget.id }] : [],
      };
      const store = createMemoryStore({ panel });
      const fixture = createFixture({ store });
      fixture.panelChannel._messages.clear();
      for (const [id, message] of messages) fixture.panelChannel._messages.set(id, message);
      let sends = 0;
      fixture.panelChannel.send = async (payload) => {
        sends += 1;
        const message = makeMessage("new-panel", payload);
        fixture.panelChannel._messages.set(message.id, message);
        return message;
      };
      cleanupTarget.delete = async () => {
        deleteStarted();
        await deleteGate;
        fixture.panelChannel._messages.delete(cleanupTarget.id);
      };
      current.delete = async () => { fixture.panelChannel._messages.delete(current.id); };
      let leaseHeld = false;
      const service = createSengenService({
        client: fixture.client,
        getGuildSettings: async () => fixture.guildSettings,
        store,
        acquireLease: async () => {
          if (leaseHeld) return null;
          leaseHeld = true;
          return { lockKey: "panel" };
        },
        renewLease: async () => true,
        releaseLease: async () => { leaseHeld = false; return true; },
        setIntervalFn: () => null,
        clearIntervalFn: () => {},
        logger: quietLogger,
      });

      const ensuring = service.ensurePanel(fixture.guild);
      await started;
      const moving = service.movePanelToBottom(fixture.guild);
      assert.equal(sends, 0, "the move must wait in the guild panel queue");
      assert.equal(store.panel.messageId, current.id);

      unblockDelete();
      assert.equal((await ensuring).status, "current");
      assert.equal((await moving).status, "moved");
      assert.equal(sends, 1);
      assert.equal(store.panel.messageId, "new-panel");
      assert.equal(fixture.panelChannel._messages.has("new-panel"), true);
      await service.shutdown();
    });
  }
});

test("lost panel lease stops ensure cleanup and does not send, delete, or change state", async () => {
  const current = makeMessage("current-panel", panelPayload("overview"));
  const stale = makeMessage("stale-panel");
  const messages = new Map([[current.id, current], [stale.id, stale]]);
  const panel = {
    guildId: "g1",
    channelId: "panel",
    messageId: current.id,
    stalePanels: [{ channelId: "panel", messageId: stale.id }],
  };
  const store = createMemoryStore({ panel });
  const fixture = createFixture({ store });
  fixture.panelChannel._messages.clear();
  for (const [id, message] of messages) fixture.panelChannel._messages.set(id, message);
  let sends = 0;
  let deletes = 0;
  let renewals = 0;
  fixture.panelChannel.send = async () => { sends += 1; throw new Error("must not send"); };
  stale.delete = async () => { deletes += 1; fixture.panelChannel._messages.delete(stale.id); };
  const service = createSengenService({
    client: fixture.client,
    getGuildSettings: async () => fixture.guildSettings,
    store,
    acquireLease: async () => ({ lockKey: "panel" }),
    renewLease: async () => { renewals += 1; return false; },
    releaseLease: async () => true,
    setIntervalFn: () => null,
    clearIntervalFn: () => {},
    logger: quietLogger,
  });

  const result = await service.ensurePanel(fixture.guild);
  assert.equal(result.status, "lease-unavailable");
  assert.equal(renewals, 1);
  assert.equal(sends, 0);
  assert.equal(deletes, 0);
  assert.equal(store.panel.messageId, current.id);
  assert.equal(store.panel.stalePanels.length, 1);
  assert.equal(fixture.panelChannel._messages.has(stale.id), true);
  await service.shutdown();
});

test("panel shutdown drains an in-flight lease heartbeat before releasing its lease", async () => {
  const current = makeMessage("current-panel", panelPayload("overview"));
  const store = createMemoryStore({ panel: { guildId: "g1", channelId: "panel", messageId: current.id, stalePanels: [] } });
  const fixture = createFixture({ store });
  fixture.panelChannel._messages.set(current.id, current);
  let listFetches = 0;
  let triggerHeartbeat;
  const originalFetch = fixture.panelChannel.messages.fetch;
  fixture.panelChannel.messages.fetch = async (options) => {
    const result = await originalFetch(options);
    if (options && typeof options === "object") {
      listFetches += 1;
      if (listFetches === 2) triggerHeartbeat();
    }
    return result;
  };
  let resolveRenewal;
  let renewalCount = 0;
  let releaseCalled = false;
  const renewalGate = new Promise((resolve) => { resolveRenewal = resolve; });
  const service = createSengenService({
    client: fixture.client,
    getGuildSettings: async () => fixture.guildSettings,
    store,
    acquireLease: async () => ({ lockKey: "panel" }),
    renewLease: async () => {
      renewalCount += 1;
      return renewalCount === 1 ? true : renewalGate;
    },
    releaseLease: async () => { releaseCalled = true; return true; },
    setIntervalFn: (callback) => { triggerHeartbeat = callback; return null; },
    clearIntervalFn: () => {},
    logger: quietLogger,
  });

  let completed = false;
  const ensuring = service.ensurePanel(fixture.guild).then((result) => { completed = true; return result; });
  while (listFetches < 2) await new Promise((resolve) => setImmediate(resolve));
  await Promise.resolve();
  assert.equal(releaseCalled, false);
  assert.equal(completed, false);
  resolveRenewal(true);
  assert.equal((await ensuring).status, "current");
  assert.equal(releaseCalled, true);
  await service.shutdown();
});
