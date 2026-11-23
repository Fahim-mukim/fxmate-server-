import test from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import { HttpError } from "../src/httpError.js";
import { createCheckoutService } from "../src/payments/checkoutService.js";
import {
  ACTIVE_PAYMENT_KEY_FIELD,
  PAYMENT_CHECKOUT_CONFLICT,
  PAYMENT_STATUS,
  checkoutIdempotencyKey,
  makeActivePaymentKey,
} from "../src/payments/paymentModel.js";

const IDS = Object.freeze({
  booking: "507f1f77bcf86cd7994390b1",
  bookingTwo: "507f1f77bcf86cd7994390b2",
  customer: "507f1f77bcf86cd7994390c1",
  otherCustomer: "507f1f77bcf86cd7994390c2",
  technician: "507f1f77bcf86cd7994390a1",
  service: "507f1f77bcf86cd799439201",
  payment: "507f1f77bcf86cd7994390d1",
  otherPayment: "507f1f77bcf86cd7994390d2",
});

const USER = Object.freeze({
  _id: new ObjectId(IDS.customer),
  name: "Canonical Customer",
  email: "Canonical.Customer@Example.test",
});

const CHECKOUT_SESSION = Object.freeze({
  id: "cs_test_abc123",
  url: "https://checkout.stripe.com/pay/cs_test_abc123",
  expires_at: 1800000000,
});

function clone(value) {
  return value ? { ...value } : null;
}

function sampleBooking(overrides = {}) {
  return {
    _id: new ObjectId(IDS.booking),
    customerId: IDS.customer,
    technicianId: IDS.technician,
    serviceId: IDS.service,
    customerName: "Stale Snapshot Name",
    customerEmail: "stale.snapshot@example.test",
    serviceTitle: "Smartphone screen repair",
    technicianName: "Technician One",
    finalAmount: 95.5,
    status: "completed",
    paymentStatus: "unpaid",
    ...overrides,
  };
}

function pendingPayment(overrides = {}) {
  return {
    _id: new ObjectId(IDS.payment),
    bookingId: new ObjectId(IDS.booking),
    customerId: new ObjectId(IDS.customer),
    serviceId: new ObjectId(IDS.service),
    serviceTitle: "Smartphone screen repair",
    amount: 95.5,
    amountCents: 9550,
    currency: "usd",
    status: PAYMENT_STATUS.CHECKOUT_PENDING,
    customerEmail: USER.email.toLowerCase(),
    checkoutUrl: null,
    clientReferenceId: IDS.booking,
    [ACTIVE_PAYMENT_KEY_FIELD]: makeActivePaymentKey(IDS.booking),
    createdAt: new Date("2026-11-22T10:00:00Z"),
    updatedAt: new Date("2026-11-22T10:00:00Z"),
    ...overrides,
  };
}

function awaitingPayment(overrides = {}) {
  return pendingPayment({
    status: PAYMENT_STATUS.AWAITING_PAYMENT,
    stripeCheckoutSessionId: CHECKOUT_SESSION.id,
    checkoutUrl: CHECKOUT_SESSION.url,
    expiresAt: new Date(1800000000000),
    ...overrides,
  });
}

function checkoutConflict() {
  return new HttpError(409, PAYMENT_CHECKOUT_CONFLICT, "Reserved.");
}

function fakeBookings({ booking = sampleBooking(), error = null } = {}) {
  const calls = [];
  return {
    calls,
    async findForCustomer(id, customerId) {
      calls.push({ id, customerId });
      if (error) throw error;
      return clone(booking);
    },
  };
}

