import test from "node:test";
import assert from "node:assert/strict";
import {
  STRIPE_WEBHOOK_EVENTS,
  WEBHOOK_CODES,
  parseCheckoutSessionEvent,
  parseWebhookEvent,
} from "../src/payments/webhookEvent.js";

const IDS = Object.freeze({
  event: "evt_123456789",
  session: "cs_test_abc123",
  payment: "507f1f77bcf86cd7994390d1",
  booking: "507f1f77bcf86cd7994390b1",
  customer: "507f1f77bcf86cd7994390c1",
  intent: "pi_123456789",
});

function event(overrides = {}) {
  const type = overrides.type ?? STRIPE_WEBHOOK_EVENTS.CHECKOUT_COMPLETED;
  const session = {
    object: "checkout.session",
    id: IDS.session,
    mode: "payment",
    payment_status: "paid",
    currency: "usd",
    amount_total: 9550,
    client_reference_id: IDS.payment,
    payment_intent: IDS.intent,
    metadata: {
      paymentId: IDS.payment,
      bookingId: IDS.booking,
      customerId: IDS.customer,
    },
    ...(overrides.session ?? {}),
  };

  return {
    id: IDS.event,
    type,
    data: { object: session },
    ...(overrides.event ?? {}),
  };
}

test("parseWebhookEvent accepts a signed supported event envelope", () => {
  const parsed = parseWebhookEvent(event());
  assert.equal(parsed.id, IDS.event);
  assert.equal(parsed.type, STRIPE_WEBHOOK_EVENTS.CHECKOUT_COMPLETED);
  assert.equal(parsed.session.id, IDS.session);
});

test("parseWebhookEvent safely ignores unrelated event types", () => {
  const parsed = parseWebhookEvent(event({ type: "payment_intent.succeeded" }));
  assert.equal(parsed.type, "payment_intent.succeeded");
  assert.equal(parsed.session, null);
});

test("parseWebhookEvent rejects malformed event shapes", () => {
  assert.throws(() => parseWebhookEvent(null), { code: WEBHOOK_CODES.EVENT_INVALID });
  assert.throws(() => parseWebhookEvent({ id: IDS.event }), {
    code: WEBHOOK_CODES.EVENT_INVALID,
  });
  assert.throws(() => parseWebhookEvent(event({ session: { object: "payment_intent" } })), {
    code: WEBHOOK_CODES.EVENT_INVALID,
  });
});

test("a valid paid Checkout Session parses to matched trusted claims", () => {
  const claim = parseCheckoutSessionEvent(event(), { requirePaid: true });
  assert.deepEqual(claim, {
    eventId: IDS.event,
    eventType: STRIPE_WEBHOOK_EVENTS.CHECKOUT_COMPLETED,
    sessionId: IDS.session,
    paymentId: IDS.payment,
    bookingId: IDS.booking,
    customerId: IDS.customer,
    clientReferenceId: IDS.payment,
    amountCents: 9550,
    currency: "usd",
    paymentIntentId: IDS.intent,
    paymentStatus: "paid",
  });
});

test("completed Session validation rejects invalid mode, currency, amount, and unpaid status", () => {
  const cases = [
    { mode: "setup" },
    { mode: "subscription" },
    { currency: "eur" },
    { amount_total: 0 },
    { amount_total: 95.5 },
    { payment_status: "unpaid" },
    { payment_status: "no_payment_required" },
  ];
  for (const session of cases) {
    assert.throws(
      () => parseCheckoutSessionEvent(event({ session }), { requirePaid: true }),
      { code: WEBHOOK_CODES.MISMATCH },
    );
  }
});

test("completed Session validation rejects malformed identifiers and client-reference mismatch", () => {
  const cases = [
    { client_reference_id: IDS.booking },
    { metadata: { paymentId: "not-an-id", bookingId: IDS.booking, customerId: IDS.customer } },
    { metadata: null },
  ];
  for (const session of cases) {
    assert.throws(
      () => parseCheckoutSessionEvent(event({ session }), { requirePaid: true }),
      { code: WEBHOOK_CODES.MISMATCH },
    );
  }
});

test("structurally valid identifier mismatches parse and are left to stored-document validation", () => {
  const cases = [
    {
      client_reference_id: "507f1f77bcf86cd7994390d2",
      metadata: { paymentId: "507f1f77bcf86cd7994390d2", bookingId: IDS.booking, customerId: IDS.customer },
    },
    { metadata: { paymentId: IDS.payment, bookingId: "507f1f77bcf86cd7994390b2", customerId: IDS.customer } },
    { metadata: { paymentId: IDS.payment, bookingId: IDS.booking, customerId: "507f1f77bcf86cd7994390c2" } },
  ];
  for (const session of cases) {
    const claim = parseCheckoutSessionEvent(event({ session }), { requirePaid: true });
    assert.equal(typeof claim.paymentId, "string");
  }
});

test("completed Session validation requires a real Checkout Session id and PaymentIntent", () => {
  assert.throws(
    () => parseCheckoutSessionEvent(event({ session: { id: "cs bad" } }), { requirePaid: true }),
    { code: WEBHOOK_CODES.EVENT_INVALID },
  );
  assert.throws(
    () => parseCheckoutSessionEvent(event({ session: { payment_intent: null } }), { requirePaid: true }),
    { code: WEBHOOK_CODES.MISMATCH },
  );
});

test("expired Session validation accepts unpaid status without requiring a PaymentIntent", () => {
  const claim = parseCheckoutSessionEvent(
    event({
      type: STRIPE_WEBHOOK_EVENTS.CHECKOUT_EXPIRED,
      session: { payment_status: "unpaid", payment_intent: null },
    }),
    { requirePaid: false },
  );
  assert.equal(claim.eventType, STRIPE_WEBHOOK_EVENTS.CHECKOUT_EXPIRED);
  assert.equal(claim.paymentIntentId, null);
  assert.equal(claim.paymentStatus, "unpaid");
});

test("expired Session validation rejects a paid Session", () => {
  assert.throws(
    () =>
      parseCheckoutSessionEvent(
        event({ type: STRIPE_WEBHOOK_EVENTS.CHECKOUT_EXPIRED, session: { payment_status: "paid" } }),
        { requirePaid: false },
      ),
    { code: WEBHOOK_CODES.MISMATCH },
  );
});
