import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { ChannelType } from "discord.js";
import { settingCommand } from "../src/commands.js";
import { normalizeGuildSettings } from "../src/settings-store.js";
import { VcDmDailyRun } from "../src/models/vc-dm-daily-run.js";
import { VcDmMemberTracking } from "../src/models/vc-dm-member-tracking.js";
import { VcDmMigration } from "../src/models/vc-dm-migration.js";
import { VcDmPanel } from "../src/models/vc-dm-panel.js";
import { VcDmReminder } from "../src/models/vc-dm-reminder.js";
import {
  buildPanelComponents,
  createVcDmPanelService,
  getPanelBody,
  isCurrentVcDmPanelInteraction,
  splitCandidateBlocks,
  withVcDmPanelLease,
  withVcDmPanelLeaseRetry,
} from "../src/vc-dm-panel-service.js";
import {
  createVcDmService,
  getVcDmManualBaselineAt,
  getVcDmMigrationImplementationAt,
  validateVcDmTargetConfiguration,
} from "../src/vc-dm-service.js";
import {
  buildVcDmParticipationRepairPipeline,
  buildVcDmParticipationUpdatePipeline,
} from "../src/vc-dm-store.js";
import {
  VC_DM_BUTTON_LABEL,
  REMINDER_CANCELED_MESSAGE,
  REMINDER_MESSAGE,
  buildInactiveDmContent,
  buildNewMemberDmContent,
  buildReminderConfirmationContent,
  getInactiveDmDueAt,
  getInactivityReference,
  getNextJstHourAt,
  getNextVcDmEventAt,
  getNewMemberDmDueAt,
  getVcDmConfigurationIssues,
  getVcDmStatusSeverity,
  hasVcDmConfiguration,
  hasValidVcParticipation,
  isTargetVcChannel,
  normalizeVcDmEventTime,
} from "../src/vc-dm-utils.js";

const joinedAt = new Date("2026-08-01T09:20:00.000Z");
const eventAt = new Date("2026-08-04T12:00:00.000Z");

test("VC DMの期限は基準日時に日数を加算した後の最初のJST17:00で計算する", () => {
  assert.equal(getNewMemberDmDueAt(joinedAt).toISOString(), "2026-08-09T08:00:00.000Z");
  assert.equal(getInactiveDmDueAt(joinedAt).toISOString(), "2026-09-01T08:00:00.000Z");
  assert.equal(normalizeVcDmEventTime(" 21:05 "), "21:05");
  assert.equal(normalizeVcDmEventTime("25:00"), null);
});

test("加入7日・不参加30日の17:00前後の境界を正しく扱う", () => {
  const beforeDailyBoundary = new Date("2026-08-01T07:59:00.000Z"); // 16:59 JST
  const atDailyBoundary = new Date("2026-08-01T08:00:00.000Z"); // 17:00 JST
  const afterDailyBoundary = new Date("2026-08-01T08:01:00.000Z"); // 17:01 JST
  assert.equal(getNewMemberDmDueAt(beforeDailyBoundary).toISOString(), "2026-08-08T08:00:00.000Z");
  assert.equal(getNewMemberDmDueAt(atDailyBoundary).toISOString(), "2026-08-08T08:00:00.000Z");
  assert.equal(getNewMemberDmDueAt(afterDailyBoundary).toISOString(), "2026-08-09T08:00:00.000Z");
  assert.equal(getInactiveDmDueAt(beforeDailyBoundary).toISOString(), "2026-08-31T08:00:00.000Z");
  assert.equal(getInactiveDmDueAt(atDailyBoundary).toISOString(), "2026-08-31T08:00:00.000Z");
  assert.equal(getInactiveDmDueAt(afterDailyBoundary).toISOString(), "2026-09-01T08:00:00.000Z");
});

test("VC DMはkokuchiの互換デフォルト時刻を未設定として扱う", () => {
  const missing = normalizeGuildSettings({ vcDmEnabled: true });
  const configured = normalizeGuildSettings({ vcDmEnabled: true, kokuchiEventTime: "21:00" });
  assert.equal(missing.kokuchiEventTime, "21:00");
  assert.equal(missing.kokuchiEventTimeConfigured, false);
  assert.equal(configured.kokuchiEventTimeConfigured, true);
  assert.deepEqual(normalizeGuildSettings(missing), missing);
  assert.equal(hasVcDmConfiguration({
    ...missing,
    vcDmPanelChannelId: "123456789012345678",
    vcDmTargetCategoryId: "123456789012345679",
  }), false);
  assert.equal(hasVcDmConfiguration({
    ...configured,
    vcDmPanelChannelId: "123456789012345678",
    vcDmTargetCategoryId: "123456789012345679",
  }), true);
  assert.deepEqual(
    getVcDmConfigurationIssues({ vcDmEnabled: true, kokuchiEventTime: "21:00", kokuchiEventTimeConfigured: true }),
    [
      { code: "panel_channel_missing", message: "VC DM対象確認パネルのチャンネルが未設定です。" },
      { code: "target_vc_missing", message: "VC DMの対象VCまたは対象カテゴリが未設定です。" },
    ],
  );
});

test("パネルの毎時再照合時刻はJSTの次の00分になる", () => {
  assert.equal(
    getNextJstHourAt(new Date("2026-08-03T01:23:45.000Z")).toISOString(),
    "2026-08-03T02:00:00.000Z",
  );
});

test("VC DMの次回イベントは火曜・土曜のうち現在時刻より後を選ぶ", () => {
  assert.equal(
    getNextVcDmEventAt(new Date("2026-08-03T09:00:00.000Z"), "21:00").toISOString(),
    "2026-08-04T12:00:00.000Z",
  );
  assert.equal(
    getNextVcDmEventAt(new Date("2026-08-04T13:00:00.000Z"), "21:00").toISOString(),
    "2026-08-08T12:00:00.000Z",
  );
  assert.equal(getNextVcDmEventAt(new Date("2026-08-03T09:00:00.000Z"), "invalid"), null);
});