function fakePayments(initial = {}) {
  const state = {
    active: clone(initial.active ?? null),
    paid: clone(initial.paid ?? null),
    sessions: new Map(initial.sessions ?? []),
    calls: [],
    insertError: initial.insertError ?? null,
    duplicateWinner: initial.duplicateWinner ?? null,
    ignoreScope: Boolean(initial.ignoreScope),
    saveError: initial.saveError ?? null,
    saveConflictTarget: initial.saveConflictTarget ?? null,
    saveReturnsNull: Boolean(initial.saveReturnsNull),
    markFailedReturnsNull: Boolean(initial.markFailedReturnsNull),
    markFailedWinner: initial.markFailedWinner ?? null,
  };

  function matchesScope(payment, scope) {
    return String(payment.bookingId) === String(scope.bookingId) &&
      String(payment.customerId) === String(scope.customerId);
  }

  return {
    state,
    async findActiveCheckout(scope) {
      state.calls.push({ method: "findActiveCheckout", scope });
      const found =
        state.active && (state.ignoreScope || matchesScope(state.active, scope))
          ? state.active
          : null;
      return clone(found);
    },
    async findPaidCheckout(scope) {
      state.calls.push({ method: "findPaidCheckout", scope });
      const found = state.paid && matchesScope(state.paid, scope) ? state.paid : null;
      return clone(found);
    },
    async findByCheckoutSessionId({ sessionId, bookingId, customerId }) {
      state.calls.push({ method: "findByCheckoutSessionId", sessionId });
      const found = state.sessions.get(sessionId);
      if (!found) return null;
      if (bookingId && String(found.bookingId) !== String(bookingId)) return null;
      if (customerId && String(found.customerId) !== String(customerId)) return null;
      return clone(found);
    },
    async insertCheckoutReservation(document) {
      state.calls.push({ method: "insertCheckoutReservation", document });
      if (state.insertError) throw state.insertError;
      if (state.duplicateWinner) {
        const winner =
          typeof state.duplicateWinner === "function"
            ? state.duplicateWinner(document)
            : state.duplicateWinner;
        state.active = clone(winner);
        throw checkoutConflict();
      }
      state.active = clone(document);
      return clone(document);
    },
    async saveCheckoutSession({ payment, sessionId, checkoutUrl, expiresAt, now }) {
      state.calls.push({ method: "saveCheckoutSession", sessionId });
      if (state.saveError) {
        if (state.saveConflictTarget) {
          const target =
            typeof state.saveConflictTarget === "function"
              ? state.saveConflictTarget(payment)
              : state.saveConflictTarget;
          state.sessions.set(sessionId, clone(target));
        }
        throw state.saveError;
      }
      const saved = {
        ...state.active,
        status: PAYMENT_STATUS.AWAITING_PAYMENT,
        stripeCheckoutSessionId: sessionId,
        checkoutUrl,
        expiresAt,
        updatedAt: now,
      };
      state.sessions.set(sessionId, clone(saved));
      if (state.saveReturnsNull) {
        state.active = clone(saved);
        return null;
      }
      state.active = clone(saved);
      return clone(saved);
    },
    async markCheckoutFailed({ payment, now }) {
      state.calls.push({ method: "markCheckoutFailed", paymentId: payment._id });
      if (state.markFailedWinner) {
        const winner =
          typeof state.markFailedWinner === "function"
            ? state.markFailedWinner(payment)
            : state.markFailedWinner;
        state.active = clone(winner);
        return null;
      }
      if (state.markFailedReturnsNull) return null;
      if (!state.active || String(state.active._id) !== String(payment._id)) return null;
      const failed = {
        ...state.active,
        status: PAYMENT_STATUS.CHECKOUT_FAILED,
        updatedAt: now,
      };
      delete failed[ACTIVE_PAYMENT_KEY_FIELD];
      state.active = failed;
      return clone(failed);
    },
  };
}

function fakeStripe({ session = CHECKOUT_SESSION, error = null, errors = [] } = {}) {
  const calls = [];
  return {
    calls,
    value: {
      client: {
        checkout: {
          sessions: {
            async create(params, options) {
              calls.push({ params, options });
              if (errors.length > 0) throw errors.shift();
              if (error) throw error;
              return session;
            },
          },
        },
      },
    },
  };
}

