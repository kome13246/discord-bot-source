import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  buildProfileRegistrationPanelPayload,
  createProfileRegistrationPanelService,
} from "../src/profile-registration-panel-service.js";

function collection(messages) {
  return {
    values: () => messages.values(),
    first: () => messages.values().next().value,
  };
}

function createGuildChannel({ messages, events }) {
  let nextId = 1;
  const channel = {
    id: "intro",
    type: 0,
    permissionsFor: () => ({ has: () => true }),
    send: async (payload) => {
      events.push("send");
      const message = {
        id: `new-${nextId++}`,
        author: { id: "bot" },
        embeds: [{ title: payload.embeds[0].data.title, description: payload.embeds[0].data.description }],
        components: [{ components: [{ customId: "profile_open" }] }],
        delete: async () => { events.push(`delete:${message.id}`); messages.delete(message.id); },
      };
      messages.set(message.id, message);
      return message;
    },
    messages: {
      fetch: async (value) => {
        if (typeof value === "string") return messages.get(value) ?? null;
        return collection(messages);
      },
    },
  };
  return channel;
}

test("profile registration panel payload has the specified text, button, and no mentions", () => {
  const payload = buildProfileRegistrationPanelPayload();
  assert.equal(payload.embeds[0].data.title, "プロフィール登録・編集");
  assert.equal(payload.embeds[0].data.description, "ここから登録したプロフィールはVCのチャットへ自動で送信されます");
  assert.equal(payload.components[0].components[0].data.custom_id, "profile_open");
  assert.equal(payload.components[0].components[0].data.label, "プロフィールを登録・編集");
  assert.deepEqual(payload.allowedMentions, { parse: [] });
});

test("panel replacement saves the new state before deleting the old panel", async () => {
  const events = [];
  const messages = new Map();
  const oldMessage = { id: "old", author: { id: "bot" }, delete: async () => { events.push("delete:old"); messages.delete("old"); } };
  messages.set(oldMessage.id, oldMessage);
  const channel = createGuildChannel({ messages, events });
  let state = { guildId: "guild", channelId: "intro", messageId: "old" };
  const guild = {
    id: "guild",
    client: { user: { id: "bot" } },
    members: { me: {} },
    channels: { fetch: async () => channel },
  };
  const service = createProfileRegistrationPanelService({
    getGuildSettings: async () => ({ profileIntroductionChannelId: "intro" }),
    getPanel: async () => state,
    savePanel: async (next) => { events.push("save"); state = next; return state; },
    deletePanel: async () => { state = null; },
    acquireLease: async () => ({ lockKey: "lease", ownerId: "owner" }),
    releaseLease: async () => true,
    sendOperationalLog: async () => null,
  });
  const result = await service.moveProfileRegistrationPanelToBottom(guild, "test");
  assert.equal(result.status, "moved");
  assert.deepEqual(events.slice(0, 3), ["send", "save", "delete:old"]);
  assert.equal(messages.size, 1);
  assert.equal(state.messageId, "new-1");
});

test("a panel send or state-save failure preserves the previous persisted panel", async () => {
  const events = [];
  const messages = new Map();
  const channel = createGuildChannel({ messages, events });
  const guild = {
    id: "guild",
    client: { user: { id: "bot" } },
    members: { me: {} },
    channels: { fetch: async () => channel },
  };
  let state = { guildId: "guild", channelId: "intro", messageId: "old" };
  channel.send = async () => { throw new Error("send denied"); };
  const sendFailure = createProfileRegistrationPanelService({
    getGuildSettings: async () => ({ profileIntroductionChannelId: "intro" }), getPanel: async () => state,
    savePanel: async (next) => { state = next; }, deletePanel: async () => {}, acquireLease: async () => ({ lockKey: "lease" }), releaseLease: async () => {},
    sendOperationalLog: async () => {}, logger: { error: () => {} },
  });
  assert.equal((await sendFailure.moveProfileRegistrationPanelToBottom(guild)).status, "send-failed");
  assert.equal(state.messageId, "old");

  const savedMessages = new Map();
  const saveChannel = createGuildChannel({ messages: savedMessages, events });
  guild.channels.fetch = async () => saveChannel;
  const saveFailure = createProfileRegistrationPanelService({
    getGuildSettings: async () => ({ profileIntroductionChannelId: "intro" }), getPanel: async () => state,
    savePanel: async () => { throw new Error("database unavailable"); }, deletePanel: async () => {}, acquireLease: async () => ({ lockKey: "lease" }), releaseLease: async () => {},
    sendOperationalLog: async () => {}, logger: { error: () => {} },
  });
  assert.equal((await saveFailure.moveProfileRegistrationPanelToBottom(guild)).status, "save-failed");
  assert.equal(state.messageId, "old");
  assert.equal(savedMessages.size, 0);
});