test("VC DMの本文・ボタン・リマインダー文面は指定文面を保持する", () => {
  assert.equal(VC_DM_BUTTON_LABEL, "イベント日にリマインダーを受け取る");
  assert.equal(
    buildNewMemberDmContent(eventAt),
    [
      "「会話に慣れるためのサーバー」からのお知らせです。",
      "",
      "あなたがサーバーに参加してから7日間経過しましたがまだVCに参加できていません。",
      "まずはイベントから参加してみませんか？",
      "次回のイベントは8月4日（火）21:00からです。",
      "ぜひ一度参加してみてください！",
      "",
      "いきなりのDM失礼いたしました。",
    ].join("\n"),
  );
  assert.equal(
    buildInactiveDmContent(eventAt),
    [
      "「会話に慣れるためのサーバー」からのお知らせです。",
      "",
      "あなたがサーバーで最後にVCへ参加してから30日間経過しました。",
      "久しぶりにVCへ参加してみませんか？",
      "次回のイベントは8月4日（火）21:00からです。",
      "ぜひ参加してみてください！",
      "",
      "いきなりのDM失礼いたしました。",
    ].join("\n"),
  );
  assert.equal(
    buildReminderConfirmationContent(eventAt),
    "8月4日（火）21:00からのイベントについて、\n開催30分前のリマインダーを設定しました。",
  );
  assert.equal(REMINDER_MESSAGE, "リマインダーを設定したイベントの開催30分前です！\n時間の都合がよろしければぜひ参加してみてください！");
  assert.equal(REMINDER_CANCELED_MESSAGE, "イベントのリマインダーをキャンセルしました。");
});

test("VC DMの対象VC判定は対象外・AFK・カテゴリ・個別指定を反映する", () => {
  const voice = (id, parentId = null) => ({ id, parentId, isVoiceBased: () => true });
  const guild = { afkChannelId: "afk" };
  const settings = { vcDmTargetCategoryId: "category", vcDmTargetChannelIds: [], vcDmExcludedChannelIds: ["excluded"] };
  assert.equal(isTargetVcChannel(voice("target", "category"), settings, guild), true);
  assert.equal(isTargetVcChannel(voice("excluded", "category"), settings, guild), false);
  assert.equal(isTargetVcChannel(voice("afk", "category"), settings, guild), false);
  assert.equal(isTargetVcChannel(voice("other"), settings, guild), false);
  assert.equal(isTargetVcChannel(voice("explicit"), { ...settings, vcDmTargetChannelIds: ["explicit"] }, guild), true);
  assert.equal(isTargetVcChannel(voice("gathering", "category"), { ...settings, gatheringVoiceChannelId: "gathering" }, guild), false);
  assert.equal(isTargetVcChannel(voice("waiting", "waiting-category"), { ...settings, waitingVcCategoryId: "waiting-category" }, guild), false);
  assert.equal(isTargetVcChannel(voice("control", "control-category"), { ...settings, vcControlCategoryId: "control-category" }, guild), false);
  assert.equal(isTargetVcChannel(voice("parent", "category"), { ...settings, parentChannelId: "parent" }, guild), false);
});

test("VC DM設定はID配列とチャンネルIDを読み取り時に正規化する", () => {
  const settings = normalizeGuildSettings({
    vcDmEnabled: true,
    vcDmPanelChannelId: "123456789012345678",
    vcDmTargetCategoryId: "123456789012345679",
    vcDmTargetChannelIds: ["123456789012345680", "123456789012345680", "invalid"],
    vcDmExcludedChannelIds: ["123456789012345681", "invalid"],
  });
  assert.equal(settings.vcDmEnabled, true);
  assert.equal(settings.vcDmPanelChannelId, "123456789012345678");
  assert.equal(settings.vcDmTargetCategoryId, "123456789012345679");
  assert.deepEqual(settings.vcDmTargetChannelIds, ["123456789012345680"]);
  assert.deepEqual(settings.vcDmExcludedChannelIds, ["123456789012345681"]);
});

test("/setting vc_dm は管理パネル・対象VC・除外VCを設定できる", () => {
  const vcDm = settingCommand.options.find((option) => option.name === "vc_dm");
  const options = new Map((vcDm?.options ?? []).map((option) => [option.name, option]));
  assert.ok(vcDm);
  assert.equal(options.get("enabled")?.type, 5);
  assert.equal(options.get("panel_channel")?.type, 7);
  assert.equal(options.get("target_category")?.type, 7);
  assert.equal(options.get("target_channels")?.type, 3);
  assert.equal(options.get("excluded_channels")?.type, 3);
});

test("VC DM用Mongoモデルは冪等キーと再起動復元に必要な状態を持つ", () => {
  const memberPaths = VcDmMemberTracking.schema.paths;
  assert.ok(memberPaths.guildId);
  assert.ok(memberPaths.userId);
  assert.ok(memberPaths.firstValidVcAt);
  assert.ok(memberPaths.newDmRecordId);
  assert.ok(memberPaths.inactiveDmRecordId);
  assert.ok(memberPaths.manualValidVcConfirmedAt);
  assert.ok(memberPaths.newDmStatus.enumValues.includes("unconfirmed"));
  assert.ok(memberPaths.newDmStatus.enumValues.includes("skipped_participated"));
  assert.ok(memberPaths.inactiveDmStatus.enumValues.includes("dm_unavailable"));
  assert.ok(VcDmReminder.schema.paths.targetEventAt);
  assert.ok(VcDmReminder.schema.paths.confirmationMessageId);
  assert.ok(VcDmDailyRun.schema.paths.jstDate);
  assert.ok(VcDmMigration.schema.paths.processedCount);
  assert.ok(VcDmPanel.schema.paths.messageIds);
  const memberIndexes = VcDmMemberTracking.schema.indexes();
  assert.ok(memberIndexes.some(([fields, options]) => fields.newDmRecordId === 1 && options?.partialFilterExpression?.newDmRecordId));
  assert.ok(memberIndexes.some(([fields, options]) => fields.inactiveDmRecordId === 1 && options?.partialFilterExpression?.inactiveDmRecordId));
  for (const model of [VcDmMemberTracking, VcDmReminder, VcDmDailyRun, VcDmMigration, VcDmPanel]) {
    assert.ok(model.schema.indexes().some(([fields, options]) => options?.unique && Object.keys(fields).length >= 1));
  }
});

test("手動除外解除は初期移行基準を消し、実参加歴があれば最終参加を復元する", () => {
  const source = readFile(new URL("../src/vc-dm-store.js", import.meta.url), "utf8");
  return source.then((contents) => {
    assert.match(contents, /inactiveBaselineAt: 1/);
    assert.match(contents, /legacyBaselineAt: 1/);
    assert.match(contents, /inactiveCycleKey: `vc:\$\{participationTimestamp\.toISOString\(\)\}`/);
    assert.match(contents, /newDmStatus: "skipped_participated"/);
  });
});

test("新規7日DM後も実参加歴・移行基準がなければ30日DMの基準を持たない", () => {
  const afterUnexclude = {
    firstValidVcAt: null,
    lastValidVcAt: null,
    inactiveBaselineAt: null,
  };
  assert.equal(getInactivityReference(afterUnexclude), null);
  const lastValidVcAt = new Date("2026-08-01T08:00:00.000Z");
  assert.equal(
    getInactivityReference({ lastValidVcAt, inactiveBaselineAt: new Date("2026-07-01T08:00:00.000Z") }).toISOString(),
    lastValidVcAt.toISOString(),
  );
});

