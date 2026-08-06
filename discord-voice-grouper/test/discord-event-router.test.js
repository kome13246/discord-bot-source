import test from "node:test";
import assert from "node:assert/strict";
import { registerDiscordEventHandlers } from "../src/app/discord-event-router.js";

const Events = {
  Error: "error", Warn: "warn", ShardError: "shardError", ShardDisconnect: "shardDisconnect",
  ShardReady: "shardReady", ShardReconnecting: "shardReconnecting", Debug: "debug",
  MessageCreate: "messageCreate", GuildMemberAdd: "guildMemberAdd", GuildMemberRemove: "guildMemberRemove",
  VoiceStateUpdate: "voiceStateUpdate", ChannelCreate: "channelCreate", ChannelDelete: "channelDelete",
  ChannelUpdate: "channelUpdate",
};

function setup({ shuttingDown = false } = {}) {
  const listeners = new Map();
  const calls = [];
  const record = (name) => async () => { calls.push(name); };
  registerDiscordEventHandlers({
    client: { on: (event, listener) => listeners.set(event, listener) },
    Events,
    ChannelType: { GuildVoice: 2 },
    debugLogs: false,
    isShuttingDown: () => shuttingDown,
    getGuildSettings: async () => ({}),
    requestOperationalStatusRefresh: () => {},
    logRecoverableError: () => {},
    services: {
      vcDm: { handleMemberAdd: record("member-add"), handleMemberRemove: record("member-remove"), handleVoiceState: record("vc-dm-voice") },
      oteboRecruitmentPanel: { ensureOteboRecruitmentPanel: record("otebo-panel") },
      voiceChannelControl: { handleVoiceState: record("voice-control"), ensurePanel: record("ensure-panel"), cleanup: record("cleanup-panel") },
    },
    handlers: {
      handleDisboardBumpMessage: record("bump"),
      handleTopicRequestMessage: record("topic"),
      handleProfileRegistrationPanelMessage: record("profile-panel"),
      handleOteboRecruitmentPanelMessage: record("otebo-message"),
      handleProfileVoiceState: record("profile-voice"),
      handleVoiceStateUpdate: record("voice-update"),
    },
    logger: { log: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  });
  return { listeners, calls };
}

test("Discordイベントルーターはメッセージ処理の順序を維持する", async () => {
  const { listeners, calls } = setup();
  await listeners.get(Events.MessageCreate)({});
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["bump", "topic", "profile-panel", "otebo-message"]);
});

test("終了処理中は新しいDiscordイベント処理を開始しない", async () => {
  const { listeners, calls } = setup({ shuttingDown: true });
  await listeners.get(Events.MessageCreate)({});
  await listeners.get(Events.GuildMemberAdd)({});
  assert.deepEqual(calls, []);
});