function setup({
  booking,
  bookingError,
  payments = {},
  stripe = fakeStripe(),
  logger,
  now = () => new Date("2026-11-22T12:00:00Z"),
} = {}) {
  const bookings = fakeBookings({ booking, error: bookingError });
  const paymentStore = fakePayments(payments);
  const service = createCheckoutService({
    bookings,
    payments: paymentStore,
    stripe: stripe?.value ?? stripe,
    redirectOrigin: "https://client.example.com",
    logger,
    now,
  });
  return { service, bookings, payments: paymentStore, stripe };
}

async function expectCode(promise, status, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.status, status);
    assert.equal(error.code, code);
    return true;
  });
}

test("creates one Checkout Session from trusted booking and canonical user data", async () => {
  const { service, bookings, payments, stripe } = setup();

  const result = await service.createCheckout({
    bookingId: IDS.booking,
    user: USER,
    amount: 1,
    customerId: IDS.otherCustomer,
    customerEmail: "attacker@example.test",
    status: "paid",
  });

  assert.deepEqual(Object.keys(result).sort(), [
    "checkoutUrl",
    "paymentId",
    "sessionId",
    "status",
  ]);
  assert.equal(result.sessionId, CHECKOUT_SESSION.id);
  assert.equal(result.checkoutUrl, CHECKOUT_SESSION.url);
  assert.equal(result.status, PAYMENT_STATUS.AWAITING_PAYMENT);
  assert.equal(bookings.calls[0].id, IDS.booking);
  assert.equal(String(bookings.calls[0].customerId), IDS.customer);

  assert.equal(stripe.calls.length, 1);
  const { params, options } = stripe.calls[0];
  assert.equal(options.idempotencyKey, checkoutIdempotencyKey(result.paymentId));
  assert.equal(params.line_items[0].price_data.unit_amount, 9550);
  assert.equal(params.customer_email, USER.email.toLowerCase());
  assert.deepEqual(params.metadata, {
    paymentId: result.paymentId,
    bookingId: IDS.booking,
    customerId: IDS.customer,
  });

  const saved = payments.state.active;
  assert.equal(saved.status, PAYMENT_STATUS.AWAITING_PAYMENT);
  assert.equal(saved.stripeCheckoutSessionId, CHECKOUT_SESSION.id);
  assert.equal(saved.checkoutUrl, CHECKOUT_SESSION.url);
  assert.equal(saved.expiresAt.getTime(), 1800000000000);
  assert.ok(saved.updatedAt instanceof Date);
  assert.equal(saved.customerEmail, USER.email.toLowerCase());
  assert.equal(saved.customerName, USER.name);
  assert.equal(saved.serviceTitle, "Smartphone screen repair");
  assert.equal(String(saved.customerId), IDS.customer);
});

test("missing or foreign bookings never reach Stripe or the payments collection", async () => {
  const notFound = new HttpError(404, "NOT_FOUND", "Booking not found.");
  const { service, payments, stripe } = setup({ bookingError: notFound });

  await expectCode(
    service.createCheckout({ bookingId: IDS.booking, user: USER }),
    404,
    "NOT_FOUND",
  );
  assert.equal(stripe.calls.length, 0);
  assert.equal(payments.state.calls.some((call) => call.method === "insertCheckoutReservation"), false);
});

test("only completed unpaid bookings are payable", async () => {
  for (const overrides of [
    { status: "accepted" },
    { status: "completed", paymentStatus: "paid" },
    { status: "cancelled" },
  ]) {
    const { service, payments, stripe } = setup({ booking: sampleBooking(overrides) });
    const expected = overrides.paymentStatus === "paid"
      ? ["PAYMENT_ALREADY_PAID"]
      : [409, "BOOKING_NOT_PAYABLE"];
    if (expected.length === 1) {
      await expectCode(
        service.createCheckout({ bookingId: IDS.booking, user: USER }),
        409,
        expected[0],
      );
    } else {
      await expectCode(
        service.createCheckout({ bookingId: IDS.booking, user: USER }),
        expected[0],
        expected[1],
      );
    }
    assert.equal(stripe.calls.length, 0);
    assert.equal(payments.state.calls.some((call) => call.method === "insertCheckoutReservation"), false);
  }
});

