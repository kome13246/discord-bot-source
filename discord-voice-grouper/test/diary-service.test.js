import test from "node:test";
import assert from "node:assert/strict";
import { ChannelType, PermissionFlagsBits } from "discord.js";
import { commands } from "../src/commands.js";
import {
  calculateDiaryDailyQuota,
  createDiaryService,
  diaryJst18At,
  diaryLatestDueSlot,
  formatDiaryAssignmentMessage,
  selectDiaryAssignees,
  DIARY_JOIN_CUSTOM_ID,
  DIARY_LEAVE_CUSTOM_ID,
} from "../src/diary-service.js";

function queryResult(values) {
  let result = [...values];
  return {
    sort(spec = {}) {
      const entries = Object.entries(spec);
      result.sort((left, right) => {
        for (const [key, direction] of entries) {
          const leftValue = new Date(left?.[key] ?? 0).getTime();
          const rightValue = new Date(right?.[key] ?? 0).getTime();
          if (leftValue !== rightValue) return (leftValue - rightValue) * Number(direction);
        }
        return 0;
      });
      return this;
    },
    lean: async () => result,
  };
}

function matchesFilter(row, filter = {}) {
  if (!row) return false;
  if (filter.$or && !filter.$or.some((candidate) => matchesFilter(row, candidate))) return false;
  for (const [key, expected] of Object.entries(filter)) {
    if (key === "$or") continue;
    const actual = row[key];
    if (expected && typeof expected === "object" && !(expected instanceof Date)) {
      if (Object.prototype.hasOwnProperty.call(expected, "$in") && !expected.$in.includes(actual)) return false;
      if (Object.prototype.hasOwnProperty.call(expected, "$lte") && !(new Date(actual).getTime() <= new Date(expected.$lte).getTime())) return false;
      if (Object.prototype.hasOwnProperty.call(expected, "$exists") && (actual !== undefined) !== expected.$exists) return false;
      if (Object.prototype.hasOwnProperty.call(expected, "$exists")) continue;
      if (Object.prototype.hasOwnProperty.call(expected, "$in")) continue;
      if (Object.prototype.hasOwnProperty.call(expected, "$lte")) continue;
    }
    if (!(expected && typeof expected === "object" && !(expected instanceof Date)) && actual !== expected) return false;
  }
  return true;
}

function applyUpdate(row, update, isInsert = false) {
  const setFields = new Set(Object.keys(update.$set ?? {}));
  for (const field of Object.keys(update.$setOnInsert ?? {})) {
    if (setFields.has(field)) throw new Error(`Updating the path '${field}' would create a conflict at '${field}'`);
  }
  if (isInsert) Object.assign(row, update.$setOnInsert ?? {});
  Object.assign(row, update.$set ?? {});
  for (const [key, value] of Object.entries(update.$inc ?? {})) row[key] = (Number(row[key]) || 0) + value;
  for (const key of Object.keys(update.$unset ?? {})) delete row[key];
}

function memoryModel(initial = []) {
  const rows = initial.map((row) => ({ ...row }));
  const model = {
    rows,
    find(filter) { return queryResult(rows.filter((row) => matchesFilter(row, filter))); },
    findOne(filter) { return rows.find((row) => matchesFilter(row, filter)) ?? null; },
    async findOneAndUpdate(filter, update, options = {}) {
      let row = rows.find((candidate) => matchesFilter(candidate, filter));
      if (!row && options.upsert) {
        row = {};
        for (const [key, value] of Object.entries(filter)) if (!key.startsWith("$")) row[key] = value;
        rows.push(row);
        applyUpdate(row, update, true);
      } else if (row) {
        applyUpdate(row, update);
      }
      return row ?? null;
    },
    async create(document) { const row = { ...document }; rows.push(row); return row; },
    async updateOne(filter, update) {
      const row = rows.find((candidate) => matchesFilter(candidate, filter));
      if (!row) return { matchedCount: 0, modifiedCount: 0 };
      applyUpdate(row, update);
      return { matchedCount: 1, modifiedCount: 1 };
    },
    async updateMany(filter, update) {
      const matches = rows.filter((candidate) => matchesFilter(candidate, filter));
      for (const row of matches) applyUpdate(row, update);
      return { matchedCount: matches.length, modifiedCount: matches.length };
    },
    async deleteOne(filter) {
      const index = rows.findIndex((candidate) => matchesFilter(candidate, filter));
      if (index < 0) return { deletedCount: 0 };
      rows.splice(index, 1);
      return { deletedCount: 1 };
    },
    async countDocuments(filter) { return rows.filter((row) => matchesFilter(row, filter)).length; },
  };
  return model;
}

function diaryGuild({ channels = [], roles = [], members = [] } = {}) {
  const bot = { id: "bot", user: { id: "bot", bot: true }, permissions: { has: () => true } };
  const guild = {
    id: "g1",
    name: "テストサーバー",
    channels: { cache: new Map(channels.map((channel) => [channel.id, channel])), fetch: async (id) => channels.find((channel) => channel.id === id) ?? null },
    roles: { cache: new Map(roles.map((role) => [role.id, role])), fetch: async (id) => roles.find((role) => role.id === id) ?? null },
    members: { cache: new Map([[bot.id, bot], ...members.map((member) => [member.id, member])]), me: bot },
  };
  bot.guild = guild;
  for (const member of members) member.guild = guild;
  return guild;
}

function diaryChannel(id, { send, messages } = {}) {
  const storedMessages = messages ?? new Map();
  return {
    id,
    type: ChannelType.GuildText,
    send: send ?? (async (payload) => {
      const message = { id: `${id}-${storedMessages.size + 1}`, author: { id: "bot", bot: true }, payload, delete: async () => storedMessages.delete(message.id) };
      storedMessages.set(message.id, message);
      return message;
    }),
    messages: { fetch: async (value) => (typeof value === "string" ? storedMessages.get(value) ?? null : queryResult([...storedMessages.values()])) },
  };
}

test("交換日記の均等化 quota は指定例を満たす", () => {
  assert.deepEqual(
    Array.from({ length: 5 }, (_, dayIndex) => calculateDiaryDailyQuota({ participantCount: 3, dayIndex })),
    [1, 0, 1, 0, 1],
  );
  assert.deepEqual(
    Array.from({ length: 5 }, (_, dayIndex) => calculateDiaryDailyQuota({ participantCount: 4, dayIndex })),
    [1, 1, 0, 1, 1],
  );
  assert.deepEqual(
    Array.from({ length: 5 }, (_, dayIndex) => calculateDiaryDailyQuota({ participantCount: 8, maxDaily: 2, dayIndex })),
    [2, 1, 2, 1, 2],
  );
  assert.deepEqual(
    Array.from({ length: 5 }, (_, dayIndex) => calculateDiaryDailyQuota({ participantCount: 5, dayIndex })),
    [1, 1, 1, 1, 1],
  );
});

test("最低再指名間隔は9/5を拒否し、9/6から許可する", () => {
  const lastAssignedAt = diaryJst18At("2026-09-01T12:00:00.000Z");
  const beforeMinimum = selectDiaryAssignees({
    slotAt: diaryJst18At("2026-09-05T12:00:00.000Z"),
    minIntervalDays: 5,
    quota: 1,
    participants: [{ userId: "u1", joinedAt: "2026-08-01T00:00:00.000Z", lastAssignedAt }],
  });
  const atMinimum = selectDiaryAssignees({
    slotAt: diaryJst18At("2026-09-06T12:00:00.000Z"),
    minIntervalDays: 5,
    quota: 1,
    participants: [{ userId: "u1", joinedAt: "2026-08-01T00:00:00.000Z", lastAssignedAt }],
  });
  assert.equal(beforeMinimum.length, 0);
  assert.deepEqual(atMinimum.map((participant) => participant.userId), ["u1"]);
});

test("初回参加者を優先し、最低再指名間隔を破らない", () => {
  const slotAt = diaryJst18At("2026-09-10T09:00:00.000Z");
  const selected = selectDiaryAssignees({
    slotAt,
    maxDaily: 2,
    minIntervalDays: 5,
    quota: 2,
    participants: [
      { userId: "old", joinedAt: "2026-09-01T00:00:00.000Z", lastAssignedAt: "2026-09-06T09:00:00.000Z" },
      { userId: "first-old", joinedAt: "2026-09-01T00:00:00.000Z", lastAssignedAt: null },
      { userId: "first-new", joinedAt: "2026-09-02T00:00:00.000Z", lastAssignedAt: null },
    ],
  });
  assert.deepEqual(selected.map((item) => item.userId), ["first-old", "first-new"]);
  const tooSoon = selectDiaryAssignees({
    slotAt,
    maxDaily: 1,
    minIntervalDays: 5,
    quota: 1,
    participants: [{ userId: "too-soon", joinedAt: "2026-09-01T00:00:00.000Z", lastAssignedAt: "2026-09-06T08:59:59.000Z" }],
  });
  assert.equal(tooSoon.length, 0);
});

