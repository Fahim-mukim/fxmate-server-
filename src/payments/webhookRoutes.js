import express from "express";

function asyncRoute(handler) {
  return function routeHandler(req, res, next) {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

// Mounted at the exact /api/payments/webhook path before express.json(). The
// route-level raw parser preserves the exact bytes Stripe signed; no body is
// parsed or re-serialized before signature verification.
export function createWebhookRouter({ service } = {}) {
  if (typeof service?.processWebhook !== "function") {
    throw new Error("createWebhookRouter requires service.processWebhook.");
  }

  const router = express.Router();
  router.post(
    "/",
    express.raw({ type: "application/json", limit: "1mb" }),
    asyncRoute(async (req, res) => {
      const header = req.headers["stripe-signature"];
      const signature = typeof header === "string" ? header : null;
      const result = await service.processWebhook({
        payload: req.body,
        signature,
      });
      res.status(200).json({
        success: true,
        data: { received: true, outcome: result?.outcome ?? "processed" },
      });
    }),
  );

  return router;
}