test("invalid persisted amounts fail before any write or Stripe call", async () => {
  for (const finalAmount of [0, -5, 1.234, "95.5", NaN, Infinity, null]) {
    const { service, payments, stripe } = setup({
      booking: sampleBooking({ finalAmount }),
    });
    await expectCode(
      service.createCheckout({ bookingId: IDS.booking, user: USER }),
      409,
      "PAYMENT_AMOUNT_INVALID",
    );
    assert.equal(stripe.calls.length, 0);
    assert.equal(payments.state.calls.some((call) => call.method === "insertCheckoutReservation"), false);
  }
});

test("an existing paid payment rejects checkout before Stripe", async () => {
  const { service, payments, stripe } = setup({
    payments: { paid: pendingPayment({ status: PAYMENT_STATUS.PAID }) },
  });

  await expectCode(
    service.createCheckout({ bookingId: IDS.booking, user: USER }),
    409,
    "PAYMENT_ALREADY_PAID",
  );
  assert.equal(stripe.calls.length, 0);
  assert.equal(payments.state.calls.some((call) => call.method === "insertCheckoutReservation"), false);
});

test("an exact active Session is reused without creating another Session", async () => {
  const existing = awaitingPayment();
  const { service, payments, stripe } = setup({ payments: { active: existing } });

  const result = await service.createCheckout({ bookingId: IDS.booking, user: USER });

  assert.deepEqual(result, {
    checkoutUrl: CHECKOUT_SESSION.url,
    paymentId: IDS.payment,
    sessionId: CHECKOUT_SESSION.id,
    status: PAYMENT_STATUS.AWAITING_PAYMENT,
  });
  assert.equal(stripe.calls.length, 0);
  assert.equal(payments.state.calls.some((call) => call.method === "insertCheckoutReservation"), false);
});

test("an active attempt belonging to another booking or customer is a safe conflict", async () => {
  for (const overrides of [
    { bookingId: new ObjectId(IDS.bookingTwo) },
    { customerId: new ObjectId(IDS.otherCustomer) },
  ]) {
    const { service, stripe } = setup({
      payments: { active: awaitingPayment(overrides), ignoreScope: true },
    });
    await expectCode(
      service.createCheckout({ bookingId: IDS.booking, user: USER }),
      409,
      PAYMENT_CHECKOUT_CONFLICT,
    );
    assert.equal(stripe.calls.length, 0);
  }
});

test("a concurrent duplicate insert re-reads and reuses the exact winning attempt", async () => {
  const winner = awaitingPayment();
  const { service, stripe } = setup({
    payments: { duplicateWinner: winner },
  });

  const result = await service.createCheckout({ bookingId: IDS.booking, user: USER });

  assert.equal(result.paymentId, IDS.payment);
  assert.equal(result.sessionId, CHECKOUT_SESSION.id);
  assert.equal(stripe.calls.length, 0);
});

test("a duplicate reservation without a reusable attempt is a safe conflict", async () => {
  const { service, stripe } = setup({
    payments: { insertError: checkoutConflict() },
  });

  await expectCode(
    service.createCheckout({ bookingId: IDS.booking, user: USER }),
    409,
    PAYMENT_CHECKOUT_CONFLICT,
  );
  assert.equal(stripe.calls.length, 0);
});