test("ensure replaces an old-description panel even when it is currently last", async () => {
  const events = [];
  const messages = new Map();
  const oldPanel = {
    id: "old", author: { id: "bot" },
    embeds: [{ title: "プロフィール登録・編集", description: "下のボタンからプロフィールを登録・編集できます。" }],
    components: [{ components: [{ customId: "profile_open" }] }],
    delete: async () => { events.push("delete:old"); messages.delete("old"); },
  };
  messages.set(oldPanel.id, oldPanel);
  const channel = createGuildChannel({ messages, events });
  let state = { guildId: "guild", channelId: "intro", messageId: "old" };
  const guild = { id: "guild", client: { user: { id: "bot" } }, members: { me: {} }, channels: { fetch: async () => channel } };
  const service = createProfileRegistrationPanelService({
    getGuildSettings: async () => ({ profileIntroductionChannelId: "intro" }), getPanel: async () => state,
    savePanel: async (next) => { state = next; return next; }, deletePanel: async () => {}, acquireLease: async () => ({ lockKey: "lease" }), releaseLease: async () => {}, sendOperationalLog: async () => {},
  });
  assert.equal((await service.ensureProfileRegistrationPanel(guild)).status, "moved");
  assert.deepEqual(events.slice(0, 2), ["send", "delete:old"]);
});

test("ensure creates a panel when the stored message no longer exists", async () => {
  const events = [];
  const messages = new Map();
  const channel = createGuildChannel({ messages, events });
  let state = { guildId: "guild", channelId: "intro", messageId: "missing" };
  const guild = { id: "guild", client: { user: { id: "bot" } }, members: { me: {} }, channels: { fetch: async () => channel } };
  const service = createProfileRegistrationPanelService({
    getGuildSettings: async () => ({ profileIntroductionChannelId: "intro" }), getPanel: async () => state,
    savePanel: async (next) => { state = next; return next; }, deletePanel: async () => {}, acquireLease: async () => ({ lockKey: "lease" }), releaseLease: async () => {}, sendOperationalLog: async () => {},
  });
  assert.equal((await service.ensureProfileRegistrationPanel(guild)).status, "moved");
  assert.equal(events[0], "send");
  assert.equal(state.messageId, "new-1");
});

test("remove clears state when Discord reports an unknown message", async () => {
  let deleted = false;
  const channel = {
    id: "intro",
    messages: { fetch: async () => { const error = new Error("unknown message"); error.code = 10008; throw error; } },
  };
  const guild = { id: "guild", channels: { fetch: async () => channel } };
  const service = createProfileRegistrationPanelService({
    getPanel: async () => ({ guildId: "guild", channelId: "intro", messageId: "missing" }),
    deletePanel: async () => { deleted = true; }, sendOperationalLog: async () => {}, logger: { error: () => {} },
  });
  assert.equal((await service.removeProfileRegistrationPanel(guild)).status, "removed");
  assert.equal(deleted, true);
});

test("an unavailable lease leaves the current panel untouched and sends nothing", async () => {
  const events = [];
  const channel = createGuildChannel({ messages: new Map(), events });
  const guild = { id: "guild", client: { user: { id: "bot" } }, members: { me: {} }, channels: { fetch: async () => channel } };
  const service = createProfileRegistrationPanelService({
    getGuildSettings: async () => ({ profileIntroductionChannelId: "intro" }), acquireLease: async () => null,
    sendOperationalLog: async () => {},
  });
  assert.equal((await service.moveProfileRegistrationPanelToBottom(guild)).status, "lease-unavailable");
  assert.deepEqual(events, []);
});

test("a debounced request resolves the superseded request and moves only once", async () => {
  const events = [];
  const messages = new Map();
  const channel = createGuildChannel({ messages, events });
  let state = null;
  const guild = {
    id: "guild",
    client: { user: { id: "bot" } },
    members: { me: {} },
    channels: { fetch: async () => channel },
  };
  const service = createProfileRegistrationPanelService({
    getGuildSettings: async () => ({ profileIntroductionChannelId: "intro" }),
    getPanel: async () => state,
    savePanel: async (next) => { state = next; return state; },
    deletePanel: async () => { state = null; },
    acquireLease: async () => ({ lockKey: "lease", ownerId: "owner" }),
    releaseLease: async () => true,
    sendOperationalLog: async () => null,
    debounceMs: 5,
  });
  const first = service.requestProfileRegistrationPanelMove(guild, "first");
  const second = service.requestProfileRegistrationPanelMove(guild, "second");
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.status, "debounced");
  assert.equal(secondResult.status, "moved");
  assert.deepEqual(events, ["send"]);
});

test("bot integration shares the setup payload, restores modal values, and ignores unsafe message triggers", async () => {
  const source = await readFile(new URL("../src/bot.js", import.meta.url), "utf8");
  assert.match(source, /interaction\.reply\(buildProfileRegistrationPanelPayload\(\)\)/);
  assert.match(source, /UserProfile\.findOne\(\{ guildId: interaction\.guildId, userId: interaction\.user\.id \}\)\.lean\(\)/);
  assert.match(source, /normalizeProfileValue\(profile\?\.nickname, 20\)/);
  assert.match(source, /status: submittedValues\.status/);
  assert.doesNotMatch(source, /submittedValues\.status \|\| existing\?\.status/);
  assert.match(source, /message\.author\?\.bot \|\| message\.webhookId \|\| message\.system \|\| message\.channel\?\.isThread\?\.\(\)/);
  assert.match(source, /void profileRegistrationPanelService\.requestProfileRegistrationPanelMove\(interaction\.guild, "profile-published"\)/);
  assert.match(source, /fallbackChannel: null/);
  const commands = await readFile(new URL("../src/commands.js", import.meta.url), "utf8");
  const profileCommand = commands.slice(commands.indexOf('.setName("profile")'), commands.indexOf("export const showReviewCommand"));
  assert.match(profileCommand, /addChannelTypes\(ChannelType\.GuildText\)/);
  assert.doesNotMatch(profileCommand, /GuildAnnouncement/);
});