test("1名の指名確保でMongoDBの更新パス競合を起こさず、同じ日には再送しない", async () => {
  const at = new Date("2026-09-21T09:00:00.000Z");
  const sent = [];
  const channel = diaryChannel("diary", { send: async (payload) => {
    sent.push(payload);
    return { id: `diary-message-${sent.length}` };
  } });
  const guild = diaryGuild({ channels: [channel] });
  const settings = { guildId: guild.id, diaryEnabled: true, diaryChannelId: channel.id, diaryMaxDaily: 1, diaryMinIntervalDays: 5 };
  const assignments = memoryModel();
  const service = createDiaryService({
    getGuildSettings: async () => settings,
    saveRuntimeGuildSettings: async (_guildId, patch) => Object.assign(settings, patch),
    participantModel: memoryModel([{ guildId: guild.id, userId: "u1", joinedAt: new Date("2026-09-01T00:00:00.000Z"), lastAssignedAt: null }]),
    assignmentModel: assignments,
    dailyRunModel: memoryModel(),
    sendOperationalLog: async () => {},
  });

  const first = await service.processGuild(guild, { at });
  const second = await service.processGuild(guild, { at });
  assert.equal(first.status, "assigned");
  assert.equal(first.assigned, 1);
  assert.equal(second.status, "already-processed");
  assert.equal(sent.length, 1);
  assert.equal(assignments.rows[0].guildId, guild.id);
  assert.equal(assignments.rows[0].sendState, "sent");
});

test("手動指名コマンドは管理者のみ実行でき、今日の指名を重複させない", async () => {
  const command = commands.find((item) => item.name === "senddiary");
  assert.equal(command?.default_member_permissions, PermissionFlagsBits.ManageGuild.toString());
  const at = new Date("2026-09-21T09:00:00.000Z");
  const sent = [];
  const channel = diaryChannel("diary", { send: async (payload) => {
    sent.push(payload);
    return { id: `diary-message-${sent.length}` };
  } });
  const guild = diaryGuild({ channels: [channel] });
  const settings = { guildId: guild.id, diaryEnabled: true, diaryChannelId: channel.id, diaryMaxDaily: 1, diaryMinIntervalDays: 5 };
  const service = createDiaryService({
    getGuildSettings: async () => settings,
    saveRuntimeGuildSettings: async (_guildId, patch) => Object.assign(settings, patch),
    participantModel: memoryModel([{ guildId: guild.id, userId: "u1", joinedAt: new Date("2026-09-01T00:00:00.000Z"), lastAssignedAt: null }]),
    assignmentModel: memoryModel(),
    dailyRunModel: memoryModel(),
    sendOperationalLog: async () => {},
    now: () => at,
  });
  function interaction(authorized) {
    return {
      guild, guildId: guild.id, inGuild: () => true,
      memberPermissions: { has: (permission) => authorized && permission === PermissionFlagsBits.ManageGuild },
      reply: async function reply(payload) { this.response = payload; },
      deferReply: async function deferReply(payload) { this.deferredPayload = payload; },
      editReply: async function editReply(payload) { this.response = payload; },
    };
  }

  const denied = interaction(false);
  await service.handleManualAssignment(denied);
  assert.match(denied.response.content, /管理権限/);
  assert.equal(sent.length, 0);

  const first = interaction(true);
  await service.handleManualAssignment(first);
  assert.match(first.response.content, /指名人数: 1人/);
  assert.equal(sent.length, 1);

  const second = interaction(true);
  await service.handleManualAssignment(second);
  assert.match(second.response.content, /重複指名は行いません/);
  assert.equal(sent.length, 1);
});

test("再参加者は旧セッションの送信履歴を引き継がず初回候補として選ばれる", async () => {
  const slotAt = diaryJst18At("2026-09-21T09:00:00.000Z");
  const channel = diaryChannel("diary");
  const oldAssignmentAt = new Date("2026-09-10T09:00:00.000Z");
  const participants = memoryModel([
    {
      guildId: "g1",
      userId: "rejoined",
      joinedAt: new Date("2026-09-20T00:00:00.000Z"),
      lastAssignedAt: null,
      consecutiveMisses: 0,
    },
    {
      guildId: "g1",
      userId: "recent",
      joinedAt: new Date("2026-09-01T00:00:00.000Z"),
      lastAssignedAt: new Date("2026-09-20T09:00:00.000Z"),
      consecutiveMisses: 0,
    },
  ]);
  const assignments = memoryModel([{
    guildId: "g1",
    assignmentId: "old-session",
    slotKey: "2026-09-10",
    userId: "rejoined",
    assignedAt: oldAssignmentAt,
    nominalAt: oldAssignmentAt,
    status: "completed",
    sendState: "sent",
  }]);
  const dailyRuns = memoryModel();
  const settings = {
    guildId: "g1",
    diaryEnabled: true,
    diaryChannelId: channel.id,
    diaryMaxDaily: 1,
    diaryMinIntervalDays: 5,
    diaryLastRunSlot: null,
    diaryPaceState: null,
  };
  const guild = diaryGuild({ channels: [channel] });
  const service = createDiaryService({
    client: { guilds: { cache: new Map([[guild.id, guild]]) } },
    getGuildSettings: async () => settings,
    saveRuntimeGuildSettings: async (_guildId, patch) => Object.assign(settings, patch),
    participantModel: participants,
    assignmentModel: assignments,
    dailyRunModel: dailyRuns,
    sendOperationalLog: async () => {},
  });

  const result = await service.processGuild(guild, { at: slotAt });
  assert.equal(result.status, "assigned");
  assert.equal(result.assigned, 1);
  const currentAssignment = assignments.rows.find((assignment) => assignment.slotKey === "2026-09-21");
  assert.equal(currentAssignment?.userId, "rejoined");
  assert.equal(participants.rows.find((participant) => participant.userId === "rejoined").lastAssignedAt.toISOString(), slotAt.toISOString());
});

test("3人運用中の4人目・5人目追加は未来密度を作り直し、新人を優先して追いつき指名しない", async () => {
  const channel = diaryChannel("pace-diary");
  const participants = memoryModel([
    { guildId: "g1", userId: "u1", joinedAt: new Date("2026-09-01T00:00:00.000Z"), lastAssignedAt: null, consecutiveMisses: 0 },
    { guildId: "g1", userId: "u2", joinedAt: new Date("2026-09-02T00:00:00.000Z"), lastAssignedAt: new Date("2026-09-10T09:00:00.000Z"), consecutiveMisses: 0 },
    { guildId: "g1", userId: "u3", joinedAt: new Date("2026-09-03T00:00:00.000Z"), lastAssignedAt: new Date("2026-09-11T09:00:00.000Z"), consecutiveMisses: 0 },
  ]);
  const assignments = memoryModel();
  const dailyRuns = memoryModel();
  const settings = {
    guildId: "g1",
    diaryEnabled: true,
    diaryChannelId: channel.id,
    diaryMaxDaily: 1,
    diaryMinIntervalDays: 5,
    diaryLastRunSlot: null,
    diaryPaceState: null,
  };
  const guild = diaryGuild({ channels: [channel] });
  const service = createDiaryService({
    client: { guilds: { cache: new Map([[guild.id, guild]]) } },
    getGuildSettings: async () => settings,
    saveRuntimeGuildSettings: async (_guildId, patch) => Object.assign(settings, patch),
    participantModel: participants,
    assignmentModel: assignments,
    dailyRunModel: dailyRuns,
    sendOperationalLog: async () => {},
  });
  // The first 3-person period starts with one assignment.
  await service.processGuild(guild, { at: new Date("2026-09-21T09:00:00.000Z") });
  assert.equal(assignments.rows.find((row) => row.slotKey === "2026-09-21")?.userId, "u1");
  const u1AssignedAt = participants.rows.find((row) => row.userId === "u1").lastAssignedAt;

  // Day 2 of the 3/5 period is intentionally empty, not a catch-up send.
  await service.processGuild(guild, { at: new Date("2026-09-22T09:00:00.000Z") });
  assert.equal(assignments.rows.filter((row) => row.slotKey === "2026-09-22").length, 0);
  participants.rows.push({ guildId: "g1", userId: "u4", joinedAt: new Date("2026-09-22T10:00:00.000Z"), lastAssignedAt: null, consecutiveMisses: 0 });

  // Adding u4 resets the future pace, but selects the newcomer first.
  await service.processGuild(guild, { at: new Date("2026-09-23T09:00:00.000Z") });
  assert.equal(assignments.rows.find((row) => row.slotKey === "2026-09-23")?.userId, "u4");
  assert.equal(participants.rows.find((row) => row.userId === "u1").lastAssignedAt.toISOString(), u1AssignedAt.toISOString());
  participants.rows.push({ guildId: "g1", userId: "u5", joinedAt: new Date("2026-09-23T10:00:00.000Z"), lastAssignedAt: null, consecutiveMisses: 0 });

  // The next participant-count change again restarts the future density; it
  // does not emit additional assignments for old slots.
  await service.processGuild(guild, { at: new Date("2026-09-24T09:00:00.000Z") });
  assert.equal(assignments.rows.find((row) => row.slotKey === "2026-09-24")?.userId, "u5");
  assert.equal(assignments.rows.filter((row) => row.slotKey === "2026-09-22").length, 0);
});

test("JST 18:00 slot and delayed 18-hour warning are stable", () => {
  const at18 = new Date("2026-09-21T09:00:00.000Z");
  assert.equal(diaryJst18At(at18).toISOString(), at18.toISOString());
  assert.equal(diaryLatestDueSlot(new Date("2026-09-21T08:59:59.000Z")).slotKey, "2026-09-20");
  assert.equal(diaryLatestDueSlot(at18).slotKey, "2026-09-21");
  const text = formatDiaryAssignmentMessage(["123"], new Date("2026-09-21T09:00:00.000Z"), { now: new Date("2026-09-20T19:00:00.000Z"), specialNoPenalty: true });
  assert.match(text, /期限：今日18:00まで/);
  assert.match(text, /今回は投稿できなかった場合でも、連続未投稿回数には加算されません/);
});

