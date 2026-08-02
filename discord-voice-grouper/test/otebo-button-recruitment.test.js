import assert from "node:assert/strict";
import test from "node:test";
import { commands } from "../src/commands.js";
import {
  BUTTON_RECRUITMENT_CONFLICT_MESSAGE,
  formatOteboRecruitmentMessage,
  formatOteboSuccessNotice,
} from "../src/otebo-utils.js";
import {
  buildOteboRecruitmentPanelPayload,
  createOteboRecruitmentPanelService,
  OTEBO_PANEL_BUTTON_CUSTOM_ID,
  OTEBO_PANEL_TEXT,
} from "../src/otebo-recruitment-panel-service.js";
import { createCallWaitRoleService } from "../src/call-wait-role-service.js";

test("ボタン募集の公開本文は匿名で、設定した要素だけを含める", () => {
  const withOptions = formatOteboRecruitmentMessage({
    closingAt: "2026-08-02T03:00:00.000Z",
    duration: "30",
    mentionRoleId: "role-id",
    mentionEnabled: true,
    note: "気軽にどうぞ @everyone",
  });
  assert.equal(
    withOptions,
    "【雑談募集】 <@&role-id>\n12:00まで掲載される雑談の募集です。(30分間予定)\n下の参加ボタンが押されたら集合メンションが行われます。\nひとこと：気軽にどうぞ @​everyone",
  );
  assert.equal(withOptions.includes("募集作成者"), false);
  assert.equal(withOptions.includes("owner-id"), false);

  const withoutOptions = formatOteboRecruitmentMessage({
    closingAt: "2026-08-02T03:00:00.000Z",
    duration: "none",
    mentionRoleId: "role-id",
    mentionEnabled: false,
    note: "",
  });
  assert.equal(
    withoutOptions,
    "【雑談募集】\n12:00まで掲載される雑談の募集です。\n下の参加ボタンが押されたら集合メンションが行われます。",
  );
  assert.equal(withoutOptions.endsWith(" "), false);
  assert.equal(withoutOptions.includes("role-id"), false);
});

test("ボタン募集の成立通知と競合文言は固定される", () => {
  assert.equal(
    formatOteboSuccessNotice({ roleId: "role-id", duration: "60", note: "30分だけ @here" }),
    "<@&role-id> 雑談募集が成立しました！VCへの参加お願いします！\n通話時間：1時間\nひとこと：30分だけ @​here",
  );
  assert.equal(
    BUTTON_RECRUITMENT_CONFLICT_MESSAGE,
    "別のボタン募集が掲載されているときは送信できません。現在の募集が終了してから、もう一度お試しください。",
  );
});

test("常設パネルは指定文面・ボタン・通知なしを使う", () => {
  const payload = buildOteboRecruitmentPanelPayload();
  assert.equal(payload.content, OTEBO_PANEL_TEXT);
  assert.equal(
    payload.content,
    "下のボタンから募集を作成すると、募集内容と参加ボタンを含む匿名の募集メッセージが送信されます。\n参加ボタンが押されると、参加者と募集作成者へ招集メンションが送られます。\n成立しなかった募集は自動で削除されます。",
  );
  assert.equal(payload.components[0].components[0].data.custom_id, OTEBO_PANEL_BUTTON_CUSTOM_ID);
  assert.equal(payload.components[0].components[0].data.label, "募集を作成");
  assert.deepEqual(payload.allowedMentions, { parse: [] });
});

function createPanelChannel(messages, events) {
  let nextId = 1;
  return {
    id: "notice",
    type: 0,
    permissionsFor: () => ({ has: () => true }),
    send: async (payload) => {
      events.push({ type: "send", payload });
      const message = {
        id: `panel-${nextId++}`,
        author: { id: "bot" },
        content: payload.content,
        components: payload.components.map((row) => ({ components: row.components.map((component) => component.toJSON()) })),
        delete: async () => { events.push({ type: "delete", id: message.id }); messages.delete(message.id); },
      };
      messages.set(message.id, message);
      return message;
    },
    messages: {
      fetch: async (value) => {
        if (typeof value === "string") return messages.get(value) ?? null;
        return {
          values: () => messages.values(),
          first: () => messages.values().next().value,
        };
      },
    },
  };
}

