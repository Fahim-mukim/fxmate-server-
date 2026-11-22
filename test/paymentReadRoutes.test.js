import http from "node:http";
import test from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";

import { createApp } from "../src/app.js";
import { HttpError, serviceUnavailable } from "../src/httpError.js";
import {
  PAYMENT_STATUS,
} from "../src/payments/paymentModel.js";
import { createPaymentReadService } from "../src/payments/paymentReadService.js";

const ALLOWED_ORIGIN = "https://client.example.com";
const SESSION_ID = "cs_test_paid123456";
const PENDING_SESSION_ID = "cs_test_pending654321";
const MISSING_SESSION_ID = "cs_test_missing123456";
const PAYMENT_ID = "507f1f77bcf86cd7994390d1";
const BOOKING_ID = "507f1f77bcf86cd7994390b1";
const CUSTOMER_ID = "507f1f77bcf86cd7994390c1";
const OTHER_CUSTOMER_ID = "507f1f77bcf86cd7994390c2";

const CUSTOMER = Object.freeze({
  _id: new ObjectId(CUSTOMER_ID),
  name: "Customer One",
  email: "customer.one@example.test",
  role: "customer",
});
const OTHER_CUSTOMER = Object.freeze({
  ...CUSTOMER,
  _id: new ObjectId(OTHER_CUSTOMER_ID),
  name: "Customer Two",
  email: "customer.two@example.test",
});
const TECHNICIAN = Object.freeze({ ...CUSTOMER, role: "technician" });
const ADMIN = Object.freeze({ ...CUSTOMER, role: "admin" });

function testConfig() {
  return {
    isProduction: true,
    mongodbUri: "mongodb://127.0.0.1:27017",
    clientOrigins: [ALLOWED_ORIGIN],
    authJwtIssuer: ALLOWED_ORIGIN,
    authJwtJwksUrl: `${ALLOWED_ORIGIN}/api/auth/jwks`,
    authJwtAudience: ALLOWED_ORIGIN,
    authJwtAlgorithms: ["EdDSA"],
  };
}

function testDatabase() {
  return {
    isReady: () => true,
    getDb: () => ({
      collection: () => ({
        async findOne() { return null; },
        async indexes() { return []; },
        async createIndex() {},
      }),
    }),
  };
}

function testMiddleware() {
  const usersByToken = new Map([
    ["Bearer customer", CUSTOMER],
    ["Bearer other-customer", OTHER_CUSTOMER],
    ["Bearer technician", TECHNICIAN],
    ["Bearer admin", ADMIN],
  ]);
  const pass = (req, res, next) => next();
  const forbid = (req, res, next) =>
    next(new HttpError(403, "FORBIDDEN", "This role is not allowed."));
  const requireRole = (role) => (req, res, next) =>
    req.user?.role === role ? pass(req, res, next) : forbid(req, res, next);

  return {
    verifyToken(req, res, next) {
      const token = req.get("authorization");
      if (!token) {
        return next(new HttpError(401, "AUTHENTICATION_REQUIRED", "Authentication is required."));
      }
      if (token === "Bearer invalid") {
        return next(new HttpError(401, "INVALID_TOKEN", "Invalid token."));
      }
      const user = usersByToken.get(token);
      if (!user) {
        return next(new HttpError(401, "AUTHENTICATION_REQUIRED", "Authentication is required."));
      }
      req.user = user;
      return next();
    },
    verifyCustomer: requireRole("customer"),
    verifyTechnician: requireRole("technician"),
    verifyAdmin: requireRole("admin"),
  };
}

function stripeSpy() {
  const calls = [];
  return {
    calls,
    checkout: {
      sessions: {
        async retrieve(id) {
          calls.push(["checkout.sessions.retrieve", id]);
          throw new Error("read APIs must not call Stripe");
        },
      },
    },
    webhooks: {
      constructEvent(payload, signature) {
        calls.push(["webhooks.constructEvent", signature]);
        throw new Error("read APIs must not verify Stripe events");
      },
    },
  };
}