test("無効化中は期限判定・未投稿加算を行わず進行中回をキャンセルする", async () => {
  const assignment = { guildId: "g1", assignmentId: "a1", userId: "u1", status: "active", deadlineAt: new Date("2026-09-20T09:00:00.000Z"), specialNoPenalty: false };
  const canceled = [];
  const assignmentModel = {
    find: () => [assignment],
    updateMany: async (filter, update) => {
      canceled.push({ filter, update });
      assignment.status = "canceled";
      return { modifiedCount: 1 };
    },
    updateOne: async () => { throw new Error("期限判定は無効中に実行してはいけない"); },
  };
  const participantModel = {
    find: () => [{ guildId: "g1", userId: "u1", consecutiveMisses: 2 }],
    countDocuments: async () => 1,
  };
  const service = createDiaryService({
    client: { guilds: { cache: new Map() } },
    getGuildSettings: async () => ({ guildId: "g1", diaryEnabled: false }),
    assignmentModel,
    participantModel,
    saveGuildSettings: async () => {},
  });
  const result = await service.processGuild({ id: "g1" }, { at: new Date("2026-09-21T10:00:00.000Z") });
  assert.equal(result.status, "disabled");
  assert.equal(canceled.length, 1);
  assert.equal(canceled[0].filter.status, "active");
});

test("投稿判定CHを取得できない場合は安全に保留し、未投稿回数を増やさない", async () => {
  const assignments = memoryModel([{ guildId: "g1", assignmentId: "a1", userId: "u1", status: "active", sendState: "sent", deadlineAt: new Date("2026-09-20T09:00:00.000Z") }]);
  const participants = memoryModel([{ guildId: "g1", userId: "u1", consecutiveMisses: 1 }]);
  const guild = diaryGuild();
  const service = createDiaryService({
    client: { guilds: { cache: new Map([[guild.id, guild]]) } },
    getGuildSettings: async () => ({ guildId: guild.id, diaryEnabled: true, diaryChannelId: "missing", diaryLastRunSlot: "2026-09-20" }),
    assignmentModel: assignments,
    participantModel: participants,
    dailyRunModel: {},
    sendOperationalLog: async () => {},
  });
  await service.processGuild(guild, { at: new Date("2026-09-21T09:00:00.000Z") });
  assert.equal(assignments.rows[0].status, "active");
  assert.equal(participants.rows[0].consecutiveMisses, 1);
});

test("参加・重複参加・離脱・未参加離脱・再参加を扱い、無効中も離脱だけ許可する", async () => {
  const events = [];
  const roleMembers = new Map();
  const participant = memoryModel();
  const assignments = memoryModel();
  let enabled = true;
  const role = { id: "diary-role", managed: false, editable: true, members: roleMembers };
  const member = {
    id: "u1",
    user: { id: "u1", bot: false },
    roles: {
      add: async () => { roleMembers.set("u1", member); events.push("role-add"); },
      remove: async () => { roleMembers.delete("u1"); events.push("role-remove"); },
    },
  };
  const guild = diaryGuild({ roles: [role], members: [member] });
  const service = createDiaryService({
    client: { guilds: { cache: new Map([[guild.id, guild]]) } },
    getGuildSettings: async () => ({ guildId: guild.id, diaryEnabled: enabled, diaryParticipantRoleId: role.id }),
    participantModel: participant,
    assignmentModel: assignments,
    sendOperationalLog: async ({ content }) => events.push(content),
    requestOperationalStatusRefresh: async () => events.push("status"),
    now: () => new Date("2026-09-21T08:50:00.000Z"),
  });
  const interaction = (customId) => {
    const response = { customId, guild, guildId: guild.id, user: { id: "u1" }, member, deferred: false, replied: false };
    response.deferReply = async () => { response.deferred = true; };
    response.editReply = async (payload) => { response.reply = payload; };
    return response;
  };

  const firstJoin = interaction(DIARY_JOIN_CUSTOM_ID);
  await service.handleButton(firstJoin);
  assert.equal(firstJoin.reply.content, "交換日記に参加しました！\n\nこれから定期的に日記担当として指名されます。\n指名されたら、翌日の18:00までに交換日記チャンネルへ何か投稿してください！");
  assert.equal(participant.rows.length, 1);
  const joinedAt = participant.rows[0].joinedAt;

  const duplicate = interaction(DIARY_JOIN_CUSTOM_ID);
  await service.handleButton(duplicate);
  assert.equal(duplicate.reply.content, "すでに交換日記に参加しています！");
  assert.equal(participant.rows.length, 1);

  enabled = false;
  const disabledJoin = interaction(DIARY_JOIN_CUSTOM_ID);
  await service.handleButton(disabledJoin);
  assert.equal(disabledJoin.reply.content, "現在、交換日記機能は停止中です。");
  const leave = interaction(DIARY_LEAVE_CUSTOM_ID);
  await service.handleButton(leave);
  assert.equal(leave.reply.content, "交換日記から離脱しました。\n\nまた参加したくなった場合は、いつでも「参加する」ボタンから再参加できます！");
  assert.equal(participant.rows.length, 0);
  assert.equal(roleMembers.size, 0);

  const notParticipantLeave = interaction(DIARY_LEAVE_CUSTOM_ID);
  await service.handleButton(notParticipantLeave);
  assert.equal(notParticipantLeave.reply.content, "現在、交換日記には参加していません。");

  enabled = true;
  const rejoin = interaction(DIARY_JOIN_CUSTOM_ID);
  await service.handleButton(rejoin);
  assert.equal(participant.rows.length, 1);
  assert.equal(participant.rows[0].consecutiveMisses, 0);
  assert.notEqual(participant.rows[0].joinedAt, joinedAt);
  assert.ok(events.includes("role-add"));
});

test("参加時刻の境界と投稿判定は担当者だけを対象にし、投稿後削除でも達成を戻さない", async () => {
  const slot = diaryJst18At("2026-09-21T09:00:00.000Z");
  assert.equal(selectDiaryAssignees({
    slotAt: slot,
    quota: 1,
    participants: [{ userId: "before", joinedAt: "2026-09-21T08:50:00.000Z" }],
  }).length, 1);
  assert.equal(selectDiaryAssignees({
    slotAt: slot,
    quota: 1,
    participants: [{ userId: "after", joinedAt: "2026-09-21T09:10:00.000Z" }],
  }).length, 0);

  const assignment = {
    guildId: "g1", assignmentId: "g1:2026-09-21:u1", slotKey: "2026-09-21", userId: "u1",
    assignedAt: new Date("2026-09-21T09:00:00.000Z"), nominalAt: slot, deadlineAt: new Date("2026-09-22T09:00:00.000Z"),
    status: "active", sendState: "sent", specialNoPenalty: false,
  };
  const assignments = memoryModel([assignment]);
  const participants = memoryModel([{ guildId: "g1", userId: "u1", consecutiveMisses: 2, joinedAt: new Date("2026-09-01T00:00:00.000Z") }, { guildId: "g1", userId: "u2", consecutiveMisses: 0 }]);
  const channel = diaryChannel("diary");
  const guild = diaryGuild({ channels: [channel] });
  const service = createDiaryService({
    client: { guilds: { cache: new Map([[guild.id, guild]]) } },
    getGuildSettings: async () => ({ diaryEnabled: true, diaryChannelId: channel.id }),
    assignmentModel: assignments,
    participantModel: participants,
    sendOperationalLog: async () => {},
  });
  await service.handleMessage({ guild, channelId: channel.id, author: { id: "u1", bot: false }, createdTimestamp: Date.parse("2026-09-21T10:00:00.000Z"), attachments: new Map() });
  assert.equal(assignments.rows[0].status, "completed");
  assert.equal(participants.rows.find((row) => row.userId === "u1").consecutiveMisses, 0);
  await service.handleMessage({ guild, channelId: channel.id, author: { id: "u2", bot: false }, createdTimestamp: Date.parse("2026-09-21T10:01:00.000Z") });
  assert.equal(participants.rows.find((row) => row.userId === "u2").consecutiveMisses, 0);
  await service.handleMessage({ guild, channelId: channel.id, author: { id: "u1", bot: false }, createdTimestamp: Date.parse("2026-09-21T10:02:00.000Z") });
  assert.equal(assignments.rows[0].status, "completed");
  await service.handleMessage({ guild, channelId: channel.id, author: { id: "bot", bot: true }, createdTimestamp: Date.parse("2026-09-21T10:03:00.000Z") });
  assert.equal(assignments.rows[0].status, "completed");
});

