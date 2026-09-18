import test from "node:test";
import assert from "node:assert/strict";
import { createRtcService } from "../src/rtc-service.js";

function createRoomModel(initial = []) {
  const rows = new Map(initial.map((row) => [`${row.guildId}:${row.channelId}`, { ...row }]));
  return {
    findOne: ({ guildId, channelId }) => rows.get(`${guildId}:${channelId}`) ?? null,
    find: ({ guildId }) => [...rows.values()].filter((row) => row.guildId === guildId),
    create: async (row) => { rows.set(`${row.guildId}:${row.channelId}`, { ...row }); return { ...row }; },
    deleteOne: async ({ guildId, channelId }) => { rows.delete(`${guildId}:${channelId}`); return { deletedCount: 1 }; },
    rows,
  };
}

function createPanelModel(initial = null) {
  let row = initial ? { ...initial } : null;
  return {
    findOne: async () => (row ? { ...row } : null),
    findOneAndUpdate: async ({ guildId }, update) => {
      row = { ...(row ?? {}), guildId, ...(update.$set ?? {}) };
      return { ...row };
    },
    deleteOne: async ({ guildId }) => {
      if (row?.guildId === guildId) row = null;
      return { deletedCount: 1 };
    },
    get row() { return row ? { ...row } : null; },
  };
}

function createMember(id, channel = null) {
  const member = {
    id,
    user: { id, bot: false },
    voice: { channelId: channel?.id ?? null, channel },
    roles: {
      cache: new Map(),
      add: async () => {},
      remove: async () => {},
    },
  };
  return member;
}

function createChannel(id, name = `room-${id}`) {
  const members = new Map();
  return {
    id,
    name,
    type: 2,
    members,
    isVoiceBased: () => true,
    send: async function send(payload) { this.sent = [...(this.sent ?? []), payload]; return payload; },
  };
}

function createFixture({ now = () => 0, timers = null, ensureVoiceControlPanel = null } = {}) {
  const room = createChannel("room-a", "💬｜チャットルーム-1");
  const channels = new Map([[room.id, room]]);
  const guild = {
    id: "guild-1",
    channels: { cache: channels, fetch: async (id) => channels.get(id) ?? null },
    members: { cache: new Map() },
    roles: { cache: new Map() },
  };
  const client = { guilds: { cache: new Map([[guild.id, guild]]) } };
  const roomModel = createRoomModel([{ guildId: guild.id, channelId: room.id, sourceParentChannelId: "parent", categoryIdAtCreation: "category", name: room.name }]);
  const settings = {
    rtcCategoryId: "category",
    rtcParentChannelId: "parent",
    rtcReceptionChannelId: "reception",
    rtcActiveRoleId: "active",
  };
  const service = createRtcService({
    client,
    getGuildSettings: async () => settings,
    getVoiceReminderParentChannelIds: () => ["voice-parent-a", "voice-parent-b"],
    roomModel,
    panelModel: null,
    ensureVoiceControlPanel,
    now,
    setTimeoutFn: timers?.set ?? ((callback, delay) => setTimeout(callback, delay)),
    clearTimeoutFn: timers?.clear ?? clearTimeout,
    logger: { error() {}, warn() {} },
  });
  return { client, guild, room, roomModel, service, settings };
}

function buttonInteraction(guild, member, customId) {
  return {
    guildId: guild.id,
    guild,
    user: member.user,
    member,
    customId,
    message: { channelId: "reception", id: "panel" },
    isButton: () => true,
    replies: [],
    reply(payload) { this.replies.push(payload); this.replied = true; return Promise.resolve(payload); },
  };
}

test("RTC対象VCは永続生成記録があるVCだけで、同じカテゴリの手動VCを含めない", async () => {
  const fixture = createFixture();
  await fixture.service.listRooms(fixture.guild.id);
  const manual = createChannel("manual", "💬｜チャットルーム-2");
  fixture.guild.channels.cache.set(manual.id, manual);
  assert.equal(fixture.service.isRtcChannel(fixture.guild.id, fixture.room.id), true);
  assert.equal(fixture.service.isRtcChannel(fixture.guild.id, manual.id), false);
});

