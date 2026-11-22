import test from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import { createPaymentRepository } from "../src/payments/paymentRepository.js";
import {
  ACTIVE_PAYMENT_KEY_FIELD,
  PAID_BOOKING_KEY_FIELD,
  PAYMENT_CHECKOUT_CONFLICT,
  PAYMENT_STATUS,
  makeActivePaymentKey,
} from "../src/payments/paymentModel.js";

const IDS = Object.freeze({
  booking: "507f1f77bcf86cd7994390b1",
  customer: "507f1f77bcf86cd7994390c1",
  payment: "507f1f77bcf86cd7994390d1",
});

function fakeCollection({ findOneResult = null, updateResult = null, duplicate = false } = {}) {
  const calls = [];
  return {
    calls,
    async indexes() {
      calls.push({ method: "indexes" });
      return [];
    },
    async createIndex(keys, options) {
      calls.push({ method: "createIndex", keys, options });
    },
    async findOne(filter, options) {
      calls.push({ method: "findOne", filter, options });
      return findOneResult ? { ...findOneResult } : null;
    },
    async insertOne(document) {
      calls.push({ method: "insertOne", document });
      if (duplicate) {
        throw Object.assign(new Error("duplicate key"), { code: 11000 });
      }
      return { insertedId: document._id };
    },
    async findOneAndUpdate(filter, update, options) {
      calls.push({ method: "findOneAndUpdate", filter, update, options });
      const value = updateResult ? { ...updateResult } : null;
      if (value && update?.$set) Object.assign(value, update.$set);
      if (value && update?.$unset) {
        for (const field of Object.keys(update.$unset)) delete value[field];
      }
      return { value };
    },
  };
}

function fakeDatabase(collection, ready = true) {
  return {
    isReady: () => ready,
    getDb: () => ({ collection: () => collection }),
  };
}

function sampleDocument(overrides = {}) {
  return {
    _id: new ObjectId(IDS.payment),
    bookingId: new ObjectId(IDS.booking),
    customerId: new ObjectId(IDS.customer),
    serviceTitle: "Smartphone screen repair",
    amountCents: 9550,
    status: PAYMENT_STATUS.CHECKOUT_PENDING,
    stripeCheckoutSessionId: "cs_test_abc",
    checkoutUrl: "https://checkout.stripe.com/pay/cs_test_abc",
    [ACTIVE_PAYMENT_KEY_FIELD]: makeActivePaymentKey(IDS.booking),
    [PAID_BOOKING_KEY_FIELD]: makeActivePaymentKey(IDS.booking),
    stripeSecretKey: "must-not-be-projected",
    updatedAt: new Date("2026-11-22T10:00:00Z"),
    ...overrides,
  };
}

async function expectCode(promise, status, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.status, status);
    assert.equal(error.code, code);
    return true;
  });
}

test("active checkout read is scoped to booking, customer, and active key", async () => {
  const document = sampleDocument();
  const collection = fakeCollection({ findOneResult: document });
  const repository = createPaymentRepository({ database: fakeDatabase(collection) });

  const found = await repository.findActiveCheckout({
    bookingId: IDS.booking,
    customerId: IDS.customer,
  });

  const call = collection.calls.find((entry) => entry.method === "findOne");
  assert.equal(String(call.filter.bookingId), IDS.booking);
  assert.equal(String(call.filter.customerId), IDS.customer);
  assert.equal(call.filter[ACTIVE_PAYMENT_KEY_FIELD], makeActivePaymentKey(IDS.booking));
  assert.equal(call.options.projection.checkoutUrl, 1);
  assert.equal(call.options.projection[ACTIVE_PAYMENT_KEY_FIELD], 1);
  assert.equal(Object.hasOwn(found, "stripeSecretKey"), false);
  assert.equal(found.checkoutUrl, document.checkoutUrl);
});

test("paid checkout read uses the paid booking key", async () => {
  const collection = fakeCollection();
  const repository = createPaymentRepository({ database: fakeDatabase(collection) });

  await repository.findPaidCheckout({ bookingId: IDS.booking, customerId: IDS.customer });

  const call = collection.calls.find((entry) => entry.method === "findOne");
  assert.equal(call.filter[PAID_BOOKING_KEY_FIELD], makeActivePaymentKey(IDS.booking));
  assert.equal(call.filter.status, undefined);
});

test("session lookup can be scoped to the authenticated booking and customer", async () => {
  const collection = fakeCollection();
  const repository = createPaymentRepository({ database: fakeDatabase(collection) });

  await repository.findByCheckoutSessionId({
    sessionId: "cs_test_abc",
    bookingId: IDS.booking,
    customerId: IDS.customer,
  });

  const call = collection.calls.find((entry) => entry.method === "findOne");
  assert.deepEqual(call.filter, {
    stripeCheckoutSessionId: "cs_test_abc",
    bookingId: new ObjectId(IDS.booking),
    customerId: new ObjectId(IDS.customer),
  });
});