test("達成assignmentを先に保存し、投稿履歴が消えても保留中のカウンタを復旧する", async () => {
  const channel = diaryChannel("durable-diary");
  const assignment = {
    guildId: "g1",
    assignmentId: "durable-success",
    slotKey: "2026-09-21",
    userId: "u1",
    assignedAt: new Date("2026-09-21T09:00:00.000Z"),
    nominalAt: new Date("2026-09-21T09:00:00.000Z"),
    deadlineAt: new Date("2026-09-22T09:00:00.000Z"),
    status: "active",
    sendState: "sent",
  };
  const assignments = memoryModel([assignment]);
  const participants = memoryModel([{
    guildId: "g1",
    userId: "u1",
    joinedAt: new Date("2026-09-01T00:00:00.000Z"),
    consecutiveMisses: 2,
  }]);
  const originalUpdate = participants.updateOne.bind(participants);
  let failProjection = true;
  participants.updateOne = async (filter, update) => {
    if (failProjection && update.$set?.lastDiaryOutcomeAssignmentId === assignment.assignmentId) {
      failProjection = false;
      throw new Error("counter write unavailable");
    }
    return originalUpdate(filter, update);
  };
  const guild = diaryGuild({ channels: [channel] });
  const service = createDiaryService({
    client: { guilds: { cache: new Map([[guild.id, guild]]) } },
    getGuildSettings: async () => ({ guildId: guild.id, diaryEnabled: true, diaryChannelId: channel.id, diaryLastRunSlot: "2026-09-22" }),
    assignmentModel: assignments,
    participantModel: participants,
    dailyRunModel: {},
    sendOperationalLog: async () => {},
  });
  await service.handleMessage({
    guild,
    channelId: channel.id,
    author: { id: "u1", bot: false },
    createdTimestamp: Date.parse("2026-09-21T10:00:00.000Z"),
  });
  assert.equal(assignments.rows[0].status, "completed");
  assert.equal(assignments.rows[0].completionState, "pending");
  assert.equal(participants.rows[0].consecutiveMisses, 2);
  // The public message is no longer in history; the durable completed row is
  // nevertheless enough for the worker to retry the failed projection.
  await service.processGuild(guild, { at: new Date("2026-09-22T10:00:00.000Z") });
  assert.equal(assignments.rows[0].completionState, "applied");
  assert.equal(participants.rows[0].consecutiveMisses, 0);
});

test("投稿内容は本文以外のメッセージ形式も達成扱いにし、リアクションだけは対象外", async () => {
  const forms = [
    { content: "短文" },
    { attachments: new Map([["file", {}]]) },
    { reference: { messageId: "prior" }, content: "返信" },
    { content: "https://example.test/diary" },
  ];
  for (const [index, form] of forms.entries()) {
    const channel = diaryChannel(`diary-${index}`);
    const assignments = memoryModel([{ guildId: "g1", assignmentId: `a-${index}`, userId: "u1", status: "active", sendState: "sent", assignedAt: new Date("2026-09-20T09:00:00.000Z"), deadlineAt: new Date("2026-09-22T09:00:00.000Z") }]);
    const participants = memoryModel([{ guildId: "g1", userId: "u1", joinedAt: new Date("2026-09-01T00:00:00.000Z"), consecutiveMisses: 1 }]);
    const guild = diaryGuild({ channels: [channel] });
    const service = createDiaryService({
      assignmentModel: assignments,
      participantModel: participants,
      getGuildSettings: async () => ({ diaryEnabled: true, diaryChannelId: channel.id }),
      sendOperationalLog: async () => {},
    });
    await service.handleMessage({ guild, channelId: channel.id, author: { id: "u1", bot: false }, createdTimestamp: Date.parse("2026-09-21T09:00:00.000Z"), ...form });
    assert.equal(assignments.rows[0].status, "completed");
    assert.equal(participants.rows[0].consecutiveMisses, 0);
  }
  const reactionOnlyAssignment = { guildId: "g1", assignmentId: "reaction-only", userId: "u1", status: "active", sendState: "sent" };
  assert.equal(reactionOnlyAssignment.status, "active");
});

test("受付パネルは新規送信・DB保存・旧削除の順で確定し、保存失敗時は新規メッセージを戻す", async () => {
  const events = [];
  const oldMessages = new Map();
  const newMessages = new Map();
  const oldMessage = { id: "old", delete: async () => { events.push("delete-old"); oldMessages.delete("old"); } };
  oldMessages.set(oldMessage.id, oldMessage);
  const oldChannel = diaryChannel("old-channel", { messages: oldMessages });
  const newChannel = diaryChannel("new-channel", { messages: newMessages });
  const originalSend = newChannel.send;
  newChannel.send = async (payload) => { events.push("send"); return originalSend(payload); };
  const guild = diaryGuild({ channels: [oldChannel, newChannel] });
  const state = { guildId: guild.id, channelId: oldChannel.id, messageId: oldMessage.id };
  const panelModel = {
    findOne: () => state,
    findOneAndUpdate: async (_filter, update) => { events.push("save"); Object.assign(state, update.$set); return state; },
  };
  const service = createDiaryService({ panelModel, sendOperationalLog: async () => {} });
  const result = await service.ensurePanel(guild, { diaryReceptionChannelId: newChannel.id });
  assert.equal(result.status, "applied");
  assert.deepEqual(events.slice(0, 3), ["send", "save", "delete-old"]);
  assert.equal(newMessages.size, 1);

  const rollbackEvents = [];
  const rollbackMessages = new Map();
  const rollbackChannel = diaryChannel("rollback", { messages: rollbackMessages });
  const rollbackSend = rollbackChannel.send;
  rollbackChannel.send = async (payload) => { rollbackEvents.push("send"); return rollbackSend(payload); };
  const rollbackGuild = diaryGuild({ channels: [oldChannel, rollbackChannel] });
  const rollbackState = { guildId: rollbackGuild.id, channelId: oldChannel.id, messageId: oldMessage.id };
  const rollbackPanel = {
    findOne: () => rollbackState,
    findOneAndUpdate: async () => { rollbackEvents.push("save"); throw new Error("db unavailable"); },
  };
  const rollbackService = createDiaryService({ panelModel: rollbackPanel, sendOperationalLog: async () => {} });
  await assert.rejects(() => rollbackService.ensurePanel(rollbackGuild, { diaryReceptionChannelId: rollbackChannel.id }));
  assert.deepEqual(rollbackEvents, ["send", "save"]);
  assert.equal(rollbackMessages.size, 0);
  assert.equal(rollbackState.messageId, oldMessage.id);
});

test("復旧履歴は古いページまで遡ってBot/Webhookを除外し、送信前行を期限判定しない", async () => {
  const assignedAt = Date.parse("2026-09-21T09:00:00.000Z");
  const deadline = Date.parse("2026-09-22T09:00:00.000Z");
  const assignment = { guildId: "g1", assignmentId: "a1", slotKey: "2026-09-21", userId: "u1", assignedAt: new Date(assignedAt), nominalAt: new Date(assignedAt), deadlineAt: new Date(deadline), status: "active", sendState: "sent", specialNoPenalty: false };
  const pending = { ...assignment, assignmentId: "a2", userId: "u2", sendState: "pending" };
  const assignments = memoryModel([assignment, pending]);
  const participants = memoryModel([{ guildId: "g1", userId: "u1", consecutiveMisses: 0 }, { guildId: "g1", userId: "u2", consecutiveMisses: 0 }]);
  const pageOne = new Map([
    ["new", { id: "new", createdTimestamp: Date.parse("2026-09-22T08:00:00.000Z"), author: { id: "someone", bot: false } }],
    ["bot", { id: "bot", createdTimestamp: Date.parse("2026-09-22T07:00:00.000Z"), author: { id: "u1", bot: true } }],
  ]);
  const pageTwo = new Map([
    ["old", { id: "old", createdTimestamp: Date.parse("2026-09-21T10:00:00.000Z"), author: { id: "u1", bot: false } }],
    ["webhook", { id: "webhook", createdTimestamp: Date.parse("2026-09-21T11:00:00.000Z"), author: { id: "u1", bot: false }, webhookId: "hook" }],
  ]);
  const history = diaryChannel("diary");
  let page = 0;
  history.messages.fetch = async (options) => {
    if (typeof options === "string") return null;
    page += 1;
    return page === 1 ? pageOne : pageTwo;
  };
  const guild = diaryGuild({ channels: [history] });
  const service = createDiaryService({
    client: { guilds: { cache: new Map([[guild.id, guild]]) } },
    getGuildSettings: async () => ({ diaryEnabled: true, diaryChannelId: history.id, diaryLastRunSlot: "2026-09-22" }),
    assignmentModel: assignments,
    participantModel: participants,
    dailyRunModel: {},
    sendOperationalLog: async () => {},
  });
  await service.processGuild(guild, { at: new Date("2026-09-22T09:00:00.000Z") });
  assert.equal(assignments.rows.find((row) => row.assignmentId === "a1").status, "completed");
  assert.equal(assignments.rows.find((row) => row.assignmentId === "a2").status, "active");
  assert.ok(page >= 2);
});