test("常設パネルはnotice channelだけに保存し、保存後に旧パネルを削除する", async () => {
  const messages = new Map();
  const events = [];
  const channel = createPanelChannel(messages, events);
  let state = { guildId: "guild", channelId: "notice", messageId: "old" };
  const guild = {
    id: "guild",
    client: { user: { id: "bot" } },
    members: { me: {} },
    channels: { fetch: async (channelId) => channelId === "notice" ? channel : null },
  };
  const service = createOteboRecruitmentPanelService({
    getGuildSettings: async () => ({ callWaitPromptChannelId: "prompt", callWaitNoticeChannelId: "notice" }),
    getPanel: async () => state,
    savePanel: async (next) => { events.push({ type: "save" }); state = next; return state; },
    deletePanel: async () => { state = null; },
    acquireLease: async () => ({ lockKey: "panel-lease" }),
    releaseLease: async () => {},
    sendOperationalLog: async () => {},
  });

  messages.set("old", { id: "old", delete: async () => events.push({ type: "delete", id: "old" }) });
  const result = await service.moveOteboRecruitmentPanelToBottom(guild, "test");
  assert.equal(result.status, "moved");
  assert.equal(events[0].type, "send");
  assert.equal(events[1].type, "save");
  assert.equal(events[2].type, "delete");
  assert.equal(events[2].id, "old");
  assert.equal(state.channelId, "notice");
  assert.equal(state.messageId, "panel-1");
  assert.equal(events[0].payload.allowedMentions.parse.length, 0);
});

test("旧募集コマンドと時間指定のお手軽募集オプションは登録されない", () => {
  assert.equal(commands.some((command) => ["b", "bosyu", "sendotebo"].includes(command.name)), false);
  const setting = commands.find((command) => command.name === "setting");
  const settingNames = setting?.options?.map((option) => option.name) ?? [];
  assert.equal(settingNames.includes("bosyu"), false);
  const callwait = setting?.options?.find((option) => option.name === "callwait");
  const callwaitNames = callwait?.options?.map((option) => option.name) ?? [];
  assert.equal(callwaitNames.includes("otebo_preview_channel"), false);
  assert.equal(callwaitNames.includes("bosyu_mention_role"), true);
});

test("常設パネルは送信・保存失敗時に既存状態を保持する", async () => {
  const messages = new Map();
  const events = [];
  const channel = createPanelChannel(messages, events);
  const guild = {
    id: "guild",
    client: { user: { id: "bot" } },
    members: { me: {} },
    channels: { fetch: async () => channel },
  };
  let state = { guildId: "guild", channelId: "notice", messageId: "old" };
  const sendFailure = createOteboRecruitmentPanelService({
    getGuildSettings: async () => ({ callWaitNoticeChannelId: "notice" }),
    getPanel: async () => state,
    acquireLease: async () => ({ lockKey: "panel-lease" }),
    releaseLease: async () => {},
    sendOperationalLog: async () => {},
    logger: { error() {} },
  });
  channel.send = async () => { throw new Error("send denied"); };
  assert.equal((await sendFailure.moveOteboRecruitmentPanelToBottom(guild)).status, "send-failed");
  assert.equal(state.messageId, "old");

  const saveChannel = createPanelChannel(new Map(), events);
  guild.channels.fetch = async () => saveChannel;
  const saveFailure = createOteboRecruitmentPanelService({
    getGuildSettings: async () => ({ callWaitNoticeChannelId: "notice" }),
    getPanel: async () => state,
    savePanel: async () => { throw new Error("database unavailable"); },
    acquireLease: async () => ({ lockKey: "panel-lease" }),
    releaseLease: async () => {},
    sendOperationalLog: async () => {},
    logger: { error() {} },
  });
  assert.equal((await saveFailure.moveOteboRecruitmentPanelToBottom(guild)).status, "save-failed");
  assert.equal(state.messageId, "old");
});

