import test from "node:test";
import assert from "node:assert/strict";
import { readBotImplementationSource } from "./source-under-test.js";

test("途中参加の転送は3人以下、監視延長は2人以下を対象にする", async () => {
  const source = await readBotImplementationSource();
  const findStart = source.indexOf("async function findUnderfilledChildChannel");
  const extensionStart = source.indexOf("async function shouldKeepWaitingRoomAlive");
  const extensionEnd = source.indexOf("async function moveMemberToChildChannel", extensionStart);
  const transferSelection = source.slice(findStart, extensionStart);
  const extensionSelection = source.slice(extensionStart, extensionEnd);

  assert.match(source, /const WAITING_CHILD_TARGET_SIZE = 4/);
  assert.match(source, /const WAITING_EXTENSION_MAX_MEMBERS = 2/);
  assert.match(transferSelection, /memberCount < WAITING_CHILD_TARGET_SIZE/);
  assert.match(extensionSelection, /getNonBotVoiceMembers\(channel\)\.length <= WAITING_EXTENSION_MAX_MEMBERS/);
  assert.doesNotMatch(extensionSelection, /findUnderfilledChildChannel/);
  assert.match(source, /2人以下の子VCが残っているため、途中参加監視を延長します/);
  assert.match(source, /2人以下の子VCが残っているため、待機用VCの自動削除を延長しました/);
});

test("再起動後の途中参加監視は通常時と同じ処理を再利用する", async () => {
  const source = await readBotImplementationSource();
  const start = source.indexOf("async function processRestoredWaitingMonitor");
  const end = source.indexOf("function startRestoredWaitingMonitor", start);
  const restoredMonitor = source.slice(start, end);

  assert.match(restoredMonitor, /await processWaitingRoom\(\{/);
  assert.match(restoredMonitor, /getSplitGroupingState\(guild\.id\)/);
  assert.match(restoredMonitor, /previousPairKeys: getPairKeysFromGroups\(previousGroups\)/);
});
