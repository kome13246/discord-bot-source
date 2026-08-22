export async function settleStartupTasks(tasks) {
  const results = await Promise.allSettled(tasks.map((task) => task.run()));
  return results.map((result, index) => ({
    name: tasks[index].name,
    ...result,
  }));
}

export function createReadyHandler({
  clearReadyWatchdog,
  migrate,
  settingsApplyTasks = [],
  restoreTasks,
  lateRestoreTasks = [],
  workerStartTasks = [],
  updateRestoreState,
  recordStartupRestore,
  statusBoard,
  shouldSendMongoSuccessLog,
  clearMongoSuccessLog,
  sendMongoStartupEmbed,
  processCallWait,
  retryCallWaitNotifications,
  scheduleCallWait,
  startRepair = null,
  startReconciliation = null,
  logger = console,
  now = () => new Date(),
}) {
  return async function handleReady(readyClient) {
    clearReadyWatchdog();
    logger.log(`Logged in as ${readyClient.user.tag}`);
    await migrate().catch((error) => logger.error("Failed to migrate kokuchi event state:", error));

    // Configuration apply jobs can touch the same Discord resources as panel
    // and VC restoration.  Run that queue in its own settled phase first;
    // keeping both sets in one Promise.allSettled would reintroduce a startup
    // race where an old revision restores over a just-applied setting.
    const results = [
      ...await settleStartupTasks(settingsApplyTasks),
      ...await settleStartupTasks(restoreTasks),
      ...await settleStartupTasks(lateRestoreTasks),
      // Workers must not start until every Discord-facing restore task has
      // settled.  In particular, start() registers a timer before returning,
      // so putting it in lateRestoreTasks still allows the first worker tick
      // to race a long late restore.
      ...await settleStartupTasks(workerStartTasks),
    ];
    const failures = results
      .filter((result) => result.status === "rejected")
      .map((result) => ({
        name: result.name,
        error: result.reason?.message ?? String(result.reason),
      }));
    for (const result of results) {
      if (result.status === "rejected") logger.error(`Startup restore failed (${result.name}):`, result.reason);
    }
    updateRestoreState({
      completed: true,
      failed: failures.length > 0,
      failures,
    });

    await recordStartupRestore({
      results: results.map(({ name, ...result }) => ({ ...result, name })),
      completedAt: now(),
    }).catch((error) => logger.error("Failed to persist startup restore health:", error));

    statusBoard.start(readyClient);
    await statusBoard.restore(readyClient).catch((error) => logger.error("Failed to restore operational status boards:", error));

    if (shouldSendMongoSuccessLog()) {
      clearMongoSuccessLog();
      void (async () => {
        const sent = await sendMongoStartupEmbed({ success: true });
        if (!sent) logger.warn("MongoDB connected successfully, but startup log channel could not be resolved or used.");
      })().catch((error) => logger.error("Failed to send MongoDB success log embed:", error));
    }

    await processCallWait().catch((error) => logger.error("Initial call-wait processing failed:", error));
    await retryCallWaitNotifications().catch((error) => logger.error("Initial call-wait end-notification retry failed:", error));
    scheduleCallWait();
    if (startRepair) {
      await startRepair(readyClient).catch((error) => logger.error("Initial reconciliation repair worker failed:", error));
    }
    if (startReconciliation) {
      // The service dispatches its first read-only run here, after all restore
      // work and the status-board restore have completed.  It may return
      // immediately while the guild loop drains in the background.
      await startReconciliation(readyClient).catch((error) => logger.error("Initial reconciliation failed:", error));
    }
  };
}
