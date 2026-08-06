import test from "node:test";
import assert from "node:assert/strict";
import { readBotImplementationSource } from "./source-under-test.js";

test("途中参加は4人未満の子VCを補充対象にする", async () => {
  const source = await readBotImplementationSource();

  assert.match(source, /const WAITING_CHILD_TARGET_SIZE = 4/);
  assert.match(source, /memberCount < WAITING_CHILD_TARGET_SIZE/);
  assert.match(source, /length < WAITING_CHILD_TARGET_SIZE/);
  assert.match(source, /3人以下の子VCが残っているため、途中参加監視を延長します/);
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
