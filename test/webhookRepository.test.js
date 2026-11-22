import test from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import { createPaymentRepository } from "../src/payments/paymentRepository.js";
import { createBookingRepository } from "../src/bookings/bookingRepository.js";
import {
  ACTIVE_PAYMENT_KEY_FIELD,
  PAID_BOOKING_KEY_FIELD,
  PAYMENT_STATUS,
  PAYMENT_WEBHOOK_PROJECTION,
  makeActivePaymentKey,
  makePaidBookingKey,
} from "../src/payments/paymentModel.js";
import {
  BOOKING_WEBHOOK_PROJECTION,
  PAID_BY_PAYMENT_ID_FIELD,
} from "../src/bookings/bookingModel.js";
import { WEBHOOK_CODES } from "../src/payments/webhookEvent.js";

const IDS = Object.freeze({
  payment: "507f1f77bcf86cd7994390d1",
  booking: "507f1f77bcf86cd7994390b1",
  customer: "507f1f77bcf86cd7994390c1",
  session: "cs_test_abc123",
  intent: "pi_123456789",
  event: "evt_123456789",
});
const NOW = new Date("2026-11-22T12:00:00.000Z");

function fakeDatabase(collections) {
  return {
    isReady: () => true,
    getDb: () => ({
      collection(name) {
        if (!collections[name]) throw new Error(`unexpected collection ${name}`);
        return collections[name];
      },
    }),
  };
}

function collectionStub({ findOneResult = null, updateResult = null, updateError = null } = {}) {
  const calls = [];
  return {
    calls,
    findOneResult,
    updateResult,
    updateError,
    async findOne(filter, options) {
      calls.push({ method: "findOne", filter, options });
      return findOneResult;
    },
    async findOneAndUpdate(filter, update, options) {
      calls.push({ method: "findOneAndUpdate", filter, update, options });
      if (updateError) throw updateError;
      return { value: updateResult };
    },
  };
}

function paymentFixture(overrides = {}) {
  return {
    _id: new ObjectId(IDS.payment),
    bookingId: new ObjectId(IDS.booking),
    customerId: new ObjectId(IDS.customer),
    amount: 95.5,
    amountCents: 9550,
    currency: "usd",
    status: PAYMENT_STATUS.AWAITING_PAYMENT,
    stripeCheckoutSessionId: IDS.session,
    [ACTIVE_PAYMENT_KEY_FIELD]: makeActivePaymentKey(IDS.booking),
    ...overrides,
  };
}

function paymentRepository(collection) {
  return createPaymentRepository({ database: fakeDatabase({ payments: collection }) });
}

function bookingRepository(collection) {
  return createBookingRepository({ database: fakeDatabase({ bookings: collection }) });
}

function duplicateKeyError() {
  const error = new Error("duplicate");
  error.code = 11000;
  return error;
}

test("webhook payment read uses the exact id and internal projection", async () => {
  const stored = paymentFixture();
  const collection = collectionStub({ findOneResult: stored });
  const repository = paymentRepository(collection);

  const result = await repository.findByIdForWebhook(IDS.payment);
  assert.deepEqual(collection.calls[0].filter, { _id: new ObjectId(IDS.payment) });
  assert.deepEqual(collection.calls[0].options.projection, {
    ...PAYMENT_WEBHOOK_PROJECTION,
  });
  assert.equal(String(result._id), IDS.payment);
});

test("Session recovery only advances an exact active checkout_pending payment", async () => {
  const payment = paymentFixture({
    status: PAYMENT_STATUS.CHECKOUT_PENDING,
    stripeCheckoutSessionId: undefined,
  });
  const collection = collectionStub({ updateResult: payment });
  const repository = paymentRepository(collection);

  await repository.associateSessionForWebhook({ payment, sessionId: IDS.session, now: NOW });

  const call = collection.calls[0];
  assert.equal(call.method, "findOneAndUpdate");
  assert.deepEqual(call.filter, {
    _id: payment._id,
    bookingId: payment.bookingId,
    customerId: payment.customerId,
    [ACTIVE_PAYMENT_KEY_FIELD]: makeActivePaymentKey(IDS.booking),
    [PAID_BOOKING_KEY_FIELD]: { $exists: false },
    status: PAYMENT_STATUS.CHECKOUT_PENDING,
    amountCents: 9550,
    currency: "usd",
    $or: [
      { stripeCheckoutSessionId: { $exists: false } },
      { stripeCheckoutSessionId: null },
      { stripeCheckoutSessionId: IDS.session },
    ],
  });
  assert.deepEqual(call.update.$set, {
    status: PAYMENT_STATUS.AWAITING_PAYMENT,
    stripeCheckoutSessionId: IDS.session,
    updatedAt: NOW,
  });
});

test("recovery duplicate-key conflicts are mapped to a safe webhook conflict", async () => {
  const payment = paymentFixture({ status: PAYMENT_STATUS.CHECKOUT_PENDING });
  const collection = collectionStub({ updateError: duplicateKeyError() });
  await assert.rejects(
    paymentRepository(collection).associateSessionForWebhook({
      payment,
      sessionId: IDS.session,
    }),
    { status: 409, code: WEBHOOK_CODES.CONFLICT },
  );
});

