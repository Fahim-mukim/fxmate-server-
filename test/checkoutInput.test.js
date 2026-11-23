import test from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import {
  buildCheckoutSessionParams,
  isDefiniteStripeFailure,
  parseCheckoutInput,
  parseStripeCheckoutSession,
  projectCheckoutResponse,
  resolveCheckoutRedirectOrigin,
} from "../src/payments/checkoutInput.js";
import { PAYMENT_STATUS } from "../src/payments/paymentModel.js";

const IDS = Object.freeze({
  payment: "507f1f77bcf86cd7994390a1",
  booking: "507f1f77bcf86cd7994390b1",
  customer: "507f1f77bcf86cd7994390c1",
});

function samplePayment(overrides = {}) {
  return {
    _id: new ObjectId(IDS.payment),
    bookingId: new ObjectId(IDS.booking),
    customerId: new ObjectId(IDS.customer),
    serviceTitle: "Smartphone screen repair",
    amountCents: 9550,
    ...overrides,
  };
}

test("checkout body accepts only a valid bookingId", () => {
  assert.deepEqual(parseCheckoutInput({ bookingId: IDS.booking }), {
    bookingId: IDS.booking,
  });

  for (const body of [
    null,
    [],
    "body",
    {},
    { bookingId: "not-an-id" },
    { bookingId: IDS.booking, amount: 1 },
    { bookingId: IDS.booking, customerId: IDS.customer },
    { bookingId: IDS.booking, successUrl: "https://evil.test" },
  ]) {
    assert.throws(() => parseCheckoutInput(body), (error) => {
      assert.equal(error.status, 400);
      assert.equal(error.code, "VALIDATION_FAILED");
      return true;
    });
  }
});

test("redirect origin selection requires a trusted absolute HTTP(S) origin", () => {
  assert.equal(
    resolveCheckoutRedirectOrigin(["bad", "https://client.example.com"]),
    "https://client.example.com",
  );
  assert.equal(resolveCheckoutRedirectOrigin("http://localhost:3000"), "http://localhost:3000");

  for (const invalid of [
    [],
    [null],
    ["/relative"],
    ["javascript:alert(1)"],
    ["https://user:pass@client.example.com"],
    ["https://client.example.com/path"],
    ["https://*.example.com"],
  ]) {
    assert.throws(() => resolveCheckoutRedirectOrigin(invalid), (error) => {
      assert.equal(error.status, 503);
      assert.equal(error.code, "PAYMENT_NOT_CONFIGURED");
      return true;
    });
  }
});

test("Stripe Session parameters use trusted snapshot values and safe metadata", () => {
  const params = buildCheckoutSessionParams({
    payment: samplePayment(),
    customerEmail: "Canonical.Customer@Example.test",
    redirectOrigin: "https://client.example.com",
  });

  assert.equal(params.mode, "payment");
  assert.equal(Object.hasOwn(params, "payment_method_types"), false);
  assert.equal(params.line_items.length, 1);
  assert.equal(params.line_items[0].quantity, 1);
  assert.equal(params.line_items[0].price_data.currency, "usd");
  assert.equal(params.line_items[0].price_data.unit_amount, 9550);
  assert.equal(
    params.line_items[0].price_data.product_data.name,
    "Smartphone screen repair",
  );
  assert.equal(params.customer_email, "canonical.customer@example.test");
  assert.equal(params.client_reference_id, IDS.payment);
  assert.deepEqual(params.metadata, {
    paymentId: IDS.payment,
    bookingId: IDS.booking,
    customerId: IDS.customer,
  });
  assert.equal(
    params.success_url,
    "https://client.example.com/payment/success?session_id={CHECKOUT_SESSION_ID}",
  );
  assert.equal(
    params.cancel_url,
    "https://client.example.com/payment/cancel?session_id={CHECKOUT_SESSION_ID}",
  );
  assert.ok(params.success_url.includes("{CHECKOUT_SESSION_ID}"));
  assert.ok(params.cancel_url.includes("{CHECKOUT_SESSION_ID}"));
  assert.equal(Object.hasOwn(params, "subscription"), false);
  assert.equal(Object.hasOwn(params, "recurring"), false);
});

