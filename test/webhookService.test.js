import test from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import { HttpError } from "../src/httpError.js";
import { createWebhookService } from "../src/payments/webhookService.js";
import {
  ACTIVE_PAYMENT_KEY_FIELD,
  PAID_BOOKING_KEY_FIELD,
  PAYMENT_STATUS,
  makeActivePaymentKey,
  makePaidBookingKey,
} from "../src/payments/paymentModel.js";
import { PAID_BY_PAYMENT_ID_FIELD } from "../src/bookings/bookingModel.js";
import {
  STRIPE_WEBHOOK_EVENTS,
  WEBHOOK_CODES,
} from "../src/payments/webhookEvent.js";

const IDS = Object.freeze({
  payment: "507f1f77bcf86cd7994390d1",
  otherPayment: "507f1f77bcf86cd7994390d2",
  booking: "507f1f77bcf86cd7994390b1",
  customer: "507f1f77bcf86cd7994390c1",
  session: "cs_test_abc123",
  otherSession: "cs_test_old456",
  intent: "pi_123456789",
  event: "evt_123456789",
  secondEvent: "evt_987654321",
});
const NOW = new Date("2026-11-22T12:00:00.000Z");
const PAYLOAD = Buffer.from("raw-payload-marker-do-not-log");

function clone(value) {
  if (!value || typeof value !== "object") return value;
  return { ...value };
}

function paymentDocument(overrides = {}) {
  return {
    _id: new ObjectId(IDS.payment),
    bookingId: new ObjectId(IDS.booking),
    customerId: new ObjectId(IDS.customer),
    technicianId: new ObjectId("507f1f77bcf86cd7994390a1"),
    serviceId: new ObjectId("507f1f77bcf86cd799439201"),
    amount: 95.5,
    amountCents: 9550,
    currency: "usd",
    status: PAYMENT_STATUS.AWAITING_PAYMENT,
    stripeCheckoutSessionId: IDS.session,
    stripePaymentIntentId: undefined,
    stripeEventId: null,
    clientReferenceId: IDS.booking,
    [ACTIVE_PAYMENT_KEY_FIELD]: makeActivePaymentKey(IDS.booking),
    createdAt: NOW,
    updatedAt: NOW,
    paidAt: null,
    ...overrides,
  };
}

function paidPaymentDocument(overrides = {}) {
  return paymentDocument({
    status: PAYMENT_STATUS.PAID,
    stripePaymentIntentId: IDS.intent,
    stripeEventId: IDS.event,
    [ACTIVE_PAYMENT_KEY_FIELD]: undefined,
    [PAID_BOOKING_KEY_FIELD]: makePaidBookingKey(IDS.booking),
    paidAt: NOW,
    ...overrides,
  });
}

function bookingDocument(overrides = {}) {
  return {
    _id: new ObjectId(IDS.booking),
    customerId: new ObjectId(IDS.customer),
    status: "completed",
    finalAmount: 95.5,
    paymentStatus: "unpaid",
    [PAID_BY_PAYMENT_ID_FIELD]: undefined,
    ...overrides,
  };
}

function stripeEvent(overrides = {}) {
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
    id: overrides.id ?? IDS.event,
    type,
    data: { object: session },
  };
}

function conflict(code = WEBHOOK_CODES.CONFLICT) {
  return new HttpError(409, code, "Simulated unique-key conflict.");
}

function unavailable() {
  return new HttpError(503, "SERVICE_UNAVAILABLE", "Simulated database failure.");
}

