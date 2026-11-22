import test from "node:test";
import assert from "node:assert/strict";
import { createPaymentRepository } from "../src/payments/paymentRepository.js";
import { PAYMENT_INDEXES } from "../src/payments/paymentModel.js";

class FakeCollection {
  constructor({ existingIndexes = [] } = {}) {
    this.existingIndexes = existingIndexes.map((index) => ({ ...index }));
    this.calls = { indexes: 0, createIndex: [] };
  }

  async indexes() {
    this.calls.indexes += 1;
    return this.existingIndexes.map((index) => ({ ...index }));
  }

  async createIndex(keys, options) {
    this.calls.createIndex.push({ keys, options });
    this.existingIndexes.push({ ...options, key: { ...keys } });
    return options.name;
  }
}

function fakeDatabase(collection, { ready = true } = {}) {
  const collectionCalls = [];
  return {
    isReady: () => ready,
    getDb: () => ({
      collection(name) {
        collectionCalls.push(name);
        assert.equal(name, "payments");
        return collection;
      },
    }),
    collectionCalls,
  };
}

test("requires a database manager", () => {
  assert.throws(() => createPaymentRepository(), /requires a database manager/);
  assert.throws(() => createPaymentRepository({ database: {} }), /requires a database manager/);
});

test("creates all payment indexes once and is idempotent on repeat", async () => {
  const payments = new FakeCollection();
  const database = fakeDatabase(payments);
  const repository = createPaymentRepository({ database });

  const first = await repository.ensureIndexes();
  assert.deepEqual(first.created, PAYMENT_INDEXES.map((definition) => definition.name));
  assert.equal(first.existingCount, 0);
  assert.equal(payments.calls.createIndex.length, 7);

  const activeIndex = payments.calls.createIndex.find(
    (call) => call.options.name === "payments_active_booking_unique",
  );
  assert.deepEqual(activeIndex.keys, { activePaymentKey: 1 });
  assert.deepEqual({ ...activeIndex.options }, { name: "payments_active_booking_unique", unique: true, sparse: true });

  const second = await repository.ensureIndexes();
  assert.deepEqual(second.created, []);
  assert.equal(second.existingCount, 7);
  assert.equal(payments.calls.createIndex.length, 7);
  assert.equal(payments.calls.indexes, 2);
  assert.deepEqual(database.collectionCalls, ["payments", "payments"]);
});

test("rejects an existing named index with conflicting keys or options", async () => {
  const conflictingKeys = new FakeCollection({
    existingIndexes: [{
      name: "payments_active_booking_unique",
      key: { wrongField: 1 },
      unique: true,
      sparse: true,
    }],
  });
  await assert.rejects(
    createPaymentRepository({ database: fakeDatabase(conflictingKeys) }).ensureIndexes(),
    /different key specification/,
  );

  const conflictingOptions = new FakeCollection({
    existingIndexes: [{
      name: "payments_checkout_session_unique",
      key: { stripeCheckoutSessionId: 1 },
      unique: false,
      sparse: true,
    }],
  });
  await assert.rejects(
    createPaymentRepository({ database: fakeDatabase(conflictingOptions) }).ensureIndexes(),
    /different options/,
  );
});

test("fails explicitly when the database is unavailable", async () => {
  const payments = new FakeCollection();
  const repository = createPaymentRepository({ database: fakeDatabase(payments, { ready: false }) });

  await assert.rejects(repository.ensureIndexes(), { code: "SERVICE_UNAVAILABLE", status: 503 });
  assert.equal(payments.calls.indexes, 0);
});
