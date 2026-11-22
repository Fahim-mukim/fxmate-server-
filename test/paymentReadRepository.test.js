import test from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";

import { createBookingRepository } from "../src/bookings/bookingRepository.js";
import { BOOKING_COLLECTION } from "../src/bookings/bookingModel.js";
import {
  PAYMENT_ADMIN_PROJECTION,
  PAYMENT_CUSTOMER_HISTORY_PROJECTION,
  PAYMENT_CUSTOMER_PROJECTION,
  PAYMENT_INDEXES,
  PAYMENT_STATUS,
} from "../src/payments/paymentModel.js";
import { createPaymentRepository } from "../src/payments/paymentRepository.js";
import {
  buildAdminPaymentFilter,
  parseAdminPaymentListQuery,
  parseCustomerPaymentHistoryQuery,
} from "../src/payments/paymentQuery.js";

const SESSION_ID = "cs_test_owned123";
const PAYMENT_ID = "507f1f77bcf86cd7994390d1";
const BOOKING_ID = "507f1f77bcf86cd7994390b1";
const CUSTOMER_ID = "507f1f77bcf86cd7994390c1";
const OTHER_CUSTOMER_ID = "507f1f77bcf86cd7994390c2";

function databaseFor(collectionName, collection) {
  return {
    isReady: () => true,
    getDb: () => ({
      collection(name) {
        assert.equal(name, collectionName);
        return collection;
      },
    }),
  };
}

function fakePaymentCollection({ documents = [], total = 0, aggregateRows = [] } = {}) {
  const calls = {
    findOne: [],
    find: [],
    count: [],
    sort: [],
    skip: [],
    limit: [],
    aggregate: [],
    writes: 0,
  };
  return {
    calls,
    async findOne(filter, options) {
      calls.findOne.push({ filter, options });
      return documents[0] ?? null;
    },
    find(filter, options) {
      calls.find.push({ filter, options });
      return {
        sort(value) {
          calls.sort.push(value);
          return this;
        },
        skip(value) {
          calls.skip.push(value);
          return this;
        },
        limit(value) {
          calls.limit.push(value);
          return this;
        },
        async toArray() {
          return documents;
        },
      };
    },
    async countDocuments(filter) {
      calls.count.push(filter);
      return total;
    },
    aggregate(pipeline) {
      calls.aggregate.push(pipeline);
      return {
        async toArray() {
          return aggregateRows;
        },
      };
    },
    async insertOne() {
      calls.writes += 1;
    },
    async updateOne() {
      calls.writes += 1;
    },
    async findOneAndUpdate() {
      calls.writes += 1;
    },
    async deleteOne() {
      calls.writes += 1;
    },
  };
}

function sensitivePaymentDocument(overrides = {}) {
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
    stripeCheckoutSessionId: SESSION_ID,
    stripePaymentIntentId: "pi_secret_marker",
    stripeEventId: "evt_secret_marker",
    checkoutUrl: "https://checkout.stripe.com/cs_test_secret_marker",
    clientReferenceId: PAYMENT_ID,
    activePaymentKey: "secret-active-key",
    paidBookingKey: "secret-paid-key",
    paidByPaymentId: "secret-marker",
    createdAt: new Date("2026-11-22T10:00:00.000Z"),
    updatedAt: new Date("2026-11-22T10:05:00.000Z"),
    paidAt: new Date("2026-11-22T10:04:00.000Z"),
    ...overrides,
  };
}

test("customer Session lookup uses exact id plus canonical owner and a safe projection", async () => {
  const collection = fakePaymentCollection({
    documents: [sensitivePaymentDocument()],
  });
  const payments = createPaymentRepository({
    database: databaseFor("payments", collection),
  });

  const result = await payments.findByCheckoutSessionIdForCustomer({
    sessionId: SESSION_ID,
    customerId: CUSTOMER_ID,
  });

  assert.deepEqual(collection.calls.findOne[0].filter, {
    stripeCheckoutSessionId: SESSION_ID,
    customerId: new ObjectId(CUSTOMER_ID),
  });
  assert.deepEqual(
    collection.calls.findOne[0].options.projection,
    PAYMENT_CUSTOMER_PROJECTION,
  );
  assert.deepEqual(Object.keys(result).sort(), Object.keys(PAYMENT_CUSTOMER_PROJECTION).sort());
  for (const forbidden of [
    "customerId",
    "customerName",
    "customerEmail",
    "technicianName",
    "stripeCheckoutSessionId",
    "stripePaymentIntentId",
    "stripeEventId",
    "checkoutUrl",
    "clientReferenceId",
    "activePaymentKey",
    "paidBookingKey",
    "amountCents",
  ]) {
    assert.equal(Object.hasOwn(result, forbidden), false, forbidden);
  }
  assert.equal(collection.calls.writes, 0);
});