function fakePayments({ payment = paymentDocument(), paid = null, sessionOwner = null, timeline = [] } = {}) {
  const state = {
    payment: clone(payment),
    paid: clone(paid ?? (payment.status === PAYMENT_STATUS.PAID ? payment : null)),
    sessionOwner: clone(sessionOwner),
    fail: {},
    finalizeWinner: null,
  };
  const calls = [];

  function record(method, detail) {
    calls.push({ method, ...(detail ?? {}) });
    timeline.push({ source: "payments", method });
  }

  return {
    state,
    calls,
    async findByIdForWebhook() {
      record("findByIdForWebhook");
      if (state.fail.findById) throw state.fail.findById;
      return clone(state.payment);
    },
    async findPaidCheckout() {
      record("findPaidCheckout");
      if (state.fail.findPaid) throw state.fail.findPaid;
      return clone(state.paid);
    },
    async findByCheckoutSessionId() {
      record("findByCheckoutSessionId");
      if (state.fail.findBySession) throw state.fail.findBySession;
      return clone(state.sessionOwner);
    },
    async associateSessionForWebhook({ sessionId } = {}) {
      record("associateSessionForWebhook");
      if (state.fail.associate) throw state.fail.associate;
      const current = state.payment;
      if (
        !current ||
        current.status !== PAYMENT_STATUS.CHECKOUT_PENDING ||
        (current.stripeCheckoutSessionId && current.stripeCheckoutSessionId !== sessionId) ||
        state.paid
      ) {
        return null;
      }
      state.payment = {
        ...current,
        status: PAYMENT_STATUS.AWAITING_PAYMENT,
        stripeCheckoutSessionId: sessionId,
      };
      return clone(state.payment);
    },
    async markPaymentProcessing({ sessionId } = {}) {
      record("markPaymentProcessing");
      if (state.fail.markProcessing) throw state.fail.markProcessing;
      const current = state.payment;
      if (
        !current ||
        current.status !== PAYMENT_STATUS.AWAITING_PAYMENT ||
        current.stripeCheckoutSessionId !== sessionId
      ) {
        return null;
      }
      state.payment = { ...current, status: PAYMENT_STATUS.PROCESSING };
      return clone(state.payment);
    },
    async finalizePayment({ sessionId, paymentIntentId, eventId } = {}) {
      record("finalizePayment");
      if (state.fail.finalize) {
        if (state.finalizeWinner) {
          state.payment = clone(state.finalizeWinner);
          state.paid = clone(state.finalizeWinner);
        }
        throw state.fail.finalize;
      }
      const current = state.payment;
      if (
        !current ||
        current.status !== PAYMENT_STATUS.PROCESSING ||
        current.stripeCheckoutSessionId !== sessionId
      ) {
        return null;
      }
      state.payment = {
        ...current,
        status: PAYMENT_STATUS.PAID,
        stripeCheckoutSessionId: sessionId,
        stripePaymentIntentId: paymentIntentId,
        stripeEventId: eventId,
        paidAt: NOW,
        [PAID_BOOKING_KEY_FIELD]: makePaidBookingKey(IDS.booking),
        [ACTIVE_PAYMENT_KEY_FIELD]: undefined,
      };
      state.paid = clone(state.payment);
      return clone(state.payment);
    },
    async markPaymentExpired({ sessionId } = {}) {
      record("markPaymentExpired");
      if (state.fail.markExpired) throw state.fail.markExpired;
      const current = state.payment;
      if (
        !current ||
        current.status !== PAYMENT_STATUS.AWAITING_PAYMENT ||
        current.stripeCheckoutSessionId !== sessionId
      ) {
        return null;
      }
      state.payment = {
        ...current,
        status: PAYMENT_STATUS.EXPIRED,
        [ACTIVE_PAYMENT_KEY_FIELD]: undefined,
      };
      return clone(state.payment);
    },
  };
}

function fakeBookings({ booking = bookingDocument(), timeline = [] } = {}) {
  const state = { booking: clone(booking), fail: {} };
  const calls = [];

  function record(method) {
    calls.push({ method });
    timeline.push({ source: "bookings", method });
  }

  return {
    state,
    calls,
    async findForPaymentWebhook() {
      record("findForPaymentWebhook");
      if (state.fail.find) throw state.fail.find;
      return clone(state.booking);
    },
    async markBookingPaidForPayment({ paymentId } = {}) {
      record("markBookingPaidForPayment");
      if (state.fail.mark) throw state.fail.mark;
      const current = state.booking;
      const marker = current?.[PAID_BY_PAYMENT_ID_FIELD];
      const canPay =
        current &&
        current.status === "completed" &&
        ((current.paymentStatus === "unpaid" && !marker) ||
          (current.paymentStatus === "paid" && String(marker) === String(paymentId)));
      if (!canPay) return null;
      state.booking = {
        ...current,
        paymentStatus: "paid",
        [PAID_BY_PAYMENT_ID_FIELD]: new ObjectId(String(paymentId)),
      };
      return clone(state.booking);
    },
  };
}

