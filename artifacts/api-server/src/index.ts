import app from "./app";
import { logger } from "./lib/logger";
import { startSignalNotifier, reconcilePhemexPositions } from "./lib/notifier";
import { startTrendingDiscovery } from "./lib/trending-discovery";
import { startCmcDiscovery } from "./lib/cmc-discovery";
import { startFib786Notifier } from "./lib/fib786-notifier";
import { syncFromDb } from "./lib/signals";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, async (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  // Await DB sync before starting the notifier — prevents a race where the
  // notifier's first poll seeds new trades and the cleanup DELETE wipes
  // existing production rows that haven't been loaded into memory yet.
  await syncFromDb();
  await reconcilePhemexPositions();

  startSignalNotifier();
  startTrendingDiscovery();
  startCmcDiscovery();

  // FIB786 alert-only engine — ships dark by default; flip on deliberately
  // once you're ready to start receiving live alerts.
  if (process.env["ENABLE_FIB786_NOTIFIER"] === "true") {
    startFib786Notifier();
  } else {
    logger.info("ENABLE_FIB786_NOTIFIER not set — FIB786 notifier disabled");
  }
});