function appFor({ paymentReadService, stripe = stripeSpy() } = {}) {
  const app = createApp({
    config: testConfig(),
    database: testDatabase(),
    authMiddleware: testMiddleware(),
    paymentReadService,
    stripe,
  });
  return { app, stripe };
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

async function get(baseUrl, path, token = "Bearer customer") {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: token ? { authorization: token } : {},
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = text;
  }
  return { response, payload, text };
}

function fakeReadService({ customerData, customerError, adminData, adminError } = {}) {
  const calls = { customer: [], admin: [] };
  return {
    calls,
    async findCustomerPayment(sessionId, user) {
      calls.customer.push({ sessionId, userId: String(user._id) });
      if (customerError) throw customerError;
      return customerData;
    },
    async listAdminPayments(query) {
      calls.admin.push(query);
      if (adminError) throw adminError;
      return adminData;
    },
  };
}

function paymentDocument(overrides = {}) {
  return {
    _id: new ObjectId(PAYMENT_ID),
    bookingId: new ObjectId(BOOKING_ID),
    customerId: new ObjectId(CUSTOMER_ID),
    serviceTitle: "Smartphone screen repair",
    customerName: "Customer One",
    customerEmail: "customer.one@example.test",
    technicianName: "Technician One",
    amount: 95.5,
    amountCents: 9550,
    currency: "usd",
    status: PAYMENT_STATUS.PAID,
    paidAt: new Date("2026-11-22T10:04:00.000Z"),
    createdAt: new Date("2026-11-22T10:00:00.000Z"),
    updatedAt: new Date("2026-11-22T10:05:00.000Z"),
    stripeCheckoutSessionId: SESSION_ID,
    stripePaymentIntentId: "pi_secret_marker",
    stripeEventId: "evt_secret_marker",
    checkoutUrl: "https://checkout.stripe.com/cs_test_secret_marker",
    activePaymentKey: "active_secret_marker",
    paidBookingKey: "paid_secret_marker",
    ...overrides,
  };
}

function paymentRepoFor() {
  const calls = { customer: [], admin: [], writes: 0 };
  const failWrite = () => {
    calls.writes += 1;
    throw new Error("read API attempted a write");
  };
  return {
    calls,
    async findByCheckoutSessionIdForCustomer({ sessionId, customerId }) {
      calls.customer.push({ sessionId, customerId });
      if (sessionId === MISSING_SESSION_ID) return null;
      if (customerId.toHexString() !== CUSTOMER_ID) return null;
      if (sessionId === PENDING_SESSION_ID) {
        return paymentDocument({
          _id: new ObjectId("507f1f77bcf86cd7994390d2"),
          bookingId: new ObjectId("507f1f77bcf86cd7994390b2"),
          status: PAYMENT_STATUS.AWAITING_PAYMENT,
          paidAt: null,
        });
      }
      return paymentDocument();
    },
    async listForAdmin(criteria) {
      calls.admin.push(criteria);
      const total = criteria.search === "nobody-matches-this" ? 0 : 23;
      return {
        items: total === 0 ? [] : [paymentDocument()],
        page: criteria.page,
        limit: criteria.limit,
        total,
        totalPages: total === 0 ? 0 : Math.ceil(total / criteria.limit),
      };
    },
    async insertCheckoutReservation() { return failWrite(); },
    async saveCheckoutSession() { return failWrite(); },
    async markCheckoutFailed() { return failWrite(); },
    async finalizePayment() { return failWrite(); },
    async markPaymentExpired() { return failWrite(); },
  };
}

function bookingRepoFor() {
  const calls = { status: [], writes: 0 };
  return {
    calls,
    async findPaymentStatusForCustomer(input) {
      calls.status.push(input);
      return {
        _id: input.bookingId,
        paymentStatus:
          String(input.bookingId) === "507f1f77bcf86cd7994390b2" ? "unpaid" : "paid",
      };
    },
    async markBookingPaidForPayment() {
      calls.writes += 1;
      throw new Error("read API attempted a booking write");
    },
  };
}

function realReadService() {
  const payments = paymentRepoFor();
  const bookings = bookingRepoFor();
  const service = createPaymentReadService({ payments, bookings });
  return { service, payments, bookings };
}