test("1人readyは成立せず、2人目のreadyで個人メンション通知後にreadyを解除する", async () => {
  const fixture = createFixture();
  fixture.room.userLimit = 1;
  const a = createMember("a", fixture.room);
  const b = createMember("b", fixture.room);
  fixture.room.members.set(a.id, a);
  const first = buttonInteraction(fixture.guild, a, "rtc:ready");
  await fixture.service.handleInteraction(first);
  assert.match(first.replies[0].content, /ほかのメンバー/);
  assert.deepEqual(fixture.service.getReadySnapshot(fixture.guild.id, fixture.room.id), ["a"]);
  fixture.room.members.set(b.id, b);
  const second = buttonInteraction(fixture.guild, b, "rtc:ready");
  await fixture.service.handleInteraction(second);
  assert.equal(fixture.room.sent.length, 1);
  assert.match(fixture.room.sent[0].content, /<@a> <@b>/);
  assert.deepEqual(fixture.service.getReadySnapshot(fixture.guild.id, fixture.room.id), []);
});

test("退出後は最新の5秒タイマーで再判定し、ready送信失敗時は状態を保持する", async () => {
  let current = 0;
  const scheduled = [];
  const timers = {
    set(callback, delay) { const entry = { callback, due: current + delay, cleared: false }; scheduled.push(entry); return entry; },
    clear(entry) { if (entry) entry.cleared = true; },
  };
  const fixture = createFixture({ now: () => current, timers });
  const a = createMember("a", fixture.room);
  const b = createMember("b", fixture.room);
  const c = createMember("c", fixture.room);
  fixture.room.members.set(a.id, a);
  fixture.room.members.set(b.id, b);
  fixture.room.members.set(c.id, c);
  await fixture.service.handleInteraction(buttonInteraction(fixture.guild, a, "rtc:ready"));
  await fixture.service.handleInteraction(buttonInteraction(fixture.guild, b, "rtc:ready"));
  // The immediate notification is intentionally successful; the next cycle
  // verifies that a failed delayed notification does not erase ready state.
  fixture.room.send = async () => { throw new Error("temporary Discord failure"); };
  await fixture.service.handleInteraction(buttonInteraction(fixture.guild, a, "rtc:ready"));
  await fixture.service.handleInteraction(buttonInteraction(fixture.guild, b, "rtc:ready"));
  fixture.room.members.delete(c.id);
  await fixture.service.handleVoiceStateUpdate({ guild: fixture.guild, channelId: fixture.room.id, member: c }, { guild: fixture.guild, channelId: null, member: c });
  current = 4_999;
  await scheduled.filter((entry) => !entry.cleared).at(-1)?.callback();
  assert.deepEqual(fixture.service.getReadySnapshot(fixture.guild.id, fixture.room.id), ["a", "b"]);
  current = 5_000;
  await scheduled.filter((entry) => !entry.cleared).at(-1)?.callback();
  assert.deepEqual(fixture.service.getReadySnapshot(fixture.guild.id, fixture.room.id), ["a", "b"]);
});

test("親VCの重複VoiceStateUpdateは同じ生成ルームを再利用する", async () => {
  const fixture = createFixture();
  const parent = createChannel("parent", "チャットルームを作成");
  fixture.guild.channels.cache.set(parent.id, parent);
  let created = 0;
  fixture.guild.channels.create = async (options) => {
    created += 1;
    const child = createChannel(`generated-${created}`, options.name);
    child.parentId = options.parent;
    fixture.guild.channels.cache.set(child.id, child);
    return child;
  };
  const member = createMember("new-user", parent);
  member.guild = fixture.guild;
  member.voice.setChannel = async (channel) => {
    member.voice.channelId = channel.id;
    member.voice.channel = channel;
    channel.members.set(member.id, member);
  };
  fixture.guild.members.cache.set(member.id, member);
  const state = { guild: fixture.guild, channelId: parent.id, member };
  await fixture.service.handleVoiceStateUpdate({ guild: fixture.guild, channelId: null, member }, state);
  await fixture.service.handleVoiceStateUpdate({ guild: fixture.guild, channelId: null, member }, state);
  assert.equal(created, 1);
});

test("生成後の移動失敗で空の子VCを削除できた場合は記録も補償削除する", async () => {
  const fixture = createFixture();
  const parent = createChannel("parent", "チャットルームを作成");
  fixture.guild.channels.cache.set(parent.id, parent);
  const deleted = [];
  fixture.guild.channels.create = async (options) => {
    const child = createChannel("generated-failed", options.name);
    child.parentId = options.parent;
    child.delete = async (reason) => { deleted.push(reason); };
    fixture.guild.channels.cache.set(child.id, child);
    return child;
  };
  const member = createMember("move-failed", parent);
  member.guild = fixture.guild;
  member.voice.setChannel = async () => { throw new Error("move denied"); };
  fixture.guild.members.cache.set(member.id, member);
  await fixture.service.handleVoiceStateUpdate(
    { guild: fixture.guild, channelId: null, member },
    { guild: fixture.guild, channelId: parent.id, member },
  );
  assert.deepEqual(deleted, ["RTC member move failed"]);
  assert.equal(fixture.roomModel.rows.has(`${fixture.guild.id}:generated-failed`), false);
});

