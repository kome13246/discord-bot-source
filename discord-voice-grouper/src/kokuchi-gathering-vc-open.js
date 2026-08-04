/**
 * Runs the Discord-side gathering-VC open transaction around a durable
 * pre-open recovery record.  The callbacks are deliberately injected so the
 * failure ordering can be tested without connecting to MongoDB or Discord.
 */
export async function runGatheringVcOpenTransaction({
  prepare,
  applyDiscord,
  readCurrentPermission,
  snapshotMatches,
  finalizeOpened,
  finalizeUnchanged,
  compensate,
  markPending,
  logger = console,
} = {}) {
  const preservePending = async (error, context) => {
    if (typeof markPending !== "function") {
      logger.error?.(`Gathering VC pending state callback is unavailable: ${error?.message ?? error}`);
      return;
    }
    await markPending(error, context).catch((markError) => {
      logger.error?.(`Failed to preserve gathering VC pending state: ${markError?.message ?? markError}`);
    });
  };
  let prepared;
  try {
    prepared = await prepare();
  } catch (error) {
    logger.error?.(`Gathering VC open preparation failed: ${error?.message ?? error}`);
    return { status: "not_prepared", error };
  }
  if (!prepared) return { status: "not_prepared" };

  let opened = false;
  let openError = null;
  try {
    opened = await applyDiscord();
  } catch (error) {
    openError = error;
  }

  if (!opened) {
    let observation = null;
    let observationError = null;
    try {
      observation = await readCurrentPermission();
    } catch (error) {
      observationError = error;
    }
    let snapshotVerified = false;
    if (observation?.known === true) {
      try {
        snapshotVerified = snapshotMatches(observation.overwrite) === true;
      } catch (error) {
        observationError = error;
      }
    }
    if (snapshotVerified) {
      try {
        await finalizeUnchanged({ observation, openError });
        return { status: "not_required", observation, openError };
      } catch (error) {
        await preservePending(error, { phase: "open-failed-but-finalization-failed", observation });
        return { status: "retry_wait", error, openError, observation };
      }
    }

    const error = observationError
      ?? openError
      ?? new Error("Gathering VC open failed and the current permission did not match the saved snapshot.");
    await preservePending(error, { phase: "open-failed", observation });
    return { status: "retry_wait", error, observation };
  }

  try {
    await finalizeOpened();
    return { status: "opened" };
  } catch (finalizationError) {
    let compensated = false;
    let compensationError = null;
    try {
      compensated = (await compensate(finalizationError)) === true;
    } catch (error) {
      compensationError = error;
    }
    if (compensated) return { status: "restored", error: finalizationError };

    const error = compensationError
      ? new Error(`${finalizationError?.message ?? finalizationError}; compensation: ${compensationError.message}`)
      : finalizationError;
    await preservePending(error, { phase: "opened-but-finalization-failed", compensationError });
    return { status: "retry_wait", error, compensationError };
  }
}