test("履歴の途中ページ取得失敗は未投稿確定せず、進行中回を保留する", async () => {
  const assignedAt = Date.parse("2026-09-21T09:00:00.000Z");
  const deadline = Date.parse("2026-09-22T09:00:00.000Z");
  const assignment = {
    guildId: "g1",
    assignmentId: "history-partial",
    slotKey: "2026-09-21",
    userId: "u1",
    channelId: "diary",
    assignedAt: new Date(assignedAt),
    nominalAt: new Date(assignedAt),
    deadlineAt: new Date(deadline),
    status: "active",
    sendState: "sent",
    specialNoPenalty: false,
  };
  const assignments = memoryModel([assignment]);
  const participants = memoryModel([{ guildId: "g1", userId: "u1", joinedAt: new Date("2026-09-01T00:00:00.000Z"), consecutiveMisses: 2 }]);
  const pageOne = new Map(Array.from({ length: 100 }, (_, index) => {
    const id = `history-page-one-${index}`;
    return [id, {
      id,
      createdTimestamp: deadline - 60 * 60 * 1_000 - index * 1_000,
      author: { id: "someone-else", bot: false },
    }];
  }));
  let fetchCalls = 0;
  const channel = diaryChannel("diary");
  channel.messages.fetch = async (options) => {
    fetchCalls += 1;
    if (fetchCalls === 1) return pageOne;
    // The old implementation retried this failure without a cursor and then
    // treated the repeated latest page as a confirmed absence.
    if (options?.before) throw new Error("history page unavailable");
    return pageOne;
  };
  const guild = diaryGuild({ channels: [channel] });
  const service = createDiaryService({
    client: { guilds: { cache: new Map([[guild.id, guild]]) } },
    getGuildSettings: async () => ({ guildId: guild.id, diaryEnabled: true, diaryChannelId: channel.id, diaryLastRunSlot: "2026-09-22" }),
    assignmentModel: assignments,
    participantModel: participants,
    dailyRunModel: {},
    sendOperationalLog: async () => {},
  });

  await service.processGuild(guild, { at: new Date(deadline) });

  assert.equal(fetchCalls, 2);
  assert.equal(assignments.rows[0].status, "active");
  assert.equal(participants.rows[0].consecutiveMisses, 2);
});

test("履歴走査が50ページ上限に達した場合は未投稿確定せず保留する", async () => {
  const assignedAt = Date.parse("2026-09-01T09:00:00.000Z");
  const deadline = Date.parse("2026-09-22T09:00:00.000Z");
  const assignment = {
    guildId: "g1",
    assignmentId: "history-page-cap",
    slotKey: "2026-09-21",
    userId: "u1",
    channelId: "diary",
    assignedAt: new Date(assignedAt),
    nominalAt: new Date(assignedAt),
    deadlineAt: new Date(deadline),
    status: "active",
    sendState: "sent",
    specialNoPenalty: false,
  };
  const assignments = memoryModel([assignment]);
  const participants = memoryModel([{ guildId: "g1", userId: "u1", joinedAt: new Date("2026-08-01T00:00:00.000Z"), consecutiveMisses: 1 }]);
  let fetchCalls = 0;
  const channel = diaryChannel("diary");
  channel.messages.fetch = async () => {
    const page = fetchCalls;
    fetchCalls += 1;
    return new Map(Array.from({ length: 100 }, (_, index) => {
      const id = `history-page-${page}-${index}`;
      return [id, {
        id,
        createdTimestamp: deadline - 60 * 60 * 1_000 - (page * 100 + index) * 1_000,
        author: { id: "someone-else", bot: false },
      }];
    }));
  };
  const guild = diaryGuild({ channels: [channel] });
  const service = createDiaryService({
    client: { guilds: { cache: new Map([[guild.id, guild]]) } },
    getGuildSettings: async () => ({ guildId: guild.id, diaryEnabled: true, diaryChannelId: channel.id, diaryLastRunSlot: "2026-09-22" }),
    assignmentModel: assignments,
    participantModel: participants,
    dailyRunModel: {},
    sendOperationalLog: async () => {},
  });

  await service.processGuild(guild, { at: new Date(deadline) });

  assert.equal(fetchCalls, 50);
  assert.equal(assignments.rows[0].status, "active");
  assert.equal(participants.rows[0].consecutiveMisses, 1);
});

test("進行中回の投稿受付は設定変更後もassignment保存先だけを受け付ける", async () => {
  const oldChannel = diaryChannel("old-diary");
  const newChannel = diaryChannel("new-diary");
  const assignedAt = Date.parse("2026-09-21T09:00:00.000Z");
  const assignment = {
    guildId: "g1",
    assignmentId: "channel-change-live",
    slotKey: "2026-09-21",
    userId: "u1",
    channelId: oldChannel.id,
    assignedAt: new Date(assignedAt),
    nominalAt: new Date(assignedAt),
    deadlineAt: new Date("2026-09-22T09:00:00.000Z"),
    status: "active",
    sendState: "sent",
    specialNoPenalty: false,
  };
  const assignments = memoryModel([assignment]);
  const participants = memoryModel([{ guildId: "g1", userId: "u1", joinedAt: new Date("2026-09-01T00:00:00.000Z"), consecutiveMisses: 2 }]);
  const guild = diaryGuild({ channels: [oldChannel, newChannel] });
  const service = createDiaryService({
    getGuildSettings: async () => ({ guildId: guild.id, diaryEnabled: true, diaryChannelId: newChannel.id }),
    assignmentModel: assignments,
    participantModel: participants,
    sendOperationalLog: async () => {},
  });

  await service.handleMessage({ guild, channelId: newChannel.id, author: { id: "u1", bot: false }, createdTimestamp: Date.parse("2026-09-21T10:00:00.000Z") });
  assert.equal(assignments.rows[0].status, "active");
  assert.equal(participants.rows[0].consecutiveMisses, 2);

  await service.handleMessage({ guild, channelId: oldChannel.id, author: { id: "u1", bot: false }, createdTimestamp: Date.parse("2026-09-21T11:00:00.000Z") });
  assert.equal(assignments.rows[0].status, "completed");
  assert.equal(participants.rows[0].consecutiveMisses, 0);
});

test("設定変更後の期限判定もassignment保存先の履歴を確認する", async () => {
  const assignedAt = Date.parse("2026-09-21T09:00:00.000Z");
  const deadline = Date.parse("2026-09-22T09:00:00.000Z");
  const oldMessages = new Map([[
    "old-post",
    { id: "old-post", createdTimestamp: Date.parse("2026-09-21T10:00:00.000Z"), author: { id: "u1", bot: false } },
  ]]);
  const oldChannel = diaryChannel("old-diary", { messages: oldMessages });
  const newChannel = diaryChannel("new-diary");
  const assignments = memoryModel([{
    guildId: "g1",
    assignmentId: "channel-change-history",
    slotKey: "2026-09-21",
    userId: "u1",
    channelId: oldChannel.id,
    assignedAt: new Date(assignedAt),
    nominalAt: new Date(assignedAt),
    deadlineAt: new Date(deadline),
    status: "active",
    sendState: "sent",
    specialNoPenalty: false,
  }]);
  const participants = memoryModel([{ guildId: "g1", userId: "u1", joinedAt: new Date("2026-09-01T00:00:00.000Z"), consecutiveMisses: 1 }]);
  const guild = diaryGuild({ channels: [oldChannel, newChannel] });
  const service = createDiaryService({
    client: { guilds: { cache: new Map([[guild.id, guild]]) } },
    getGuildSettings: async () => ({ guildId: guild.id, diaryEnabled: true, diaryChannelId: newChannel.id, diaryLastRunSlot: "2026-09-22" }),
    assignmentModel: assignments,
    participantModel: participants,
    dailyRunModel: {},
    sendOperationalLog: async () => {},
  });

  await service.processGuild(guild, { at: new Date(deadline) });

  assert.equal(assignments.rows[0].status, "completed");
  assert.equal(participants.rows[0].consecutiveMisses, 0);
});

test("DB参加者を正としてロールを再付与し、DB未参加のロール保持者を解除する", async () => {
  const roleMembers = new Map();
  const role = { id: "role", managed: false, editable: true, members: roleMembers };
  const added = { id: "u1", user: { id: "u1", bot: false }, roles: { add: async () => { roleMembers.set("u1", added); }, remove: async () => {} } };
  const stale = { id: "u2", user: { id: "u2", bot: false }, roles: { add: async () => {}, remove: async () => { roleMembers.delete("u2"); } } };
  roleMembers.set(stale.id, stale);
  const guild = diaryGuild({ roles: [role], members: [added, stale] });
  const participants = memoryModel([{ guildId: guild.id, userId: added.id, joinedAt: new Date() }]);
  const service = createDiaryService({ participantModel: participants, sendOperationalLog: async () => {} });
  const result = await service.syncParticipantRoles(guild, { diaryParticipantRoleId: role.id });
  assert.equal(result.status, "applied");
  assert.equal(roleMembers.has(added.id), true);
  assert.equal(roleMembers.has(stale.id), false);
});