test("processing, finalization, and expiration all use exact-attempt conditional writes", async () => {
  const payment = paymentFixture();
  const processingCollection = collectionStub({ updateResult: payment });
  await paymentRepository(processingCollection).markPaymentProcessing({
    payment,
    sessionId: IDS.session,
    now: NOW,
  });
  assert.deepEqual(processingCollection.calls[0].filter, {
    _id: payment._id,
    bookingId: payment.bookingId,
    customerId: payment.customerId,
    [ACTIVE_PAYMENT_KEY_FIELD]: makeActivePaymentKey(IDS.booking),
    [PAID_BOOKING_KEY_FIELD]: { $exists: false },
    status: PAYMENT_STATUS.AWAITING_PAYMENT,
    stripeCheckoutSessionId: IDS.session,
    amountCents: 9550,
    currency: "usd",
  });

  const finalCollection = collectionStub({ updateResult: payment });
  await paymentRepository(finalCollection).finalizePayment({
    payment,
    bookingId: IDS.booking,
    sessionId: IDS.session,
    paymentIntentId: IDS.intent,
    eventId: IDS.event,
    now: NOW,
  });
  const finalCall = finalCollection.calls[0];
  assert.equal(finalCall.filter.status, PAYMENT_STATUS.PROCESSING);
  assert.deepEqual(finalCall.filter.$or, [
    { stripePaymentIntentId: { $exists: false } },
    { stripePaymentIntentId: null },
    { stripePaymentIntentId: IDS.intent },
  ]);
  assert.deepEqual(finalCall.update.$set, {
    status: PAYMENT_STATUS.PAID,
    stripeCheckoutSessionId: IDS.session,
    stripePaymentIntentId: IDS.intent,
    stripeEventId: IDS.event,
    paidAt: NOW,
    updatedAt: NOW,
    [PAID_BOOKING_KEY_FIELD]: makePaidBookingKey(IDS.booking),
  });
  assert.deepEqual(finalCall.update.$unset, { [ACTIVE_PAYMENT_KEY_FIELD]: "" });

  const expireCollection = collectionStub({ updateResult: payment });
  await paymentRepository(expireCollection).markPaymentExpired({
    payment,
    sessionId: IDS.session,
    now: NOW,
  });
  const expireCall = expireCollection.calls[0];
  assert.equal(expireCall.filter.status, PAYMENT_STATUS.AWAITING_PAYMENT);
  assert.deepEqual(expireCall.update.$set, {
    status: PAYMENT_STATUS.EXPIRED,
    updatedAt: NOW,
  });
  assert.deepEqual(expireCall.update.$unset, { [ACTIVE_PAYMENT_KEY_FIELD]: "" });
});

test("finalization duplicate-key conflicts are mapped to a safe webhook conflict", async () => {
  const payment = paymentFixture({ status: PAYMENT_STATUS.PROCESSING });
  const collection = collectionStub({ updateError: duplicateKeyError() });
  await assert.rejects(
    paymentRepository(collection).finalizePayment({
      payment,
      sessionId: IDS.session,
      paymentIntentId: IDS.intent,
      eventId: IDS.event,
    }),
    { status: 409, code: WEBHOOK_CODES.CONFLICT },
  );
});

test("webhook booking reads include the server-owned same-attempt marker", async () => {
  const collection = collectionStub({});
  const repository = bookingRepository(collection);
  await repository.findForPaymentWebhook({
    bookingId: IDS.booking,
    customerId: IDS.customer,
  });
  assert.deepEqual(collection.calls[0].filter, {
    _id: new ObjectId(IDS.booking),
    customerId: new ObjectId(IDS.customer),
  });
  assert.deepEqual(collection.calls[0].options.projection, {
    ...BOOKING_WEBHOOK_PROJECTION,
  });
  assert.equal(BOOKING_WEBHOOK_PROJECTION[PAID_BY_PAYMENT_ID_FIELD], 1);
});

test("booking payment update allows unpaid or same-payment retries only", async () => {
  const collection = collectionStub({ updateResult: {} });
  const repository = bookingRepository(collection);
  await repository.markBookingPaidForPayment({
    bookingId: IDS.booking,
    customerId: IDS.customer,
    paymentId: IDS.payment,
    finalAmount: 95.5,
  });

  const call = collection.calls[0];
  assert.deepEqual(call.filter, {
    _id: new ObjectId(IDS.booking),
    customerId: new ObjectId(IDS.customer),
    status: "completed",
    finalAmount: 95.5,
    $or: [
      {
        paymentStatus: "unpaid",
        [PAID_BY_PAYMENT_ID_FIELD]: { $exists: false },
      },
      {
        paymentStatus: "paid",
        [PAID_BY_PAYMENT_ID_FIELD]: new ObjectId(IDS.payment),
      },
    ],
  });
  assert.deepEqual(call.update.$set, {
    paymentStatus: "paid",
    [PAID_BY_PAYMENT_ID_FIELD]: new ObjectId(IDS.payment),
  });
});

test("booking payment update returns null when no optimistic condition matches", async () => {
  const collection = collectionStub({ updateResult: null });
  const result = await bookingRepository(collection).markBookingPaidForPayment({
    bookingId: IDS.booking,
    customerId: IDS.customer,
    paymentId: IDS.payment,
    finalAmount: 95.5,
  });
  assert.equal(result, null);
});
