import { SengenDeclaration } from "./models/sengen-declaration.js";
import { SengenDraft } from "./models/sengen-draft.js";
import { SengenPanel } from "./models/sengen-panel.js";

async function resolve(value) {
  return value && typeof value.lean === "function" ? value.lean() : value;
}

export function createSengenStore({
  declarationModel = SengenDeclaration,
  draftModel = SengenDraft,
  panelModel = SengenPanel,
} = {}) {
  return {
    async createDraft(draft) {
      return resolve(draftModel.create(draft));
    },
    async getDraft(draftId, userId, guildId) {
      return resolve(draftModel.findOne({ draftId, userId, guildId, consumedAt: null, expiresAt: { $gt: new Date() } }));
    },
    async refreshDraftDate(draftId, userId, guildId, previewDateKey, updatedAt) {
      return resolve(draftModel.findOneAndUpdate(
        { draftId, userId, guildId, consumedAt: null },
        { $set: { previewDateKey, updatedAt } },
        { returnDocument: "after" },
      ));
    },
    async refreshDraftConfiguration(draftId, userId, guildId, { postChannelId, overviewChannelId }, updatedAt) {
      return resolve(draftModel.findOneAndUpdate(
        { draftId, userId, guildId, consumedAt: null },
        { $set: { postChannelId, overviewChannelId, updatedAt } },
        { returnDocument: "after" },
      ));
    },
    async claimDraft(draftId, userId, guildId, consumedAt) {
      return resolve(draftModel.findOneAndUpdate(
        { draftId, userId, guildId, consumedAt: null, expiresAt: { $gt: consumedAt } },
        { $set: { consumedAt } },
        { returnDocument: "after" },
      ));
    },
    async countActive(guildId, userId, now) {
      return declarationModel.countDocuments({ guildId, userId, result: null, deadlineAt: { $gt: now } });
    },
    async createDeclaration(declaration) {
      return resolve(declarationModel.create(declaration));
    },
    async deleteDeclaration(declarationId) {
      return declarationModel.deleteOne({ _id: declarationId });
    },
    async getDeclaration(declarationId, guildId = undefined) {
      return resolve(declarationModel.findOne({ _id: declarationId, ...(guildId ? { guildId } : {}) }));
    },
    async setPostMessage(declarationId, messageId) {
      return resolve(declarationModel.findOneAndUpdate(
        { _id: declarationId, postMessageId: null, publicationStatus: { $in: ["posting", "orphaned"] } },
        { $set: { postMessageId: messageId, publicationStatus: "published", lastError: null } },
        { returnDocument: "after" },
      ));
    },
    async markPublicationOrphaned(declarationId, error, now) {
      return declarationModel.updateOne(
        { _id: declarationId, postMessageId: null, publicationStatus: "posting" },
        { $set: { publicationStatus: "orphaned", lastError: String(error?.message ?? error).slice(0, 500), updatedAt: now } },
      );
    },
    async claimResultPrompt(declarationId, now) {
      return resolve(declarationModel.findOneAndUpdate(
        { _id: declarationId, result: null, resultPromptSentAt: null, publicationStatus: "published", postMessageId: { $ne: null }, deadlineAt: { $lte: now } },
        { $set: { resultPromptSentAt: now, nextProgressAt: null, updatedAt: now } },
        { returnDocument: "after" },
      ));
    },
    async claimProgress(declarationId, expectedNextProgressAt, nextProgressAt, now) {
      return resolve(declarationModel.findOneAndUpdate(
        { _id: declarationId, result: null, publicationStatus: "published", postMessageId: { $ne: null }, deadlineAt: { $gt: now }, nextProgressAt: expectedNextProgressAt },
        { $set: { nextProgressAt, lastProgressNoticeAt: now, updatedAt: now } },
        { returnDocument: "after" },
      ));
    },
    async submitResult({ declarationId, guildId, userId, result, now }) {
      return resolve(declarationModel.findOneAndUpdate(
        { _id: declarationId, guildId, userId, result: null, deadlineAt: { $lte: now } },
        { $set: { result, resultSubmittedAt: now, failureReason: null, publicSyncPending: true, updatedAt: now }, $inc: { publicRevision: 1 } },
        { returnDocument: "after" },
      ));
    },
    async updateFailureReason({ declarationId, guildId, userId, reason, now }) {
      return resolve(declarationModel.findOneAndUpdate(
        { _id: declarationId, guildId, userId, result: "failed" },
        { $set: { failureReason: reason || null, publicSyncPending: true, updatedAt: now }, $inc: { publicRevision: 1 } },
        { returnDocument: "after" },
      ));
    },
    async correctResult({ declarationId, guildId, result, now }) {
      return resolve(declarationModel.findOneAndUpdate(
        { _id: declarationId, guildId, result: { $in: ["achieved", "failed"] } },
        { $set: { result, resultSubmittedAt: now, failureReason: null, publicSyncPending: true, updatedAt: now }, $inc: { publicRevision: 1 } },
        { returnDocument: "after" },
      ));
    },
    async markPublicSynced(declarationId, revision, now) {
      return declarationModel.updateOne(
        { _id: declarationId, publicSyncPending: true, publicRevision: revision },
        { $set: { publicSyncPending: false, publicSyncedRevision: revision, lastError: null, updatedAt: now } },
      );
    },
    async setPublicSyncError(declarationId, error, now) {
      return declarationModel.updateOne(
        { _id: declarationId, publicSyncPending: true },
        { $set: { lastError: String(error?.message ?? error).slice(0, 500), updatedAt: now } },
      );
    },
    async listDueResultPrompts(now) {
      return resolve(declarationModel.find({ result: null, resultPromptSentAt: null, publicationStatus: "published", postMessageId: { $ne: null }, deadlineAt: { $lte: now } }));
    },
    async listDueProgress(now) {
      return resolve(declarationModel.find({ result: null, publicationStatus: "published", postMessageId: { $ne: null }, nextProgressAt: { $lte: now }, deadlineAt: { $gt: now } }));
    },
    async listPublicSyncPending() {
      return resolve(declarationModel.find({ publicSyncPending: true, postMessageId: { $ne: null } }));
    },
    async listUnpublished() {
      return resolve(declarationModel.find({ postMessageId: null, publicationStatus: { $in: ["posting", "orphaned"] } }));
    },
    async getPanel(guildId) {
      return resolve(panelModel.findOne({ guildId }));
    },
    async savePanel({ guildId, channelId, messageId, expectedCurrent = null, stalePanel = null }) {
      const update = {
        $set: { channelId, messageId },
        $setOnInsert: { guildId },
      };
      if (stalePanel?.channelId && stalePanel?.messageId) update.$addToSet = { stalePanels: stalePanel };
      const filter = expectedCurrent
        ? { guildId, channelId: expectedCurrent.channelId, messageId: expectedCurrent.messageId }
        : { guildId, messageId: { $exists: false } };
      return resolve(panelModel.findOneAndUpdate(
        filter,
        update,
        { upsert: !expectedCurrent, returnDocument: "after" },
      ));
    },
    async removeStalePanel(guildId, { channelId, messageId }) {
      return panelModel.updateOne({ guildId }, { $pull: { stalePanels: { channelId, messageId } } });
    },
    async deletePanel(guildId, expectedCurrent = null) {
      return panelModel.deleteOne({
        guildId,
        ...(expectedCurrent ? { channelId: expectedCurrent.channelId, messageId: expectedCurrent.messageId } : {}),
      });
    },
  };
}
