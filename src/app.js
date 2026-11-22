import express from "express";
import cors from "cors";
import { createBookingRepository } from "./bookings/bookingRepository.js";
import { createBookingsRouter } from "./bookings/routes.js";
import { createAuthMiddleware } from "./auth/middleware.js";
import { createAuthRouter } from "./auth/routes.js";
import { createJwtVerifier } from "./auth/jwtVerifier.js";
import { createErrorHandler, notFoundHandler } from "./middleware.js";
import { createServicesRouter } from "./services/routes.js";
import { createServiceRepository } from "./services/serviceRepository.js";
import { createProfileRouter } from "./users/profileRoutes.js";
import { createUserRepository } from "./users/userRepository.js";
import { createImgBbClient } from "./uploads/imgBbClient.js";
import { createUploadRouter } from "./uploads/uploadRoutes.js";

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

export function createApp({
  config,
  database,
  services,
  bookings,
  users,
  tokenVerifier,
  authMiddleware,
  imageHost,
} = {}) {
  if (!config || !database) {
    throw new Error("createApp requires config and database.");
  }

  const serviceRepository = services ?? createServiceRepository({ database });
  const bookingRepository = bookings ?? createBookingRepository({ database });
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
  const uploadHost = imageHost ?? createImgBbClient({ apiKey: config.imgbbApiKey });

  const app = express();

  app.disable("x-powered-by");
  app.use(cors(createCorsOptions(config)));

  // Mounted before the global 1 MB JSON parser so uploads may use their own
  // larger, explicit body limit without weakening other endpoints.
  app.use("/api/uploads", createUploadRouter({
    middleware,
    users: userRepository,
    imageHost: uploadHost,
  }));

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
  app.use("/api/profile", createProfileRouter({
    middleware,
    users: userRepository,
  }));
  app.use("/api/services", createServicesRouter({
    repository: serviceRepository,
    middleware,
  }));
  app.use("/api/bookings", createBookingsRouter({
    repository: bookingRepository,
    middleware,
  }));

  app.use(notFoundHandler);
  app.use(createErrorHandler({
    isProduction: config.isProduction,
    mongodbUri: config.mongodbUri,
    secretValues: config.imgbbApiKey ? [config.imgbbApiKey] : [],
  }));

  return app;
}