function setup({
  payment = paymentDocument(),
  paid = null,
  sessionOwner = null,
  booking = bookingDocument(),
  event = stripeEvent(),
  signature = "valid-signature",
  failSignature = false,
  configError = false,
} = {}) {
  const timeline = [];
  const payments = fakePayments({ payment, paid, sessionOwner, timeline });
  const bookings = fakeBookings({ booking, timeline });
  const stripeCalls = [];
  const stripe = {
    constructWebhookEvent(payload, receivedSignature) {
      stripeCalls.push({ payload, receivedSignature });
      if (configError) {
        throw new HttpError(503, "PAYMENT_NOT_CONFIGURED", "not configured");
      }
      if (failSignature || receivedSignature !== "valid-signature") {
        throw new Error("signature verification failed");
      }
      return event;
    },
  };
  const logs = { info: [], warn: [] };
  const logger = {
    info: (message) => logs.info.push(message),
    warn: (message) => logs.warn.push(message),
  };
  const service = createWebhookService({
    bookings,
    payments,
    stripe,
    logger,
    now: () => NOW,
  });
  return { service, payments, bookings, stripeCalls, logs, timeline };
}

function deliver(service, { signature = "valid-signature", payload = PAYLOAD } = {}) {
  return service.processWebhook({ payload, signature });
}

test("createWebhookService validates required repositories", () => {
  assert.throws(
    () => createWebhookService({ payments: {} }),
    /requires bookings\.findForPaymentWebhook/,
  );
  assert.throws(
    () => createWebhookService({ bookings: fakeBookings() }),
    /requires payments\.findByIdForWebhook/,
  );
});

test("a valid completion advances payment, booking, and audit fields in order", async () => {
  const { service, payments, bookings, timeline } = setup();
  const result = await deliver(service);

  assert.deepEqual(result, { outcome: "processed" });
  const methods = timeline.map((entry) => `${entry.source}.${entry.method}`);
  assert.ok(
    methods.indexOf("payments.markPaymentProcessing") <
      methods.indexOf("bookings.markBookingPaidForPayment"),
  );
  assert.ok(
    methods.indexOf("bookings.markBookingPaidForPayment") <
      methods.indexOf("payments.finalizePayment"),
  );

  assert.equal(payments.state.payment.status, PAYMENT_STATUS.PAID);
  assert.equal(payments.state.payment.stripeCheckoutSessionId, IDS.session);
  assert.equal(payments.state.payment.stripePaymentIntentId, IDS.intent);
  assert.equal(payments.state.payment.stripeEventId, IDS.event);
  assert.equal(payments.state.payment.paidAt, NOW);
  assert.equal(payments.state.payment[PAID_BOOKING_KEY_FIELD], makePaidBookingKey(IDS.booking));
  assert.equal(payments.state.payment[ACTIVE_PAYMENT_KEY_FIELD], undefined);
  assert.equal(bookings.state.booking.paymentStatus, "paid");
  assert.equal(String(bookings.state.booking[PAID_BY_PAYMENT_ID_FIELD]), IDS.payment);
});

test("unsupported Stripe events are ignored without any database write", async () => {
  const { service, payments, bookings, stripeCalls } = setup({
    event: stripeEvent({ type: "payment_intent.succeeded" }),
  });
  assert.deepEqual(await deliver(service), { outcome: "ignored_unsupported_event" });
  assert.equal(stripeCalls.length, 1);
  assert.equal(payments.calls.length, 0);
  assert.equal(bookings.calls.length, 0);
});

test("invalid signatures are rejected before payment reads, while config errors stay 5xx", async () => {
  const invalid = setup({ failSignature: true });
  await assert.rejects(deliver(invalid.service), {
    status: 400,
    code: WEBHOOK_CODES.SIGNATURE_INVALID,
  });
  assert.equal(invalid.payments.calls.length, 0);

  const unconfigured = setup({ configError: true });
  await assert.rejects(deliver(unconfigured.service), {
    status: 503,
    code: "PAYMENT_NOT_CONFIGURED",
  });
});

test("empty payloads and missing signatures are rejected with safe codes", async () => {
  const { service } = setup();
  await assert.rejects(
    service.processWebhook({ payload: Buffer.alloc(0), signature: "valid-signature" }),
    { status: 400, code: WEBHOOK_CODES.PAYLOAD_INVALID },
  );
  await assert.rejects(
    service.processWebhook({ payload: PAYLOAD, signature: "   " }),
    { status: 400, code: WEBHOOK_CODES.SIGNATURE_MISSING },
  );
});