test("Session parameters reject unsafe snapshot state before any Stripe call", () => {
  assert.throws(
    () => buildCheckoutSessionParams({
      payment: samplePayment({ amountCents: 0 }),
      customerEmail: "customer@example.test",
      redirectOrigin: "https://client.example.com",
    }),
    { code: "PAYMENT_CHECKOUT_INVALID" },
  );
  assert.throws(
    () => buildCheckoutSessionParams({
      payment: samplePayment({ serviceTitle: "" }),
      customerEmail: "customer@example.test",
      redirectOrigin: "https://client.example.com",
    }),
    { code: "PAYMENT_CHECKOUT_INVALID" },
  );
  assert.throws(
    () => buildCheckoutSessionParams({
      payment: samplePayment(),
      customerEmail: "not-an-email",
      redirectOrigin: "https://client.example.com",
    }),
    { code: "PAYMENT_CHECKOUT_INVALID" },
  );
  assert.throws(
    () => buildCheckoutSessionParams({
      payment: samplePayment(),
      customerEmail: "customer@example.test",
      redirectOrigin: "ftp://client.example.com",
    }),
    { code: "PAYMENT_NOT_CONFIGURED" },
  );
});

test("Stripe response parsing accepts only a hosted Checkout Session", () => {
  const parsed = parseStripeCheckoutSession({
    id: "cs_test_abc123",
    url: "https://checkout.stripe.com/pay/cs_test_abc123",
    expires_at: 1800000000,
    metadata: { ignored: true },
  });
  assert.deepEqual(parsed, {
    sessionId: "cs_test_abc123",
    checkoutUrl: "https://checkout.stripe.com/pay/cs_test_abc123",
    expiresAt: new Date(1800000000000),
  });

  for (const invalid of [
    null,
    { id: "other", url: "https://checkout.stripe.com/pay/x" },
    { id: "cs_test_abc", url: "http://checkout.stripe.com/pay/x" },
    { id: "cs_test_abc", url: "https://evil.test/pay/x" },
    { id: "cs_test_abc", url: "not a url" },
    { id: "cs_test_abc" },
  ]) {
    assert.throws(() => parseStripeCheckoutSession(invalid), {
      code: "PAYMENT_PROVIDER_UNAVAILABLE",
    });
  }
  assert.equal(parseStripeCheckoutSession({
    id: "cs_test_abc",
    url: "https://checkout.stripe.com/pay/cs_test_abc",
  }).expiresAt, null);
});

test("only definite Stripe pre-creation errors release a reservation", () => {
  for (const error of [
    { type: "StripeInvalidRequestError", statusCode: 400 },
    { type: "StripeCardError", statusCode: 402 },
    { type: "StripeAuthenticationError", statusCode: 401 },
    { type: "StripePermissionError", statusCode: 403 },
    { status: 422 },
  ]) {
    assert.equal(isDefiniteStripeFailure(error), true);
  }
  for (const error of [
    null,
    { message: "fetch failed" },
    { statusCode: 500 },
    { statusCode: 503 },
    { type: "StripeConnectionError", statusCode: 500 },
    { status: 409 },
    { type: "StripeIdempotencyError", statusCode: 409 },
  ]) {
    assert.equal(isDefiniteStripeFailure(error), false);
  }
});

test("response projection exposes only the four safe Checkout fields", () => {
  const projected = projectCheckoutResponse({
    _id: new ObjectId(IDS.payment),
    stripeCheckoutSessionId: "cs_test_abc",
    checkoutUrl: "https://checkout.stripe.com/pay/cs_test_abc",
    status: PAYMENT_STATUS.AWAITING_PAYMENT,
    customerEmail: "private@example.test",
    activePaymentKey: "secret",
    rawStripe: { id: "cs_test_abc" },
  });
  assert.deepEqual(Object.keys(projected).sort(), [
    "checkoutUrl",
    "paymentId",
    "sessionId",
    "status",
  ]);
  assert.equal(projected.paymentId, IDS.payment);
  assert.equal(projected.status, PAYMENT_STATUS.AWAITING_PAYMENT);
});
