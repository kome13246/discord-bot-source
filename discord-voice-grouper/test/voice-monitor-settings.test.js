import { readBotImplementationSource } from "./source-under-test.js";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { settingCommand } from "../src/commands.js";
import { normalizeGuildSettings } from "../src/settings-store.js";

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