test("stored amount, currency, mode, and amount snapshot mismatches never mark paid", async () => {
  const cases = [
    { payment: paymentDocument({ amountCents: 9000 }) },
    { payment: paymentDocument({ amount: 90 }) },
    { payment: paymentDocument({ currency: "eur" }) },
    { event: stripeEvent({ session: { mode: "setup" } }) },
    { event: stripeEvent({ session: { amount_total: 9000 } }) },
  ];
  for (const input of cases) {
    const { service, payments, bookings } = setup(input);
    await assert.rejects(deliver(service), { status: 409, code: WEBHOOK_CODES.MISMATCH });
    assert.equal(payments.state.payment.status, PAYMENT_STATUS.AWAITING_PAYMENT);
    assert.equal(bookings.state.booking.paymentStatus, "unpaid");
    assert.equal(payments.calls.some((call) => call.method === "finalizePayment"), false);
  }
});

test("booking state, amount, and different-payment mismatches are rejected", async () => {
  const cases = [
    { booking: bookingDocument({ status: "in-progress" }) },
    { booking: bookingDocument({ finalAmount: 90 }) },
    {
      booking: bookingDocument({
        paymentStatus: "paid",
        [PAID_BY_PAYMENT_ID_FIELD]: new ObjectId(IDS.otherPayment),
      }),
    },
    {
      event: stripeEvent({
        session: {
          metadata: {
            paymentId: IDS.payment,
            bookingId: "507f1f77bcf86cd7994390b2",
            customerId: IDS.customer,
          },
        },
      }),
    },
  ];
  for (const input of cases) {
    const { service, payments, bookings } = setup(input);
    await assert.rejects(deliver(service), { status: 409, code: WEBHOOK_CODES.MISMATCH });
    assert.equal(payments.state.payment.status, PAYMENT_STATUS.AWAITING_PAYMENT);
    assert.equal(payments.calls.some((call) => call.method === "markPaymentProcessing"), false);
    assert.equal(bookings.calls.some((call) => call.method === "markBookingPaidForPayment"), false);
  }
});

test("an already-paid matching Session is idempotent for a different event id", async () => {
  const { service, payments, bookings } = setup({
    payment: paidPaymentDocument(),
    booking: bookingDocument({
      paymentStatus: "paid",
      [PAID_BY_PAYMENT_ID_FIELD]: new ObjectId(IDS.payment),
    }),
    event: stripeEvent({ id: IDS.secondEvent }),
  });
  assert.deepEqual(await deliver(service), { outcome: "already_paid" });
  assert.equal(payments.state.payment.stripeEventId, IDS.event);
  assert.equal(payments.calls.some((call) => call.method === "finalizePayment"), false);
  assert.equal(bookings.calls.some((call) => call.method === "markBookingPaidForPayment"), false);
});

test("an already-paid payment with conflicting identifiers is not overwritten", async () => {
  const { service, payments } = setup({
    payment: paidPaymentDocument({ stripeCheckoutSessionId: IDS.otherSession }),
    paid: paidPaymentDocument({ stripeCheckoutSessionId: IDS.otherSession }),
  });
  await assert.rejects(deliver(service), { status: 409, code: WEBHOOK_CODES.MISMATCH });
  assert.equal(payments.state.payment.stripeCheckoutSessionId, IDS.otherSession);
});

test("duplicated completion deliveries are safe", async () => {
  const { service, payments, bookings } = setup();
  assert.deepEqual(await deliver(service), { outcome: "processed" });
  assert.deepEqual(await deliver(service), { outcome: "already_paid" });
  assert.equal(payments.calls.filter((call) => call.method === "finalizePayment").length, 1);
  assert.equal(bookings.state.booking.paymentStatus, "paid");
});

test("concurrent duplicate deliveries both resolve successfully without double finalization", async () => {
  const { service, payments, bookings } = setup();
  const results = await Promise.all([deliver(service), deliver(service)]);
  assert.ok(results.every((result) => result.outcome === "processed" || result.outcome === "already_paid"));
  assert.equal(payments.state.payment.status, PAYMENT_STATUS.PAID);
  assert.equal(bookings.state.booking.paymentStatus, "paid");
  assert.equal(payments.state.paid && payments.state.paid._id.toString(), IDS.payment);
});