test("必須設定不足の日次処理はDMを開始せず、運用ログへ停止理由を出す", async () => {
  const logs = [];
  const service = createVcDmService({
    client: { guilds: { cache: new Map() } },
    getGuildSettings: async () => ({
      vcDmEnabled: true,
      vcDmPanelChannelId: "123456789012345678",
      vcDmTargetChannelIds: [],
      vcDmTargetCategoryId: null,
      kokuchiEventTime: "21:00",
      kokuchiEventTimeConfigured: true,
    }),
    sendOperationalLog: async ({ content }) => logs.push(content),
    storeOverrides: {
      claimVcDmDailyRun: async () => ({ status: "processing" }),
      stopVcDmDailyRun: async (args) => args,
    },
    logger: { error() {}, warn() {} },
  });
  try {
    const result = await service.runDailyForGuild({ id: "guild-config-test" });
    assert.equal(result.status, "skipped_config");
    assert.match(logs[0], /target_vc_missing/);
  } finally {
    service.shutdown();
  }
});

test("DM送信後の保存失敗はunconfirmedにし、長期不参加の失敗は同じ周期で再試行できる", async () => {
  const source = await readFile(new URL("../src/vc-dm-service.js", import.meta.url), "utf8");
  assert.match(source, /let sent = false;[\s\S]*?status: "unconfirmed"/);
  assert.match(source, /record\.inactiveDmCycleKey !== cycleKey \|\| record\.inactiveDmStatus === "failed"/);
  assert.match(source, /claimNewVcDm[\s\S]*?member\.send/);
  assert.match(source, /claimInactiveVcDm[\s\S]*?member\.send/);
});

test("移行再開時は最初に保存した実装日時を維持する", () => {
  const initial = new Date("2026-08-01T08:00:00.000Z");
  const resumed = getVcDmMigrationImplementationAt({ state: { implementationAt: initial } }, new Date("2026-08-05T08:00:00.000Z"));
  assert.equal(resumed.toISOString(), initial.toISOString());
});

test("管理者除外の30日基準は導入時既存メンバーだけに設定する", () => {
  const implementationAt = new Date("2026-08-01T08:00:00.000Z");
  const migration = { version: 1, implementationAt };
  assert.equal(
    getVcDmManualBaselineAt({ migrationVersion: 1, joinedAt: new Date("2026-07-28T08:00:00.000Z") }, migration).toISOString(),
    implementationAt.toISOString(),
  );
  assert.equal(
    getVcDmManualBaselineAt({ migrationVersion: undefined, joinedAt: new Date("2026-08-10T08:00:00.000Z") }, migration),
    undefined,
  );
});