test("customer payment read enforces authentication and Customer role first", async () => {
  const service = fakeReadService({ customerData: { status: "paid" } });
  const { app, stripe } = appFor({ paymentReadService: service });

  await withServer(app, async (baseUrl) => {
    const missing = await get(baseUrl, `/api/payments/session/${SESSION_ID}`, null);
    assert.equal(missing.response.status, 401);
    assert.equal(missing.payload.error.code, "AUTHENTICATION_REQUIRED");

    const invalid = await get(baseUrl, `/api/payments/session/${SESSION_ID}`, "Bearer invalid");
    assert.equal(invalid.response.status, 401);
    assert.equal(invalid.payload.error.code, "INVALID_TOKEN");

    for (const token of ["Bearer technician", "Bearer admin"]) {
      const forbidden = await get(baseUrl, `/api/payments/session/${SESSION_ID}`, token);
      assert.equal(forbidden.response.status, 403);
      assert.equal(forbidden.payload.error.code, "FORBIDDEN");
    }

    const allowed = await get(baseUrl, `/api/payments/session/${SESSION_ID}`);
    assert.equal(allowed.response.status, 200);
    assert.equal(service.calls.customer.length, 1);
  });
  assert.equal(stripe.calls.length, 0);
});

test("payment read endpoints map database outages to a safe 503", async () => {
  const service = fakeReadService({
    customerError: serviceUnavailable(),
    adminError: serviceUnavailable(),
  });
  const { app } = appFor({ paymentReadService: service });

  await withServer(app, async (baseUrl) => {
    const customer = await get(baseUrl, `/api/payments/session/${SESSION_ID}`);
    const admin = await get(baseUrl, "/api/payments/admin", "Bearer admin");

    for (const response of [customer, admin]) {
      assert.equal(response.response.status, 503);
      assert.equal(response.payload.error.code, "SERVICE_UNAVAILABLE");
      assert.equal(response.text.includes("mongo"), false);
      assert.equal(response.text.includes("stack"), false);
    }
  });
});

test("customer payment read validates Session ids and rejects every query override", async () => {
  const service = fakeReadService({ customerData: { status: "paid" } });
  const { app } = appFor({ paymentReadService: service });

  const invalidIds = [
    "not-a-session",
    "cs_test_short",
    `cs_test_${"a".repeat(300)}`,
    "cs_live_has space",
    encodeURIComponent("$ne"),
  ];
  const overrideQueries = [
    "?customerId=507f1f77bcf86cd7994390c2",
    "?bookingId=507f1f77bcf86cd7994390b9",
    "?amount=1",
    "?status=paid",
    "?ownership=technician",
    "?customerEmail=attacker@example.test",
  ];

  await withServer(app, async (baseUrl) => {
    for (const id of invalidIds) {
      const response = await get(baseUrl, `/api/payments/session/${id}`);
      assert.equal(response.response.status, 400, id);
      assert.equal(response.payload.error.code, "INVALID_QUERY");
    }
    for (const query of overrideQueries) {
      const response = await get(baseUrl, `/api/payments/session/${SESSION_ID}${query}`);
      assert.equal(response.response.status, 400, query);
      assert.equal(response.payload.error.code, "INVALID_QUERY");
    }
    assert.equal(service.calls.customer.length, 0);
  });
});

test("missing and non-owned customer Sessions return the identical 404", async () => {
  const { service, payments, bookings } = realReadService();
  const { app, stripe } = appFor({ paymentReadService: service });

  await withServer(app, async (baseUrl) => {
    const missing = await get(baseUrl, `/api/payments/session/${MISSING_SESSION_ID}`);
    const nonOwned = await get(
      baseUrl,
      `/api/payments/session/${SESSION_ID}`,
      "Bearer other-customer",
    );

    assert.equal(missing.response.status, 404);
    assert.equal(nonOwned.response.status, 404);
    assert.deepEqual(missing.payload, nonOwned.payload);
    assert.equal(missing.payload.error.code, "NOT_FOUND");
    assert.equal(missing.payload.error.message, "Payment not found.");
    assert.equal(payments.calls.customer.length, 2);
    assert.equal(bookings.calls.status.length, 0);
  });
  assert.equal(payments.calls.writes, 0);
  assert.equal(bookings.calls.writes, 0);
  assert.equal(stripe.calls.length, 0);
});

