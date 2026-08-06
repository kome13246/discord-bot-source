export function createShutdownController({
  stopServices = [],
  clearStandaloneTimers = [],
  timerCollections = [],
  destroyClient,
  disconnectDatabase,
  exit = (code) => process.exit(code),
  logger = console,
}) {
  let shuttingDown = false;

  async function shutdown({ signal, exitCode }) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.log(`Graceful shutdown started${signal ? ` (${signal})` : ""}.`);

    for (const stop of stopServices) {
      try {
        await stop();
      } catch (error) {
        logger.error("Service shutdown failed:", error);
      }
    }
    for (const clearTimer of clearStandaloneTimers) clearTimer();
    for (const timers of timerCollections) {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    }

    try {
      destroyClient();
    } catch (error) {
      logger.error("Failed to destroy Discord client during shutdown:", error);
    }
    try {
      await disconnectDatabase();
    } catch (error) {
      logger.error("Failed to close MongoDB during shutdown:", error);
    }
    if (Number.isInteger(exitCode)) exit(exitCode);
  }

  return {
    isShuttingDown: () => shuttingDown,
    shutdown,
  };
}

export function registerProcessShutdownHandlers({ processTarget = process, shutdown, logger = console }) {
  processTarget.once("SIGTERM", () => { void shutdown({ signal: "SIGTERM", exitCode: 0 }); });
  processTarget.once("SIGINT", () => { void shutdown({ signal: "SIGINT", exitCode: 0 }); });
  processTarget.once("unhandledRejection", (reason) => {
    logger.error("Unhandled promise rejection:", reason);
    void shutdown({ signal: "unhandledRejection", exitCode: 1 });
  });
  processTarget.once("uncaughtException", (error) => {
    logger.error("Uncaught exception:", error);
    void shutdown({ signal: "uncaughtException", exitCode: 1 });
  });
}
