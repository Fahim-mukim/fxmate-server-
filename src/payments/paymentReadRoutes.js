import express from "express";
import {
  assertNoCustomerPaymentQueryOverrides,
  parseAdminPaymentListQuery,
  parseCheckoutSessionId,
} from "./paymentQuery.js";

function asyncRoute(handler) {
  return function routeHandler(req, res, next) {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

// Mounted at /api/payments. These are the only read routes added in this
// phase; they never call Stripe and never mutate payment or booking state.
export function createPaymentReadRouter({ service, middleware } = {}) {
  if (
    typeof middleware?.verifyToken !== "function" ||
    typeof middleware?.verifyCustomer !== "function" ||
    typeof middleware?.verifyAdmin !== "function"
  ) {
    throw new Error(
      "createPaymentReadRouter requires middleware.verifyToken, verifyCustomer, and verifyAdmin.",
    );
  }
  if (typeof service?.findCustomerPayment !== "function") {
    throw new Error("createPaymentReadRouter requires service.findCustomerPayment.");
  }
  if (typeof service?.listAdminPayments !== "function") {
    throw new Error("createPaymentReadRouter requires service.listAdminPayments.");
  }

  const router = express.Router();
  const customer = [middleware.verifyToken, middleware.verifyCustomer];
  const admin = [middleware.verifyToken, middleware.verifyAdmin];

  router.get("/session/:sessionId", ...customer, asyncRoute(async (req, res) => {
    assertNoCustomerPaymentQueryOverrides(req.query);
    const sessionId = parseCheckoutSessionId(req.params.sessionId);
    const data = await service.findCustomerPayment(sessionId, req.user);
    return res.status(200).json({ success: true, data });
  }));

  router.get("/admin", ...admin, asyncRoute(async (req, res) => {
    const criteria = parseAdminPaymentListQuery(req.query);
    const data = await service.listAdminPayments(criteria);
    return res.status(200).json({ success: true, data });
  }));

  return router;
}
