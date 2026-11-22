import http from "node:http";
import test from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import { createApp } from "../src/app.js";
import { createWebhookService } from "../src/payments/webhookService.js";

const ALLOWED_ORIGIN = "http://localhost:3000";
const SIGNATURE = "t=123,v1=fake";
const RAW_BODY = '{ "id": "evt_raw",  "type": "payment_intent.succeeded" }';

function testConfig() {
  return {
    isProduction: false,
    mongodbUri: "mongodb://127.0.0.1:27017",
    clientOrigins: [ALLOWED_ORIGIN],
    authJwtIssuer: "http://localhost:3000",
    authJwtJwksUrl: "http://localhost:3000/api/auth/jwks",
    authJwtAudience: "http://localhost:3000",
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

function unsupportedEvent() {
  return { id: "evt_raw", type: "payment_intent.succeeded", data: { object: {} } };
}

function fakeWebhookApp({ expectedBody = RAW_BODY, allowSignature = true } = {}) {
  const constructionCalls = [];
  const stripe = {
    constructWebhookEvent(payload, signature) {
      constructionCalls.push({ payload: Buffer.from(payload), signature });
      if (!Buffer.isBuffer(payload) || payload.toString("utf8") !== expectedBody) {
        throw new Error("raw body mismatch");
      }
      if (!allowSignature || signature !== SIGNATURE) {
        throw new Error("signature mismatch");
      }
      return unsupportedEvent();
    },
  };
  const noop = async () => null;
  const webhookService = createWebhookService({
    bookings: {
      findForPaymentWebhook: noop,
      markBookingPaidForPayment: noop,
    },
    payments: {
      findByIdForWebhook: noop,
      findPaidCheckout: noop,
      findByCheckoutSessionId: noop,
      associateSessionForWebhook: noop,
      markPaymentProcessing: noop,
      finalizePayment: noop,
      markPaymentExpired: noop,
    },
    stripe,
  });
  const app = createApp({
    config: testConfig(),
    database: testDatabase(),
    webhookService,
  });
  return { app, constructionCalls };
}

function postWebhook(baseUrl, { body = RAW_BODY, signature = SIGNATURE } = {}) {
  const headers = { "content-type": "application/json" };
  if (signature !== null) headers["stripe-signature"] = signature;
  return fetch(`${baseUrl}/api/payments/webhook`, {
    method: "POST",
    headers,
    body,
  });
}

test("webhook route verifies the exact raw bytes and needs no JWT", async () => {
  const { app, constructionCalls } = fakeWebhookApp();
  await withServer(app, async (baseUrl) => {
    const response = await postWebhook(baseUrl);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      success: true,
      data: { received: true, outcome: "ignored_unsupported_event" },
    });
    assert.equal(constructionCalls.length, 1);
    assert.equal(constructionCalls[0].payload.toString("utf8"), RAW_BODY);
    assert.equal(constructionCalls[0].signature, SIGNATURE);
  });
});

test("webhook route rejects missing, invalid, and malformed payloads safely", async () => {
  const valid = fakeWebhookApp();
  await withServer(valid.app, async (baseUrl) => {
    const missing = await postWebhook(baseUrl, { signature: null });
    assert.equal(missing.status, 400);
    assert.equal((await missing.json()).error.code, "WEBHOOK_SIGNATURE_MISSING");

    const invalid = await postWebhook(baseUrl, { signature: "bad-signature" });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error.code, "WEBHOOK_SIGNATURE_INVALID");

    const malformed = await postWebhook(baseUrl, { body: "{" });
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).error.code, "WEBHOOK_SIGNATURE_INVALID");
  });
  assert.equal(valid.constructionCalls.length, 2);
});

test("webhook error responses never echo raw body content", async () => {
  const { app } = fakeWebhookApp();
  await withServer(app, async (baseUrl) => {
    const response = await postWebhook(baseUrl, { body: '{"secret_marker":true}' });
    assert.equal(response.status, 400);
    const text = await response.text();
    assert.equal(text.includes("secret_marker"), false);
  });
});

test("normal JSON routes still receive parsed JSON after raw webhook mounting", async () => {
  const captured = [];
  const checkoutService = {
    async createCheckout(input) {
      captured.push(input);
      return { checkoutUrl: "https://checkout.stripe.com/test", paymentId: "p1", sessionId: "cs_test_1", status: "awaiting_payment" };
    },
  };
  const middleware = {
    verifyToken(req, res, next) {
      req.user = { _id: new ObjectId("507f1f77bcf86cd7994390c1"), role: "customer" };
      next();
    },
    verifyCustomer(req, res, next) { next(); },
    verifyTechnician(req, res, next) { next(); },
    verifyAdmin(req, res, next) { next(); },
  };
  const { app } = fakeWebhookApp();
  const jsonApp = createApp({
    config: testConfig(),
    database: testDatabase(),
    checkoutService,
    authMiddleware: middleware,
  });
  assert.ok(app);

  await withServer(jsonApp, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/payments/checkout`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test",
      },
      body: JSON.stringify({ bookingId: "507f1f77bcf86cd7994390b1" }),
    });
    assert.equal(response.status, 200);
    assert.equal(captured.length, 1);
    assert.equal(captured[0].bookingId, "507f1f77bcf86cd7994390b1");
    assert.equal(captured[0].user.role, "customer");

    const malformed = await fetch(`${baseUrl}/api/health`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).error.code, "REQUEST_ERROR");
  });
});
