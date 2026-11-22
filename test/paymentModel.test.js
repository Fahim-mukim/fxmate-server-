import test from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import {
  BOOKING_PAYMENT_STATUS,
  PAYMENT_COLLECTION,
  PAYMENT_CURRENCY,
  PAYMENT_INDEXES,
  PAYMENT_PROJECTION,
  PAYMENT_STATUS,
  PAYMENT_STATUSES,
  PAYMENT_TRANSITIONS,
  assertPaymentTransition,
  canTransitionPayment,
  isBookingPayable,
  makeActivePaymentKey,
  normalizePaymentId,
} from "../src/payments/paymentModel.js";
import { BOOKING_STATUS } from "../src/bookings/bookingModel.js";

const BOOKING_ID = "507f1f77bcf86cd7994390b1";

test("reuses the existing payments collection and fixed currency", () => {
  assert.equal(PAYMENT_COLLECTION, "payments");
  assert.equal(PAYMENT_CURRENCY, "usd");
  assert.deepEqual(Object.values(BOOKING_PAYMENT_STATUS), ["unpaid", "paid"]);
});

test("defines all payment statuses and only legal forward transitions", () => {
  assert.deepEqual(Object.values(PAYMENT_STATUS), PAYMENT_STATUSES);
  assert.equal(Object.isFrozen(PAYMENT_TRANSITIONS), true);

  const legal = [
    [PAYMENT_STATUS.CHECKOUT_PENDING, PAYMENT_STATUS.AWAITING_PAYMENT],
    [PAYMENT_STATUS.CHECKOUT_PENDING, PAYMENT_STATUS.CHECKOUT_FAILED],
    [PAYMENT_STATUS.AWAITING_PAYMENT, PAYMENT_STATUS.PROCESSING],
    [PAYMENT_STATUS.AWAITING_PAYMENT, PAYMENT_STATUS.EXPIRED],
    [PAYMENT_STATUS.PROCESSING, PAYMENT_STATUS.PAID],
  ];
  for (const [from, to] of legal) {
    assert.equal(canTransitionPayment(from, to), true);
    assert.doesNotThrow(() => assertPaymentTransition(from, to));
  }

  // Same-state webhook retries are idempotent no-ops, not transitions.
  for (const status of PAYMENT_STATUSES) {
    assert.equal(canTransitionPayment(status, status), false);
  }

  // Terminal states have no outbound transitions; cancelled has no inbound.
  for (const terminal of [
    PAYMENT_STATUS.PAID,
    PAYMENT_STATUS.CHECKOUT_FAILED,
    PAYMENT_STATUS.CANCELLED,
    PAYMENT_STATUS.EXPIRED,
  ]) {
    assert.deepEqual(PAYMENT_TRANSITIONS[terminal], []);
  }
  assert.equal(
    PAYMENT_STATUSES.some((status) =>
      PAYMENT_TRANSITIONS[status].includes(PAYMENT_STATUS.CANCELLED),
    ),
    false,
  );

  assert.equal(canTransitionPayment(PAYMENT_STATUS.PAID, PAYMENT_STATUS.PROCESSING), false);
  assert.throws(
    () => assertPaymentTransition(PAYMENT_STATUS.PAID, PAYMENT_STATUS.PROCESSING),
    { code: "PAYMENT_STATE_CONFLICT", status: 409 },
  );
});

test("normalizes payment ids and builds a deterministic active key", () => {
  const objectId = new ObjectId(BOOKING_ID);
  assert.equal(normalizePaymentId(objectId), objectId);
  assert.equal(normalizePaymentId(BOOKING_ID).toHexString(), BOOKING_ID);
  assert.equal(makeActivePaymentKey(BOOKING_ID), BOOKING_ID);
  assert.throws(() => normalizePaymentId("not-an-id"), {
    code: "VALIDATION_FAILED",
    status: 400,
  });
});

test("eligibility requires a completed, unpaid server-loaded booking", () => {
  const payable = {
    status: BOOKING_STATUS.COMPLETED,
    paymentStatus: BOOKING_PAYMENT_STATUS.UNPAID,
  };
  assert.equal(isBookingPayable(payable), true);

  assert.equal(isBookingPayable(null), false);
  assert.equal(isBookingPayable({ ...payable, paymentStatus: "paid" }), false);
  assert.equal(isBookingPayable({ ...payable, status: BOOKING_STATUS.ACCEPTED }), false);
  assert.equal(isBookingPayable({ status: BOOKING_STATUS.COMPLETED }), false);
});

test("defines sparse unique indexes and excludes internal keys from projection", () => {
  assert.equal(PAYMENT_INDEXES.length, 8);
  const byName = new Map(PAYMENT_INDEXES.map((definition) => [definition.name, definition]));

  for (const name of [
    "payments_active_booking_unique",
    "payments_paid_booking_unique",
    "payments_checkout_session_unique",
    "payments_payment_intent_unique",
  ]) {
    assert.equal(byName.get(name).unique, true);
    assert.equal(byName.get(name).sparse, true);
  }
  assert.equal(byName.get("payments_customer_created").unique, undefined);

  for (const internal of ["activePaymentKey", "paidBookingKey", "checkoutUrl", "clientReferenceId"]) {
    assert.equal(Object.prototype.hasOwnProperty.call(PAYMENT_PROJECTION, internal), false);
  }
  assert.equal(PAYMENT_PROJECTION.bookingId, 1);
  assert.equal(PAYMENT_PROJECTION.status, 1);
});
