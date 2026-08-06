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
  restoreTasks,
  lateRestoreTasks = [],
  updateRestoreState,
  recordStartupRestore,
  statusBoard,
  shouldSendMongoSuccessLog,
  clearMongoSuccessLog,
  sendMongoStartupEmbed,
  processCallWait,
  retryCallWaitNotifications,
  scheduleCallWait,
  logger = console,
  now = () => new Date(),
}) {
  return async function handleReady(readyClient) {
    clearReadyWatchdog();
    logger.log(`Logged in as ${readyClient.user.tag}`);
    await migrate().catch((error) => logger.error("Failed to migrate kokuchi event state:", error));

    const results = [
      ...await settleStartupTasks(restoreTasks),
      ...await settleStartupTasks(lateRestoreTasks),
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
  };
}