test("a finalize unique-key conflict won by the same payment is treated as success", async () => {
  const { service, payments } = setup();
  payments.state.fail.finalize = conflict();
  payments.state.finalizeWinner = paidPaymentDocument();
  assert.deepEqual(await deliver(service), { outcome: "processed" });
  assert.equal(payments.state.payment.status, PAYMENT_STATUS.PAID);
});

test("failure before the payment state update leaves the booking unpaid", async () => {
  const { service, payments, bookings } = setup();
  payments.state.fail.markProcessing = unavailable();
  await assert.rejects(deliver(service), { status: 503, code: "SERVICE_UNAVAILABLE" });
  assert.equal(payments.state.payment.status, PAYMENT_STATUS.AWAITING_PAYMENT);
  assert.equal(bookings.state.booking.paymentStatus, "unpaid");
  assert.equal(bookings.calls.length, 1);
});

test("failure after processing resumes on the next delivery", async () => {
  const { service, payments, bookings } = setup();
  bookings.state.fail.mark = unavailable();
  await assert.rejects(deliver(service), { status: 503, code: "SERVICE_UNAVAILABLE" });
  assert.equal(payments.state.payment.status, PAYMENT_STATUS.PROCESSING);
  assert.equal(bookings.state.booking.paymentStatus, "unpaid");

  bookings.state.fail.mark = null;
  assert.deepEqual(await deliver(service), { outcome: "processed" });
  assert.equal(payments.state.payment.status, PAYMENT_STATUS.PAID);
  assert.equal(bookings.state.booking.paymentStatus, "paid");
});

test("failure after the booking is paid finalizes the same payment on retry", async () => {
  const { service, payments, bookings } = setup();
  payments.state.fail.finalize = unavailable();
  await assert.rejects(deliver(service), { status: 503, code: "SERVICE_UNAVAILABLE" });
  assert.equal(payments.state.payment.status, PAYMENT_STATUS.PROCESSING);
  assert.equal(bookings.state.booking.paymentStatus, "paid");
  assert.equal(String(bookings.state.booking[PAID_BY_PAYMENT_ID_FIELD]), IDS.payment);

  payments.state.fail.finalize = null;
  assert.deepEqual(await deliver(service), { outcome: "processed" });
  assert.equal(payments.state.payment.status, PAYMENT_STATUS.PAID);
  assert.equal(String(bookings.state.booking[PAID_BY_PAYMENT_ID_FIELD]), IDS.payment);
});

test("a webhook before Session persistence safely recovers the exact active attempt", async () => {
  const { service, payments, timeline } = setup({
    payment: paymentDocument({
      status: PAYMENT_STATUS.CHECKOUT_PENDING,
      stripeCheckoutSessionId: undefined,
    }),
  });
  assert.deepEqual(await deliver(service), { outcome: "processed" });
  const methods = timeline.map((entry) => `${entry.source}.${entry.method}`);
  assert.ok(methods.includes("payments.associateSessionForWebhook"));
  assert.equal(payments.state.payment.status, PAYMENT_STATUS.PAID);
  assert.equal(payments.state.payment.stripeCheckoutSessionId, IDS.session);
});

test("recovery cannot bind a Session through a wrong payment id, conflict, amount, or currency", async () => {
  const cases = [
    {
      payment: paymentDocument({
        status: PAYMENT_STATUS.CHECKOUT_PENDING,
        stripeCheckoutSessionId: undefined,
      }),
      event: stripeEvent({
        session: {
          metadata: {
            paymentId: IDS.otherPayment,
            bookingId: IDS.booking,
            customerId: IDS.customer,
          },
          client_reference_id: IDS.otherPayment,
        },
      }),
    },
    {
      payment: paymentDocument({
        status: PAYMENT_STATUS.CHECKOUT_PENDING,
        stripeCheckoutSessionId: IDS.otherSession,
      }),
    },
    {
      payment: paymentDocument({
        status: PAYMENT_STATUS.CHECKOUT_PENDING,
        stripeCheckoutSessionId: undefined,
        amountCents: 9000,
        amount: 90,
      }),
    },
    {
      payment: paymentDocument({
        status: PAYMENT_STATUS.CHECKOUT_PENDING,
        stripeCheckoutSessionId: undefined,
        currency: "eur",
      }),
    },
  ];
  for (const input of cases) {
    const { service, payments, bookings } = setup(input);
    await assert.rejects(deliver(service), { status: 409, code: WEBHOOK_CODES.MISMATCH });
    assert.equal(
      payments.calls.some((call) => call.method === "associateSessionForWebhook"),
      false,
    );
    assert.equal(payments.state.payment.status, PAYMENT_STATUS.CHECKOUT_PENDING);
    assert.equal(bookings.state.booking.paymentStatus, "unpaid");
  }
});

