import test from "node:test";
import assert from "node:assert/strict";
import { buildVoiceControlPanel, createVoiceChannelControlService } from "../src/voice-channel-control-service.js";

const CHANNEL_ID = "123456789012345";

function componentIds(payload) {
  return payload.components.flatMap((row) => row.components).map((component) => component.toJSON().custom_id);
}

function createControlFixture({ rtc = true, normal = false } = {}) {
  let record = null;
  const messages = new Map();
  const sent = [];
  const channel = {
    id: CHANNEL_ID,
    type: 2,
    parentId: "category",
    name: "💬｜チャットルーム-1",
    members: new Map(),
    permissionsFor: () => ({ has: () => true }),
    messages: {
      fetch: async (id) => (id ? messages.get(id) : messages),
    },
    send: async (payload) => {
      const message = { id: `panel-${sent.length + 1}`, edit: async (next) => { message.payload = next; } };
      message.payload = payload;
      messages.set(message.id, message);
      sent.push(payload);
      return message;
    },
    setName: async (name) => { channel.name = name; },
    setVoiceChannelStatus: async (status) => { channel.status = status; },
    setUserLimit: async (limit) => { channel.userLimit = limit; },
  };
  const guild = {
    id: "guild-1",
    members: { me: { id: "bot" } },
    channels: { cache: new Map([[CHANNEL_ID, channel]]) },
  };
  channel.guild = guild;
  const schedule = { _id: "schedule-1", guildId: guild.id, userId: "user-1", voiceChannelId: CHANNEL_ID, scheduledAt: new Date(Date.now() + 60_000) };
  const replies = [];
  const updates = [];
  const service = createVoiceChannelControlService({
    getGuildSettings: async () => ({ vcControlCategoryId: normal ? "category" : null }),
    isRtcChannel: () => rtc,
    acquireLease: async () => ({ id: "lease" }),
    renewLease: async () => true,
    releaseLease: async () => {},
    getVoiceControlRecord: async () => record,
    upsertVoiceControlRecord: async (_guildId, _channelId, patch) => { record = { guildId: guild.id, channelId: CHANNEL_ID, ...patch }; return record; },
    getVoiceExitScheduleRecord: async () => schedule,
    cancelVoiceExitScheduleRecord: async () => schedule,
    setVoiceChannelStatus: async (target, status) => { target.status = status; },
    setIntervalFn: null,
    logger: { error() {}, warn() {} },
  });
  const interactionBase = {
    guildId: guild.id,
    guild,
    user: { id: "user-1", bot: false },
    member: { voice: { channelId: CHANNEL_ID } },
    replied: false,
    deferred: false,
    reply(payload) { replies.push(payload); this.replied = true; return Promise.resolve(payload); },
    update(payload) { updates.push(payload); return Promise.resolve(payload); },
    showModal(payload) { this.modal = payload; return Promise.resolve(payload); },
    isStringSelectMenu: () => false,
  };
  return { service, guild, channel, sent, replies, updates, interactionBase };
}

test("通常VCは4機能、RTC子VCはnameを除く3機能の共通payloadになる", () => {
  const channel = { id: CHANNEL_ID };
  const normal = buildVoiceControlPanel(channel);
  const rtc = buildVoiceControlPanel(channel, { rtc: true });
  assert.deepEqual(componentIds(normal), [
    `vc_control:name:${CHANNEL_ID}`,
    `vc_control:limit:${CHANNEL_ID}`,
    `vc_control:status:${CHANNEL_ID}`,
    `vc_control:exit_schedule:${CHANNEL_ID}`,
  ]);
  assert.deepEqual(componentIds(rtc), [
    `vc_control:limit:${CHANNEL_ID}`,
    `vc_control:status:${CHANNEL_ID}`,
    `vc_control:exit_schedule:${CHANNEL_ID}`,
  ]);
  assert.match(normal.embeds[0].toJSON().description, /名前変更/);
  assert.doesNotMatch(rtc.embeds[0].toJSON().description, /名前変更|VC名/);
});

