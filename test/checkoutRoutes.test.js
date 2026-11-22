import http from "node:http";
import test from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import { createApp } from "../src/app.js";
import { HttpError } from "../src/httpError.js";
import { createCheckoutService } from "../src/payments/checkoutService.js";
import { PAYMENT_STATUS } from "../src/payments/paymentModel.js";

const ALLOWED_ORIGIN = "https://client.example.com";
const BOOKING_ID = "507f1f77bcf86cd7994390b1";
const CUSTOMER_ID = "507f1f77bcf86cd7994390c1";
const CHECKOUT_URL = "https://checkout.stripe.com/pay/cs_test_abc123";

const CUSTOMER = Object.freeze({
  _id: new ObjectId(CUSTOMER_ID),
  name: "Customer One",
  email: "customer.one@example.test",
  role: "customer",
});
const TECHNICIAN = Object.freeze({ ...CUSTOMER, role: "technician" });

const SUCCESS = Object.freeze({
  checkoutUrl: CHECKOUT_URL,
  paymentId: "507f1f77bcf86cd7994390d1",
  sessionId: "cs_test_abc123",
  status: PAYMENT_STATUS.AWAITING_PAYMENT,
});

function testConfig() {
  return {
    isProduction: false,
    mongodbUri: "mongodb://127.0.0.1:27017",
    clientOrigins: [ALLOWED_ORIGIN],
    authJwtIssuer: ALLOWED_ORIGIN,
    authJwtJwksUrl: `${ALLOWED_ORIGIN}/api/auth/jwks`,
    authJwtAudience: ALLOWED_ORIGIN,
    authJwtAlgorithms: ["EdDSA"],
  };
}

function testDatabase() {
  const collection = {
    async findOne() { return null; },
    async updateOne() { return { upsertedCount: 1 }; },
    async indexes() { return []; },
    async createIndex() {},
  };
  return {
    isReady: () => true,
    getDb: () => ({ collection: () => collection }),
  };
}

function testAuthMiddleware() {
  const pass = (req, res, next) => next();
  const forbid = (req, res, next) => next(new HttpError(403, "FORBIDDEN", "This role is not allowed."));
  return {
    verifyToken(req, res, next) {
      const header = req.get("authorization") ?? "";
      if (header === "Bearer customer") {
        req.user = CUSTOMER;
        return next();
      }
      if (header === "Bearer technician") {
        req.user = TECHNICIAN;
        return next();
      }
      if (header === "Bearer invalid") {
        return next(new HttpError(401, "INVALID_TOKEN", "Invalid token."));
      }
      return next(new HttpError(401, "AUTHENTICATION_REQUIRED", "Authentication is required."));
    },
    verifyCustomer(req, res, next) {
      return req.user?.role === "customer" ? pass(req, res, next) : forbid(req, res, next);
    },
    verifyTechnician(req, res, next) {
      return req.user?.role === "technician" ? pass(req, res, next) : forbid(req, res, next);
    },
    verifyAdmin: forbid,
  };
}

function fakeCheckoutService({ result = SUCCESS, error = null } = {}) {
  const calls = [];
  return {
    calls,
    async createCheckout(args) {
      calls.push(args);
      if (error) throw error;
      return result;
    },
  };
}

async function withServer(app, callback) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    await callback(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }
}

function postCheckout(baseUrl, body, token = "Bearer customer") {
  return fetch(`${baseUrl}/api/payments/checkout`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: token } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

test("POST /api/payments/checkout requires a valid authenticated Customer", async () => {
  const checkout = fakeCheckoutService();
  const app = createApp({
    config: testConfig(),
    database: testDatabase(),
    authMiddleware: testAuthMiddleware(),
    checkoutService: checkout,
  });

  await withServer(app, async (baseUrl) => {
    const unauthenticated = await postCheckout(baseUrl, { bookingId: BOOKING_ID }, null);
    assert.equal(unauthenticated.status, 401);
    assert.equal((await unauthenticated.json()).error.code, "AUTHENTICATION_REQUIRED");

    const invalid = await postCheckout(baseUrl, { bookingId: BOOKING_ID }, "Bearer invalid");
    assert.equal(invalid.status, 401);
    assert.equal((await invalid.json()).error.code, "INVALID_TOKEN");

    const wrongRole = await postCheckout(baseUrl, { bookingId: BOOKING_ID }, "Bearer technician");
    assert.equal(wrongRole.status, 403);
    assert.equal((await wrongRole.json()).error.code, "FORBIDDEN");

    assert.equal(checkout.calls.length, 0);

    const allowed = await postCheckout(baseUrl, { bookingId: BOOKING_ID });
    assert.equal(allowed.status, 200);
    assert.deepEqual(await allowed.json(), { success: true, data: SUCCESS });
    assert.equal(checkout.calls.length, 1);
  });
});

test("checkout body accepts only bookingId and ignores client-supplied identity", async () => {
  const checkout = fakeCheckoutService();
  const app = createApp({
    config: testConfig(),
    database: testDatabase(),
    authMiddleware: testAuthMiddleware(),
    checkoutService: checkout,
  });

  await withServer(app, async (baseUrl) => {
    const rejectedBodies = [
      undefined,
      {},
      [],
      { bookingId: "bad-id" },
      { bookingId: BOOKING_ID, amount: 1 },
      { bookingId: BOOKING_ID, customerId: CUSTOMER_ID },
      { bookingId: BOOKING_ID, customerEmail: "attacker@example.test" },
      { bookingId: BOOKING_ID, successUrl: "https://attacker.example.test" },
      { bookingId: BOOKING_ID, status: "paid" },
    ];

    for (const body of rejectedBodies) {
      const response = await postCheckout(baseUrl, body);
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error.code, "VALIDATION_FAILED");
    }
    assert.equal(checkout.calls.length, 0);

    const accepted = await postCheckout(baseUrl, { bookingId: BOOKING_ID });
    assert.equal(accepted.status, 200);
    assert.equal(checkout.calls.length, 1);
    assert.deepEqual(checkout.calls[0], { bookingId: BOOKING_ID, user: CUSTOMER });
  });
});