test("customer read returns DB-authoritative paid and pending states with only safe fields", async () => {
  const { service, payments, bookings } = realReadService();
  const { app, stripe } = appFor({ paymentReadService: service });
  const expectedKeys = [
    "amount",
    "bookingPaymentStatus",
    "bookingId",
    "createdAt",
    "currency",
    "paidAt",
    "paymentId",
    "serviceTitle",
    "status",
    "updatedAt",
  ];

  await withServer(app, async (baseUrl) => {
    const paid = await get(baseUrl, `/api/payments/session/${SESSION_ID}`);
    const pending = await get(baseUrl, `/api/payments/session/${PENDING_SESSION_ID}`);

    assert.equal(paid.response.status, 200);
    assert.equal(pending.response.status, 200);
    assert.equal(paid.payload.data.status, PAYMENT_STATUS.PAID);
    assert.equal(pending.payload.data.status, PAYMENT_STATUS.AWAITING_PAYMENT);
    assert.equal(paid.payload.data.bookingPaymentStatus, "paid");
    assert.equal(pending.payload.data.bookingPaymentStatus, "unpaid");
    assert.deepEqual(Object.keys(paid.payload.data).sort(), expectedKeys.sort());
    assert.equal(paid.payload.data.paymentId, PAYMENT_ID);

    for (const marker of [
      "secret_marker",
      SESSION_ID,
      "checkout.stripe.com",
      "pi_",
      "evt_",
      "customer.one@example.test",
      "activePaymentKey",
      "paidBookingKey",
      "amountCents",
    ]) {
      assert.equal(paid.text.includes(marker), false, marker);
      assert.equal(pending.text.includes(marker), false, marker);
    }
  });
  assert.equal(payments.calls.writes, 0);
  assert.equal(bookings.calls.writes, 0);
  assert.equal(stripe.calls.length, 0);
});

test("admin payment list enforces authentication and Admin role", async () => {
  const service = fakeReadService({ adminData: { items: [], total: 0 } });
  const { app } = appFor({ paymentReadService: service });

  await withServer(app, async (baseUrl) => {
    const missing = await get(baseUrl, "/api/payments/admin", null);
    assert.equal(missing.response.status, 401);

    const invalid = await get(baseUrl, "/api/payments/admin", "Bearer invalid");
    assert.equal(invalid.response.status, 401);

    for (const token of ["Bearer customer", "Bearer technician"]) {
      const forbidden = await get(baseUrl, "/api/payments/admin", token);
      assert.equal(forbidden.response.status, 403);
      assert.equal(forbidden.payload.error.code, "FORBIDDEN");
    }

    const allowed = await get(baseUrl, "/api/payments/admin", "Bearer admin");
    assert.equal(allowed.response.status, 200);
    assert.equal(service.calls.admin.length, 1);
  });
});

test("admin list uses defaults and caps limit at fifty", async () => {
  const service = fakeReadService({ adminData: { items: [], total: 0 } });
  const { app } = appFor({ paymentReadService: service });

  await withServer(app, async (baseUrl) => {
    const defaults = await get(baseUrl, "/api/payments/admin", "Bearer admin");
    assert.equal(defaults.response.status, 200);
    assert.deepEqual(service.calls.admin[0], {
      status: null,
      search: null,
      sort: "newest",
      page: 1,
      limit: 10,
    });

    const capped = await get(baseUrl, "/api/payments/admin?limit=50", "Bearer admin");
    assert.equal(capped.response.status, 200);
    assert.equal(service.calls.admin[1].limit, 50);

    const over = await get(baseUrl, "/api/payments/admin?limit=51", "Bearer admin");
    assert.equal(over.response.status, 400);
    assert.equal(service.calls.admin.length, 2);
  });
});

