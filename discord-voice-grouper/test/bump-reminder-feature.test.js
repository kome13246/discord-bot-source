import test from "node:test";
import assert from "node:assert/strict";
import { createBumpReminderFeature } from "../src/features/bump-reminder.js";

test("DISBOARD bumpを保存し、Bot以外の実行者だけを対象にする", async () => {
  const saved = [];
  const feature = createBumpReminderFeature({
    client: { channels: { fetch: async () => null } },
    store: {
      saveReminder: async (reminder) => saved.push(reminder),
      getReminders: async () => [],
      deleteReminder: async () => {},
    },
    disboardBotId: "disboard",
    waitMs: 1000,
    now: () => Date.parse("2026-08-06T00:00:00.000Z"),
  });
  await feature.handleMessage({
    id: "message", guildId: "guild", channelId: "channel",
    author: { id: "disboard" }, interaction: { commandName: "bump", user: { id: "user", bot: false } },
    inGuild: () => true,
  });
  assert.equal(saved.length, 1);
  assert.equal(saved[0].dueAt, "2026-08-06T00:00:01.000Z");
  feature.shutdown();
});
