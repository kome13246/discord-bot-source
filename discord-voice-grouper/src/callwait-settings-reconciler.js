/**
 * Idempotent runtime cleanup for a callwait configuration transition.
 *
 * Configuration revisions never contain prompt/message/lifecycle state.  The
 * apply worker therefore uses this small service to reconcile those runtime
 * fields after a versioned update or rollback.  All Discord functions are
 * injected so this module remains usable by the command path and by tests.
 */
export function createCallWaitSettingsReconciler({
  saveGuildSettingsWithCurrent = null,
  endCallWaitInterestsForRecruitment = null,
  deleteCallWaitPrompt = null,
  deleteCallWaitMessage = null,
  callWaitFollowupTimers = null,
  logger = console,
} = {}) {
  function discordCleanupFailure(result, reason) {
    if (!result) return null;
    const status = String(result.status ?? result.result ?? "").toLowerCase();
    if (result.unknownOutcome || ["unknown", "uncertain"].includes(status)) {
      return { status: "unknown", unknownOutcome: true, reason };
    }
    if (result.retryable || ["retry", "retry_wait", "busy", "lease-unavailable"].includes(status)) {
      return { status: "retry_wait", retryable: true, reason };
    }
    if (["failed", "send-failed", "delete-failed", "channel-unavailable"].includes(status)) {
      return { status: "unknown", unknownOutcome: true, reason };
    }
    return null;
  }

  async function reconcile({ guild, currentSettings = {}, nextSettings = {}, assertLease = null } = {}) {
    const guildId = guild?.id ?? currentSettings?.guildId ?? nextSettings?.guildId;
    const disabled = nextSettings?.callWaitEnabled !== true;
    const promptChannelChanged = Boolean(
      currentSettings?.callWaitPromptChannelId
      && Object.prototype.hasOwnProperty.call(nextSettings ?? {}, "callWaitPromptChannelId")
      && currentSettings.callWaitPromptChannelId !== (nextSettings.callWaitPromptChannelId ?? null),
    );
    const shouldClosePrompt = disabled || promptChannelChanged;
    const runtimePatch = {};
    const currentPrompt = currentSettings?.callWaitPrompt;
    const currentSkipped = currentSettings?.callWaitSkippedNotice;

    if (!shouldClosePrompt && !disabled) return { status: "not-required" };

    try {
      if (currentPrompt) {
        await assertLease?.();
        try {
          const interestResult = await endCallWaitInterestsForRecruitment?.(guildId, currentPrompt.messageId);
          const interestFailure = discordCleanupFailure(interestResult, "interest-cleanup");
          if (interestFailure) return interestFailure;
        } catch (error) {
          // Interest closure is persisted runtime cleanup.  It is safe to
          // retry when Mongo rejects the cleanup, while an explicitly
          // uncertain Discord response must remain blocked.
          if (error?.unknownOutcome || error?.code === "SETTINGS_APPLY_UNKNOWN_OUTCOME") return { status: "unknown", unknownOutcome: true, reason: error?.message };
          return { status: "retry_wait", retryable: true, reason: error?.message ?? "interest-cleanup-failed" };
        }
        await assertLease?.();
        try {
          const promptResult = await deleteCallWaitPrompt?.(guild, currentPrompt);
          const promptFailure = discordCleanupFailure(promptResult, "prompt-delete");
          if (promptFailure) return promptFailure;
        } catch (error) {
          // A failed delete may have reached Discord before the error.  Never
          // repeat it blindly; the job is blocked until an operator checks it.
          return { status: "unknown", unknownOutcome: true, reason: error?.message ?? "prompt-delete-unknown" };
        }
        // Do not clear the durable reference until ownership is still held
        // after the Discord delete has completed.
        await assertLease?.();
        runtimePatch.callWaitPrompt = null;
      }
      if (currentSkipped && shouldClosePrompt) {
        await assertLease?.();
        try {
          const noticeResult = await deleteCallWaitMessage?.(guild, currentSkipped);
          const noticeFailure = discordCleanupFailure(noticeResult, "skipped-notice-delete");
          if (noticeFailure) return noticeFailure;
        } catch (error) {
          return { status: "unknown", unknownOutcome: true, reason: error?.message ?? "skipped-notice-delete-unknown" };
        }
        await assertLease?.();
        runtimePatch.callWaitSkippedNotice = null;
      }
      if (disabled) {
        const prefix = `callwait-followup:${guildId}:`;
        for (const [actionKey, followupTimer] of callWaitFollowupTimers?.entries?.() ?? []) {
          if (!actionKey.startsWith(prefix)) continue;
          clearTimeout(followupTimer);
          callWaitFollowupTimers.delete(actionKey);
        }
        runtimePatch.callWaitPendingNotice = null;
      }
      if (Object.keys(runtimePatch).length > 0) {
        // A persistence failure leaves runtime fields untouched in Mongo and
        // is safe to retry.  The worker distinguishes this from an uncertain
        // Discord mutation using the explicit retryable result.
        if (typeof saveGuildSettingsWithCurrent !== "function") {
          return { status: "retry_wait", retryable: true, reason: "runtime-save-unavailable" };
        }
        try {
          await saveGuildSettingsWithCurrent(guildId, nextSettings, runtimePatch);
        } catch (error) {
          logger.warn?.(`Callwait runtime state save deferred for guild=${guildId}: ${error?.message ?? error}`);
          return { status: "retry_wait", retryable: true, reason: error?.message ?? "runtime-save-failed" };
        }
      }
      return { status: "applied", runtimePatch };
    } catch (error) {
      if (error?.leaseLost || error?.code === "SETTINGS_APPLY_LEASE_LOST") throw error;
      if (error?.unknownOutcome || error?.code === "SETTINGS_APPLY_UNKNOWN_OUTCOME") {
        return { status: "unknown", unknownOutcome: true, reason: error?.message };
      }
      logger.warn?.(`Callwait runtime reconciliation deferred for guild=${guildId}: ${error?.message ?? error}`);
      return { status: "retry_wait", retryable: true, reason: error?.message ?? "runtime-reconcile-failed" };
    }
  }

  return { reconcile };
}
