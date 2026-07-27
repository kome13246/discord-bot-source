import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { commands } from "../src/commands.js";
import { SplitReview } from "../src/models/split-review.js";
import { SplitReviewDraft } from "../src/models/split-review-draft.js";

test("感想コマンドと送信先オプションが登録されている", () => {
  const show = commands.find((command) => command.name === "show");
  const setting = commands.find((command) => command.name === "setting");
  assert.ok(show?.options?.some((option) => option.name === "review"));
  const forms = setting?.options?.find((option) => option.name === "forms");
  assert.ok(forms?.options?.some((option) => option.name === "review_send_channel"));
});

test("感想回答はセッションごとに一人一回答", () => {
  const index = SplitReview.schema.indexes().find(([fields, options]) => fields.guildId === 1 && fields.splitSessionId === 1 && fields.userId === 1 && options.unique);
  assert.ok(index);
});

test("感想下書きは一意かつ期限でTTL削除される", () => {
  const indexes = SplitReviewDraft.schema.indexes();
  assert.ok(indexes.some(([fields, options]) => fields.guildId === 1 && fields.splitSessionId === 1 && fields.userId === 1 && options.unique));
  assert.ok(indexes.some(([fields, options]) => fields.expiresAt === 1 && options.expireAfterSeconds === 0));
});

test("感想の表示ラベルは質問ごとに分離され、未知の値は安全に表示する", async () => {
  const source = await readFile(new URL("../src/bot.js", import.meta.url), "utf8");
  assert.match(source, /const TALK_AMOUNT_LABELS = \{/);
  assert.match(source, /const DURATION_FEELING_LABELS = \{/);
  assert.match(source, /const PRACTICE_EFFECT_LABELS = \{/);
  assert.match(source, /TALK_AMOUNT_LABELS\[draft\.talkAmount\] \?\? "不明"/);
  assert.match(source, /DURATION_FEELING_LABELS\[draft\.durationFeeling\] \?\? "不明"/);
  assert.match(source, /PRACTICE_EFFECT_LABELS\[draft\.practiceEffect\] \?\? "不明"/);
});

test("全質問集計と終了通知は感想可否を安全に分岐する", async () => {
  const source = await readFile(new URL("../src/bot.js", import.meta.url), "utf8");
  assert.match(source, /const renderedQuestions = \["1", "2", "3"\][\s\S]*?\.join\("\\n\\n"\)/);
  assert.doesNotMatch(source, /\.\.\.\["1", "2", "3"\]\.map\(\(key\) => renderQuestion\(fields\[key\]\)\)\.join/);
  assert.match(source, /question !== "all" && !fields\[question\]/);
  assert.match(source, /const finishContent = canReview/);
});