test("a definite Stripe rejection releases the reservation", async () => {
  const stripe = fakeStripe({
    error: Object.assign(new Error("invalid request"), {
      type: "StripeInvalidRequestError",
      statusCode: 400,
    }),
  });
  const { service, payments } = setup({ stripe });

  await expectCode(
    service.createCheckout({ bookingId: IDS.booking, user: USER }),
    502,
    "PAYMENT_PROVIDER_FAILED",
  );
  assert.equal(payments.state.active.status, PAYMENT_STATUS.CHECKOUT_FAILED);
  assert.equal(payments.state.active[ACTIVE_PAYMENT_KEY_FIELD], undefined);
  assert.equal(
    payments.state.calls.filter((call) => call.method === "markCheckoutFailed").length,
    1,
  );
});

test("a definite failure after a concurrent save reuses the saved Session", async () => {
  const stripe = fakeStripe({
    error: Object.assign(new Error("invalid request"), {
      type: "StripeInvalidRequestError",
      statusCode: 400,
    }),
  });
  const { service } = setup({
    stripe,
    payments: { markFailedWinner: (payment) => awaitingPayment({ _id: payment._id }) },
  });

  const result = await service.createCheckout({ bookingId: IDS.booking, user: USER });

  assert.equal(result.sessionId, CHECKOUT_SESSION.id);
  assert.equal(stripe.calls.length, 1);
});

test("an ambiguous Stripe failure keeps the attempt and retries with the same key", async () => {
  const stripe = fakeStripe({
    errors: [Object.assign(new Error("fetch failed"), { statusCode: 500 })],
  });
  const { service, payments } = setup({ stripe });

  await expectCode(
    service.createCheckout({ bookingId: IDS.booking, user: USER }),
    503,
    "PAYMENT_PROVIDER_UNAVAILABLE",
  );
  assert.equal(payments.state.active.status, PAYMENT_STATUS.CHECKOUT_PENDING);
  assert.equal(
    payments.state.active[ACTIVE_PAYMENT_KEY_FIELD],
    makeActivePaymentKey(IDS.booking),
  );

  const retry = await service.createCheckout({ bookingId: IDS.booking, user: USER });

  assert.equal(retry.sessionId, CHECKOUT_SESSION.id);
  assert.equal(stripe.calls.length, 2);
  assert.equal(stripe.calls[0].options.idempotencyKey, stripe.calls[1].options.idempotencyKey);
  assert.equal(payments.state.calls.filter((call) => call.method === "insertCheckoutReservation").length, 1);
});

test("Stripe authentication failure logs safe fields and returns generic 502", async () => {
  const loggerCalls = [];
  const logger = { error: (entry) => loggerCalls.push(entry) };
  const stripe = fakeStripe({
    error: Object.assign(new Error("Invalid API Key provided: sk_test_secret"), {
      type: "StripeAuthenticationError",
      code: "api_key_expired",
      statusCode: 401,
      requestId: "req_test_auth_123",
    }),
  });
  const { service } = setup({ stripe, logger });

  await expectCode(
    service.createCheckout({ bookingId: IDS.booking, user: USER }),
    502,
    "PAYMENT_PROVIDER_FAILED",
  );

  assert.equal(loggerCalls.length, 1);
  const event = JSON.parse(loggerCalls[0]);
  assert.deepEqual(event, {
    event: "stripe_checkout_create_failed",
    stripeType: "StripeAuthenticationError",
    stripeCode: "api_key_expired",
    stripeStatusCode: 401,
    stripeRequestId: "req_test_auth_123",
    definite: true,
    idempotencyKeyPresent: true,
  });
});

