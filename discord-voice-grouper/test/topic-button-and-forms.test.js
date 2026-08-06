import { readBotImplementationSource } from "./source-under-test.js";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { commands } from "../src/commands.js";

test("/kokuchi と /setting splitvc は旧話題オプションを登録しない", () => {
  const kokuchi = commands.find((command) => command.name === "kokuchi");
  const setting = commands.find((command) => command.name === "setting");
  const splitvc = setting?.options?.find((option) => option.name === "splitvc");

  assert.ok(kokuchi);
  assert.equal(kokuchi.options?.some((option) => option.name === "send_topic"), false);
  assert.equal(splitvc?.options?.some((option) => option.name === "post_split_wadai_channel"), false);
});
test("子VC話題ボタンとフォーム転送は指定された表示・通知制御を使う", async () => {
  const source = await readBotImplementationSource();

  assert.match(source, /const SPLIT_RANDOM_TOPIC = "split_random_topic"/);
  assert.match(source, /\$\{SPLIT_RANDOM_TOPIC\}:\$\{childChannel\.id\}/);
  assert.match(source, /下のボタンを押したらランダムに話題が出ます！\\n話題に詰まった時などに使ってみてください！/);
  assert.match(source, /memberVoiceChannelId !== childChannelId/);
  assert.match(source, /randomTopicCooldownByChannel\.set\(childChannelId, Date\.now\(\) \+ 10_000\)/);
  assert.match(source, /`話題：\$\{topic\.text\}`/);
  assert.match(source, /const senderMention = `<@\$\{interaction\.user\.id\}>`/);
  assert.match(source, /users: \[\]/);
  assert.match(source, /会話練習会の話題ボタンに使えるような話題があればぜひ送ってください！/);
});

test("/kokuchi は話題を抽選・保存せず、告知文に話題を含めない", async () => {
  const source = await readBotImplementationSource();
  const kokuchiStart = source.indexOf("async function handleKokuchi");
  const kokuchiEnd = source.indexOf("async function restoreGatheringVcUnlockSchedules");
  const kokuchiSource = source.slice(kokuchiStart, kokuchiEnd);

  assert.doesNotMatch(kokuchiSource, /send_topic|chooseAndStoreKokuchiWadaiTopic|wadaiCurrentTopic|kokuchiTopicEnabled/);
  assert.match(source, /function formatKokuchiMessage\(\{ weekday, overviewChannelId \}\)/);
  assert.doesNotMatch(source, /function sendPostSplitWadaiTopic/);
});

test("子VCの話題パネルは追加メンバーの転送前に設置する", async () => {
  const source = await readBotImplementationSource();

  assert.match(
    source,
    /childChannelIds\.add\(childChannel\.id\);[\s\S]*?sendSplitRandomTopicPanels\([\s\S]*?childChannelIds: \[childChannel\.id\][\s\S]*?for \(const member of group\.slice\(1\)\)/,
  );
  assert.match(
    source,
    /transferWaitingGroupToNewChild[\s\S]*?sendSplitRandomTopicPanels\([\s\S]*?childChannelIds: \[childChannel\.id\][\s\S]*?for \(const member of members\.slice\(1\)\)/,
  );
  assert.doesNotMatch(
    source.slice(source.indexOf('"existing-group"'), source.indexOf("if (waitingMembers.length >= 3)")),
    /sendSplitRandomTopicPanels/,
  );
});