test("リマインダー確認メッセージは別DM送信・重複claim・無効化停止の経路を持つ", async () => {
  const source = await readFile(new URL("../src/vc-dm-service.js", import.meta.url), "utf8");
  assert.match(source, /interaction\.channel\.send\(\{/);
  assert.doesNotMatch(source, /confirmationMessageId: interaction\.message\?\.id/);
  assert.match(source, /claimVcDmReminderConfirmation/);
  assert.match(source, /clearReminderTimersForGuild\(guild\.id\)/);
  assert.match(source, /settings\?\.vcDmEnabled !== true/);
  assert.match(source, /processReminder\(reminder\.recordId, reminder\)/);
});

test("リマインダー確認claimには永続leaseと再起動復元用フィールドがある", () => {
  assert.ok(VcDmReminder.schema.paths.confirmationLeaseUntil);
  assert.ok(VcDmReminder.schema.paths.confirmationMessageId);
  assert.ok(VcDmReminder.schema.indexes().some(([fields, options]) => options?.unique && fields.recordId === 1));
});

test("次回イベントは月跨ぎ・年跨ぎの火曜土曜境界を正しく扱う", () => {
  assert.equal(
    getNextVcDmEventAt(new Date("2026-01-31T13:00:00.000Z"), "21:00").toISOString(),
    "2026-02-03T12:00:00.000Z",
  );
  assert.equal(
    getNextVcDmEventAt(new Date("2026-12-31T13:00:00.000Z"), "21:00").toISOString(),
    "2027-01-02T12:00:00.000Z",
  );
});

test("パネル分割は全候補を保持し、操作コンポーネントを構成する", () => {
  const blocks = Array.from({ length: 12 }, (_, index) => ({
    userId: String(100000000000000000 + index),
    block: `${index}: ${"x".repeat(250)}`,
  }));
  const pages = splitCandidateBlocks(blocks, 700);
  assert.ok(pages.length > 1);
  assert.deepEqual(pages.flat().map((item) => item.userId), blocks.map((item) => item.userId));
  const components = buildPanelComponents("panel-record", { hasCandidates: true });
  assert.equal(components.length, 3);
  assert.equal(components[0].toJSON().components[0].type, 5);
});

test("常駐パネルのギルド単位Mongo leaseは競合中の更新を一つに制限する", async () => {
  const held = new Set();
  const acquireMongoLease = async (lockKey) => {
    if (held.has(lockKey)) return null;
    held.add(lockKey);
    return { lockKey, ownerId: "test-owner" };
  };
  const releaseMongoLease = async ({ lockKey }) => {
    held.delete(lockKey);
  };
  let releaseFirst;
  const firstStarted = new Promise((resolve) => {
    const first = withVcDmPanelLease({
      guildId: "guild-panel-test",
      acquireMongoLease,
      releaseMongoLease,
      callback: async () => {
        resolve();
        await new Promise((release) => { releaseFirst = release; });
        return { status: "updated" };
      },
    });
    void first;
  });
  await firstStarted;
  const competing = await withVcDmPanelLease({
    guildId: "guild-panel-test",
    acquireMongoLease,
    releaseMongoLease,
    callback: async () => ({ status: "updated" }),
  });
  assert.equal(competing.status, "busy");
  releaseFirst();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(held.size, 0);
  assert.ok(VcDmPanel.schema.indexes().some(([fields, options]) => options?.unique && fields.guildId === 1));
});

test("new VC participation storage is atomic and repairs legacy records", async () => {
  const source = await readFile(new URL("../src/vc-dm-store.js", import.meta.url), "utf8");
  assert.match(source, /firstValidVcAt:\s*\{\s*\$ifNull/);
  assert.match(source, /repairVcDmParticipationRecords/);
  assert.match(source, /lastValidVcAt:\s*null/);
  assert.doesNotMatch(source, /const initialized = await asLean\(VcDmMemberTracking\.findOneAndUpdate/);
});

test("target validation, settings-state protection, and panel retry are implemented", async () => {
  const serviceSource = await readFile(new URL("../src/vc-dm-service.js", import.meta.url), "utf8");
  const panelSource = await readFile(new URL("../src/vc-dm-panel-service.js", import.meta.url), "utf8");
  assert.match(serviceSource, /validateVcDmTargetConfiguration/);
  const settingsHandler = serviceSource.slice(
    serviceSource.indexOf("async function onSettingsChanged"),
    serviceSource.indexOf("async function handleReminderRegistration"),
  );
  assert.doesNotMatch(settingsHandler, /restoreReminders\(\)/);
  assert.doesNotMatch(settingsHandler, /runDailyForGuild\(/);
  assert.match(panelSource, /withVcDmPanelLeaseRetry/);
  assert.match(panelSource, /PANEL_RECOVERY_DELAY_MS/);
});

test("valid participation treats either timestamp as authoritative and updates first atomically", () => {
  const validAt = new Date("2026-08-03T08:00:00.000Z");
  assert.equal(hasValidVcParticipation({ firstValidVcAt: null, lastValidVcAt: validAt }), true);
  assert.equal(hasValidVcParticipation({ firstValidVcAt: validAt, lastValidVcAt: null }), true);
  assert.equal(hasValidVcParticipation({ firstValidVcAt: "legacy-invalid", lastValidVcAt: null }), true);
  assert.equal(hasValidVcParticipation({ firstValidVcAt: null, lastValidVcAt: null }), false);

  const pipeline = buildVcDmParticipationUpdatePipeline(validAt);
  assert.deepEqual(pipeline[0].$set.newDmStatus, { $ifNull: ["$newDmStatus", "pending"] });
  assert.deepEqual(pipeline[0].$set.firstValidVcAt, { $ifNull: ["$firstValidVcAt", validAt] });
  assert.equal(pipeline[0].$set.lastValidVcAt, validAt);
  assert.deepEqual(pipeline[1], { $unset: ["inactiveDmRecordId"] });
  const repair = buildVcDmParticipationRepairPipeline();
  assert.deepEqual(repair[0].$set.firstValidVcAt, { $ifNull: ["$firstValidVcAt", "$lastValidVcAt"] });
});

test("daily processing fails closed when a configured target is missing or not viewable", async () => {
  const guildId = "guild-target-validation";
  const settings = {
    vcDmEnabled: true,
    vcDmPanelChannelId: "panel-channel",
    vcDmTargetChannelIds: ["target-channel"],
    vcDmTargetCategoryId: null,
    kokuchiEventTime: "21:00",
    kokuchiEventTimeConfigured: true,
  };
  const channels = new Map();
  const guild = {
    id: guildId,
    members: { me: { id: "bot" } },
    channels: { cache: channels, fetch: async (id) => channels.get(id) ?? null },
  };
  const logs = [];
  const service = createVcDmService({
    client: { guilds: { cache: new Map([[guildId, guild]]) } },
    getGuildSettings: async () => settings,
    sendOperationalLog: async ({ content }) => logs.push(content),
    storeOverrides: {
      claimVcDmDailyRun: async () => ({ status: "processing" }),
      stopVcDmDailyRun: async (args) => args,
    },
    logger: { error() {}, warn() {} },
  });
  try {
    const missing = await service.runDailyForGuild(guild);
    assert.equal(missing.status, "skipped_config");
    assert.match(missing.reason, /target_vc_not_found/);
    assert.ok(logs.some((content) => content.includes("skipped_config")));

    channels.set("target-channel", {
      id: "target-channel",
      guildId,
      type: ChannelType.GuildVoice,
      isVoiceBased: () => true,
      permissionsFor: () => ({ has: () => false }),
    });
    const notViewable = await service.runDailyForGuild(guild);
    assert.equal(notViewable.status, "skipped_config");
    assert.match(notViewable.reason, /target_vc_not_viewable/);
  } finally {
    service.shutdown();
  }
});

test("target category validation checks guild, type, child existence, and visibility", async () => {
  const guildId = "guild-category-validation";
  const bot = { id: "bot" };
  const channels = new Map();
  const guild = {
    id: guildId,
    members: { me: bot },
    channels: {
      cache: channels,
      fetch: async (id) => id ? channels.get(id) ?? null : channels,
    },
  };
  const category = {
    id: "category",
    guildId,
    type: ChannelType.GuildCategory,
    permissionsFor: () => ({ has: () => true }),
  };
  const child = {
    id: "voice-child",
    guildId,
    parentId: category.id,
    type: ChannelType.GuildVoice,
    isVoiceBased: () => true,
    permissionsFor: () => ({ has: () => true }),
  };
  channels.set(category.id, category);
  channels.set(child.id, child);
  const settings = { vcDmTargetCategoryId: category.id, vcDmTargetChannelIds: [], vcDmExcludedChannelIds: [] };
  assert.deepEqual(await validateVcDmTargetConfiguration(guild, settings), []);

  channels.delete(child.id);
  const noChild = await validateVcDmTargetConfiguration(guild, settings);
  assert.ok(noChild.some((issue) => issue.code === "target_category_no_voice"));

  channels.set("wrong", { id: "wrong", guildId: "other-guild", type: ChannelType.GuildCategory });
  const wrongType = await validateVcDmTargetConfiguration(guild, { ...settings, vcDmTargetCategoryId: "wrong" });
  assert.ok(wrongType.some((issue) => issue.code === "target_category_wrong_guild"));
});

test("settings changes reschedule without canceling send state, and panel lease retries", async () => {
  const serviceSource = await readFile(new URL("../src/vc-dm-service.js", import.meta.url), "utf8");
  const rescheduler = serviceSource.slice(
    serviceSource.indexOf("async function reschedulePendingRemindersForEventTime"),
    serviceSource.indexOf("async function syncReminderTimersForGuild"),
  );
  assert.doesNotMatch(rescheduler, /cancelVcDmReminder\(/);

  let attempts = 0;
  let callbackCalls = 0;
  const retried = await withVcDmPanelLeaseRetry({
    guildId: "guild-panel-retry",
    acquireMongoLease: async () => {
      attempts += 1;
      return attempts < 4 ? null : { lockKey: "panel", ownerId: "owner" };
    },
    releaseMongoLease: async () => {},
    sleep: async () => {},
    callback: async () => {
      callbackCalls += 1;
      return { status: "updated" };
    },
  });
  assert.equal(retried.status, "updated");
  assert.equal(attempts, 4);
  assert.equal(callbackCalls, 1);

  let exhausted = 0;
  const busy = await withVcDmPanelLeaseRetry({
    guildId: "guild-panel-retry-busy",
    acquireMongoLease: async () => null,
    sleep: async () => {},
    onExhausted: async ({ attempts: count }) => { exhausted = count; },
    callback: async () => ({ status: "updated" }),
  });
  assert.equal(busy.status, "busy");
  assert.equal(exhausted, 4);

  const panelBody = getPanelBody({
    candidates: { totalCount: 0, pageItems: [] },
    updatedAt: new Date("2026-08-03T08:00:00.000Z"),
    pageNumber: 1,
    pageCount: 1,
    configurationIssues: [{ code: "target_vc_not_viewable", message: "target is hidden" }],
  });
  assert.match(panelBody, /VC DM STOPPED/);
  assert.match(panelBody, /target_vc_not_viewable/);
});

test("日次無効化・パネル整理・ハッシュ抑止・運用ステータス反映の受け入れ条件を実装する", async () => {
  const serviceSource = await readFile(new URL("../src/vc-dm-service.js", import.meta.url), "utf8");
  const panelSource = await readFile(new URL("../src/vc-dm-panel-service.js", import.meta.url), "utf8");
  assert.match(serviceSource, /latestSettingsForClaim/);
  assert.match(serviceSource, /stopVcDmDailyRun/);
  assert.match(serviceSource, /requestOperationalStatusRefresh/);
  assert.match(serviceSource, /この操作パネルは古いため利用できません/);
  assert.match(serviceSource, /panelService\.removePanel\(guild, "settings-disabled"\)/);
  assert.match(panelSource, /async function removePanel/);
  assert.match(panelSource, /status: "unchanged"/);
  assert.match(panelSource, /includeUpdatedAt/);
});

test("再加入者の有効参加記録は在籍状態を同一原子更新で復元する", () => {
  const validAt = new Date("2026-08-03T08:00:00.000Z");
  const pipeline = buildVcDmParticipationUpdatePipeline(validAt, { joinedAt: new Date("2026-08-01T08:00:00.000Z") });
  assert.equal(pipeline[0].$set.isMember, true);
  assert.equal(pipeline[0].$set.leftAt, null);
  assert.equal(pipeline[0].$set.lastValidVcAt, validAt);
  assert.deepEqual(pipeline[0].$set.firstValidVcAt, { $ifNull: ["$firstValidVcAt", validAt] });
  assert.deepEqual(pipeline[0].$set.trackingStartedAt, { $ifNull: ["$trackingStartedAt", new Date("2026-08-01T08:00:00.000Z")] });
  assert.ok(pipeline.some((stage) => stage.$unset?.includes("inactiveDmRecordId")));
});

function createPanelBehaviorHarness({ deleteFails = false, nowProvider = () => new Date("2026-08-03T08:00:00.000Z"), beforeSend = null } = {}) {
  const guildId = "guild-panel-behavior";
  const messages = new Map();
  const state = { deleteFails, nextId: 1, editCount: 0, deleteCount: 0 };
  const makeChannel = (id, channelMessages = new Map()) => {
    const channel = {
      id,
      guildId,
      type: ChannelType.GuildText,
      messages: {
        fetch: async (query) => {
          if (typeof query === "string") {
            const message = channelMessages.get(query);
            if (!message) throw new Error("message not found");
            return message;
          }
          return new Map(channelMessages);
        },
      },
      send: async ({ content, components }) => {
        await beforeSend?.();
        const message = {
          id: `panel-message-${state.nextId++}`,
          channelId: id,
          content,
          components,
          author: { id: "bot" },
          createdTimestamp: Date.now(),
          edit: async ({ content: nextContent, components: nextComponents }) => {
            state.editCount += 1;
            message.content = nextContent;
            message.components = nextComponents;
            return message;
          },
          delete: async () => {
            state.deleteCount += 1;
            if (state.deleteFails) throw new Error("simulated Discord delete failure");
            channelMessages.delete(message.id);
          },
        };
        channelMessages.set(message.id, message);
        return message;
      },
    };
    return channel;
  };
  const channel = makeChannel("old-panel", messages);
  const channels = new Map([[channel.id, channel]]);
  const settings = {
    vcDmEnabled: true,
    vcDmPanelChannelId: channel.id,
    vcDmTargetChannelIds: ["target-voice"],
    vcDmTargetCategoryId: null,
    vcDmExcludedChannelIds: [],
    kokuchiEventTime: "21:00",
    kokuchiEventTimeConfigured: true,
  };
  let panel = null;
  const guild = {
    id: guildId,
    members: { me: null, cache: new Map() },
    channels: {
      cache: channels,
      fetch: async (channelId) => channels.get(channelId) ?? null,
    },
  };
  const service = createVcDmPanelService({
    getGuildSettings: async () => settings,
    client: { user: { id: "bot" } },
    getRuntimeConfigurationIssues: async () => [],
    storeOverrides: {
      getVcDmPanel: async () => panel,
      listVcDmMembers: async () => [],
      saveVcDmPanel: async (next) => {
        panel = { ...next };
        return panel;
      },
      deleteVcDmPanel: async () => {
        const previous = panel;
        panel = null;
        return previous;
      },
    },
    logger: { error() {}, warn() {} },
    now: nowProvider,
  });
  return { service, guild, channel, channels, messages, settings, state, makeChannel, getPanel: () => panel };
}

test("パネルチャンネル変更後は旧パネルを削除し、削除失敗でも旧ボタンを拒否する", async () => {
  const successful = createPanelBehaviorHarness();
  try {
    const first = await successful.service.ensurePanel(successful.guild, "initial");
    const oldMessageId = first.panel.messageIds[0];
    const newChannel = successful.makeChannel("new-panel");
    successful.channels.set(newChannel.id, newChannel);
    successful.settings.vcDmPanelChannelId = newChannel.id;
    const changed = await successful.service.ensurePanel(successful.guild, "channel-change");
    assert.equal(changed.status, "updated", changed.error?.message ?? JSON.stringify(changed));
    assert.equal(changed.panel.channelId, "new-panel");
    assert.equal(successful.messages.has(oldMessageId), false);
  } finally {
    successful.service.shutdown();
  }

  const failed = createPanelBehaviorHarness({ deleteFails: true });
  try {
    const first = await failed.service.ensurePanel(failed.guild, "initial");
    const oldMessageId = first.panel.messageIds[0];
    const newChannel = failed.makeChannel("new-panel");
    failed.channels.set(newChannel.id, newChannel);
    failed.settings.vcDmPanelChannelId = newChannel.id;
    const changed = await failed.service.ensurePanel(failed.guild, "channel-change");
    assert.equal(changed.panel.channelId, "new-panel");
    assert.equal(failed.messages.has(oldMessageId), true);
    assert.equal(
      isCurrentVcDmPanelInteraction({ channelId: failed.channel.id, message: { id: oldMessageId } }, changed.panel, changed.panel.recordId),
      false,
    );
    assert.equal(
      isCurrentVcDmPanelInteraction({ channelId: "new-panel", message: { id: changed.panel.messageIds[0] } }, changed.panel, changed.panel.recordId),
      true,
    );
  } finally {
    failed.service.shutdown();
  }
});

test("表示状態に変更がなければ現在時刻が変わってもパネルを編集しない", async () => {
  let tick = 0;
  const harness = createPanelBehaviorHarness({
    nowProvider: () => new Date(new Date("2026-08-03T08:00:00.000Z").getTime() + tick++ * 60_000),
  });
  try {
    const first = await harness.service.ensurePanel(harness.guild, "initial");
    const second = await harness.service.ensurePanel(harness.guild, "hourly-reconcile");
    assert.equal(second.status, "unchanged");
    assert.equal(harness.state.editCount, 0);
    assert.equal(second.panel.lastRenderedHash, first.panel.lastRenderedHash);
    await harness.service.removePanel(harness.guild, "settings-disabled");
    assert.equal(harness.messages.size, 0);
  } finally {
    harness.service.shutdown();
  }
});

test("パネル削除は進行中の更新より後に確定し、無効化後の再作成を防ぐ", async () => {
  let releaseSend;
  let sendStartedResolve;
  const sendGate = new Promise((resolve) => { releaseSend = resolve; });
  const sendStarted = new Promise((resolve) => { sendStartedResolve = resolve; });
  const harness = createPanelBehaviorHarness({ beforeSend: async () => { sendStartedResolve(); await sendGate; } });
  const update = harness.service.ensurePanel(harness.guild, "initial");
  await sendStarted;
  harness.settings.vcDmEnabled = false;
  const removal = harness.service.removePanel(harness.guild, "settings-disabled");
  releaseSend();
  const [updated, removed] = await Promise.all([update, removal]);
  assert.equal(updated.status, "updated");
  assert.equal(removed.status, "removed");
  assert.equal(harness.getPanel(), null);
  assert.equal(harness.messages.size, 0);
  harness.service.shutdown();
});

test("パネルの意味状態が同じでも重複パネルを掃除し、内容の外部改変は再描画する", async () => {
  const harness = createPanelBehaviorHarness();
  try {
    const first = await harness.service.ensurePanel(harness.guild, "initial");
    const duplicate = await harness.channel.send({ content: first.panel ? getPanelBody({
      candidates: { totalCount: 0, pageItems: [] },
      updatedAt: new Date("2026-08-03T08:00:00.000Z"),
      pageNumber: 1,
      pageCount: 1,
    }) : "<!-- vc-dm-panel:v1 -->", components: [] });
    const unchanged = await harness.service.ensurePanel(harness.guild, "duplicate-reconcile");
    assert.equal(unchanged.status, "unchanged");
    assert.equal(harness.messages.has(duplicate.id), false);
    assert.equal(harness.messages.size, 1);
    harness.getPanel().lastError = "transient panel error";
    const recovered = await harness.service.ensurePanel(harness.guild, "error-state-reconcile");
    assert.equal(recovered.status, "unchanged");
    assert.equal(harness.getPanel().lastError, null);

    const current = harness.messages.get(first.panel.messageIds[0]);
    current.content = `${current.content}\n外部改変`;
    const repaired = await harness.service.ensurePanel(harness.guild, "drift-reconcile");
    assert.equal(repaired.status, "updated");
    assert.equal(harness.state.editCount, 1);
  } finally {
    harness.service.shutdown();
  }
});

test("日次DM中の機能無効化は後続利用者をclaimせず、claim済み送信だけを完了する", async () => {
  const guildId = "guild-daily-disable";
  const nowValue = new Date("2026-08-03T09:00:00.000Z");
  let enabled = true;
  let claimCount = 0;
  let sendCount = 0;
  let stopped;
  const refreshReasons = [];
  const target = {
    id: "target-voice",
    guildId,
    type: ChannelType.GuildVoice,
    isVoiceBased: () => true,
    permissionsFor: () => ({ has: () => true }),
  };
  const records = ["user-1", "user-2"].map((userId) => ({
    guildId,
    userId,
    isMember: true,
    joinedAt: new Date("2026-07-01T00:00:00.000Z"),
    firstValidVcAt: null,
    lastValidVcAt: null,
    manualValidVcConfirmedAt: null,
    newDmStatus: "pending",
    inactiveDmStatus: "pending",
    inactiveCycleKey: null,
    inactiveDmCycleKey: null,
  }));
  const members = new Map(records.map((record) => [record.userId, {
    id: record.userId,
    joinedAt: record.joinedAt,
    user: { bot: false },
    send: async () => { sendCount += 1; },
  }]));
  const guild = {
    id: guildId,
    members: {
      me: { id: "bot" },
      fetch: async (userId) => members.get(userId),
    },
    channels: {
      cache: new Map([[target.id, target]]),
      fetch: async (channelId) => channelId === target.id ? target : null,
    },
  };
  const settings = {
    vcDmPanelChannelId: "panel",
    vcDmTargetChannelIds: [target.id],
    vcDmTargetCategoryId: null,
    vcDmExcludedChannelIds: [],
    kokuchiEventTime: "21:00",
    kokuchiEventTimeConfigured: true,
  };
  const service = createVcDmService({
    client: { user: { id: "bot" }, guilds: { cache: new Map([[guild.id, guild]]) } },
    getGuildSettings: async () => ({ ...settings, vcDmEnabled: enabled }),
    sendOperationalLog: async () => {},
    requestOperationalStatusRefresh: async (_id, reason) => { refreshReasons.push(reason); },
    now: () => new Date(nowValue),
    storeOverrides: {
      claimVcDmDailyRun: async () => ({ status: "processing" }),
      listVcDmMembers: async () => records,
      claimNewVcDm: async ({ userId }) => {
        claimCount += 1;
        enabled = false;
        return { userId, status: "processing" };
      },
      updateNewVcDmResult: async ({ status }) => ({ status }),
      stopVcDmDailyRun: async (args) => {
        stopped = args;
        return { status: "stopped", ...args };
      },
      finishVcDmDailyRun: async () => ({ status: "completed" }),
      failVcDmDailyRun: async () => ({ status: "failed" }),
      getVcDmPanel: async () => null,
      saveVcDmPanel: async () => null,
    },
    logger: { error() {}, warn() {} },
  });
  try {
    const outcome = await service.runDailyForGuild(guild);
    assert.equal(outcome.status, "stopped");
    assert.equal(outcome.reason, "feature_disabled_during_daily");
    assert.equal(claimCount, 1);
    assert.equal(sendCount, 1);
    assert.equal(stopped.reason, "feature_disabled_during_daily");
    assert.equal(stopped.result.settingsChanged, true);
    assert.equal(refreshReasons.length, 1);
    assert.match(refreshReasons[0], /stopped/);
  } finally {
    service.shutdown();
  }
});

test("停止処理は既にclaim済みの日次DM送信とDB確定を待ってから完了する", async () => {
  const guildId = "guild-shutdown-waits-daily";
  let sendStartedResolve;
  let releaseSend;
  const sendStarted = new Promise((resolve) => { sendStartedResolve = resolve; });
  const sendGate = new Promise((resolve) => { releaseSend = resolve; });
  const target = {
    id: "shutdown-target-voice",
    guildId,
    type: ChannelType.GuildVoice,
    isVoiceBased: () => true,
    permissionsFor: () => ({ has: () => true }),
  };
  const member = {
    id: "shutdown-dm-member",
    joinedAt: new Date("2026-07-01T00:00:00.000Z"),
    user: { bot: false },
    send: async () => { sendStartedResolve(); await sendGate; },
  };
  const guild = {
    id: guildId,
    members: { me: { id: "bot" }, fetch: async () => member },
    channels: { cache: new Map([[target.id, target]]), fetch: async (id) => id === target.id ? target : null },
  };
  const service = createVcDmService({
    client: { user: { id: "bot" }, guilds: { cache: new Map([[guildId, guild]]) } },
    getGuildSettings: async () => ({ vcDmEnabled: true, vcDmPanelChannelId: "panel-channel", vcDmTargetChannelIds: [target.id], vcDmTargetCategoryId: null, vcDmExcludedChannelIds: [], kokuchiEventTime: "21:00", kokuchiEventTimeConfigured: true }),
    now: () => new Date("2026-08-10T09:00:00.000Z"),
    storeOverrides: {
      claimVcDmDailyRun: async () => ({ status: "processing" }),
      listVcDmMembers: async () => [{ guildId, userId: member.id, isMember: true, joinedAt: member.joinedAt, firstValidVcAt: null, lastValidVcAt: null, manualValidVcConfirmedAt: null, newDmStatus: "pending", inactiveDmStatus: "pending" }],
      claimNewVcDm: async () => ({ guildId, userId: member.id, newDmStatus: "processing" }),
      updateNewVcDmResult: async (args) => ({ ...args, newDmStatus: args.status }),
      finishVcDmDailyRun: async () => ({ status: "completed" }),
    },
    logger: { error() {}, warn() {} },
  });
  try {
    const run = service.runDailyForGuild(guild);
    await sendStarted;
    let shutdownFinished = false;
    const shutdown = service.shutdown().then(() => { shutdownFinished = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(shutdownFinished, false);
    releaseSend();
    await run;
    await shutdown;
    assert.equal(shutdownFinished, true);
  } finally {
    await service.shutdown();
  }
});

test("日次の設定不備停止はDB保存後に運用ステータス更新を要求する", async () => {
  const events = [];
  const guild = { id: "guild-daily-config-stop", members: { cache: new Map() }, channels: { cache: new Map() } };
  const service = createVcDmService({
    client: { user: { id: "bot" }, guilds: { cache: new Map([[guild.id, guild]]) } },
    getGuildSettings: async () => ({ vcDmEnabled: true, vcDmPanelChannelId: null, vcDmTargetChannelIds: [], vcDmTargetCategoryId: null, kokuchiEventTime: "21:00", kokuchiEventTimeConfigured: true }),
    requestOperationalStatusRefresh: async () => { events.push("refresh"); },
    storeOverrides: {
      claimVcDmDailyRun: async () => ({ status: "processing" }),
      stopVcDmDailyRun: async (args) => { events.push("db"); return args; },
    },
    logger: { error() {}, warn() {} },
    now: () => new Date("2026-08-03T09:00:00.000Z"),
  });
  try {
    const outcome = await service.runDailyForGuild(guild);
    assert.equal(outcome.status, "skipped_config");
    assert.equal(events[0], "db");
    assert.equal(events[1], "refresh");
    assert.equal(events.length, 2);
  } finally {
    service.shutdown();
  }
});

test("stopped daily runs are visible as a warning in the VC DM operational status", () => {
  assert.equal(getVcDmStatusSeverity({ enabled: true, configValid: true, dailyRun: { status: "stopped" } }), "warning");
  assert.equal(getVcDmStatusSeverity({ enabled: false, configValid: false, dailyRun: { status: "stopped" } }), "disabled");
});

test("機能無効化後に期限を迎えたVoiceStateセッションは有効参加として保存しない", async () => {
  let enabled = true;
  let current = new Date("2026-08-03T00:00:00.000Z");
  let recorded = 0;
  const target = {
    id: "disabled-target-voice",
    guildId: "guild-disabled-session",
    type: ChannelType.GuildVoice,
    isVoiceBased: () => true,
    permissionsFor: () => ({ has: () => true }),
  };
  const member = { id: "member-disabled-session", user: { bot: false }, joinedAt: current, voice: { channelId: target.id, channel: target } };
  const guild = {
    id: target.guildId,
    members: { me: { id: "bot" }, fetch: async () => member },
    channels: { cache: new Map([[target.id, target]]), fetch: async (id) => id === target.id ? target : null },
  };
  const service = createVcDmService({
    client: { user: { id: "bot" }, guilds: { cache: new Map([[guild.id, guild]]) } },
    getGuildSettings: async () => ({ vcDmEnabled: enabled, vcDmTargetChannelIds: [target.id], vcDmTargetCategoryId: null }),
    now: () => new Date(current),
    storeOverrides: {
      getVcDmMember: async () => ({ guildId: guild.id, userId: member.id, isMember: true }),
      recordValidVcParticipation: async () => { recorded += 1; return {}; },
    },
    logger: { error() {}, warn() {} },
  });
  try {
    await service.handleVoiceState({ guild, channelId: null, member }, { guild, channelId: target.id, member });
    enabled = false;
    current = new Date(current.getTime() + 3 * 60 * 1000);
    await service.completeDueVoiceSessions(guild);
    assert.equal(recorded, 0);
  } finally {
    service.shutdown();
  }
});

test("起動時に無効なVC DMの保存済みパネル参照とDiscordメッセージを整理する", async () => {
  const guildId = "guild-startup-disabled-panel";
  const messages = new Map();
  const message = {
    id: "startup-old-panel-message",
    channelId: "startup-old-panel-channel",
    author: { id: "bot" },
    content: "<!-- vc-dm-panel:v1 -->",
    delete: async () => { messages.delete(message.id); },
  };
  messages.set(message.id, message);
  const channel = {
    id: message.channelId,
    messages: { fetch: async (id) => typeof id === "string" ? messages.get(id) ?? null : new Map(messages) },
  };
  const panel = {
    guildId,
    channelId: channel.id,
    messageIds: [message.id],
    recordId: "startup-old-panel-record",
    marker: "<!-- vc-dm-panel:v1 -->",
  };
  let panelReference = panel;
  const guild = {
    id: guildId,
    members: { cache: new Map(), fetch: async () => new Map() },
    channels: { cache: new Map([[channel.id, channel]]), fetch: async (id) => id === channel.id ? channel : null },
  };
  const refreshReasons = [];
  const service = createVcDmService({
    client: { user: { id: "bot" }, guilds: { cache: new Map([[guildId, guild]]) } },
    getGuildSettings: async () => ({ vcDmEnabled: false }),
    requestOperationalStatusRefresh: async (_guildId, reason) => refreshReasons.push(reason),
    storeOverrides: {
      getVcDmPanel: async () => panelReference,
      deleteVcDmPanel: async () => { const old = panelReference; panelReference = null; return old; },
    },
    logger: { error() {}, warn() {} },
  });
  try {
    await service.restore();
    assert.equal(panelReference, null);
    assert.equal(messages.size, 0);
    assert.ok(refreshReasons.some((reason) => reason.includes("startup-disabled")));
  } finally {
    service.shutdown();
  }
});

test("isMember:falseの再加入者はguildMemberAdd更新前のVoiceStateでも原子的参加記録の対象になる", async () => {
  const guildId = "guild-rejoin-before-member-add";
  let current = new Date("2026-08-03T00:00:00.000Z");
  let recorded;
  let joinedUpdateCount = 0;
  const target = {
    id: "target-voice",
    guildId,
    type: ChannelType.GuildVoice,
    isVoiceBased: () => true,
    permissionsFor: () => ({ has: () => true }),
  };
  const member = {
    id: "rejoined-user",
    joinedAt: new Date("2026-08-02T00:00:00.000Z"),
    user: { bot: false },
    voice: { channelId: target.id, channel: target },
  };
  const guild = {
    id: guildId,
    members: {
      me: { id: "bot" },
      fetch: async () => member,
    },
    channels: {
      cache: new Map([[target.id, target]]),
      fetch: async (id) => id === target.id ? target : null,
    },
  };
  const service = createVcDmService({
    client: { user: { id: "bot" }, guilds: { cache: new Map([[guild.id, guild]]) } },
    getGuildSettings: async () => ({ vcDmEnabled: true, vcDmPanelChannelId: "panel-channel", vcDmTargetChannelIds: [target.id], vcDmTargetCategoryId: null, vcDmExcludedChannelIds: [], kokuchiEventTime: "21:00", kokuchiEventTimeConfigured: true }),
    now: () => new Date(current),
    storeOverrides: {
      getVcDmMember: async () => ({ guildId, userId: member.id, isMember: false, leftAt: new Date("2026-08-01T00:00:00.000Z") }),
      markVcDmMemberJoined: async () => { joinedUpdateCount += 1; },
      recordValidVcParticipation: async (args) => {
        recorded = args;
        return { isMember: true, firstValidVcAt: args.validAt, lastValidVcAt: args.validAt };
      },
    },
    logger: { error() {}, warn() {} },
  });
  try {
    await service.handleVoiceState(
      { guild, channelId: null, member },
      { guild, channelId: target.id, member },
    );
    current = new Date(current.getTime() + 3 * 60 * 1000);
    await service.completeDueVoiceSessions(guild);
    assert.equal(joinedUpdateCount, 0);
    assert.ok(recorded);
    assert.equal(recorded.guildId, guildId);
    assert.equal(recorded.userId, member.id);
    const restored = { firstValidVcAt: null, lastValidVcAt: recorded.validAt, newDmStatus: "pending" };
    assert.equal(hasValidVcParticipation(restored), true);
  } finally {
    service.shutdown();
  }
});

test("再加入者の有効VC参加履歴は7日DM候補から除外される", async () => {
  const guildId = "guild-rejoin-not-new-dm";
  const target = {
    id: "rejoin-target-voice",
    guildId,
    type: ChannelType.GuildVoice,
    isVoiceBased: () => true,
    permissionsFor: () => ({ has: () => true }),
  };
  const member = { id: "rejoin-user-no-new-dm", user: { bot: false }, joinedAt: new Date("2026-07-01T00:00:00.000Z"), send: async () => {} };
  const guild = {
    id: guildId,
    members: { me: { id: "bot" }, fetch: async () => member },
    channels: { cache: new Map([[target.id, target]]), fetch: async (id) => id === target.id ? target : null },
  };
  let claimCount = 0;
  const service = createVcDmService({
    client: { user: { id: "bot" }, guilds: { cache: new Map([[guildId, guild]]) } },
    getGuildSettings: async () => ({ vcDmEnabled: true, vcDmPanelChannelId: "panel-channel", vcDmTargetChannelIds: [target.id], vcDmTargetCategoryId: null, vcDmExcludedChannelIds: [], kokuchiEventTime: "21:00", kokuchiEventTimeConfigured: true }),
    now: () => new Date("2026-08-10T09:00:00.000Z"),
    storeOverrides: {
      claimVcDmDailyRun: async () => ({ status: "processing" }),
      listVcDmMembers: async () => [{
        guildId,
        userId: member.id,
        isMember: true,
        joinedAt: member.joinedAt,
        firstValidVcAt: new Date("2026-08-03T00:00:00.000Z"),
        lastValidVcAt: new Date("2026-08-03T00:00:00.000Z"),
        manualValidVcConfirmedAt: null,
        newDmStatus: "pending",
        inactiveDmStatus: "pending",
      }],
      claimNewVcDm: async () => { claimCount += 1; return null; },
      finishVcDmDailyRun: async () => ({ status: "completed" }),
    },
    logger: { error() {}, warn() {} },
  });
  try {
    const outcome = await service.runDailyForGuild(guild);
    assert.equal(outcome.status, "completed");
    assert.equal(claimCount, 0);
  } finally {
    service.shutdown();
  }
});
