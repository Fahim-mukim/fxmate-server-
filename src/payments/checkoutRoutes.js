import express from "express";
import { parseCheckoutInput } from "./checkoutInput.js";

const REQUIRED_MIDDLEWARE_METHODS = ["verifyToken", "verifyCustomer"];

function asyncRoute(handler) {
  return function routeHandler(req, res, next) {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

// Mounted at /api/payments. Only the authenticated Customer may create a
// Checkout Session; all identity and amount data comes from the Server.
export function createCheckoutRouter({ service, middleware } = {}) {
  const missingMiddleware = REQUIRED_MIDDLEWARE_METHODS.find(
    (method) => typeof middleware?.[method] !== "function",
  );
  if (missingMiddleware) {
    throw new Error(`createCheckoutRouter requires middleware.${missingMiddleware}.`);
  }
  if (typeof service?.createCheckout !== "function") {
    throw new Error("createCheckoutRouter requires service.createCheckout.");
  }

  const router = express.Router();
  const customer = [middleware.verifyToken, middleware.verifyCustomer];

  router.post("/checkout", ...customer, asyncRoute(async (req, res) => {
    const { bookingId } = parseCheckoutInput(req.body);
    const data = await service.createCheckout({ bookingId, user: req.user });
    return res.status(200).json({ success: true, data });
  }));

  return router;
}