test("通常未投稿は連続加算し、達成は0へ戻し、3回目は自動離脱する", async () => {
  const channel = diaryChannel("diary");
  const roleMembers = new Map();
  const member = {
    id: "u1", user: { id: "u1", bot: false },
    roles: { add: async () => {}, remove: async () => { roleMembers.delete("u1"); } },
    send: async () => {},
  };
  const role = { id: "role", managed: false, editable: true, members: roleMembers };
  const guild = diaryGuild({ channels: [channel], roles: [role], members: [member] });
  const participants = memoryModel([{ guildId: guild.id, userId: member.id, consecutiveMisses: 0, joinedAt: new Date("2026-09-01T00:00:00.000Z") }]);
  const assignments = memoryModel();
  const settings = { guildId: guild.id, diaryEnabled: true, diaryChannelId: channel.id, diaryParticipantRoleId: role.id };
  let run = 0;
  const logs = [];
  const service = createDiaryService({
    getGuildSettings: async () => ({ ...settings, diaryLastRunSlot: `2026-09-${String(19 + run).padStart(2, "0")}` }),
    assignmentModel: assignments,
    participantModel: participants,
    dailyRunModel: {},
    sendOperationalLog: async ({ content }) => logs.push(content),
    saveRuntimeGuildSettings: async () => {},
    requestOperationalStatusRefresh: async () => {},
  });
  // Directly exercise the normal expiry path with three durable, sent rows.
  for (const [index, misses] of [[1, 0], [2, 1], [3, 2]]) {
    participants.rows[0].consecutiveMisses = misses;
    const deadline = new Date(`2026-09-${String(19 + index).padStart(2, "0")}T09:00:00.000Z`);
    assignments.rows.push({ guildId: guild.id, assignmentId: `a${index}`, slotKey: `2026-09-${String(18 + index).padStart(2, "0")}`, userId: member.id, assignedAt: new Date(deadline.getTime() - 86_400_000), nominalAt: new Date(deadline.getTime() - 86_400_000), deadlineAt: deadline, status: "active", sendState: "sent", specialNoPenalty: false });
    run = index;
    await service.processGuild(guild, { at: new Date(deadline.getTime() + 60_000) });
    if (index < 3) assert.equal(participants.rows[0].consecutiveMisses, misses + 1);
  }
  assert.equal(participants.rows.length, 0);
  assert.equal(roleMembers.size, 0);
  assert.ok(logs.some((log) => log.includes("自動離脱")));
});

test("stale daily run は pending を取消して再試行し、sent/sending は重複送信せず完了復旧する", async () => {
  const oldClaimedAt = new Date("2026-09-20T00:00:00.000Z");
  const dailyRuns = memoryModel([{ guildId: "g1", slotKey: "2026-09-20", status: "claimed", claimToken: "old", claimedAt: oldClaimedAt }]);
  const pendingAssignments = memoryModel([{ guildId: "g1", slotKey: "2026-09-20", assignmentId: "pending", userId: "u1", status: "active", sendState: "pending" }]);
  const participants = memoryModel([{ guildId: "g1", userId: "u1", lastAssignedAt: null }]);
  const guild = diaryGuild();
  const service = createDiaryService({
    dailyRunModel: dailyRuns,
    assignmentModel: pendingAssignments,
    participantModel: participants,
    sendOperationalLog: async () => {},
  });
  const recoveredPending = await service.recoverClaimedDailyRun(guild, "2026-09-20", new Date("2026-09-21T00:00:00.000Z"));
  assert.equal(recoveredPending.status, "recovered-failed");
  assert.equal(pendingAssignments.rows[0].status, "canceled");
  assert.equal(dailyRuns.rows[0].status, "failed");

  const sent = { guildId: "g1", slotKey: "2026-09-21", assignmentId: "sent", userId: "u1", status: "active", sendState: "sent", nominalAt: new Date("2026-09-21T09:00:00.000Z") };
  const uncertain = { guildId: "g1", slotKey: "2026-09-21", assignmentId: "uncertain", userId: "u2", status: "active", sendState: "sending", nominalAt: new Date("2026-09-21T09:00:00.000Z") };
  dailyRuns.rows.push({ guildId: "g1", slotKey: "2026-09-21", status: "claimed", claimToken: "old", claimedAt: oldClaimedAt });
  pendingAssignments.rows.push(sent, uncertain);
  participants.rows.push({ guildId: "g1", userId: "u2", lastAssignedAt: null });
  const recoveredSent = await service.recoverClaimedDailyRun(guild, "2026-09-21", new Date("2026-09-22T00:00:00.000Z"));
  assert.equal(recoveredSent.status, "recovered-completed");
  assert.equal(dailyRuns.rows.find((row) => row.slotKey === "2026-09-21").status, "completed");
  assert.equal(pendingAssignments.rows.find((row) => row.assignmentId === "uncertain").status, "canceled");
  assert.ok(participants.rows.find((row) => row.userId === "u1").lastAssignedAt);
  assert.ok(participants.rows.find((row) => row.userId === "u2").lastAssignedAt);
});

test("公開送信失敗はassignmentを再準備して再試行し、複数担当の一部確定失敗は未追跡行を残さない", async () => {
  const channel = diaryChannel("diary");
  let sends = 0;
  channel.send = async (payload) => {
    sends += 1;
    if (sends === 1) throw new Error("discord unavailable");
    return { id: `message-${sends}`, payload };
  };
  const guild = diaryGuild({ channels: [channel] });
  const settings = { guildId: guild.id, diaryEnabled: true, diaryChannelId: channel.id, diaryMaxDaily: 2, diaryMinIntervalDays: 1, diaryLastRunSlot: null };
  const participants = memoryModel([
    { guildId: guild.id, userId: "u1", joinedAt: new Date("2026-09-01T00:00:00.000Z"), lastAssignedAt: null, consecutiveMisses: 0 },
  ]);
  const assignments = memoryModel();
  const dailyRuns = memoryModel();
  const saveRuntime = async (_guildId, patch) => Object.assign(settings, patch);
  const service = createDiaryService({
    client: { guilds: { cache: new Map([[guild.id, guild]]) } },
    getGuildSettings: async () => settings,
    saveRuntimeGuildSettings: saveRuntime,
    assignmentModel: assignments,
    participantModel: participants,
    dailyRunModel: dailyRuns,
    sendOperationalLog: async () => {},
  });
  const first = await service.processGuild(guild, { at: new Date("2026-09-21T09:00:00.000Z") });
  assert.equal(first.status, "send-failed");
  assert.equal(assignments.rows[0].status, "canceled");
  assert.equal(assignments.rows[0].sendState, "failed");
  assert.equal(dailyRuns.rows[0].status, "failed");
  const retry = await service.processGuild(guild, { at: new Date("2026-09-21T09:01:00.000Z") });
  assert.equal(retry.status, "assigned");
  assert.equal(retry.assigned, 1);
  assert.equal(assignments.rows[0].status, "active");
  assert.equal(assignments.rows[0].sendState, "sent");
  assert.equal(sends, 2);

  const twoParticipants = memoryModel([
    { guildId: guild.id, userId: "u1", joinedAt: new Date("2026-09-01T00:00:00.000Z"), lastAssignedAt: null, consecutiveMisses: 0 },
    { guildId: guild.id, userId: "u2", joinedAt: new Date("2026-09-01T00:00:01.000Z"), lastAssignedAt: null, consecutiveMisses: 0 },
  ]);
  const partialAssignments = memoryModel();
  const partialRuns = memoryModel();
  const originalUpdateOne = partialAssignments.updateOne.bind(partialAssignments);
  let failStateOnce = true;
  partialAssignments.updateOne = async (filter, update) => {
    if (failStateOnce && filter.assignmentId?.endsWith(":u2") && update.$set?.sendState === "sent") {
      failStateOnce = false;
      return { matchedCount: 0, modifiedCount: 0 };
    }
    return originalUpdateOne(filter, update);
  };
  const partialSettings = { ...settings, diaryChannelId: "partial", diaryLastRunSlot: null };
  const partialChannel = diaryChannel("partial");
  partialChannel.send = async () => ({ id: "partial-message" });
  const partialGuild = diaryGuild({ channels: [partialChannel] });
  const partialService = createDiaryService({
    client: { guilds: { cache: new Map([[partialGuild.id, partialGuild]]) } },
    getGuildSettings: async () => partialSettings,
    saveRuntimeGuildSettings: async (_guildId, patch) => Object.assign(partialSettings, patch),
    assignmentModel: partialAssignments,
    participantModel: twoParticipants,
    dailyRunModel: partialRuns,
    sendOperationalLog: async () => {},
  });
  const partial = await partialService.processGuild(partialGuild, { at: new Date("2026-09-21T09:00:00.000Z") });
  assert.equal(partial.status, "assigned");
  assert.equal(partial.assigned, 1);
  assert.equal(partialAssignments.rows.filter((row) => row.sendState === "sending").length, 0);
  assert.equal(partialAssignments.rows.find((row) => row.userId === "u2").status, "canceled");
  assert.equal(partialAssignments.rows.find((row) => row.userId === "u2").cancelReason, "send-outcome-uncertain");
  assert.ok(twoParticipants.rows.find((row) => row.userId === "u2").lastAssignedAt);
  assert.equal(partialRuns.rows[0].status, "completed");
});

test("18時間未満の特例回は失敗ペナルティを免除し、投稿成功は通常どおり0へ戻す", async () => {
  const channel = diaryChannel("diary");
  const participant = memoryModel([{ guildId: "g1", userId: "u1", consecutiveMisses: 2 }]);
  const deadline = new Date("2026-09-22T09:00:00.000Z");
  const assignment = { guildId: "g1", assignmentId: "special", slotKey: "2026-09-21", userId: "u1", assignedAt: new Date("2026-09-22T01:00:00.000Z"), nominalAt: new Date("2026-09-21T09:00:00.000Z"), deadlineAt: deadline, status: "active", sendState: "sent", specialNoPenalty: true };
  const assignments = memoryModel([assignment]);
  const guild = diaryGuild({ channels: [channel] });
  const service = createDiaryService({
    getGuildSettings: async () => ({ guildId: guild.id, diaryEnabled: true, diaryChannelId: channel.id, diaryLastRunSlot: "2026-09-22" }),
    assignmentModel: assignments,
    participantModel: participant,
    dailyRunModel: {},
    sendOperationalLog: async () => {},
  });
  await service.processGuild(guild, { at: deadline });
  assert.equal(assignments.rows[0].status, "missed");
  assert.equal(participant.rows[0].consecutiveMisses, 2);

  const successful = { ...assignment, assignmentId: "special-success", status: "active" };
  assignments.rows.push(successful);
  await service.handleMessage({ guild, channelId: channel.id, author: { id: "u1", bot: false }, createdTimestamp: Date.parse("2026-09-22T02:00:00.000Z") });
  assert.equal(successful.status, "completed");
  assert.equal(participant.rows[0].consecutiveMisses, 0);
});