test("Stripe invalid request failure logs safe fields and returns generic 502", async () => {
  const loggerCalls = [];
  const logger = { error: (entry) => loggerCalls.push(entry) };
  const stripe = fakeStripe({
    error: Object.assign(new Error("Invalid parameter"), {
      type: "StripeInvalidRequestError",
      code: "parameter_invalid_empty",
      statusCode: 400,
      requestId: "req_test_invalid_456",
    }),
  });
  const { service, payments } = setup({ stripe, logger });

  await expectCode(
    service.createCheckout({ bookingId: IDS.booking, user: USER }),
    502,
    "PAYMENT_PROVIDER_FAILED",
  );

  assert.equal(loggerCalls.length, 1);
  const event = JSON.parse(loggerCalls[0]);
  assert.equal(event.event, "stripe_checkout_create_failed");
  assert.equal(event.stripeType, "StripeInvalidRequestError");
  assert.equal(event.stripeCode, "parameter_invalid_empty");
  assert.equal(event.stripeStatusCode, 400);
  assert.equal(event.stripeRequestId, "req_test_invalid_456");
  assert.equal(event.definite, true);
  assert.equal(event.idempotencyKeyPresent, true);
  assert.equal(payments.state.active.status, PAYMENT_STATUS.CHECKOUT_FAILED);
});

test("Ambiguous Stripe/network failure logs definite:false and returns generic 503", async () => {
  const loggerCalls = [];
  const logger = { error: (entry) => loggerCalls.push(entry) };
  const stripe = fakeStripe({
    error: Object.assign(new Error("fetch failed"), { statusCode: 500, requestId: "req_test_ambig_789" }),
  });
  const { service, payments } = setup({ stripe, logger });

  await expectCode(
    service.createCheckout({ bookingId: IDS.booking, user: USER }),
    503,
    "PAYMENT_PROVIDER_UNAVAILABLE",
  );

  assert.equal(loggerCalls.length, 1);
  const event = JSON.parse(loggerCalls[0]);
  assert.equal(event.event, "stripe_checkout_create_failed");
  assert.equal(event.definite, false);
  assert.equal(event.idempotencyKeyPresent, true);
  assert.equal(event.stripeStatusCode, 500);
  assert.equal(event.stripeRequestId, "req_test_ambig_789");
  assert.equal(payments.state.active.status, PAYMENT_STATUS.CHECKOUT_PENDING);
});

test("Stripe checkout failure logs contain no forbidden secrets, PII, raw objects, or URLs", async () => {
  const loggerCalls = [];
  const logger = { error: (entry) => loggerCalls.push(entry) };
  const secretKey = "sk_test_super_secret_value";
  const webhookSecret = "whsec_super_secret_value";
  const customerEmail = "Canonical.Customer@Example.test";
  const customerName = "Canonical Customer";
  const checkoutUrl = "https://checkout.stripe.com/c/pay/cs_test_abc123";
  const stripe = fakeStripe({
    error: Object.assign(new Error(`Stripe failure ${secretKey} ${webhookSecret} ${customerEmail}`), {
      type: "StripeAuthenticationError",
      code: "api_key_expired",
      statusCode: 401,
      requestId: "req_test_safe_000",
      header: `Bearer ${secretKey}`,
      raw: {
        message: `bad key ${secretKey}`,
        headers: { authorization: `Bearer ${secretKey}` },
      },
    }),
  });
  const { service } = setup({ stripe, logger });

  await expectCode(
    service.createCheckout({ bookingId: IDS.booking, user: USER }),
    502,
    "PAYMENT_PROVIDER_FAILED",
  );

  assert.equal(loggerCalls.length, 1);
  const logged = String(loggerCalls[0]);
  for (const forbidden of [
    secretKey,
    webhookSecret,
    customerEmail,
    customerName,
    checkoutUrl,
    "Bearer ",
    "authorization",
    "sk_test_",
    "whsec_",
    "[object Object]",
  ]) {
    assert.equal(logged.includes(forbidden), false, `log leaked: ${forbidden}`);
  }

  const event = JSON.parse(logged);
  assert.deepEqual(Object.keys(event).sort(), [
    "definite",
    "event",
    "idempotencyKeyPresent",
    "stripeCode",
    "stripeRequestId",
    "stripeStatusCode",
    "stripeType",
  ]);
});

