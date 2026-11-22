import http from "node:http";
import "dotenv/config";
import { MongoClient } from "mongodb";
import { createApp } from "./src/app.js";
import { createBookingRepository } from "./src/bookings/bookingRepository.js";
import { createJwtVerifier } from "./src/auth/jwtVerifier.js";
import { loadConfig } from "./src/config.js";
import { createDatabaseManager } from "./src/database.js";
import { sanitizeMessage } from "./src/middleware.js";
import { createPaymentRepository } from "./src/payments/paymentRepository.js";
import { createStripeClient } from "./src/payments/stripeClient.js";
import { createServiceRepository } from "./src/services/serviceRepository.js";
import { createUserRepository } from "./src/users/userRepository.js";

const logger = {
  info: (message) => console.info(message),
  error: (message) => console.error(message),
};

function sensitiveValues(config) {
  const values = [
    process.env.MONGODB_URI,
    process.env.IMGBB_API_KEY,
    process.env.STRIPE_SECRET_KEY,
    process.env.STRIPE_WEBHOOK_SECRET,
  ];

  if (config) {
    values.push(
      config.mongodbUri,
      config.imgbbApiKey,
      config.stripeSecretKey,
      config.stripeWebhookSecret,
    );
  }

  return values.filter((value) => typeof value === "string" && value.length > 0);
}

async function start() {
  let config;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    logger.error(`Configuration error: ${sanitizeMessage(error.message, sensitiveValues())}`);
    process.exitCode = 1;
    return;
  }

  const database = createDatabaseManager({
    MongoClient,
    uri: config.mongodbUri,
    databaseName: config.databaseName,
    logger,
  });
  const services = createServiceRepository({ database });
  const bookings = createBookingRepository({ database });
  const users = createUserRepository({ database });
  const payments = createPaymentRepository({ database });
  const tokenVerifier = createJwtVerifier({
    jwksUrl: config.authJwtJwksUrl,
    issuer: config.authJwtIssuer,
    audience: config.authJwtAudience,
    algorithms: config.authJwtAlgorithms,
  });

  // One shared, server-only Stripe client for the process. When Stripe is not
  // configured, Checkout requests fail explicitly with PAYMENT_NOT_CONFIGURED.
  let stripe = null;
  if (config.stripeSecretKey) {
    try {
      stripe = createStripeClient({
        secretKey: config.stripeSecretKey,
        webhookSecret: config.stripeWebhookSecret,
      });
      logger.info(`Stripe Checkout initialized in ${stripe.mode} mode.`);
    } catch (error) {
      logger.error(`Stripe initialization failed: ${sanitizeMessage(error.message, sensitiveValues(config))}`);
    }
  }

  const app = createApp({
    config,
    database,
    services,
    bookings,
    users,
    payments,
    tokenVerifier,
    stripe,
  });
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
            logger.error(`HTTP close error: ${sanitizeMessage(error.message, sensitiveValues(config))}`);
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
        logger.error(`MongoDB close error: ${sanitizeMessage(error.message, sensitiveValues(config))}`);
      }

      logger.info("Shutdown complete.");
    })();

    return shutdownPromise;
  };

  server.on("error", (error) => {
    logger.error(`HTTP server error: ${sanitizeMessage(error.message, sensitiveValues(config))}`);
    shutdown("server error");
  });

  let databaseConnected = false;
  try {
    await database.connect();
    databaseConnected = true;
  } catch (error) {
    logger.error(
      `MongoDB initial connection failed; readiness will report unavailable: ${sanitizeMessage(error.message, sensitiveValues(config))}`,
    );
  }

  if (databaseConnected) {
    try {
      const result = await services.ensureIndexes();
      logger.info(
        `Service indexes verified; created ${result.created.length} missing index(es).`,
      );
    } catch (error) {
      logger.error(
        `Service index initialization failed; existing indexes were left unchanged: ${sanitizeMessage(error.message, sensitiveValues(config))}`,
      );
    }

    try {
      const result = await bookings.ensureIndexes();
      logger.info(
        `Booking indexes verified; created ${result.created.length} missing index(es).`,
      );
    } catch (error) {
      logger.error(
        `Booking index initialization failed; existing indexes were left unchanged: ${sanitizeMessage(error.message, sensitiveValues(config))}`,
      );
    }

    try {
      const result = await payments.ensureIndexes();
      logger.info(
        `Payment indexes verified; created ${result.created.length} missing index(es).`,
      );
    } catch (error) {
      logger.error(
        `Payment index initialization failed; existing indexes were left unchanged: ${sanitizeMessage(error.message, sensitiveValues(config))}`,
      );
    }

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
  logger.error(`Startup failed: ${sanitizeMessage(error.message, sensitiveValues())}`);
  process.exitCode = 1;
});
