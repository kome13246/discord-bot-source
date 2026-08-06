import { createServer } from "node:http";

export function buildHealthSnapshot({
  discordReady,
  mongoReady,
  startupRestoreCompleted,
  startupRestoreFailed,
  shuttingDown,
  botTag,
  uptimeSeconds,
  startedAt,
}) {
  const ok = discordReady
    && mongoReady
    && startupRestoreCompleted
    && !startupRestoreFailed
    && !shuttingDown;

  return {
    statusCode: ok ? 200 : 503,
    body: {
      ok,
      discordReady,
      mongoReady,
      startupRestoreCompleted,
      shuttingDown,
      bot: botTag ?? null,
      uptimeSeconds,
      startedAt: startedAt.toISOString(),
    },
  };
}

export function startHealthServer({
  port,
  client,
  getMongoReady,
  getStartupState,
  isShuttingDown,
  logger = console,
  now = () => new Date(),
  getUptimeSeconds = () => Math.round(process.uptime()),
}) {
  const startedAt = now();
  const server = createServer((request, response) => {
    const path = request.url?.split("?")[0] ?? "/";

    if (request.method === "GET" && (path === "/" || path === "/health")) {
      const startupState = getStartupState();
      const snapshot = buildHealthSnapshot({
        discordReady: client.isReady(),
        mongoReady: getMongoReady(),
        startupRestoreCompleted: startupState.completed,
        startupRestoreFailed: startupState.failed,
        shuttingDown: isShuttingDown(),
        botTag: client.user?.tag,
        uptimeSeconds: getUptimeSeconds(),
        startedAt,
      });

      response.writeHead(snapshot.statusCode, {
        "cache-control": "no-store",
        "content-type": "application/json; charset=utf-8",
      });
      response.end(JSON.stringify(snapshot.body));
      return;
    }

    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not Found");
  });

  server.listen(port, "0.0.0.0", () => {
    logger.log(`Health server listening on port ${port}`);
  });
  return server;
}