test("a Session saved with a conditional-write conflict is recovered on the same request", async () => {
  const stripe = fakeStripe();
  const { service } = setup({
    stripe,
    payments: {
      saveError: checkoutConflict(),
      saveConflictTarget: (payment) => awaitingPayment({ _id: payment._id }),
    },
  });

  const result = await service.createCheckout({ bookingId: IDS.booking, user: USER });

  assert.equal(result.sessionId, CHECKOUT_SESSION.id);
  assert.equal(stripe.calls.length, 1);
});

test("a conflicting Session belonging to another payment is a safe conflict", async () => {
  const { service, stripe } = setup({
    payments: {
      saveError: checkoutConflict(),
      saveConflictTarget: awaitingPayment({
        _id: new ObjectId(IDS.otherPayment),
      }),
    },
  });

  await expectCode(
    service.createCheckout({ bookingId: IDS.booking, user: USER }),
    409,
    PAYMENT_CHECKOUT_CONFLICT,
  );
  assert.equal(stripe.calls.length, 1);
});

test("a conditional-update miss re-reads the exact attempt before returning", async () => {
  const { service, payments } = setup({
    payments: { saveReturnsNull: true },
  });

  const result = await service.createCheckout({ bookingId: IDS.booking, user: USER });

  assert.equal(result.paymentId, String(payments.state.active._id));
  assert.equal(result.status, PAYMENT_STATUS.AWAITING_PAYMENT);
});

test("missing Stripe configuration is a definite pre-creation failure", async () => {
  for (const stripe of [null, { client: {} }]) {
    const { service, payments } = setup({ stripe });
    await expectCode(
      service.createCheckout({ bookingId: IDS.booking, user: USER }),
      503,
      "PAYMENT_NOT_CONFIGURED",
    );
    assert.equal(payments.state.active.status, PAYMENT_STATUS.CHECKOUT_FAILED);
    assert.equal(payments.state.active[ACTIVE_PAYMENT_KEY_FIELD], undefined);
  }
});

test("a malformed Stripe response keeps the attempt pending for a same-key retry", async () => {
  const stripe = fakeStripe({
    errors: [{ id: "cs_test_bad", url: "https://evil.test/pay" }],
  });
  const { service, payments } = setup({ stripe });

  await expectCode(
    service.createCheckout({ bookingId: IDS.booking, user: USER }),
    503,
    "PAYMENT_PROVIDER_UNAVAILABLE",
  );
  assert.equal(payments.state.active.status, PAYMENT_STATUS.CHECKOUT_PENDING);
  assert.equal(payments.state.active[ACTIVE_PAYMENT_KEY_FIELD], makeActivePaymentKey(IDS.booking));
  assert.equal(
    payments.state.calls.filter((call) => call.method === "markCheckoutFailed").length,
    0,
  );

  const retry = await service.createCheckout({ bookingId: IDS.booking, user: USER });
  assert.equal(retry.sessionId, CHECKOUT_SESSION.id);
  assert.equal(stripe.calls[0].options.idempotencyKey, stripe.calls[1].options.idempotencyKey);
});

test("the checkout service never logs the hosted Checkout URL", async () => {
  const originals = ["info", "error", "warn", "debug", "log"].map((name) => [name, console[name]]);
  const output = [];
  for (const name of ["info", "error", "warn", "debug", "log"]) {
    console[name] = (...args) => output.push(args.map(String).join(" "));
  }

  try {
    const success = fakeStripe();
    await setup({ stripe: success }).service.createCheckout({ bookingId: IDS.booking, user: USER });

    const failure = fakeStripe({
      error: Object.assign(new Error("fetch failed"), { statusCode: 500 }),
    });
    await assert.rejects(
      setup({ stripe: failure }).service.createCheckout({ bookingId: IDS.booking, user: USER }),
    );
  } finally {
    for (const [name, original] of originals) console[name] = original;
  }

  assert.equal(output.some((line) => line.includes(CHECKOUT_SESSION.url)), false);
});