test("RTC用ensurePanelは共通サービスを使い、現在のpayloadからname UIを除外する", async () => {
  const fixture = createControlFixture({ rtc: true });
  const result = await fixture.service.ensurePanel(fixture.channel);
  assert.equal(result.status, "created");
  assert.deepEqual(componentIds(fixture.sent[0]), [
    `vc_control:limit:${CHANNEL_ID}`,
    `vc_control:status:${CHANNEL_ID}`,
    `vc_control:exit_schedule:${CHANNEL_ID}`,
  ]);
});

test("RTCでは古いname buttonとname modalもhandler側で拒否し、チャンネル名を変更しない", async () => {
  const fixture = createControlFixture({ rtc: true });
  const button = { ...fixture.interactionBase, customId: `vc_control:name:${CHANNEL_ID}`, isButton: () => true, isModalSubmit: () => false };
  await fixture.service.handle(button);
  assert.equal(fixture.channel.name, "💬｜チャットルーム-1");
  assert.match(fixture.replies.at(-1).content, /VC名を変更できません/);

  const modal = {
    ...fixture.interactionBase,
    customId: `vc_control:name_modal:${CHANNEL_ID}`,
    isButton: () => false,
    isModalSubmit: () => true,
    fields: { getTextInputValue: () => "不正な名前" },
  };
  await fixture.service.handle(modal);
  assert.equal(fixture.channel.name, "💬｜チャットルーム-1");
  assert.match(fixture.replies.at(-1).content, /VC名を変更できません/);
});

test("RTCのstatus・解除、limit、exit_scheduleは既存handlerへ通る", async () => {
  const fixture = createControlFixture({ rtc: true });
  const statusButton = { ...fixture.interactionBase, customId: `vc_control:status:${CHANNEL_ID}`, isButton: () => true, isModalSubmit: () => false };
  await fixture.service.handle(statusButton);
  assert.equal(fixture.replies.length, 0);

  const statusModal = {
    ...fixture.interactionBase,
    customId: `vc_control:status_modal:${CHANNEL_ID}`,
    isButton: () => false,
    isModalSubmit: () => true,
    fields: { getTextInputValue: () => "作業しながら雑談" },
  };
  await fixture.service.handle(statusModal);
  assert.equal(fixture.channel.status, "作業しながら雑談");

  const clearModal = {
    ...statusModal,
    fields: { getTextInputValue: () => "" },
  };
  await fixture.service.handle(clearModal);
  assert.equal(fixture.channel.status, "");

  const limitButton = { ...fixture.interactionBase, customId: `vc_control:limit:${CHANNEL_ID}`, isButton: () => true, isModalSubmit: () => false };
  await fixture.service.handle(limitButton);
  assert.equal(fixture.replies.length > 0, true);
  const limitSelect = {
    ...fixture.interactionBase,
    customId: `vc_control:limit_select:${CHANNEL_ID}`,
    values: ["4"],
    isButton: () => false,
    isModalSubmit: () => false,
    isStringSelectMenu: () => true,
  };
  await fixture.service.handle(limitSelect);
  assert.equal(fixture.channel.userLimit, 4);

  const exitButton = { ...fixture.interactionBase, customId: `vc_control:exit_schedule:${CHANNEL_ID}`, isButton: () => true, isModalSubmit: () => false };
  await fixture.service.handle(exitButton);
  assert.equal(fixture.replies.length > 1, true);
  const exitCancel = {
    ...fixture.interactionBase,
    customId: `vc_control:exit_schedule_select:${CHANNEL_ID}`,
    values: ["cancel"],
    isButton: () => false,
    isModalSubmit: () => false,
    isStringSelectMenu: () => true,
  };
  await fixture.service.handle(exitCancel);
  assert.equal(fixture.updates.at(-1).content, "退出予定のキャンセルが完了しました。");
});

test("通常VCのpanelは従来どおりnameを表示する", async () => {
  const fixture = createControlFixture({ rtc: false, normal: true });
  const result = await fixture.service.ensurePanel(fixture.channel);
  assert.equal(result.status, "created");
  assert.deepEqual(componentIds(fixture.sent[0]), [
    `vc_control:name:${CHANNEL_ID}`,
    `vc_control:limit:${CHANNEL_ID}`,
    `vc_control:status:${CHANNEL_ID}`,
    `vc_control:exit_schedule:${CHANNEL_ID}`,
  ]);
});