test("customer Session lookup never broadens to another customer", async () => {
  const collection = fakePaymentCollection();
  const payments = createPaymentRepository({
    database: databaseFor("payments", collection),
  });

  const result = await payments.findByCheckoutSessionIdForCustomer({
    sessionId: SESSION_ID,
    customerId: OTHER_CUSTOMER_ID,
  });

  assert.equal(result, null);
  assert.deepEqual(collection.calls.findOne[0].filter.customerId, new ObjectId(OTHER_CUSTOMER_ID));
  assert.equal(Object.hasOwn(collection.calls.findOne[0].filter, "$or"), false);
  assert.equal(collection.calls.writes, 0);
});

test("Admin listing filters, counts, sorts, and paginates entirely in MongoDB", async () => {
  const collection = fakePaymentCollection({
    documents: [sensitivePaymentDocument()],
    total: 23,
  });
  const payments = createPaymentRepository({
    database: databaseFor("payments", collection),
  });
  const criteria = parseAdminPaymentListQuery({
    status: "paid",
    search: PAYMENT_ID,
    page: "2",
    limit: "10",
  });

  const result = await payments.listForAdmin(criteria);

  assert.deepEqual(collection.calls.count[0], buildAdminPaymentFilter(criteria));
  assert.deepEqual(collection.calls.find[0].filter, collection.calls.count[0]);
  assert.equal(collection.calls.find[0].filter.status, PAYMENT_STATUS.PAID);
  assert.equal(collection.calls.find[0].filter.$or.length, 6);
  assert.ok(
    collection.calls.find[0].filter.$or.some(
      (clause) => String(clause._id) === PAYMENT_ID,
    ),
  );
  assert.deepEqual(collection.calls.sort[0], { createdAt: -1, _id: -1 });
  assert.deepEqual(collection.calls.skip, [10]);
  assert.deepEqual(collection.calls.limit, [10]);
  assert.deepEqual(collection.calls.find[0].options.projection, PAYMENT_ADMIN_PROJECTION);
  assert.equal(result.total, 23);
  assert.equal(result.totalPages, 3);
  assert.equal(result.items.length, 1);
  assert.equal(collection.calls.writes, 0);
});

test("Admin listing defaults to ten newest rows with a stable secondary sort", async () => {
  const collection = fakePaymentCollection();
  const payments = createPaymentRepository({
    database: databaseFor("payments", collection),
  });

  const result = await payments.listForAdmin(parseAdminPaymentListQuery());

  assert.equal(collection.calls.count[0].status, undefined);
  assert.equal(collection.calls.count[0].$or, undefined);
  assert.deepEqual(collection.calls.sort[0], { createdAt: -1, _id: -1 });
  assert.deepEqual(collection.calls.skip, [0]);
  assert.deepEqual(collection.calls.limit, [10]);
  assert.equal(result.page, 1);
  assert.equal(result.limit, 10);
  assert.equal(result.total, 0);
  assert.equal(result.totalPages, 0);
  assert.equal(collection.calls.writes, 0);
});