test("遅延がちょうど18時間残る回は通常ペナルティ対象として送信する", async () => {
  const channel = diaryChannel("diary");
  const assignments = memoryModel();
  const participants = memoryModel([{ guildId: "g1", userId: "u1", joinedAt: new Date("2026-09-01T00:00:00.000Z"), consecutiveMisses: 0, lastAssignedAt: null }]);
  const dailyRuns = memoryModel();
  const guild = diaryGuild({ channels: [channel] });
  const settings = { guildId: guild.id, diaryEnabled: true, diaryChannelId: channel.id, diaryLastRunSlot: null, diaryMaxDaily: 1, diaryMinIntervalDays: 1 };
  const service = createDiaryService({
    client: { guilds: { cache: new Map([[guild.id, guild]]) } },
    getGuildSettings: async () => settings,
    saveRuntimeGuildSettings: async (_guildId, patch) => Object.assign(settings, patch),
    assignmentModel: assignments,
    participantModel: participants,
    dailyRunModel: dailyRuns,
    sendOperationalLog: async () => {},
  });
  // The nominal slot is 9/20 18:00 JST; invoking exactly 9/20 18:00 JST
  // leaves 24h, while invoking at 9/21 00:00 JST leaves 18h exactly.
  const result = await service.processGuild(guild, { at: new Date("2026-09-20T15:00:00.000Z") });
  assert.equal(result.status, "assigned");
  assert.equal(assignments.rows[0].specialNoPenalty, false);
});

test("設定適用時は旧新設定を一度だけ比較し、ロール交換と受付パネル移動を一度だけ行う", async () => {
  const events = [];
  const oldRoleMembers = new Map();
  const newRoleMembers = new Map();
  const oldRole = { id: "old-role", managed: false, editable: true, members: oldRoleMembers };
  const newRole = { id: "new-role", managed: false, editable: true, members: newRoleMembers };
  const member = {
    id: "u1", user: { id: "u1", bot: false },
    roles: {
      add: async (role) => { events.push(`add:${role.id}`); role.members.set(member.id, member); },
      remove: async (role) => { events.push(`remove:${role.id}`); role.members.delete(member.id); },
    },
  };
  oldRoleMembers.set(member.id, member);
  const oldMessages = new Map([["old-panel", { id: "old-panel", delete: async () => events.push("delete-panel") }]]);
  const oldChannel = diaryChannel("old-reception", { messages: oldMessages });
  const newChannel = diaryChannel("new-reception");
  const guild = diaryGuild({ channels: [oldChannel, newChannel], roles: [oldRole, newRole], members: [member] });
  const participants = memoryModel([{ guildId: guild.id, userId: member.id, joinedAt: new Date(), lastAssignedAt: null }]);
  const panelState = { guildId: guild.id, channelId: oldChannel.id, messageId: "old-panel" };
  const panelModel = {
    findOne: () => ({ ...panelState }),
    findOneAndUpdate: async (_filter, update) => { events.push("save-panel"); Object.assign(panelState, update.$set); return panelState; },
  };
  const service = createDiaryService({
    participantModel: participants,
    assignmentModel: memoryModel(),
    panelModel,
    saveRuntimeGuildSettings: async () => {},
    sendOperationalLog: async () => {},
    requestOperationalStatusRefresh: async () => events.push("status"),
  });
  await service.onSettingsChanged(
    guild,
    { guildId: guild.id, diaryEnabled: true, diaryReceptionChannelId: newChannel.id, diaryParticipantRoleId: newRole.id },
    { guildId: guild.id, diaryEnabled: true, diaryReceptionChannelId: oldChannel.id, diaryParticipantRoleId: oldRole.id },
  );
  assert.deepEqual(events.filter((event) => event.startsWith("add:")), ["add:new-role"]);
  assert.deepEqual(events.filter((event) => event.startsWith("remove:")), ["remove:old-role"]);
  assert.equal(events.filter((event) => event === "save-panel").length, 1);
  assert.equal(events.filter((event) => event === "delete-panel").length, 1);
  assert.equal(panelState.channelId, newChannel.id);
});

test("起動時ステータス人数はDB参加者を基準にし、回収保留中を数えない", async () => {
  const participants = memoryModel([
    { guildId: "g1", userId: "active", leaveState: "active" },
    { guildId: "g1", userId: "legacy" },
    { guildId: "g1", userId: "pending", leaveState: "pending" },
    { guildId: "g1", userId: "failed", leaveState: "failed" },
  ]);
  const service = createDiaryService({ participantModel: participants, sendOperationalLog: async () => {} });
  assert.equal((await service.getStatus("g1")).participantCount, 2);
});

test("起動復元は参加者ロール・余剰ロール・status refresh・人数を一連で同期する", async () => {
  const roleMembers = new Map();
  const role = { id: "diary-role", managed: false, editable: true, members: roleMembers };
  const member = {
    id: "u1",
    user: { id: "u1", bot: false },
    roles: {
      add: async () => roleMembers.set("u1", member),
      remove: async () => roleMembers.delete("u1"),
    },
  };
  const stale = {
    id: "u2",
    user: { id: "u2", bot: false },
    roles: { add: async () => {}, remove: async () => roleMembers.delete("u2") },
  };
  roleMembers.set(stale.id, stale);
  const guild = diaryGuild({ roles: [role], members: [member, stale] });
  const participants = memoryModel([{ guildId: guild.id, userId: member.id, joinedAt: new Date("2026-09-01T00:00:00.000Z") }]);
  const settings = { guildId: guild.id, diaryEnabled: true, diaryParticipantRoleId: role.id, diaryLastRunSlot: "2026-09-21" };
  const refreshes = [];
  const service = createDiaryService({
    client: { guilds: { cache: new Map([[guild.id, guild]]) } },
    getGuildSettings: async () => settings,
    participantModel: participants,
    assignmentModel: memoryModel(),
    dailyRunModel: {},
    now: () => new Date("2026-09-21T09:10:00.000Z"),
    requestOperationalStatusRefresh: async (_guildId, reason) => refreshes.push(reason),
    sendOperationalLog: async () => {},
  });
  await service.restore();
  assert.equal(roleMembers.has(member.id), true);
  assert.equal(roleMembers.has(stale.id), false);
  assert.ok(refreshes.includes("diary:startup"));
  assert.equal((await service.getStatus(guild.id)).participantCount, 1);
});

test("離脱DB保存失敗は成功返信せず、自動離脱は再試行上限で停止する", async () => {
  const participants = memoryModel([{ guildId: "g1", userId: "u1", joinedAt: new Date("2026-09-01T00:00:00.000Z"), consecutiveMisses: 0 }]);
  const assignments = memoryModel();
  const guild = diaryGuild();
  const service = createDiaryService({
    participantModel: participants,
    assignmentModel: assignments,
    getGuildSettings: async () => ({ guildId: guild.id, diaryEnabled: true }),
    sendOperationalLog: async () => {},
  });
  const originalDelete = participants.deleteOne;
  let deleteAttempts = 0;
  participants.deleteOne = async () => { deleteAttempts += 1; throw new Error("db unavailable"); };
  const interaction = { customId: DIARY_LEAVE_CUSTOM_ID, guildId: guild.id, guild, user: { id: "u1" }, deferred: false, replied: false, deferReply: async function deferReply() { this.deferred = true; }, editReply: async function editReply(payload) { this.reply = payload; } };
  await service.handleButton(interaction);
  assert.match(interaction.reply.content, /処理中にエラー/);
  assert.equal(participants.rows.length, 1);

  participants.deleteOne = async (filter) => originalDelete.call(participants, filter);
  const channel = diaryChannel("diary");
  const autoParticipants = memoryModel([{ guildId: "g1", userId: "u2", joinedAt: new Date("2026-09-01T00:00:00.000Z"), consecutiveMisses: 2 }]);
  const autoAssignments = memoryModel([{ guildId: "g1", assignmentId: "miss-1", userId: "u2", status: "active", sendState: "sent", assignedAt: new Date("2026-09-20T09:00:00.000Z"), deadlineAt: new Date("2026-09-21T09:00:00.000Z"), slotKey: "2026-09-20" }]);
  const autoGuild = diaryGuild({ channels: [channel] });
  const logs = [];
  const autoService = createDiaryService({
    client: { guilds: { cache: new Map([[autoGuild.id, autoGuild]]) } },
    participantModel: autoParticipants,
    assignmentModel: autoAssignments,
    dailyRunModel: {},
    getGuildSettings: async () => ({ guildId: autoGuild.id, diaryEnabled: true, diaryChannelId: channel.id, diaryLastRunSlot: "2026-09-21" }),
    sendOperationalLog: async ({ content }) => logs.push(content),
  });
  autoParticipants.deleteOne = async () => { deleteAttempts += 1; throw new Error("db unavailable"); };
  const firstAt = new Date("2026-09-21T10:00:00.000Z");
  await autoService.processGuild(autoGuild, { at: firstAt });
  assert.equal(autoParticipants.rows[0].leaveState, "pending");
  const attemptsAfterFirst = deleteAttempts;
  await autoService.processGuild(autoGuild, { at: firstAt });
  assert.equal(deleteAttempts, attemptsAfterFirst);
  await autoService.processGuild(autoGuild, { at: new Date(firstAt.getTime() + 61_000) });
  await autoService.processGuild(autoGuild, { at: new Date(firstAt.getTime() + 183_000) });
  assert.equal(autoParticipants.rows[0].leaveState, "failed");
  assert.ok(logs.some((content) => content.includes("再試行上限")));
});

