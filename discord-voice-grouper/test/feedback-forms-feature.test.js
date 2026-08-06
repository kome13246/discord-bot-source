import test from "node:test";
import assert from "node:assert/strict";
import { createButtonRow, createMessages } from "../src/features/feedback-forms.js";

test("フィードバックフォームは3種類の固定メッセージとボタンを生成する", () => {
  const messages = createMessages();
  assert.deepEqual(messages.map((message) => message.type), ["topic", "suggestion", "complaint"]);
  assert.equal(createButtonRow("topic").toJSON().components[0].custom_id, "feedback_form_button:topic");
});
