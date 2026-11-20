import express from "express";
import cors from "cors";
import { createAuthMiddleware } from "./auth/middleware.js";
import { createAuthRouter } from "./auth/routes.js";
import { createJwtVerifier } from "./auth/jwtVerifier.js";
import { createErrorHandler, notFoundHandler } from "./middleware.js";
import { createServicesRouter } from "./services/routes.js";
import { createServiceRepository } from "./services/serviceRepository.js";
import { PROVISIONING_SECRET_HEADER, createUsersRouter } from "./users/routes.js";
import { createUserRepository } from "./users/userRepository.js";

function createCorsOptions(config) {
  const allowedOrigins = new Set(config.clientOrigins);

  return {
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", PROVISIONING_SECRET_HEADER],
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

export function createApp({
  config,
  database,
  services,
  users,
  tokenVerifier,
  authMiddleware,
} = {}) {
  if (!config || !database) {
    throw new Error("createApp requires config and database.");
  }

  const serviceRepository = services ?? createServiceRepository({ database });
  const userRepository = users ?? createUserRepository({ database });
  const verifier = tokenVerifier ?? createJwtVerifier({
    jwksUrl: config.authJwtJwksUrl,
    issuer: config.authJwtIssuer,
    audience: config.authJwtAudience,
    algorithms: config.authJwtAlgorithms,
  });
  const middleware = authMiddleware ?? createAuthMiddleware({
    verifier,
    users: userRepository,
  });

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

  app.use("/api/auth", createAuthRouter({ middleware }));
  app.use("/api/internal/users", createUsersRouter({
    users: userRepository,
    provisioningSecret: config.provisioningSecret,
  }));
  app.use("/api/services", createServicesRouter({ repository: serviceRepository }));

  app.use(notFoundHandler);
  app.use(createErrorHandler({
    isProduction: config.isProduction,
    mongodbUri: config.mongodbUri,
    secretValues: [config.provisioningSecret],
  }));

  return app;
}
