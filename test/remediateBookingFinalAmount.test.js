import test from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";

import {
  APPLY_MODE,
  DRY_RUN_MODE,
  evaluatePreconditions,
  parseArgs,
  remediateBookingFinalAmount,
} from "../scripts/remediate-booking-final-amount.js";

const BOOKING_ID = "507f1f77bcf86cd799439011";
const BOOKING_OID = new ObjectId(BOOKING_ID);

function fakeBookingsCollection({ findOneResult, updateOneResult, onUpdate } = {}) {
  const calls = { findOne: [], updateOne: [] };
  return {
    calls,
    async findOne(filter, options) {
      calls.findOne.push({ filter, options });
      return findOneResult;
    },
    async updateOne(filter, update, options) {
      calls.updateOne.push({ filter, update, options });
      if (onUpdate) return onUpdate({ filter, update, options });
      return updateOneResult ?? { matchedCount: 1, modifiedCount: 1 };
    },
  };
}

function fakePaymentsCollection({ payments = [] } = {}) {
  const calls = { find: [], updateOne: 0, deleteOne: 0, deleteMany: 0 };
  return {
    calls,
    find(filter, options) {
      calls.find.push({ filter, options });
      return {
        async toArray() {
          return payments;
        },
      };
    },
    async updateOne() {
      calls.updateOne += 1;
      throw new Error("payments must not be updated");
    },
    async deleteOne() {
      calls.deleteOne += 1;
      throw new Error("payments must not be deleted");
    },
    async deleteMany() {
      calls.deleteMany += 1;
      throw new Error("payments must not be deleted");
    },
  };
}

function baseBooking(overrides = {}) {
  return {
    _id: BOOKING_OID,
    status: "completed",
    paymentStatus: "unpaid",
    finalAmount: 565743,
    ...overrides,
  };
}

function historicalFailedPayment(overrides = {}) {
  return {
    _id: new ObjectId(),
    status: "checkout_failed",
    amount: 565743,
    amountCents: 56574300,
    currency: "usd",
    ...overrides,
  };
}

function silentLogger() {
  return { info() {}, error() {}, warn() {} };
}

test("parseArgs requires booking id, expected old amount, and new amount", () => {
  assert.throws(() => parseArgs([]), /--booking-id is required/);
  assert.throws(() => parseArgs(["--booking-id", BOOKING_ID]), /--expected-old-amount is required/);
  assert.throws(
    () => parseArgs(["--booking-id", BOOKING_ID, "--expected-old-amount", "565743"]),
    /--new-amount is required/,
  );
});

test("parseArgs rejects invalid ObjectId and invalid amounts", () => {
  assert.throws(
    () => parseArgs(["--booking-id", "bad-id", "--expected-old-amount", "565743", "--new-amount", "95"]),
    /valid 24-character hex ObjectId/,
  );
  assert.throws(
    () =>
      parseArgs([
        "--booking-id",
        BOOKING_ID,
        "--expected-old-amount",
        "565743",
        "--new-amount",
        "5000.01",
      ]),
    /--new-amount is invalid/,
  );
  assert.throws(
    () =>
      parseArgs([
        "--booking-id",
        BOOKING_ID,
        "--expected-old-amount",
        "565743",
        "--new-amount",
        "95.555",
      ]),
    /--new-amount is invalid/,
  );
  assert.throws(
    () =>
      parseArgs([
        "--booking-id",
        BOOKING_ID,
        "--expected-old-amount",
        "-1",
        "--new-amount",
        "95",
      ]),
    /expected-old-amount must be a positive finite number/,
  );
});

test("parseArgs accepts valid dry-run and apply args", () => {
  const dry = parseArgs([
    "--booking-id",
    BOOKING_ID,
    "--expected-old-amount",
    "565743",
    "--new-amount",
    "95.50",
  ]);
  assert.equal(dry.apply, false);
  assert.equal(dry.bookingId, BOOKING_ID);
  assert.equal(dry.expectedOldAmount, 565743);
  assert.equal(dry.newAmount, 95.5);

  const apply = parseArgs([
    "--booking-id",
    BOOKING_ID,
    "--expected-old-amount",
    "565743",
    "--new-amount",
    "95.50",
    "--apply",
  ]);
  assert.equal(apply.apply, true);
});

