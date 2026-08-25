import test from "node:test";
import assert from "node:assert/strict";
import { createInteractionHandler } from "../src/interaction-router.js";

const ids = {
  splitReviewOpen: "split_review_open",
  splitReviewSubmit: "split_review_submit",
  splitRandomTopic: "split_random_topic",
  callWaitJoin: "call_wait_join",
  callWaitInterest: "call_wait_interest",
  callWaitCancel: "call_wait_cancel",
  kokuchiReservationCancel: "kokuchi_reservation_cancel",
  oteboCreate: "otebo_create",
  oteboDraftNote: "otebo_draft_note",
  oteboDraftSubmit: "otebo_draft_submit",
  oteboDraftCancel: "otebo_draft_cancel",
  oteboJoin: "otebo_join",
  oteboMemberCancel: "otebo_member_cancel",
  oteboOwnerCancel: "otebo_owner_cancel",
  oteboOwnerCancelConfirm: "otebo_owner_cancel_confirm",
  splitReviewSelect: "split_review_select",
  oteboDraftSelect: "otebo_draft_select",
  callWaitInterestSelect: "call_wait_interest_threshold",
  splitReviewModal: "split_review_comment",
  oteboNoteModal: "otebo_note_modal",
};

function createHarness({ shuttingDown = false } = {}) {
  const calls = [];
  const record = (name) => async () => { calls.push(name); };
  const handlers = new Proxy({}, { get: (_target, name) => record(String(name)) });
  const services = {
    vcDm: { handleInteraction: record("vcDm.handleInteraction") },
    operationalManagement: {
      handle: record("operationalManagement.handle"),
      handleCommand: record("operationalManagement.handleCommand"),
    },
    voiceChannelControl: { handle: record("voiceChannelControl.handle") },
    fukyoTheme: {
      addTheme: record("fukyoTheme.addTheme"),
      showThemes: record("fukyoTheme.showThemes"),
      deleteTheme: record("fukyoTheme.deleteTheme"),
      sendTheme: record("fukyoTheme.sendTheme"),
    },
  };
  const route = createInteractionHandler({
    isShuttingDown: () => shuttingDown,
    messageFlags: { Ephemeral: 64 },
    services,
    handlers,
    ids,
  });
  return { calls, route };
}

function interaction(overrides = {}) {
  return {
    customId: "",
    commandName: "",
    deferred: false,
    replied: false,
    isButton: () => false,
    isUserSelectMenu: () => false,
    isStringSelectMenu: () => false,
    isModalSubmit: () => false,
    isChatInputCommand: () => false,
    reply: async () => {},
    ...overrides,
  };
}

test("Interactionルーターはボタンのprefixを既存の優先順で処理する", async () => {
  const { calls, route } = createHarness();
  await route(interaction({ customId: "vcdm:panel:1", isButton: () => true }));
  await route(interaction({ customId: "split_review_open:session", isButton: () => true }));
  await route(interaction({ customId: "call_wait_interest_again", isButton: () => true }));
  assert.deepEqual(calls, [
    "vcDm.handleInteraction",
    "handleSplitReviewButton",
    "handleCallWaitButton",
  ]);
});

test("Interactionルーターはコマンドを対応する機能へ渡す", async () => {
  const { calls, route } = createHarness();
  await route(interaction({ commandName: "splitvc", isChatInputCommand: () => true }));
  await route(interaction({ commandName: "botstatus", isChatInputCommand: () => true }));
  await route(interaction({ commandName: "config", isChatInputCommand: () => true }));
  await route(interaction({ commandName: "show", isChatInputCommand: () => true }));
  assert.deepEqual(calls, [
    "handleSplitVoice",
    "operationalManagement.handleCommand",
    "handleConfig",
    "handleShowReview",
  ]);
});

test("Interactionルーターは各コマンドの応答を先取りしない", async () => {
  const acknowledgements = [];
  const route = createInteractionHandler({
    isShuttingDown: () => false,
    messageFlags: { Ephemeral: 64 },
    services: {
      vcDm: {},
      operationalManagement: {},
      voiceChannelControl: {},
      fukyoTheme: {},
    },
    handlers: {
      handleCheckbot: async (current) => {
        assert.equal(current.deferred, false);
        await current.deferReply({ flags: 64 });
      },
      handleConfig: async (current) => {
        assert.equal(current.deferred, false);
        await current.deferReply({ flags: 64 });
      },
      handleSetup: async (current) => {
        assert.equal(current.deferred, false);
        await current.deferReply({ flags: 64 });
      },
    },
    ids,
  });

  for (const commandName of ["checkbot", "config", "setup"]) {
    const current = interaction({
      commandName,
      isChatInputCommand: () => true,
      deferReply: async () => {
        acknowledgements.push(commandName);
        current.deferred = true;
      },
    });
    await route(current);
  }

  assert.deepEqual(acknowledgements, ["checkbot", "config", "setup"]);
});

test("終了処理中は機能へ渡さずephemeral応答する", async () => {
  const { calls, route } = createHarness({ shuttingDown: true });
  let replyPayload;
  await route(interaction({
    commandName: "splitvc",
    isChatInputCommand: () => true,
    reply: async (payload) => { replyPayload = payload; },
  }));
  assert.deepEqual(calls, []);
  assert.equal(replyPayload.flags, 64);
});

test("Interactionルーターはsetupのチャンネル選択・ロール選択をセットアップハンドラーへ渡す", async () => {
  const { calls, route } = createHarness();
  await route(interaction({
    customId: "setup:channel:session:field",
    isChannelSelectMenu: () => true,
  }));
  await route(interaction({
    customId: "setup:role:session:field",
    isRoleSelectMenu: () => true,
  }));
  assert.deepEqual(calls, ["handleSetupInteraction", "handleSetupInteraction"]);
});
