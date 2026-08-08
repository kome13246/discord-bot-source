import { createServer } from "node:http";

const HEALTH_CHECK_TIMEOUT_MS = 2_000;

function withHealthTimeout(value) {
  let timer;
  return Promise.race([
    Promise.resolve(value),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), HEALTH_CHECK_TIMEOUT_MS);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

export function buildHealthSnapshot({
  discordReady,
  mongoReady,
  startupRestoreCompleted,
  startupRestoreFailed,
  shuttingDown,
  botTag,
  uptimeSeconds,
  startedAt,
  eventLoopLagMs = null,
}) {
  const ready = discordReady
    && mongoReady
    && startupRestoreCompleted
    && !shuttingDown;
  const degraded = ready && startupRestoreFailed;
  const ok = ready && !startupRestoreFailed;

  return {
    statusCode: ok ? 200 : 503,
    body: {
      ok,
      ready,
      degraded,
      discordReady,
      mongoReady,
      startupRestoreCompleted,
      startupRestoreFailed,
      shuttingDown,
      bot: botTag ?? null,
      uptimeSeconds,
      startedAt: startedAt.toISOString(),
      eventLoopLagMs,
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
  getEventLoopLagMs = () => null,
}) {
  const startedAt = now();
  const server = createServer(async (request, response) => {
    const path = request.url?.split("?")[0] ?? "/";

    if (request.method === "GET" && ["/", "/health", "/ready", "/live"].includes(path)) {
      if (path === "/live") {
        const live = !isShuttingDown();
        response.writeHead(live ? 200 : 503, {
          "cache-control": "no-store",
          "content-type": "application/json; charset=utf-8",
        });
        response.end(JSON.stringify({ live, shuttingDown: !live, uptimeSeconds: getUptimeSeconds(), startedAt: startedAt.toISOString(), eventLoopLagMs: getEventLoopLagMs() }));
        return;
      }
      let mongoReady = false;
      try {
        mongoReady = Boolean(await withHealthTimeout(getMongoReady()));
      } catch (error) {
        logger.error?.(`MongoDB health probe failed: ${error?.message ?? error}`);
      }
      const startupState = getStartupState();
      const snapshot = buildHealthSnapshot({
        discordReady: client.isReady(),
        mongoReady,
        startupRestoreCompleted: startupState.completed,
        startupRestoreFailed: startupState.failed,
        shuttingDown: isShuttingDown(),
        botTag: client.user?.tag,
        uptimeSeconds: getUptimeSeconds(),
        startedAt,
        eventLoopLagMs: getEventLoopLagMs(),
      });

      const statusCode = path === "/ready"
          ? snapshot.body.ready ? 200 : 503
          : snapshot.statusCode;
      const body = snapshot.body;

      response.writeHead(statusCode, {
        "cache-control": "no-store",
        "content-type": "application/json; charset=utf-8",
      });
      response.end(JSON.stringify(body));
      return;
    }

    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not Found");
  });

  server.on("error", (error) => {
    logger.error?.(`Health server error on port ${port}: ${error?.message ?? error}`);
  });

  server.listen(port, "0.0.0.0", () => {
    logger.log(`Health server listening on port ${port}`);
  });
  return server;
}