test("dry-run does not update when preconditions pass", async () => {
  const bookings = fakeBookingsCollection({ findOneResult: baseBooking() });
  const payments = fakePaymentsCollection({
    payments: [historicalFailedPayment(), historicalFailedPayment()],
  });

  const summary = await remediateBookingFinalAmount({
    bookingsCollection: bookings,
    paymentsCollection: payments,
    bookingId: BOOKING_ID,
    expectedOldAmount: 565743,
    newAmount: 95.5,
    apply: false,
    logger: silentLogger(),
  });

  assert.equal(summary.mode, DRY_RUN_MODE);
  assert.equal(summary.preconditionOk, true);
  assert.equal(summary.updateResult.outcome, "dry_run");
  assert.equal(bookings.calls.updateOne.length, 0);
  assert.equal(payments.calls.updateOne, 0);
});

test("missing --apply cannot update (apply false path)", async () => {
  const bookings = fakeBookingsCollection({ findOneResult: baseBooking() });
  const payments = fakePaymentsCollection({ payments: [historicalFailedPayment()] });

  const summary = await remediateBookingFinalAmount({
    bookingsCollection: bookings,
    paymentsCollection: payments,
    bookingId: BOOKING_ID,
    expectedOldAmount: 565743,
    newAmount: 95.5,
    apply: false,
    logger: silentLogger(),
  });

  assert.equal(summary.mode, DRY_RUN_MODE);
  assert.equal(bookings.calls.updateOne.length, 0);
});

test("preconditions reject booking not found, wrong old amount, non-completed, paid, paid marker, paid payment, active reservation, and invalid payment states", async () => {
  const cases = [
    {
      name: "booking not found",
      booking: null,
      payments: [],
      expected: "booking_exists",
    },
    {
      name: "wrong expected old amount",
      booking: baseBooking({ finalAmount: 100 }),
      payments: [],
      expected: "final_amount_matches_expected_old",
    },
    {
      name: "non-completed booking",
      booking: baseBooking({ status: "in-progress" }),
      payments: [],
      expected: "booking_completed",
    },
    {
      name: "paid booking",
      booking: baseBooking({ paymentStatus: "paid" }),
      payments: [],
      expected: "booking_unpaid",
    },
    {
      name: "contradictory paid marker",
      booking: baseBooking({ paidByPaymentId: new ObjectId() }),
      payments: [],
      expected: "no_contradictory_paid_marker",
    },
    {
      name: "existing paid payment",
      booking: baseBooking(),
      payments: [historicalFailedPayment({ status: "paid", paidBookingKey: "k" })],
      expected: "no_paid_payment",
    },
    {
      name: "active checkout reservation",
      booking: baseBooking(),
      payments: [historicalFailedPayment({ status: "awaiting_payment", activePaymentKey: "k" })],
      expected: "no_active_checkout_reservation",
    },
    {
      name: "non-historical payment record",
      booking: baseBooking(),
      payments: [historicalFailedPayment({ status: "processing" })],
      expected: "payment_records_historical_only",
    },
  ];

  for (const c of cases) {
    const result = await evaluatePreconditions({
      bookingsCollection: fakeBookingsCollection({ findOneResult: c.booking }),
      paymentsCollection: fakePaymentsCollection({ payments: c.payments }),
      bookingId: BOOKING_ID,
      expectedOldAmount: 565743,
      newAmount: 95.5,
    });
    assert.equal(result.ok, false, c.name);
    assert.ok(
      result.checks.some((check) => check.name === c.expected && check.ok === false),
      c.name,
    );
  }
});

test("invalid new amount is rejected by parseArgs and preconditions reject unsafe amount", async () => {
  assert.throws(
    () =>
      parseArgs([
        "--booking-id",
        BOOKING_ID,
        "--expected-old-amount",
        "565743",
        "--new-amount",
        "5001",
      ]),
    /--new-amount is invalid/,
  );

  const result = await evaluatePreconditions({
    bookingsCollection: fakeBookingsCollection({ findOneResult: baseBooking() }),
    paymentsCollection: fakePaymentsCollection({ payments: [] }),
    bookingId: BOOKING_ID,
    expectedOldAmount: 565743,
    newAmount: 5000.01,
  });
  assert.equal(result.ok, false);
  assert.ok(result.checks.some((c) => c.name === "new_amount_valid" && c.ok === false));
});