test("recovery cannot bind a Session already owned by another payment", async () => {
  const { service, payments } = setup({
    payment: paymentDocument({
      status: PAYMENT_STATUS.CHECKOUT_PENDING,
      stripeCheckoutSessionId: undefined,
    }),
    sessionOwner: { _id: new ObjectId(IDS.otherPayment) },
  });
  await assert.rejects(deliver(service), { status: 409, code: WEBHOOK_CODES.MISMATCH });
  assert.equal(payments.state.payment.stripeCheckoutSessionId, undefined);
});

test("a paid attempt found for the booking blocks a different webhook payment", async () => {
  const { service, payments } = setup({
    paid: { _id: new ObjectId(IDS.otherPayment) },
  });
  await assert.rejects(deliver(service), { status: 409, code: WEBHOOK_CODES.MISMATCH });
  assert.equal(payments.calls.some((call) => call.method === "markPaymentProcessing"), false);
});

test("the correct active Session expires and releases only its active key", async () => {
  const { service, payments, bookings } = setup({
    event: stripeEvent({
      type: STRIPE_WEBHOOK_EVENTS.CHECKOUT_EXPIRED,
      session: { payment_status: "unpaid", payment_intent: null },
    }),
  });
  assert.deepEqual(await deliver(service), { outcome: "expired" });
  assert.equal(payments.state.payment.status, PAYMENT_STATUS.EXPIRED);
  assert.equal(payments.state.payment[ACTIVE_PAYMENT_KEY_FIELD], undefined);
  assert.equal(bookings.state.booking.paymentStatus, "unpaid");
  assert.equal(bookings.state.booking[PAID_BY_PAYMENT_ID_FIELD], undefined);
});

test("expiration of an old or different Session cannot expire a newer attempt", async () => {
  const { service, payments } = setup({
    payment: paymentDocument({ stripeCheckoutSessionId: IDS.otherSession }),
    event: stripeEvent({
      type: STRIPE_WEBHOOK_EVENTS.CHECKOUT_EXPIRED,
      session: { payment_status: "unpaid", payment_intent: null },
    }),
  });
  assert.deepEqual(await deliver(service), { outcome: "ignored_stale_expiration" });
  assert.equal(payments.state.payment.status, PAYMENT_STATUS.AWAITING_PAYMENT);
  assert.equal(payments.calls.some((call) => call.method === "markPaymentExpired"), false);
});

test("paid and processing payments cannot be expired", async () => {
  for (const status of [PAYMENT_STATUS.PAID, PAYMENT_STATUS.PROCESSING]) {
    const payment =
      status === PAYMENT_STATUS.PAID
        ? paidPaymentDocument()
        : paymentDocument({ status });
    const { service, payments } = setup({
      payment,
      event: stripeEvent({
        type: STRIPE_WEBHOOK_EVENTS.CHECKOUT_EXPIRED,
        session: { payment_status: "unpaid", payment_intent: null },
      }),
    });
    assert.deepEqual(await deliver(service), { outcome: "ignored_stale_expiration" });
    assert.equal(payments.state.payment.status, status);
    assert.equal(payments.calls.some((call) => call.method === "markPaymentExpired"), false);
  }
});

test("logs contain only safe outcome fields, never payloads, URLs, or secrets", async () => {
  const { service, logs } = setup({
    event: stripeEvent({
      session: { url: "https://checkout.stripe.com/pay/sensitive-session-url" },
    }),
  });
  await deliver(service, { payload: Buffer.from("whsec_raw_payload_marker") });
  const joined = [...logs.info, ...logs.warn].join("\n");
  assert.match(joined, /stripe\.webhook/);
  assert.match(joined, /processed/);
  assert.equal(joined.includes("checkout.stripe.com"), false);
  assert.equal(joined.includes("whsec_raw_payload_marker"), false);
  assert.equal(joined.includes("sensitive-session-url"), false);
  assert.equal(joined.includes(IDS.intent), false);
});
