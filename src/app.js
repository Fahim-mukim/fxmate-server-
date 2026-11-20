import express from "express";
import cors from "cors";
import { createErrorHandler, notFoundHandler } from "./middleware.js";

function createCorsOptions(config) {
  const allowedOrigins = new Set(config.clientOrigins);

  return {
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    optionsSuccessStatus: 204,
    origin(origin, callback) {
      if (!origin) {
        return callback(null, true);
      }
      if (allowedOrigins.has(origin)) {
        return callback(null, origin);
      }
      return callback(null, false);
    },
  };
}

export function createApp({ config, database }) {
  if (!config || !database) {
    throw new Error("createApp requires config and database.");
  }

  const app = express();

  app.disable("x-powered-by");
  app.use(cors(createCorsOptions(config)));
  app.use(express.json({ limit: "1mb" }));

  app.get("/api/health", (req, res) => {
    res.status(200).json({
      success: true,
      data: { status: "ok" },
    });
  });

  app.get("/api/ready", (req, res) => {
    if (database.isReady()) {
      return res.status(200).json({
        success: true,
        data: { status: "ready" },
      });
    }

    return res.status(503).json({
      success: false,
      error: {
        code: "SERVICE_UNAVAILABLE",
        message: "Service is not ready.",
      },
    });
  });

  app.use(notFoundHandler);
  app.use(createErrorHandler({
    isProduction: config.isProduction,
    mongodbUri: config.mongodbUri,
  }));

  return app;
}