test("customer history scopes ownership in MongoDB and uses a safe projection", async () => {
  const collection = fakePaymentCollection({
    documents: [sensitivePaymentDocument()],
    total: 12,
  });
  const payments = createPaymentRepository({
    database: databaseFor("payments", collection),
  });
  const criteria = parseCustomerPaymentHistoryQuery({ page: "2", limit: "5" });

  const result = await payments.listForCustomer({
    ...criteria,
    customerId: CUSTOMER_ID,
  });

  assert.deepEqual(collection.calls.count[0], {
    customerId: new ObjectId(CUSTOMER_ID),
  });
  assert.deepEqual(collection.calls.find[0].filter, collection.calls.count[0]);
  assert.deepEqual(
    collection.calls.find[0].options.projection,
    PAYMENT_CUSTOMER_HISTORY_PROJECTION,
  );
  assert.deepEqual(collection.calls.sort[0], { createdAt: -1, _id: -1 });
  assert.deepEqual(collection.calls.skip, [5]);
  assert.deepEqual(collection.calls.limit, [5]);
  assert.equal(result.total, 12);
  assert.equal(result.totalPages, 3);
  assert.deepEqual(Object.keys(result.items[0]).sort(),
    Object.keys(PAYMENT_CUSTOMER_HISTORY_PROJECTION).sort());
  for (const forbidden of [
    "customerId",
    "customerName",
    "customerEmail",
    "stripeCheckoutSessionId",
    "stripeEventId",
    "checkoutUrl",
    "clientReferenceId",
    "activePaymentKey",
    "paidBookingKey",
    "amountCents",
  ]) {
    assert.equal(Object.hasOwn(result.items[0], forbidden), false, forbidden);
  }
  assert.equal(result.items[0].stripePaymentIntentId, "pi_secret_marker");
  assert.equal(collection.calls.writes, 0);
});

test("customer history rejects browser-supplied ownership and status filters", () => {
  for (const query of [
    { customerId: CUSTOMER_ID },
    { status: "paid" },
    { sort: "newest" },
    { search: "phone" },
  ]) {
    assert.throws(
      () => parseCustomerPaymentHistoryQuery(query),
      /Unsupported query parameter/,
    );
  }
  assert.deepEqual(parseCustomerPaymentHistoryQuery(), {
    page: 1,
    limit: 10,
  });
});

test("revenue aggregation counts only paid USD payments and sums integer cents", async () => {
  const collection = fakePaymentCollection({
    aggregateRows: [{ _id: null, paidCount: 3, totalCents: 24875 }],
  });
  const payments = createPaymentRepository({
    database: databaseFor("payments", collection),
  });

  const summary = await payments.aggregatePaidRevenue();

  assert.deepEqual(collection.calls.aggregate[0], [
    { $match: { status: PAYMENT_STATUS.PAID, currency: "usd" } },
    {
      $group: {
        _id: null,
        paidCount: { $sum: 1 },
        totalCents: { $sum: "$amountCents" },
      },
    },
  ]);
  assert.deepEqual(summary, {
    currency: "usd",
    paidCount: 3,
    totalRevenue: 248.75,
  });
  assert.equal(collection.calls.writes, 0);
});

test("revenue aggregation fails closed when the stored aggregate is invalid", async () => {
  const payments = createPaymentRepository({
    database: databaseFor("payments", fakePaymentCollection({
      aggregateRows: [{ _id: null, paidCount: "many", totalCents: Number.NaN }],
    })),
  });

  assert.deepEqual(await payments.aggregatePaidRevenue(), {
    currency: "usd",
    paidCount: 0,
    totalRevenue: 0,
  });
});

test("booking payment status read is ownership-scoped and exposes only the flag", async () => {
  const calls = { findOne: [], writes: 0 };
  const collection = {
    async findOne(filter, options) {
      calls.findOne.push({ filter, options });
      return {
        _id: new ObjectId(BOOKING_ID),
        paymentStatus: "paid",
        customerName: "must-not-leak",
        address: "must-not-leak",
      };
    },
    async updateOne() {
      calls.writes += 1;
    },
    async findOneAndUpdate() {
      calls.writes += 1;
    },
  };
  const bookings = createBookingRepository({
    database: databaseFor(BOOKING_COLLECTION, collection),
  });

  const result = await bookings.findPaymentStatusForCustomer({
    bookingId: BOOKING_ID,
    customerId: CUSTOMER_ID,
  });

  assert.deepEqual(calls.findOne[0].filter, {
    _id: new ObjectId(BOOKING_ID),
    customerId: new ObjectId(CUSTOMER_ID),
  });
  assert.deepEqual(calls.findOne[0].options.projection, { _id: 1, paymentStatus: 1 });
  assert.deepEqual(result, {
    _id: new ObjectId(BOOKING_ID),
    paymentStatus: "paid",
  });
  assert.equal(calls.writes, 0);
});

test("Admin newest-first read index is additive and non-unique", () => {
  const index = PAYMENT_INDEXES.find(
    (definition) => definition.name === "payments_admin_created",
  );
  assert.ok(index);
  assert.deepEqual(index.keys, { createdAt: -1, _id: -1 });
  assert.equal(index.unique, undefined);
  assert.equal(index.sparse, undefined);
});
