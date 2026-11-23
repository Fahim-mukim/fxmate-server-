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
import { createAdminUserRouter } from "./users/adminUserRoutes.js";
import { createProfileRouter } from "./users/profileRoutes.js";
import { createUserRepository } from "./users/userRepository.js";
import { createImgBbClient } from "./uploads/imgBbClient.js";
import { createUploadRouter } from "./uploads/uploadRoutes.js";
import { createCheckoutRouter } from "./payments/checkoutRoutes.js";
import { createCheckoutService } from "./payments/checkoutService.js";
import { createPaymentRepository } from "./payments/paymentRepository.js";
import { createPaymentReadRouter } from "./payments/paymentReadRoutes.js";
import { createPaymentReadService } from "./payments/paymentReadService.js";
import { createWebhookRouter } from "./payments/webhookRoutes.js";
import { createWebhookService } from "./payments/webhookService.js";

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
  payments,
  tokenVerifier,
  authMiddleware,
  imageHost,
  stripe,
  checkoutService,
  webhookService,
  paymentReadService,
  webhookLogger = null,
  logger = webhookLogger,
} = {}) {
  if (!config || !database) {
    throw new Error("createApp requires config and database.");
  }

  const serviceRepository = services ?? createServiceRepository({ database });
  const bookingRepository = bookings ?? createBookingRepository({ database });
  const userRepository = users ?? createUserRepository({ database });
  const paymentRepository = payments ?? createPaymentRepository({ database });
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
  const uploadHost = imageHost ?? createImgBbClient({
    apiKey: config.imgbbApiKey,
    logger,
  });
  const checkout = checkoutService ?? createCheckoutService({
    bookings: bookingRepository,
    payments: paymentRepository,
    stripe,
    redirectOrigin: config.clientOrigins[0],
  });
  const webhook = webhookService ?? createWebhookService({
    bookings: bookingRepository,
    payments: paymentRepository,
    stripe,
    logger: webhookLogger,
  });
  const paymentRead = paymentReadService ?? createPaymentReadService({
    payments: paymentRepository,
    bookings: bookingRepository,
  });

  const app = express();

  app.disable("x-powered-by");
  app.use(cors(createCorsOptions(config)));

  // Mounted before the global 1 MB JSON parser so Stripe signature
  // verification receives the exact raw request bytes. The route-level raw
  // parser applies only to this exact endpoint; normal routes still receive
  // parsed JSON below.
  app.use("/api/payments/webhook", createWebhookRouter({ service: webhook }));

  // Mounted before the global 1 MB JSON parser so uploads may use their own
  // larger, explicit body limit without weakening other endpoints.
  app.use("/api/uploads", createUploadRouter({
    middleware,
    users: userRepository,
    imageHost: uploadHost,
    logger,
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
  app.use("/api/admin/users", createAdminUserRouter({
    middleware,
    users: userRepository,
    services: serviceRepository,
  }));
  app.use("/api/services", createServicesRouter({
    repository: serviceRepository,
    middleware,
  }));
  app.use("/api/bookings", createBookingsRouter({
    repository: bookingRepository,
    middleware,
  }));
  app.use("/api/payments", createCheckoutRouter({
    service: checkout,
    middleware,
  }));
  app.use("/api/payments", createPaymentReadRouter({
    service: paymentRead,
    middleware,
  }));

  app.use(notFoundHandler);
  app.use(createErrorHandler({
    isProduction: config.isProduction,
    mongodbUri: config.mongodbUri,
    secretValues: [
      config.imgbbApiKey,
      config.stripeSecretKey,
      config.stripeWebhookSecret,
    ].filter((value) => typeof value === "string" && value.length > 0),
  }));

  return app;
}
