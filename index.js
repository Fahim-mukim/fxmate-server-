import http from "node:http";
import "dotenv/config";
import { MongoClient } from "mongodb";
import { createApp } from "./src/app.js";
import { loadConfig } from "./src/config.js";
import { createDatabaseManager } from "./src/database.js";
import { sanitizeMessage } from "./src/middleware.js";

const logger = {
  info: (message) => console.info(message),
  error: (message) => console.error(message),
};

async function start() {
  let config;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    logger.error(`Configuration error: ${sanitizeMessage(error.message, [process.env.MONGODB_URI])}`);
    process.exitCode = 1;
    return;
  }

  const database = createDatabaseManager({
    MongoClient,
    uri: config.mongodbUri,
    logger,
  });
  const app = createApp({ config, database });
  const server = http.createServer(app);

  let shutdownPromise = null;
  const shutdown = (reason) => {
    if (shutdownPromise) {
      return shutdownPromise;
    }

    shutdownPromise = (async () => {
      logger.info(`Shutting down (${reason}).`);

      await new Promise((resolve) => {
        if (!server.listening) {
          resolve();
          return;
        }

        server.close((error) => {
          if (error) {
            logger.error(`HTTP close error: ${sanitizeMessage(error.message, [config.mongodbUri])}`);
          }
          resolve();
        });

        if (typeof server.closeAllConnections === "function") {
          server.closeAllConnections();
        }
      });

      try {
        await database.close();
      } catch (error) {
        logger.error(`MongoDB close error: ${sanitizeMessage(error.message, [config.mongodbUri])}`);
      }

      logger.info("Shutdown complete.");
    })();

    return shutdownPromise;
  };

  server.on("error", (error) => {
    logger.error(`HTTP server error: ${sanitizeMessage(error.message, [config.mongodbUri])}`);
    shutdown("server error");
  });

  try {
    await database.connect();
  } catch (error) {
    logger.error(
      `MongoDB initial connection failed; readiness will report unavailable: ${sanitizeMessage(error.message, [config.mongodbUri])}`,
    );
  }

  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("error", onError);
      reject(error);
    };

    server.once("error", onError);
    server.listen(config.port, () => {
      server.off("error", onError);
      resolve();
    });
  });

  logger.info(`FixMate API listening on port ${config.port}.`);

  process.once("SIGINT", () => {
    shutdown("SIGINT");
  });
  process.once("SIGTERM", () => {
    shutdown("SIGTERM");
  });
}

start().catch((error) => {
  logger.error(`Startup failed: ${sanitizeMessage(error.message, [process.env.MONGODB_URI])}`);
  process.exitCode = 1;
});