test("checkout service errors use the shared error envelope", async () => {
  const checkout = fakeCheckoutService({
    error: new HttpError(409, "PAYMENT_ALREADY_PAID", "This booking has already been paid."),
  });
  const app = createApp({
    config: testConfig(),
    database: testDatabase(),
    authMiddleware: testAuthMiddleware(),
    checkoutService: checkout,
  });

  await withServer(app, async (baseUrl) => {
    const response = await postCheckout(baseUrl, { bookingId: BOOKING_ID });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      success: false,
      error: {
        code: "PAYMENT_ALREADY_PAID",
        message: "This booking has already been paid.",
      },
    });
  });
});

test("checkout responses and errors never log the hosted Checkout URL", async () => {
  const names = ["info", "error", "warn", "debug", "log"];
  const originals = names.map((name) => [name, console[name]]);
  const output = [];
  for (const name of names) {
    console[name] = (...args) => output.push(args.map(String).join(" "));
  }

  try {
    const success = fakeCheckoutService();
    const successApp = createApp({
      config: testConfig(),
      database: testDatabase(),
      authMiddleware: testAuthMiddleware(),
      checkoutService: success,
    });
    await withServer(successApp, async (baseUrl) => {
      await postCheckout(baseUrl, { bookingId: BOOKING_ID });
    });

    const failure = fakeCheckoutService({
      error: new HttpError(502, "PAYMENT_PROVIDER_FAILED", "Stripe could not create the Checkout Session."),
    });
    const failureApp = createApp({
      config: testConfig(),
      database: testDatabase(),
      authMiddleware: testAuthMiddleware(),
      checkoutService: failure,
    });
    await withServer(failureApp, async (baseUrl) => {
      await postCheckout(baseUrl, { bookingId: BOOKING_ID });
    });
  } finally {
    for (const [name, original] of originals) console[name] = original;
  }

  assert.equal(output.some((line) => line.includes(CHECKOUT_URL)), false);
});

test("visiting the cancel URL cannot release a reservation or expose another endpoint", async () => {
  const calls = [];
  const bookingId = new ObjectId(BOOKING_ID);
  const payments = {
    async findActiveCheckout() { calls.push("findActiveCheckout"); return null; },
    async findPaidCheckout() { calls.push("findPaidCheckout"); return null; },
    async findByCheckoutSessionId() { calls.push("findByCheckoutSessionId"); return null; },
    async insertCheckoutReservation() { calls.push("insertCheckoutReservation"); return null; },
    async saveCheckoutSession() { calls.push("saveCheckoutSession"); return null; },
    async markCheckoutFailed() { calls.push("markCheckoutFailed"); return null; },
  };
  const bookings = {
    async findForCustomer() {
      return {
        _id: bookingId,
        customerId: CUSTOMER_ID,
        technicianId: "507f1f77bcf86cd7994390a1",
        serviceId: "507f1f77bcf86cd799439201",
        customerName: CUSTOMER.name,
        customerEmail: CUSTOMER.email,
        serviceTitle: "Smartphone screen repair",
        technicianName: "Technician One",
        finalAmount: 95.5,
        status: "completed",
        paymentStatus: "unpaid",
      };
    },
  };
  const checkoutService = createCheckoutService({
    bookings,
    payments,
    stripe: null,
    redirectOrigin: ALLOWED_ORIGIN,
  });
  const app = createApp({
    config: testConfig(),
    database: testDatabase(),
    checkoutService,
  });

  await withServer(app, async (baseUrl) => {
    const cancel = await fetch(
      `${baseUrl}/api/payments/checkout/cancel?session_id=cs_test_abc123`,
    );
    assert.equal(cancel.status, 404);
    assert.equal((await cancel.json()).error.code, "NOT_FOUND");

    const webhook = await fetch(`${baseUrl}/api/payments/webhook`, { method: "POST" });
    assert.equal(webhook.status, 404);

    const verify = await fetch(`${baseUrl}/api/payments/verify?session_id=cs_test_abc123`);
    assert.equal(verify.status, 404);
  });

  assert.deepEqual(calls, []);
});