test("valid proposed amount passes dry-run with historical failed payments untouched", async () => {
  const payments = [historicalFailedPayment(), historicalFailedPayment()];
  const paymentsCollection = fakePaymentsCollection({ payments });
  const bookings = fakeBookingsCollection({ findOneResult: baseBooking() });

  const summary = await remediateBookingFinalAmount({
    bookingsCollection: bookings,
    paymentsCollection,
    bookingId: BOOKING_ID,
    expectedOldAmount: 565743,
    newAmount: 120,
    apply: false,
    logger: silentLogger(),
  });

  assert.equal(summary.preconditionOk, true);
  assert.equal(summary.mode, DRY_RUN_MODE);
  assert.equal(summary.paymentCount, 2);
  assert.deepEqual(summary.payments.map((p) => p.status), ["checkout_failed", "checkout_failed"]);
  assert.equal(paymentsCollection.calls.updateOne, 0);
});

test("apply mode updates only finalAmount with conditional atomic filter", async () => {
  const bookings = fakeBookingsCollection({
    findOneResult: baseBooking(),
    updateOneResult: { matchedCount: 1, modifiedCount: 1 },
  });
  const payments = fakePaymentsCollection({ payments: [historicalFailedPayment(), historicalFailedPayment()] });

  const summary = await remediateBookingFinalAmount({
    bookingsCollection: bookings,
    paymentsCollection: payments,
    bookingId: BOOKING_ID,
    expectedOldAmount: 565743,
    newAmount: 120,
    apply: true,
    logger: silentLogger(),
  });

  assert.equal(summary.mode, APPLY_MODE);
  assert.equal(summary.updateResult.outcome, "applied");
  assert.equal(bookings.calls.updateOne.length, 1);
  const call = bookings.calls.updateOne[0];
  assert.deepEqual(call.filter, {
    _id: BOOKING_OID,
    status: "completed",
    paymentStatus: "unpaid",
    finalAmount: 565743,
    paidByPaymentId: { $exists: false },
  });
  assert.deepEqual(call.update, { $set: { finalAmount: 120 } });
  assert.equal(payments.calls.updateOne, 0);
});

test("apply mode aborts without update when preconditions fail", async () => {
  const bookings = fakeBookingsCollection({ findOneResult: baseBooking({ paymentStatus: "paid" }) });
  const payments = fakePaymentsCollection({ payments: [] });

  const summary = await remediateBookingFinalAmount({
    bookingsCollection: bookings,
    paymentsCollection: payments,
    bookingId: BOOKING_ID,
    expectedOldAmount: 565743,
    newAmount: 120,
    apply: true,
    logger: silentLogger(),
  });

  assert.equal(summary.mode, APPLY_MODE);
  assert.equal(summary.preconditionOk, false);
  assert.equal(summary.updateResult.outcome, "aborted_preconditions");
  assert.equal(bookings.calls.updateOne.length, 0);
});

test("conditional update race results in safe failure", async () => {
  const bookings = fakeBookingsCollection({
    findOneResult: baseBooking(),
    updateOneResult: { matchedCount: 0, modifiedCount: 0 },
  });
  const payments = fakePaymentsCollection({ payments: [historicalFailedPayment()] });

  await assert.rejects(
    () =>
      remediateBookingFinalAmount({
        bookingsCollection: bookings,
        paymentsCollection: payments,
        bookingId: BOOKING_ID,
        expectedOldAmount: 565743,
        newAmount: 120,
        apply: true,
        logger: silentLogger(),
      }),
    (error) => {
      assert.equal(error.code, "UPDATE_NOT_CONFIRMED");
      assert.equal(error.details.updateResult.outcome, "unexpected_update_result");
      return true;
    },
  );
  assert.equal(bookings.calls.updateOne.length, 1);
  assert.equal(payments.calls.updateOne, 0);
});