test("常設パネルの削除失敗時は保存状態を保持して復旧対象に残す", async () => {
  const messages = new Map();
  const panel = {
    id: "old",
    author: { id: "bot" },
    content: OTEBO_PANEL_TEXT,
    components: [{ components: [{ customId: OTEBO_PANEL_BUTTON_CUSTOM_ID, label: "募集を作成" }] }],
    delete: async () => { throw new Error("delete denied"); },
  };
  messages.set(panel.id, panel);
  const channel = createPanelChannel(messages, []);
  let state = { guildId: "guild", channelId: "notice", messageId: panel.id };
  const guild = {
    id: "guild",
    client: { user: { id: "bot" } },
    channels: { fetch: async () => channel },
  };
  const service = createOteboRecruitmentPanelService({
    getGuildSettings: async () => ({ callWaitNoticeChannelId: "notice" }),
    getPanel: async () => state,
    deletePanel: async () => { state = null; },
    acquireLease: async () => ({ lockKey: "panel-lease" }),
    releaseLease: async () => {},
    sendOperationalLog: async () => {},
    logger: { error() {} },
  });

  assert.equal((await service.removeOteboRecruitmentPanel(guild)).status, "remove-failed");
  assert.equal(state.messageId, panel.id);
});

test("招集用ロールの置換失敗時は既存保持者を復元する", async () => {
  const roleId = "call-wait-role";
  const roleState = { old: true, first: false, second: false };
  const members = new Map();
  const createMember = (id, { failAdd = false } = {}) => ({
    id,
    user: { bot: false },
    roles: {
      cache: { has: (candidateRoleId) => candidateRoleId === roleId && roleState[id] === true },
      add: async () => {
        if (failAdd) throw new Error(`grant failed for ${id}`);
        roleState[id] = true;
      },
      remove: async () => { roleState[id] = false; },
    },
  });
  members.set("old", createMember("old"));
  members.set("first", createMember("first"));
  members.set("second", createMember("second", { failAdd: true }));
  const role = {
    id: roleId,
    managed: false,
    editable: true,
    members: new Map([["old", members.get("old")]]),
  };
  const guild = {
    id: "guild",
    roles: { fetch: async () => role },
    members: {
      me: { permissions: { has: () => true } },
      cache: members,
      fetch: async (memberId) => (memberId ? members.get(memberId) : members),
    },
  };
  const previousGeneration = {
    generationId: "previous-generation",
    roleId,
    memberIds: ["old"],
    executeAt: new Date(Date.now() + 60_000).toISOString(),
    status: "active",
  };
  let settings = { callWaitRoleGeneration: previousGeneration };
  const generations = new Map();
  const generationModel = {
    create: async (generation) => { generations.set(generation.generationId, { ...generation }); },
    updateOne: async (filter, update) => {
      const generation = generations.get(filter.generationId);
      if (!generation) return null;
      if (update.$set) Object.assign(generation, update.$set);
      if (update.$addToSet?.memberIds && !generation.memberIds.includes(update.$addToSet.memberIds)) generation.memberIds.push(update.$addToSet.memberIds);
      return generation;
    },
    updateMany: async () => ({}),
    findOneAndUpdate: async () => null,
  };
  const roleGrantModel = {
    updateOne: async () => ({}),
    updateMany: async () => ({}),
  };
  const service = createCallWaitRoleService({
    getGuildSettings: async () => settings,
    saveGuildSettings: async (_guildId, patch) => { settings = { ...settings, ...patch }; return settings; },
    generationModel,
    roleGrantModel,
    acquireLease: async () => ({ lockKey: "role-lease" }),
    releaseLease: async () => {},
    logger: { info() {}, error() {} },
  });

  const result = await service.replaceRole({
    guild,
    roleId,
    memberIds: ["first", "second"],
    sourceType: "button",
    sourceId: "recruitment",
    requiredMemberCount: 2,
  });

  assert.equal(result.ok, false);
  assert.equal(roleState.old, true);
  assert.equal(roleState.first, false);
  assert.equal(roleState.second, false);
  assert.equal(settings.callWaitRoleGeneration.generationId, previousGeneration.generationId);
});
