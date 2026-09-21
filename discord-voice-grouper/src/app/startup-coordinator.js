export async function settleStartupTasks(tasks, logger = null) {
  const results = await Promise.allSettled(tasks.map(async (task) => {
    const startedAt = Date.now();
    logger?.log?.(`Startup task started: ${task.name}`);
    try {
      const result = await task.run();
      logger?.log?.(`Startup task completed: ${task.name} durationMs=${Date.now() - startedAt}`);
      return result;
    } catch (error) {
      logger?.error?.(`Startup task failed: ${task.name} durationMs=${Date.now() - startedAt}`, error);
      throw error;
    }
  }));
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
    logger.log("Startup migration started: kokuchi event state");
    await migrate().then(
      () => logger.log("Startup migration completed: kokuchi event state"),
      (error) => logger.error("Failed to migrate kokuchi event state:", error),
    );

    // Configuration apply jobs can touch the same Discord resources as panel
    // and VC restoration.  Run that queue in its own settled phase first;
    // keeping both sets in one Promise.allSettled would reintroduce a startup
    // race where an old revision restores over a just-applied setting.
    const results = [
      ...await settleStartupTasks(settingsApplyTasks, logger),
      ...await settleStartupTasks(restoreTasks, logger),
      ...await settleStartupTasks(lateRestoreTasks, logger),
      // Workers must not start until every Discord-facing restore task has
      // settled.  In particular, start() registers a timer before returning,
      // so putting it in lateRestoreTasks still allows the first worker tick
      // to race a long late restore.
      ...await settleStartupTasks(workerStartTasks, logger),
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
    logger.log(`Startup restore completed: failed=${failures.length > 0} failureCount=${failures.length}`);

    logger.log("Startup restore health persistence started");
    await recordStartupRestore({
      results: results.map(({ name, ...result }) => ({ ...result, name })),
      completedAt: now(),
    }).then(
      () => logger.log("Startup restore health persistence completed"),
      (error) => logger.error("Failed to persist startup restore health:", error),
    );

    statusBoard.start(readyClient);
    logger.log("Startup status board restoration started");
    await statusBoard.restore(readyClient).catch((error) => logger.error("Failed to restore operational status boards:", error));
    logger.log("Startup status board restoration settled");

    if (shouldSendMongoSuccessLog()) {
      clearMongoSuccessLog();
      void (async () => {
        logger.log("MongoDB startup notification started");
        const sent = await sendMongoStartupEmbed({ success: true });
        if (!sent) logger.warn("MongoDB connected successfully, but startup log channel could not be resolved or used.");
        else logger.log("MongoDB startup notification sent");
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