test("reservation insert maps a duplicate key to a safe checkout conflict", async () => {
  const duplicateCollection = fakeCollection({ duplicate: true });
  const duplicateRepository = createPaymentRepository({
    database: fakeDatabase(duplicateCollection),
  });
  await expectCode(
    duplicateRepository.insertCheckoutReservation(sampleDocument()),
    409,
    PAYMENT_CHECKOUT_CONFLICT,
  );

  const collection = fakeCollection();
  const repository = createPaymentRepository({ database: fakeDatabase(collection) });
  const inserted = await repository.insertCheckoutReservation(sampleDocument());
  const call = collection.calls.find((entry) => entry.method === "insertOne");
  assert.equal(String(call.document._id), IDS.payment);
  assert.equal(inserted.status, PAYMENT_STATUS.CHECKOUT_PENDING);
  assert.equal(Object.hasOwn(inserted, "stripeSecretKey"), false);
});

test("saving a Checkout Session uses a conditional update and a reliable expiration", async () => {
  const now = new Date("2026-11-22T12:00:00Z");
  const expiresAt = new Date(1800000000000);
  const collection = fakeCollection({ updateResult: sampleDocument() });
  const repository = createPaymentRepository({ database: fakeDatabase(collection) });

  const saved = await repository.saveCheckoutSession({
    payment: sampleDocument(),
    sessionId: "cs_test_abc",
    checkoutUrl: "https://checkout.stripe.com/pay/cs_test_abc",
    expiresAt,
    now,
  });

  const call = collection.calls.find((entry) => entry.method === "findOneAndUpdate");
  assert.equal(String(call.filter._id), IDS.payment);
  assert.equal(call.filter[ACTIVE_PAYMENT_KEY_FIELD], makeActivePaymentKey(IDS.booking));
  assert.deepEqual(call.filter.status.$in, [
    PAYMENT_STATUS.CHECKOUT_PENDING,
    PAYMENT_STATUS.AWAITING_PAYMENT,
  ]);
  assert.equal(call.update.$set.status, PAYMENT_STATUS.AWAITING_PAYMENT);
  assert.equal(call.update.$set.stripeCheckoutSessionId, "cs_test_abc");
  assert.equal(call.update.$set.updatedAt, now);
  assert.equal(call.update.$set.expiresAt, expiresAt);
  assert.equal(saved.status, PAYMENT_STATUS.AWAITING_PAYMENT);

  const noExpiry = fakeCollection({ updateResult: sampleDocument() });
  await createPaymentRepository({ database: fakeDatabase(noExpiry) }).saveCheckoutSession({
    payment: sampleDocument(),
    sessionId: "cs_test_abc",
    checkoutUrl: "https://checkout.stripe.com/pay/cs_test_abc",
    expiresAt: null,
    now,
  });
  const noExpiryCall = noExpiry.calls.find((entry) => entry.method === "findOneAndUpdate");
  assert.equal(Object.hasOwn(noExpiryCall.update.$set, "expiresAt"), false);
});

test("definite failure update releases the active key only from checkout_pending", async () => {
  const collection = fakeCollection({ updateResult: sampleDocument() });
  const repository = createPaymentRepository({ database: fakeDatabase(collection) });

  const result = await repository.markCheckoutFailed({
    payment: sampleDocument(),
    now: new Date("2026-11-22T12:00:00Z"),
  });

  const call = collection.calls.find((entry) => entry.method === "findOneAndUpdate");
  assert.equal(call.filter.status, PAYMENT_STATUS.CHECKOUT_PENDING);
  assert.equal(call.update.$set.status, PAYMENT_STATUS.CHECKOUT_FAILED);
  assert.equal(call.update.$unset[ACTIVE_PAYMENT_KEY_FIELD], "");
  assert.equal(result.status, PAYMENT_STATUS.CHECKOUT_FAILED);
});

test("checkout reads and writes fail closed when the database is unavailable", async () => {
  const collection = fakeCollection();
  const repository = createPaymentRepository({ database: fakeDatabase(collection, false) });

  await expectCode(
    repository.findActiveCheckout({ bookingId: IDS.booking, customerId: IDS.customer }),
    503,
    "SERVICE_UNAVAILABLE",
  );
  await expectCode(
    repository.insertCheckoutReservation(sampleDocument()),
    503,
    "SERVICE_UNAVAILABLE",
  );
});

test("checkout references are validated before querying", async () => {
  const collection = fakeCollection();
  const repository = createPaymentRepository({ database: fakeDatabase(collection) });

  await expectCode(
    repository.findActiveCheckout({ bookingId: "bad", customerId: IDS.customer }),
    400,
    "VALIDATION_FAILED",
  );
  await expectCode(
    repository.findByCheckoutSessionId({ sessionId: "cs_test_abc", customerId: "bad" }),
    400,
    "VALIDATION_FAILED",
  );
  assert.equal(collection.calls.length, 0);
});