test("古い未投稿の投影失敗中は後続未投稿を先に加算せず、復旧後に2回へ到達する", async () => {
  const channel = diaryChannel("diary");
  const guild = diaryGuild({ channels: [channel] });
  const participants = memoryModel([{ guildId: guild.id, userId: "u1", joinedAt: new Date("2026-09-01T00:00:00.000Z"), consecutiveMisses: 0 }]);
  const assignments = memoryModel([
    { guildId: guild.id, assignmentId: "A", userId: "u1", status: "active", sendState: "sent", slotKey: "2026-09-19", nominalAt: new Date("2026-09-19T09:00:00.000Z"), assignedAt: new Date("2026-09-19T09:00:00.000Z"), deadlineAt: new Date("2026-09-20T09:00:00.000Z") },
    { guildId: guild.id, assignmentId: "B", userId: "u1", status: "active", sendState: "sent", slotKey: "2026-09-20", nominalAt: new Date("2026-09-20T09:00:00.000Z"), assignedAt: new Date("2026-09-20T09:00:00.000Z"), deadlineAt: new Date("2026-09-21T09:00:00.000Z") },
  ]);
  const originalUpdate = participants.updateOne.bind(participants);
  let failA = true;
  participants.updateOne = async (filter, update) => {
    if (failA && update.$set?.lastDiaryOutcomeAssignmentId === "A") {
      failA = false;
      throw new Error("participant projection unavailable");
    }
    return originalUpdate(filter, update);
  };
  const service = createDiaryService({
    client: { guilds: { cache: new Map([[guild.id, guild]]) } },
    participantModel: participants,
    assignmentModel: assignments,
    dailyRunModel: {},
    getGuildSettings: async () => ({ guildId: guild.id, diaryEnabled: true, diaryChannelId: channel.id, diaryLastRunSlot: "2026-09-21" }),
    sendOperationalLog: async () => {},
  });
  const firstAt = new Date("2026-09-21T10:00:00.000Z");
  await service.processGuild(guild, { at: firstAt });
  assert.equal(participants.rows[0].consecutiveMisses, 0);
  assert.equal(assignments.rows.find((row) => row.assignmentId === "B").missState, "pending");
  await service.processGuild(guild, { at: new Date(firstAt.getTime() + 61_000) });
  assert.equal(participants.rows[0].consecutiveMisses, 2);
  assert.equal(assignments.rows.find((row) => row.assignmentId === "A").missState, "applied");
  assert.equal(assignments.rows.find((row) => row.assignmentId === "B").missState, "applied");
});

test("受付パネル取得の一時障害では重複送信せず、旧削除失敗は保留し古いボタンを拒否する", async () => {
  const oldMessage = { id: "old", delete: async () => { throw new Error("permission denied"); } };
  const oldMessages = new Map([[oldMessage.id, oldMessage]]);
  const oldChannel = diaryChannel("old", { messages: oldMessages });
  let sends = 0;
  const newChannel = diaryChannel("new");
  const originalSend = newChannel.send;
  newChannel.send = async (payload) => { sends += 1; return originalSend(payload); };
  const guild = diaryGuild({ channels: [oldChannel, newChannel] });
  const panel = memoryModel([{ guildId: guild.id, channelId: oldChannel.id, messageId: oldMessage.id }]);
  const transientMessages = oldChannel.messages.fetch;
  oldChannel.messages.fetch = async () => { throw Object.assign(new Error("rate limited"), { status: 503 }); };
  const transientService = createDiaryService({ panelModel: panel, sendOperationalLog: async () => {} });
  const transient = await transientService.ensurePanel(guild, { diaryReceptionChannelId: oldChannel.id });
  assert.equal(transient.status, "message-unknown");
  assert.equal(sends, 0);
  oldChannel.messages.fetch = transientMessages;
  const applied = await transientService.ensurePanel(guild, { diaryReceptionChannelId: newChannel.id });
  assert.equal(applied.status, "applied-cleanup-pending");
  assert.equal(panel.rows[0].pendingMessageDeletions.length, 1);
  const stale = { customId: DIARY_JOIN_CUSTOM_ID, guildId: guild.id, guild, channelId: oldChannel.id, message: { id: oldMessage.id }, user: { id: "u1" }, deferred: false, replied: false, deferReply: async function deferReply() { this.deferred = true; }, editReply: async function editReply(payload) { this.reply = payload; } };
  const serviceWithSettings = createDiaryService({ panelModel: panel, getGuildSettings: async () => ({ diaryEnabled: true }), participantModel: memoryModel(), sendOperationalLog: async () => {} });
  await serviceWithSettings.handleButton(stale);
  assert.match(stale.reply.content, /古い/);
});

test("参加者ロール付与がfalseなら参加登録を戻し、同時参加は一件に収束する", async () => {
  const role = { id: "role", managed: false, editable: true, members: new Map() };
  const member = { id: "u1", user: { id: "u1", bot: false }, roles: { add: async () => false, remove: async () => {} } };
  const guild = diaryGuild({ roles: [role], members: [member] });
  const participants = memoryModel();
  const service = createDiaryService({ participantModel: participants, getGuildSettings: async () => ({ diaryEnabled: true, diaryParticipantRoleId: role.id }), sendOperationalLog: async () => {} });
  const makeInteraction = () => ({ customId: DIARY_JOIN_CUSTOM_ID, guildId: guild.id, guild, user: { id: member.id }, member, deferred: false, replied: false, deferReply: async function deferReply() { this.deferred = true; }, editReply: async function editReply(payload) { this.reply = payload; } });
  const failed = makeInteraction();
  await service.handleButton(failed);
  assert.match(failed.reply.content, /ロール/);
  assert.equal(participants.rows.length, 0);

  member.roles.add = async () => { role.members.set(member.id, member); };
  const [first, second] = [makeInteraction(), makeInteraction()];
  await Promise.all([service.handleButton(first), service.handleButton(second)]);
  assert.equal(participants.rows.length, 1);
  assert.equal([first.reply.content, second.reply.content].filter((content) => content.includes("参加しました！")).length, 1);
});

test("ロール失敗のDB回収再試行は自動離脱DMを送らない", async () => {
  const role = { id: "role", managed: false, editable: true, members: new Map() };
  const dms = [];
  const member = {
    id: "u1",
    user: { id: "u1", bot: false },
    roles: { add: async () => false, remove: async () => {} },
    send: async (payload) => { dms.push(payload); },
  };
  const guild = diaryGuild({ roles: [role], members: [member] });
  const participants = memoryModel();
  const assignments = memoryModel();
  const logs = [];
  const now = new Date("2026-09-21T10:00:00.000Z");
  const settings = {
    guildId: guild.id,
    diaryEnabled: true,
    diaryParticipantRoleId: role.id,
    diaryLastRunSlot: "2026-09-21",
  };
  const service = createDiaryService({
    client: { guilds: { cache: new Map([[guild.id, guild]]) } },
    participantModel: participants,
    assignmentModel: assignments,
    dailyRunModel: {},
    getGuildSettings: async () => settings,
    now: () => now,
    sendOperationalLog: async ({ content }) => logs.push(content),
  });
  const originalDelete = participants.deleteOne.bind(participants);
  let deleteAttempts = 0;
  participants.deleteOne = async (filter) => {
    deleteAttempts += 1;
    if (deleteAttempts === 1) throw new Error("db unavailable");
    return originalDelete(filter);
  };
  const makeInteraction = () => ({
    customId: DIARY_JOIN_CUSTOM_ID,
    guildId: guild.id,
    guild,
    user: { id: member.id },
    member,
    deferred: false,
    replied: false,
    deferReply: async function deferReply() { this.deferred = true; },
    editReply: async function editReply(payload) { this.reply = payload; },
  });

  const failed = makeInteraction();
  await service.handleButton(failed);
  assert.match(failed.reply.content, /ロール/);
  assert.equal(participants.rows.length, 1);
  assert.equal(participants.rows[0].leaveReason, "join-role-rollback");
  assert.equal(dms.length, 0);

  await service.processGuild(guild, { at: new Date(now.getTime() + 61_000) });

  assert.equal(deleteAttempts, 2);
  assert.equal(participants.rows.length, 0);
  assert.equal(dms.length, 0);
  assert.ok(logs.some((content) => content.includes("DB回収")));
  assert.equal(logs.some((content) => content.includes("3回連続") || content.includes("自動離脱")), false);
});