test("RTC子VCの移動成功後に共通VCコントロールパネルを設置する", async () => {
  const panelChannels = [];
  const fixture = createFixture({ ensureVoiceControlPanel: async (channel) => {
    panelChannels.push(channel.id);
    return { status: "created" };
  } });
  const parent = createChannel("parent", "チャットルームを作成");
  fixture.guild.channels.cache.set(parent.id, parent);
  fixture.guild.channels.create = async (options) => {
    const child = createChannel("generated-panel", options.name);
    child.parentId = options.parent;
    fixture.guild.channels.cache.set(child.id, child);
    return child;
  };
  const member = createMember("panel-user", parent);
  member.guild = fixture.guild;
  member.voice.setChannel = async (channel) => {
    member.voice.channelId = channel.id;
    member.voice.channel = channel;
    channel.members.set(member.id, member);
  };
  fixture.guild.members.cache.set(member.id, member);
  await fixture.service.handleVoiceStateUpdate(
    { guild: fixture.guild, channelId: null, member },
    { guild: fixture.guild, channelId: parent.id, member },
  );
  assert.deepEqual(panelChannels, ["generated-panel"]);
});

test("設定変更で利用中ロールを差し替えると旧ロール保持者も解除する", async () => {
  const fixture = createFixture();
  const member = createMember("role-user", fixture.room);
  member.guild = fixture.guild;
  fixture.room.members.set(member.id, member);
  const removed = [];
  member.roles.remove = async (roleId) => { removed.push(roleId); };
  const oldRole = { id: "old-role", members: new Map([[member.id, member]]) };
  const newRole = { id: "active", members: new Map() };
  fixture.guild.roles.cache.set(oldRole.id, oldRole);
  fixture.guild.roles.cache.set(newRole.id, newRole);
  await fixture.service.syncGuildRoles(fixture.guild, { rtcActiveRoleId: "active" }, { rtcActiveRoleId: oldRole.id });
  assert.deepEqual(removed, ["old-role"]);
});

test("通知送信中のcancelからreadyし直した同一ユーザーの新世代を消さない", async () => {
  const fixture = createFixture();
  const a = createMember("a", fixture.room);
  const b = createMember("b", fixture.room);
  fixture.room.members.set(a.id, a);
  fixture.room.members.set(b.id, b);
  let sendStarted = false;
  fixture.room.send = async function send(payload) {
    sendStarted = true;
    await fixture.service.handleInteraction(buttonInteraction(fixture.guild, a, "rtc:cancel"));
    await fixture.service.handleInteraction(buttonInteraction(fixture.guild, a, "rtc:ready"));
    this.sent = [...(this.sent ?? []), payload];
    return payload;
  };
  await fixture.service.handleInteraction(buttonInteraction(fixture.guild, a, "rtc:ready"));
  await fixture.service.handleInteraction(buttonInteraction(fixture.guild, b, "rtc:ready"));
  assert.equal(sendStarted, true);
  assert.deepEqual(fixture.service.getReadySnapshot(fixture.guild.id, fixture.room.id), ["a"]);
});

test("通知直前に参加者が増えた場合は古い構成で成立させない", async () => {
  const fixture = createFixture();
  const a = createMember("a", fixture.room);
  const b = createMember("b", fixture.room);
  const c = createMember("c", fixture.room);
  fixture.room.members.set(a.id, a);
  fixture.room.members.set(b.id, b);
  fixture.room.send = async () => { throw new Error("temporary Discord failure"); };
  await fixture.service.handleInteraction(buttonInteraction(fixture.guild, a, "rtc:ready"));
  await fixture.service.handleInteraction(buttonInteraction(fixture.guild, b, "rtc:ready"));
  const channelGet = fixture.guild.channels.cache.get.bind(fixture.guild.channels.cache);
  let reads = 0;
  fixture.guild.channels.cache.get = (id) => {
    if (id === fixture.room.id) {
      reads += 1;
      if (reads === 2) fixture.room.members.set(c.id, c);
    }
    return channelGet(id);
  };
  fixture.room.send = async function send(payload) {
    this.sent = [...(this.sent ?? []), payload];
    return payload;
  };
  const result = await fixture.service.maybeNotify(fixture.guild.id, fixture.room.id);
  assert.equal(result.status, "membership-changed");
  assert.equal(fixture.room.sent, undefined);
  assert.deepEqual(fixture.service.getReadySnapshot(fixture.guild.id, fixture.room.id), ["a", "b"]);
});