test("admin list rejects unsupported parameters, statuses, sorts, searches, and pagination", async () => {
  const service = fakeReadService({ adminData: { items: [], total: 0 } });
  const { app } = appFor({ paymentReadService: service });
  const invalidQueries = [
    "?customerId=507f1f77bcf86cd7994390c2",
    "?status=paid_fake",
    "?sort=evil",
    "?page=0",
    "?page=not-a-number",
    "?limit=0",
    `?search=${"x".repeat(101)}`,
    `?search=${encodeURIComponent("$ne")}`,
    `?search=${encodeURIComponent('{"$gt":""}')}`,
    `?search=${encodeURIComponent("[true]")}`,
    "?search[]=x",
  ];

  await withServer(app, async (baseUrl) => {
    for (const query of invalidQueries) {
      const response = await get(baseUrl, `/api/payments/admin${query}`, "Bearer admin");
      assert.equal(response.response.status, 400, query);
      assert.equal(response.payload.error.code, "INVALID_QUERY");
    }
    assert.equal(service.calls.admin.length, 0);
  });
});

test("admin list forwards validated status, search, sort, and pagination", async () => {
  const service = fakeReadService({ adminData: { items: [], total: 0 } });
  const { app } = appFor({ paymentReadService: service });

  await withServer(app, async (baseUrl) => {
    const response = await get(
      baseUrl,
      "/api/payments/admin?status=paid&search=Smartphone&sort=newest&page=3&limit=25",
      "Bearer admin",
    );
    assert.equal(response.response.status, 200);
    assert.deepEqual(service.calls.admin[0], {
      status: "paid",
      search: "Smartphone",
      sort: "newest",
      page: 3,
      limit: 25,
    });
  });
});

test("admin listing returns safe rows, total, page, page size, and empty results", async () => {
  const { service, payments, bookings } = realReadService();
  const { app, stripe } = appFor({ paymentReadService: service });

  await withServer(app, async (baseUrl) => {
    const results = await get(baseUrl, "/api/payments/admin", "Bearer admin");
    assert.equal(results.response.status, 200);
    assert.equal(results.payload.data.total, 23);
    assert.equal(results.payload.data.page, 1);
    assert.equal(results.payload.data.limit, 10);
    assert.equal(results.payload.data.totalPages, 3);
    const row = results.payload.data.items[0];
    assert.deepEqual(Object.keys(row).sort(), [
      "amount",
      "bookingId",
      "createdAt",
      "currency",
      "customerEmail",
      "customerName",
      "paidAt",
      "paymentId",
      "serviceTitle",
      "status",
      "technicianName",
      "updatedAt",
    ].sort());
    assert.equal(row.paymentId, PAYMENT_ID);
    for (const marker of [
      "secret_marker",
      SESSION_ID,
      "checkout.stripe.com",
      "activePaymentKey",
      "paidBookingKey",
      "clientReferenceId",
      "amountCents",
    ]) {
      assert.equal(results.text.includes(marker), false, marker);
    }

    const empty = await get(
      baseUrl,
      "/api/payments/admin?search=nobody-matches-this",
      "Bearer admin",
    );
    assert.equal(empty.response.status, 200);
    assert.deepEqual(empty.payload.data.items, []);
    assert.equal(empty.payload.data.total, 0);
    assert.equal(empty.payload.data.totalPages, 0);
    assert.equal(payments.calls.admin.length, 2);
  });
  assert.equal(payments.calls.writes, 0);
  assert.equal(bookings.calls.writes, 0);
  assert.equal(stripe.calls.length, 0);
});

test("admin payment endpoints expose no mutation routes", async () => {
  const service = fakeReadService({ adminData: { items: [], total: 0 } });
  const { app } = appFor({ paymentReadService: service });

  await withServer(app, async (baseUrl) => {
    for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
      const response = await fetch(`${baseUrl}/api/payments/admin`, {
        method,
        headers: { authorization: "Bearer admin" },
      });
      assert.equal(response.status, 404, method);
    }
    const sessionPost = await fetch(`${baseUrl}/api/payments/session/${SESSION_ID}`, {
      method: "POST",
      headers: { authorization: "Bearer customer" },
    });
    assert.equal(sessionPost.status, 404);
  });
});
