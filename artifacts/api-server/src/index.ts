import app from "./app";
import { logger } from "./lib/logger";
import { startSignalNotifier } from "./lib/notifier";
import { startTrendingDiscovery } from "./lib/trending-discovery";
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

  startSignalNotifier();
  startTrendingDiscovery();
});