test("退出後の空室は再確認して削除し、RtcRoom記録も掃除する", async () => {
  const fixture = createFixture();
  const deleted = [];
  fixture.room.delete = async (reason) => { deleted.push(reason); };
  fixture.room.members.clear();
  const result = await fixture.service.maybeNotify(fixture.guild.id, fixture.room.id);
  assert.equal(result.status, "deleted");
  assert.deepEqual(deleted, ["RTC空室の自動削除"]);
  assert.equal(fixture.roomModel.rows.has(`${fixture.guild.id}:${fixture.room.id}`), false);
  assert.equal(fixture.service.isRtcChannel(fixture.guild.id, fixture.room.id), false);
});

test("起動復旧は確定欠損VCの孤児記録だけを削除し、一時取得失敗は保持する", async () => {
  const missingModel = createRoomModel([{ guildId: "guild-missing", channelId: "missing" }]);
  const missingError = new Error("Unknown Channel");
  missingError.code = 10003;
  const missingGuild = {
    id: "guild-missing",
    channels: { cache: new Map(), fetch: async () => { throw missingError; } },
  };
  const missingService = createRtcService({
    client: { guilds: { cache: new Map([[missingGuild.id, missingGuild]]) } },
    getGuildSettings: async () => null,
    roomModel: missingModel,
    panelModel: null,
    logger: { error() {}, warn() {} },
  });
  await missingService.restore([missingGuild]);
  assert.equal(missingModel.rows.size, 0);

  const transientModel = createRoomModel([{ guildId: "guild-transient", channelId: "transient" }]);
  const transientGuild = {
    id: "guild-transient",
    channels: { cache: new Map(), fetch: async () => { throw new Error("Discord unavailable"); } },
  };
  const transientService = createRtcService({
    client: { guilds: { cache: new Map([[transientGuild.id, transientGuild]]) } },
    getGuildSettings: async () => null,
    roomModel: transientModel,
    panelModel: null,
    logger: { error() {}, warn() {} },
  });
  await transientService.restore([transientGuild]);
  assert.equal(transientModel.rows.size, 1);
});

test("受付パネルは現Botのメッセージだけを回収し、並行ensureでも1件だけ送信する", async () => {
  const messages = new Map([
    ["other-panel", {
      id: "other-panel",
      author: { id: "other-bot", bot: true },
      components: [{ components: [{ customId: "rtc:ready" }] }],
    }],
  ]);
  let sends = 0;
  let firstSendStarted;
  let releaseFirstSend;
  const firstSend = new Promise((resolve) => { releaseFirstSend = resolve; });
  const reception = {
    id: "reception",
    type: 0,
    isTextBased: () => true,
    permissionsFor: () => ({ has: () => true }),
    messages: {
      fetch: async (target) => typeof target === "string" ? messages.get(target) ?? null : messages,
    },
    send: async (payload) => {
      sends += 1;
      if (sends === 1) {
        firstSendStarted = true;
        await firstSend;
      }
      const message = {
        id: `rtc-panel-${sends}`,
        author: { id: "current-bot", bot: true },
        components: payload.components,
        edit: async () => {},
      };
      messages.set(message.id, message);
      return message;
    },
  };
  const guild = {
    id: "guild-panel",
    client: { user: { id: "current-bot" } },
    members: { me: { user: { id: "current-bot" } } },
    channels: { cache: new Map([[reception.id, reception]]) },
  };
  const client = { user: { id: "current-bot" }, guilds: { cache: new Map([[guild.id, guild]]) } };
  const panelModel = createPanelModel();
  const service = createRtcService({
    client,
    getGuildSettings: async () => ({ rtcReceptionChannelId: reception.id }),
    roomModel: createRoomModel(),
    panelModel,
    logger: { error() {}, warn() {} },
  });
  const first = service.ensurePanel(guild);
  while (!firstSendStarted) await new Promise((resolve) => setImmediate(resolve));
  const second = service.ensurePanel(guild);
  releaseFirstSend();
  await Promise.all([first, second]);
  assert.equal(sends, 1);
  assert.equal(panelModel.row.messageId, "rtc-panel-1");
});
