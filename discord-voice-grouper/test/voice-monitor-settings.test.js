import { readBotImplementationSource } from "./source-under-test.js";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { settingCommand } from "../src/commands.js";
import { createVoiceSplitFeature } from "../src/features/voice-split.js";
import { normalizeGuildSettings } from "../src/settings-store.js";
import { formatVoiceReminderParentChannelMentions, getVoiceReminderParentChannelIds } from "../src/voice-reminder-settings.js";

test("voice reminder parent settings normalize to a deduplicated array", () => {
  assert.deepEqual(
    normalizeGuildSettings({ voiceReminderParentChannelId: "parent-a" }).voiceReminderParentChannelIds,
    ["parent-a"],
  );
  assert.deepEqual(
    normalizeGuildSettings({ voiceReminderParentChannelIds: ["parent-a", "parent-a", "parent-b"] }).voiceReminderParentChannelIds,
    ["parent-a", "parent-b"],
  );
  assert.equal(
    normalizeGuildSettings({ voiceReminderParentChannelIds: ["parent-a", "parent-b"] }).voiceReminderParentChannelId,
    "parent-a",
  );
});

test("/setting show向けのVC集合親VC表示は設定された全チャンネルを保持する", () => {
  const settings = {
    voiceReminderParentChannelIds: ["parent-a", "parent-b", "parent-a", "parent-c"],
    voiceReminderParentChannelId: "parent-a",
  };
  assert.deepEqual(getVoiceReminderParentChannelIds(settings), ["parent-a", "parent-b", "parent-c"]);
  assert.equal(
    formatVoiceReminderParentChannelMentions(settings),
    "<#parent-a> <#parent-b> <#parent-c>",
  );
  assert.equal(
    formatVoiceReminderParentChannelMentions({ voiceReminderParentChannelIds: [], voiceReminderParentChannelId: "legacy-parent" }),
    "<#legacy-parent>",
  );

  const feature = createVoiceSplitFeature({
    DEFAULT_NOTICE_WAIT_MINUTES: 25,
    DEFAULT_ROLE_REMOVE_WAIT_MINUTES: 150,
    DEFAULT_TRANSFER_WAIT_SECONDS: 30,
    DEFAULT_WAITING_VC_NAME: "途中参加部屋",
    getCallWaitIntervalMinutes: () => 30,
    getCallWaitNoticeChannelId: () => null,
    getCallWaitPromptChannelId: () => null,
    getKokuchiAnnouncementChannelId: () => null,
    getOteboQuickConfirmSeconds: () => 30,
    normalizeKokuchiEventTime: (value) => value,
  });
  assert.match(
    feature.formatCurrentSettings(settings),
    /対象VC親: <#parent-a> <#parent-b> <#parent-c>/,
  );
});

test("zatudan exposes multiple PB parent VC selectors", () => {
  const zatudan = settingCommand.options.find((option) => option.name === "zatudan");
  const optionNames = zatudan?.options?.map((option) => option.name) ?? [];
  assert.deepEqual(
    optionNames.filter((name) => name.startsWith("voice_reminder_parent_channel")),
    [
      "voice_reminder_parent_channel",
      "voice_reminder_parent_channel_2",
      "voice_reminder_parent_channel_3",
      "voice_reminder_parent_channel_4",
      "voice_reminder_parent_channel_5",
    ],
  );
});

test("voice monitor admission uses the configured child category instead of active split sessions", async () => {
  const source = await readBotImplementationSource();
  const monitorSection = source.slice(
    source.indexOf("async function isVoiceChannelMonitored"),
    source.indexOf("function getVoiceReminderParentChannelIds"),
  );
  assert.match(monitorSection, /return isPbChildVoiceChannel\(guild, settings, voiceChannel\)/);
  assert.doesNotMatch(monitorSection, /SplitProcessSession\.exists/);
  assert.match(source, /const targetCategoryId = settings\.voiceReminderChildCategoryId \?\? settings\.childCategoryId/);
});
